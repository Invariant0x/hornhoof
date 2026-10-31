import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, companies, departments, jobs, requests, subscriptions } from '../src/db/schema.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { as, connectNode, invitePerson, listen, setUpCompany, testApp, until } from './helpers.js';
import { agentState, enqueueTurn } from '../src/modules/conversation/queue.js';

const TOKEN = 'tool-token-watch-0123456789abcdef0123';
const NODE_KEY = 'k'.repeat(40);

/* Operations with Wendy, who runs a turn with the given skills, and Development with Hana at its head and Bruno, who holds
   a task. Everyone is on the company key, which the built-in node runs. */
async function company(skills: string[]) {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const builtin = await connectNode(url, NODE_KEY);
  onTestFinished(() => builtin.close());
  builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [] });
  const [acme] = await db.select().from(companies);
  const [sub] = await db.select().from(subscriptions);
  const [ops] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'operations', roleCode: 'OPS' }).returning();
  const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId: string, own: string[] = []) =>
    (await db.insert(agents).values({ companyId: acme!.id, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id, skills: own }).returning())[0]!;
  const wendy = await hire('Wendy', 'worker', 'OPS-FIX', ops!.id, skills);
  const hana = await hire('Hana', 'head', 'DEV-HEAD', dev!.id);
  const bruno = await hire('Bruno', 'worker', 'DEV-BE', dev!.id);
  /* The node says hello before Wendy's turn starts, so it does not end a turn it never ran. */
  await until(async () => (await agentState(app.ctx, bruno.id)).ready);
  await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: wendy.id, kind: 'conversation', prompt: 'round', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(TOKEN) });
  const task = (await createTask(app.ctx, { agentId: hana.id }, { title: 'Checkout API', brief: '', body: 'POST /checkout.', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true, gates: [] })).task;
  return { app, db, ceo, dev: dev!, acme: acme!, sub: sub!, wendy, hana, bruno, task };
}

async function mcp(app: FastifyInstance): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  onTestFinished(() => client.close());
  return client;
}

type Result = { content: { text: string }[]; isError?: boolean };
const call = async (client: Client, name: string, args: object = {}) => (await client.callTool({ name, arguments: args })) as Result;
const names = async (client: Client) => (await client.listTools()).tools.map(t => t.name);

