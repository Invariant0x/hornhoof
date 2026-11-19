import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ServerMessage } from '@hornhoof/protocol';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import type { Db } from '../src/db/client.js';
import { agentEvents, agents, companies, departments, jobs, requests, subscriptions, taskEvents, tasks, type ExternalWait } from '../src/db/schema.js';
import { blocked, createTask } from '../src/modules/tasks/engine.js';
import { as, connectNode, invitePerson, listen, mcp, setUpCompany, testApp, until, ownPlan } from './helpers.js';
import { agentState, enqueueTurn, GONE_ALONG } from '../src/modules/conversation/queue.js';
import { discardStaleTurn } from '../src/modules/tasks/wake-state.js';
import { keepUndelivered } from '../src/modules/conversation/undelivered.js';

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
  /* Repeated nudges use live input after the first one opens the recipient's turn. */
  builtin.ws.on('message', data => {
    const message = JSON.parse(String(data)) as ServerMessage;
    if (message.type === 'agent.say') builtin.send({ type: 'agent.said', ref: message.ref, ok: true });
  });
  builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [], terminals: true });
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
  const task = (await createTask(app.ctx, { agentId: hana.id }, { title: 'Checkout API', brief: '', body: 'POST /checkout.', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true })).task;
  return { app, db, ceo, dev: dev!, ops: ops!, acme: acme!, sub: sub!, wendy, hana, bruno, task, hire };
}


type Result = { content: { text: string }[]; isError?: boolean };
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Result;
const names = async (client: Client) => (await client.listTools()).tools.map(t => t.name);

type WatchedTask = { number: number; title: string; status: string; updatedAt: string; waitsFor: number[];
  externalWait: Pick<ExternalWait, 'reason' | 'since' | 'until'> | null; waitingForPerson: boolean };
const watched = async (client: Client) => JSON.parse((await call(client, 'agents')).content[0]!.text) as { name: string; tasks: WatchedTask[] }[];
const taskWaitCount = (rows: WatchedTask[]) => rows.filter(t => t.waitsFor.length && !t.externalWait && !t.waitingForPerson).length;

async function messagesFrom(db: Db, agentId: string): Promise<string[]> {
  const rows = await db.select({ text: sql<string>`${agentEvents.data}->>'text'` }).from(agentEvents)
    .where(and(eq(agentEvents.kind, 'message'), sql`${agentEvents.data}->>'by' = ${agentId}`));
  return rows.map(row => row.text).sort();
}

