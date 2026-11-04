import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, companies, departments, jobs, requests, subscriptions, tasks } from '../src/db/schema.js';
import { blocked, createTask } from '../src/modules/tasks/engine.js';
import { as, connectNode, invitePerson, listen, mcp, setUpCompany, testApp, until } from './helpers.js';
import { agentState, enqueueTurn, GONE_ALONG } from '../src/modules/conversation/queue.js';
import { discardStaleTurn } from '../src/modules/tasks/wake-state.js';

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
  return { app, db, ceo, dev: dev!, ops: ops!, acme: acme!, sub: sub!, wendy, hana, bruno, task, hire };
}


type Result = { content: { text: string }[]; isError?: boolean };
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Result;
const names = async (client: Client) => (await client.listTools()).tools.map(t => t.name);

describe('tools a skill grants', () => {
  it('exposes node restart evidence to the failure collector separately from agent output', async () => {
    const { app, db, acme, sub, bruno, task } = await company(['ops-failure-review']);
    const interruption = { cause: 'container' as const, at: new Date().toISOString(), task: task.number, node: { id: null, name: 'the built-in node' }, machine: { id: 'machine-id', name: 'a-host' }, diagnosis: { kind: 'planned' as const, reason: 'hornhoof_update' as const, startedAt: null, at: null, log: 'Stopping node: hornhoof_update.' } };
    await db.insert(jobs).values({ companyId: acme.id, subscriptionId: sub.id, agentId: bruno.id, taskId: task.id, kind: 'conversation', prompt: 'Check.', timeoutMs: 1, status: 'failed', error: 'machine_restarted', tail: 'Last agent output.', interruption, finishedAt: new Date() });
    const result = JSON.parse((await call(await mcp(app, TOKEN), 'failures')).content[0]!.text);
    expect(result.failed).toEqual([expect.objectContaining({ agent: 'Bruno', error: 'machine_restarted', tail: 'Last agent output.', interruption })]);
  });

  it('are not there for an employee without such a skill', async () => {
    const { app } = await company([]);
    const tools = await names(await mcp(app, TOKEN));
    expect(tools).toContain('tasks');
    for (const name of ['agents', 'failures', 'restart_program']) expect(tools).not.toContain(name);
  });

  it('let any employee write to the people of its own department, and only to them', async () => {
    const { app, db, ops, bruno, hire } = await company([]);
    const olga = await hire('Olga', 'worker', 'OPS-INTEG', ops.id);
    const client = await mcp(app, TOKEN);
    expect(await names(client)).toContain('message_employee');
    expect((await call(client, 'message_employee', { employee: olga.id, text: 'Which token did the Stripe connector get? Your branch has none.' })).isError).toBeFalsy();
    expect((await db.select().from(jobs).where(eq(jobs.agentId, olga.id))).map(j => j.prompt)).toEqual([expect.stringContaining('Which token did the Stripe connector get?')]);
    const away = await call(client, 'message_employee', { employee: bruno.id, text: 'Hi Bruno.' });
    expect(away.isError).toBe(true);
    expect(away.content[0]!.text).toContain('another department');
  });

  it("let a watchdog see every agent with what it holds, and nudge one in its window", async () => {
    const { app, db, bruno, task, wendy } = await company(['ops-task-watch']);
    const client = await mcp(app, TOKEN);
    const tools = await names(client);
    expect(tools).toEqual(expect.arrayContaining(['agents', 'message_employee', 'restart_program']));
    expect(tools).not.toContain('failures');
    const all = JSON.parse((await call(client, 'agents')).content[0]!.text) as { name: string; department: string | null; on: boolean; busy: boolean; tasks: { number: number; status: string }[] }[];
    expect(all.map(a => a.name)).toEqual(expect.arrayContaining(['Orchestrator', 'Wendy', 'Hana', 'Bruno']));
    expect(all.find(a => a.name === 'Bruno')).toMatchObject({ department: 'Development', on: true, busy: false, tasks: [{ number: task.number, status: task.status }] });
    expect(all.find(a => a.name === 'Wendy')).toMatchObject({ busy: true });
    const nudge = await call(client, 'message_employee', { employee: bruno.id, text: 'Task #1 has had no report for an hour. Report or say what blocks you.' });
    expect(nudge.content[0]!.text).toBe("Sent to Bruno.");
    const [turn] = await db.select().from(jobs).where(and(eq(jobs.agentId, bruno.id), inArray(jobs.status, ['queued', 'running'])));
    expect(turn!.prompt).toBe('From Wendy (Reliability engineer, Operations) to Bruno (Backend engineer, Development):\n\nWendy (Reliability engineer) wrote:\n\n> Task #1 has had no report for an hour. Report or say what blocks you.');
    const [said] = await db.select().from(agentEvents).where(and(eq(agentEvents.agentId, bruno.id), eq(agentEvents.kind, 'message')));
    expect(said!.data).toMatchObject({ text: 'Task #1 has had no report for an hour. Report or say what blocks you.', from: 'agent', name: 'Wendy' });
    /* The map runs it from Operations to Development. */
    expect(app.ctx.bus.channels(wendy.companyId).map(c => [c.from, c.to])).toContainEqual([
      { kind: 'department', id: wendy.departmentId },
      { kind: 'department', id: bruno.departmentId },
    ]);
    expect((await call(client, 'message_employee', { employee: wendy.id, text: 'Hi me.' })).isError).toBe(true);
  });

  it('count as an agent\'s activity only what it did, not the messages others sent it', async () => {
    const { app, db, acme, bruno } = await company(['ops-task-watch']);
    const did = new Date(Date.now() - 3 * 3_600_000);
    await db.insert(agentEvents).values({ companyId: acme.id, agentId: bruno.id, seq: 1, kind: 'text', data: { kind: 'text', text: 'Reviewing #15.' }, createdAt: did });
    await db.insert(agentEvents).values({ companyId: acme.id, agentId: bruno.id, seq: 2, kind: 'message', data: { text: 'Any news on #15?', from: 'agent', name: 'Hana' } });
    const all = JSON.parse((await call(await mcp(app, TOKEN), 'agents')).content[0]!.text) as { name: string; lastActivityAt: string | null }[];
    expect(all.find(a => a.name === 'Bruno')!.lastActivityAt).toBe(did.toISOString());
  });

  it('show until when a plan is at its limit, so the watchdog leaves its agents to wait', async () => {
    const { app, db, sub } = await company(['ops-task-watch']);
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    await db.update(subscriptions).set({ limits: { status: 'rejected', windows: [{ name: 'five_hour', utilization: 1, resetsAt }] } }).where(eq(subscriptions.id, sub.id));
    const all = JSON.parse((await call(await mcp(app, TOKEN), 'agents')).content[0]!.text) as { name: string; limitUntil: string | null }[];
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
    const client = await mcp(app, TOKEN);
    for (let i = 0; i < 10; i++) expect((await call(client, 'message_employee', { employee: i % 2 ? hana.id : bruno.id, text: `Nudge ${i}.` })).isError).toBeFalsy();
    const more = await call(client, 'message_employee', { employee: hana.id, text: 'One more.' });
    expect([more.isError, more.content[0]!.text]).toEqual([true, 'One turn sends at most 10 messages. Go on in your next round.']);
  });

  it('keep to ten messages when a turn sends several at once', async () => {
    const { app, hana, bruno } = await company(['ops-task-watch']);
    const client = await mcp(app, TOKEN);
    for (let i = 0; i < 9; i++) await call(client, 'message_employee', { employee: bruno.id, text: `Nudge ${i}.` });
    const last = await Promise.all([1, 2, 3].map(i => call(client, 'message_employee', { employee: hana.id, text: `At once ${i}.` })));
    expect(last.filter(r => !r.isError)).toHaveLength(1);
  });

  it('count what a turn sent before Hornhoof restarted', async () => {
    const { app, acme, wendy, hana, bruno } = await company(['ops-task-watch']);
    /* Sent through the queue before a restart, so only what Hornhoof keeps knows of them. */
    for (let i = 0; i < 9; i++)
      await enqueueTurn(app.ctx, { companyId: acme.id, agentId: bruno.id, prompt: `Nudge ${i}.`, createdBy: null, message: { personId: null, text: `Nudge ${i}.`, from: 'agent', name: 'Wendy', by: wendy.id } });
    const client = await mcp(app, TOKEN);
    expect((await call(client, 'message_employee', { employee: hana.id, text: 'Last one.' })).isError).toBeFalsy();
    expect((await call(client, 'message_employee', { employee: hana.id, text: 'One more.' })).isError).toBe(true);
  });

  it('let a failure collector read the failed turns and blocked tasks of the last hours, with why each task stopped', async () => {
    const { app, db, acme, sub, bruno, task } = await company(['ops-failure-review']);
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    const hung = ago(30);
    await db.insert(jobs).values([
      { companyId: acme.id, subscriptionId: sub.id, agentId: bruno.id, taskId: task.id, kind: 'conversation', prompt: 'x', timeoutMs: 1, status: 'failed', error: 'timeout', tail: 'npm test hung', finishedAt: hung },
      { companyId: acme.id, subscriptionId: sub.id, agentId: bruno.id, kind: 'conversation', prompt: 'x', timeoutMs: 1, status: 'failed', error: 'agent_failed', tail: 'old', finishedAt: ago(600) },
      /* Stopped by a person: no failure of the system. */
      { companyId: acme.id, subscriptionId: sub.id, agentId: bruno.id, kind: 'conversation', prompt: 'x', timeoutMs: 1, status: 'failed', error: 'cancelled', tail: 'stopped', finishedAt: ago(20) },
    ]);
    const other = (await createTask(app.ctx, { personId: sub.ownerPersonId! }, { title: 'Obsolete wake', brief: '', body: '', departmentId: task.departmentId, assigneeAgentId: bruno.id, executor: true })).task;
    const [obsolete] = await db.insert(jobs).values({ companyId: acme.id, subscriptionId: sub.id, agentId: bruno.id, taskId: other.id, kind: 'conversation', prompt: 'x', timeoutMs: 1, status: 'queued' }).returning();
    await db.insert(agentEvents).values({ companyId: acme.id, agentId: bruno.id, jobId: obsolete!.id, kind: 'message', data: { text: 'Merge wake', taskWake: { why: 'merge', status: 'working', stage: 0, merging: false } } });
    await blocked(app.ctx, bruno.id, task.id, 'Waits for #40: the staging database does not answer.');
    await db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(eq(tasks.id, other.id));
    expect(await discardStaleTurn(db, obsolete!)).toBe(true);
    const client = await mcp(app, TOKEN);
    const recent = JSON.parse((await call(client, 'failures', { hours: 6 })).content[0]!.text) as { failed: { agent: string; error: string; tail: string }[]; blocked: unknown[] };
    expect(recent.failed).toEqual([expect.objectContaining({ agent: 'Bruno', error: 'timeout', tail: 'npm test hung' })]);
    expect(recent.blocked).toEqual([
      {
        number: task.number,
        title: 'Checkout API',
        holder: 'Bruno',
        since: expect.any(String),
        why: 'Waits for #40: the staging database does not answer.',
        lastTurn: { status: 'failed', error: 'timeout', at: hung.toISOString() },
      },
    ]);
  });

  it("tell a failure collector how the turn ended that a blocked task went out in along with another task", async () => {
    const { app, db, dev, acme, sub, hana } = await company(['ops-failure-review']);
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    const held = async (title: string) => (await createTask(app.ctx, { personId: sub.ownerPersonId! }, { title, brief: '', body: '', departmentId: dev.id, assigneeAgentId: hana.id, executor: true })).task;
    const [payments, refunds] = [await held('Payments'), await held('Refunds')];
    const restarted = ago(25);
    await db.insert(jobs).values([
      { companyId: acme.id, subscriptionId: sub.id, agentId: hana.id, taskId: refunds.id, kind: 'conversation', prompt: 'x', timeoutMs: 1, status: 'failed', error: 'machine_restarted', startedAt: ago(31), finishedAt: restarted },
      { companyId: acme.id, subscriptionId: sub.id, agentId: hana.id, taskId: payments.id, kind: 'conversation', prompt: 'x', timeoutMs: 1, status: 'done', result: GONE_ALONG, startedAt: ago(30), finishedAt: ago(30) },
    ]);
    await blocked(app.ctx, hana.id, payments.id, 'Waits for the bank.');
    const client = await mcp(app, TOKEN);
    const recent = JSON.parse((await call(client, 'failures', { hours: 6 })).content[0]!.text) as { blocked: { title: string; lastTurn: unknown }[] };
    expect(recent.blocked.find(b => b.title === 'Payments')?.lastTurn).toEqual({ status: 'failed', error: 'machine_restarted', at: restarted.toISOString() });
  });

  it('let a failure collector see where agents stumbled: programs they lacked, what they installed by hand, and where they stopped for people', async () => {
    const { app, db, acme, sub, hana, bruno, task } = await company(['ops-failure-review']);
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    const event = (agentId: string, kind: 'tool' | 'tool_result', data: object, minutes = 30) => ({ companyId: acme.id, agentId, kind, data, createdAt: ago(minutes) });
    const [onTask] = await db.insert(jobs).values({ companyId: acme.id, subscriptionId: sub.id, agentId: hana.id, taskId: task.id, kind: 'conversation', prompt: 'x', timeoutMs: 1, status: 'done', finishedAt: ago(25) }).returning();
    const newest = { ...event(hana.id, 'tool_result', { ok: false, summary: 'load average 0.4\nbash: line 3: ps: command not found' }, 29), jobId: onTask!.id };
    await db.insert(agentEvents).values([
      event(bruno.id, 'tool_result', { ok: false, summary: '/bin/bash: line 1: ps: command not found\n' }),
      newest,
      /* Read in a test file, not run. */
      event(bruno.id, 'tool_result', { ok: true, summary: "apps/server/test/stumbles.test.ts-6-    expect(missingIn('bash: line 1: jq: command not found'))" }),
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
      { companyId: acme.id, taskId: task.id, agentId: bruno.id, kind: 'approval', text: 'Approve the commit.', commit: 'a'.repeat(40), createdAt: ago(10) },
    ]);
    const recent = JSON.parse((await call(await mcp(app, TOKEN), 'failures', { hours: 6 })).content[0]!.text);
    /* The most frequent first, then the newest, with the newest line that said it. */
    expect(recent.missing).toEqual([
      { what: 'ps', kind: 'command', times: 2, agents: ['Bruno', 'Hana'], example: 'bash: line 3: ps: command not found', at: newest.createdAt.toISOString(), task: task.number },
      expect.objectContaining({ what: 'left-pad', kind: 'node module', agents: ['Bruno'] }),
      expect.objectContaining({ what: 'yaml', kind: 'python module', agents: ['Bruno'] }),
      expect.objectContaining({ what: 'python', kind: 'command', times: 1, agents: ['Hana'] }),
    ]);
    expect(recent.installed).toEqual([
      { command: 'npm i -g pnpm', times: 1, agents: ['Hana'], at: expect.any(String), task: null },
      { command: 'pip install --user pyyaml', times: 1, agents: ['Bruno'], at: expect.any(String), task: null },
    ]);
    expect(recent.stops).toEqual([
      { kind: 'stuck', agent: 'Bruno', task: task.number, text: 'Ended 3 turns in a row on #1 without moving it.', status: 'open', answer: null, lastTurn: 'This content can’t be shown.' },
      { kind: 'question', agent: 'Bruno', task: task.number, text: 'Which payment provider?', status: 'answered', answer: 'Stripe', lastTurn: null },
    ]);
  });
});
