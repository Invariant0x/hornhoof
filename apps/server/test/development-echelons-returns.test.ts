import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { testParts, testRuns } from '../src/db/schema.js';
import { report, submit, verdict } from '../src/modules/tasks/engine.js';
import { reviewContext } from '../src/modules/tasks/review-context.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';
import { candidateChecks } from './development-echelons-verification.js';

const FIXED = 'e'.repeat(40);
const REWRITTEN = 'f'.repeat(40);
const TOTALS = 'logic/totals.ts', TAX = 'logic/tax.ts';

/* A task over two files. The first candidate changes both; the author's fix after a return changes only the tax. A
   rewritten history is no descendant of what was checked, so git gives no comparison from it. */
async function twoFiles(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options);
  const { task } = await f.create({ paths: [TOTALS, TAX] });
  const changed: Record<string, string[]> = { [`${BASE}..${HEAD}`]: [TOTALS, TAX], [`${BASE}..${FIXED}`]: [TOTALS, TAX], [`${HEAD}..${FIXED}`]: [TAX], [`${BASE}..${REWRITTEN}`]: [TOTALS, TAX] };
  f.ctx.readCompare = async (_repo, want) => {
    const paths = changed[`${want.base}..${want.head}`];
    return paths ? { complete: true, baseSha: want.base, headSha: want.head, paths, diff: paths.map(() => '@@ -1 +1 @@\n-old\n+new').join('\n') } : { complete: false, reason: 'not-an-ancestor' };
  };
  const hand = (agentId: string, commit: string) => {
    f.atCommit(commit, changed[`${BASE}..${commit}`]);
    return submit(f.ctx, agentId, task.id, { summary: 'Keep totals and tax.', evidence: 'Focused checks.', review: { baseCommit: BASE } });
  };
  const route = async () => (await f.detail(task.id)).echelons;
  return { ...f, task, hand, route };
}

/* Tests finds a defect of the candidate in a run that failed. */
async function testsFindDefect(f: Awaited<ReturnType<typeof twoFiles>>) {
  const snapshot = await f.route();
  const checks = await candidateChecks(f, snapshot, HEAD);
  const run = await checks.run();
  await f.db.update(testRuns).set({ status: 'failed' }).where(eq(testRuns.id, run.id));
  await f.db.update(testParts).set({ status: 'failed', exitCode: 1, error: 'failed', commit: HEAD, tail: 'tax.test.ts failed', failedFiles: [{ suiteId: 'vitest', file: 'test/tax.test.ts' }], finishedAt: new Date() }).where(eq(testParts.runId, run.id));
  return report(f.ctx, f.tester.id, f.task.id, { done: false, summary: 'tax.test.ts fails: the tax of a free order is not zero.', verification: { candidateId: snapshot.candidateId!, revision: snapshot.revision, runIds: [run.id], defect: true } });
}

const AUTHOR_WORK = 'The tax rate must come from the order, not a constant: that is the author\'s design to change, not a repair.';