describe('tools a skill grants', () => {
  it('exposes node restart evidence to the failure collector separately from agent output', async () => {
    const { app, db, acme, sub, bruno, task } = await company(['ops-failure-review']);
    const interruption = { cause: 'container' as const, at: new Date().toISOString(), task: task.number, node: { id: null, name: 'the built-in node' }, machine: { id: 'machine-id', name: 'host-a' }, diagnosis: { kind: 'planned' as const, reason: 'hornhoof_update' as const, startedAt: null, at: null, log: 'Stopping node: hornhoof_update.' } };
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
    expect(away.content[0]!.text).toBe(`Bruno works in another department. Ask your head, who has the orchestrator pass it on.\nNot delivered: reason other_department, recipient ${bruno.id}, task none.`);
  });

  it('let an employee answer the one who wrote to it last, in another department or the orchestrator, with one message', async () => {
    const { app, db, acme, wendy, bruno } = await company([]);
    const [orchestrator] = await db.select().from(agents).where(and(eq(agents.companyId, acme.id), eq(agents.kind, 'orchestrator')));
    const client = await mcp(app, TOKEN);
    const write = (employee: string, text: string) => call(client, 'message_employee', { employee, text });
    /* Nobody wrote to Wendy yet: Development is out of her reach. */
    expect((await write(bruno.id, 'Your tests are green.')).content[0]!.text).toContain('another department');
    const asks = (from: { from: 'agent'; name: string; by: string } | { from: 'orchestrator' }, text: string) =>
      enqueueTurn(app.ctx, { companyId: acme.id, agentId: wendy.id, prompt: text, createdBy: null, message: { personId: null, text, ...from } });
    await asks({ from: 'agent', name: 'Bruno', by: bruno.id }, 'Which machine runs my tests?');
    await asks({ from: 'orchestrator' }, 'Is the node back?');
    expect((await write(bruno.id, 'The built-in node runs them.')).isError).toBeFalsy();
    expect((await write(orchestrator!.id, 'Yes, the node is back.')).isError).toBeFalsy();
    expect(await messagesFrom(db, wendy.id)).toEqual(['The built-in node runs them.', 'Yes, the node is back.']);
    const told = await db.select().from(jobs).where(eq(jobs.agentId, orchestrator!.id));
    expect(told.map(j => j.prompt)).toContainEqual(expect.stringContaining('> Yes, the node is back.'));
    /* That was the answer: anything more waits until they write again. */
    expect((await write(bruno.id, 'One more thing.')).content[0]!.text).toContain('another department');
    await asks({ from: 'agent', name: 'Bruno', by: bruno.id }, 'And the browsers?');
    expect((await write(bruno.id, 'Chromium only.')).isError).toBeFalsy();
  });

  it('let any employee and any head write to the orchestrator, which helps everyone, as often as their turn allows', async () => {
    const { app, db, acme, sub, wendy, hana } = await company([]);
    const [orchestrator] = await db.select().from(agents).where(and(eq(agents.companyId, acme.id), eq(agents.kind, 'orchestrator')));
    const headToken = 'tool-token-watch-head-0123456789abcdef';
    await db.insert(jobs).values({ companyId: acme.id, subscriptionId: sub.id, agentId: hana.id, kind: 'conversation', prompt: 'round', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(headToken) });
    const worker = await mcp(app, TOKEN);
    const head = await mcp(app, headToken);
    /* Nobody wrote to either of them, and neither has a grant: the orchestrator is in reach of everyone all the same. */
    for (const [client, text] of [[worker, 'Two members of Development stand free.'], [worker, 'They still stand free.'], [head, 'Development needs a stand for Android.']] as const) {
      const sent = await call(client, 'message_employee', { employee: orchestrator!.id, text });
      expect([sent.isError, sent.content[0]!.text]).toEqual([undefined, expect.stringMatching(/^Sent to Orchestrator\./)]);
    }
    expect(await messagesFrom(db, wendy.id)).toEqual(['They still stand free.', 'Two members of Development stand free.']);
    expect(await messagesFrom(db, hana.id)).toEqual(['Development needs a stand for Android.']);
    const told = await db.select({ text: sql<string>`${agentEvents.data}->>'text'`, by: sql<string>`${agentEvents.data}->>'by'` }).from(agentEvents)
      .where(and(eq(agentEvents.agentId, orchestrator!.id), eq(agentEvents.kind, 'message')));
    expect(told).toEqual(expect.arrayContaining([
      { text: 'Two members of Development stand free.', by: wendy.id },
      { text: 'They still stand free.', by: wendy.id },
      { text: 'Development needs a stand for Android.', by: hana.id },
    ]));
    expect((await db.select().from(jobs).where(eq(jobs.agentId, orchestrator!.id)))[0]!.prompt).toContain('> Two members of Development stand free.');
    /* An id that is no employee still says so. */
    const nobody = randomUUID();
    const gone = await call(worker, 'message_employee', { employee: nobody, text: 'Hello.' });
    expect([gone.isError, gone.content[0]!.text]).toEqual([true, `There is no employee with id ${nobody}. Call agents to see the current ids.\nNot delivered: reason recipient_unknown, recipient ${nobody}, task none.`]);
  });

  it("tell an employee that a person's own assistant serves only that person, and to write to the orchestrator instead", async () => {
    const { app, db, acme } = await company([]);
    const [ava] = await db.insert(agents).values({ companyId: acme.id, kind: 'assistant', name: 'Ava', model: '' }).returning();
    const refused = await call(await mcp(app, TOKEN), 'message_employee', { employee: ava!.id, text: 'Hello Ava.' });
    expect([refused.isError, refused.content[0]!.text]).toEqual([true, `Ava is a person's own assistant and works only for that person. Write to the orchestrator instead.\nNot delivered: reason personal_assistant, recipient ${ava!.id}, task none.`]);
    expect(await db.select().from(jobs).where(eq(jobs.agentId, ava!.id))).toEqual([]);
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
    expect(turn!.prompt).toBe(
      'From Wendy (Reliability engineer, Operations) to Bruno (Backend engineer, Development):\n\nWendy (Reliability engineer) wrote:\n\n> Task #1 has had no report for an hour. Report or say what blocks you.' +
        `\n\nIf you answer Wendy, do it with "message_employee", employee ${wendy.id}: an answer in this window does not reach Wendy.`,
    );
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

  it('shows only open prerequisites of the held task department, without task bodies or hidden references', async () => {
    const { app, db, acme, dev, ops, task } = await company(['ops-task-watch']);
    const [foreign] = await db.insert(companies).values({ name: 'Unrelated company', singleton: false }).returning();
    const closedAt = new Date();
    const dependencies = await db.insert(tasks).values([
      { companyId: acme.id, departmentId: dev.id, number: 10, title: 'Private dependency title', body: 'Private dependency body' },
      { companyId: acme.id, departmentId: dev.id, number: 11, title: 'Done dependency', status: 'done', closedAt },
      { companyId: acme.id, departmentId: dev.id, number: 12, title: 'Cancelled dependency', status: 'cancelled', closedAt },
      { companyId: acme.id, departmentId: ops.id, number: 14, title: 'Other department dependency' },
      { companyId: foreign!.id, number: 15, title: 'Foreign dependency' },
      { companyId: acme.id, number: 16, title: 'Departmentless dependency' },
    ]).returning();
    await db.update(tasks).set({ after: dependencies.map(t => t.id), body: 'Private held body' }).where(eq(tasks.id, task.id));
    const client = await mcp(app, TOKEN), rows = await watched(client);
    const held = rows.find(a => a.name === 'Bruno')!.tasks;
    expect(held).toEqual([{ number: task.number, title: task.title, status: task.status, updatedAt: expect.any(String),
      waitsFor: [10], externalWait: null, waitingForPerson: false }]);
    expect(taskWaitCount(held)).toBe(1);
    const serialized = JSON.stringify(rows);
    for (const hidden of [...dependencies.flatMap(t => [t.id, t.title]), 'Private held body', 'Private dependency body', 'Unrelated company']) expect(serialized).not.toContain(hidden);
    await db.update(tasks).set({ status: 'done', closedAt }).where(eq(tasks.id, dependencies[0]!.id));
    const after = (await watched(client)).find(a => a.name === 'Bruno')!.tasks;
    expect(after[0]!.waitsFor).toEqual([]);
    expect(taskWaitCount(after)).toBe(0);
  });

  it('distinguishes a person question from work that can be handed out, even beside an open prerequisite', async () => {
    const { app, db, acme, dev, bruno, task } = await company(['ops-task-watch']);
    const [dependency] = await db.insert(tasks).values({ companyId: acme.id, departmentId: dev.id, number: 10, title: 'Prerequisite' }).returning();
    await db.update(tasks).set({ after: [dependency!.id], status: 'waiting' }).where(eq(tasks.id, task.id));
    const [question] = await db.insert(requests).values({ companyId: acme.id, taskId: task.id, agentId: bruno.id, kind: 'question', text: 'Private question text' }).returning();
    const client = await mcp(app, TOKEN), rows = await watched(client), held = rows.find(a => a.name === 'Bruno')!.tasks;
    expect(held[0]).toMatchObject({ waitsFor: [10], externalWait: null, waitingForPerson: true });
    expect(taskWaitCount(held)).toBe(0);
    expect(JSON.stringify(rows)).not.toContain('Private question text');
    await db.update(requests).set({ status: 'answered', answeredAt: new Date() }).where(eq(requests.id, question!.id));
    const answered = (await watched(client)).find(a => a.name === 'Bruno')!.tasks;
    expect(answered[0]!.waitingForPerson).toBe(false);
    expect(taskWaitCount(answered)).toBe(1);
  });

  for (const on of [undefined, ...['time', 'ceo', 'machine', 'other'].map(event => ({ kind: 'external' as const, event: event as 'time' | 'ceo' | 'machine' | 'other' })),
    { kind: 'employee' as const, employee: '00000000-0000-4000-8000-000000000099', name: 'Hidden dependency employee' }]) {
    it('keeps an external wait separate from department work: ' + (on?.kind === 'external' ? on.event : on?.kind ?? 'legacy'), async () => {
      const { app, db, acme, dev, task } = await company(['ops-task-watch']);
      const [dependency] = await db.insert(tasks).values({ companyId: acme.id, departmentId: dev.id, number: 10, title: 'Prerequisite' }).returning();
      const now = Date.now(), wait = { reason: 'Waiting for the agreed event', since: new Date(now).toISOString(), until: new Date(now + 60_000).toISOString() };
      await db.update(tasks).set({ after: [dependency!.id], externalWait: { ...wait, ...(on ? { on } : {}) } }).where(eq(tasks.id, task.id));
      const rows = await watched(await mcp(app, TOKEN)), held = rows.find(a => a.name === 'Bruno')!.tasks;
      expect(held[0]).toMatchObject({ waitsFor: [10], waitingForPerson: on?.kind === 'external' && on.event === 'ceo' });
      expect(held[0]!.externalWait).toEqual(wait);
      expect(taskWaitCount(held)).toBe(0);
      expect(JSON.stringify(rows)).not.toContain('Hidden dependency employee');
      expect(JSON.stringify(rows)).not.toContain('00000000-0000-4000-8000-000000000099');
    });
  }

  it('show until when a plan is at its limit, so the watchdog leaves its agents to wait', async () => {
    const { app, db, sub } = await company(['ops-task-watch']);
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    await db.update(subscriptions).set({ limits: { status: 'rejected', windows: [{ name: 'five_hour', utilization: 1, resetsAt }] }, limitsUpdatedAt: new Date() }).where(eq(subscriptions.id, sub.id));
    const all = JSON.parse((await call(await mcp(app, TOKEN), 'agents')).content[0]!.text) as { name: string; limitUntil: string | null }[];
    expect(all.find(a => a.name === 'Bruno')).toMatchObject({ limitUntil: resetsAt });
  });

  it('are turned on only by people who see the whole company, since they show all of it', async () => {
    const { app, ceo, dev, bruno } = await company([]);
    const dana = await invitePerson(app, ceo, { name: 'Dana', email: 'dana@acme.test', access: { departments: [dev.id] } });
    await ownPlan(app.ctx.db, 'dana@acme.test', bruno.id);
    const grant = (token: string, skill: string) => app.inject({ method: 'PATCH', url: `/api/agents/${bruno.id}`, payload: { skills: { [skill]: true } }, ...as(token) });
    const refused = await grant(dana, 'ops-failure-review');
    expect([refused.statusCode, refused.json().error.reason]).toEqual([403, 'skill_company_only']);
    expect((await grant(dana, 'ops-postmortem')).statusCode).toBe(200);
    expect((await grant(ceo, 'ops-failure-review')).statusCode).toBe(200);
  });

  it('delivers every employee message and head report from the same turn', async () => {
    const { app, db, wendy, bruno } = await company(['ops-task-watch']);
    await db.update(agents).set({ kind: 'head' }).where(eq(agents.id, wendy.id));
    const client = await mcp(app, TOKEN);
    const texts = Array.from({ length: 12 }, (_, i) => `Report ${i}.`);
    const sent = await Promise.all(texts.map((text, i) => i % 2
      ? call(client, 'tell_orchestrator', { text })
      : call(client, 'message_employee', { employee: bruno.id, text })));
    expect(sent.filter(result => result.isError)).toEqual([]);
    expect((await messagesFrom(db, wendy.id)).sort()).toEqual(texts.sort());
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
        whyTail: null,
        next: 'Waits for #40: the staging database does not answer.',
        lastTurn: { status: 'failed', error: 'timeout', at: hung.toISOString() },
      },
    ]);
  });

  it('let a failure collector read the end of a long blocked reason, where its holder says what stops it, beside its start', async () => {
    const { app, db, bruno, task } = await company(['ops-failure-review']);
    const files = Array.from({ length: 40 }, (_, i) => `apps/web/e2e/agent-state-${i}.spec.ts`).join(', ');
    const reason = `Status: BLOCKED. What changed: ${files}. Concerns: the browser suite needs the candidate's own build. Next: the head gives the Tests stage a machine with the browsers.`;
    await blocked(app.ctx, bruno.id, task.id, reason);
    const recent = JSON.parse((await call(await mcp(app, TOKEN), 'failures', { hours: 6 })).content[0]!.text) as { blocked: { why: string; whyTail: string | null }[] };
    expect(recent.blocked).toEqual([expect.objectContaining({ why: reason.slice(0, 400), whyTail: reason.slice(-500) })]);
    expect(recent.blocked[0]!.whyTail).toContain('Next: the head gives the Tests stage a machine with the browsers.');
    expect(await db.select().from(tasks).where(eq(tasks.id, task.id))).toEqual([expect.objectContaining({ status: 'blocked' })]);
  });

  it('let a failure collector read why a turn failed when its program left no output, and leave out turns Hornhoof ended before they started', async () => {
    const { app, db, acme, sub, bruno, task } = await company(['ops-failure-review']);
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    await db.insert(jobs).values([
      /* The task went to another holder, or waits for tasks before it: its queued turn ended unsent, with no program. */
      { companyId: acme.id, subscriptionId: sub.id, agentId: bruno.id, taskId: task.id, kind: 'conversation', prompt: 'x', timeoutMs: 1, status: 'failed', error: 'handed_on', tail: '', finishedAt: ago(30) },
      { companyId: acme.id, subscriptionId: sub.id, agentId: bruno.id, taskId: task.id, kind: 'conversation', prompt: 'x', timeoutMs: 1, status: 'failed', error: 'waiting', tail: '', finishedAt: ago(29) },
      { companyId: acme.id, subscriptionId: sub.id, agentId: bruno.id, taskId: task.id, kind: 'conversation', prompt: 'x', timeoutMs: 1, status: 'failed', error: 'agent_failed', tail: '', result: 'The terminal output recorder did not start.', finishedAt: ago(20) },
      { companyId: acme.id, subscriptionId: sub.id, agentId: bruno.id, taskId: task.id, kind: 'conversation', prompt: 'x', timeoutMs: 1, status: 'failed', error: 'agent_failed', tail: '', failure: { kind: 'overloaded', text: 'Selected model is at capacity.', retryable: true }, finishedAt: ago(10) },
    ]);
    const recent = JSON.parse((await call(await mcp(app, TOKEN), 'failures', { hours: 6 })).content[0]!.text) as { failed: { error: string; tail: string; reason: string | null }[] };
    expect(recent.failed).toEqual([
      expect.objectContaining({ error: 'agent_failed', tail: '', reason: 'overloaded: Selected model is at capacity.' }),
      expect.objectContaining({ error: 'agent_failed', tail: '', reason: 'The terminal output recorder did not start.' }),
    ]);
  });

  /* Made-up credentials and private places that a holder or a program may write into what it says. */
  const GITHUB_TOKEN = 'ghp_' + 'syntheticWatchToken0'.repeat(3);
  const HOME = '/home/fixture805/private-project/.env';

  it("keeps credentials and private paths of another department's blocked task out of what a failure collector reads, at its start and its end", async () => {
    const { app, bruno, task } = await company(['ops-failure-review']);
    /* The second token sits where the last 500 characters of the words as written begin 12 characters before its end, so a
       cut made before cleaning would leave that end, which no longer looks like a token. */
    const second = 'ghp_' + 'secondWatchToken0123'.repeat(3);
    const next = `\nNext: token=${GITHUB_TOKEN} path=${HOME} or C:\\Users\\fixture\\.ssh\\id_rsa or /Users/fixture/keys.`;
    const reason = `Status: BLOCKED. Could not read ${HOME} with ${GITHUB_TOKEN}. ` + 'x'.repeat(900) + ` ${second} ` + 'y'.repeat(500 - next.length - 1 - 12) + next;
    expect(reason.slice(-500).startsWith(second.slice(-12))).toBe(true);
    await blocked(app.ctx, bruno.id, task.id, reason);
    const client = await mcp(app, TOKEN);
    expect((await call(client, 'task', { task: task.number })).isError).toBe(true);
    const [held] = JSON.parse((await call(client, 'failures', { hours: 6 })).content[0]!.text).blocked as { why: string; whyTail: string }[];
    for (const words of [held!.why, held!.whyTail]) {
      for (const secret of [GITHUB_TOKEN, second.slice(-12), HOME, 'fixture805', 'C:\\Users\\fixture', '/Users/fixture']) expect(words).not.toContain(secret);
    }
    expect(held!.why.length).toBeLessThanOrEqual(400);
    expect(held!.whyTail.length).toBeLessThanOrEqual(500);
    expect(held!.why).toContain('Status: BLOCKED. Could not read');
    expect(held!.whyTail).toContain('Next: token=');
  });

  it("keeps credentials and private paths of another department's failed turn out of its reason and its output, from its failure and its result alike", async () => {
    const { app, db, acme, sub, bruno, task } = await company(['ops-failure-review']);
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    const turn = { companyId: acme.id, subscriptionId: sub.id, agentId: bruno.id, taskId: task.id, kind: 'conversation' as const, prompt: 'x', timeoutMs: 1, status: 'failed' as const, error: 'agent_failed' };
    await db.insert(jobs).values([
      { ...turn, tail: '', failure: { kind: 'unknown', text: `Cannot load ${HOME}/credential-loader`, retryable: false }, finishedAt: ago(30) },
      { ...turn, tail: '', result: `Push refused for https://bruno:${GITHUB_TOKEN}@github.com/acme/app.git from /Users/fixture/app`, finishedAt: ago(20) },
      { ...turn, tail: `npm ERR! token=${GITHUB_TOKEN} in /root/.npmrc`, finishedAt: ago(10) },
      /* A turn on no task is the work of its agent's department. */
      { ...turn, taskId: null, tail: `git push failed: key=${GITHUB_TOKEN} for /home/fixture805/app`, finishedAt: ago(5) },
    ]);
    const client = await mcp(app, TOKEN);
    expect((await call(client, 'task', { task: task.number })).isError).toBe(true);
    const failed = JSON.parse((await call(client, 'failures', { hours: 6 })).content[0]!.text).failed as { tail: string; reason: string | null }[];
    expect(failed).toHaveLength(4);
    for (const { tail, reason } of failed) {
      for (const words of [tail, reason ?? '']) {
        for (const secret of [GITHUB_TOKEN, HOME, 'fixture805', '/Users/fixture', '/root/.npmrc']) expect(words).not.toContain(secret);
      }
      expect((reason ?? '').length).toBeLessThanOrEqual(400);
    }
    expect(failed.map(f => f.reason)).toEqual([null, null, expect.stringContaining('Push refused for https://'), expect.stringContaining('unknown: Cannot load')]);
    expect(failed.map(f => f.tail)).toEqual(['git push failed: key=[hidden] for [hidden]', 'npm ERR! token=[hidden] in [hidden]', '', '']);
  });

  it('lets a failure collector of the same department read what its own task says as it is', async () => {
    const { app, db, acme, sub, hana, bruno, task } = await company(['ops-failure-review']);
    const own = 'tool-token-watch-own-department-0123456';
    await db.update(agents).set({ skills: ['ops-failure-review'] }).where(eq(agents.id, hana.id));
    await db.insert(jobs).values({ companyId: acme.id, subscriptionId: sub.id, agentId: hana.id, kind: 'conversation', prompt: 'round', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(own) });
    const reason = `Status: BLOCKED. Could not read ${HOME}. ` + 'x'.repeat(900) + ` Next: path=${HOME}`;
    await blocked(app.ctx, bruno.id, task.id, reason);
    const turn = { companyId: acme.id, subscriptionId: sub.id, agentId: bruno.id, kind: 'conversation' as const, prompt: 'x', timeoutMs: 1, status: 'failed' as const, error: 'agent_failed' };
    await db.insert(jobs).values([
      { ...turn, taskId: task.id, tail: '', failure: { kind: 'unknown', text: `Cannot load ${HOME}`, retryable: false }, finishedAt: new Date(Date.now() - 60_000) },
      /* A turn on no task of an agent of the same department. */
      { ...turn, tail: `git push failed for ${HOME}`, finishedAt: new Date() },
    ]);
    const client = await mcp(app, own);
    expect((await call(client, 'task', { task: task.number })).isError).toBeFalsy();
    const recent = JSON.parse((await call(client, 'failures', { hours: 6 })).content[0]!.text) as { failed: { reason: string | null; tail: string }[]; blocked: { why: string; whyTail: string }[] };
    expect(recent.blocked).toEqual([expect.objectContaining({ why: reason.slice(0, 400), whyTail: reason.slice(-500) })]);
    expect(recent.failed).toEqual([
      expect.objectContaining({ tail: `git push failed for ${HOME}`, reason: null }),
      expect.objectContaining({ tail: '', reason: `unknown: Cannot load ${HOME}` }),
    ]);
  });

  it('let a failure collector read the Next section of a blocked report as next, cleaned for every reader, beside why as it was', async () => {
    const { app, db, acme, sub, hana, bruno, task } = await company(['ops-failure-review']);
    const own = 'tool-token-watch-own-next-0123456789ab';
    await db.update(agents).set({ skills: ['ops-failure-review'] }).where(eq(agents.id, hana.id));
    await db.insert(jobs).values({ companyId: acme.id, subscriptionId: sub.id, agentId: hana.id, kind: 'conversation', prompt: 'round', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(own) });
    const report = [
      '- **Status:** BLOCKED',
      `- **What changed:** nothing, as ${HOME} cannot be read.`,
      `- **Next:** the head connects the registry with token=${GITHUB_TOKEN} from ${HOME}`,
      '- **Concerns:** none.',
    ].join('\n');
    await blocked(app.ctx, bruno.id, task.id, report);
    const heldBy = async (token: string) => (JSON.parse((await call(await mcp(app, token), 'failures', { hours: 6 })).content[0]!.text) as { blocked: { why: string; whyTail: string | null; next: string }[] }).blocked;
    /* The stored report has already lost its credential; its own department still reads its private path. */
    expect(await heldBy(own)).toEqual([expect.objectContaining({ why: report.replace(GITHUB_TOKEN, '[hidden]'), whyTail: null, next: 'the head connects the registry with token=[hidden] from [hidden]' })]);
    expect(await heldBy(TOKEN)).toEqual([expect.objectContaining({ why: expect.not.stringContaining(HOME), whyTail: null, next: 'the head connects the registry with token=[hidden] from [hidden]' })]);
  });

  it('let a failure collector read every message an employee could not deliver, with its code, its recipient and its task, and no credential in it', async () => {
    const { app, db, acme, sub, hana, bruno, task } = await company(['ops-failure-review']);
    const client = await mcp(app, TOKEN);
    await db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, hana.id));
    const off = await call(client, 'message_employee', { employee: hana.id, text: 'Are you there?', task: task.number });
    expect([off.isError, off.content[0]!.text]).toEqual([true, `Hana is switched off and takes no work until a person switches it on.\nNot delivered: reason switched_off, recipient ${hana.id}, task #${task.number}.`]);
    const nobody = randomUUID();
    const gone = await call(client, 'message_employee', { employee: nobody, text: 'Hello.' });
    expect([gone.isError, gone.content[0]!.text]).toEqual([true, `There is no employee with id ${nobody}. Call agents to see the current ids.\nNot delivered: reason recipient_unknown, recipient ${nobody}, task none.`]);
    /* A credential given as the task fits the 40 characters a task reference takes. */
    const token = 'ghp_' + 'b'.repeat(36);
    const unknown = await call(client, 'message_employee', { employee: bruno.id, text: 'About the leak.', task: token });
    expect([unknown.isError, unknown.content[0]!.text]).toEqual([true, `There is no task [hidden] you can message.\nNot delivered: reason task_unknown, recipient ${bruno.id}, task [hidden].`]);
    /* A turn Hornhoof failed for a message before it kept why. */
    await db.insert(jobs).values({ companyId: acme.id, subscriptionId: sub.id, agentId: bruno.id, taskId: task.id, kind: 'conversation', prompt: 'x', timeoutMs: 1, status: 'failed', error: 'message_not_delivered', tail: '', finishedAt: new Date() });

    const out = JSON.parse((await call(client, 'failures', { hours: 6 })).content[0]!.text) as { failed: unknown[]; undelivered: unknown[] };
    expect(out.failed).toEqual([expect.objectContaining({ agent: 'Bruno', error: 'message_not_delivered', task: task.number, reason: `Not delivered: reason reason_not_recorded, recipient ${bruno.id}, task #${task.number}.` })]);
    const line = (reason: string, recipient: string, on: string) => `Not delivered: reason ${reason}, recipient ${recipient}, task ${on}.`;
    expect(out.undelivered).toEqual([
      { agent: 'Wendy', at: expect.any(String), recipient: bruno.id, to: 'Bruno', task: '[hidden]', reason: 'task_unknown', text: line('task_unknown', bruno.id, '[hidden]') },
      { agent: 'Wendy', at: expect.any(String), recipient: nobody, to: null, task: null, reason: 'recipient_unknown', text: line('recipient_unknown', nobody, 'none') },
      { agent: 'Wendy', at: expect.any(String), recipient: hana.id, to: 'Hana', task: task.number, reason: 'switched_off', text: line('switched_off', hana.id, `#${task.number}`) },
    ]);
    expect(JSON.stringify(out)).not.toContain(token);
  });

  /* Where agents stumbled and stopped on another department's task, its title and a node log of a restart, each with a
     credential or a private path in it: what a failure collector may not open comes cleaned, and its own department reads it
     as it is. */
  async function stumbledOnTask(c: Awaited<ReturnType<typeof company>>) {
    const { app, db, acme, sub, bruno, task } = c;
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    await db.update(tasks).set({ title: `Checkout API for ${GITHUB_TOKEN}` }).where(eq(tasks.id, task.id));
    await blocked(app.ctx, bruno.id, task.id, 'Waits for the bank.');
    const turn = { companyId: acme.id, subscriptionId: sub.id, agentId: bruno.id, taskId: task.id, kind: 'conversation' as const, prompt: 'x', timeoutMs: 1 };
    /* The token of the second turn sits where the last 400 characters of its output as written begin 9 characters before
       its end. */
    const second = 'ghp_' + 'stopTurnSecondToken0'.repeat(3);
    const output = `Asked about ${second} ` + 'y'.repeat(390);
    const [asked, , round] = await db.insert(jobs).values([
      { ...turn, status: 'done' as const, result: `token=${GITHUB_TOKEN} path=${HOME}`, tail: '', startedAt: ago(30), finishedAt: ago(29) },
      { ...turn, status: 'done' as const, result: '', tail: output, startedAt: ago(20), finishedAt: ago(19) },
      /* A turn on no task is read as its agent's department may. */
      { ...turn, taskId: null, status: 'done' as const, result: '', tail: '', startedAt: ago(25), finishedAt: ago(23) },
    ]).returning();
    await db.insert(requests).values([
      { companyId: acme.id, taskId: task.id, agentId: bruno.id, kind: 'question', text: `May I push with ${GITHUB_TOKEN} from ${HOME} now?`, status: 'answered', answer: `No, keep /Users/fixture/keys to yourself.`, createdAt: ago(28) },
      { companyId: acme.id, taskId: task.id, agentId: bruno.id, kind: 'stuck', text: 'Needs help.', createdAt: ago(18) },
    ]);
    await db.insert(agentEvents).values([
      { companyId: acme.id, agentId: bruno.id, jobId: asked!.id, kind: 'tool_result', data: { ok: false, summary: `bash: line 1: ps: command not found; could not read ${HOME} with ${GITHUB_TOKEN}` }, createdAt: ago(27) },
      { companyId: acme.id, agentId: bruno.id, jobId: asked!.id, kind: 'tool', data: { name: 'Bash', input: `pip install --user pyyaml --target ${HOME} --token ${GITHUB_TOKEN}` }, createdAt: ago(26) },
      { companyId: acme.id, agentId: bruno.id, jobId: round!.id, kind: 'tool_result', data: { ok: false, summary: `zsh:1: command not found: jq while reading ${HOME}` }, createdAt: ago(24) },
      /* CUT of 120 falls inside the password of the index address, which a cut before cleaning would leave without its @. */
      { companyId: acme.id, agentId: bruno.id, jobId: asked!.id, kind: 'tool', data: { name: 'Bash', input: `pip install --index-url https://bruno:${'p'.repeat(60)}@pypi.example.com/simple ` + 'x'.repeat(20) + ' pyyaml' }, createdAt: ago(25) },
    ]);
    const interruption = { cause: 'container' as const, at: new Date().toISOString(), task: task.number, node: { id: null, name: 'the built-in node' }, machine: { id: 'machine-id', name: 'host-a' }, diagnosis: { kind: 'planned' as const, reason: 'hornhoof_update' as const, startedAt: null, at: null, log: `Stopping node token=${GITHUB_TOKEN} path=${HOME}` } };
    await db.insert(jobs).values({ ...turn, status: 'failed', error: 'machine_restarted', tail: 'safe', interruption, finishedAt: ago(5) });
    return { second, output, interruption };
  }

  type Stumbles = {
    failed: { interruption: { diagnosis: { log: string } } }[];
    blocked: { title: string }[];
    stops: { text: string; answer: string | null; lastTurn: string | null }[];
    missing: { what: string; example: string }[];
    installed: { command: string }[];
  };

  it("keeps credentials and private paths of another department's task out of its stops, stumbles, title and node log", async () => {
    const c = await company(['ops-failure-review']);
    const { second, output } = await stumbledOnTask(c);
    expect(output.slice(-400).startsWith(second.slice(-9))).toBe(true);
    const client = await mcp(c.app, TOKEN);
    expect((await call(client, 'task', { task: c.task.number })).isError).toBe(true);
    const out = JSON.parse((await call(client, 'failures', { hours: 6 })).content[0]!.text) as Stumbles;
    const words: [string, string][] = [
      ['failed.interruption.diagnosis.log', out.failed[0]!.interruption.diagnosis.log], ['blocked.title', out.blocked[0]!.title],
      ...out.stops.flatMap((s, i): [string, string][] => [[`stops.${i}.text`, s.text], [`stops.${i}.answer`, s.answer ?? ''], [`stops.${i}.lastTurn`, s.lastTurn ?? '']]),
      ...out.missing.flatMap((m, i): [string, string][] => [[`missing.${i}.what`, m.what], [`missing.${i}.example`, m.example]]),
      ...out.installed.map((m, i): [string, string] => [`installed.${i}.command`, m.command]),
    ];
    for (const [field, said] of words) {
      for (const secret of [GITHUB_TOKEN, second.slice(-9), HOME, 'fixture805', '/Users/fixture', 'bruno:ppp']) expect.soft(said, field).not.toContain(secret);
    }
    expect(out.failed[0]!.interruption.diagnosis.log).toBe('Stopping node token=[hidden] path=[hidden]');
    expect(out.blocked[0]!.title).toBe('Checkout API for [hidden]');
    expect(out.stops).toEqual([
      expect.objectContaining({ text: 'Needs help.', lastTurn: ' [hidden] ' + 'y'.repeat(390) }),
      expect.objectContaining({ text: 'May I push with [hidden] from [hidden] now?', answer: 'No, keep [hidden] to yourself.', lastTurn: 'token=[hidden] path=[hidden]' }),
    ]);
    expect(out.missing).toEqual([
      expect.objectContaining({ what: 'jq', example: 'zsh:1: command not found: jq while reading [hidden]', task: null }),
      expect.objectContaining({ what: 'ps', example: 'bash: line 1: ps: command not found; could not read [hidden] with [hidden]', task: c.task.number }),
    ]);
    expect(out.installed.map(i => i.command).sort()).toEqual([
      'pip install --index-url https://[hidden]@pypi.example.com/simple ' + 'x'.repeat(20) + ' pyyaml',
      'pip install --user pyyaml --target [hidden] --token [hidden]',
    ]);
  });

  it('lets a failure collector of the same department read the stops, stumbles, title and node log of its own task as they are', async () => {
    const c = await company(['ops-failure-review']);
    const own = 'tool-token-watch-own-stumbles-0123456789';
    await c.db.update(agents).set({ skills: ['ops-failure-review'] }).where(eq(agents.id, c.hana.id));
    await c.db.insert(jobs).values({ companyId: c.acme.id, subscriptionId: c.sub.id, agentId: c.hana.id, kind: 'conversation', prompt: 'round', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(own) });
    const { interruption, output } = await stumbledOnTask(c);
    const client = await mcp(c.app, own);
    expect((await call(client, 'task', { task: c.task.number })).isError).toBeFalsy();
    const out = JSON.parse((await call(client, 'failures', { hours: 6 })).content[0]!.text) as Stumbles;
    expect(out.failed[0]!.interruption).toEqual(interruption);
    expect(out.blocked[0]!.title).toBe(`Checkout API for ${GITHUB_TOKEN}`);
    expect(out.stops).toEqual([
      expect.objectContaining({ text: 'Needs help.', lastTurn: output.slice(-400) }),
      expect.objectContaining({ text: `May I push with ${GITHUB_TOKEN} from ${HOME} now?`, answer: 'No, keep /Users/fixture/keys to yourself.', lastTurn: `token=${GITHUB_TOKEN} path=${HOME}` }),
    ]);
    expect(out.missing).toEqual([
      expect.objectContaining({ what: 'jq', example: `zsh:1: command not found: jq while reading ${HOME}`, task: null }),
      expect.objectContaining({ what: 'ps', example: `bash: line 1: ps: command not found; could not read ${HOME} with ${GITHUB_TOKEN}`, task: c.task.number }),
    ]);
    expect(out.installed.map(i => i.command)).toContain(`pip install --user pyyaml --target ${HOME} --token ${GITHUB_TOKEN}`.slice(0, 120));
  });

  /* An agent's last failure and the tasks it holds, with a credential or a private path in their words, as agents shows
     them to a watchdog of another department and to one of its own. */
  async function failedHolder(c: Awaited<ReturnType<typeof company>>) {
    const { db, acme, sub, bruno, task } = c;
    const wait = { reason: `Waits for the bank to read ${HOME}`, since: new Date().toISOString(), until: new Date(Date.now() + 60_000).toISOString() };
    await db.update(tasks).set({ title: `Checkout API for ${GITHUB_TOKEN}`, externalWait: wait }).where(eq(tasks.id, task.id));
    const failure = { kind: 'unknown' as const, text: `Cannot load ${HOME} with ${GITHUB_TOKEN}`, retryable: false };
    await db.insert(jobs).values({ companyId: acme.id, subscriptionId: sub.id, agentId: bruno.id, taskId: task.id, kind: 'conversation', prompt: 'x', timeoutMs: 1, status: 'failed', error: 'agent_failed',
      tail: `push token=${GITHUB_TOKEN} from ${HOME}`, failure, finishedAt: new Date(Date.now() - 60_000) });
    return { wait, failure };
  }
  type Watched = { name: string; failure: { text: string; tail: string } | null; tasks: { number: number; title: string; externalWait: { reason: string } | null }[] }[];

  it("keeps credentials and private paths out of another department's agent's last failure and the tasks it holds", async () => {
    const c = await company(['ops-failure-review']);
    await failedHolder(c);
    /* Its own task stays readable, with the credential hidden when the task was created. */
    const [orchestrator] = await c.db.select().from(agents).where(and(eq(agents.companyId, c.acme.id), eq(agents.kind, 'orchestrator')));
    const opsTask = (await createTask(c.app.ctx, { agentId: orchestrator!.id }, { title: `Rotate ${GITHUB_TOKEN}`, brief: '', body: '', departmentId: c.ops.id, assigneeAgentId: c.bruno.id, executor: true })).task;
    const client = await mcp(c.app, TOKEN);
    expect((await call(client, 'task', { task: c.task.number })).isError).toBe(true);
    const own = await call(client, 'task', { task: opsTask.number });
    expect(own.isError, own.content[0]!.text).toBeFalsy();
    expect(JSON.parse(own.content[0]!.text).title).toBe('Rotate [hidden]');
    expect(own.content[0]!.text).not.toContain(GITHUB_TOKEN);
    const { tasks: holds, ...bruno } = (JSON.parse((await call(client, 'agents')).content[0]!.text) as Watched).find(a => a.name === 'Bruno')!;
    const closed = holds.find(t => t.number === c.task.number);
    for (const secret of [GITHUB_TOKEN, HOME, 'fixture805']) expect.soft(JSON.stringify([bruno, closed])).not.toContain(secret);
    expect(bruno.failure).toMatchObject({ text: 'Cannot load [hidden] with [hidden]', tail: 'push token=[hidden] from [hidden]' });
    expect(holds).toHaveLength(2);
    expect(holds).toEqual(expect.arrayContaining([
      expect.objectContaining({ number: c.task.number, title: 'Checkout API for [hidden]', externalWait: expect.objectContaining({ reason: 'Waits for the bank to read [hidden]' }) }),
      expect.objectContaining({ number: opsTask.number, title: 'Rotate [hidden]' }),
    ]));
  });

  it("lets a watchdog of the same department read its agent's last failure and the tasks it holds as they are", async () => {
    const c = await company(['ops-failure-review']);
    const own = 'tool-token-watch-own-agents-0123456789';
    await c.db.update(agents).set({ skills: ['ops-task-watch'] }).where(eq(agents.id, c.hana.id));
    await c.db.insert(jobs).values({ companyId: c.acme.id, subscriptionId: c.sub.id, agentId: c.hana.id, kind: 'conversation', prompt: 'round', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(own) });
    const { wait, failure } = await failedHolder(c);
    const bruno = (JSON.parse((await call(await mcp(c.app, own), 'agents')).content[0]!.text) as Watched).find(a => a.name === 'Bruno')!;
    expect(bruno.failure).toMatchObject({ text: failure.text, tail: `push token=${GITHUB_TOKEN} from ${HOME}` });
    expect(bruno.tasks).toEqual([expect.objectContaining({ title: `Checkout API for ${GITHUB_TOKEN}`, externalWait: wait })]);
  });

  it('leaves the orchestrator its sight of every task', async () => {
    const { app, db, acme, sub, task } = await company(['ops-failure-review']);
    const [orchestrator] = await db.select().from(agents).where(and(eq(agents.companyId, acme.id), eq(agents.kind, 'orchestrator')));
    const own = 'tool-token-watch-orchestrator-0123456789';
    await db.insert(jobs).values({ companyId: acme.id, subscriptionId: sub.id, agentId: orchestrator!.id, kind: 'conversation', prompt: 'round', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(own) });
    expect((await call(await mcp(app, own), 'task', { task: task.number })).isError).toBeFalsy();
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

  /* A person's own assistant works for that person alone, so agents leaves it out; failures does too, in every part, while
     an employee's same work still shows. */
  it("leave a person's own assistant out of failures as agents does: its failed turns, blocked tasks, stumbles, stops and undelivered words", async () => {
    const { app, db, acme, sub, dev, bruno, task } = await company(['ops-failure-review']);
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    const [ava] = await db.insert(agents).values({ companyId: acme.id, kind: 'assistant', name: 'Ava', model: '', subscriptionId: sub.id }).returning();
    /* The assistant holds one task and does another that an employee holds: either is that person's work. */
    const [own] = await db.insert(tasks).values([
      { companyId: acme.id, number: 900, title: 'Letter to the landlord', departmentId: dev.id, status: 'blocked', assigneeAgentId: ava!.id },
      { companyId: acme.id, number: 901, title: 'Receipt for the landlord', departmentId: dev.id, status: 'blocked', assigneeAgentId: bruno.id, executorAgentId: ava!.id },
    ]).returning();
    await db.insert(taskEvents).values({ companyId: acme.id, taskId: own!.id, kind: 'blocked', agentId: ava!.id, text: 'Waits for the tenancy deposit sum.' });
    await blocked(app.ctx, bruno.id, task.id, 'Waits for the bank.');
    const turn = { companyId: acme.id, subscriptionId: sub.id, kind: 'conversation' as const, prompt: 'x', timeoutMs: 1, status: 'failed' as const };
    const [avaTurn] = await db.insert(jobs).values([
      { ...turn, agentId: ava!.id, taskId: own!.id, error: 'agent_failed', tail: 'Dear landlord, about the rent', startedAt: ago(16), finishedAt: ago(15) },
      { ...turn, agentId: ava!.id, error: 'timeout', tail: 'Private diary of the owner', finishedAt: ago(14) },
      { ...turn, agentId: bruno.id, taskId: task.id, error: 'timeout', tail: 'npm test hung', finishedAt: ago(30) },
    ]).returning();
    const event = (agentId: string, kind: 'tool' | 'tool_result', data: object, jobId: string | null = null) => ({ companyId: acme.id, agentId, jobId, kind, data, createdAt: ago(13) });
    const undelivered = (reason: string) => ({ ok: false, summary: `Not delivered: reason ${reason}, recipient ${bruno.id}, task none.`, undelivered: { reason, recipient: bruno.id, task: null } });
    await db.insert(agentEvents).values([
      event(ava!.id, 'tool_result', { ok: false, summary: 'bash: line 1: rg: command not found' }, avaTurn!.id),
      event(ava!.id, 'tool', { name: 'Bash', input: 'pip install --user landlordpkg' }, avaTurn!.id),
      event(ava!.id, 'tool_result', undelivered('agent_not_ready')),
      event(bruno.id, 'tool_result', { ok: false, summary: 'bash: line 1: ps: command not found' }),
      event(bruno.id, 'tool', { name: 'Bash', input: 'pip install --user pyyaml' }),
      event(bruno.id, 'tool_result', undelivered('switched_off')),
    ]);
    await db.insert(requests).values([
      { companyId: acme.id, taskId: own!.id, agentId: ava!.id, kind: 'question', text: 'Should the letter name the deposit?', createdAt: ago(12) },
      { companyId: acme.id, taskId: task.id, agentId: bruno.id, kind: 'question', text: 'Which payment provider?', createdAt: ago(11) },
    ]);

    const out = JSON.parse((await call(await mcp(app, TOKEN), 'failures', { hours: 6 })).content[0]!.text);
    expect.soft(out.failed, 'failed').toEqual([expect.objectContaining({ agent: 'Bruno', tail: 'npm test hung' })]);
    expect.soft(out.blocked, 'blocked').toEqual([expect.objectContaining({ number: task.number, holder: 'Bruno' })]);
    expect.soft(out.missing, 'missing').toEqual([expect.objectContaining({ what: 'ps', agents: ['Bruno'] })]);
    expect.soft(out.installed, 'installed').toEqual([expect.objectContaining({ command: 'pip install --user pyyaml', agents: ['Bruno'] })]);
    expect.soft(out.stops, 'stops').toEqual([expect.objectContaining({ agent: 'Bruno', text: 'Which payment provider?' })]);
    expect.soft(out.undelivered, 'undelivered').toEqual([expect.objectContaining({ agent: 'Bruno', reason: 'switched_off' })]);
    for (const word of ['Ava', 'landlord', 'diary', 'deposit', 'agent_not_ready']) expect.soft(JSON.stringify(out)).not.toContain(word);
  });

  it("leave out a message an employee could not deliver to a person's own assistant, which names that assistant", async () => {
    const { app, db, acme, sub, hana, bruno } = await company(['ops-failure-review']);
    const [ava] = await db.insert(agents).values({ companyId: acme.id, kind: 'assistant', name: 'Ava', model: '', subscriptionId: sub.id }).returning();
    const sender = { companyId: acme.id, agentId: bruno.id };
    await keepUndelivered(app.ctx, sender, { reason: 'personal_assistant', recipient: ava!.id, task: null });
    await keepUndelivered(app.ctx, sender, { reason: 'switched_off', recipient: hana.id, task: null });
    /* An id goes in with capitals too, and its refusal keeps it as it was written. */
    const client = await mcp(app, TOKEN);
    expect((await call(client, 'message_employee', { employee: ava!.id.toUpperCase(), text: 'Hello.' })).isError).toBe(true);

    const out = JSON.parse((await call(client, 'failures', { hours: 6 })).content[0]!.text);
    expect(out.undelivered).toEqual([expect.objectContaining({ agent: 'Bruno', recipient: hana.id, to: 'Hana', reason: 'switched_off' })]);
    for (const word of [ava!.id, ava!.id.toUpperCase(), 'Ava', 'personal_assistant']) expect.soft(JSON.stringify(out)).not.toContain(word);
  });

  /* An employee's work on a task a person's own assistant holds or does is that person's work too, as task views keep it. */
  it("leave out an employee's failed turns, stumbles, stops and undelivered words on a task a person's own assistant holds or does", async () => {
    const { app, db, acme, sub, dev, hana, bruno, task } = await company(['ops-failure-review']);
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    const [ava] = await db.insert(agents).values({ companyId: acme.id, kind: 'assistant', name: 'Ava', model: '', subscriptionId: sub.id }).returning();
    const [held, done] = await db.insert(tasks).values([
      { companyId: acme.id, number: 900, title: 'Letter to the landlord', departmentId: dev.id, status: 'working', assigneeAgentId: ava!.id },
      { companyId: acme.id, number: 901, title: 'Receipt for the landlord', departmentId: dev.id, status: 'working', assigneeAgentId: bruno.id, executorAgentId: ava!.id },
    ]).returning();
    const turn = { companyId: acme.id, subscriptionId: sub.id, agentId: bruno.id, kind: 'conversation' as const, prompt: 'x', timeoutMs: 1, status: 'failed' as const, error: 'timeout' };
    const [onHeld] = await db.insert(jobs).values([
      { ...turn, taskId: held!.id, tail: 'Dear landlord, about the rent', finishedAt: ago(15) },
      { ...turn, taskId: done!.id, tail: 'Private diary of the owner', finishedAt: ago(14) },
      { ...turn, taskId: task.id, tail: 'npm test hung', finishedAt: ago(30) },
      { ...turn, tail: 'out of memory', finishedAt: ago(31) },
    ]).returning();
    const event = (jobId: string | null, kind: 'tool' | 'tool_result', data: object) => ({ companyId: acme.id, agentId: bruno.id, jobId, kind, data, createdAt: ago(13) });
    const undelivered = (reason: string) => ({ ok: false, summary: `Not delivered: reason ${reason}, recipient ${hana.id}, task none.`, undelivered: { reason, recipient: hana.id, task: null } });
    await db.insert(agentEvents).values([
      event(onHeld!.id, 'tool_result', { ok: false, summary: 'bash: line 1: rg: command not found' }),
      event(onHeld!.id, 'tool', { name: 'Bash', input: 'pip install --user landlordpkg' }),
      event(onHeld!.id, 'tool_result', undelivered('agent_not_ready')),
      event(null, 'tool_result', { ok: false, summary: 'bash: line 1: ps: command not found' }),
      event(null, 'tool', { name: 'Bash', input: 'pip install --user pyyaml' }),
      event(null, 'tool_result', undelivered('switched_off')),
    ]);
    await db.insert(requests).values([
      { companyId: acme.id, taskId: held!.id, agentId: bruno.id, kind: 'question', text: 'Should the letter name the deposit?', createdAt: ago(12) },
      { companyId: acme.id, taskId: done!.id, agentId: bruno.id, kind: 'stuck', text: 'Stuck on the deposit receipt.', createdAt: ago(12) },
      { companyId: acme.id, taskId: task.id, agentId: bruno.id, kind: 'question', text: 'Which payment provider?', createdAt: ago(11) },
    ]);

    const out = JSON.parse((await call(await mcp(app, TOKEN), 'failures', { hours: 6 })).content[0]!.text);
    expect.soft(out.failed, 'failed').toEqual([
      expect.objectContaining({ agent: 'Bruno', task: task.number, tail: 'npm test hung' }),
      expect.objectContaining({ agent: 'Bruno', task: null, tail: 'out of memory' }),
    ]);
    expect.soft(out.missing, 'missing').toEqual([expect.objectContaining({ what: 'ps', agents: ['Bruno'] })]);
    expect.soft(out.installed, 'installed').toEqual([expect.objectContaining({ command: 'pip install --user pyyaml', agents: ['Bruno'] })]);
    expect.soft(out.stops, 'stops').toEqual([expect.objectContaining({ agent: 'Bruno', text: 'Which payment provider?' })]);
    expect.soft(out.undelivered, 'undelivered').toEqual([expect.objectContaining({ agent: 'Bruno', reason: 'switched_off' })]);
    for (const word of ['landlord', 'diary', 'deposit', 'agent_not_ready', '"task":900', '"task":901']) expect.soft(JSON.stringify(out)).not.toContain(word);
  });
});
