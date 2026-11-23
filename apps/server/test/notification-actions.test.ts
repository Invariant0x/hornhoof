import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentEvents, agents, companies, departments, jobs, people, subscriptions } from '../src/db/schema.js';
import { answer, ask, comment, createTask, report, submit, verdict } from '../src/modules/tasks/engine.js';
import { wordsForTurn } from '../src/modules/conversation/turn-words.js';
import { said } from '../src/modules/conversation/live.js';
import { BUILTIN } from './builtin.js';
import { eq } from 'drizzle-orm';
import { checkExternalWaits, waitFor } from '../src/modules/tasks/external-wait.js';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { wakeQueued, wakesLeft } from '../src/modules/tasks/outbox.js';
import { wakeAll, wakeLeftBehind } from '../src/modules/tasks/wake.js';
import { messageHeading } from '../src/modules/conversation/prompt.js';
import { decisionPrincipal } from '../src/modules/conversation/decision-context.js';
import { appendEvent, listEvents } from '../src/modules/events/store.js';
import { setUpCompany, testApp, echelonsTurn } from './helpers.js';
import { recorded } from './recorded-fixture.js';

/* Reports are combined within ten seconds of the server's clock, and waits end by it: here it stands still unless a test
   moves it, so no window or wait runs out while a test works. */
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); });

