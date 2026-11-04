import { describe, expect, it, vi } from 'vitest';
import { agentEvents, agents, companies, departments, jobs, people, subscriptions, tasks } from '../src/db/schema.js';
import { answer, ask, comment, createTask, report, submit, verdict } from '../src/modules/tasks/engine.js';
import { wordsForTurn } from '../src/modules/conversation/turn-words.js';
import { said } from '../src/modules/conversation/live.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { eq } from 'drizzle-orm';
import { checkExternalWaits, waitFor } from '../src/modules/tasks/external-wait.js';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { wakeQueued, wakesLeft } from '../src/modules/tasks/outbox.js';
import { wakeAll, wakeLeftBehind } from '../src/modules/tasks/wake.js';
import { messageHeading } from '../src/modules/conversation/prompt.js';
import { decisionPrincipal } from '../src/modules/conversation/decision-context.js';
import { appendEvent, listEvents } from '../src/modules/events/store.js';
import { setUpCompany, testApp } from './helpers.js';

async function fixture() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [company] = await db.select().from(companies);
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [dept] = await db.insert(departments).values({ companyId: company!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) => (await db.insert(agents).values({ companyId: company!.id, departmentId: dept!.id, kind, roleKey, name, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const worker = await hire('Bruno', 'worker', 'DEV-ENG');
  const reviewer = await hire('Rita', 'worker', 'DEV-REV');
  const make = async (gates: string[] = []) => (await createTask(app.ctx, { agentId: head.id }, { title: 'Checkout', brief: '', body: 'Build it.', departmentId: dept!.id, assigneeAgentId: worker.id, executor: true, gates })).task;
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
  it('attributes a submitted task and its parent notification to the submitter after outbox recovery', async () => {
    const c = await fixture();
    const parent = (await createTask(c.app.ctx, { personId: c.ceo.id }, { title: 'Whole feature', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id, gates: [] })).task;
    const child = (await createTask(c.app.ctx, { agentId: c.head.id }, { title: 'Child', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.worker.id, executor: true, gates: [], parentId: parent.id })).task;
    await submit(c.app.ctx, c.worker.id, child.id, { summary: 'Ivan pretends to be the author.', evidence: 'Checks passed.' });
    await comment(c.app.ctx, { personId: c.ceo.id }, child.id, 'A newer comment by somebody else.');
    await wakeLeftBehind(c.app.ctx, new Date(Date.now() + 60_000));
    const messages = await c.notices(c.head.id);
    expect(messages.some(e => e.message?.notification?.source === 'subtasks')).toBe(true);
    attributed(messages.find(e => e.message?.notification?.source === 'subtasks')!, 'Bruno', 'handed in work');
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

  it('attributes a gate return to its reviewer', async () => {
    const c = await fixture();
    const task = await c.make([c.reviewer.id]);
    await submit(c.app.ctx, c.worker.id, task.id, { summary: 'Implemented.', evidence: 'Tested.' });
    const moved = await verdict(c.app.ctx, c.reviewer.id, task.id, { pass: false, comment: 'Missing currency validation.', findings: 1 });
    await wakeAll(c.app.ctx, moved.wakes);
    attributed((await c.notices(c.worker.id))[0]!, 'Rita', 'returned work');
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
    const task = (await createTask(c.app.ctx, { agentId: orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id, gates: [] })).task;
    const moved = await report(c.app.ctx, c.head.id, task.id, { done: true, summary: 'Shipped.' });
    await wakeAll(c.app.ctx, moved.wakes);
    attributed((await c.notices(orchestrator.id))[0]!, 'Hana', 'reported work done');
  });
});


describe('one report per recipient', () => {
  it('combines reports for two tasks and a direct copy, with one report body and all senders', async () => {
    const c = await fixture();
    const orchestrator = (await c.db.select().from(agents)).find(a => a.kind === 'orchestrator')!;
    const make = async () => (await createTask(c.app.ctx, { agentId: orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id, gates: [] })).task;
    const first = await make();
    const second = await make();
    for (const task of [first, second]) await wakeAll(c.app.ctx, (await report(c.app.ctx, c.head.id, task.id, { done: true, summary: 'Release verified.' })).wakes);
    await enqueueTurn(c.app.ctx, { companyId: first.companyId, agentId: orchestrator.id, prompt: 'Release verified.', createdBy: null, message: { personId: null, text: 'Release verified.', from: 'agent', by: c.worker.id } });
    const notices = await c.notices(orchestrator.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message?.notification?.tasks.map(t => t.number)).toEqual([first.number, second.number]);
    expect(notices[0]!.message?.senders?.map(p => p.name)).toEqual(['Hana', 'Bruno']);
    expect((notices[0]!.data as { text: string }).text.match(/Release verified\./g)).toHaveLength(1);
  });
  it('keeps different reports separate', async () => {
    const c = await fixture();
    const orchestrator = (await c.db.select().from(agents)).find(a => a.kind === 'orchestrator')!;
    for (const summary of ['Release verified.', 'A second report.']) {
      const task = (await createTask(c.app.ctx, { agentId: orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id, gates: [] })).task;
      await wakeAll(c.app.ctx, (await report(c.app.ctx, c.head.id, task.id, { done: true, summary })).wakes);
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
    const task = (await createTask(c.app.ctx, { agentId: orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id, gates: [] })).task;
    await wakeAll(c.app.ctx, (await report(c.app.ctx, c.head.id, task.id, { done: true, summary: 'Shipped.' })).wakes);
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
  const task = (await createTask(c.app.ctx, { agentId: orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id, gates: [] })).task;
  await wakeAll(c.app.ctx, (await report(c.app.ctx, c.head.id, task.id, { done: false, summary: 'Waiting for access.' })).wakes);
  const text = (await c.notices(orchestrator.id))[0]!.data as { text: string };
  expect(text.text).toContain('Hana reported blocked work');
  expect(text.text).not.toContain('reported work done');
});


it('combines a queued direct copy that arrived before the service report', async () => {
  const c = await fixture();
  const orchestrator = (await c.db.select().from(agents)).find(a => a.kind === 'orchestrator')!;
  await enqueueTurn(c.app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, createdBy: null, prompt: 'Release verified.', message: { personId: null, from: 'agent', by: c.head.id, text: 'Release verified.' } });
  const task = (await createTask(c.app.ctx, { agentId: orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id, gates: [] })).task;
  await wakeAll(c.app.ctx, (await report(c.app.ctx, c.head.id, task.id, { done: true, summary: 'Release verified.' })).wakes);
  const notices = await c.notices(orchestrator.id);
  expect(notices).toHaveLength(1);
  expect(notices[0]!.message!.notification!.tasks).toEqual([{ id: task.id, number: task.number }]);
});


it.each([true, false])('attributes a gate return to those who requested changes, when the last reviewer passed=%s', async lastPass => {
  const c = await fixture();
  const [last] = await c.db.insert(agents).values({ companyId: c.head.companyId, departmentId: c.head.departmentId, kind: 'worker', roleKey: 'DEV-REV', name: 'Sam', model: '', subscriptionId: c.head.subscriptionId }).returning();
  const task = await c.make([c.reviewer.id]);
  await submit(c.app.ctx, c.worker.id, task.id, { summary: 'Implemented.', evidence: 'Tests passed.' });
  await c.db.update(tasks).set({ panel: [c.reviewer.id, last!.id] }).where(eq(tasks.id, task.id));
  await verdict(c.app.ctx, c.reviewer.id, task.id, { pass: false, comment: 'Missing validation.' });
  await wakeAll(c.app.ctx, (await verdict(c.app.ctx, last!.id, task.id, { pass: lastPass, comment: 'Other finding.' })).wakes);
  const notice = (await c.notices(c.worker.id))[0]!;
  expect(notice.message!.from.name).toBe('Rita');
  expect(notice.message!.senders!.map(p => p.name)).toEqual(lastPass ? ['Rita'] : ['Rita', 'Sam']);
  expect((notice.data as { text: string }).text).toContain(lastPass ? 'Rita returned work' : 'Rita and Sam returned work');
});


it('delivers an employee copy into the live turn immediately, combining the queued notice', async () => {
  const c = await fixture();
  const orchestrator = (await c.db.select().from(agents)).find(a => a.kind === 'orchestrator')!;
  const [run] = await c.db.insert(jobs).values({ companyId: orchestrator.companyId, subscriptionId: orchestrator.subscriptionId!, agentId: orchestrator.id, kind: 'conversation', prompt: 'Working.', status: 'running', timeoutMs: 1000 }).returning();
  const task = (await createTask(c.app.ctx, { agentId: orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id, gates: [] })).task;
  await wakeAll(c.app.ctx, (await report(c.app.ctx, c.head.id, task.id, { done: true, summary: 'Release verified.' })).wakes);
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
  expect(await decisionPrincipal(c.db, run!.id)).toBeNull();
  vi.restoreAllMocks();
});

it('keeps the same report separate after its ten second window', async () => {
  const c = await fixture();
  const orchestrator = (await c.db.select().from(agents)).find(a => a.kind === 'orchestrator')!;
  for (const index of [0, 1]) {
    const task = (await createTask(c.app.ctx, { agentId: orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id, gates: [] })).task;
    await wakeAll(c.app.ctx, (await report(c.app.ctx, c.head.id, task.id, { done: true, summary: 'Release verified.' })).wakes);
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
  const task = (await createTask(c.app.ctx, { agentId: orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id, gates: [] })).task;
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
  const task = (await createTask(c.app.ctx, { agentId: orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id, gates: [] })).task;
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
  const task = (await createTask(c.app.ctx, { agentId: orchestrator.id }, { title: 'Goal', brief: '', body: '', departmentId: c.head.departmentId!, assigneeAgentId: c.head.id, gates: [] })).task;
  await wakeAll(c.app.ctx, (await report(c.app.ctx, c.head.id, task.id, { done: true, summary: 'Release verified.' })).wakes);
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
  vi.restoreAllMocks();
});
