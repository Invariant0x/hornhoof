import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TASK43_TRANSFER_V1, type ServerMessage, type Task43NodeMessage, type Task43ServerMessage } from '@hornhoof/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, people, subscriptions, taskEvents, tasks } from '../src/db/schema.js';
import { identityOf } from '../src/modules/nodes/hub.js';
import { Task43Transfer } from '../src/modules/task43-transfer/relay.js';
import { authorizeTask43 } from '../src/modules/task43-transfer/auth.js';
import { jobOf } from '../src/modules/tools/mcp.js';
import { createTask43Node } from '../../node/src/task43-transfer.js';
import { connectNode, listen, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

const SOURCE = 'b8f2e7aa-1fb2-447e-9312-7dc1e12108a6';
const TARGET = '100edb09-da27-4868-9646-5c0118b9934e';
const TOKEN = 'ops-head-current-56-tool-token';
const NODE_KEY = 'node-key-is-not-a-person-or-admin';
const REQUEST = '8a3e65b0-6b1a-4f5f-b5f4-cf7e26f0e9a1';

type Result = { content: { type: string; text: string }[]; isError?: boolean };

async function fixture() {
  const { app, db } = await testApp();
  await listen(app);
  await setUpCompany(app);
  const [company] = await db.select().from(companies);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const [orchestratorSub] = await db.select().from(subscriptions);
  const [ops] = await db.insert(departments).values({ companyId: company!.id, templateKey: 'operations', roleCode: 'OPS' }).returning();
  const makeSubscription = async (provider: 'codex' | 'kimi') =>
    (await db.insert(subscriptions).values({ companyId: company!.id, provider, kind: 'personal', label: provider, ownerPersonId: owner!.id, status: 'ready' }).returning())[0]!;
  const sourceSub = await makeSubscription('codex');
  const targetSub = await makeSubscription('kimi');
  const makeAgent = async (id: string, name: string, kind: 'head' | 'worker', roleKey: string, subscriptionId: string) =>
    (await db.insert(agents).values({ id, companyId: company!.id, kind, name, roleKey, departmentId: ops!.id, model: '', subscriptionId }).returning())[0]!;
  const head = await makeAgent(randomUUID(), 'Operations head', 'head', 'OPS-HEAD', orchestratorSub!.id);
  const source = await makeAgent(SOURCE, 'Source', 'worker', 'OPS-WATCH', sourceSub.id);
  const target = await makeAgent(TARGET, 'Target', 'worker', 'OPS-WATCH', targetSub.id);
  const [task] = await db.insert(tasks).values({
    companyId: company!.id, number: 56, departmentId: ops!.id, title: 'Deliver task43 artifact', status: 'working', stage: 0,
    assigneeAgentId: head.id, executorAgentId: head.id,
  }).returning();
  const running = async (agentId: string, token: string, taskId: string | null = task!.id) =>
    (await db.insert(jobs).values({ companyId: company!.id, subscriptionId: orchestratorSub!.id, agentId, taskId, kind: 'conversation', prompt: 'work', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(token) }).returning())[0]!;
  await running(head.id, TOKEN);
  return { app, db, company: company!, ops: ops!, head, source, target, task: task!, sourceSub, targetSub, running };
}

async function mcp(app: FastifyInstance, token = TOKEN): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name: 'task43-test', version: '0.0.0' });
  await client.connect(transport);
  onTestFinished(() => client.close());
  return client;
}

async function call(client: Client, args: object = { task: 56, requestId: REQUEST }): Promise<Result> {
  return await client.callTool({ name: 'transfer_task_artifact', arguments: args }) as Result;
}

