import type { ServerMessage } from '@hornhoof/protocol';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { encryptSecret } from '../src/crypto/secrets.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, attachments, companies, departments, jobs, subscriptions, tasks, testParts } from '../src/db/schema.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { afterJob } from '../src/modules/tasks/wake.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { checkTestTimes, placesOf, pumpTests } from '../src/modules/testruns/runs.js';
import { as, connectNode, invitePerson, listen, mcp, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

const GIB = 1024 ** 3;
const NODE_KEY = 'builtin-node-key-0123456789abcdef';
const idle = (over: object = {}) => ({ cpus: 8, load: 0.5, memFree: 12 * GIB, memTotal: 16 * GIB, tests: 0, jobs: 0, ...over });
type Res = { content: { text: string }[]; isError?: boolean };
type TestsRun = Extract<ServerMessage, { type: 'tests.run' }>;

/* A company whose development department has a repository, with Bruno at work on #1 there. */
async function company(env: NodeJS.ProcessEnv = {}) {
  const { app, db } = await testApp({ NODE_PING_MS: '50', NODE_KEY, ...env });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [dev, sales] = await db
    .insert(departments)
    .values([
      { companyId, templateKey: 'development', roleCode: 'DEV', position: 1, repoUrl: 'https://github.com/acme/shop.git', repoTokenEnc: encryptSecret('ghp_shop0123456789', app.ctx.config.secret), repoTokenLast4: '6789' },
      { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 },
    ])
    .returning();
  const [sub] = await db.select().from(subscriptions);
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId = dev!.id) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const sam = await hire('Sam', 'worker', 'SAL-AE', sales!.id);
  const task = (await createTask(app.ctx, { agentId: head.id }, { title: 'Checkout', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true, gates: [] })).task;
  let n = 0;
  /* A running turn of the agent on a task, and its tools. */
  const turn = async (agent: { id: string }, taskId: string | null = task.id) => {
    const token = `tool-token-${++n}-0123456789abcdef0123456789`;
    const [job] = await db
      .insert(jobs)
      .values({ companyId, subscriptionId: sub!.id, agentId: agent.id, taskId, kind: 'conversation', prompt: 'go', timeoutMs: 900000, status: 'running', startedAt: new Date(Date.now() - 1000), toolTokenHash: hashToken(token) })
      .returning();
    const client = await mcp(app, token);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as Res;
      return { text: res.content[0]!.text, error: res.isError === true };
    };
    return { job: job!, call };
  };
  /* A machine of a person with one node, online with this load. */
  const machine = async (token: string, hostname: string, load: object = idle(), { work = true, kind, noRuns }: { work?: boolean; kind?: string; noRuns?: string } = {}) => {
    const connected = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(token) });
    const code = connected.json().command.split('--join ')[1];
    const joined = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: `${hostname}-0001-abcd`, hostname, os: 'linux', arch: 'x86_64', ...(kind ? { kind } : {}) } })).json();
    const [{ nodeId, subscriptionId, key }] = joined.nodes;
    const node = await connectNode(url, key);
    node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: load as ReturnType<typeof idle>, tests: [], work, ...(noRuns ? { noRuns } : {}) });
    await until(() => app.ctx.hub.loadOf(nodeIdentity(nodeId)) !== null);
    return { node, key: key as string, nodeId: nodeId as string, subscriptionId: subscriptionId as string, machineId: joined.machine.id as string };
  };
  /* A machine of a person that joined without a plan, online with this load. */
  const planless = async (token: string, hostname: string, load: object = idle()) => {
    const code = (await app.inject({ method: 'POST', url: '/api/machines/command', ...as(token) })).json().command.split('--join ')[1];
    const joined = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: `${hostname}-0001-abcd`, hostname, os: 'linux', arch: 'x86_64' } })).json();
    const [{ nodeId, key }] = joined.nodes;
    const node = await connectNode(url, key);
    node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: load as ReturnType<typeof idle>, tests: [] });
    await until(() => app.ctx.hub.loadOf(nodeIdentity(nodeId)) !== null);
    return { node, nodeId: nodeId as string, machineId: joined.machine.id as string };
  };
  /* The same machine's node back online after it was away. */
  const reconnect = async (m: { key: string; nodeId: string }, load: object = idle()) => {
    const node = await connectNode(url, m.key);
    node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: load as ReturnType<typeof idle>, tests: [], work: true });
    await until(() => app.ctx.hub.loadOf(nodeIdentity(m.nodeId)) !== null);
    return node;
  };
  const ann = await invitePerson(app, ceo, { name: 'Ann', email: 'ann@acme.com', access: { departments: [dev!.id] } });
  const bob = await invitePerson(app, ceo, { name: 'Bob', email: 'bob@acme.com', access: { departments: [sales!.id] } });
  /* A file on the task, as an agent puts it there. */
  const putFile = async (name: string, text: string, taskId = task.id) => {
    const [made] = await db.select({ id: jobs.id }).from(jobs).limit(1);
    const bytes = Buffer.from(text);
    await db.insert(attachments).values({ companyId, jobId: made!.id, agentId: bruno.id, taskId, name, mediaType: 'application/octet-stream', bytes, size: bytes.length });
  };
  /* The agent's newest turn waiting on the task. */
  const wokeWith = async (agentId: string, taskId = task.id) =>
    (await db.select().from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.taskId, taskId), eq(jobs.status, 'queued'))).orderBy(asc(jobs.createdAt))).pop()?.prompt ?? null;
  const filesOn = async (taskId = task.id) =>
    (await db.select({ name: attachments.name, bytes: attachments.bytes }).from(attachments).where(eq(attachments.taskId, taskId)).orderBy(asc(attachments.name))).map(f => ({ name: f.name, text: Buffer.from(f.bytes).toString('utf8') }));
  /* The built-in node, online with this load. */
  const builtin = async (load: object = idle()) => {
    const node = await connectNode(url, NODE_KEY);
    node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: load as ReturnType<typeof idle>, tests: [] });
    await until(() => app.ctx.hub.loadOf({ kind: 'builtin' }) !== null);
    return node;
  };
  return { app, db, url, ceo, ann, bob, builtin, dev: dev!, sales: sales!, head, bruno, sam, task, turn, machine, planless, reconnect, putFile, wokeWith, filesOn };
}

/* The next message of one kind a node gets, past the others. */
async function nextOf<T extends ServerMessage['type']>(node: FakeNode, type: T): Promise<Extract<ServerMessage, { type: T }>> {
  for (;;) {
    const msg = await node.next();
    if (msg.type === type) return msg as Extract<ServerMessage, { type: T }>;
  }
}

/* Whether a node got a message of this kind within a short wait; what came meanwhile is taken. */
async function gets(node: FakeNode, type: ServerMessage['type'], ms = 300): Promise<boolean> {
  await new Promise(r => setTimeout(r, ms));
  let got = false;
  for (let n = node.queued(); n > 0; n--) if ((await node.next()).type === type) got = true;
  return got;
}

