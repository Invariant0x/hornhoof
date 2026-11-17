import { and, asc, eq, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agentInbox, agents, companies, departments, jobs, people, requests, subscriptions, tasks, teams } from '../src/db/schema.js';
import { said } from '../src/modules/conversation/live.js';
import { letterKind, type MailMessage } from '../src/modules/conversation/inbox.js';
import { enqueueTurn, GONE_ALONG, pump } from '../src/modules/conversation/queue.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { comment, createTask } from '../src/modules/tasks/engine.js';
import { queueTaskMessage, waitFor } from '../src/modules/tasks/external-wait.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import { BUILTIN } from './builtin.js';
import { as, echelonsTurn, invitePerson, listen, mcp, SETUP, setUpCompany, testApp } from './helpers.js';

const MIN = 60_000;
const START = new Date('2030-01-01T08:00:00Z');

type Said = { isError?: boolean; content: { text: string }[] };

/* Acme runs everyone on its key, on the built-in node. Development: Hana, its head, with Bruno and Rita. Sales: Sam, its
   head, with Sara; Pia, a person, owns Sales. Ivan is the CEO. */
async function company() {
  vi.useFakeTimers({ toFake: ['Date'], now: START });
  onTestFinished(() => { vi.useRealTimers(); });
  const { app, db } = await testApp();
  await listen(app);
  const ceoToken = await setUpCompany(app);
  const ctx = app.ctx;
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  /* Every company takes its mail by inbox from the start; the helper's company takes it the old way. */
  await db.update(companies).set({ inboxMode: 'inbox' });
  const [ceo] = await db.select().from(people);
  const [key] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  await db.update(jobs).set({ status: 'done', result: '', finishedAt: new Date() }).where(eq(jobs.agentId, orchestrator!.id));
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop.git' }).returning();
  const [sales] = await db.insert(departments).values({ companyId, templateKey: 'sales', roleCode: 'SAL' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: 'claude-opus-5-5', subscriptionId: key!.id, skills: [] }).returning())[0]!;
  const hana = await hire('Hana', 'head', 'DEV-HEAD', dev!.id);
  const bruno = await hire('Bruno', 'worker', 'DEV-BE', dev!.id);
  const rita = await hire('Rita', 'worker', 'DEV-BE', dev!.id);
  const sam = await hire('Sam', 'head', 'SAL-HEAD', sales!.id);
  const sara = await hire('Sara', 'worker', 'SAL-REP', sales!.id);
  await echelonsTurn(db, companyId);

  vi.spyOn(ctx.hub, 'isReady').mockImplementation(id => id.kind === 'builtin');
  vi.spyOn(ctx.hub, 'hasTerminals').mockReturnValue(false);
  vi.spyOn(ctx.hub, 'takesSkillFiles').mockReturnValue(true);
  /* The built-in node takes live words into a running turn when the test says it does, and says so. */
  let takesLiveWords = true;
  const send = vi.spyOn(ctx.hub, 'send').mockImplementation((to, m) => {
    if (m.type === 'agent.say') queueMicrotask(() => said(ctx, to, m.ref, takesLiveWords));
    return true;
  });
  const refuseLiveWords = () => { takesLiveWords = false; };

  const later = (ms = MIN) => vi.setSystemTime(Date.now() + ms);
  const turnsOf = (agentId: string) => db.select().from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.kind, 'conversation'))).orderBy(asc(jobs.createdAt));
  const job = async (id: string) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
  const inboxOf = (agentId: string) => db.select().from(agentInbox).where(eq(agentInbox.agentId, agentId)).orderBy(asc(agentInbox.seq));
  const runs = () => send.mock.calls.flatMap(([, m]) => (m.type === 'job.run' ? [m] : []));
  const liveWords = () => send.mock.calls.flatMap(([, m]) => (m.type === 'agent.say' ? [m] : []));
  /* Ivan writes to the employee in its window. */
  const ivanWrites = (agentId: string, text: string) =>
    enqueueTurn(ctx, { companyId, agentId, prompt: `Ivan (CEO): ${text}`, createdBy: ceo!.id, message: { personId: ceo!.id, text } });
  /* An employee writes to another with message_employee, about a task or not. */
  const letter = (from: { id: string; name: string }, to: string, text: string, task?: number) =>
    queueTaskMessage(ctx, { companyId, agentId: to, task, actor: { agentId: from.id }, text }, { companyId, agentId: to, prompt: `${from.name} wrote:\n\n${text}`, createdBy: null, message: { personId: null, text, from: 'agent', name: from.name, by: from.id } });
  /* The built-in node ends the turn. */
  const ends = (jobId: string) => handleNodeMessage(ctx, BUILTIN, { type: 'job.done', jobId, ok: true, sessionId: 'session-1', result: 'Done.', tail: '', error: null });
  /* The employee's tools, as its running turn has them. */
  const toolsOf = async (agentId: string) => {
    const token = `inbox-${agentId}-${Date.now()}`;
    const [turn] = await db.update(jobs).set({ toolTokenHash: hashToken(token) }).where(and(eq(jobs.agentId, agentId), eq(jobs.status, 'running'))).returning({ id: jobs.id });
    if (!turn) await db.insert(jobs).values({ companyId, subscriptionId: key!.id, agentId, kind: 'conversation', prompt: 'Work.', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    return mcp(app, token);
  };
  const newTask = (holder: string, body = '') => createTask(ctx, { agentId: hana.id }, { title: 'Checkout API', brief: '', body, departmentId: dev!.id, assigneeAgentId: holder, executor: true, small: true, paths: ['logic/totals.ts'] });
  const task = async (holder: string, body = '') => (await newTask(holder, body)).task;
  /* Hana gives the task out, and its holder is woken for it, as the task tools do. */
  const given = async (holder: string) => {
    const moved = await newTask(holder);
    await wakeAll(ctx, moved.wakes);
    return moved;
  };
  return { app, ctx, db, ceoToken, companyId, ceo: ceo!, key: key!, orchestrator: orchestrator!, dev: dev!, sales: sales!, hana, bruno, rita, sam, sara, later, turnsOf, job, inboxOf, runs, liveWords, ivanWrites, letter, ends, toolsOf, task, given, refuseLiveWords, send };
}

type Company = Awaited<ReturnType<typeof company>>;

describe('mail from employees in inbox mode', () => {
  it('keeps 25 letters that come while a person talks with the head in her inbox, and gives them in one turn after it', async () => {
    const c = await company();
    const talk = await c.ivanWrites(c.hana.id, 'Let us plan the release.');
    expect((await c.job(talk)).status).toBe('running');
    for (let i = 0; i < 25; i++) {
      c.later(1000);
      await c.letter(i % 2 ? c.bruno : c.rita, c.hana.id, `Status ${i}: the branch is pushed.`);
    }

    expect(c.liveWords()).toEqual([]);
    expect((await c.inboxOf(c.hana.id)).map(m => m.status)).toEqual(Array(25).fill('unread'));
    const waiting = (await c.turnsOf(c.hana.id)).filter(j => j.status === 'queued');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ inboxWake: true });

    await c.ends(talk);
    const [batch] = (await c.turnsOf(c.hana.id)).filter(j => j.status === 'running');
    expect(batch!.id).toBe(waiting[0]!.id);
    const sent = c.runs().filter(r => r.jobId === batch!.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.prompt).toMatch(/25 unread/);
    expect(sent[0]!.prompt).toContain('Bruno');
    expect(sent[0]!.prompt).toContain('Status 24: the branch is pushed.');
    expect((await c.inboxOf(c.hana.id)).every(m => m.status === 'read' && m.jobId === batch!.id)).toBe(true);
    expect((await c.turnsOf(c.hana.id)).filter(j => j.id !== talk)).toHaveLength(1);
  });

  it('lets a person\'s words go before the letters that waited', async () => {
    const c = await company();
    const work = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.hana.id, prompt: 'Hornhoof: plan the week.', createdBy: null });
    c.later();
    await c.letter(c.bruno, c.hana.id, 'The branch is pushed.');
    c.later();
    c.refuseLiveWords();
    const asked = await c.ivanWrites(c.hana.id, 'Answer me first, please.');
    expect((await c.job(asked)).status).toBe('queued');

    await c.ends(work);
    expect((await c.job(asked)).status).toBe('running');
    expect((await c.turnsOf(c.hana.id)).filter(j => j.inboxWake).map(j => j.status)).toEqual(['queued']);
  });

  it('gives the letters that waited with the next turn on a task, so the turn for the inbox never waits behind newer turns', async () => {
    const c = await company();
    const given = await c.given(c.bruno.id);
    const [working] = (await c.turnsOf(c.bruno.id)).filter(j => j.status === 'running');
    await c.letter(c.rita, c.bruno.id, 'I pushed the fixtures.');
    c.later();
    await wakeAll(c.ctx, (await comment(c.ctx, { agentId: c.hana.id }, given.task.id, 'Mind the rounding.')).wakes);
    const wake = (await c.turnsOf(c.bruno.id)).find(j => j.inboxWake)!;
    const [onTask] = (await c.turnsOf(c.bruno.id)).filter(j => j.status === 'queued' && !j.inboxWake);
    expect(+wake.createdAt).toBeLessThan(+onTask!.createdAt);

    await c.ends(working!.id);

    expect((await c.job(onTask!.id)).status).toBe('running');
    const prompt = c.runs().find(r => r.jobId === onTask!.id)!.prompt;
    expect(prompt).toContain('Mind the rounding.');
    expect(prompt).toMatch(/1 unread letter\b/);
    expect(prompt).toContain('I pushed the fixtures.');
    expect(await c.job(wake.id)).toMatchObject({ status: 'done', result: GONE_ALONG });
    expect((await c.inboxOf(c.bruno.id)).find(m => m.text === 'I pushed the fixtures.')).toMatchObject({ status: 'read', jobId: onTask!.id });
    expect((await c.turnsOf(c.bruno.id)).filter(j => j.status === 'queued')).toEqual([]);
  });

  it('gives every message that waited on the same task in one turn, and keeps a message on another task and a person\'s words apart', async () => {
    const c = await company();
    const checkout = await c.task(c.bruno.id);
    const refunds = await c.task(c.bruno.id);
    const talk = await c.ivanWrites(c.bruno.id, 'How is it going?');
    c.refuseLiveWords();
    await c.letter(c.hana, c.bruno.id, 'Use the new totals.', checkout.number);
    c.later();
    await c.letter(c.hana, c.bruno.id, 'And round down.', checkout.number);
    c.later();
    await c.letter(c.hana, c.bruno.id, 'Refunds can wait.', refunds.number);
    c.later();
    const asked = await c.ivanWrites(c.bruno.id, 'Answer me later.');
    const [first, second, other] = (await c.turnsOf(c.bruno.id)).filter(j => j.status === 'queued' && j.taskId);

    await c.ends(talk);

    expect((await c.job(first!.id)).status).toBe('running');
    const prompt = c.runs().find(r => r.jobId === first!.id)!.prompt;
    expect(prompt).toContain('Use the new totals.');
    expect(prompt).toContain('And round down.');
    expect(prompt).not.toContain('Refunds can wait.');
    expect(await c.job(second!.id)).toMatchObject({ status: 'done', result: GONE_ALONG });
    expect([(await c.job(other!.id)).status, (await c.job(asked)).status]).toEqual(['queued', 'queued']);
  });

  it('wakes a holder whose task waits with a turn on that task that has the letter whole, and ends the wait as before', async () => {
    const c = await company();
    const task = await c.task(c.bruno.id);
    await waitFor(c.ctx, c.bruno.id, task.id, { reason: 'Images', until: new Date(Date.now() + 60 * MIN).toISOString(), on: { kind: 'employee', employee: c.hana.id } });
    const text = `The images are ready. ${'Each one is checked against the brief and named by its page. '.repeat(6)}`.trim();
    await c.letter(c.hana, c.bruno.id, text, task.number);

    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.externalWait).toBeNull();
    const [turn] = (await c.turnsOf(c.bruno.id)).filter(j => j.status === 'running');
    expect(turn).toMatchObject({ inboxWake: false, taskId: task.id });
    expect(c.runs().find(r => r.jobId === turn!.id)!.prompt).toContain(text);
    expect((await c.turnsOf(c.bruno.id)).filter(j => j.inboxWake)).toEqual([]);
    expect(await c.inboxOf(c.bruno.id)).toMatchObject([{ kind: 'message', taskId: task.id, jobId: turn!.id, status: 'read' }]);
  });

  it('keeps a letter on a task for a turn on that task, so its holder cannot wait past it', async () => {
    const c = await company();
    const task = await c.task(c.bruno.id);
    const talk = await c.ivanWrites(c.bruno.id, 'How is it going?');
    expect((await c.job(talk)).status).toBe('running');
    c.refuseLiveWords();
    await c.letter(c.hana, c.bruno.id, 'Use the new totals.', task.number);

    const [waiting] = (await c.turnsOf(c.bruno.id)).filter(j => j.status === 'queued');
    expect(waiting).toMatchObject({ taskId: task.id, inboxWake: false });
    await expect(waitFor(c.ctx, c.bruno.id, task.id, { reason: 'Images', until: new Date(Date.now() + 60 * MIN).toISOString(), on: { kind: 'employee', employee: c.hana.id } })).rejects.toMatchObject({ status: 409 });
    expect(await c.inboxOf(c.bruno.id)).toMatchObject([{ taskId: task.id, jobId: waiting!.id, status: 'unread' }]);
    await c.ends(talk);
    expect((await c.job(waiting!.id)).status).toBe('running');
    expect((await c.inboxOf(c.bruno.id))[0]!.status).toBe('read');
  });

  it('fails a letter on a task that cannot go out alone: the sender hears it, the wait goes on, and nothing of it waits unread', async () => {
    const c = await company();
    const task = await c.task(c.bruno.id);
    await waitFor(c.ctx, c.bruno.id, task.id, { reason: 'Images', until: new Date(Date.now() + 60 * MIN).toISOString(), on: { kind: 'employee', employee: c.hana.id } });
    await c.ivanWrites(c.bruno.id, 'How is it going?');
    c.refuseLiveWords();
    await c.letter(c.rita, c.bruno.id, 'I pushed the fixtures.');
    /* The plan is at its limit: a turn that waits for it does not end by itself. */
    await c.db.update(subscriptions).set({ limits: { status: 'rejected', windows: [{ name: 'five_hour', utilization: 1, resetsAt: new Date(Date.now() + 60 * MIN).toISOString() }] }, limitsUpdatedAt: new Date() }).where(eq(subscriptions.id, c.key.id));

    await expect(c.letter(c.hana, c.bruno.id, 'The images are ready.', task.number)).rejects.toMatchObject({ status: 409, reason: 'agent_not_ready' });
    expect((await c.turnsOf(c.bruno.id)).filter(j => j.inboxWake).map(j => j.status)).toEqual(['queued']);
    expect((await c.inboxOf(c.bruno.id)).map(m => [m.text, m.status])).toEqual([['I pushed the fixtures.', 'unread']]);
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.externalWait).toMatchObject({ reason: 'Images' });
  });

  it('keeps a letter without a task in the inbox for an employee whose plan is at its limit, and fails no turn of it', async () => {
    const c = await company();
    await c.ivanWrites(c.bruno.id, 'How is it going?');
    c.refuseLiveWords();
    await c.db.update(subscriptions).set({ limits: { status: 'rejected', windows: [{ name: 'five_hour', utilization: 1, resetsAt: new Date(Date.now() + 60 * MIN).toISOString() }] }, limitsUpdatedAt: new Date() }).where(eq(subscriptions.id, c.key.id));
    await c.letter(c.rita, c.bruno.id, 'I pushed the fixtures.');
    await c.letter(c.hana, c.bruno.id, 'Review it when you can.');
    expect((await c.turnsOf(c.bruno.id)).filter(j => j.inboxWake).map(j => j.status)).toEqual(['queued']);
    expect((await c.inboxOf(c.bruno.id)).map(m => m.status)).toEqual(['unread', 'unread']);
  });

  it('takes a person\'s words that came by Telegram or an assistant as a person\'s, not as mail', async () => {
    const c = await company();
    await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.hana.id, prompt: 'Ivan (CEO): hello', createdBy: c.ceo.id, message: { personId: c.ceo.id, text: 'hello', channel: 'telegram', telegram: { bot: 'acme_bot', chat: 1, update: 1 } } });
    await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.sam.id, prompt: 'Ivan (CEO): hi', createdBy: c.ceo.id, message: { personId: c.ceo.id, text: 'hi', channel: 'assistant', assistant: { id: c.ceo.id, name: 'Ivan\'s assistant', message: 'hi' } } });
    expect(await c.inboxOf(c.hana.id)).toEqual([]);
    expect(await c.inboxOf(c.sam.id)).toEqual([]);
    expect((await c.turnsOf(c.hana.id)).every(j => !j.inboxWake)).toBe(true);
  });

  it('shows each employee only its own letters, cut short, and no task text it does not see', async () => {
    const c = await company();
    const task = await c.task(c.bruno.id, 'SECRET-BODY of the checkout.');
    /* A notice about a task that wakes nothing on it waits in the inbox; a letter on a task is a turn of its own. */
    await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.bruno.id, prompt: 'Tests ended.', createdBy: null, message: { personId: null, text: `Look at the totals. ${'x'.repeat(1000)}`, task: { id: task.id, number: task.number }, notification: { source: 'tests', tasks: [] } } });
    await c.letter(c.hana, c.rita.id, 'Only for Rita.');
    const [batch] = (await c.turnsOf(c.bruno.id)).filter(j => j.status === 'running');
    const prompt = c.runs().find(r => r.jobId === batch!.id)!.prompt;
    expect(prompt).toContain(`#${task.number}`);
    expect(prompt).not.toContain('SECRET-BODY');
    expect(prompt).not.toContain('Only for Rita.');
    expect(prompt).not.toContain('x'.repeat(600));
  });
});

