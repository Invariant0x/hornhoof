import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { agents, companies, departments, people, requests, subscriptions, taskEvents, tasks } from '../src/db/schema.js';
import { answer, blocked, cancel, comment, createTask, leaveWork, report, submit, updateTask, verdict } from '../src/modules/tasks/engine.js';
import { wakePrompt } from '../src/modules/tasks/wake.js';
import { askedOfPerson, setUpCompany, testApp } from './helpers.js';

async function company() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [sub] = await db.select().from(subscriptions);
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const rita = await hire('Rita', 'worker', 'DEV-REV');
  const tess = await hire('Tess', 'worker', 'DEV-TEST');
  const ctx = app.ctx;
  const CEO = { personId: ceo!.id };
  /* A department task from the CEO, and a member task the head made from it. */
  const deptTask = async () => (await createTask(ctx, CEO, { title: 'Payments', brief: 'Take card payments.', body: 'Stripe checkout.', departmentId: dev!.id, assigneeAgentId: head.id })).task;
  const memberTask = async (gates = [rita.id, tess.id]) => {
    const parent = await deptTask();
    return (await createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: 'The API.', body: 'POST /checkout.', departmentId: dev!.id, parentId: parent.id, assigneeAgentId: bruno.id, executor: true, gates })).task;
  };
  const read = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
  return { ctx, db, CEO, orchestrator: orchestrator!, dev: dev!, head, bruno, rita, tess, deptTask, memberTask, read };
}

const reason = (p: Promise<unknown>) => p.then(() => 'ok', (err: { reason?: string }) => err.reason);
const woken = (r: { wakes: { agentId: string; why: string }[] }) => r.wakes.map(w => [w.agentId, w.why]);