const done = (run: TestsRun, over: object = {}) => ({ type: 'tests.done' as const, partId: run.partId, ok: true, exitCode: 0, error: null, commit: 'a'.repeat(40), log: `part ${run.part} ok\n`, ...over });

/* The scheduler consumes optional physical resources at the hub boundary. */
const reportHost = (c: Awaited<ReturnType<typeof company>>, nodeId: string | null, host: string, over: object = {}) => {
  const load = { ...idle(), host, hostCpus: 16, hostLoad: 1, hostMemFree: 12 * GIB, hostMemory: 16 * GIB, ...over };
  c.app.ctx.hub.report(nodeId ? nodeIdentity(nodeId) : { kind: 'builtin' }, load);
};

describe('parts on physical computers', () => {
  it('finishes an existing run part before permitting the node update', async () => {
    const c = await company({ HORNHOOF_CONTROL_DIR: mkdtempSync(join(tmpdir(), 'hh-run-drain-')) });
    const first = await c.machine(c.ann, 'updating');
    const { call } = await c.turn(c.bruno);
    expect((await call('run_work', { command: 'printf checked', branch: 'task-1' })).error).toBe(false);
    const part = await nextOf(first.node, 'tests.run');
    const prepare = () => c.app.inject({ method: 'POST', url: '/api/nodes/update', headers: { authorization: `Bearer ${first.key}` }, payload: {} });
    expect((await prepare()).json()).toMatchObject({ ready: false, drain: { state: 'waiting', turnsLeft: 0, partsLeft: 1 } });
    expect((await c.db.select().from(testParts))[0]).toMatchObject({ status: 'running', nodeId: first.nodeId, error: null });
    expect(await gets(first.node, 'tests.cancel')).toBe(false);
    first.node.send(done(part));
    await until(async () => (await prepare()).json().ready === true);
    expect((await c.db.select().from(testParts))[0]).toMatchObject({ status: 'passed', error: null });
  });

  it.each(['run_tests', 'run_work'])('sends %s parts to a free machine while another waits for an update', async tool => {
    const c = await company({ HORNHOOF_CONTROL_DIR: mkdtempSync(join(tmpdir(), 'hh-run-drain-')) });
    const first = await c.machine(c.ann, 'updating');
    const second = await c.machine(c.ceo, 'available');
    const { call } = await c.turn(c.bruno);
    const prepared = await c.app.inject({ method: 'POST', url: '/api/nodes/update', headers: { authorization: `Bearer ${first.key}` }, payload: {} });
    expect(prepared.json().ready).toBe(true);
    const started = await call(tool, { command: 'printf checked', ...(tool === 'run_work' ? { branch: 'task-1' } : {}) });
    expect(started.error).toBe(false);
    const parts = await c.db.select().from(testParts);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ nodeId: second.nodeId, status: 'running' });
    expect(await gets(first.node, 'tests.run')).toBe(false);
  });

  it.each([
    { selectedGb: 2, siblingGb: 12, status: 'queued' },
    { selectedGb: 12, siblingGb: 2, status: 'running' },
  ])('uses the selected node with $selectedGb GB, even when its sibling reports $siblingGb GB last', async ({ selectedGb, siblingGb, status }) => {
    const c = await company();
    const connect = await c.app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude', 'codex'] }, ...as(c.ceo) });
    const code = connect.json().command.split('--join ')[1];
    const joined = (await c.app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'shared-0001-abcd', hostname: 'shared', os: 'linux', arch: 'x86_64' } })).json();
    const connected: { node: FakeNode; id: string }[] = [];
    const host = { host: 'linux', hostCpus: 16, hostLoad: 1, hostMemFree: 12 * GIB, hostMemory: 16 * GIB };
    for (const entry of joined.nodes) {
      const node = await connectNode(c.url, entry.key);
      node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], tests: [], work: true, load: idle({ ...host, memFree: GIB }) });
      await until(() => c.app.ctx.hub.loadOf(nodeIdentity(entry.nodeId)) !== null);
      connected.push({ node, id: entry.nodeId });
    }
    const [chosen] = await placesOf(c.app.ctx, c.task.companyId);
    const selected = connected.find(n => n.id === chosen!.nodeId)!;
    const sibling = connected.find(n => n.id !== selected.id)!;
    selected.node.send({ type: 'load', ...idle({ ...host, memFree: selectedGb * GIB }) });
    await until(() => c.app.ctx.hub.loadOf(nodeIdentity(selected.id))?.memFree === selectedGb * GIB);
    const selectedAt = c.app.ctx.hub.loadOf(nodeIdentity(selected.id))!.at;
    await until(() => Date.now() > selectedAt);
    sibling.node.send({ type: 'load', ...idle({ ...host, memFree: siblingGb * GIB }) });
    await until(() => (c.app.ctx.hub.loadOf(nodeIdentity(sibling.id))?.at ?? 0) > selectedAt);
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    expect(JSON.parse((await call('test_run', { run: 1 })).text).parts).toMatchObject([{ status }]);
    if (status === 'running') expect((await c.db.select().from(testParts))[0]!.nodeId).toBe(selected.id);
    else expect((await c.app.inject({ url: '/api/pool', ...as(c.ceo) })).json().waiting[0].why).toMatch(/Short of the 4 GB/);
  });

  it('groups reports received through the node protocol without injecting hub state', async () => {
    const c = await company();
    const load = idle({ host: 'linux', hostCpus: 16, hostLoad: 1, hostMemFree: 12 * GIB, hostMemory: 16 * GIB });
    await c.planless(c.ceo, 'container-one', load);
    await c.planless(c.ceo, 'container-two', load);
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test -- {part}', parts: 2 });
    expect(JSON.parse((await call('test_run', { run: 1 })).text).parts).toMatchObject([{ status: 'running' }, { status: 'queued' }]);
  });

  it('sends the next run to another host even when a sibling container looks idle', async () => {
    const c = await company();
    const one = await c.planless(c.ceo, 'container-one');
    const two = await c.planless(c.ceo, 'container-two');
    const mac = await c.machine(c.ceo, 'macbook', idle({ load: 6 }));
    reportHost(c, one.nodeId, 'linux');
    reportHost(c, two.nodeId, 'linux');
    reportHost(c, mac.nodeId, 'mac', { hostLoad: 6 });
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    await nextOf(one.node, 'tests.run');
    await call('run_tests', { command: 'make test' });
    const state = JSON.parse((await call('test_run', { run: 2 })).text);
    expect(state.parts).toMatchObject([{ status: 'running', machine: 'macbook' }]);
    expect(await gets(two.node, 'tests.run')).toBe(false);
  });

  it('keeps the next run queued until a part on the shared host ends', async () => {
    const c = await company();
    const one = await c.planless(c.ceo, 'container-one');
    const two = await c.planless(c.ceo, 'container-two');
    reportHost(c, one.nodeId, 'linux');
    reportHost(c, two.nodeId, 'linux');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    const first = await nextOf(one.node, 'tests.run');
    const waits = await call('run_tests', { command: 'make test' });
    expect(waits.text).toMatch(/Test run 2.*waits for a free machine/);
    expect(JSON.parse((await call('test_run', { run: 2 })).text).parts).toMatchObject([{ status: 'queued', machine: null }]);
    expect(await gets(two.node, 'tests.run')).toBe(false);
    const pool = (await c.app.inject({ url: '/api/pool', ...as(c.ceo) })).json();
    expect(pool.waiting[0].why).toMatch(/Running another part/);
    one.node.send(done(first));
    await nextOf(one.node, 'tests.run');
    expect(JSON.parse((await call('test_run', { run: 2 })).text).parts[0].status).toBe('running');
  });

  it('counts the built-in node and containers on its host together', async () => {
    const c = await company();
    const node = await c.builtin();
    reportHost(c, null, 'linux');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    await nextOf(node, 'tests.run');
    const container = await c.machine(c.ceo, 'container');
    reportHost(c, container.nodeId, 'linux');
    expect((await call('run_tests', { command: 'make test' })).text).toMatch(/waits for a free machine/);
    expect(await gets(container.node, 'tests.run')).toBe(false);
  });

  it('allows two places on one host when configured and queues the third', async () => {
    const c = await company({ MAX_RUNS_PER_HOST: '2' });
    const one = await c.planless(c.ceo, 'container-one');
    const two = await c.planless(c.ceo, 'container-two');
    reportHost(c, one.nodeId, 'linux');
    reportHost(c, two.nodeId, 'linux');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test -- {part}', parts: 3 });
    expect(JSON.parse((await call('test_run', { run: 1 })).text).parts).toMatchObject([
      { status: 'running', machine: 'container-one' }, { status: 'running', machine: 'container-two' }, { status: 'queued', machine: null },
    ]);
  });

  it('keeps a node reserved even when the host allows two parts, since its runs share a user', async () => {
    const c = await company({ MAX_RUNS_PER_HOST: '2' });
    const box = await c.planless(c.ceo, 'container');
    reportHost(c, box.nodeId, 'linux');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test -- {part}', parts: 2 });
    expect(JSON.parse((await call('test_run', { run: 1 })).text).parts).toMatchObject([{ status: 'running' }, { status: 'queued' }]);
  });

  it('uses the newest report of a shared host even when its other container reported an idle host earlier', async () => {
    const c = await company();
    const one = await c.planless(c.ceo, 'stale-container');
    const two = await c.planless(c.ceo, 'current-container');
    const mac = await c.machine(c.ceo, 'macbook', idle({ load: 6 }));
    reportHost(c, one.nodeId, 'linux', { hostLoad: 1 });
    await new Promise(r => setTimeout(r, 5));
    reportHost(c, two.nodeId, 'linux', { hostLoad: 15 });
    reportHost(c, mac.nodeId, 'mac', { hostLoad: 5 });
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    expect(JSON.parse((await call('test_run', { run: 1 })).text).parts).toMatchObject([{ machine: 'macbook' }]);
  });

  it('reserves the shared host between parts of one run in one queue pass', async () => {
    const c = await company();
    const one = await c.planless(c.ceo, 'container-one');
    const two = await c.planless(c.ceo, 'container-two');
    reportHost(c, one.nodeId, 'linux');
    reportHost(c, two.nodeId, 'linux');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test -- {part}', parts: 2 });
    expect(JSON.parse((await call('test_run', { run: 1 })).text).parts).toMatchObject([{ status: 'running' }, { status: 'queued' }]);
  });

  it('keeps old places without a host separate, including the built-in node', async () => {
    const c = await company();
    await c.planless(c.ceo, 'one');
    await c.planless(c.ceo, 'two');
    await c.builtin();
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test -- {part}', parts: 3 });
    expect(JSON.parse((await call('test_run', { run: 1 })).text).parts.map((p: { status: string }) => p.status)).toEqual(['running', 'running', 'running']);
  });

  it('picks by host resources instead of an idle container on a loaded host', async () => {
    const c = await company();
    const one = await c.planless(c.ceo, 'idle-container');
    const mac = await c.machine(c.ceo, 'macbook', idle({ load: 6 }));
    reportHost(c, one.nodeId, 'linux', { hostLoad: 15 });
    reportHost(c, mac.nodeId, 'mac', { hostLoad: 2 });
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    expect(JSON.parse((await call('test_run', { run: 1 })).text).parts).toMatchObject([{ machine: 'macbook' }]);
  });

  it('keeps the host slot occupied while a disconnected node may still run its part', async () => {
    const c = await company();
    const one = await c.planless(c.ceo, 'container-one');
    const two = await c.planless(c.ceo, 'container-two');
    reportHost(c, one.nodeId, 'linux');
    reportHost(c, two.nodeId, 'linux');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    await nextOf(one.node, 'tests.run');
    one.node.close();
    await until(() => !c.app.ctx.hub.isOnline(nodeIdentity(one.nodeId)));
    expect((await call('run_tests', { command: 'make test' })).text).toMatch(/waits for a free machine/);
    expect(await gets(two.node, 'tests.run')).toBe(false);
  });

  it('tries another physical computer when a sibling container lost a part', async () => {
    const c = await company();
    const one = await c.planless(c.ceo, 'container-one');
    const two = await c.planless(c.ceo, 'container-two');
    const mac = await c.machine(c.ceo, 'macbook', idle({ load: 6 }));
    reportHost(c, one.nodeId, 'linux');
    reportHost(c, two.nodeId, 'linux');
    reportHost(c, mac.nodeId, 'mac', { hostLoad: 6 });
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    const first = await nextOf(one.node, 'tests.run');
    one.node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], tests: [], load: idle() });
    await until(async () => (await c.db.select().from(testParts)).some(p => p.id !== first.partId));
    expect(JSON.parse((await call('test_run', { run: 1 })).text).parts).toMatchObject([{ status: 'running', machine: 'macbook' }]);
  });

  it('does not give a shared host two parts when run requests arrive together', async () => {
    const c = await company();
    const one = await c.planless(c.ceo, 'container-one');
    const two = await c.planless(c.ceo, 'container-two');
    reportHost(c, one.nodeId, 'linux');
    reportHost(c, two.nodeId, 'linux');
    const { call } = await c.turn(c.bruno);
    await Promise.all([call('run_tests', { command: 'make test' }), call('run_tests', { command: 'make test' })]);
    const parts = await c.db.select().from(testParts).orderBy(asc(testParts.createdAt));
    expect(parts.map(p => p.status).sort()).toEqual(['queued', 'running']);
  });

  it('recovers the occupied host from the database when its sibling reconnects before it after a server restart', async () => {
    const c = await company();
    const one = await c.planless(c.ceo, 'container-one');
    const two = await c.planless(c.ceo, 'container-two');
    reportHost(c, one.nodeId, 'linux');
    reportHost(c, two.nodeId, 'linux');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    await nextOf(one.node, 'tests.run');
    one.node.close();
    await until(() => !c.app.ctx.hub.isOnline(nodeIdentity(one.nodeId)));
    await call('run_tests', { command: 'make test' });
    /* A new server context has the persisted database and the sibling's connection, without the old server's cache. */
    await pumpTests({ ...c.app.ctx });
    expect(JSON.parse((await call('test_run', { run: 2 })).text).parts).toMatchObject([{ status: 'queued', machine: null }]);
    expect(await gets(two.node, 'tests.run')).toBe(false);
  });

  it('queues and explains a run whose host has memory but whose container does not', async () => {
    const c = await company();
    const box = await c.planless(c.ceo, 'small-container');
    reportHost(c, box.nodeId, 'linux', { memFree: 2 * GIB, hostMemFree: 12 * GIB });
    const { call } = await c.turn(c.bruno);
    expect((await call('run_tests', { command: 'make test' })).text).toMatch(/waits for a free machine/);
    const pool = (await c.app.inject({ url: '/api/pool', ...as(c.ceo) })).json();
    expect(pool.waiting[0].why).toMatch(/Short of the 4 GB/);
  });
});