async function fixture() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [company] = await db.select().from(companies);
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [dept] = await db.insert(departments).values({ companyId: company!.id, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop.git' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) => (await db.insert(agents).values({ companyId: company!.id, departmentId: dept!.id, kind, roleKey, name, model: 'claude-opus-5-5', subscriptionId: sub!.id, skills: app.ctx.templates.roles.get(roleKey)?.skills.filter(skill => skill.on).map(skill => skill.id) ?? [] }).returning())[0]!;
  app.ctx.readCommit = async (_repo, want) => ({ branch: 'task' in want ? `task-${want.task}` : want.branch, commitSha: 'b'.repeat(40) });
  app.ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const worker = await hire('Bruno', 'worker', 'DEV-ENG');
  const reviewer = await hire('Rita', 'worker', 'DEV-REV');
  await echelonsTurn(db, company!.id);
  const make = async () => (await createTask(app.ctx, { agentId: head.id }, { title: 'Checkout', brief: '', body: 'Build it.', departmentId: dept!.id, assigneeAgentId: worker.id, executor: true, small: true, reviewerAgentId: reviewer.id, paths: ['logic/totals.ts'] })).task;
  const notices = async (agentId: string) => (await listEvents(db, agentId, 0)).filter(e => e.kind === 'message' && e.message?.direction === 'in');
  return { app, db, head, worker, reviewer, ceo: ceo!, make, notices };
}

function attributed(event: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['notices']>>[number], name: string, action: string) {
  expect(event.message?.from.name).toBe(name);
  expect(messageHeading(event.message!)).toContain(`${name}`);
  expect(messageHeading(event.message!)).toContain('via Hornhoof');
  expect((event.data as { text: string }).text).toContain(`${name} ${action}`);
  expect(messageHeading(event.message!)).not.toContain('From Hornhoof to');
}

describe('recorded action authors', () => {
  it('attributes the Review handoff to its producer after outbox recovery', async () => {
    const c = await fixture();
    const parent = (await createTask(c.app.ctx, { personId: c.ceo.id }, { title: 'Whole feature', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id })).task;
    const child = (await createTask(c.app.ctx, { agentId: c.head.id }, { title: 'Child', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.worker.id, executor: true, small: true, reviewerAgentId: c.reviewer.id, paths: ['logic/totals.ts'], parentId: parent.id })).task;
    await submit(c.app.ctx, c.worker.id, child.id, { summary: 'Ivan pretends to be the author.', evidence: 'Checks passed.', review: { baseCommit: 'a'.repeat(40) } });
    await comment(c.app.ctx, { personId: c.ceo.id }, child.id, 'A newer comment by somebody else.');
    await wakeLeftBehind(c.app.ctx, new Date(Date.now() + 60_000));
    const messages = await c.notices(c.reviewer.id);
    expect(messages.some(e => e.message?.notification?.source === 'review')).toBe(true);
    attributed(messages.find(e => e.message?.notification?.source === 'review')!, 'Bruno', 'handed in work');
  });

  it.each([true, false])('attributes an approval decision (%s) to the recorded person', async approve => {
    const c = await fixture();
    const task = await c.make();
    const requested = await ask(c.app.ctx, c.worker.id, task.id, { kind: 'approval', text: 'Approve release?', commit: 'a'.repeat(40) });
    const moved = await answer(c.app.ctx, { personId: c.ceo.id }, requested.request.id, { approve });
    await wakeAll(c.app.ctx, moved.wakes);
    attributed((await c.notices(c.worker.id))[0]!, 'Ivan', approve ? 'approved' : 'declined');
  });

  it('attributes a free text answer without trusting names in its text', async () => {
    const c = await fixture();
    const task = await c.make();
    const requested = await ask(c.app.ctx, c.worker.id, task.id, { kind: 'question', text: 'Which currency?' });
    await wakeAll(c.app.ctx, (await answer(c.app.ctx, { personId: c.ceo.id }, requested.request.id, { answer: 'Hana says USD.' })).wakes);
    attributed((await c.notices(c.worker.id))[0]!, 'Ivan', 'answered');
  });

  it('attributes a wrong-goal escalation to the current reviewer', async () => {
    const c = await fixture();
    const task = await c.make();
    await submit(c.app.ctx, c.worker.id, task.id, { summary: 'Implemented.', evidence: 'Tested.', review: { baseCommit: 'a'.repeat(40) } });
    const moved = await verdict(c.app.ctx, c.reviewer.id, task.id, { pass: false, reviewedCommit: 'b'.repeat(40), escalate: true, comment: 'The requested currency behavior is different.' });
    await wakeAll(c.app.ctx, moved.wakes);
    const notice = (await c.notices(c.head.id))[0]!;
    const text = (notice.data as { text: string }).text;
    expect(text).toContain('current stage owner');
    expect(text).not.toContain('opens it again for its executor');
    attributed(notice, 'Rita', 'escalated work');
  });

  it('attributes a comment to its person', async () => {
    const c = await fixture();
    const task = await c.make();
    await wakeAll(c.app.ctx, (await comment(c.app.ctx, { personId: c.ceo.id }, task.id, 'Use USD.')).wakes);
    attributed((await c.notices(c.worker.id))[0]!, 'Ivan', 'commented');
  });

  it('attributes a department report to its head', async () => {
    const c = await fixture();
    const orchestrator = (await c.db.select().from(agents)).find(a => a.kind === 'orchestrator')!;
    const task = (await createTask(c.app.ctx, { agentId: orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id })).task;
    const moved = await report(c.app.ctx, c.head.id, task.id, { done: true, summary: 'Shipped.', ...(await recorded(c.app.ctx, task.id, c.head.id)) });
    await wakeAll(c.app.ctx, moved.wakes);
    attributed((await c.notices(orchestrator.id))[0]!, 'Hana', 'reported work done');
  });
});


describe('one report per recipient', () => {
  it('combines reports for two tasks and a direct copy, with one report body and all senders', async () => {
    const c = await fixture();
    const orchestrator = (await c.db.select().from(agents)).find(a => a.kind === 'orchestrator')!;
    const make = async () => (await createTask(c.app.ctx, { agentId: orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id })).task;
    const first = await make();
    const second = await make();
    for (const task of [first, second]) await wakeAll(c.app.ctx, (await report(c.app.ctx, c.head.id, task.id, { done: true, summary: 'Release verified.', ...(await recorded(c.app.ctx, task.id, c.head.id)) })).wakes);
    await enqueueTurn(c.app.ctx, { companyId: first.companyId, agentId: orchestrator.id, prompt: 'Release verified.', createdBy: null, message: { personId: null, text: 'Release verified.', from: 'agent', by: c.worker.id } });
    const notices = await c.notices(orchestrator.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message?.notification?.tasks.map(t => t.number)).toEqual([first.number, second.number]);
    expect(notices[0]!.message?.senders?.map(p => p.name)).toEqual(['Hana', 'Bruno']);
    expect((notices[0]!.data as { text: string }).text.match(/Release verified\./g)).toHaveLength(1);
    const text = (notices[0]!.data as { text: string }).text;
    expect(text).toContain(`Hana reported work done on #${first.number}`);
    expect(text).toContain(`Hana reported work done on #${second.number}`);
    expect(notices[0]!.message!.revision).toBe(2);
    const [queued] = await c.db.select().from(jobs).where(eq(jobs.id, notices[0]!.jobId!));
    expect(queued!.notBefore).toBeNull();
    expect((await listEvents(c.db, c.head.id, 0)).filter(e => e.message?.direction === 'out')).toEqual([]);
  });
  it('keeps different reports separate', async () => {
    const c = await fixture();
    const orchestrator = (await c.db.select().from(agents)).find(a => a.kind === 'orchestrator')!;
    for (const summary of ['Release verified.', 'A second report.']) {
      const task = (await createTask(c.app.ctx, { agentId: orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id })).task;
      await wakeAll(c.app.ctx, (await report(c.app.ctx, c.head.id, task.id, { done: true, summary, ...(await recorded(c.app.ctx, task.id, c.head.id)) })).wakes);
    }
    expect(await c.notices(orchestrator.id)).toHaveLength(2);
  });
});


describe('report window boundaries', () => {
  it('delivers a person immediately while a report waits, without advancing the clock', async () => {
    const c = await fixture();
    const orchestrator = (await c.db.select().from(agents)).find(a => a.kind === 'orchestrator')!;
    const [run] = await c.db.insert(jobs).values({ companyId: orchestrator.companyId, subscriptionId: orchestrator.subscriptionId!, agentId: orchestrator.id, kind: 'conversation', prompt: 'Working.', status: 'running', timeoutMs: 1000 }).returning();
    vi.spyOn(c.app.ctx.hub, 'hasTerminals').mockReturnValue(true);
    vi.spyOn(c.app.ctx.hub, 'send').mockImplementation((_node, message) => {
      if (message.type === 'agent.say') queueMicrotask(() => said(c.app.ctx, BUILTIN, message.ref, true));
      return true;
    });
    const task = (await createTask(c.app.ctx, { agentId: orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id })).task;
    await wakeAll(c.app.ctx, (await report(c.app.ctx, c.head.id, task.id, { done: true, summary: 'Shipped.', ...(await recorded(c.app.ctx, task.id, c.head.id)) })).wakes);
    expect((await c.db.select().from(jobs).where(eq(jobs.taskId, task.id)))[0]!.notBefore!.getTime()).toBeGreaterThan(Date.now());
    const delivered = await enqueueTurn(c.app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, prompt: 'New instruction.', createdBy: c.ceo.id, message: { personId: c.ceo.id, text: 'New instruction.' } });
    expect(delivered).toBe(run!.id);
    expect((await c.notices(orchestrator.id)).find(e => e.message?.from.kind === 'person')!.jobId).toBe(run!.id);
    vi.restoreAllMocks();
  });
});


