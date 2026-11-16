import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, people, subscriptions, taskEvents } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { carriesFile } from '../src/modules/tasks/attachments.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { listen, setUpCompany, testApp } from './helpers.js';

const BASE64 = randomBytes(1200).toString('base64');

async function company() {
  const { app, db } = await testApp();
  await listen(app);
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', position: 1 }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const parent = (await createTask(app.ctx, { personId: ceo!.id }, { title: 'Payments', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: head.id })).task;
  const task = (await createTask(app.ctx, { agentId: head.id }, { title: 'Checkout API', brief: '', body: '', departmentId: dev!.id, parentId: parent.id, assigneeAgentId: bruno.id, executor: true })).task;
  let n = 0;
  const turn = async (agent: { id: string }) => {
    const token = `tool-token-${++n}-0123456789abcdef0123456789`;
    await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: agent.id, kind: 'conversation', prompt: 'go', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    return mcp(app, token);
  };
  const log = async () => (await db.select(only(taskEvents, 'kind')).from(taskEvents).where(eq(taskEvents.taskId, task.id))).map(e => e.kind);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  return { orchestrator: orchestrator!, head, bruno, task, turn, log };
}

async function mcp(app: FastifyInstance, token: string): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  onTestFinished(() => client.close());
  return client;
}

type Res = { content: { text: string }[]; isError?: boolean };
const call = async (c: Client, name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as Res;

describe('a text that carries a file', () => {
  it('is a long run of base64 or hex, on one line or wrapped', () => {
    expect(carriesFile(`Here it is: ${BASE64}`)).toBe(true);
    expect(carriesFile(BASE64.match(/.{1,76}/g)!.join('\n'))).toBe(true);
    expect(carriesFile(randomBytes(600).toString('hex'))).toBe(true);
  });

  it('is not prose, links, a list of commits or a long line of dashes', () => {
    expect(carriesFile('The build passed. '.repeat(200))).toBe(false);
    expect(carriesFile(`See https://github.com/acme/shop/compare/main...turn-3?expand=1&diff=split&w=1 ${'and more words '.repeat(80)}`)).toBe(false);
    expect(carriesFile(Array.from({ length: 60 }, () => randomBytes(20).toString('hex')).join('\n'))).toBe(false);
    expect(carriesFile('-'.repeat(1500))).toBe(false);
  });

  it('is refused in a comment, a blocked reason and a handed in task, with the way to put the file on the task', async () => {
    const { bruno, task, turn, log } = await company();
    const tools = await turn(bruno);
    const before = await log();
    for (const [name, args] of [
      ['comment', { task: task.number, text: `The dump: ${BASE64}` }],
      ['blocked', { task: task.number, why: `It fails on this file: ${BASE64}` }],
      ['submit', { task: task.number, summary: 'Done.', evidence: BASE64 }],
    ] as const) {
      const r = await call(tools, name, args);
      expect(r.isError, name).toBe(true);
      expect(r.content[0]!.text).toContain(`hh-attach --task ${task.number} FILE`);
    }
    expect(await log()).toEqual(before);
  });

  it("is refused in a message to another employee, the orchestrator's too", async () => {
    const { orchestrator, head, bruno, turn } = await company();
    for (const [from, to] of [[bruno, head], [orchestrator, bruno]]) {
      const r = await call(await turn(from!), 'message_employee', { employee: to!.id, text: BASE64 });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain('hh-attach --task');
    }
  });
});