describe('a test run', () => {
  it('runs on a machine that joined without a plan, as on any machine of the company', async () => {
    const c = await company();
    const box = await c.planless(c.ceo, 'build-box');
    const { call } = await c.turn(c.bruno);
    expect((await call('run_tests', { command: 'npm test' })).error).toBe(false);
    const run = await nextOf(box.node, 'tests.run');
    expect(run).toMatchObject({ command: 'npm test', part: 1, parts: 1 });
    expect((await c.db.select().from(testParts))[0]).toMatchObject({ status: 'running', nodeId: box.nodeId, machineId: box.machineId, machineName: 'build-box' });
    box.node.send(done(run));
    await nextOf(box.node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/part 1 of 1 passed on build-box|passed on build-box/i);
  });

  it('splits into parts across the freest machines, puts each log on the task and wakes the agent with the result', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac', idle({ load: 6 }));
    const ann = await c.machine(c.ann, 'ann-pc');
    const { call } = await c.turn(c.bruno);
    const started = await call('run_tests', { command: 'npm test -- --shard={part}/{parts}', parts: 2 });
    expect(started.error).toBe(false);
    expect(started.text).toContain('Test run 1');
    const first = await nextOf(ann.node, 'tests.run');
    const second = await nextOf(ivan.node, 'tests.run');
    expect(first).toMatchObject({ repo: { url: 'https://github.com/acme/shop.git', token: 'ghp_shop0123456789' }, branch: null, task: c.task.number, command: 'npm test -- --shard=1/2', part: 1, parts: 2, timeoutMs: 30 * 60_000 });
    expect(second).toMatchObject({ command: 'npm test -- --shard=2/2', part: 2, parts: 2 });
    ann.node.send({ type: 'tests.started', partId: first.partId });
    ann.node.send(done(first, { log: 'ok 12 tests\n' }));
    expect(await nextOf(ann.node, 'tests.ack')).toEqual({ type: 'tests.ack', partId: first.partId });
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    ivan.node.send(done(second, { ok: false, exitCode: 1, error: 'failed', log: `${lines}\nFAIL cart.test.ts: expected 2, got 3\n` }));
    await nextOf(ivan.node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    const prompt = (await c.wokeWith(c.bruno.id))!;
    expect(prompt).toContain('Test run 1 failed');
    expect(prompt).toMatch(/part 1 of 2 passed on ann-pc/i);
    expect(prompt).toMatch(/part 2 of 2 failed on ivan-mac/i);
    expect(prompt).toContain('> FAIL cart.test.ts: expected 2, got 3');
    expect(prompt).not.toContain('line 1\n');
    expect(prompt).toContain('tests-1-2.log');
    expect(await c.filesOn()).toEqual([
      { name: 'tests-1-1.log', text: 'ok 12 tests\n' },
      { name: 'tests-1-2.log', text: `${lines}\nFAIL cart.test.ts: expected 2, got 3\n` },
    ]);
    const state = JSON.parse((await call('test_run', { run: 1 })).text);
    expect(state).toMatchObject({ run: 1, task: c.task.number, status: 'failed', parts: [{ part: 1, status: 'passed', machine: 'ann-pc', log: 'tests-1-1.log' }, { part: 2, status: 'failed', machine: 'ivan-mac', exitCode: 1 }] });
  });

  it('runs one part at a time on a machine, and a part that finds none free waits for the first that frees up', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test', branch: 'task-1-checkout' });
    const one = await nextOf(ivan.node, 'tests.run');
    expect(one.branch).toBe('task-1-checkout');
    const waits = await call('run_tests', { command: 'make test', branch: 'task-1-checkout' });
    expect(waits.text).toMatch(/waits for a free machine/);
    expect(JSON.parse((await call('test_run', { run: 2 })).text)).toMatchObject({ status: 'running', parts: [{ part: 1, status: 'queued', machine: null }] });
    expect(await gets(ivan.node, 'tests.run')).toBe(false);
    ivan.node.send(done(one));
    const two = await nextOf(ivan.node, 'tests.run');
    expect(two.partId).not.toBe(one.partId);
  });

  it('waits while no machine has the free memory its repository needs', async () => {
    const c = await company();
    await c.db.update(departments).set({ repoTestMemoryGb: 8 }).where(eq(departments.id, c.dev.id));
    const ivan = await c.machine(c.ceo, 'ivan-mac', idle({ memFree: 6 * GIB }));
    const { call } = await c.turn(c.bruno);
    expect((await call('run_tests', { command: 'make test' })).text).toMatch(/waits for a free machine/);
    expect(await gets(ivan.node, 'tests.run')).toBe(false);
    ivan.node.send({ type: 'load', ...idle({ memFree: 9 * GIB }) });
    expect((await nextOf(ivan.node, 'tests.run')).command).toBe('make test');
  });

  it('gives no new part to a loaded machine, and gives it one once its load drops', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac', idle({ load: 7.6 }));
    const { call } = await c.turn(c.bruno);
    expect((await call('run_tests', { command: 'make test' })).text).toMatch(/waits for a free machine/);
    expect(await gets(ivan.node, 'tests.run')).toBe(false);
    ivan.node.send({ type: 'load', ...idle({ load: 2 }) });
    expect((await nextOf(ivan.node, 'tests.run')).command).toBe('make test');
  });

  it('leaves out a machine its owner took back, and one whose owner does not reach the repository', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac', idle({ load: 7 }));
    const ann = await c.machine(c.ann, 'ann-pc');
    const bob = await c.machine(c.bob, 'bob-pc');
    expect((await c.app.inject({ method: 'PATCH', url: `/api/machines/${ann.machineId}`, payload: { lendsTests: false }, ...as(c.ann) })).statusCode).toBe(200);
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test -- {part}', parts: 3 });
    expect((await nextOf(ivan.node, 'tests.run')).part).toBe(1);
    expect(await gets(ann.node, 'tests.run')).toBe(false);
    expect(await gets(bob.node, 'tests.run')).toBe(false);
    expect((await c.app.inject({ method: 'PATCH', url: `/api/machines/${ann.machineId}`, payload: { lendsTests: true }, ...as(c.ann) })).statusCode).toBe(200);
    expect((await nextOf(ann.node, 'tests.run')).part).toBe(2);
  });

  it('fails a part that runs past its time, and tells its node to stop it', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test', minutes: 5 });
    const run = await nextOf(ivan.node, 'tests.run');
    expect(run.timeoutMs).toBe(5 * 60_000);
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 4 * 60_000));
    expect(await gets(ivan.node, 'tests.cancel')).toBe(false);
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 15 * 60_000));
    expect(await nextOf(ivan.node, 'tests.cancel')).toEqual({ type: 'tests.cancel', partId: run.partId });
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 failed[\s\S]*did not end within 5 min/);
  });

  it('stops on stop_tests: its parts end, their nodes stop them, and nobody is woken', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test -- {part}', parts: 2 });
    const run = await nextOf(ivan.node, 'tests.run');
    const stopped = await call('stop_tests', { run: 1 });
    expect(stopped).toEqual({ text: 'Test run 1 is stopped.', error: false });
    expect(await nextOf(ivan.node, 'tests.cancel')).toEqual({ type: 'tests.cancel', partId: run.partId });
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ status: 'stopped', parts: [{ status: 'stopped' }, { status: 'stopped' }] });
    ivan.node.send(done(run, { ok: false, error: 'cancelled', exitCode: null, log: 'Stopped.\n' }));
    await nextOf(ivan.node, 'tests.ack');
    expect(await c.filesOn()).toEqual([{ name: 'tests-1-1.log', text: 'Stopped.\n' }]);
    expect(await c.wokeWith(c.bruno.id)).toBeNull();
    expect((await call('stop_tests', { run: 1 })).error).toBe(true);
    /* Sales sees nothing of development's runs. */
    expect((await (await c.turn(c.sam, null)).call('stop_tests', { run: 1 })).text).toMatch(/no test run 1/i);
  });

  it('wakes its agent when another one stopped it', async () => {
    const c = await company();
    await c.machine(c.ceo, 'ivan-mac');
    await (await c.turn(c.bruno)).call('run_tests', { command: 'make test' });
    expect((await (await c.turn(c.head, null)).call('stop_tests', { run: 1 })).error).toBe(false);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 was stopped by Hana/);
  });

  it('runs a lost part again on the machine that lost it when no other machine could ever fit it', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    await c.machine(c.ann, 'ann-pc', idle({ memFree: 1 * GIB, memTotal: 1 * GIB }));
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    const lost = await nextOf(ivan.node, 'tests.run');
    ivan.node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [] });
    const again = await nextOf(ivan.node, 'tests.run');
    expect(again).toMatchObject({ part: 1, command: 'make test' });
    expect(again.partId).not.toBe(lost.partId);
  });

  it('runs a part its machine lost in a restart again on another machine, under a new id, and says so', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac', idle({ load: 6 }));
    const ann = await c.machine(c.ann, 'ann-pc');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    const lost = await nextOf(ann.node, 'tests.run');
    ann.node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [] });
    const again = await nextOf(ivan.node, 'tests.run');
    expect(again).toMatchObject({ part: 1, command: 'make test' });
    expect(again.partId).not.toBe(lost.partId);
    expect(await gets(ann.node, 'tests.run')).toBe(false);
    /* The lost run's end, should it still come, changes nothing, and its node hears to stop it. */
    ann.node.send(done(lost, { ok: false, exitCode: 1, error: 'failed' }));
    await nextOf(ann.node, 'tests.ack');
    ann.node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [lost.partId] });
    expect(await nextOf(ann.node, 'tests.cancel')).toEqual({ type: 'tests.cancel', partId: lost.partId });
    expect(await c.wokeWith(c.bruno.id)).toBeNull();
    ivan.node.send(done(again));
    await nextOf(ivan.node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 passed[\s\S]*Part 1 of 1 passed on ivan-mac[^\n]*It ran again after ann-pc restarted and lost it\./);
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ parts: [{ status: 'passed', machine: 'ivan-mac', ranAgain: ['ann-pc restarted and lost it'] }] });
  });

  it('keeps a part through a 60-second disconnect and accepts its result after return', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const { job, call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    const started = await nextOf(ivan.node, 'tests.run');
    ivan.node.close();
    await until(() => !c.app.ctx.hub.isOnline({ kind: 'node', nodeId: ivan.nodeId }));

    await checkTestTimes(c.app.ctx, new Date(Date.now() + 60_000));
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ status: 'running', parts: [{ status: 'running' }] });

    const back = await connectNode(c.url, ivan.key);
    back.send({ type: 'hello', version: '0.6.1', loggedIn: true, running: [job.id], load: idle(), tests: [started.partId], work: true });
    await until(() => c.app.ctx.hub.isReady({ kind: 'node', nodeId: ivan.nodeId }));
    back.send(done(started));
    await nextOf(back, 'tests.ack');

    const result = JSON.parse((await call('test_run', { run: 1 })).text);
    expect(result).toMatchObject({ status: 'passed', parts: [{ status: 'passed' }] });
    expect(result.parts[0].ranAgain).toBeUndefined();
    expect(await gets(back, 'tests.cancel')).toBe(false);
  });

  it('runs a part again once its machine is away for 3 minutes, at most twice, then fails it and says where it was lost', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    await nextOf(ivan.node, 'tests.run');
    ivan.node.close();
    await until(() => !c.app.ctx.hub.isOnline({ kind: 'node', nodeId: ivan.nodeId }));
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 60_000));
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ parts: [{ status: 'running' }] });
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 4 * 60_000));
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ status: 'running', parts: [{ status: 'queued', ranAgain: ['ivan-mac went offline'] }] });
    /* The only machine there is takes it again once it is back. */
    const back = await c.reconnect(ivan);
    await nextOf(back, 'tests.run');
    back.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [] });
    await nextOf(back, 'tests.run');
    back.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [] });
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(
      /Test run 1 failed[\s\S]*Part 1 of 1 failed on ivan-mac[^:\n]*: its machine restarted and lost it\. It ran again after ivan-mac went offline, and again after ivan-mac restarted and lost it\./,
    );
    expect(await gets(back, 'tests.run')).toBe(false);
  });

  it("does not count a turn that ended while its test run goes on as standing still", async () => {
    const c = await company();
    await c.machine(c.ceo, 'ivan-mac');
    const { job, call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, job.id));
    await afterJob(c.app.ctx, job.id);
    expect((await c.db.select({ silent: tasks.silent }).from(tasks).where(eq(tasks.id, c.task.id)))[0]).toEqual({ silent: 0 });
    expect(await c.wokeWith(c.bruno.id)).toBeNull();
  });

  it('goes to the built-in node too, which reaches every repository', async () => {
    const c = await company();
    const node = await c.builtin();
    await (await c.turn(c.bruno)).call('run_tests', { command: 'make test' });
    const run = await nextOf(node, 'tests.run');
    node.send(done(run));
    await nextOf(node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 passed[\s\S]*Part 1 of 1 passed on the built-in node/);
  });

  it('ends a part that found no free machine within 2 hours', async () => {
    const c = await company();
    const { call } = await c.turn(c.bruno);
    expect((await call('run_tests', { command: 'make test' })).text).toMatch(/No machine that may take it is online now/);
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 60 * 60_000));
    expect(await c.wokeWith(c.bruno.id)).toBeNull();
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 3 * 60 * 60_000));
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 failed[\s\S]*no machine was free for it within 120 min/);
  });

  it('runs the parts of a machine disconnected from the company, and of a removed plan, again on another machine', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const ann = await c.machine(c.ann, 'ann-pc');
    const spare = await c.planless(c.ceo, 'spare-box', idle({ load: 7 }));
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test -- {part}', parts: 2 });
    const first = await nextOf(ivan.node, 'tests.run');
    await nextOf(ann.node, 'tests.run');
    expect((await c.app.inject({ method: 'POST', url: `/api/machines/${ivan.machineId}/disconnect`, ...as(c.ceo) })).statusCode).toBe(204);
    const one = await nextOf(spare.node, 'tests.run');
    expect(one).toMatchObject({ part: 1 });
    expect(one.partId).not.toBe(first.partId);
    expect((await c.app.inject({ method: 'DELETE', url: `/api/subscriptions/${ann.subscriptionId}`, ...as(c.ann) })).statusCode).toBe(204);
    /* One part at a time on a machine: the second waits for the first to end there. */
    expect(await gets(spare.node, 'tests.run')).toBe(false);
    spare.node.send(done(one));
    const two = await nextOf(spare.node, 'tests.run');
    expect(two).toMatchObject({ part: 2 });
    spare.node.send(done(two));
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    const prompt = (await c.wokeWith(c.bruno.id))!;
    expect(prompt).toMatch(/Test run 1 passed/);
    expect(prompt).toMatch(/Part 1 of 2 passed on spare-box[^\n]*It ran again after ivan-mac was disconnected from the company\./);
    expect(prompt).toMatch(/Part 2 of 2 passed on spare-box[^\n]*It ran again after ann-pc lost the plan its node ran for\./);
  });

  it('brings its result into the turn that already waits on the task', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const { job, call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    const run = await nextOf(ivan.node, 'tests.run');
    await c.db.insert(jobs).values({ companyId: job.companyId, subscriptionId: job.subscriptionId, agentId: c.bruno.id, taskId: c.task.id, kind: 'conversation', prompt: 'Rita sent it back.', timeoutMs: 900000 });
    ivan.node.send(done(run));
    await nextOf(ivan.node, 'tests.ack');
    await until(async () => /Test run 1 passed/.test((await c.wokeWith(c.bruno.id)) ?? ''));
    expect(await c.wokeWith(c.bruno.id)).toMatch(/^Rita sent it back\.\n\nThe tests you ran on #1/);
    expect((await c.db.select().from(jobs).where(and(eq(jobs.agentId, c.bruno.id), eq(jobs.status, 'queued')))).length).toBe(1);
  });

  it('is refused without a repository, without {part} in a split command, past 3 open runs, and without a task', async () => {
    const c = await company();
    const { call } = await c.turn(c.bruno);
    expect(await call('run_tests', { command: 'make test', parts: 2 })).toMatchObject({ error: true, text: expect.stringContaining('{part}') });
    for (let i = 0; i < 3; i++) expect((await call('run_tests', { command: 'make test' })).error).toBe(false);
    expect(await call('run_tests', { command: 'make test' })).toMatchObject({ error: true, text: expect.stringContaining('3') });
    expect((await (await c.turn(c.sam, null)).call('run_tests', { command: 'make test' })).text).toMatch(/task/);
    const [own] = await c.db.insert(tasks).values({ companyId: c.task.companyId, number: 99, title: 'Pitch', brief: '', body: '', departmentId: c.sales.id, assigneeAgentId: c.sam.id, status: 'working' }).returning();
    expect((await (await c.turn(c.sam, own!.id)).call('run_tests', { command: 'make test' })).text).toMatch(/repository/);
  });
});