it('does not describe a blocked department report as done', async () => {
  const c = await fixture();
  const orchestrator = (await c.db.select().from(agents)).find(a => a.kind === 'orchestrator')!;
  const task = (await createTask(c.app.ctx, { agentId: orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id })).task;
  await wakeAll(c.app.ctx, (await report(c.app.ctx, c.head.id, task.id, { done: false, summary: 'Waiting for access.' })).wakes);
  const text = (await c.notices(orchestrator.id))[0]!.data as { text: string };
  expect(text.text).toContain('Hana reported blocked work');
  expect(text.text).not.toContain('reported work done');
});


it('combines a queued direct copy that arrived before the service report', async () => {
  const c = await fixture();
  const orchestrator = (await c.db.select().from(agents)).find(a => a.kind === 'orchestrator')!;
  await enqueueTurn(c.app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, createdBy: null, prompt: 'Release verified.', message: { personId: null, from: 'agent', by: c.head.id, text: 'Release verified.' } });
  const task = (await createTask(c.app.ctx, { agentId: orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id })).task;
  await wakeAll(c.app.ctx, (await report(c.app.ctx, c.head.id, task.id, { done: true, summary: 'Release verified.', ...(await recorded(c.app.ctx, task.id, c.head.id)) })).wakes);
  const notices = await c.notices(orchestrator.id);
  expect(notices).toHaveLength(1);
  expect(notices[0]!.message!.notification!.tasks).toEqual([{ id: task.id, number: task.number }]);
});


