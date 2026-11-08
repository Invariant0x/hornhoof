import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { jobs, testParts, testRuns } from '../src/db/schema.js';
import { report, submit, verdict } from '../src/modules/tasks/engine.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

async function testsFixture(fix = false) {
  const f = await fixture();
  const input = { summary: 'Keep totals.', evidence: 'Focused checks.', review: { baseCommit: BASE } };
  await submit(f.ctx, f.author.id, f.task.id, input);
  let finalCommit = HEAD;
  if (fix) {
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: false, comment: 'Fixing a boundary.', reviewedCommit: HEAD });
    finalCommit = 'c'.repeat(40);
    f.atCommit(finalCommit);
    await submit(f.ctx, f.reviewer.id, f.task.id, input);
  } else await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Checked the candidate.', reviewedCommit: HEAD });
  const snapshot = (await f.detail()).echelons;
  const [job] = await f.db.insert(jobs).values({ companyId: f.task.companyId, agentId: f.tester.id, subscriptionId: f.tester.subscriptionId!, taskId: f.task.id, kind: 'conversation', prompt: 'Verify final candidate', timeoutMs: 1000 }).returning();
  const run = async (commit = finalCommit, parts = 1) => {
    const [value] = await f.db.insert(testRuns).values({ companyId: f.task.companyId, taskId: f.task.id, agentId: f.tester.id, jobId: job!.id, departmentId: f.task.departmentId, number: 1, branch: 'task-1', commitSha: commit, command: 'Changed tests', status: 'passed', finishedAt: new Date(), parts, timeoutMs: 1000 }).returning();
    if (parts) await f.db.insert(testParts).values({ companyId: f.task.companyId, runId: value!.id, part: 1, status: 'passed', commit, exitCode: 0 });
    return value!;
  };
  const verified = (ids: string[]) => ({ done: true, summary: 'Verified the final changed scope.', ...{ verification: { candidateId: snapshot.candidateId!, revision: snapshot.revision, runIds: ids } } });
  return { ...f, run, verified, snapshot, finalCommit };
}

describe('Tests verifies the final candidate without changing it', () => {
  it('keeps the candidate and makes it ready for the head after verified exact parts', async () => {
    const f = await testsFixture(true);
    const run = await f.run();
    const moved = await report(f.ctx, f.tester.id, f.task.id, f.verified([run.id]));
    expect(moved.task).toMatchObject({ status: 'open', assigneeAgentId: f.head.id });
    expect((await f.detail()).echelons).toMatchObject({ phase: 'ready', candidateId: f.snapshot.candidateId });
    expect(moved.wakes.map(w => w.agentId)).toEqual([f.head.id]);
  });
  it('rejects an author receipt made before the checker changed the commit', async () => {
    const f = await testsFixture(true);
    const run = await f.run(HEAD);
    await expect(report(f.ctx, f.tester.id, f.task.id, f.verified([run.id])).then(() => null)).rejects.toMatchObject({ status: 409 });
  });
  it.each(['missing', 'unfinished', 'wrong-part-commit', 'zero-parts', 'duplicate'])('rejects %s evidence', async problem => {
    const f = await testsFixture();
    const run = await f.run(f.finalCommit, problem === 'zero-parts' ? 0 : 1);
    if (problem === 'unfinished') await f.db.update(testParts).set({ status: 'running', exitCode: null }).where(eq(testParts.runId, run.id));
    if (problem === 'wrong-part-commit') await f.db.update(testParts).set({ commit: BASE }).where(eq(testParts.runId, run.id));
    const ids = problem === 'missing' ? [randomUUID()] : problem === 'duplicate' ? [run.id, run.id] : [run.id];
    await expect(report(f.ctx, f.tester.id, f.task.id, f.verified(ids)).then(() => null)).rejects.toMatchObject({ status: 409 });
  });
  it('refuses code submission from Tests', async () => {
    const f = await testsFixture();
    await expect(submit(f.ctx, f.tester.id, f.task.id, { summary: 'Tests must not edit code.', evidence: 'None.', review: { baseCommit: BASE } })).rejects.toMatchObject({ status: 403 });
  });
});