describe("Hornhoof's words on a task", () => {
  it('keep a comment that goes into the turn on its task in the inbox as read with that turn', async () => {
    const c = await company();
    vi.mocked(c.ctx.hub.hasTerminals).mockReturnValue(true);
    const given = await c.given(c.bruno.id);
    const [working] = (await c.turnsOf(c.bruno.id)).filter(j => j.status === 'running');
    await wakeAll(c.ctx, (await comment(c.ctx, { agentId: c.hana.id }, given.task.id, 'Mind the rounding.')).wakes);
    expect(c.liveWords().map(m => m.text).join('\n')).toContain('Mind the rounding.');
    expect((await c.turnsOf(c.bruno.id)).filter(j => j.status === 'queued')).toEqual([]);
    expect((await c.inboxOf(c.bruno.id)).filter(m => m.kind === 'comment')).toMatchObject([{ taskId: given.task.id, jobId: working!.id, status: 'read' }]);
  });

  it('keep each comment that joins a turn already waiting on its task in the inbox with that turn', async () => {
    const c = await company();
    const given = await c.given(c.bruno.id);
    c.refuseLiveWords();
    await wakeAll(c.ctx, (await comment(c.ctx, { agentId: c.hana.id }, given.task.id, 'Mind the rounding.')).wakes);
    await wakeAll(c.ctx, (await comment(c.ctx, { agentId: c.hana.id }, given.task.id, 'And the tax.')).wakes);
    const waiting = (await c.turnsOf(c.bruno.id)).filter(j => j.status === 'queued');
    expect(waiting).toHaveLength(1);
    expect((await c.inboxOf(c.bruno.id)).filter(m => m.kind === 'comment').map(m => [m.jobId, m.status])).toEqual([
      [waiting[0]!.id, 'unread'],
      [waiting[0]!.id, 'unread'],
    ]);
  });

  it('keep a request the orchestrator explains in its running turn in its inbox as read with that turn', async () => {
    const c = await company();
    vi.mocked(c.ctx.hub.hasTerminals).mockReturnValue(true);
    const given = await c.given(c.bruno.id);
    const talk = await c.ivanWrites(c.orchestrator.id, 'What is waiting for me?');
    expect((await c.job(talk)).status).toBe('running');
    const [request] = await c.db.insert(requests).values({ companyId: c.companyId, taskId: given.task.id, agentId: c.bruno.id, kind: 'question', text: 'Is tax in scope?' }).returning();
    await wakeAll(c.ctx, [{ agentId: c.orchestrator.id, taskId: given.task.id, why: 'explain', text: request!.id }]);
    expect(c.liveWords().map(m => m.text).join('\n')).toContain('Is tax in scope?');
    expect(await c.inboxOf(c.orchestrator.id)).toMatchObject([{ taskId: given.task.id, jobId: talk, status: 'read' }]);
  });
});

