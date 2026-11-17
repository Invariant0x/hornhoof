import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { WaitPlan } from '@hornhoof/protocol/waits';
import { and, eq, inArray } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { agents, pendingWakes, taskEvents, tasks, taskWaits, testRuns, waitNotices } from '../../src/db/schema.js';
import { checkExternalWaits, waitFor } from '../../src/modules/tasks/external-wait.js';
import * as noticeModule from '../../src/modules/tasks/wait-notices.js';
import { claimFinalReview, endSourceWait, operationSourceKey, replanWait, syncSourceWaits, waitForSourceKey } from '../../src/modules/tasks/wait-state.js';
import { checkTestTimes, startRun } from '../../src/modules/testruns/runs.js';
import { ApiError } from '../../src/errors.js';
import { backendPid, privatePostgres, runFixture } from './helpers.js';
import { eventually } from '../../../../test-support/eventually.mjs';

const HOUR = 3_600_000;
const after = (ms: number) => new Date(Date.now() + ms).toISOString();

async function waits() {
  const pg = await privatePostgres();
  const fixture = await runFixture(pg);
  const [head] = await pg.db.insert(agents).values({ companyId: fixture.companyId, departmentId: fixture.departmentId, kind: 'head', name: 'Head', model: '' }).returning();
  const [one, two] = fixture.actors;
  const plan = (change: Partial<WaitPlan> = {}): WaitPlan => ({
    version: 1, ownerDueAt: after(HOUR), headDueAt: after(2 * HOUR), decisionDueAt: after(3 * HOUR),
    provenance: { kind: 'explicit_promise', actor: { agentId: head!.id }, ref: 'promise-1', revision: 1, origin: 'test' },
    finalReview: { headAgentId: head!.id, anchorAt: after(4 * HOUR), intervalMs: HOUR },
    ...change,
  });
  const key = waitForSourceKey(randomUUID());
  const source = { taskId: one.task.id, kind: 'external' as const, sourceKey: key, sourceRevision: 1, ownerBinding: { agentId: one.job.agentId }, plan: plan(), sourceState: {}, actor: { agentId: one.job.agentId } };
  const rows = () => pg.db.select().from(taskWaits).where(eq(taskWaits.taskId, one.task.id));
  const blockers = async (pid: number) => (await pg.admin.query<{ blockers: number[] }>('SELECT pg_blocking_pids($1) AS blockers', [pid])).rows[0]!.blockers;
  return { pg, fixture, head: head!, one, two, plan, key, source, rows, blockers };
}

it('waits for whoever holds the task and commits once they let go', async () => {
  const c = await waits();
  const locker = await c.pg.pool('locker').connect();
  const pid = await backendPid(c.one.pool);
  let pending: Promise<unknown> | undefined;
  try {
    await locker.query('BEGIN');
    await locker.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [c.one.task.id]);
    const owner = (await locker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    pending = c.one.ctx.db.transaction(tx => syncSourceWaits(tx, c.source));
    await eventually(async () => isDeepStrictEqual(await c.blockers(pid), [owner]));
    expect(await c.rows()).toEqual([]);
    await locker.query('COMMIT');
    await pending;
    expect(await c.rows()).toHaveLength(1);
  } finally {
    await locker.query('ROLLBACK').catch(() => {});
    locker.release(true);
    await pending?.catch(() => {});
  }
});

