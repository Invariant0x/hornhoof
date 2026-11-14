import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentInbox, agents, companies, departments, jobs, people, subscriptions, tasks } from '../src/db/schema.js';
import { said } from '../src/modules/conversation/live.js';
import { letterKind, type MailMessage } from '../src/modules/conversation/inbox.js';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { comment, createTask } from '../src/modules/tasks/engine.js';
import { queueTaskMessage, waitFor } from '../src/modules/tasks/external-wait.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
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

  it('wakes a holder whose task waits at once with one turn, and ends the wait as before', async () => {
    const c = await company();
    const task = await c.task(c.bruno.id);
    await waitFor(c.ctx, c.bruno.id, task.id, { reason: 'Images', until: new Date(Date.now() + 60 * MIN).toISOString(), on: { kind: 'employee', employee: c.hana.id } });
    await c.letter(c.hana, c.bruno.id, 'The images are ready.', task.number);

    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.externalWait).toBeNull();
    const [batch] = (await c.turnsOf(c.bruno.id)).filter(j => j.status === 'running');
    expect(batch).toMatchObject({ inboxWake: true });
    const prompt = c.runs().find(r => r.jobId === batch!.id)!.prompt;
    expect(prompt).toContain('The images are ready.');
    expect(prompt).toContain(`#${task.number}`);
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
    await c.letter(c.hana, c.bruno.id, `Look at the totals. ${'x'.repeat(1000)}`, task.number);
    await c.letter(c.hana, c.rita.id, 'Only for Rita.');
    const [batch] = (await c.turnsOf(c.bruno.id)).filter(j => j.status === 'running');
    const prompt = c.runs().find(r => r.jobId === batch!.id)!.prompt;
    expect(prompt).toContain(`#${task.number}`);
    expect(prompt).not.toContain('SECRET-BODY');
    expect(prompt).not.toContain('Only for Rita.');
    expect(prompt).not.toContain('x'.repeat(600));
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
    const view = (await c.app.inject({ url: `/api/agents/${c.hana.id}/inbox`, ...as(c.ceoToken) })).json() as { mode: { own: string | null; effective: string } };
    expect(view.mode).toEqual({ own: null, effective: 'inbox' });
    const again = await c.ivanWrites(c.hana.id, 'And now?');
    expect((await c.job(again)).status).toBe('running');
    const wake = await c.letter(c.bruno, c.hana.id, 'Into the inbox.');
    expect(await c.job(wake)).toMatchObject({ status: 'queued', inboxWake: true });
    expect((await c.inboxOf(c.hana.id)).at(-1)).toMatchObject({ text: 'Into the inbox.', status: 'unread' });
    const sam = (await c.app.inject({ url: `/api/agents/${c.sam.id}/inbox`, ...as(c.ceoToken) })).json() as typeof view;
    expect(sam.mode).toEqual({ own: null, effective: 'direct' });
  });

  it('is for the CEO alone to set for the orchestrator, which has no department', async () => {
    const c = await company();
    expect((await put(c, `/api/agents/${c.orchestrator.id}/inbox-mode`, 'direct')).statusCode).toBe(200);
    expect((await c.app.inject({ url: `/api/agents/${c.orchestrator.id}/inbox`, ...as(c.ceoToken) })).json()).toMatchObject({ mode: { own: 'direct', effective: 'direct' } });
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
});

type Letter = { id: string; sender: { kind: string; id: string | null; name: string; role: { en: string; ru: string } | null; department: { id: string; name: { en: string; ru: string } } | null }; kind: string; task: { number: number; title: string | null } | null; at: string; text: string; status: string };
type Inbox = { unread: number; letters: Letter[]; mode: { own: string | null; effective: string } };

describe('the inbox a person opens', () => {
  const open = async (c: Company, agentId: string, token = c.ceoToken) => (await c.app.inject({ url: `/api/agents/${agentId}/inbox`, ...as(token) })).json() as Inbox;
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

    const inbox = await open(c, c.bruno.id);
    expect(inbox.letters.map(l => l.kind)).toEqual(['assignment', 'comment', 'message']);
    expect(inbox.letters.map(l => l.status)).toEqual(['read', 'unread', 'unread']);
    expect(inbox.unread).toBe(2);
    const [assigned, , pushed] = inbox.letters;
    expect(assigned!.sender).toMatchObject({ kind: 'agent', id: c.hana.id, name: 'Hana', department: { id: c.dev.id } });
    expect(assigned!.sender.role).not.toBeNull();
    expect(pushed).toMatchObject({ sender: { kind: 'agent', id: c.rita.id, name: 'Rita', department: { id: c.dev.id } }, task: { number: task.number, title: 'Checkout API' }, text: 'I pushed the fixtures.', at: new Date(Date.now()).toISOString() });

    const tools = await c.toolsOf(c.bruno.id);
    await tools.callTool({ name: 'inbox_mark', arguments: { ids: [pushed!.id], status: 'done' } });
    expect((await open(c, c.bruno.id)).letters.map(l => l.status)).toEqual(['read', 'unread', 'read']);
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
    expect(opened.unread).toBe(3);
    expect((await c.inboxOf(c.hana.id)).map(m => m.status)).toEqual(['unread', 'unread', 'unread']);

    const tools = await c.toolsOf(c.hana.id);
    await tools.callTool({ name: 'inbox_mark', arguments: { ids: [opened.letters[2]!.id], status: 'done' } });
    expect((await markRead(c, c.hana.id, { ids: [opened.letters[0]!.id] })).statusCode).toBe(200);
    expect((await open(c, c.hana.id)).unread).toBe(1);
    expect((await markRead(c, c.hana.id, { all: true })).json()).toEqual({ unread: 0 });
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

    expect((await markRead(c, c.hana.id, { all: true }, pia)).statusCode).toBe(403);
    expect((await markRead(c, c.sara.id, { ids: [hanas!.id] }, pia)).statusCode).toBe(404);
    expect((await c.inboxOf(c.hana.id))[0]!.status).toBe('unread');
    expect((await markRead(c, c.sara.id, { ids: [saras!.id] }, pia)).statusCode).toBe(200);
    expect((await c.inboxOf(c.sara.id))[0]!.status).toBe('read');
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