describe('Review sends a candidate back to its author when the work is the author\'s', () => {
  it('returns the candidate to the author on Development, who hands in a new one that Review sees as a change from the one it checked', async () => {
    const f = await twoFiles();
    await f.hand(f.author.id, HEAD);
    const first = await f.route();
    const moved = await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: false, returnToAuthor: true, comment: AUTHOR_WORK, reviewedCommit: HEAD });
    expect(moved.task).toMatchObject({ status: 'open', assigneeAgentId: f.author.id });
    expect(moved.wakes).toEqual([{ agentId: f.author.id, taskId: f.task.id, why: 'changes', text: AUTHOR_WORK, cause: expect.objectContaining({ actor: { agentId: f.reviewer.id }, action: 'sent work back to its author' }) as unknown }]);
    const returned = await f.route();
    expect(returned).toMatchObject({ stage: 'development', phase: 'active', assignment: null, candidateId: first.candidateId });
    expect(returned.stages.find(step => step.stage === 'review')).toMatchObject({ status: 'pending', reason: 'review_returned', candidateId: null, inputCandidateId: null });
    expect((await f.detail(f.task.id)).log.findLast(event => event.kind === 'verdict')?.data).toMatchObject({ pass: false, returnedToAuthor: true, stage: 'review', reviewedCommit: HEAD });

    const again = await f.hand(f.author.id, FIXED);
    expect(again.task).toMatchObject({ status: 'review', assigneeAgentId: f.reviewer.id });
    const review = await reviewContext(f.db, f.task.id);
    expect(review?.source).toMatchObject({ baseCommit: BASE, commit: FIXED, paths: [TOTALS, TAX] });
    expect(review?.since).toEqual([{ stage: 'review', candidateId: first.candidateId, commit: HEAD, pass: false, delta: { paths: [TAX], changedLines: 2, unchangedPaths: [TOTALS] }, reason: null }]);
  });

  it('refuses a return to the author that passes, escalates, or comes from anyone but Review', async () => {
    const f = await twoFiles({ riskClass: 'security' });
    await f.hand(f.author.id, HEAD);
    await expect(verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, returnToAuthor: true, comment: AUTHOR_WORK, reviewedCommit: HEAD })).rejects.toMatchObject({ status: 400 });
    await expect(verdict(f.ctx, f.reviewer.id, f.task.id, { pass: false, escalate: true, returnToAuthor: true, comment: AUTHOR_WORK, reviewedCommit: HEAD })).rejects.toMatchObject({ status: 400 });
    expect(await f.route()).toMatchObject({ stage: 'review', phase: 'active' });
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Checked the candidate.', reviewedCommit: HEAD });
    expect(await f.route()).toMatchObject({ stage: 'security', phase: 'active' });
    await expect(verdict(f.ctx, f.security.id, f.task.id, { pass: false, returnToAuthor: true, comment: AUTHOR_WORK, reviewedCommit: HEAD })).rejects.toMatchObject({ status: 400 });
    expect(await f.route()).toMatchObject({ stage: 'security', phase: 'active' });
  });
});

describe('after a return, a checker sees only the change since it checked, and its earlier PASS stands on the rest', () => {
  it('shows Review and Security their PASS on the candidate Tests sent back, with the paths the fix left alone', async () => {
    const f = await twoFiles({ riskClass: 'security' });
    await f.hand(f.author.id, HEAD);
    const first = await f.route();
    expect((await reviewContext(f.db, f.task.id))?.since).toEqual([]);
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Checked the candidate.', reviewedCommit: HEAD });
    await verdict(f.ctx, f.security.id, f.task.id, { pass: true, comment: 'No secret leaves the order.', reviewedCommit: HEAD });
    expect(await f.route()).toMatchObject({ stage: 'tests', phase: 'active' });
    expect((await testsFindDefect(f)).task).toMatchObject({ status: 'open', assigneeAgentId: f.author.id });

    await f.hand(f.author.id, FIXED);
    const since = (await reviewContext(f.db, f.task.id))?.since;
    const delta = { paths: [TAX], changedLines: 2, unchangedPaths: [TOTALS] };
    expect(since).toEqual([
      { stage: 'review', candidateId: first.candidateId, commit: HEAD, pass: true, delta, reason: null },
      { stage: 'security', candidateId: first.candidateId, commit: HEAD, pass: true, delta, reason: null },
    ]);
  });

  it('shows no change, so no earlier verdict stands on any path, when the new candidate does not grow from the checked one', async () => {
    const f = await twoFiles();
    await f.hand(f.author.id, HEAD);
    const first = await f.route();
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Checked the candidate.', reviewedCommit: HEAD });
    await testsFindDefect(f);
    await f.hand(f.author.id, REWRITTEN);
    expect((await reviewContext(f.db, f.task.id))?.since).toEqual([{ stage: 'review', candidateId: first.candidateId, commit: HEAD, pass: true, delta: null, reason: 'not-an-ancestor' }]);
  });
});