describe('an employee that is switched off', () => {
  it('takes no turn for its inbox until it is on again, and then takes one for all its letters', async () => {
    const c = await company();
    await c.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, c.bruno.id));
    const notice = (text: string) => enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.bruno.id, prompt: text, createdBy: null, message: { personId: null, text, notification: { source: 'tests', tasks: [] } } });
    await notice('The test run ended.');
    await notice('The second run ended.');
    expect((await c.turnsOf(c.bruno.id)).filter(j => j.status === 'running')).toEqual([]);
    expect((await c.inboxOf(c.bruno.id)).map(m => m.status)).toEqual(['unread', 'unread']);

    await c.db.update(agents).set({ switchedOffAt: null }).where(eq(agents.id, c.bruno.id));
    await pump(c.ctx, c.bruno.id);
    const running = (await c.turnsOf(c.bruno.id)).filter(j => j.status === 'running');
    expect(running).toMatchObject([{ inboxWake: true }]);
    expect(c.runs().find(r => r.jobId === running[0]!.id)!.prompt).toMatch(/2 unread letters/);
  });

  it('starts no turn for letters that wait with no turn while it is off', async () => {
    const c = await company();
    await c.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, c.bruno.id));
    await c.db.insert(agentInbox).values({ companyId: c.companyId, agentId: c.bruno.id, senderKind: 'hornhoof', senderName: 'Hornhoof', kind: 'notification', source: 'tests', text: 'The test run ended.', status: 'unread' });
    await pump(c.ctx, c.bruno.id);
    expect(await c.turnsOf(c.bruno.id)).toEqual([]);
  });
});

