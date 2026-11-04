import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, agents, companies, jobs, people, subscriptions, taskEvents, tasks } from '../src/db/schema.js';
import { cancel, lastMove, type Task, type WakeWhy } from '../src/modules/tasks/engine.js';
import { discardStaleTurn, discardStaleTurns, repeatedTurn, repeatWake, taskForWake, taskWakeOf, waitingTaskTurn } from '../src/modules/tasks/wake-state.js';
import { wakeAll, wakePrompt } from '../src/modules/tasks/wake.js';
import { createTestDb, statements, testApp } from './helpers.js';

async function fixture(existing?: Awaited<ReturnType<typeof testApp>>['db']) {
  const db = existing ?? await createTestDb();
  const [company] = await db.insert(companies).values({ name: 'Acme' }).returning();
  const [owner] = await db.insert(people).values({ companyId: company!.id, name: 'Ivan', email: 'ivan@acme.test', status: 'active', scopeKind: 'company', isOwner: true }).returning();
  const [sub] = await db.insert(subscriptions).values({ companyId: company!.id, provider: 'anthropic_api', kind: 'api_key', label: 'Key', ownerPersonId: owner!.id, status: 'ready' }).returning();
  const [head, worker, reviewer] = await db.insert(agents).values([
    { companyId: company!.id, kind: 'head', name: 'Hana', model: '' },
    { companyId: company!.id, kind: 'worker', name: 'Bruno', model: '' },
    { companyId: company!.id, kind: 'worker', name: 'Rita', model: '' },
  ]).returning();
  let number = 0;
  const task = async (set: Partial<Task> = {}) => (await db.insert(tasks).values({ companyId: company!.id, number: ++number, title: 'Checkout', createdByAgentId: head!.id, executorAgentId: worker!.id, assigneeAgentId: worker!.id, ...set }).returning())[0]!;
  const job = async (t: Task | null, agentId: string | null = worker!.id) => (await db.insert(jobs).values({ companyId: company!.id, subscriptionId: sub!.id, agentId, taskId: t?.id ?? null, kind: 'conversation', prompt: 'Work.', timeoutMs: 1000 }).returning())[0]!;
  const message = async (id: string, t: Task, why: WakeWhy, agentId = worker!.id) => db.insert(agentEvents).values({ companyId: company!.id, agentId, jobId: id, kind: 'message', data: { text: 'A task wake.', taskWake: taskWakeOf(t, { why }) } });
  return { db, owner: owner!, sub: sub!, head: head!, worker: worker!, reviewer: reviewer!, task, job, message };
}