it('keeps an ordinary Review finding with its current owner and sends no author return', async () => {
  const c = await fixture();
  const task = await c.make();
  await submit(c.app.ctx, c.worker.id, task.id, { summary: 'Implemented.', evidence: 'Tests passed.', review: { baseCommit: 'a'.repeat(40) } });
  const moved = await verdict(c.app.ctx, c.reviewer.id, task.id, { pass: false, reviewedCommit: 'b'.repeat(40), comment: 'I will repair validation.' });
  expect(moved.task).toMatchObject({ status: 'working', assigneeAgentId: c.reviewer.id });
  expect(moved.wakes).toEqual([]);
  expect(await c.notices(c.worker.id)).toEqual([]);
});


it('delivers an employee copy into the live turn immediately, combining the queued notice', async () => {
  const c = await fixture();
  const orchestrator = (await c.db.select().from(agents)).find(a => a.kind === 'orchestrator')!;
  const [run] = await c.db.insert(jobs).values({ companyId: orchestrator.companyId, subscriptionId: orchestrator.subscriptionId!, agentId: orchestrator.id, kind: 'conversation', prompt: 'Working.', status: 'running', timeoutMs: 1000 }).returning();
  const task = (await createTask(c.app.ctx, { agentId: orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id })).task;
  await wakeAll(c.app.ctx, (await report(c.app.ctx, c.head.id, task.id, { done: true, summary: 'Release verified.', ...(await recorded(c.app.ctx, task.id, c.head.id)) })).wakes);
  await appendEvent(c.app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, jobId: run!.id, kind: 'message', personId: c.ceo.id, data: { text: 'A newer personal instruction.' } });
  expect((await decisionPrincipal(c.db, run!.id))!.personId).toBe(c.ceo.id);
  const saidTexts: string[] = [];
  vi.spyOn(c.app.ctx.hub, 'hasTerminals').mockReturnValue(true);
  vi.spyOn(c.app.ctx.hub, 'send').mockImplementation((_node, message) => {
    if (message.type === 'agent.say') { saidTexts.push(message.text); queueMicrotask(() => said(c.app.ctx, BUILTIN, message.ref, true)); }
    return true;
  });
  const into = await enqueueTurn(c.app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, createdBy: null, prompt: 'Release verified.', message: { personId: null, from: 'agent', by: c.worker.id, text: 'Release verified.' } });
  expect(into).toBe(run!.id);
  expect(saidTexts).toHaveLength(1);
  expect(saidTexts[0]).toContain('Hana');
  expect(saidTexts[0]).toContain('Bruno');
  expect(saidTexts[0]).toContain('via Hornhoof');
  expect((await c.notices(orchestrator.id)).filter(e => e.message!.from.kind !== 'person')).toHaveLength(1);
  expect(await decisionPrincipal(c.db, run!.id)).toEqual({ personId: c.ceo.id, sourceSeq: null });
  vi.restoreAllMocks();
});

it('keeps the same report separate after its ten second window', async () => {
  const c = await fixture();
  const orchestrator = (await c.db.select().from(agents)).find(a => a.kind === 'orchestrator')!;
  for (const index of [0, 1]) {
    const task = (await createTask(c.app.ctx, { agentId: orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id })).task;
    await wakeAll(c.app.ctx, (await report(c.app.ctx, c.head.id, task.id, { done: true, summary: 'Release verified.', ...(await recorded(c.app.ctx, task.id, c.head.id)) })).wakes);
    if (index === 0) await c.db.update(agentEvents).set({ createdAt: new Date(Date.now() - 11_000) }).where(eq(agentEvents.agentId, orchestrator.id));
  }
  expect(await c.notices(orchestrator.id)).toHaveLength(2);
});


it('names the wait timer, its recorded setter and deadline without inventing an action author', async () => {
  const c = await fixture();
  const task = await c.make();
  const now = Date.now();
  const until = new Date(now + 1000).toISOString();
  await waitFor(c.app.ctx, c.worker.id, task.id, { reason: 'Image build', until });
  await checkExternalWaits(c.app.ctx, new Date(now + 2000));
  const notice = (await c.notices(c.worker.id)).find(e => e.message!.notification!.source === 'wait_ended')!;
  expect(messageHeading(notice.message!)).toContain(`wait timer on #${task.number} (set by Bruno, until ${until})`);
  expect(notice.message!.from.kind).toBe('hornhoof');
});