describe('the inbox tools', () => {
  it('list the unread letters by task and sender, and mark them read or dealt with', async () => {
    const c = await company();
    const task = await c.task(c.bruno.id);
    const talk = await c.ivanWrites(c.hana.id, 'Let us plan.');
    await c.letter(c.bruno, c.hana.id, 'On the task.', task.number);
    await c.letter(c.rita, c.hana.id, 'Not on a task.');
    expect((await c.job(talk)).status).toBe('running');
    const tools = await c.toolsOf(c.hana.id);
    expect((await tools.listTools()).tools.map(t => t.name)).toEqual(expect.arrayContaining(['inbox', 'inbox_mark']));

    const all = JSON.parse(((await tools.callTool({ name: 'inbox', arguments: {} })) as Said).content[0]!.text) as { unread: number; letters: { id: string; from: string; task: number | null; text: string; status: string }[] };
    expect(all.unread).toBe(2);
    expect(all.letters.map(l => [l.from, l.task, l.text, l.status])).toEqual([['Bruno', task.number, 'On the task.', 'unread'], ['Rita', null, 'Not on a task.', 'unread']]);
    const onTask = JSON.parse(((await tools.callTool({ name: 'inbox', arguments: { task: task.number } })) as Said).content[0]!.text) as typeof all;
    expect(onTask.letters.map(l => l.from)).toEqual(['Bruno']);
    const fromRita = JSON.parse(((await tools.callTool({ name: 'inbox', arguments: { sender: c.rita.id } })) as Said).content[0]!.text) as typeof all;
    expect(fromRita.letters.map(l => l.text)).toEqual(['Not on a task.']);

    expect(((await tools.callTool({ name: 'inbox_mark', arguments: { ids: [onTask.letters[0]!.id], status: 'done' } })) as Said).isError).toBeFalsy();
    const left = JSON.parse(((await tools.callTool({ name: 'inbox', arguments: {} })) as Said).content[0]!.text) as typeof all;
    expect(left.unread).toBe(1);
    const history = JSON.parse(((await tools.callTool({ name: 'inbox', arguments: { status: 'all' } })) as Said).content[0]!.text) as typeof all;
    expect(history.letters.map(l => l.status)).toEqual(['done', 'unread']);

    /* Another employee's letters are not hers to mark. */
    await c.letter(c.hana, c.sara.id, 'For Sara.');
    const [saras] = await c.inboxOf(c.sara.id);
    const refused = (await tools.callTool({ name: 'inbox_mark', arguments: { ids: [saras!.id], status: 'done' } })) as Said;
    expect(refused.isError).toBe(true);
    expect((await c.inboxOf(c.sara.id))[0]!.status).not.toBe('done');
  });

  it('let letters marked in the running turn go without a turn of their own', async () => {
    const c = await company();
    const talk = await c.ivanWrites(c.hana.id, 'Let us plan.');
    await c.letter(c.bruno, c.hana.id, 'Read me now.');
    const tools = await c.toolsOf(c.hana.id);
    const [mine] = await c.inboxOf(c.hana.id);
    await tools.callTool({ name: 'inbox_mark', arguments: { ids: [mine!.id], status: 'read' } });
    await c.ends(talk);
    expect((await c.turnsOf(c.hana.id)).filter(j => j.inboxWake).map(j => j.status)).toEqual(['done']);
    expect(c.runs().filter(r => r.prompt.includes('Read me now.'))).toEqual([]);
  });
});

/* Letters of Sam, the head of Sales, as a long quiet night of the Mac node left them: three stale alarms an hour apart, a
   call to the program operator, and Sara's letter on her task. */
async function nightOf(c: Company, agentId = c.sam.id) {
  const task = await c.task(c.bruno.id);
  const at = (h: number) => new Date(START.getTime() + h * 60 * MIN);
  const notice = (source: string, text: string, h: number) => ({ companyId: c.companyId, agentId, senderKind: 'hornhoof' as const, senderName: 'Hornhoof', kind: 'notification' as const, source, text, createdAt: at(h) });
  const rows = await c.db.insert(agentInbox).values([
    notice('program_alarm', 'Bruno has given no sign of life for 20 minutes.', 1),
    notice('program_alarm', 'Rita has given no sign of life for 20 minutes.', 2),
    notice('program_operator', 'Program operator case for Bruno.', 2),
    notice('program_alarm', 'Sara has given no sign of life for 20 minutes.', 3),
    { companyId: c.companyId, agentId, senderKind: 'agent' as const, senderAgentId: c.sara.id, senderName: 'Sara', kind: 'message' as const, taskId: task.id, taskNumber: task.number, text: 'The price list is ready.', createdAt: at(4) },
  ]).returning();
  return { task, at, rows };
}

/* What the employee's log tells of marks someone else made in its inbox. */
const marksIn = async (c: Company, agentId: string) =>
  (await c.db.select().from(agentEvents).where(eq(agentEvents.agentId, agentId)).orderBy(asc(agentEvents.seq)))
    .map(e => e.data as { text: string; notification?: { source: string }; inboxMarked?: unknown; _message?: { from: { kind: string; name: string } } })
    .filter(d => d.notification?.source === 'inbox_marked');

const json = (res: Said) => JSON.parse(res.content[0]!.text) as { unread: number; letters: { id: string; from: string; task: number | null; text: string; status: string }[] };