describe('the task engine', () => {
  it('keeps a blocked task with its giver after its executor leaves, even when the giver comments', async () => {
    const { ctx, CEO, head, bruno, memberTask, read } = await company();
    const task = await memberTask();
    await blocked(ctx, bruno.id, task.id, 'Which currency?');
    await leaveWork(ctx, CEO, bruno);
    expect(await read(task.id)).toMatchObject({ status: 'blocked', assigneeAgentId: head.id, executorAgentId: bruno.id });
    const result = await comment(ctx, { agentId: head.id }, task.id, 'The next executor will use euros.');
    expect(result.wakes).toEqual([]);
    expect(await read(task.id)).toMatchObject({ status: 'blocked', assigneeAgentId: head.id, executorAgentId: bruno.id });
  });

  it('opens a blocked member task again when whoever gave it out answers in a comment, and wakes its executor with it', async () => {
    const { ctx, db, orchestrator, head, bruno, rita, memberTask, read } = await company();
    const task = await memberTask();
    await blocked(ctx, bruno.id, task.id, 'Which currency?');
    const aside = await comment(ctx, { agentId: rita.id }, task.id, 'I would ask too.');
    expect([aside.wakes, (await read(task.id)).status]).toEqual([[], 'blocked']);
    const answered = await comment(ctx, { agentId: head.id }, task.id, 'Euros only.');
    expect(answered.task).toMatchObject({ status: 'open', assigneeAgentId: bruno.id, silent: 0 });
    const log = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id)).orderBy(taskEvents.id);
    expect(log.at(-1)).toMatchObject({ kind: 'comment', agentId: head.id, text: 'Euros only.' });
    expect(answered.wakes).toEqual([{
      agentId: bruno.id, taskId: task.id, why: 'unblocked', text: 'Euros only.',
      cause: { actor: { agentId: head.id }, action: 'commented', eventId: log.at(-1)!.id, task: { id: task.id, number: task.number } },
    }]);
    const [me] = await db.select().from(agents).where(eq(agents.id, bruno.id));
    const prompt = wakePrompt(me!, answered.task, answered.wakes[0]!);
    expect(prompt).toContain('answered what blocked it');
    expect(prompt).toContain('Euros only.');
    expect(prompt).toContain('blocked');
    const [hana] = await db.select().from(agents).where(eq(agents.id, head.id));
    const stopped = await blocked(ctx, bruno.id, task.id, 'And the rounding?');
    expect(wakePrompt(hana!, stopped.task, stopped.wakes[0]!)).toContain('Answer it with comment, which opens it again for its executor');
    const resumed = await comment(ctx, { agentId: orchestrator.id }, task.id, 'Round half up.');
    expect(resumed.task).toMatchObject({ status: 'open', assigneeAgentId: bruno.id });
    expect(woken(resumed)).toEqual([[bruno.id, 'unblocked']]);
    expect(woken(await comment(ctx, { agentId: head.id }, task.id, 'Thanks.'))).toEqual([[bruno.id, 'comment']]);
    expect(woken(await comment(ctx, { agentId: bruno.id }, task.id, 'Understood.'))).toEqual([]);
  });

  it('delivers a person comment to the blocked executor without opening the task', async () => {
    const { ctx, db, CEO, bruno, memberTask, read } = await company();
    const task = await memberTask();
    await blocked(ctx, bruno.id, task.id, 'Which currency?');
    const result = await comment(ctx, CEO, task.id, 'Check the accounting notes.');
    expect(result.task).toMatchObject({ status: 'blocked', assigneeAgentId: bruno.id });
    expect(await read(task.id)).toMatchObject({ status: 'blocked', assigneeAgentId: bruno.id });
    const log = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id)).orderBy(taskEvents.id);
    expect(log.at(-1)).toMatchObject({ kind: 'comment', personId: CEO.personId, text: 'Check the accounting notes.' });
    expect(result.wakes).toEqual([{
      agentId: bruno.id, taskId: task.id, why: 'comment', text: 'Check the accounting notes.',
      cause: { actor: CEO, action: 'commented', eventId: log.at(-1)!.id, task: { id: task.id, number: task.number } },
    }]);
  });

  it("gives a person's task to the department head and wakes the head", async () => {
    const { ctx, db, CEO, dev, head } = await company();
    const res = await createTask(ctx, CEO, { title: 'Payments', brief: 'Take card payments.', body: 'Stripe checkout.', departmentId: dev.id, assigneeAgentId: head.id });
    expect(res.task).toMatchObject({ number: 1, status: 'open', assigneeAgentId: head.id, createdByPersonId: CEO.personId, departmentId: dev.id });
    expect(woken(res)).toEqual([[head.id, 'assigned']]);
    const log = await db.select().from(taskEvents).where(eq(taskEvents.taskId, res.task.id));
    expect(log.map(e => [e.kind, e.personId])).toEqual([['created', CEO.personId]]);
    expect((await createTask(ctx, CEO, { title: 'Next', brief: '', body: '', departmentId: dev.id, assigneeAgentId: head.id })).task.number).toBe(2);
  });

  it('takes a member task through its gates in order and tells the head when it is done', async () => {
    const { ctx, head, bruno, rita, tess, memberTask, read } = await company();
    const task = await memberTask();
    expect(task).toMatchObject({ executorAgentId: bruno.id, assigneeAgentId: bruno.id, gates: [rita.id, tess.id], stage: 0 });
    const sent = await submit(ctx, bruno.id, task.id, { summary: 'Done.', evidence: 'npm test: 12 passed' });
    expect(sent.task).toMatchObject({ status: 'review', stage: 1, assigneeAgentId: rita.id });
    expect(woken(sent)).toEqual([[rita.id, 'review']]);
    const first = await verdict(ctx, rita.id, task.id, { pass: true, comment: 'Clean diff.' });
    expect(first.task).toMatchObject({ status: 'review', stage: 2, assigneeAgentId: tess.id });
    expect(woken(first)).toEqual([[tess.id, 'review']]);
    const last = await verdict(ctx, tess.id, task.id, { pass: true, comment: 'Tests cover it.' });
    expect(last.task).toMatchObject({ status: 'done', assigneeAgentId: null });
    expect((await read(task.id)).closedAt).not.toBeNull();
    /* It was the last work under the department task, which the head hears of once. */
    expect(woken(last)).toEqual([[head.id, 'subtasks']]);
  });

  it('sends changes back to the executor, and the third send-back at one gate also wakes the head', async () => {
    const { ctx, head, bruno, rita, memberTask } = await company();
    const task = await memberTask([rita.id]);
    const round = async () => {
      await submit(ctx, bruno.id, task.id, { summary: 'Done.', evidence: 'npm test' });
      return verdict(ctx, rita.id, task.id, { pass: false, comment: 'Missing a test for refunds.' });
    };
    const once = await round();
    expect(once.task).toMatchObject({ status: 'open', stage: 0, assigneeAgentId: bruno.id, bounces: 1 });
    expect(woken(once)).toEqual([[bruno.id, 'changes']]);
    await round();
    expect(woken(await round())).toEqual([
      [bruno.id, 'changes'],
      [head.id, 'stuck_at_gate'],
    ]);
  });

  it('never lets the executor pass its own gate', async () => {
    const { ctx, bruno, rita, memberTask } = await company();
    expect(await reason(memberTask([rita.id, bruno.id]))).toBe('task_invalid');
    const task = await memberTask([rita.id]);
    await submit(ctx, bruno.id, task.id, { summary: 'Done.', evidence: 'npm test' });
    expect(await reason(verdict(ctx, bruno.id, task.id, { pass: true, comment: 'Looks good to me.' }))).toBe('task_not_yours');
  });

  it('refuses a verdict without a comment or from a gate that is not at its stage', async () => {
    const { ctx, bruno, rita, tess, memberTask, read } = await company();
    const task = await memberTask();
    await submit(ctx, bruno.id, task.id, { summary: 'Done.', evidence: 'npm test' });
    expect(await reason(verdict(ctx, tess.id, task.id, { pass: true, comment: 'Fine.' }))).toBe('task_not_yours');
    expect(await reason(verdict(ctx, rita.id, task.id, { pass: true, comment: '  ' }))).toBe('task_invalid');
    expect(await read(task.id)).toMatchObject({ stage: 1, status: 'review' });
  });

  it('refuses to cancel a finished task', async () => {
    const { ctx, CEO, bruno, memberTask } = await company();
    const task = await memberTask([]);
    expect((await submit(ctx, bruno.id, task.id, { summary: 'Done.', evidence: 'npm test' })).task.status).toBe('done');
    expect(await reason(cancel(ctx, CEO, task.id, 'Not needed.'))).toBe('task_closed');
  });

  it('lets only one of two moves that read the same task land', async () => {
    const { ctx, CEO, bruno, rita, memberTask, read } = await company();
    const task = await memberTask();
    await submit(ctx, bruno.id, task.id, { summary: 'Done.', evidence: 'npm test' });
    const both = await Promise.allSettled([verdict(ctx, rita.id, task.id, { pass: true, comment: 'Clean.' }), cancel(ctx, CEO, task.id, 'Dropped.')]);
    expect(both.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((both.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.reason).toBe('task_changed');
    expect(['review', 'cancelled']).toContain((await read(task.id)).status);
  });

  it('tells whoever gave a department task when its head reports, and asks the orchestrator when a head is blocked on theirs', async () => {
    const { ctx, db, orchestrator, dev, head, deptTask } = await company();
    const given = await createTask(ctx, { agentId: orchestrator.id }, { title: 'Pricing page', brief: '', body: '', departmentId: dev.id, assigneeAgentId: head.id });
    const done = await report(ctx, head.id, given.task.id, { done: true, summary: 'Shipped behind a flag.' });
    expect(done.task.status).toBe('done');
    expect(woken(done)).toEqual([[orchestrator.id, 'reported']]);
    const mine = await deptTask();
    const stuck = await report(ctx, head.id, mine.id, { done: false, summary: 'Need a Stripe account.' });
    expect(stuck.task.status).toBe('waiting');
    expect(woken(stuck)).toEqual([[orchestrator.id, 'question']]);
    expect(await db.select({ kind: requests.kind, text: requests.text, status: requests.status }).from(requests)).toEqual([{ kind: 'stuck', text: 'Need a Stripe account.', status: 'open' }]);
  });

  it('lets a blocked executor wait for its head', async () => {
    const { ctx, head, bruno, memberTask } = await company();
    const task = await memberTask();
    const res = await blocked(ctx, bruno.id, task.id, 'The API key is missing.');
    expect(res.task).toMatchObject({ status: 'blocked', assigneeAgentId: bruno.id });
    expect(woken(res)).toEqual([[head.id, 'blocked']]);
  });

  it('waits for a person and wakes the agent with the answer', async () => {
    const { ctx, db, CEO, bruno, memberTask, read } = await company();
    const task = await memberTask();
    const asked = await askedOfPerson(ctx, bruno.id, task.id, { kind: 'question', text: 'Which currency?' });
    expect((await read(task.id)).status).toBe('waiting');
    const answered = await answer(ctx, CEO, asked.request.id, { answer: 'EUR' });
    expect(answered.request).toMatchObject({ status: 'answered', answer: 'EUR', answeredBy: CEO.personId });
    expect((await read(task.id)).status).toBe('working');
    expect(woken(answered)).toEqual([[bruno.id, 'answered']]);
    expect(await reason(askedOfPerson(ctx, bruno.id, task.id, { kind: 'approval', text: 'Release?', commit: 'abc' }))).toBe('task_invalid');
    const approval = await askedOfPerson(ctx, bruno.id, task.id, { kind: 'approval', text: 'Release 0.5.0?', commit: 'a'.repeat(40) });
    expect(await reason(answer(ctx, CEO, approval.request.id, { answer: 'yes' }))).toBe('task_invalid');
    expect((await answer(ctx, CEO, approval.request.id, { approve: true })).request.status).toBe('approved');
    expect(await reason(answer(ctx, CEO, approval.request.id, { approve: false }))).toBe('request_closed');
  });

  it('leaves a task that closed while a person answered it closed', async () => {
    const { ctx, db, CEO, bruno, memberTask, read } = await company();
    const task = await memberTask();
    const asked = await askedOfPerson(ctx, bruno.id, task.id, { kind: 'question', text: 'Which currency?' });
    /* The task is cancelled after the answer read it and before the answer is written. */
    const begin = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce(async (fn, config) => {
      await db.update(tasks).set({ status: 'cancelled', closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, task.id));
      return begin(fn, config);
    });
    const answered = await answer(ctx, CEO, asked.request.id, { answer: 'EUR' });
    expect((await read(task.id)).status).toBe('cancelled');
    expect(answered.wakes).toEqual([]);
  });

  it('gives no subtask under a task cancelled while it was being made', async () => {
    const { ctx, db, dev, head, bruno, deptTask } = await company();
    const parent = await deptTask();
    const begin = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce(async (fn, config) => {
      await db.update(tasks).set({ status: 'cancelled', closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, parent.id));
      return begin(fn, config);
    });
    const made = createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: '', body: '', departmentId: dev.id, parentId: parent.id, assigneeAgentId: bruno.id, executor: true });
    expect(await reason(made)).toBe('task_closed');
    expect((await db.select().from(tasks)).map(t => t.id)).toEqual([parent.id]);
  });

  it('keeps a task open while a subtask under it is open', async () => {
    const { ctx, head, memberTask, read } = await company();
    const child = await memberTask([]);
    expect(await reason(report(ctx, head.id, child.parentId!, { done: true, summary: 'All done.' }))).toBe('task_invalid');
    expect((await read(child.parentId!)).status).toBe('open');
  });

  it('takes no work in while work under it is open, and tells its executor once that work is done', async () => {
    const { ctx, db, dev, head, bruno, tess, memberTask, read } = await company();
    const task = await memberTask([]);
    const { task: under } = await createTask(ctx, { agentId: head.id }, { title: 'Refunds', brief: '', body: 'POST /refunds.', departmentId: dev.id, parentId: task.id, assigneeAgentId: tess.id, executor: true, gates: [] });
    expect(await reason(submit(ctx, bruno.id, task.id, { summary: 'Done.', evidence: 'npm test: 12 passed' }))).toBe('task_invalid');
    expect((await read(task.id)).status).toBe('open');
    const finished = await submit(ctx, tess.id, under.id, { summary: 'Done.', evidence: 'npm test: 3 passed' });
    const log = await db.select().from(taskEvents).where(eq(taskEvents.taskId, under.id)).orderBy(taskEvents.id);
    expect(log.at(-1)).toMatchObject({ kind: 'submitted', agentId: tess.id, text: 'Done.' });
    expect(finished.wakes).toContainEqual({
      agentId: bruno.id, taskId: task.id, why: 'subtasks',
      cause: { actor: { agentId: tess.id }, action: 'handed in work', eventId: log.at(-1)!.id, task: { id: under.id, number: under.number }, report: 'Done.' },
    });
    expect((await submit(ctx, bruno.id, task.id, { summary: 'Done.', evidence: 'npm test: 12 passed' })).task.status).toBe('done');
  });

  it('gives no work under a task that is at its gates', async () => {
    const { ctx, dev, head, bruno, tess, memberTask } = await company();
    const task = await memberTask([tess.id]);
    await submit(ctx, bruno.id, task.id, { summary: 'Done.', evidence: 'npm test: 12 passed' });
    const made = createTask(ctx, { agentId: head.id }, { title: 'Refunds', brief: '', body: '', departmentId: dev.id, parentId: task.id, assigneeAgentId: bruno.id, executor: true, gates: [] });
    expect(await reason(made)).toBe('task_invalid');
  });

  it('checks a gate with whoever of its role can, leaving out one that is on without a subscription', async () => {
    const { ctx, db, dev, bruno, rita, memberTask } = await company();
    await db.insert(agents).values({ companyId: dev.companyId, kind: 'worker', name: 'Rex', roleKey: 'DEV-REV', departmentId: dev.id, model: '', subscriptionId: null });
    const task = await memberTask([rita.id]);
    const sent = await submit(ctx, bruno.id, task.id, { summary: 'Done.', evidence: 'npm test: 12 passed' });
    expect(sent.task).toMatchObject({ status: 'review', stage: 1, panel: [rita.id], assigneeAgentId: rita.id });
    const log = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id)).orderBy(taskEvents.id);
    expect(log.at(-1)).toMatchObject({ kind: 'submitted', agentId: bruno.id, text: 'Done.' });
    expect(sent.wakes).toEqual([{
      agentId: rita.id, taskId: task.id, why: 'review',
      cause: { actor: { agentId: bruno.id }, action: 'handed in work', eventId: log.at(-1)!.id, task: { id: task.id, number: task.number }, report: 'Done.' },
    }]);
  });

  it('declines a commit: the request closes, the task goes on and the agent hears why', async () => {
    const { ctx, db, CEO, bruno, memberTask, read } = await company();
    const task = await memberTask();
    const commit = 'b'.repeat(40);
    const approval = await askedOfPerson(ctx, bruno.id, task.id, { kind: 'approval', text: 'Merge the checkout?', commit });
    expect((await read(task.id)).status).toBe('waiting');
    const declined = await answer(ctx, CEO, approval.request.id, { approve: false, answer: 'Refunds first.' });
    expect(declined.request).toMatchObject({ status: 'declined', answer: 'Refunds first.', answeredBy: CEO.personId });
    expect((await read(task.id)).status).toBe('working');
    const log = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id)).orderBy(taskEvents.id);
    expect(declined.wakes).toEqual([{
      agentId: bruno.id, taskId: task.id, why: 'answered', text: `Declined ${commit}. Refunds first.`,
      cause: { actor: CEO, action: `declined ${commit}`, eventId: log.at(-1)!.id, task: { id: task.id, number: task.number } },
    }]);
    expect(log.at(-1)).toMatchObject({ kind: 'answered', personId: CEO.personId, text: `Declined ${commit}. Refunds first.` });
    expect(await reason(answer(ctx, CEO, approval.request.id, { approve: true }))).toBe('request_closed');
  });

  it.each(['open', 'working'] as const)('wakes the %s task holder for another author, and skips its own comments', async status => {
    const { ctx, db, CEO, head, bruno, rita, memberTask } = await company();
    const task = await memberTask();
    await db.update(tasks).set({ status }).where(eq(tasks.id, task.id));
    expect(woken(await comment(ctx, CEO, task.id, 'Keep refunds out of this one.'))).toEqual([[bruno.id, 'comment']]);
    expect(woken(await comment(ctx, { agentId: head.id }, task.id, 'Noted.'))).toEqual([[bruno.id, 'comment']]);
    expect(woken(await comment(ctx, { agentId: rita.id }, task.id, 'I can check refunds separately.'))).toEqual([[bruno.id, 'comment']]);
    expect(woken(await comment(ctx, { agentId: bruno.id }, task.id, 'I will leave refunds out.'))).toEqual([]);
  });

  it('wakes the executor when its head rewrites the task', async () => {
    const { ctx, head, bruno, tess, memberTask } = await company();
    const task = await memberTask();
    const res = await updateTask(ctx, head.id, task.id, { body: 'POST /checkout with idempotency keys.' });
    expect(res.task.body).toBe('POST /checkout with idempotency keys.');
    expect(woken(res)).toEqual([[bruno.id, 'updated']]);
    const moved = await updateTask(ctx, head.id, task.id, { executor: tess.id, gates: [] });
    expect(moved.task).toMatchObject({ executorAgentId: tess.id, assigneeAgentId: tess.id, gates: [] });
    expect(woken(moved)).toEqual([[tess.id, 'assigned']]);
  });
});
