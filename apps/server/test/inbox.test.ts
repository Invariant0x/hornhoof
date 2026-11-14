import type { ServerMessage } from '@hornhoof/protocol';
import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentInbox, agents, companies, departments, jobs, people, subscriptions, tasks } from '../src/db/schema.js';
import { said } from '../src/modules/conversation/live.js';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { queueTaskMessage, waitFor } from '../src/modules/tasks/external-wait.js';
import { as, echelonsTurn, invitePerson, listen, mcp, setUpCompany, testApp } from './helpers.js';

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
  const send = vi.spyOn(ctx.hub, 'send').mockImplementation((to, m: ServerMessage) => {
    if (m.type === 'agent.say') queueMicrotask(() => said(ctx, to, m.ref, takesLiveWords));
    return true;
  });
  const refuseLiveWords = () => { takesLiveWords = false; };

  const later = (ms = MIN) => vi.setSystemTime(Date.now() + ms);
  const turnsOf = (agentId: string) => db.select().from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.kind, 'conversation'))).orderBy(asc(jobs.createdAt));
  const job = async (id: string) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
  const inboxOf = (agentId: string) => db.select().from(agentInbox).where(eq(agentInbox.agentId, agentId)).orderBy(asc(agentInbox.createdAt));
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
    await db.insert(jobs).values({ companyId, subscriptionId: key!.id, agentId, kind: 'conversation', prompt: 'Work.', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    return mcp(app, token);
  };
  const task = async (holder: string, body = '') => (await createTask(ctx, { agentId: hana.id }, { title: 'Checkout API', brief: '', body, departmentId: dev!.id, assigneeAgentId: holder, executor: true, small: true, paths: ['logic/totals.ts'] })).task;
  return { app, ctx, db, ceoToken, companyId, ceo: ceo!, key: key!, orchestrator: orchestrator!, dev: dev!, sales: sales!, hana, bruno, rita, sam, sara, later, turnsOf, job, inboxOf, runs, liveWords, ivanWrites, letter, ends, toolsOf, task, refuseLiveWords, send };
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
  const put = (c: Company, url: string, mode: string | null, token = c.ceoToken) => c.app.inject({ method: 'PUT', url, payload: { mode }, ...as(token) });

  it('sends letters as before to an employee set to direct delivery, and takes the department\'s and the company\'s mode otherwise', async () => {
    const c = await company();
    expect((await put(c, `/api/agents/${c.hana.id}/inbox-mode`, 'direct')).statusCode).toBe(200);
    const talk = await c.ivanWrites(c.hana.id, 'Let us plan.');
    await c.letter(c.bruno, c.hana.id, 'Straight in.');
    expect(c.liveWords().map(w => w.text)).toEqual([expect.stringContaining('Straight in.')]);
    expect((await c.turnsOf(c.hana.id)).some(j => j.inboxWake)).toBe(false);
    expect((await c.inboxOf(c.hana.id)).map(m => [m.text, m.status])).toEqual([['Straight in.', 'read']]);
    await c.ends(talk);

    expect((await put(c, '/api/company/inbox-mode', 'direct')).statusCode).toBe(200);
    expect((await put(c, `/api/departments/${c.dev.id}/inbox-mode`, 'inbox')).statusCode).toBe(200);
    expect((await put(c, `/api/agents/${c.hana.id}/inbox-mode`, null)).statusCode).toBe(200);
    const view = (await c.app.inject({ url: `/api/agents/${c.hana.id}/inbox`, ...as(c.ceoToken) })).json() as { mode: { own: string | null; effective: string } };
    expect(view.mode).toEqual({ own: null, effective: 'inbox' });
    const again = await c.ivanWrites(c.hana.id, 'And now?');
    await c.letter(c.bruno, c.hana.id, 'Into the inbox.');
    expect(c.liveWords().map(w => w.text)).not.toEqual(expect.arrayContaining([expect.stringContaining('Into the inbox.')]));
    expect((await c.inboxOf(c.hana.id)).at(-1)).toMatchObject({ text: 'Into the inbox.', status: 'unread' });
    expect((await c.job(again)).status).toBe('running');
    const sam = (await c.app.inject({ url: `/api/agents/${c.sam.id}/inbox`, ...as(c.ceoToken) })).json() as typeof view;
    expect(sam.mode).toEqual({ own: null, effective: 'direct' });
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