describe("another employee's inbox", () => {
  it("opens to the orchestrator whole, and it marks letters by kind, source, task and time, which the employee's log tells with who, why and how many", async () => {
    const c = await company();
    const { task, at } = await nightOf(c);
    const tools = await c.toolsOf(c.orchestrator.id);
    const all = json((await tools.callTool({ name: 'inbox', arguments: { employee: c.sam.id, status: 'all' } })) as Said);
    expect(all.unread).toBe(5);
    expect(all.letters.map(l => l.text)).toEqual(['Bruno has given no sign of life for 20 minutes.', 'Rita has given no sign of life for 20 minutes.', 'Program operator case for Bruno.', 'Sara has given no sign of life for 20 minutes.', 'The price list is ready.']);

    const stale = (await tools.callTool({ name: 'inbox_mark', arguments: { employee: c.sam.id, status: 'done', source: 'program_alarm', receivedBefore: at(3).toISOString(), reason: 'Stale alarms of the night the Mac node was away.' } })) as Said;
    expect(stale.isError).toBeFalsy();
    expect(stale.content[0]!.text).toBe("Marked 2 letters done in Sam's inbox.");
    const onTask = (await tools.callTool({ name: 'inbox_mark', arguments: { employee: c.sam.id, status: 'read', kind: 'message', task: task.number, reason: 'Sara told me the same.' } })) as Said;
    expect(onTask.content[0]!.text).toBe("Marked 1 letter read in Sam's inbox.");
    expect((await c.inboxOf(c.sam.id)).map(l => l.status)).toEqual(['done', 'done', 'unread', 'unread', 'read']);
    /* Read never takes back a letter that was dealt with, and a mark that finds nothing tells nobody anything. */
    const none = (await tools.callTool({ name: 'inbox_mark', arguments: { employee: c.sam.id, status: 'read', source: 'program_alarm', receivedBefore: at(3).toISOString(), reason: 'Again.' } })) as Said;
    expect(none.content[0]!.text).toBe("Marked 0 letters read in Sam's inbox.");
    expect((await c.inboxOf(c.sam.id)).map(l => l.status)).toEqual(['done', 'done', 'unread', 'unread', 'read']);

    expect(await marksIn(c, c.sam.id)).toEqual([
      expect.objectContaining({ text: 'Orchestrator marked 2 letters done in this inbox. Why: Stale alarms of the night the Mac node was away.', inboxMarked: { by: { kind: 'agent', id: c.orchestrator.id, name: 'Orchestrator' }, status: 'done', count: 2, reason: 'Stale alarms of the night the Mac node was away.' } }),
      expect.objectContaining({ text: 'Orchestrator marked 1 letter read in this inbox. Why: Sara told me the same.', inboxMarked: { by: { kind: 'agent', id: c.orchestrator.id, name: 'Orchestrator' }, status: 'read', count: 1, reason: 'Sara told me the same.' } }),
    ]);
    expect((await marksIn(c, c.sam.id))[0]!._message!.from).toMatchObject({ kind: 'agent', name: 'Orchestrator' });
    expect(await marksIn(c, c.orchestrator.id)).toEqual([]);
  });

  it('asks the orchestrator for a reason and a choice of letters, and refuses ids of letters that are not that inbox\'s whole', async () => {
    const c = await company();
    const { rows } = await nightOf(c);
    await c.db.insert(agentInbox).values({ companyId: c.companyId, agentId: c.sara.id, senderKind: 'hornhoof', senderName: 'Hornhoof', kind: 'notification', text: 'For Sara.', createdAt: new Date() });
    const [saras] = await c.inboxOf(c.sara.id);
    const tools = await c.toolsOf(c.orchestrator.id);
    const refused = async (args: Record<string, unknown>) => ((await tools.callTool({ name: 'inbox_mark', arguments: args })) as Said);
    expect((await refused({ employee: c.sam.id, status: 'done', source: 'program_alarm' })).isError).toBe(true);
    expect((await refused({ employee: c.sam.id, status: 'done', reason: 'All of it.' })).isError).toBe(true);
    const mixed = await refused({ employee: c.sam.id, status: 'done', ids: [rows[0]!.id, saras!.id], reason: 'Old.' });
    expect(mixed.isError).toBe(true);
    expect((await c.inboxOf(c.sam.id)).every(l => l.status === 'unread')).toBe(true);
    expect((await refused({ employee: c.sam.id, status: 'done', ids: [rows[0]!.id], reason: 'Old.' })).content[0]!.text).toBe("Marked 1 letter done in Sam's inbox.");
  });

  it("is closed to every other employee, a head too, and a person's own assistant's or a removed employee's to the orchestrator", async () => {
    const c = await company();
    const { rows } = await nightOf(c);
    const hana = await c.toolsOf(c.hana.id);
    const read = (await hana.callTool({ name: 'inbox', arguments: { employee: c.sam.id } })) as Said;
    expect(read.isError).toBe(true);
    expect(read.content[0]!.text).toBe("Forbidden: only the orchestrator reads and marks another employee's inbox. Leave out employee for your own.");
    const marked = (await hana.callTool({ name: 'inbox_mark', arguments: { employee: c.sam.id, status: 'done', ids: [rows[0]!.id], reason: 'Mine now.' } })) as Said;
    expect(marked.isError).toBe(true);
    expect((await c.inboxOf(c.sam.id)).every(l => l.status === 'unread')).toBe(true);
    /* Her own inbox, named or not, is hers as before. */
    expect(json((await hana.callTool({ name: 'inbox', arguments: { employee: c.hana.id } })) as Said).letters).toEqual([]);

    const [ava] = await c.db.insert(agents).values({ companyId: c.companyId, kind: 'assistant', name: 'Ava', model: 'claude-opus-5-5', subscriptionId: c.key.id, skills: [] }).returning();
    /* Rita left the company. */
    await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, c.rita.id));
    const orchestrator = await c.toolsOf(c.orchestrator.id);
    for (const employee of [ava!.id, c.rita.id, '0f0f0f0f-0000-4000-8000-00000000000a']) {
      const unknown = (await orchestrator.callTool({ name: 'inbox', arguments: { employee } })) as Said;
      expect(unknown.isError).toBe(true);
      expect(unknown.content[0]!.text).toBe(`There is no employee with id ${employee} in the company. Call company for their ids.`);
    }
    expect(await marksIn(c, c.sam.id)).toEqual([]);
  });
});

