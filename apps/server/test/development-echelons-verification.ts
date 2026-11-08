import { and, desc, eq } from 'drizzle-orm';
import { jobs, testParts, testRuns } from '../src/db/schema.js';
import { startRun } from '../src/modules/testruns/runs.js';
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
    await startRun(f.ctx, { id: job!.id, companyId: f.task.companyId, agentId: f.tester.id, agentKind: f.tester.kind, departmentId: f.tester.departmentId }, {
      task: f.task.id, command: 'Changed tests', candidate: { candidateId: snapshot.candidateId!, revision: snapshot.revision },
    });
    const [value] = await f.db.select().from(testRuns).where(and(eq(testRuns.taskId, f.task.id), eq(testRuns.agentId, f.tester.id))).orderBy(desc(testRuns.number)).limit(1);
    const [finished] = await f.db.update(testRuns).set({ status: 'passed', finishedAt: new Date(), commitSha: commit, parts }).where(eq(testRuns.id, value!.id)).returning();
    if (parts) await f.db.update(testParts).set({ status: 'passed', commit, exitCode: 0 }).where(eq(testParts.runId, value!.id));
    else await f.db.delete(testParts).where(eq(testParts.runId, value!.id));
    return finished!;
  };
  const verified = (ids: string[]) => ({ done: true, summary: 'Verified the final changed scope.', ...{ verification: { candidateId: snapshot.candidateId!, revision: snapshot.revision, runIds: ids } } });
  return { ...f, run, verified, snapshot, finalCommit };
}