it('retains two different reports on the same task while combining a repeated one', async () => {
  const c = await fixture();
  const orchestrator = (await c.db.select().from(agents)).find(a => a.kind === 'orchestrator')!;
  const task = (await createTask(c.app.ctx, { agentId: orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id })).task;
  for (const summary of ['Waiting for access.', 'Waiting for a machine.', 'Waiting for access.']) {
    await wakeAll(c.app.ctx, (await report(c.app.ctx, c.head.id, task.id, { done: false, summary })).wakes);
  }
  const notices = await c.notices(orchestrator.id);
  expect(notices).toHaveLength(2);
  const texts = notices.map(e => (e.data as { text: string }).text);
  expect(texts.filter(t => t.includes('Waiting for access.'))).toHaveLength(1);
  expect(texts.filter(t => t.includes('Waiting for a machine.'))).toHaveLength(1);
});


it('preserves different pending reports across recovery and acknowledges only the delivered action', async () => {
  const c = await fixture();
  const orchestrator = (await c.db.select().from(agents)).find(a => a.kind === 'orchestrator')!;
  const task = (await createTask(c.app.ctx, { agentId: orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id })).task;
  const first = await report(c.app.ctx, c.head.id, task.id, { done: false, summary: 'Waiting for access.' });
  await report(c.app.ctx, c.head.id, task.id, { done: false, summary: 'Waiting for a machine.' });
  const before = new Date(Date.now() + 60_000);
  expect((await wakesLeft(c.db, before)).filter(w => w.cause?.report)).toHaveLength(2);
  await wakeQueued(c.db, first.wakes[0]!);
  const left = (await wakesLeft(c.db, before)).filter(w => w.cause?.report);
  expect(left).toHaveLength(1);
  expect(left[0]!.cause!.report).toBe('Waiting for a machine.');
  await wakeAll(c.app.ctx, left);
  const notices = await c.notices(orchestrator.id);
  expect(notices).toHaveLength(1);
  expect((notices[0]!.data as { text: string }).text).toContain('Waiting for a machine.');
});

it('keeps other queued words when a direct report is combined and delivered live', async () => {
  const c = await fixture();
  const orchestrator = (await c.db.select().from(agents)).find(a => a.kind === 'orchestrator')!;
  const id = await enqueueTurn(c.app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, createdBy: null, prompt: 'Hana wrote:\n\n> Release verified.', message: { personId: null, from: 'agent', by: c.head.id, text: 'Release verified.' } });
  await appendEvent(c.app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, jobId: id, kind: 'message', personId: c.ceo.id, data: { text: 'Keep the separate instruction.' } });
  await c.db.update(jobs).set({ prompt: 'Hana wrote:\n\n> Release verified.\n\nIvan commented: Keep the separate instruction.' }).where(eq(jobs.id, id));
  const task = (await createTask(c.app.ctx, { agentId: orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id })).task;
  await wakeAll(c.app.ctx, (await report(c.app.ctx, c.head.id, task.id, { done: true, summary: 'Release verified.', ...(await recorded(c.app.ctx, task.id, c.head.id)) })).wakes);
  expect((await c.db.select().from(jobs).where(eq(jobs.id, id)))[0]!.prompt).toContain('Keep the separate instruction.');
  const [run] = await c.db.insert(jobs).values({ companyId: orchestrator.companyId, subscriptionId: orchestrator.subscriptionId!, agentId: orchestrator.id, kind: 'conversation', prompt: 'Working.', status: 'running', timeoutMs: 1000 }).returning();
  const spoken: string[] = [];
  vi.spyOn(c.app.ctx.hub, 'hasTerminals').mockReturnValue(true);
  vi.spyOn(c.app.ctx.hub, 'send').mockImplementation((_node, message) => {
    if (message.type === 'agent.say') { spoken.push(message.text); queueMicrotask(() => said(c.app.ctx, BUILTIN, message.ref, true)); }
    return true;
  });
  await enqueueTurn(c.app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, createdBy: null, prompt: 'Release verified.', message: { personId: null, from: 'agent', by: c.worker.id, text: 'Release verified.' } });
  expect(spoken[0]).toContain('Keep the separate instruction.');
  expect(spoken[0]!.match(/Release verified\./g)).toHaveLength(1);
  expect(await wordsForTurn(c.app.ctx, orchestrator.id, run!.id, spoken[0])).toHaveLength(1);
  expect(await wordsForTurn(c.app.ctx, orchestrator.id, run!.id)).toHaveLength(1);
  vi.restoreAllMocks();
});