describe('the delivery mode', () => {
  it('is the inbox for a company from its first setup', async () => {
    const { app, db } = await testApp();
    expect((await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP })).statusCode).toBeLessThan(300);
    expect((await db.select({ mode: companies.inboxMode }).from(companies))).toEqual([{ mode: 'inbox' }]);
  });

  const put = (c: Company, url: string, mode: string | null, token = c.ceoToken) => c.app.inject({ method: 'PUT', url, payload: { mode }, ...as(token) });

  it('sends letters as before to an employee set to direct delivery, and takes the department\'s and the company\'s mode otherwise', async () => {
    const c = await company();
    expect((await put(c, `/api/agents/${c.hana.id}/inbox-mode`, 'direct')).statusCode).toBe(200);
    const talk = await c.ivanWrites(c.hana.id, 'Let us plan.');
    const own = await c.letter(c.bruno, c.hana.id, 'A turn of its own.');
    expect(await c.job(own)).toMatchObject({ status: 'queued', inboxWake: false });
    expect((await c.inboxOf(c.hana.id)).map(m => [m.text, m.status, m.jobId])).toEqual([['A turn of its own.', 'unread', own]]);
    await c.ends(talk);
    expect((await c.job(own)).status).toBe('running');
    expect((await c.inboxOf(c.hana.id)).map(m => m.status)).toEqual(['read']);
    await c.ends(own);

    expect((await put(c, '/api/company/inbox-mode', 'direct')).statusCode).toBe(200);
    expect((await put(c, `/api/departments/${c.dev.id}/inbox-mode`, 'inbox')).statusCode).toBe(200);
    expect((await put(c, `/api/agents/${c.hana.id}/inbox-mode`, null)).statusCode).toBe(200);
    const view = (await c.app.inject({ url: `/api/agents/${c.hana.id}/inbox`, ...as(c.ceoToken) })).json() as { mode: string | null; inheritedMode: string; effectiveMode: string };
    expect(view).toMatchObject({ mode: null, inheritedMode: 'inbox', effectiveMode: 'inbox' });
    const again = await c.ivanWrites(c.hana.id, 'And now?');
    expect((await c.job(again)).status).toBe('running');
    const wake = await c.letter(c.bruno, c.hana.id, 'Into the inbox.');
    expect(await c.job(wake)).toMatchObject({ status: 'queued', inboxWake: true });
    expect((await c.inboxOf(c.hana.id)).at(-1)).toMatchObject({ text: 'Into the inbox.', status: 'unread' });
    const sam = (await c.app.inject({ url: `/api/agents/${c.sam.id}/inbox`, ...as(c.ceoToken) })).json() as typeof view;
    expect(sam).toMatchObject({ mode: null, inheritedMode: 'direct', effectiveMode: 'direct' });
  });

  it('is for the CEO alone to set for the orchestrator, which has no department', async () => {
    const c = await company();
    expect((await put(c, `/api/agents/${c.orchestrator.id}/inbox-mode`, 'direct')).statusCode).toBe(200);
    expect((await c.app.inject({ url: `/api/agents/${c.orchestrator.id}/inbox`, ...as(c.ceoToken) })).json()).toMatchObject({ mode: 'direct', inheritedMode: 'inbox', effectiveMode: 'direct' });
  });

  it('opens an employee\'s inbox to the CEO and to the owner of its department only', async () => {
    const c = await company();
    const pia = await invitePerson(c.app, c.ceoToken, { name: 'Pia', email: 'pia@acme.com', access: { departments: [c.sales.id] } });
    const [piaRow] = await c.db.select().from(people).where(eq(people.name, 'Pia'));
    await c.db.update(departments).set({ ownerPersonId: piaRow!.id }).where(eq(departments.id, c.sales.id));
    await c.letter(c.bruno, c.hana.id, 'For Hana.');
    await c.letter(c.sam, c.sara.id, 'For Sara.');

    const read = (agentId: string, token: string) => c.app.inject({ url: `/api/agents/${agentId}/inbox`, ...as(token) });
    expect((await read(c.hana.id, c.ceoToken)).statusCode).toBe(200);
    const hers = (await read(c.sara.id, pia)).json() as { unread: number; letters: { text: string }[] };
    expect(hers.letters.map(l => l.text)).toEqual(['For Sara.']);
    expect((await read(c.hana.id, pia)).statusCode).toBe(403);
    expect((await put(c, `/api/agents/${c.hana.id}/inbox-mode`, 'direct', pia)).statusCode).toBe(403);
    expect((await put(c, `/api/departments/${c.dev.id}/inbox-mode`, 'direct', pia)).statusCode).toBe(403);
    expect((await put(c, '/api/company/inbox-mode', 'direct', pia)).statusCode).toBe(403);
    expect((await put(c, `/api/departments/${c.sales.id}/inbox-mode`, 'direct', pia)).statusCode).toBe(200);
    expect((await put(c, `/api/agents/${c.sara.id}/inbox-mode`, 'inbox', pia)).statusCode).toBe(200);
  });

  it('sets a mode for a department alone, and knows no department by the id of a product in it', async () => {
    const c = await company();
    const [shop] = await c.db.insert(departments).values({ companyId: c.companyId, name: 'Shop', parentId: c.dev.id, roleCode: 'DEV' }).returning();
    const res = await put(c, `/api/departments/${shop!.id}/inbox-mode`, 'direct');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found', reason: 'department_unknown' } });
    expect((await c.db.select({ mode: departments.inboxMode }).from(departments).where(eq(departments.id, shop!.id)))).toEqual([{ mode: null }]);
  });
});

type Letter = { id: string; sender: { kind: string; id: string | null; name: string; role: { en: string; ru: string } | null; department: { id: string; name: { en: string; ru: string } } | null }; kind: string; task: { id: string | null; number: number; title: string | null } | null; receivedAt: string; text: string; unread: boolean };
type Inbox = { unreadCount: number; total: number; letters: Letter[]; more: boolean; mode: string | null; inheritedMode: string; effectiveMode: string; canChangeMode: boolean; canMarkRead: boolean };