it('takes the task, then the wait: a second writer queues on the task and nobody deadlocks', async () => {
  const c = await waits();
  const wait = await c.pg.db.transaction(tx => syncSourceWaits(tx as never, c.source));
  const locker = await c.pg.pool('locker').connect();
  const [firstPid, secondPid] = [await backendPid(c.one.pool), await backendPid(c.two.pool)];
  const pending: Promise<unknown>[] = [];
  try {
    await locker.query('BEGIN');
    await locker.query('SELECT id FROM task_waits WHERE id = $1 FOR UPDATE', [wait.id]);
    const owner = (await locker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const replanned = c.one.ctx.db.transaction(tx => replanWait(tx, { waitId: wait.id, expectedGeneration: 1, plan: c.plan({ ownerDueAt: after(HOUR / 2) }), reason: 'Sooner.', actor: { agentId: c.head.id } }));
    pending.push(replanned);
    await eventually(async () => isDeepStrictEqual(await c.blockers(firstPid), [owner]));
    const ended = c.two.ctx.db.transaction(tx => endSourceWait(tx, { taskId: c.one.task.id, kind: 'external', sourceKey: c.key, sourceRevision: 1, outcome: 'resolved', proofRef: 'proof-1', actor: { agentId: c.head.id } }));
    pending.push(ended);
    await eventually(async () => isDeepStrictEqual(await c.blockers(secondPid), [firstPid]));
    await locker.query('COMMIT');
    expect(await replanned).toMatchObject({ generation: 2, state: 'active' });
    expect(await ended).toMatchObject({ generation: 2, state: 'resolved', proofRef: 'proof-1' });
  } finally {
    await locker.query('ROLLBACK').catch(() => {});
    locker.release(true);
    await Promise.allSettled(pending);
  }
});

it('keeps one wait for a source two connections write at once', async () => {
  const c = await waits();
  const [first, second] = await Promise.all([c.one, c.two].map(actor => actor.ctx.db.transaction(tx => syncSourceWaits(tx, c.source))));
  expect(first!.id).toBe(second!.id);
  expect(await c.rows()).toHaveLength(1);
  expect((await c.pg.db.select().from(taskEvents).where(eq(taskEvents.taskId, c.one.task.id))).filter(event => event.data.wait)).toHaveLength(1);
});

it('lets one of two connections plan the generation both read, and refuses the other', async () => {
  const c = await waits();
  const wait = await c.pg.db.transaction(tx => syncSourceWaits(tx as never, c.source));
  const attempts = await Promise.allSettled([c.one, c.two].map((actor, index) => actor.ctx.db.transaction(tx => replanWait(tx, {
    waitId: wait.id, expectedGeneration: 1, plan: c.plan({ ownerDueAt: after(HOUR / (index + 2)) }), reason: 'New promise.', actor: { agentId: c.head.id },
  }))));
  expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1);
  const refused = attempts.find(attempt => attempt.status === 'rejected') as PromiseRejectedResult;
  expect(refused.reason).toBeInstanceOf(ApiError);
  expect((refused.reason as ApiError).reason).toBe('task_changed');
  expect((await c.rows())[0]).toMatchObject({ generation: 2 });
});

it('gives the one signal of an operation to one of two sweeps, none after a restart, and writes one notice', async () => {
  const c = await waits();
  const deadline = after(-1000);
  const plan = c.plan({ ownerDueAt: deadline, headDueAt: deadline, decisionDueAt: deadline, finalReview: { headAgentId: c.head.id, anchorAt: deadline, intervalMs: null }, provenance: { kind: 'source_contract', actor: { agentId: c.head.id }, ref: 'operation-1', revision: 1, origin: 'external' } });
  const wait = await c.pg.db.transaction(tx => syncSourceWaits(tx as never, { ...c.source, sourceKey: operationSourceKey(randomUUID()), plan }));
  const sweep = (ctx: typeof c.one.ctx) => ctx.db.transaction(async tx => {
    const step = await claimFinalReview(tx, { waitId: wait.id, expectedGeneration: 1, at: new Date() });
    if (!step) return false;
    await noticeModule.recordWaitNotice(tx, {
      companyId: c.fixture.companyId, agentId: c.head.id, dedupKey: `final:${wait.id}:${step.wait.generation}`, waitId: wait.id, generation: step.wait.generation, level: step.wait.level, purpose: 'final_review', routeRevision: step.wait.routeRevision,
      message: { text: 'Past its date.' } as never, guard: { tasks: [{ id: c.one.task.id, version: c.one.task.version }] },
    });
    return true;
  });
  const claimed = await Promise.all([sweep(c.one.ctx), sweep(c.two.ctx)]);
  expect(claimed.filter(Boolean)).toHaveLength(1);
  expect(await sweep(c.one.ctx)).toBe(false);
  expect(await c.pg.db.select().from(waitNotices).where(eq(waitNotices.waitId, wait.id))).toHaveLength(1);
  expect((await c.rows())[0]).toMatchObject({ reviewOrdinal: 1, nextReviewAt: null, level: 3, state: 'active' });
});

