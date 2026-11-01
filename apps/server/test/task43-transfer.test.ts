import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, people, subscriptions, tasks } from '../src/db/schema.js';
import { jobOf } from '../src/modules/tools/mcp.js';
import { listen, setUpCompany, testApp } from './helpers.js';

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