describe('a run of other work', () => {
  it("runs a command with no branch on a free machine, hands its node the task's files it names, and puts what it made on the task", async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const { call } = await c.turn(c.bruno);
    await c.putFile('data.csv', 'a,b\n');
    const started = await call('run_work', { command: 'python3 make.py', files: ['data.csv'] });
    expect(started).toMatchObject({ error: false, text: expect.stringMatching(/^Work run 1 of #1 runs on ivan-mac\./) });
    const run = await nextOf(ivan.node, 'tests.run');
    expect(run).toMatchObject({ kind: 'work', repo: null, branch: null, files: ['data.csv'], command: 'python3 make.py', part: 1, parts: 1, timeoutMs: 30 * 60_000 });
    const node = { authorization: `Bearer ${ivan.key}` };
    const fetched = await c.app.inject({ url: `/api/parts/${run.partId}/files/data.csv`, headers: node });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.body).toBe('a,b\n');
    const put = await c.app.inject({ method: 'PUT', url: `/api/parts/${run.partId}/files/report.txt`, headers: { ...node, 'content-type': 'application/octet-stream' }, payload: Buffer.from('made') });
    expect(put.statusCode).toBe(201);
    const listed = (await c.app.inject({ url: '/api/machines', ...as(c.ceo) })).json().machines;
    expect(listed).toEqual([expect.objectContaining({ hostname: 'ivan-mac', kind: 'computer', running: expect.objectContaining({ parts: [expect.objectContaining({ run: 1, part: 1, kind: 'work' })] }) })]);
    ivan.node.send(done(run, { commit: null, log: 'Put on the task: report.txt.\n' }));
    await nextOf(ivan.node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    const prompt = (await c.wokeWith(c.bruno.id))!;
    expect(prompt).toMatch(/^The work you ran on #1/);
    expect(prompt).toMatch(/Work run 1 is done[\s\S]*Part 1 of 1 done on ivan-mac/);
    expect(prompt).toMatch(/What it made is on #1: work-1-1-report\.txt/);
    expect(prompt).toContain('work-1-1.log');
    expect((await c.filesOn()).map(f => f.name).sort()).toEqual(['data.csv', 'work-1-1-report.txt', 'work-1-1.log']);
    expect((await c.filesOn()).find(f => f.name === 'work-1-1-report.txt')!.text).toBe('made');
    expect(JSON.parse((await call('work_run', { run: 1 })).text)).toMatchObject({
      run: 1,
      kind: 'work',
      branch: null,
      files: ['data.csv'],
      status: 'done',
      parts: [{ part: 1, status: 'done', machine: 'ivan-mac', log: 'work-1-1.log', made: ['work-1-1-report.txt'] }],
    });
  });

  it('drops what a lost attempt put on the task, so the part that runs again makes its own files', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_work', { command: 'make report' });
    const first = await nextOf(ivan.node, 'tests.run');
    const node = { authorization: `Bearer ${ivan.key}`, 'content-type': 'application/octet-stream' };
    const put = (partId: string, name: string) => c.app.inject({ method: 'PUT', url: `/api/parts/${partId}/files/${name}`, headers: node, payload: Buffer.from(name) });
    for (let i = 1; i <= 20; i++) expect((await put(first.partId, `old-${i}.txt`)).statusCode).toBe(201);
    ivan.node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [], work: true });
    const again = await nextOf(ivan.node, 'tests.run');
    expect(await c.filesOn()).toEqual([]);
    expect((await put(again.partId, 'new.txt')).statusCode).toBe(201);
    ivan.node.send(done(again, { commit: null }));
    await nextOf(ivan.node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/What it made is on #1: work-1-1-new\.txt\./);
  });

  it('runs a part again after its machine went offline only when the run said it may run twice, and says why it did not', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const ann = await c.machine(c.ann, 'ann-pc', idle({ load: 6 }));
    const { call } = await c.turn(c.bruno);
    const away = async (m: { node: FakeNode; nodeId: string }) => {
      m.node.close();
      await until(() => !c.app.ctx.hub.isOnline(nodeIdentity(m.nodeId)));
      await checkTestTimes(c.app.ctx, new Date(Date.now() + 60_000));
      await checkTestTimes(c.app.ctx, new Date(Date.now() + 4 * 60_000));
    };
    await call('run_work', { command: 'make deploy' });
    await nextOf(ivan.node, 'tests.run');
    await away(ivan);
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Work run 1 failed[\s\S]*Part 1 of 1 failed on ivan-mac[^:]*: its machine went offline, and it did not run again elsewhere, as it may still run there and run_work did not say it is repeatable/);
    expect(await gets(ann.node, 'tests.run')).toBe(false);

    await call('run_work', { command: 'make report', repeatable: true });
    expect(await nextOf(ann.node, 'tests.run')).toMatchObject({ command: 'make report' });
    await away(ann);
    expect(JSON.parse((await call('work_run', { run: 2 })).text)).toMatchObject({ repeatable: true, parts: [{ status: 'queued', ranAgain: ['ann-pc went offline'] }] });
  });

  it('clones a branch first when one is named, and splits into parts like a test run', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const ann = await c.machine(c.ann, 'ann-pc');
    const { call } = await c.turn(c.bruno);
    expect((await call('run_work', { command: 'render --frames {part}/{parts}', branch: 'main', parts: 2, minutes: 90 })).error).toBe(false);
    const runs = [await nextOf(ivan.node, 'tests.run'), await nextOf(ann.node, 'tests.run')].sort((a, b) => a.part - b.part);
    expect(runs[0]).toMatchObject({ kind: 'work', repo: { url: 'https://github.com/acme/shop.git', token: 'ghp_shop0123456789' }, branch: 'main', command: 'render --frames 1/2', files: [], timeoutMs: 90 * 60_000 });
    expect(runs[1]).toMatchObject({ command: 'render --frames 2/2' });
  });

  it("is refused a file its task lacks, a branch with no repository and a split command without {part}, and a part's files reach only the node that runs it", async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const ann = await c.machine(c.ann, 'ann-pc', idle({ load: 7.5 }));
    const { call } = await c.turn(c.bruno);
    await c.putFile('data.csv', 'a,b\n');
    await c.putFile('secret.txt', 'not for this run');
    expect(await call('run_work', { command: 'x', files: ['nope.csv'] })).toMatchObject({ error: true, text: expect.stringContaining('#1 has no file nope.csv') });
    expect(await call('run_work', { command: 'x', parts: 2 })).toMatchObject({ error: true, text: expect.stringContaining('{part}') });
    await call('run_work', { command: 'x', files: ['data.csv'] });
    const run = await nextOf(ivan.node, 'tests.run');
    const file = (name: string, key?: string) => c.app.inject({ url: `/api/parts/${run.partId}/files/${name}`, headers: key ? { authorization: `Bearer ${key}` } : {} });
    expect((await file('data.csv', ann.key)).statusCode).toBe(404);
    expect((await file('secret.txt', ivan.key)).statusCode).toBe(404);
    expect((await file('data.csv')).statusCode).toBe(401);
    expect((await file('data.csv', ivan.key)).statusCode).toBe(200);
    ivan.node.send(done(run, { commit: null }));
    await nextOf(ivan.node, 'tests.ack');
    const late = await c.app.inject({ method: 'PUT', url: `/api/parts/${run.partId}/files/late.txt`, headers: { authorization: `Bearer ${ivan.key}`, 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') });
    expect(late.statusCode).toBe(404);
    expect((await c.filesOn()).map(f => f.name)).not.toContain('work-1-1-late.txt');
    const [pitch] = await c.db.insert(tasks).values({ companyId: c.task.companyId, number: 99, title: 'Pitch', brief: '', body: '', departmentId: c.sales.id, assigneeAgentId: c.sam.id, status: 'working' }).returning();
    const sam = await c.turn(c.sam, pitch!.id);
    expect(await sam.call('run_work', { command: 'x', branch: 'main' })).toMatchObject({ error: true, text: expect.stringMatching(/no repository/) });
    expect((await sam.call('run_work', { command: 'x' })).error).toBe(false);
  });

  it('goes only to machines whose node runs work, waits for the free memory it asks for, and stops on stop_work', async () => {
    const c = await company();
    const old = await c.machine(c.ceo, 'old-mac', idle(), { work: false });
    const { call } = await c.turn(c.bruno);
    expect((await call('run_work', { command: 'small' })).text).toMatch(/waits for a free machine/);
    expect(await gets(old.node, 'tests.run')).toBe(false);
    const ann = await c.machine(c.ann, 'ann-pc', idle({ memFree: 6 * GIB }));
    const small = await nextOf(ann.node, 'tests.run');
    expect(small).toMatchObject({ kind: 'work', command: 'small' });
    ann.node.send(done(small, { commit: null }));
    await nextOf(ann.node, 'tests.ack');
    expect((await call('run_work', { command: 'big', memory: 8 })).text).toMatch(/waits for a free machine/);
    expect(await gets(ann.node, 'tests.run')).toBe(false);
    ann.node.send({ type: 'load', ...idle({ memFree: 9 * GIB }) });
    const big = await nextOf(ann.node, 'tests.run');
    expect(big.command).toBe('big');
    /* Test runs still go to a node that knows only them. */
    await call('run_tests', { command: 'make test' });
    expect((await nextOf(old.node, 'tests.run')).kind ?? 'tests').toBe('tests');
    expect(await call('stop_work', { run: 2 })).toEqual({ text: 'Work run 2 is stopped.', error: false });
    expect(await nextOf(ann.node, 'tests.cancel')).toEqual({ type: 'tests.cancel', partId: big.partId });
  });
});

describe('the pool of machines', () => {
  it('shows the orchestrator every machine with its load, the parts it runs and why each waiting part waits', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    await c.machine(c.ann, 'ann-pc', idle({ load: 7.6 }));
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'npm test -- --shard={part}/{parts}', parts: 2 });
    const first = await nextOf(ivan.node, 'tests.run');
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const boss = await c.turn(orchestrator!, null);

    const pool = JSON.parse((await boss.call('pool')).text);
    expect(pool.machines).toEqual([
      expect.objectContaining({ name: 'ivan-mac', owner: 'Ivan', kind: 'computer', online: true, lent: true, loaded: false, load: expect.objectContaining({ cpus: 8 }), parts: [expect.objectContaining({ run: 1, kind: 'tests', task: c.task.number, part: 1, parts: 2, agent: 'Bruno', command: 'npm test -- --shard=1/2', ranAgain: [] })] }),
      expect.objectContaining({ name: 'ann-pc', owner: 'Ann', online: true, lent: true, loaded: true, parts: [] }),
    ]);
    expect(pool.builtin).toMatchObject({ online: false, parts: [] });
    expect(pool.waiting).toEqual([expect.objectContaining({ run: 1, kind: 'tests', task: c.task.number, part: 2, parts: 2, agent: 'Bruno', why: 'Running another part: ivan-mac. Loaded: ann-pc.' })]);

    /* Once the first part is done, the second goes out, and nothing waits. */
    ivan.node.send(done(first));
    await nextOf(ivan.node, 'tests.run');
    const after = JSON.parse((await boss.call('pool')).text);
    expect(after.waiting).toEqual([]);
    expect(after.machines[0].parts).toEqual([expect.objectContaining({ part: 2 })]);
  });

  it('says a part waits for a lent machine, for one its department reaches, for one that runs work, or for free memory', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac', idle({ memFree: 1 * GIB }), { work: false });
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const boss = await c.turn(orchestrator!, null);
    const why = async () => JSON.parse((await boss.call('pool')).text).waiting.map((w: { why: string }) => w.why);
    const lend = (machineId: string, lendsTests: boolean) => c.app.inject({ method: 'PATCH', url: `/api/machines/${machineId}`, payload: { lendsTests }, ...as(c.ceo) });

    await lend(ivan.machineId, false);
    await (await c.turn(c.bruno)).call('run_tests', { command: 'npm test' });
    expect(await why()).toEqual(['No computer lent to runs is online.']);
    await lend(ivan.machineId, true);
    expect(await why()).toEqual(['Short of the 4 GB of free memory it needs: ivan-mac.']);

    /* Ann's machine takes the test run; it reaches development only, and its node knows test runs alone. */
    await lend(ivan.machineId, false);
    const ann = await c.machine(c.ann, 'ann-pc', idle(), { work: false });
    await nextOf(ann.node, 'tests.run');
    const [pitch] = await c.db.insert(tasks).values({ companyId: c.task.companyId, number: 99, title: 'Pitch', brief: '', body: '', departmentId: c.sales.id, assigneeAgentId: c.sam.id, status: 'working' }).returning();
    await (await c.turn(c.sam, pitch!.id)).call('run_work', { command: 'make report' });
    expect(await why()).toEqual(['No lent machine online belongs to someone who reaches its department.']);
    await lend(ivan.machineId, true);
    expect(await why()).toEqual(['The lent machines online that may take it run a node too old for work: update their node.']);
  });

  it('shows a person who does not see the whole company only their own machines and what runs there', async () => {
    const c = await company();
    await c.machine(c.ceo, 'ivan-mac', idle({ load: 6 }));
    const ann = await c.machine(c.ann, 'ann-pc');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'npm test' });
    const part = await nextOf(ann.node, 'tests.run');
    const seen = (await c.app.inject({ method: 'GET', url: '/api/pool', ...as(c.ann) })).json();
    expect(seen.machines.map((m: { name: string }) => m.name)).toEqual(['ann-pc']);
    expect(seen.machines[0].parts).toEqual([expect.objectContaining({ run: 1, part: 1 })]);
    expect(seen).toMatchObject({ builtin: null, waiting: [] });
    void part;
  });

  it('shows each machine online and as busy as the machines screen does, a removed plan left out of both', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac', idle({ load: 3 }));
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const boss = await c.turn(orchestrator!, null);
    const both = async () => {
      const pool = JSON.parse((await boss.call('pool')).text).machines[0];
      const screen = (await c.app.inject({ url: '/api/machines', ...as(c.ceo) })).json().machines[0];
      return { pool: { online: pool.online, load: pool.load }, screen: { online: screen.online, load: screen.load } };
    };
    const now = await both();
    expect(now.pool).toEqual(now.screen);
    expect(now.pool).toMatchObject({ online: true, load: { load: 3 } });
    expect((await c.app.inject({ method: 'DELETE', url: `/api/subscriptions/${ivan.subscriptionId}`, ...as(c.ceo) })).statusCode).toBe(204);
    const after = await both();
    expect(after.pool).toEqual(after.screen);
    expect(after.pool).toEqual({ online: false, load: null });
  });

  it('gives no part to a machine whose node has no user of its own for runs, and shows why', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac', idle(), { noRuns: 'This node runs without a user of its own for runs.' });
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'npm test' });
    expect(await gets(ivan.node, 'tests.run')).toBe(false);
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const pool = JSON.parse((await (await c.turn(orchestrator!, null)).call('pool')).text);
    expect(pool.machines).toEqual([expect.objectContaining({ name: 'ivan-mac', online: true, noRuns: 'This node runs without a user of its own for runs.' })]);
    expect(pool.waiting).toEqual([expect.objectContaining({ part: 1, why: 'No computer lent to runs is online.' })]);
  });

  it('gives no part to a phone or a browser, which run no commands, and shows what kind each machine is', async () => {
    const c = await company();
    const phone = await c.machine(c.ceo, 'ivan-phone', idle(), { kind: 'phone' });
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'npm test' });
    expect(await gets(phone.node, 'tests.run')).toBe(false);
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const pool = JSON.parse((await (await c.turn(orchestrator!, null)).call('pool')).text);
    expect(pool.machines).toEqual([expect.objectContaining({ name: 'ivan-phone', kind: 'phone', online: true, lent: true, parts: [] })]);
    expect((await c.app.inject({ url: '/api/machines', ...as(c.ceo) })).json().machines).toEqual([expect.objectContaining({ hostname: 'ivan-phone', kind: 'phone' })]);
    expect(pool.waiting).toEqual([expect.objectContaining({ part: 1, why: 'No computer lent to runs is online.' })]);
    const box = await c.planless(c.ceo, 'build-box');
    expect(await nextOf(box.node, 'tests.run')).toMatchObject({ command: 'npm test' });
    expect((await c.app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: 'x', machineId: 'odd-0001-abcd', hostname: 'odd', os: 'linux', arch: 'x86_64', kind: 'toaster' } })).statusCode).toBe(400);
  });
});
