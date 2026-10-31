import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, people, requests, subscriptions, taskEvents, tasks } from '../src/db/schema.js';
import { answer, ask, blocked, cancel, comment, createTask, report, submit, updateTask, verdict } from '../src/modules/tasks/engine.js';
import { setUpCompany, testApp } from './helpers.js';

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
    expect(woken(last)).toEqual([[head.id, 'done']]);
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

  it('tells whoever gave a department task when its head reports, and asks a person when a head is blocked on theirs, whose question the orchestrator puts into plain words', async () => {
    const { ctx, db, CEO, orchestrator, dev, head, deptTask } = await company();
    const given = await createTask(ctx, { agentId: orchestrator.id }, { title: 'Pricing page', brief: '', body: '', departmentId: dev.id, assigneeAgentId: head.id });
    const done = await report(ctx, head.id, given.task.id, { done: true, summary: 'Shipped behind a flag.' });
    expect(done.task.status).toBe('done');
    expect(woken(done)).toEqual([[orchestrator.id, 'reported']]);
    const mine = await deptTask();
    const stuck = await report(ctx, head.id, mine.id, { done: false, summary: 'Need a Stripe account.' });
    expect(stuck.task.status).toBe('waiting');
    expect(woken(stuck)).toEqual([[orchestrator.id, 'explain']]);
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
    const { ctx, CEO, bruno, memberTask, read } = await company();
    const task = await memberTask();
    const asked = await ask(ctx, bruno.id, task.id, { kind: 'question', text: 'Which currency?' });
    expect((await read(task.id)).status).toBe('waiting');
    const answered = await answer(ctx, CEO, asked.request.id, { answer: 'EUR' });
    expect(answered.request).toMatchObject({ status: 'answered', answer: 'EUR', answeredBy: CEO.personId });
    expect((await read(task.id)).status).toBe('working');
    expect(woken(answered)).toEqual([[bruno.id, 'answered']]);
    expect(await reason(ask(ctx, bruno.id, task.id, { kind: 'approval', text: 'Release?', commit: 'abc' }))).toBe('task_invalid');
    const approval = await ask(ctx, bruno.id, task.id, { kind: 'approval', text: 'Release 0.5.0?', commit: 'a'.repeat(40) });
    expect(await reason(answer(ctx, CEO, approval.request.id, { answer: 'yes' }))).toBe('task_invalid');
    expect((await answer(ctx, CEO, approval.request.id, { approve: true })).request.status).toBe('approved');
    expect(await reason(answer(ctx, CEO, approval.request.id, { approve: false }))).toBe('request_closed');
  });

  it("wakes the assignee for a person's comment but nobody for an agent's", async () => {
    const { ctx, CEO, head, bruno, memberTask } = await company();
    const task = await memberTask();
    expect(woken(await comment(ctx, CEO, task.id, 'Keep refunds out of this one.'))).toEqual([[bruno.id, 'comment']]);
    expect(woken(await comment(ctx, { agentId: head.id }, task.id, 'Noted.'))).toEqual([]);
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
