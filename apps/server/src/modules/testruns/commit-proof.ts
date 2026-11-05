import { and, desc, eq, isNotNull, or } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { tasks, TEST_RUN_STATUSES, testRuns } from '../../db/schema.js';

type TaskPlace = Pick<typeof tasks.$inferSelect, 'id' | 'companyId' | 'turnId' | 'departmentId'>;

/* What test runs say of one exact commit. run: the newest that passed on it, on any task of the company, as the final
   check of a turn is rarely the task that asks; failedRun: the newest that failed on it, which whoever decides hears of all
   the same; other: when none passed on it, the newest that passed on another commit of this work, and proves nothing here. */
export type CommitProof = { commit: string; run: number | null; command: string | null; failedRun: number | null; other: { run: number; commitSha: string } | null };

const COMMAND_SHOWN = 300;

/* A command as a task shows it, however long it ran with: test_run shows it whole. */
export const commandShown = (command: string) => (command.length > COMMAND_SHOWN ? `${command.slice(0, COMMAND_SHOWN - 3)}...` : command);

const testsOf = (companyId: string) => and(eq(testRuns.companyId, companyId), eq(testRuns.kind, 'tests'));

async function newestOn(db: Db, companyId: string, commit: string, status: (typeof TEST_RUN_STATUSES)[number]) {
  const [run] = await db
    .select({ number: testRuns.number, command: testRuns.command })
    .from(testRuns)
    .where(and(testsOf(companyId), eq(testRuns.commitSha, commit), eq(testRuns.status, status)))
    .orderBy(desc(testRuns.number))
    .limit(1);
  return run ?? null;
}

/* The newest run that pinned a commit and passed, on the task or on its department's work in this turn. As none passed on
   the commit asked about, it checked another one. */
async function passedElsewhere(db: Db, task: TaskPlace): Promise<CommitProof['other']> {
  const sameWork = task.turnId && task.departmentId ? and(eq(tasks.turnId, task.turnId), eq(tasks.departmentId, task.departmentId)) : undefined;
  const [run] = await db
    .select({ number: testRuns.number, commitSha: testRuns.commitSha })
    .from(testRuns)
    .innerJoin(tasks, eq(tasks.id, testRuns.taskId))
    .where(and(testsOf(task.companyId), eq(testRuns.status, 'passed'), isNotNull(testRuns.commitSha), or(eq(testRuns.taskId, task.id), sameWork)))
    .orderBy(desc(testRuns.number))
    .limit(1);
  return run ? { run: run.number, commitSha: run.commitSha! } : null;
}

export async function commitProof(db: Db, task: TaskPlace, commit: string): Promise<CommitProof> {
  const passed = await newestOn(db, task.companyId, commit, 'passed');
  const failed = await newestOn(db, task.companyId, commit, 'failed');
  return { commit, run: passed?.number ?? null, command: passed ? commandShown(passed.command) : null, failedRun: failed?.number ?? null, other: passed ? null : await passedElsewhere(db, task) };
}

/* The same in a sentence, for whoever asks for an approval, gives it, or releases on it. */
export function proofLine(p: CommitProof): string {
  const said = p.run !== null ? `Test run ${p.run} (${p.command}) passed on this commit.` : 'No passed test run checked this commit.';
  const failed = p.failedRun !== null ? ` Test run ${p.failedRun} failed on it.` : '';
  const other = p.other ? ` Test run ${p.other.run} passed on ${p.other.commitSha}, which proves nothing about this one.` : '';
  return `${said}${failed}${other}`;
}
