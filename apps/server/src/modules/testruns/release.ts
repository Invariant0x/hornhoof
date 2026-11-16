import type { EnvironmentProblem, EnvironmentSnapshot } from '@hornhoof/protocol';
import { and, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { testRuns } from '../../db/schema.js';
import { refuse, type Task } from '../tasks/engine.js';
import { goesStraightToMain } from '../tasks/turn-integration.js';

/* Whole test runs go once per release; a change is checked in its author's own workspace by the test files it reaches. */

const releaseBranch = (branch: string, mainLine: string): boolean =>
  branch === 'main' || branch === mainLine || /^turn-\d+$/.test(branch) || /^release-./.test(branch);

/* A test run checks a release branch of its repository: main or the main line the repository names, a turn's branch or a
   release branch. Where results go to their own main line straight, each is a release of its own, so any branch is one. A product
   run bound to a Tests candidate runs only the test files its change reaches, on that candidate's branch. Anything else is
   refused before the repository is asked anything. */
export async function requireReleaseBranch(db: Ctx['db'], task: Task, run: { branch: string | undefined; mainLine: string; candidate: boolean }): Promise<void> {
  if (run.candidate || (run.branch !== undefined && releaseBranch(run.branch, run.mainLine)) || (await goesStraightToMain(db, task))) return;
  const which = run.branch === undefined ? `#${task.number}'s own branch` : run.branch;
  const lines = [...new Set(['main', run.mainLine])].join(', ');
  throw refuse(
    409,
    'tests_not_release',
    `tests_not_release: ${which} is not a release branch, and run_tests runs only on one: ${lines}, a turn's branch turn-<number> or a release-<name> branch. ` +
      "Check your change in your own workspace by the test files it reaches, with the selection command your repository's AGENTS.md names. The whole suite runs once per release, on its release branch.",
  );
}

/* The full run of a release runs every test file anew, so it goes once, at the end: a release that failed is mended by the
   profile it replaces, which runs only what failed or changed, and the full run waits until that passed on the same commit. */
export async function fullRunTooEarly(db: Ctx['db'], run: { companyId: string; commitSha: string | null }, snapshot: EnvironmentSnapshot): Promise<EnvironmentProblem | null> {
  const fullRun = snapshot.description.manifest.execution?.fullRun;
  if (!fullRun || !run.commitSha) return null;
  const [passed] = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(
      and(
        eq(testRuns.companyId, run.companyId),
        eq(testRuns.departmentId, snapshot.description.repositoryScope.repositoryOwnerId),
        eq(testRuns.kind, 'tests'),
        eq(testRuns.status, 'passed'),
        eq(testRuns.commitSha, run.commitSha),
        sql`${testRuns.environmentSnapshot}->>'profile' = ${fullRun.replaces}`,
        sql`${testRuns.environmentSnapshot}->'candidate' is null`,
        sql`${testRuns.environmentRequest}->>'suite' is null`,
      ),
    )
    .limit(1);
  if (passed) return null;
  return {
    code: 'full_run_early',
    detail:
      `Profile ${fullRun.profile} runs every test file anew, once per release, after profile ${fullRun.replaces} passed on this same commit ${run.commitSha}, and it has not. ` +
      `Run profile ${fullRun.replaces} first: it runs only the test files that failed or changed. Once it passes, run profile ${fullRun.profile} on this same commit.`,
  };
}