it('tells the result once and refuses the wait built before it, with no wake at the deadline, across connections', async () => {
  const c = await waits();
  const reply = await startRun(c.one.ctx, c.one.job, { task: c.one.task.number, branch: `release-${c.one.task.number}`, command: 'never-runs', parts: 1 });
  expect(reply).toContain('Test run 1');
  const original = noticeModule.requestedWaitNotice;
  let checked!: () => void;
  let resume!: () => void;
  const atBarrier = new Promise<void>(done => { checked = done; });
  const released = new Promise<void>(done => { resume = done; });
  const paused = vi.spyOn(noticeModule, 'requestedWaitNotice').mockImplementation(async (...args) => {
    const notice = await original(...args);
    checked();
    await released;
    return notice;
  });
  try {
    const until = after(HOUR);
    const waiting = waitFor(c.one.ctx, c.one.job.agentId, c.one.task.id, { reason: 'The run', until }).then(() => 'placed', (error: unknown) => (error as ApiError).reason);
    await atBarrier;
    await checkTestTimes(c.two.ctx, new Date(Date.now() + 2 * 24 * HOUR));
    await eventually(async () => (await c.pg.db.select().from(testRuns))[0]!.status === 'failed');
    resume();
    expect(await waiting).toBe('task_changed');
    const [task] = await c.pg.db.select().from(tasks).where(eq(tasks.id, c.one.task.id));
    expect(task!.externalWait).toBeNull();
    expect(await checkExternalWaits(c.two.ctx, new Date(Date.parse(until) + 1))).toBe(0);
    const [run] = await c.pg.db.select().from(testRuns);
    const [record] = await c.pg.db.select().from(taskWaits).where(and(eq(taskWaits.taskId, c.one.task.id), eq(taskWaits.sourceKey, `run:${run!.id}`)));
    expect(record).toMatchObject({ state: 'resolved', proofRef: `run:${run!.id}:failed` });
    expect(await c.pg.db.select().from(pendingWakes).where(and(eq(pendingWakes.taskId, c.one.task.id), inArray(pendingWakes.why, ['wait_ended'])))).toEqual([]);
  } finally {
    resume();
    paused.mockRestore();
  }
});

it('takes the task before the run when a run ends, leaving the run row free until it has it', async () => {
  const c = await waits();
  await startRun(c.one.ctx, c.one.job, { task: c.one.task.number, branch: `release-${c.one.task.number}`, command: 'never-runs', parts: 1 });
  const [run] = await c.pg.db.select().from(testRuns);
  const locker = await c.pg.pool('locker').connect();
  const pid = await backendPid(c.two.pool);
  let pending: Promise<unknown> | undefined;
  try {
    await locker.query('BEGIN');
    await locker.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [c.one.task.id]);
    const owner = (await locker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    pending = checkTestTimes(c.two.ctx, new Date(Date.now() + 2 * 24 * HOUR));
    await eventually(async () => isDeepStrictEqual(await c.blockers(pid), [owner]));
    const free = await c.pg.admin.query('SELECT id, status FROM test_runs WHERE id = $1 FOR UPDATE NOWAIT', [run!.id]);
    expect(free.rows[0]).toMatchObject({ status: 'running' });
    await locker.query('COMMIT');
    await pending;
    expect((await c.pg.db.select().from(testRuns))[0]!.status).toBe('failed');
  } finally {
    await locker.query('ROLLBACK').catch(() => {});
    locker.release(true);
    await pending?.catch(() => {});
  }
});