async function deliveredReport() {
  const c = await fixture();
  const orchestrator = (await c.db.select().from(agents)).find(a => a.kind === 'orchestrator')!;
  const make = async () => (await createTask(c.app.ctx, { agentId: orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id })).task;
  const first = await make();
  const second = await make();
  const [run] = await c.db.insert(jobs).values({ companyId: orchestrator.companyId, subscriptionId: orchestrator.subscriptionId!, agentId: orchestrator.id, kind: 'conversation', prompt: 'Working.', status: 'running', timeoutMs: 1000, startedAt: new Date() }).returning();
  const spoken: string[] = [];
  vi.spyOn(c.app.ctx.hub, 'hasTerminals').mockReturnValue(true);
  vi.spyOn(c.app.ctx.hub, 'send').mockImplementation((_node, message) => {
    if (message.type === 'agent.say') { spoken.push(message.text); queueMicrotask(() => said(c.app.ctx, BUILTIN, message.ref, true)); }
    return true;
  });
  const text = `Release verified on #${first.number}.`;
  await enqueueTurn(c.app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, createdBy: null, prompt: text, message: { personId: null, from: 'agent', by: c.worker.id, text } });
  return { ...c, orchestrator, first, second, run: run!, text, spoken };
}

it('updates a delivered copy for known tasks without another input or changing the person it answers', async () => {
  const c = await deliveredReport();
  const original = (await c.notices(c.orchestrator.id))[0]!;
  await appendEvent(c.app.ctx, { companyId: c.orchestrator.companyId, agentId: c.orchestrator.id, jobId: c.run.id, kind: 'message', personId: c.ceo.id, data: { text: 'A newer personal instruction.' } });
  await wakeAll(c.app.ctx, (await report(c.app.ctx, c.head.id, c.first.id, { done: true, summary: c.text, ...(await recorded(c.app.ctx, c.first.id, c.head.id)) })).wakes);
  await enqueueTurn(c.app.ctx, { companyId: c.orchestrator.companyId, agentId: c.orchestrator.id, createdBy: null, prompt: c.text, message: { personId: null, from: 'agent', by: c.worker.id, text: c.text, task: { id: c.first.id, number: c.first.number } } });
  const notices = (await c.notices(c.orchestrator.id)).filter(e => e.message!.from.kind !== 'person');
  expect(notices).toHaveLength(1);
  expect(notices[0]!.message!.notification!.tasks).toEqual([{ id: c.first.id, number: c.first.number }]);
  expect(notices[0]!.message!.senders!.map(p => p.name)).toEqual(['Bruno', 'Hana']);
  expect(notices[0]!.message!.originSeq).toBe(original.seq);
  expect(notices[0]!.message!.revision).toBe(2);
  expect(notices[0]!.seq).toBeGreaterThan(original.seq);
  expect(c.spoken).toHaveLength(1);
  expect((await decisionPrincipal(c.db, c.run.id))!.personId).toBe(c.ceo.id);
  expect(await wordsForTurn(c.app.ctx, c.orchestrator.id, c.run.id, c.spoken[0])).toHaveLength(1);
  expect(await wordsForTurn(c.app.ctx, c.orchestrator.id, c.run.id)).toHaveLength(2);
  vi.restoreAllMocks();
});

it.each(['different text', 'new task'] as const)('delivers %s even after a similar report was delivered', async difference => {
  const c = await deliveredReport();
  const task = difference === 'new task' ? c.second : c.first;
  const text = difference === 'different text' ? 'A different report.' : c.text;
  await wakeAll(c.app.ctx, (await report(c.app.ctx, c.head.id, task.id, { done: true, summary: text, ...(await recorded(c.app.ctx, task.id, c.head.id)) })).wakes);
  const notices = await c.notices(c.orchestrator.id);
  expect(notices).toHaveLength(2);
  expect((notices[1]!.data as { text: string }).text).toContain(text);
  expect(notices[1]!.message!.notification!.tasks).toContainEqual({ id: task.id, number: task.number });
  vi.restoreAllMocks();
});