describe('task wake policy in the database', () => {
  it.each(['agent', 'person'] as const)('notifies the creator of a dependent task about a cancelled prerequisite (%s)', async creator => {
    const { app, db } = await testApp();
    const c = await fixture(db);
    await db.update(agents).set({ subscriptionId: c.sub.id }).where(eq(agents.id, c.head.id));
    const [orchestrator] = await db.insert(agents).values({ companyId: c.head.companyId, kind: 'orchestrator', name: 'Owen', model: '', subscriptionId: c.sub.id }).returning();
    const receiver = creator === 'agent' ? c.head.id : orchestrator!.id;
    const previous = await c.task();
    const dependent = await c.task({ title: 'Waiting checkout', after: [previous.id], createdByAgentId: creator === 'agent' ? c.head.id : null, createdByPersonId: creator === 'person' ? c.owner.id : null });
    const moved = await cancel(app.ctx, { personId: c.owner.id }, previous.id, 'Changed plans.');
    expect(moved.wakes).toContainEqual(expect.objectContaining({ agentId: receiver, taskId: dependent.id, why: 'after_cancelled' }));

    await wakeAll(app.ctx, moved.wakes);

    const queued = await db.select().from(jobs).where(and(eq(jobs.taskId, dependent.id), eq(jobs.agentId, receiver)));
    expect(queued).toMatchObject([{ agentId: receiver, taskId: dependent.id, status: 'queued' }]);
    expect(queued[0]!.prompt).toContain('cancelled');
    expect(await discardStaleTurn(db, queued[0]!)).toBe(false);
    expect(await taskForWake(db, { agentId: c.worker.id, taskId: dependent.id, why: 'after_cancelled' })).toBeNull();
    await db.update(tasks).set({ createdByAgentId: c.reviewer.id, createdByPersonId: null }).where(eq(tasks.id, dependent.id));
    expect(await discardStaleTurn(db, queued[0]!)).toBe(true);
  });

  it('rejects missing and removed orchestrators for a human-created dependent task', async () => {
    const c = await fixture();
    const task = await c.task({ createdByAgentId: null, createdByPersonId: c.owner.id });
    const wake = { agentId: c.worker.id, taskId: task.id, why: 'after_cancelled' as const };
    expect(await taskForWake(c.db, wake)).toBeNull();
    const [orchestrator] = await c.db.insert(agents).values({ companyId: task.companyId, kind: 'orchestrator', name: 'Owen', model: '', removedAt: new Date() }).returning();
    expect(await taskForWake(c.db, { ...wake, agentId: orchestrator!.id })).toBeNull();
  });

  it('keeps current actions and rejects work for closed tasks, other holders, and other phases', async () => {
    const c = await fixture();
    const cases: { why: WakeWhy; initial?: Partial<Task>; next?: Partial<Task>; receiver?: string; stale: boolean }[] = [
      { why: 'assigned', stale: false },
      { why: 'assigned', initial: { status: 'working' }, stale: false },
      { why: 'assigned', next: { status: 'working' }, stale: true },
      { why: 'assigned', next: { merging: true }, stale: true },
      { why: 'assigned', next: { status: 'done', closedAt: new Date(), assigneeAgentId: null }, stale: true },
      { why: 'assigned', next: { status: 'cancelled', closedAt: new Date() }, stale: true },
      { why: 'assigned', next: { assigneeAgentId: c.head.id }, stale: true },
      { why: 'assigned', initial: { status: 'blocked' }, stale: true },
      { why: 'merge', initial: { merging: true }, stale: false },
      { why: 'merge', stale: true },
      { why: 'merge', initial: { merging: true, assigneeAgentId: c.head.id }, stale: true },
      { why: 'review', initial: { status: 'review', stage: 1, panel: [c.reviewer.id] }, receiver: c.reviewer.id, stale: false },
      { why: 'turn_review', initial: { status: 'review', stage: 1, panel: [c.reviewer.id] }, next: { stage: 2 }, receiver: c.reviewer.id, stale: true },
      { why: 'review', initial: { panel: [c.reviewer.id] }, receiver: c.reviewer.id, stale: true },
      { why: 'review', initial: { status: 'review', stage: 1, panel: [c.worker.id] }, receiver: c.reviewer.id, stale: true },
      { why: 'comment', initial: { stage: 0, panel: [c.reviewer.id] }, receiver: c.reviewer.id, stale: true },
      { why: 'updated', next: { assigneeAgentId: c.head.id }, stale: true },
      { why: 'comment', stale: false },
      ...(['done', 'reported', 'reviewed', 'review_passed'] as const).map(why => ({ why, next: { status: 'done' as const, closedAt: new Date() }, receiver: c.head.id, stale: false })),
      ...(['blocked', 'stuck_at_gate', 'tests', 'work'] as const).map(why => ({ why, receiver: c.head.id, stale: false })),
      { why: 'tests', stale: false },
    ];
    for (const test of cases) {
      const task = await c.task(test.initial);
      const receiver = test.receiver ?? c.worker.id;
      const job = await c.job(task, receiver);
      await c.message(job.id, task, test.why, receiver);
      if (test.next) await c.db.update(tasks).set(test.next).where(eq(tasks.id, task.id));
      expect(await discardStaleTurn(c.db, job), `${test.why} ${task.number}`).toBe(test.stale);
      const [ended] = await c.db.select().from(jobs).where(eq(jobs.id, job.id));
      expect(ended!.status).toBe(test.stale ? 'failed' : 'queued');
      expect(ended!.startedAt).toBeNull();
      if (test.stale) expect(ended!.result).toContain(`#${task.number}`);
    }
  });

  it('validates fresh wakes before queueing, including missing tasks and current reviews', async () => {
    const c = await fixture();
    const task = await c.task();
    expect(await taskForWake(c.db, { agentId: c.worker.id, taskId: task.id, why: 'assigned' })).not.toBeNull();
    expect(await taskForWake(c.db, { agentId: c.worker.id, taskId: task.id, why: 'merge' })).toBeNull();
    expect(await taskForWake(c.db, { agentId: c.worker.id, taskId: '00000000-0000-4000-8000-000000000099', why: 'assigned' })).toBeNull();
  });

  it('retains stale log entries once and leaves non-task turns and current queued wakes intact', async () => {
    const c = await fixture();
    const task = await c.task();
    const job = await c.job(task);
    await c.message(job.id, task, 'assigned');
    expect(await waitingTaskTurn(c.db, c.worker.id, task.id)).toEqual({ id: job.id });
    await c.db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(eq(tasks.id, task.id));
    expect(await discardStaleTurn(c.db, job)).toBe(true);
    const skipped = await c.db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id));
    expect(skipped).toEqual([expect.objectContaining({ kind: 'wake_skipped', agentId: c.worker.id, data: { wake: 'assigned', job: job.id } })]);
    expect(await lastMove(c.db, task.id)).toBeUndefined();
    const stopped = (await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, job.id))).filter(e => e.kind === 'stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.data).toMatchObject({ reason: 'stale', task: { id: task.id, number: task.number } });
    expect(await discardStaleTurn(c.db, job)).toBe(true);
    expect((await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, job.id))).filter(e => e.kind === 'stopped')).toHaveLength(1);
    expect(await c.db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id))).toHaveLength(1);
    expect(await waitingTaskTurn(c.db, c.worker.id, task.id)).toBeUndefined();
    const plain = await c.job(null);
    expect(await discardStaleTurn(c.db, plain)).toBe(false);
    expect(await discardStaleTurn(c.db, await c.job(task, null))).toBe(false);
    expect(await discardStaleTurns(c.db, [])).toBe(false);
  });

  it('repeats current work, keeping its purpose and stage while rejecting another holder, stage, merge phase or external wait', async () => {
    const c = await fixture();
    for (const next of [{ status: 'working' as const }, { assigneeAgentId: c.head.id }, { stage: 1 }, { merging: true }, { externalWait: { reason: 'Registry', since: new Date().toISOString(), until: new Date(Date.now() + 1000).toISOString() } }]) {
      const task = await c.task();
      const job = await c.job(task);
      await c.message(job.id, task, 'assigned');
      const [current] = await c.db.update(tasks).set(next).where(eq(tasks.id, task.id)).returning();
      const repeated = await repeatWake(c.db, { job, task: current!, agent: c.worker }, 'restart');
      expect(repeated !== null).toBe('status' in next);
      if (repeated) expect(repeated).toMatchObject({ why: 'assigned', status: 'working', stage: 0, merging: false });
      expect(await c.db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id))).toEqual([]);
    }
  });

  it('only repeats the matching failed turn, never a queued turn or a second continuation', async () => {
    const c = await fixture();
    const task = await c.task();
    const job = await c.job(task);
    expect(await repeatedTurn(c.db, job.id, 'restart')).toBeNull();
    expect(await repeatedTurn(c.db, '00000000-0000-4000-8000-000000000099', 'continue')).toBeNull();
    await c.db.update(jobs).set({ status: 'failed', error: 'machine_restarted' }).where(eq(jobs.id, job.id));
    expect(await repeatedTurn(c.db, job.id, 'restart')).toMatchObject({ job: { id: job.id }, taskWake: { why: 'go_on' } });
    expect(await repeatedTurn(c.db, job.id, 'continue')).toBeNull();
    await c.db.update(jobs).set({ error: 'agent_failed' }).where(eq(jobs.id, job.id));
    expect(await repeatedTurn(c.db, job.id, 'restart')).toBeNull();
    expect(await repeatedTurn(c.db, job.id, 'continue')).toMatchObject({ job: { id: job.id }, taskWake: { why: 'go_on' } });
    await c.db.update(jobs).set({ continueOf: job.id }).where(eq(jobs.id, job.id));
    expect(await repeatedTurn(c.db, job.id, 'continue')).toBeNull();
  });

  it('does not repeat a comment from before the task entered the merge phase', async () => {
    const c = await fixture();
    const task = await c.task();
    const job = await c.job(task);
    await c.message(job.id, task, 'comment');
    const [current] = await c.db.update(tasks).set({ merging: true }).where(eq(tasks.id, task.id)).returning();
    expect(await repeatWake(c.db, { job, task: current!, agent: c.worker }, 'restart')).toBeNull();
  });

  it('repeats legacy work and legacy giver notices, and names queued retries and continuations when skipped', async () => {
    const c = await fixture();
    const task = await c.task();
    const job = await c.job(task);
    expect(await repeatWake(c.db, { job, task, agent: c.worker }, 'restart')).toMatchObject({ why: 'go_on' });
    const closed = await c.task({ status: 'done', closedAt: new Date() });
    const notice = await c.job(closed, c.head.id);
    notice.prompt = `#${closed.number} "Checkout", which you gave out, passed its gates and is done.`;
    expect(await repeatWake(c.db, { job: notice, task: closed, agent: c.head }, 'restart')).toMatchObject({ why: 'done' });
    for (const [link, wake] of [['retryOf', 'restart'], ['continueOf', 'continue']] as const) {
      const queued = await c.job(closed);
      await c.db.update(jobs).set({ [link]: job.id }).where(eq(jobs.id, queued.id));
      expect(await discardStaleTurn(c.db, queued)).toBe(true);
      expect((await c.db.select().from(taskEvents).where(eq(taskEvents.taskId, closed.id))).find(e => (e.data as { job: string }).job === queued.id)).toMatchObject({ data: { wake, job: queued.id } });
    }
  });

  it('checks every task of a batch and takes its row locks', async () => {
    const c = await fixture();
    const current = await c.task();
    const old = await c.task({ status: 'done', closedAt: new Date() });
    const a = await c.job(current);
    const b = await c.job(old);
    await c.message(a.id, current, 'assigned');
    await c.message(b.id, old, 'assigned');
    const ran = statements();
    expect(await c.db.transaction(tx => discardStaleTurns(tx, [a, b]))).toBe(true);
    expect(ran.find(s => s.sql.includes('for share'))?.params).toEqual(expect.arrayContaining([current.id, old.id]));
    expect((await c.db.select().from(jobs).where(eq(jobs.id, a.id)))[0]!.status).toBe('queued');
    expect((await c.db.select().from(jobs).where(eq(jobs.id, b.id)))[0]!.error).toBe('stale');
  });

  it('supports legacy messages without treating a worker who created its task as a completion notice', async () => {
    const c = await fixture();
    const current = await c.task();
    expect(await discardStaleTurn(c.db, await c.job(current))).toBe(false);
    const old = await c.task({ status: 'done', closedAt: new Date(), createdByAgentId: c.worker.id });
    expect(await discardStaleTurn(c.db, await c.job(old))).toBe(true);
    const given = await c.task({ status: 'done', closedAt: new Date() });
    const notice = await c.job(given, c.head.id);
    await c.db.update(jobs).set({ prompt: `#${given.number} "Checkout", which you gave out, passed its gates and is done.` }).where(eq(jobs.id, notice.id));
    expect(await discardStaleTurn(c.db, notice)).toBe(false);
    for (const why of ['done', 'reported', 'reviewed', 'review_passed', 'cancelled', 'turn'] as const) {
      const kept = await c.job(given, c.head.id);
      const prompt = wakePrompt(c.head, given, { agentId: c.head.id, taskId: given.id, why, text: 'Checked.' });
      await c.db.update(jobs).set({ prompt }).where(eq(jobs.id, kept.id));
      expect(await discardStaleTurn(c.db, kept), why).toBe(false);
    }
    const own = await c.task({ status: 'done', closedAt: new Date(), executorAgentId: c.head.id });
    expect(await discardStaleTurn(c.db, await c.job(own, c.head.id))).toBe(true);
    const blocked = await c.task({ status: 'blocked' });
    const alert = await c.job(blocked, c.head.id);
    await c.db.update(jobs).set({ prompt: `#${blocked.number} "Checkout", which you gave out, cannot go on.` }).where(eq(jobs.id, alert.id));
    expect(await discardStaleTurn(c.db, alert)).toBe(false);
    await c.db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(eq(tasks.id, blocked.id));
    expect(await discardStaleTurn(c.db, alert)).toBe(true);
  });

  it('keeps a direct task message to another employee until the task is cancelled', async () => {
    const c = await fixture();
    const task = await c.task({ externalWait: { reason: 'CI', since: new Date().toISOString(), until: new Date(Date.now() + 60_000).toISOString() } });
    const direct = await c.job(task, c.head.id);
    await c.db.insert(agentEvents).values({
      companyId: task.companyId,
      agentId: c.head.id,
      jobId: direct.id,
      kind: 'message',
      data: { text: 'Update for head.', task: { id: task.id, number: task.number }, taskWake: { ...taskWakeOf(task, { why: 'comment' }), why: 'message', to: c.head.id } },
    });
    expect(await discardStaleTurn(c.db, direct)).toBe(false);
    await c.db.update(tasks).set({ status: 'done', closedAt: new Date(), externalWait: null }).where(eq(tasks.id, task.id));
    expect(await discardStaleTurn(c.db, direct)).toBe(false);
    await c.db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, task.id));
    expect(await discardStaleTurn(c.db, direct)).toBe(true);
  });
});
