import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, tasks, testParts, testRuns } from '../src/db/schema.js';
import { quote } from '../src/modules/conversation/prompt.js';
import { report, submit, verdict } from '../src/modules/tasks/engine.js';
import { wakePrompt } from '../src/modules/tasks/wake.js';
import { taskForWake } from '../src/modules/tasks/wake-state.js';
import { BASE } from './development-echelons-fixture.js';
import { testsFixture } from './development-echelons-verification.js';

/* A run of the current candidate that ended failed: a test that failed, or a run whose parts never went out. */
async function failedRun(f: Awaited<ReturnType<typeof testsFixture>>, error: 'failed' | 'commit_unavailable') {
  const run = await f.run();
  await f.db.update(testRuns).set({ status: 'failed' }).where(eq(testRuns.id, run.id));
  const content = error === 'failed';
  await f.db.update(testParts).set({ status: 'failed', exitCode: content ? 1 : null, error, commit: content ? f.finalCommit : null, tail: content ? 'totals.test.ts failed' : 'Cannot find package typescript', finishedAt: new Date() }).where(eq(testParts.runId, run.id));
  return run;
}

const defect = (f: Awaited<ReturnType<typeof testsFixture>>, runIds: string[], summary: string) =>
  ({ done: false, summary, verification: { candidateId: f.snapshot.candidateId!, revision: f.snapshot.revision, runIds, defect: true as const } });

describe('Tests sends a defect of the candidate back to its author on Development', () => {
  it('returns a candidate whose check failed to its author, who hands in a new candidate that goes through Review and Tests again', async () => {
    const f = await testsFixture();
    const run = await failedRun(f, 'failed');
    const moved = await report(f.ctx, f.tester.id, f.task.id, defect(f, [run.id], 'totals.test.ts fails: the total of an empty order is not zero.'));
    expect(moved.task).toMatchObject({ status: 'open', assigneeAgentId: f.author.id });
    const route = (await f.detail()).echelons;
    expect(route).toMatchObject({ phase: 'active', stage: 'development', candidateId: f.snapshot.candidateId, assignment: null });
    expect(route.stages.map(step => [step.stage, step.status, step.ownerAgentId, step.candidateId])).toEqual(f.snapshot.stages.map(step => [
      step.stage, step.stage === 'development' ? 'active' : step.status === 'skipped' ? 'skipped' : 'pending', step.ownerAgentId, step.stage === 'development' || step.status === 'skipped' ? step.candidateId : null,
    ]));
    expect(route.stages.find(step => step.stage === 'tests')?.reason).toBe('tests_found_defect');
    expect(moved.wakes).toEqual([{ agentId: f.author.id, taskId: f.task.id, why: 'changes', text: 'totals.test.ts fails: the total of an empty order is not zero.', cause: expect.objectContaining({
      actor: { agentId: f.tester.id }, action: 'found a defect and sent work back', report: 'totals.test.ts fails: the total of an empty order is not zero.',
    }) as unknown }]);
    expect(await taskForWake(f.db, moved.wakes[0]!)).toMatchObject({ id: f.task.id });
    expect((await f.detail()).log.findLast(event => event.kind === 'report')?.data).toMatchObject({ failedVerification: { kind: 'content', defect: true, candidateId: f.snapshot.candidateId, runIds: [run.id] } });

    f.atCommit('e'.repeat(40));
    const again = await submit(f.ctx, f.author.id, f.task.id, { summary: 'Empty orders total zero.', evidence: 'totals.test.ts passes.', review: { baseCommit: BASE } });
    expect(again.task).toMatchObject({ status: 'review', assigneeAgentId: f.reviewer.id });
    const handed = (await f.detail()).echelons;
    expect(handed).toMatchObject({ stage: 'review', phase: 'active' });
    expect(handed.candidateId).not.toBe(f.snapshot.candidateId);
    expect((await f.detail()).log.findLast(event => event.kind === 'submitted')?.data).toMatchObject({ candidate: { parentId: f.snapshot.candidateId, commit: 'e'.repeat(40) } });
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Checked the new candidate.', reviewedCommit: 'e'.repeat(40) });
    expect((await f.detail()).echelons).toMatchObject({ stage: 'tests', phase: 'active', candidateId: handed.candidateId });
  });

  it('returns a candidate whose run could not send out a part, as the candidate keeps the run from starting', async () => {
    const f = await testsFixture();
    const run = await failedRun(f, 'commit_unavailable');
    const moved = await report(f.ctx, f.tester.id, f.task.id, defect(f, [run.id], 'The node cannot describe this candidate: it imports typescript, which the image does not install.'));
    expect(moved.task).toMatchObject({ status: 'open', assigneeAgentId: f.author.id });
    expect((await f.detail()).echelons).toMatchObject({ phase: 'active', stage: 'development' });
    expect((await f.detail()).log.findLast(event => event.kind === 'report')?.data).toMatchObject({ failedVerification: { kind: 'infrastructure', defect: true, runIds: [run.id] } });
  });

  it('gives the author the whole text of the defect, however long', async () => {
    const f = await testsFixture();
    const run = await failedRun(f, 'failed');
    const text = Array.from({ length: 300 }, (_, i) => `Line ${i + 1}: the total of order ${i + 1} is off by one cent.`).join('\n');
    expect(text.length).toBeGreaterThan(10_000);
    const moved = await report(f.ctx, f.tester.id, f.task.id, defect(f, [run.id], text));
    const [author] = await f.db.select().from(agents).where(eq(agents.id, f.author.id));
    expect(wakePrompt(author!, moved.task, moved.wakes[0]!)).toContain(quote(text));
  });

  it('refuses a defect without a failed run of the current candidate, and leaves the candidate at Tests', async () => {
    const f = await testsFixture();
    await expect(report(f.ctx, f.tester.id, f.task.id, defect(f, [], 'No run.'))).rejects.toMatchObject({ status: 409, message: 'Name the exact current candidate and route revision.' });
    const passed = await f.run();
    await expect(report(f.ctx, f.tester.id, f.task.id, defect(f, [passed.id], 'A run that passed.'))).rejects.toMatchObject({ status: 409, message: 'No failed check was reported.' });
    const other = await failedRun(f, 'failed');
    await f.db.update(testRuns).set({ commitSha: 'd'.repeat(40) }).where(eq(testRuns.id, other.id));
    await expect(report(f.ctx, f.tester.id, f.task.id, defect(f, [other.id], 'A run of another candidate.'))).rejects.toMatchObject({ status: 409, message: 'A run does not verify the current candidate.' });
    expect((await f.detail()).echelons).toMatchObject({ phase: 'active', stage: 'tests', candidateId: f.snapshot.candidateId });
    expect((await f.db.select().from(tasks).where(eq(tasks.id, f.task.id)))[0]).toMatchObject({ assigneeAgentId: f.tester.id });
  });

  it('refuses a defect from anyone but the Tests owner, and with a report of done work', async () => {
    const f = await testsFixture();
    const run = await failedRun(f, 'failed');
    await expect(report(f.ctx, f.author.id, f.task.id, defect(f, [run.id], 'Not mine to check.'))).rejects.toMatchObject({ status: 403 });
    await expect(report(f.ctx, f.tester.id, f.task.id, { ...defect(f, [run.id], 'Done and a defect.'), done: true })).rejects.toMatchObject({ status: 400 });
    expect((await f.detail()).echelons).toMatchObject({ phase: 'active', stage: 'tests' });
  });
});
