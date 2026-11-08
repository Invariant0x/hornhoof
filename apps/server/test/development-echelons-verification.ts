import { jobs, testParts, testRuns } from '../src/db/schema.js';
import { submit, verdict } from '../src/modules/tasks/engine.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

export async function testsFixture(fix = false) {
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

