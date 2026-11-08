import { taskForWake } from '../src/modules/tasks/wake-state.js';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { tasks, testParts, testRuns } from '../src/db/schema.js';
import { report } from '../src/modules/tasks/engine.js';
import { testsFixture } from './development-echelons-verification.js';

async function failedFixture(error: string | null = 'failed', commit: string | null | undefined = undefined) {
  const f = await testsFixture();
  const run = await f.run();
  await f.db.update(testRuns).set({ status: 'failed' }).where(eq(testRuns.id, run.id));
  await f.db.update(testParts).set({ status: 'failed', exitCode: error === 'failed' ? 1 : null, error, commit: commit === undefined ? f.finalCommit : commit, finishedAt: new Date() }).where(eq(testParts.runId, run.id));
  const input = { ...f.verified([run.id]), done: false };
  return { ...f, input, failedRun: run };
}

describe('Tests failure belongs to the current candidate', () => {
  it('escalates a real failing check to the head without returning it to the author', async () => {
    const f = await failedFixture();
    const moved = await report(f.ctx, f.tester.id, f.task.id, f.input);
    expect(moved.task).toMatchObject({ status: 'blocked', assigneeAgentId: null });
    expect((await f.detail()).echelons).toMatchObject({ phase: 'escalated', stage: 'tests', candidateId: f.snapshot.candidateId });
    expect(moved.wakes.map(wake => wake.agentId)).toEqual([f.head.id]);
    expect(await taskForWake(f.db, moved.wakes[0]!)).toMatchObject({ id: f.task.id });
    expect((await f.detail()).log.findLast(event => event.kind === 'report')?.data).toMatchObject({ failedVerification: { kind: 'content', candidateId: f.snapshot.candidateId, runIds: [f.failedRun.id] } });
  });
  it('escalates to the department head when a worker originally created the task', async () => {
    const f = await failedFixture();
    await f.db.update(tasks).set({ createdByAgentId: f.author.id }).where(eq(tasks.id, f.task.id));
    const moved = await report(f.ctx, f.tester.id, f.task.id, f.input);
    expect(moved.wakes.map(wake => wake.agentId)).toEqual([f.head.id]);
    expect(await taskForWake(f.db, moved.wakes[0]!)).toMatchObject({ id: f.task.id });
  });
  it.each(['no_machine', 'clone_failed', 'timeout'])('keeps %s failure retryable at Tests without certifying readiness', async error => {
    const f = await failedFixture(error, null);
    const moved = await report(f.ctx, f.tester.id, f.task.id, f.input);
    expect(moved.task).toMatchObject({ status: 'working', assigneeAgentId: f.tester.id });
    expect((await f.detail()).echelons).toMatchObject({ phase: 'active', stage: 'tests', candidateId: f.snapshot.candidateId });
    expect(moved.wakes).toEqual([]);
    expect((await f.detail()).log.findLast(event => event.kind === 'report')?.data).toMatchObject({ failedVerification: { kind: 'infrastructure', candidateId: f.snapshot.candidateId } });
  });
  it('refuses a content failure reported from a different checked commit', async () => {
    const f = await failedFixture('failed', 'd'.repeat(40));
    await expect(report(f.ctx, f.tester.id, f.task.id, f.input).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect((await f.detail()).echelons.phase).toBe('active');
  });
  it('refuses an incomplete run as proof of a failed check', async () => {
    const f = await failedFixture();
    await f.db.update(testRuns).set({ status: 'running', finishedAt: null }).where(eq(testRuns.id, f.failedRun.id));
    await expect(report(f.ctx, f.tester.id, f.task.id, f.input).then(() => null)).rejects.toMatchObject({ status: 409 });
  });
  it('refuses a former owner reporting a Tests failure', async () => {
    const f = await failedFixture();
    await expect(report(f.ctx, f.author.id, f.task.id, f.input).then(() => null)).rejects.toMatchObject({ status: 403 });
  });
});