describe('the inbox a person opens', () => {
  const open = async (c: Company, agentId: string, token = c.ceoToken, query = '') => (await c.app.inject({ url: `/api/agents/${agentId}/inbox${query}`, ...as(token) })).json() as Inbox;
  const markRead = (c: Company, agentId: string, payload: { ids: string[] } | { all: true }, token = c.ceoToken) =>
    c.app.inject({ method: 'POST', url: `/api/agents/${agentId}/inbox/read`, payload, ...as(token) });

  it('shows each letter with who sent it, of what kind, on which task and when, and a letter the employee dealt with as read', async () => {
    const c = await company();
    const given = await c.given(c.bruno.id);
    const task = given.task;
    c.later();
    await wakeAll(c.ctx, (await comment(c.ctx, { agentId: c.hana.id }, task.id, 'Mind the rounding.')).wakes);
    c.later();
    await c.letter(c.rita, c.bruno.id, 'I pushed the fixtures.', task.number);

    /* Newest first, as the tab shows them. */
    const inbox = await open(c, c.bruno.id);
    expect(inbox.letters.map(l => l.kind)).toEqual(['message', 'comment', 'assignment']);
    expect(inbox.letters.map(l => l.unread)).toEqual([true, true, false]);
    expect(inbox).toMatchObject({ unreadCount: 2, total: 3, more: false, mode: null, inheritedMode: 'inbox', effectiveMode: 'inbox', canChangeMode: true, canMarkRead: true });
    const [pushed, , assigned] = inbox.letters;
    expect(assigned!.sender).toMatchObject({ kind: 'agent', id: c.hana.id, name: 'Hana', department: { id: c.dev.id } });
    expect(assigned!.sender.role).not.toBeNull();
    expect(pushed).toMatchObject({ sender: { kind: 'agent', id: c.rita.id, name: 'Rita', department: { id: c.dev.id } }, task: { id: task.id, number: task.number, title: 'Checkout API' }, text: 'I pushed the fixtures.', receivedAt: new Date(Date.now()).toISOString() });

    const tools = await c.toolsOf(c.bruno.id);
    await tools.callTool({ name: 'inbox_mark', arguments: { ids: [pushed!.id], status: 'done' } });
    expect((await open(c, c.bruno.id)).letters.map(l => l.unread)).toEqual([false, true, false]);
  });

  it('gives a comment that waits in a turn of its task with that turn, not again in the turn that takes the inbox', async () => {
    const c = await company();
    const given = await c.given(c.bruno.id);
    const [working] = (await c.turnsOf(c.bruno.id)).filter(j => j.status === 'running');
    await wakeAll(c.ctx, (await comment(c.ctx, { agentId: c.hana.id }, given.task.id, 'Mind the rounding.')).wakes);
    const [onTask] = (await c.turnsOf(c.bruno.id)).filter(j => j.status === 'queued');
    await c.letter(c.rita, c.bruno.id, 'I pushed the fixtures.');
    /* The plan's share for tasks is spent: a worker's task turns wait for it, other turns go. */
    await c.db.update(subscriptions).set({ budget: 50, limits: { status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.8, resetsAt: new Date(Date.now() + 60 * MIN).toISOString() }] }, limitsUpdatedAt: new Date() }).where(eq(subscriptions.id, c.key.id));
    await c.ends(working!.id);
    const wake = (await c.turnsOf(c.bruno.id)).find(j => j.inboxWake)!;
    expect(wake.status).toBe('running');
    const summary = c.runs().find(r => r.jobId === wake.id)!.prompt;
    expect(summary).toMatch(/1 unread letter\b/);
    expect(summary).not.toContain('Mind the rounding.');
    expect((await c.inboxOf(c.bruno.id)).find(m => m.kind === 'comment')).toMatchObject({ status: 'unread', jobId: onTask!.id });
  });

  it('names letters of each kind as the tab shows them', () => {
    const of = (m: Partial<MailMessage>) => letterKind({ personId: null, text: 'x', ...m });
    expect(of({ from: 'agent', by: 'a', name: 'Bruno' })).toBe('message');
    expect(of({ from: 'orchestrator' })).toBe('message');
    expect(of({ report: 'Done.' })).toBe('report');
    expect(of({ notification: { source: 'reported' } })).toBe('report');
    expect(of({ notification: { source: 'comment' } })).toBe('comment');
    expect(of({ notification: { source: 'assigned' } })).toBe('assignment');
    expect(of({ notification: { source: 'review' } })).toBe('assignment');
    expect(of({ notification: { source: 'tests' } })).toBe('notification');
    expect(of({})).toBe('notification');
  });

  it('leaves a letter unread when a person opens it, and marks it read only by the person\'s own buttons', async () => {
    const c = await company();
    const talk = await c.ivanWrites(c.hana.id, 'Let us plan.');
    for (const text of ['One.', 'Two.', 'Three.']) await c.letter(c.bruno, c.hana.id, text);
    await open(c, c.hana.id);
    const opened = await open(c, c.hana.id);
    expect(opened.unreadCount).toBe(3);
    expect(opened.letters.map(l => l.text)).toEqual(['Three.', 'Two.', 'One.']);
    expect((await c.app.inject({ url: `/api/agents/${c.hana.id}`, ...as(c.ceoToken) })).json()).toMatchObject({ inboxUnread: 3 });
    expect((await c.inboxOf(c.hana.id)).map(m => m.status)).toEqual(['unread', 'unread', 'unread']);

    const tools = await c.toolsOf(c.hana.id);
    await tools.callTool({ name: 'inbox_mark', arguments: { ids: [opened.letters[0]!.id], status: 'done' } });
    expect((await markRead(c, c.hana.id, { ids: [opened.letters[2]!.id] })).statusCode).toBe(200);
    expect((await open(c, c.hana.id)).unreadCount).toBe(1);
    expect((await markRead(c, c.hana.id, { all: true })).json()).toEqual({ unreadCount: 0 });
    expect((await c.inboxOf(c.hana.id)).map(m => m.status)).toEqual(['read', 'read', 'done']);
    await c.ends(talk);
    expect(c.runs().filter(r => r.prompt.includes('Two.'))).toEqual([]);
  });

  it('lets only who may change the employee\'s rules mark its letters, and only its own letters', async () => {
    const c = await company();
    await c.ivanWrites(c.hana.id, 'Let us plan.');
    await c.ivanWrites(c.sara.id, 'Let us sell.');
    const pia = await invitePerson(c.app, c.ceoToken, { name: 'Pia', email: 'pia@acme.com', access: { departments: [c.sales.id] } });
    const [piaRow] = await c.db.select().from(people).where(eq(people.name, 'Pia'));
    await c.db.update(departments).set({ ownerPersonId: piaRow!.id }).where(eq(departments.id, c.sales.id));
    await c.letter(c.bruno, c.hana.id, 'For Hana.');
    await c.letter(c.sam, c.sara.id, 'For Sara.');
    const [hanas] = await c.inboxOf(c.hana.id);
    const [saras] = await c.inboxOf(c.sara.id);

    expect((await open(c, c.sara.id, pia))).toMatchObject({ canChangeMode: true, canMarkRead: true });
    expect((await open(c, c.hana.id))).toMatchObject({ canChangeMode: true, canMarkRead: true });
    expect((await markRead(c, c.hana.id, { all: true }, pia)).statusCode).toBe(403);
    expect((await markRead(c, c.sara.id, { ids: [hanas!.id] }, pia)).statusCode).toBe(404);
    expect((await c.inboxOf(c.hana.id))[0]!.status).toBe('unread');
    expect((await markRead(c, c.sara.id, { ids: [saras!.id] }, pia)).statusCode).toBe(200);
    expect((await c.inboxOf(c.sara.id))[0]!.status).toBe('read');
  });

  it('shows a person who opens the employee on a plan of theirs in a team they have, but does not run its department, its letters with no buttons, and refuses their marks', async () => {
    const c = await company();
    /* Everyone given a department runs it; a team in it is not the department. */
    const [backend] = await c.db.insert(teams).values({ companyId: c.companyId, departmentId: c.dev.id, name: 'Backend' }).returning();
    await c.db.update(agents).set({ teamId: backend!.id }).where(eq(agents.id, c.bruno.id));
    const lena = await invitePerson(c.app, c.ceoToken, { name: 'Lena', email: 'lena@acme.com', access: { departments: [], teams: [backend!.id] } });
    const [lenaRow] = await c.db.select().from(people).where(eq(people.name, 'Lena'));
    const [plan] = await c.db.insert(subscriptions).values({ companyId: c.companyId, provider: 'claude', kind: 'personal', label: 'Lena', status: 'ready', ownerPersonId: lenaRow!.id }).returning();
    await c.db.update(agents).set({ subscriptionId: plan!.id }).where(eq(agents.id, c.bruno.id));
    await c.db.insert(agentInbox).values({ companyId: c.companyId, agentId: c.bruno.id, senderKind: 'hornhoof', senderName: 'Hornhoof', kind: 'notification', text: 'The run ended.', createdAt: new Date() });

    const seen = await open(c, c.bruno.id, lena);
    expect(seen).toMatchObject({ unreadCount: 1, canChangeMode: false, canMarkRead: false });
    expect(seen.letters.map(l => l.text)).toEqual(['The run ended.']);
    expect((await markRead(c, c.bruno.id, { ids: [seen.letters[0]!.id] }, lena)).statusCode).toBe(403);
    expect((await markRead(c, c.bruno.id, { all: true }, lena)).statusCode).toBe(403);
    expect((await c.inboxOf(c.bruno.id))[0]!.status).toBe('unread');
  });

  const mark = (c: Company, agentId: string, payload: object, token = c.ceoToken) =>
    c.app.inject({ method: 'POST', url: `/api/agents/${agentId}/inbox/mark`, payload, ...as(token) });

  it("lets the CEO and the CEO delegate mark any employee's letters read or done by kind, source, task and time, with the reason in its log", async () => {
    const c = await company();
    const { task, at, rows } = await nightOf(c);
    const dave = await invitePerson(c.app, c.ceoToken, { name: 'Dave', email: 'dave@acme.com', access: { whole: true } });
    await c.db.update(people).set({ isCeoDelegate: true }).where(eq(people.name, 'Dave'));

    const stale = await mark(c, c.sam.id, { status: 'done', source: 'program_alarm', receivedBefore: at(3).toISOString(), reason: 'Stale alarms.' });
    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toEqual({ marked: 2, unreadCount: 3 });
    const byDave = await mark(c, c.sam.id, { status: 'read', ids: [rows[2]!.id], kind: 'notification', reason: 'Bruno is back.' }, dave);
    expect(byDave.json()).toEqual({ marked: 1, unreadCount: 2 });
    expect((await mark(c, c.sam.id, { status: 'done', kind: 'message', task: task.number, reason: 'Answered.' }, dave)).json()).toEqual({ marked: 1, unreadCount: 1 });
    expect((await c.inboxOf(c.sam.id)).map(l => l.status)).toEqual(['done', 'done', 'read', 'unread', 'done']);

    expect((await marksIn(c, c.sam.id)).map(d => [d.text, d.inboxMarked, d._message?.from.name])).toEqual([
      ['Ivan marked 2 letters done in this inbox. Why: Stale alarms.', { by: { kind: 'person', id: c.ceo.id, name: 'Ivan' }, status: 'done', count: 2, reason: 'Stale alarms.' }, 'Ivan'],
      ['Dave marked 1 letter read in this inbox. Why: Bruno is back.', { by: { kind: 'person', id: expect.any(String), name: 'Dave' }, status: 'read', count: 1, reason: 'Bruno is back.' }, 'Dave'],
      ['Dave marked 1 letter done in this inbox. Why: Answered.', { by: { kind: 'person', id: expect.any(String), name: 'Dave' }, status: 'done', count: 1, reason: 'Answered.' }, 'Dave'],
    ]);
  });

  it('asks for a reason and a choice of letters, refuses letters of another inbox, and opens to nobody else, a department owner and a person with the whole company too', async () => {
    const c = await company();
    /* Sara's letters this time: Pia, who owns Sales, sees her once she works on its plan. */
    await c.ivanWrites(c.sara.id, 'Let us sell.');
    const { rows } = await nightOf(c, c.sara.id);
    await c.db.insert(agentInbox).values({ companyId: c.companyId, agentId: c.sam.id, senderKind: 'hornhoof', senderName: 'Hornhoof', kind: 'notification', text: 'For Sam.', createdAt: new Date() });
    const [sams] = await c.inboxOf(c.sam.id);
    expect((await mark(c, c.sara.id, { status: 'done', source: 'program_alarm' })).statusCode).toBe(400);
    expect((await mark(c, c.sara.id, { status: 'done', reason: 'Everything.' })).statusCode).toBe(400);
    expect((await mark(c, c.sara.id, { status: 'done', ids: [sams!.id], reason: 'Old.' })).statusCode).toBe(404);

    const pia = await invitePerson(c.app, c.ceoToken, { name: 'Pia', email: 'pia@acme.com', access: { departments: [c.sales.id] } });
    await c.db.update(departments).set({ ownerPersonId: (await c.db.select().from(people).where(eq(people.name, 'Pia')))[0]!.id }).where(eq(departments.id, c.sales.id));
    const wes = await invitePerson(c.app, c.ceoToken, { name: 'Wes', email: 'wes@acme.com', access: { whole: true } });
    const byPia = await mark(c, c.sara.id, { status: 'done', ids: [rows[0]!.id], reason: 'Old.' }, pia);
    expect(byPia.statusCode).toBe(403);
    expect(byPia.json().error.message).toBe("Only the CEO and the CEO delegate mark another employee's letters this way.");
    /* Wes sees the whole company, yet is neither the CEO nor the delegate. */
    expect((await mark(c, c.sara.id, { status: 'done', ids: [rows[0]!.id], reason: 'Old.' }, wes)).statusCode).toBe(403);
    /* The owner of Sales still marks its letters read by the buttons of the tab. */
    expect((await markRead(c, c.sara.id, { ids: [rows[0]!.id] }, pia)).statusCode).toBe(200);
    expect((await c.inboxOf(c.sara.id)).map(l => l.status)).toEqual(['read', 'unread', 'unread', 'unread', 'unread']);
    expect(await marksIn(c, c.sara.id)).toEqual([]);
  });

  it('names a sender that is no longer in the company "Employee", not by the name its letter kept', async () => {
    const c = await company();
    await c.letter(c.rita, c.bruno.id, 'I pushed the fixtures.');
    /* No employee leaves the company by a route yet: Rita goes as a removal would take her, past what still points at her. */
    await c.db.transaction(async tx => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.delete(agents).where(eq(agents.id, c.rita.id));
    });
    const [letter] = (await open(c, c.bruno.id)).letters;
    expect(letter!.sender).toEqual({ kind: 'agent', id: null, name: 'Employee', role: null, department: null });
  });

  it('gives the newest 50 letters first, and the older ones a page at a time', async () => {
    const c = await company();
    await c.db.insert(agentInbox).values(Array.from({ length: 55 }, (_, i) => ({ companyId: c.companyId, agentId: c.bruno.id, senderKind: 'hornhoof' as const, senderName: 'Hornhoof', kind: 'notification' as const, text: `Notice ${i}.`, createdAt: new Date() })));
    const first = await open(c, c.bruno.id);
    expect(first).toMatchObject({ total: 55, unreadCount: 55, more: true });
    expect(first.letters).toHaveLength(50);
    expect([first.letters[0]!.text, first.letters.at(-1)!.text]).toEqual(['Notice 54.', 'Notice 5.']);
    const next = await open(c, c.bruno.id, c.ceoToken, `?before=${first.letters.at(-1)!.id}`);
    expect(next).toMatchObject({ more: false });
    expect(next.letters.map(l => l.text)).toEqual(['Notice 4.', 'Notice 3.', 'Notice 2.', 'Notice 1.', 'Notice 0.']);
  });

  it('tells the screens of the employee\'s place when its inbox changes, and nothing of what it says', async () => {
    const c = await company();
    const heard = vi.spyOn(c.ctx.bus, 'publish');
    const talk = await c.ivanWrites(c.hana.id, 'Let us plan.');
    await c.letter(c.bruno, c.hana.id, 'A letter.');
    const told = () => heard.mock.calls.filter(([, m]) => m.type === 'inbox').map(([, m]) => m);
    expect(told()).toEqual([{ type: 'inbox', agentId: c.hana.id, spot: { departmentId: c.dev.id, parentId: null, teamId: null } }]);
    await markRead(c, c.hana.id, { all: true });
    expect(told()).toHaveLength(2);
    await c.ends(talk);
  });
});