describe('tools a skill grants', () => {
  it('are not there for an employee without such a skill', async () => {
    const { app } = await company([]);
    const tools = await names(await mcp(app));
    expect(tools).toContain('tasks');
    for (const name of ['agents', 'failures', 'message_employee']) expect(tools).not.toContain(name);
  });

  it("let a watchdog see every agent with what it holds, and nudge one in its window", async () => {
    const { app, db, bruno, task, wendy } = await company(['ops-task-watch']);
    const client = await mcp(app);
    const tools = await names(client);
    expect(tools).toEqual(expect.arrayContaining(['agents', 'message_employee']));
    expect(tools).not.toContain('failures');
    const all = JSON.parse((await call(client, 'agents')).content[0]!.text) as { name: string; department: string | null; on: boolean; busy: boolean; tasks: { number: number; status: string }[] }[];
    expect(all.map(a => a.name)).toEqual(expect.arrayContaining(['Orchestrator', 'Wendy', 'Hana', 'Bruno']));
    expect(all.find(a => a.name === 'Bruno')).toMatchObject({ department: 'Development', on: true, busy: false, tasks: [{ number: task.number, status: task.status }] });
    expect(all.find(a => a.name === 'Wendy')).toMatchObject({ busy: true });
    const nudge = await call(client, 'message_employee', { employee: bruno.id, text: 'Task #1 has had no report for an hour. Report or say what blocks you.' });
    expect(nudge.content[0]!.text).toBe("Sent to Bruno.");
    const [turn] = await db.select().from(jobs).where(and(eq(jobs.agentId, bruno.id), inArray(jobs.status, ['queued', 'running'])));
    expect(turn!.prompt).toBe('Wendy (Reliability engineer): Task #1 has had no report for an hour. Report or say what blocks you.');
    const [said] = await db.select().from(agentEvents).where(and(eq(agentEvents.agentId, bruno.id), eq(agentEvents.kind, 'message')));
    expect(said!.data).toMatchObject({ text: 'Task #1 has had no report for an hour. Report or say what blocks you.', from: 'agent', name: 'Wendy' });
    /* The map runs it from Operations to Development. */
    expect(app.ctx.bus.channels(wendy.companyId).map(c => [c.from, c.to])).toContainEqual([
      { kind: 'department', id: wendy.departmentId },
      { kind: 'department', id: bruno.departmentId },
    ]);
    expect((await call(client, 'message_employee', { employee: wendy.id, text: 'Hi me.' })).isError).toBe(true);
  });

  it('show until when a plan is at its limit, so the watchdog leaves its agents to wait', async () => {
    const { app, db, sub } = await company(['ops-task-watch']);
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    await db.update(subscriptions).set({ limits: { status: 'rejected', windows: [{ name: 'five_hour', utilization: 1, resetsAt }] } }).where(eq(subscriptions.id, sub.id));
    const all = JSON.parse((await call(await mcp(app), 'agents')).content[0]!.text) as { name: string; limitUntil: string | null }[];
    expect(all.find(a => a.name === 'Bruno')).toMatchObject({ limitUntil: resetsAt });
  });

  it('are turned on only by people who see the whole company, since they show all of it', async () => {
    const { app, ceo, dev, bruno } = await company([]);
    const dana = await invitePerson(app, ceo, { name: 'Dana', email: 'dana@acme.test', access: { departments: [dev.id] } });
    const grant = (token: string, skill: string) => app.inject({ method: 'PATCH', url: `/api/agents/${bruno.id}`, payload: { skills: { [skill]: true } }, ...as(token) });
    const refused = await grant(dana, 'ops-failure-review');
    expect([refused.statusCode, refused.json().error.reason]).toEqual([403, 'skill_company_only']);
    expect((await grant(dana, 'ops-postmortem')).statusCode).toBe(200);
    expect((await grant(ceo, 'ops-failure-review')).statusCode).toBe(200);
  });

  it('send at most ten messages in one turn', async () => {
    const { app, hana, bruno } = await company(['ops-task-watch']);
    const client = await mcp(app);
    for (let i = 0; i < 10; i++) expect((await call(client, 'message_employee', { employee: i % 2 ? hana.id : bruno.id, text: `Nudge ${i}.` })).isError).toBeFalsy();
    const more = await call(client, 'message_employee', { employee: hana.id, text: 'One more.' });
    expect([more.isError, more.content[0]!.text]).toEqual([true, 'One turn sends at most 10 messages. Go on in your next round.']);
  });

  it('keep to ten messages when a turn sends several at once', async () => {
    const { app, hana, bruno } = await company(['ops-task-watch']);
    const client = await mcp(app);
    for (let i = 0; i < 9; i++) await call(client, 'message_employee', { employee: bruno.id, text: `Nudge ${i}.` });
    const last = await Promise.all([1, 2, 3].map(i => call(client, 'message_employee', { employee: hana.id, text: `At once ${i}.` })));
    expect(last.filter(r => !r.isError)).toHaveLength(1);
  });

  it('count what a turn sent before Hornhoof restarted', async () => {
    const { app, acme, wendy, hana, bruno } = await company(['ops-task-watch']);
    /* Sent through the queue before a restart, so only what Hornhoof keeps knows of them. */
    for (let i = 0; i < 9; i++)
      await enqueueTurn(app.ctx, { companyId: acme.id, agentId: bruno.id, prompt: `Nudge ${i}.`, createdBy: null, message: { personId: null, text: `Nudge ${i}.`, from: 'agent', name: 'Wendy', by: wendy.id } });
    const client = await mcp(app);
    expect((await call(client, 'message_employee', { employee: hana.id, text: 'Last one.' })).isError).toBeFalsy();
    expect((await call(client, 'message_employee', { employee: hana.id, text: 'One more.' })).isError).toBe(true);
  });

  it('let a failure collector read the failed turns and blocked tasks of the last hours', async () => {
    const { app, db, acme, sub, bruno } = await company(['ops-failure-review']);
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    await db.insert(jobs).values([
      { companyId: acme.id, subscriptionId: sub.id, agentId: bruno.id, kind: 'conversation', prompt: 'x', timeoutMs: 1, status: 'failed', error: 'timeout', tail: 'npm test hung', finishedAt: ago(30) },
      { companyId: acme.id, subscriptionId: sub.id, agentId: bruno.id, kind: 'conversation', prompt: 'x', timeoutMs: 1, status: 'failed', error: 'agent_failed', tail: 'old', finishedAt: ago(600) },
      /* Stopped by a person: no failure of the system. */
      { companyId: acme.id, subscriptionId: sub.id, agentId: bruno.id, kind: 'conversation', prompt: 'x', timeoutMs: 1, status: 'failed', error: 'cancelled', tail: 'stopped', finishedAt: ago(20) },
    ]);
    const client = await mcp(app);
    const recent = JSON.parse((await call(client, 'failures', { hours: 6 })).content[0]!.text) as { failed: { agent: string; error: string; tail: string }[]; blocked: unknown[] };
    expect(recent.failed).toEqual([expect.objectContaining({ agent: 'Bruno', error: 'timeout', tail: 'npm test hung' })]);
    expect(recent.blocked).toEqual([]);
  });

  it('let a failure collector see where agents stumbled: programs they lacked, what they installed by hand, and where they stopped for people', async () => {
    const { app, db, acme, sub, hana, bruno, task } = await company(['ops-failure-review']);
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    const event = (agentId: string, kind: 'tool' | 'tool_result', data: object, minutes = 30) => ({ companyId: acme.id, agentId, kind, data, createdAt: ago(minutes) });
    await db.insert(agentEvents).values([
      event(bruno.id, 'tool_result', { ok: false, summary: '/bin/bash: line 1: ps: command not found\n' }),
      event(hana.id, 'tool_result', { ok: false, summary: 'load average 0.4\nbash: line 3: ps: command not found' }),
      event(hana.id, 'tool_result', { ok: false, summary: '/usr/bin/env: ‘python’: No such file or directory' }),
      event(bruno.id, 'tool_result', { ok: false, summary: "Traceback (most recent call last):\nModuleNotFoundError: No module named 'yaml.loader'" }),
      event(bruno.id, 'tool_result', { ok: false, summary: "Error: Cannot find module 'left-pad/index.js'" }),
      /* Its own script that is not there: nothing to install. */
      event(bruno.id, 'tool_result', { ok: false, summary: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/check/run.mjs'" }),
      event(bruno.id, 'tool_result', { ok: false, summary: 'bash: line 1: jq: command not found' }, 600),
      event(bruno.id, 'tool', { name: 'Bash', input: 'pip install --user pyyaml && python3 run.py' }),
      event(hana.id, 'tool', { name: 'exec_command', input: '/bin/bash,-lc,npm i -g pnpm; pnpm -v' }),
      event(bruno.id, 'tool', { name: 'Bash', input: 'npm install && npm test' }),
    ]);
    await db.insert(jobs).values({ companyId: acme.id, subscriptionId: sub.id, agentId: bruno.id, taskId: task.id, kind: 'conversation', prompt: 'x', timeoutMs: 1, status: 'done', result: '', tail: 'This content can’t be shown.', startedAt: ago(50), finishedAt: ago(45) });
    await db.insert(requests).values([
      { companyId: acme.id, taskId: task.id, agentId: bruno.id, kind: 'stuck', text: 'Ended 3 turns in a row on #1 without moving it.', createdAt: ago(44) },
      { companyId: acme.id, taskId: task.id, agentId: bruno.id, kind: 'question', text: 'Which payment provider?', status: 'answered', answer: 'Stripe', createdAt: ago(120) },
      { companyId: acme.id, taskId: task.id, agentId: bruno.id, kind: 'approval', text: 'Approve the commit.', createdAt: ago(10) },
    ]);
    const recent = JSON.parse((await call(await mcp(app), 'failures', { hours: 6 })).content[0]!.text);
    /* The most frequent first, then the newest, with the newest line that said it. */
    expect(recent.missing).toEqual([
      { what: 'ps', kind: 'command', times: 2, agents: ['Bruno', 'Hana'], example: 'bash: line 3: ps: command not found' },
      expect.objectContaining({ what: 'left-pad', kind: 'node module', agents: ['Bruno'] }),
      expect.objectContaining({ what: 'yaml', kind: 'python module', agents: ['Bruno'] }),
      expect.objectContaining({ what: 'python', kind: 'command', times: 1, agents: ['Hana'] }),
    ]);
    expect(recent.installed).toEqual([
      { command: 'npm i -g pnpm', times: 1, agents: ['Hana'] },
      { command: 'pip install --user pyyaml', times: 1, agents: ['Bruno'] },
    ]);
    expect(recent.stops).toEqual([
      { kind: 'stuck', agent: 'Bruno', task: task.number, text: 'Ended 3 turns in a row on #1 without moving it.', status: 'open', answer: null, lastTurn: 'This content can’t be shown.' },
      { kind: 'question', agent: 'Bruno', task: task.number, text: 'Which payment provider?', status: 'answered', answer: 'Stripe', lastTurn: null },
    ]);
  });
});