function reason(result: Result): string {
  expect(result.isError).toBe(true);
  return JSON.parse(result.content[0]!.text).error.reason;
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const receiptOf = (result: Result) => JSON.parse(result.content[0]!.text);

type RelayOptions = {
  wrongAck?: boolean;
  existingConflict?: boolean;
  disconnectAt?: number;
  dropStored?: boolean;
  silentOn?: ServerMessage['type'];
  nonCanonicalChunk?: boolean;
  beforeFrame?: (frame: ServerMessage) => Promise<void> | void;
};

class ManualNode {
  readonly frames: ServerMessage[] = [];
  stored = false;
  aborted = false;
  data: Buffer;

  constructor(readonly node: FakeNode, readonly role: 'source' | 'target', data: Buffer, readonly options: RelayOptions = {}) {
    this.data = role === 'source' ? data : Buffer.alloc(0);
  }

  start(): void {
    void this.loop();
  }

  send(message: Task43NodeMessage): void {
    this.node.send(message);
  }

  private async loop(): Promise<void> {
    try {
      for (;;) {
        const frame = await this.node.next();
        if (!frame.type.startsWith('task43.')) continue;
        this.frames.push(frame);
        await this.options.beforeFrame?.(frame);
        if (this.options.silentOn === frame.type) continue;
        const ids = 'requestId' in frame ? { requestId: frame.requestId, attemptId: frame.attemptId } : null;
        if (!ids) continue;
        if (frame.type === 'task43.abort') {
          this.aborted = true;
          continue;
        }
        if (this.options.existingConflict && this.role === 'target' && frame.type === 'task43.prepare') {
          this.send({ type: 'task43.failed', ...ids, reason: 'destination_conflict', mayExist: true });
          continue;
        }
        if (this.options.disconnectAt !== undefined && this.role === 'source' && frame.type === 'task43.read' && frame.offset === this.options.disconnectAt) {
          this.node.ws.terminate();
          continue;
        }
        switch (frame.type) {
          case 'task43.prepare':
            this.send({ type: 'task43.ready', ...ids, role: this.role, existing: this.role === 'target' && this.stored ? 'matching' : 'absent' });
            break;
          case 'task43.read': {
            const data = this.data.subarray(frame.offset, Math.min(frame.offset + 32768, this.data.length));
            this.send({ type: 'task43.chunk', ...ids, offset: frame.offset, data: this.options.nonCanonicalChunk && frame.offset === 0 ? 'YR==' : data.toString('base64') });
            break;
          }
          case 'task43.write': {
            const raw = Buffer.from(frame.data, 'base64');
            this.data = Buffer.concat([this.data, raw]);
            this.send({ type: 'task43.ack', ...ids, nextOffset: this.options.wrongAck ? frame.offset + raw.length + 1 : frame.offset + raw.length });
            break;
          }
          case 'task43.source_finish':
            this.send({ type: 'task43.source_verified', ...ids, size: this.data.length, sha256: sha256(this.data), sourceReadAt: new Date().toISOString() });
            break;
          case 'task43.verify':
            this.send({ type: 'task43.verified', ...ids, size: this.data.length, sha256: sha256(this.data), targetVerifiedAt: new Date().toISOString() });
            break;
          case 'task43.commit': {
            const mode = this.stored ? 'already_present' : 'copied';
            this.stored = true;
            if (this.options.dropStored) {
              this.node.ws.terminate();
              break;
            }
            this.send({ type: 'task43.stored', ...ids, mode, size: this.data.length, sha256: sha256(this.data), actualPath: `/fixture/${TARGET}/task43-review-transfer-r1.tgz`, targetVerifiedAt: new Date().toISOString(), storedAt: new Date().toISOString() });
            break;
          }
        }
      }
    } catch {
      return;
    }
  }
}

async function relayFixture(data: Buffer, targetOptions: RelayOptions = {}, sourceOptions: RelayOptions = {}, capabilities: string[] = ['task43_transfer_v1']) {
  const current = await fixture();
  const { app, db, sourceSub, targetSub } = current;
  const sourceKey = 'source-node-key-0123456789abcdef';
  const targetKey = 'target-node-key-0123456789abcdef';
  await db.update(subscriptions).set({ nodeKeyHash: hashToken(sourceKey) }).where(eq(subscriptions.id, sourceSub.id));
  await db.update(subscriptions).set({ nodeKeyHash: hashToken(targetKey) }).where(eq(subscriptions.id, targetSub.id));
  app.ctx.task43 = new Task43Transfer(app.ctx, { ...TASK43_TRANSFER_V1, sha256: sha256(data) });
  const url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/nodes/socket`;
  const sourceSocket = await connectNode(url, sourceKey);
  const targetSocket = await connectNode(url, targetKey);
  onTestFinished(() => {
    sourceSocket.close();
    targetSocket.close();
  });
  sourceSocket.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], capabilities });
  targetSocket.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], capabilities });
  await until(() => app.ctx.hub.isReady(identityOf(sourceSub)) && app.ctx.hub.isReady(identityOf(targetSub)));
  const source = new ManualNode(sourceSocket, 'source', data, sourceOptions);
  const target = new ManualNode(targetSocket, 'target', data, targetOptions);
  source.start();
  target.start();
  const client = await mcp(app);
  return { ...current, source, target, client };
}

describe('task43 artifact authorization', () => {
  it('registers the bounded tool and lets only the current56 context reach routing', async () => {
    const { app } = await fixture();
    const client = await mcp(app);
    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name)).toContain('transfer_task_artifact');
    expect(reason(await call(client))).toBe('node_offline');
  });

  it('denies a historical57, null task, wrong role and non-working task before routing', async () => {
    const { app, db, ops, head, task, running } = await fixture();
    const [task57] = await db.insert(tasks).values({ companyId: task.companyId, number: 57, departmentId: ops.id, title: 'Historical', status: 'working', assigneeAgentId: head.id, executorAgentId: head.id }).returning();
    const cases: { token: string; taskId?: string | null; role?: string; status?: 'planned' | 'working' | 'blocked' | 'done' }[] = [
      { token: 'historical-57', taskId: task57!.id },
      { token: 'null-task', taskId: null },
      { token: 'wrong-role', role: 'DEV-HEAD' },
      { token: 'blocked-task', status: 'blocked' },
      { token: 'done-task', status: 'done' },
      { token: 'planned-task', status: 'planned' },
    ];
    for (const item of cases) {
      const token = `${item.token}-0123456789abcdef`;
      if (item.role || item.status) {
        if (item.role) await db.update(agents).set({ roleKey: item.role }).where(eq(agents.id, head.id));
        await db.update(tasks).set({ ...(item.status ? { status: item.status } : {}), ...(item.status === 'done' ? { closedAt: new Date() } : { closedAt: null }) }).where(eq(tasks.id, task.id));
        await running(head.id, token, task.id);
      } else {
        await running(head.id, token, item.taskId);
      }
      expect(reason(await call(await mcp(app, token), { task: 56, requestId: randomUUID() }))).toBe('wrong_context');
      await db.delete(jobs).where(and(eq(jobs.agentId, head.id), eq(jobs.toolTokenHash, hashToken(token))));
      await db.update(agents).set({ roleKey: 'OPS-HEAD' }).where(eq(agents.id, head.id));
      await db.update(tasks).set({ status: 'working', closedAt: null }).where(eq(tasks.id, task.id));
    }
  });

  it('denies removed or foreign source and target mappings before routing', async () => {
    const { app, db, source, target, sourceSub, targetSub } = await fixture();
    const client = await mcp(app);
    const [other] = await db.insert(companies).values({ name: 'Other', singleton: false }).returning();
    const cases = [
      async () => { await db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, source.id)); },
      async () => { await db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, target.id)); },
      async () => { await db.update(subscriptions).set({ removedAt: new Date() }).where(eq(subscriptions.id, targetSub.id)); },
      async () => { await db.update(agents).set({ companyId: other!.id }).where(eq(agents.id, source.id)); },
    ];
    for (const change of cases) {
      await change();
      expect(reason(await call(client, { task: 56, requestId: randomUUID() }))).toBe('wrong_context');
      await db.update(agents).set({ removedAt: null, companyId: source.companyId }).where(eq(agents.id, source.id));
      await db.update(agents).set({ removedAt: null, companyId: target.companyId }).where(eq(agents.id, target.id));
      await db.update(subscriptions).set({ removedAt: null }).where(eq(subscriptions.id, targetSub.id));
    }
    expect(sourceSub.companyId).toBe(source.companyId);
  });

  it('rejects an ended job and a node key at the existing bearer boundary', async () => {
    const { app, db, head } = await fixture();
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, head.id));
    for (const token of [TOKEN, NODE_KEY]) {
      await expect(jobOf(app.ctx, { headers: { authorization: `Bearer ${token}` } } as any)).rejects.toMatchObject({ status: 401, reason: 'tool_token_invalid' });
    }
  });

  it('rejects invocation overrides instead of treating them as a grant', async () => {
    const { app } = await fixture();
    const client = await mcp(app);
    expect((await client.listTools()).tools.some(tool => tool.name === 'transfer_task_artifact')).toBe(true);
    for (const extra of [{ sourceAgentId: SOURCE }, { targetAgentId: TARGET }, { path: '/tmp/other' }, { exec: 'id' }, { expectedSha256: '0'.repeat(64) }]) {
      const result = await call(client, { task: 56, requestId: REQUEST, ...extra });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('Unrecognized key');
    }
  });
});

describe('task43 two-node relay', () => {
  const synthetic = Buffer.alloc(2012762);
  for (let index = 0; index < synthetic.length; index++) synthetic[index] = index % 251;

  it('relays exactly62 chunks, persists truthful receipts and retries an unchanged destination', async () => {
    const { app, db, task, source, target, client } = await relayFixture(synthetic);
    const first = receiptOf(await call(client));
    expect(first).toMatchObject({ schema: 'task43-transfer-v1', taskNumber: 56, taskId: task.id, status: 'server_complete', delivered: false, mode: 'copied', actualSize: synthetic.length, actualSha256: sha256(synthetic), errorReason: null });
    expect(target.stored).toBe(true);
    expect(target.data.equals(synthetic)).toBe(true);
    expect(source.frames.filter(frame => frame.type === 'task43.read')).toHaveLength(62);
    expect(target.frames.filter(frame => frame.type === 'task43.write')).toHaveLength(62);
    expect(target.frames.filter(frame => frame.type === 'task43.commit')).toHaveLength(1);
    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id));
    expect(events.map(event => (event.data as any).task43Transfer.status)).toEqual(['started', 'server_complete']);
    expect(JSON.stringify(events)).not.toContain(synthetic.subarray(0, 32768).toString('base64'));

    const second = receiptOf(await call(client));
    expect(second).toMatchObject({ status: 'server_complete', delivered: false, mode: 'already_present', sourceReadAt: null, actualSha256: sha256(synthetic) });
    expect(source.frames.filter(frame => frame.type === 'task43.read')).toHaveLength(62);
    expect(target.frames.filter(frame => frame.type === 'task43.commit')).toHaveLength(2);
  });

  it('does not commit when the actual source hash differs from the delegated hash', async () => {
    const current = await relayFixture(synthetic);
    current.app.ctx.task43 = new Task43Transfer(current.app.ctx, { ...TASK43_TRANSFER_V1, sha256: '0'.repeat(64) });
    const receipt = receiptOf(await call(current.client));
    expect(receipt).toMatchObject({ status: 'failed', errorReason: 'hash_mismatch', delivered: false, actualSha256: null });
    expect(current.target.stored).toBe(false);
    expect(current.target.frames.some(frame => frame.type === 'task43.commit')).toBe(false);
  });

  it('aborts a wrong acknowledgement without publishing', async () => {
    const current = await relayFixture(synthetic, { wrongAck: true });
    const receipt = receiptOf(await call(current.client));
    expect(receipt).toMatchObject({ status: 'failed', errorReason: 'size_mismatch', delivered: false });
    expect(current.target.stored).toBe(false);
    expect(current.target.frames.some(frame => frame.type === 'task43.commit')).toBe(false);
  });

  it('reauthorizes after verification and refuses a changed task version before commit', async () => {
    const current = await relayFixture(synthetic, {
      beforeFrame: async frame => {
        if (frame.type === 'task43.verify') await current.db.update(tasks).set({ version: current.task.version + 1 }).where(eq(tasks.id, current.task.id));
      },
    });
    const receipt = receiptOf(await call(current.client));
    expect(receipt).toMatchObject({ status: 'failed', errorReason: 'wrong_context', delivered: false });
    expect(current.target.frames.some(frame => frame.type === 'task43.commit')).toBe(false);
  });

  it('reports disconnect without a false stored receipt', async () => {
    const current = await relayFixture(synthetic, {}, { disconnectAt: 32768 });
    const receipt = receiptOf(await call(current.client));
    expect(receipt).toMatchObject({ status: 'failed', errorReason: 'disconnected', delivered: false, storedAt: null });
    expect(current.target.stored).toBe(false);
  });

  it('keeps a published file after a lost stored ack and rechecks it on retry', async () => {
    const current = await relayFixture(synthetic, { dropStored: true });
    const first = receiptOf(await call(current.client));
    expect(first).toMatchObject({ status: 'failed', errorReason: 'commit_outcome_unknown', mayExist: true, delivered: false });
    expect(current.target.stored).toBe(true);

    const key = 'target-node-key-0123456789abcdef';
    const url = `ws://127.0.0.1:${(current.app.server.address() as AddressInfo).port}/api/nodes/socket`;
    const socket = await connectNode(url, key);
    onTestFinished(() => socket.close());
    socket.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], capabilities: ['task43_transfer_v1'] });
    await until(() => current.app.ctx.hub.isReady(identityOf(current.targetSub)));
    const retryTarget = new ManualNode(socket, 'target', synthetic);
    retryTarget.stored = true;
    retryTarget.data = synthetic;
    retryTarget.start();
    const second = receiptOf(await call(current.client));
    expect(second).toMatchObject({ status: 'server_complete', mode: 'already_present', delivered: false, actualSha256: sha256(synthetic) });
    expect(retryTarget.frames.some(frame => frame.type === 'task43.write')).toBe(false);
  });

  it('refuses an existing destination conflict before source preparation', async () => {
    const current = await relayFixture(synthetic, { existingConflict: true });
    const receipt = receiptOf(await call(current.client));
    expect(receipt).toMatchObject({ status: 'failed', errorReason: 'destination_conflict', mayExist: true, delivered: false });
    expect(current.source.frames.some(frame => frame.type === 'task43.prepare')).toBe(false);
  });

  it('rejects a noncanonical chunk before any target write', async () => {
    const current = await relayFixture(synthetic, {}, { nonCanonicalChunk: true });
    const receipt = receiptOf(await call(current.client));
    expect(receipt).toMatchObject({ status: 'failed', errorReason: 'size_mismatch', delivered: false });
    expect(current.target.frames.some(frame => frame.type === 'task43.write')).toBe(false);
  });

  it('does not send transfer frames to nodes without the capability', async () => {
    const current = await relayFixture(synthetic, {}, {}, []);
    expect(reason(await call(current.client))).toBe('unsupported_node');
    expect(current.source.frames).toEqual([]);
    expect(current.target.frames).toEqual([]);
    const [job] = await current.db.select().from(jobs).where(eq(jobs.toolTokenHash, hashToken(TOKEN)));
    expect(job!.status).toBe('running');
  });

  it('allows only one global attempt and returns busy to a concurrent call', async () => {
    let entered!: () => void;
    let release!: () => void;
    const firstWrite = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const current = await relayFixture(synthetic, {
      beforeFrame: async frame => {
        if (frame.type === 'task43.write' && frame.offset === 0) {
          entered();
          await gate;
        }
      },
    });
    const first = call(current.client);
    await firstWrite;
    const token = 'second-current-56-job-token-0123456789';
    await current.running(current.head.id, token);
    const secondClient = await mcp(current.app, token);
    expect(reason(await call(secondClient, { task: 56, requestId: randomUUID() }))).toBe('busy');
    release();
    expect(receiptOf(await first)).toMatchObject({ status: 'server_complete', delivered: false });
  });

  it('fails instead of queueing past the socket backpressure bound', async () => {
    const current = await relayFixture(synthetic);
    const ref = current.app.ctx.hub.pinTask43(identityOf(current.targetSub))!;
    const entry = (current.app.ctx.hub as any).sockets.get(ref.key);
    Object.defineProperty(entry.socket, 'bufferedAmount', { get: () => 262145 });
    const receipt = receiptOf(await call(current.client));
    expect(receipt).toMatchObject({ status: 'failed', errorReason: 'backpressure', delivered: false });
    expect(current.target.frames.some(frame => frame.type === 'task43.prepare')).toBe(false);
  });

  it('fails an idle attempt after the contract timeout without publishing', async () => {
    const current = await relayFixture(synthetic, { silentOn: 'task43.prepare' });
    const receipt = receiptOf(await call(current.client));
    expect(receipt).toMatchObject({ status: 'failed', errorReason: 'timeout', delivered: false, storedAt: null });
    expect(current.target.stored).toBe(false);
    await until(() => current.target.aborted);
  }, 20000);

  it('returns commit_outcome_unknown without diagnostics when final receipt persistence fails', async () => {
    const marker = 'synthetic-secret-database-marker';
    const current = await relayFixture(synthetic, {
      beforeFrame: frame => {
        if (frame.type !== 'task43.commit') return;
        const original = current.db.insert.bind(current.db);
        (current.db as any).insert = (table: unknown) => {
          if (table === taskEvents) throw new Error(marker);
          return original(table as any);
        };
      },
    });
    const result = await call(current.client);
    const receipt = receiptOf(result);
    expect(receipt).toMatchObject({ status: 'failed', errorReason: 'commit_outcome_unknown', mayExist: true, delivered: false });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(current.target.stored).toBe(true);
  });

  it('aborts the active attempt when the caller signal is aborted', async () => {
    const controller = new AbortController();
    const current = await relayFixture(synthetic, {
      beforeFrame: frame => {
        if (frame.type === 'task43.write' && frame.offset === 0) controller.abort();
      },
    });
    const [job] = await current.db.select().from(jobs).where(eq(jobs.toolTokenHash, hashToken(TOKEN)));
    const auth = await authorizeTask43(current.app.ctx, job!.id, current.app.ctx.task43.policy);
    const receipt = await current.app.ctx.task43.transfer(auth, REQUEST, controller.signal);
    expect(receipt).toMatchObject({ status: 'failed', errorReason: 'disconnected', delivered: false, storedAt: null });
    expect(current.target.stored).toBe(false);
  });

  it('runs the real MCP, sockets, node adapters and file helpers end to end', async () => {
    const current = await fixture();
    const dir = mkdtempSync(join(tmpdir(), 'task43-e2e-'));
    const root = join(dir, 'work', 'agents');
    const sourceWorkspace = join(root, SOURCE);
    const targetWorkspace = join(root, TARGET);
    mkdirSync(sourceWorkspace, { recursive: true });
    mkdirSync(targetWorkspace, { recursive: true });
    const sourceFile = join(sourceWorkspace, TASK43_TRANSFER_V1.relativeSource);
    mkdirSync(join(sourceFile, '..'), { recursive: true });
    writeFileSync(sourceFile, synthetic);
    const sourceKey = 'source-node-key-0123456789abcdef';
    const targetKey = 'target-node-key-0123456789abcdef';
    await current.db.update(subscriptions).set({ nodeKeyHash: hashToken(sourceKey) }).where(eq(subscriptions.id, current.sourceSub.id));
    await current.db.update(subscriptions).set({ nodeKeyHash: hashToken(targetKey) }).where(eq(subscriptions.id, current.targetSub.id));
    current.app.ctx.task43 = new Task43Transfer(current.app.ctx, { ...TASK43_TRANSFER_V1, sha256: sha256(synthetic) });
    const url = `ws://127.0.0.1:${(current.app.server.address() as AddressInfo).port}/api/nodes/socket`;
    const sourceSocket = await connectNode(url, sourceKey);
    const targetSocket = await connectNode(url, targetKey);
    const source = await createTask43Node({ dir, policy: { ...TASK43_TRANSFER_V1, sha256: sha256(synthetic) }, send: message => sourceSocket.send(message) });
    const target = await createTask43Node({ dir, policy: { ...TASK43_TRANSFER_V1, sha256: sha256(synthetic) }, send: message => targetSocket.send(message) });
    onTestFinished(() => {
      source.close();
      target.close();
      sourceSocket.close();
      targetSocket.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const pump = async (socket: FakeNode, node: { handle(frame: Task43ServerMessage): Promise<void> }) => {
      try {
        for (;;) {
          const frame = await socket.next();
          if (frame.type.startsWith('task43.')) await node.handle(frame as Task43ServerMessage);
        }
      } catch {
        return;
      }
    };
    void pump(sourceSocket, source);
    void pump(targetSocket, target);
    sourceSocket.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], capabilities: ['task43_transfer_v1'] });
    targetSocket.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], capabilities: ['task43_transfer_v1'] });
    await until(() => current.app.ctx.hub.isReady(identityOf(current.sourceSub)) && current.app.ctx.hub.isReady(identityOf(current.targetSub)));
    const client = await mcp(current.app);
    const receipt = receiptOf(await call(client));
    const final = join(targetWorkspace, TASK43_TRANSFER_V1.destinationBasename);
    expect(receipt).toMatchObject({ status: 'server_complete', delivered: false, mode: 'copied', actualPath: final, actualSize: synthetic.length, actualSha256: sha256(synthetic) });
    expect(statSync(final).size).toBe(synthetic.length);
    expect(createHash('sha256').update(readFileSync(final)).digest('hex')).toBe(sha256(synthetic));
    const events = await current.db.select().from(taskEvents).where(eq(taskEvents.taskId, current.task.id));
    expect(events.map(event => (event.data as any).task43Transfer.status)).toEqual(['started', 'server_complete']);
    expect(JSON.stringify(events)).not.toContain(synthetic.subarray(0, 32768).toString('base64'));
  });
});
