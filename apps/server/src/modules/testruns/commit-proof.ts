import { and, desc, eq, isNotNull, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { tasks, testRuns } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { openTurnOf } from '../tasks/turn-department.js';
import { runScope, scopeWords, type RunScope, type ScopeSource } from './purpose.js';

type TaskPlace = Pick<typeof tasks.$inferSelect, 'id' | 'companyId' | 'turnId' | 'departmentId'>;

/* What test runs say of one exact commit. run: the newest passed run on it that left no suite out, a whole run of its release, else
   the newest that passed on it, on any task of the company, as the final check of a turn is rarely the task that asks; scope: what that run
   left out, for a run of the product's environment; failedRun: the newest that failed on it, which whoever decides hears of all
   the same; other: when none passed on it, the newest that passed on another commit of this work, and proves nothing here. */
export type CommitProof = { commit: string; run: number | null; command: string | null; scope: RunScope | null; failedRun: number | null; other: { run: number; commitSha: string } | null };

const COMMAND_SHOWN = 300;
/* The passed runs of one commit a proof looks through for one that ran everything. */
const PASSED_READ = 50;

/* A command as a task shows it, however long it ran with: test_run shows it whole. */
export const commandShown = (command: string) => (command.length > COMMAND_SHOWN ? `${command.slice(0, COMMAND_SHOWN - 3)}...` : command);

const testsOf = (companyId: string) => and(eq(testRuns.companyId, companyId), eq(testRuns.kind, 'tests'));

/* What a proof reads of a run: of its snapshot only what says what it left out, as the inventory of a product is long. */
const snapshot = testRuns.environmentSnapshot;
const PASSED = {
  number: testRuns.number, command: testRuns.command,
  source: sql<ScopeSource | null>`case when ${snapshot} is null then null else jsonb_build_object('profile', ${snapshot}->'profile', 'manifest', ${snapshot}->'description'->'manifest') end`,
  suite: sql<string | null>`${testRuns.environmentRequest}->>'suite'`,
  kept: sql<number | null>`(${testRuns.fileCache}->>'reused')::int`,
};
type Passed = { number: number; command: string; source: ScopeSource | null; suite: string | null; kept: number | null };
/* What a run of the product's environment left out; none for a command. */
const scopeOf = (run: Passed): RunScope | null => (run.command === '' && run.source ? runScope(run.source, run.suite, run.kept ?? 0) : null);

async function newestFailed(db: Db, companyId: string, commit: string) {
  const [run] = await db.select(only(testRuns, 'number')).from(testRuns).where(and(testsOf(companyId), eq(testRuns.commitSha, commit), eq(testRuns.status, 'failed'))).orderBy(desc(testRuns.number)).limit(1);
  return run ?? null;
}

/* A whole run of the release proves the commit, whatever narrower run passed after it. */
async function bestPassed(db: Db, companyId: string, commit: string): Promise<(Passed & { scope: RunScope | null }) | null> {
  const runs = await db
    .select(PASSED)
    .from(testRuns)
    .where(and(testsOf(companyId), eq(testRuns.commitSha, commit), eq(testRuns.status, 'passed')))
    .orderBy(desc(testRuns.number))
    .limit(PASSED_READ);
  const scoped = runs.map(run => ({ ...run, scope: scopeOf(run) }));
  return scoped.find(run => run.scope && !run.scope.leftOut.length) ?? scoped[0] ?? null;
}

/* The turn a task's work is in: the one it went into, else its department's open turn, the release it goes into. */
async function workTurn(db: Db, task: TaskPlace): Promise<string | null> {
  return task.turnId ?? (await openTurnOf(db, task.companyId, task.departmentId))?.id ?? null;
}

/* The newest run that pinned a commit and passed, on the task or on its department's work in its turn. As none passed on
   the commit asked about, it checked another one. */
async function passedElsewhere(db: Db, task: TaskPlace): Promise<CommitProof['other']> {
  const turn = await workTurn(db, task);
  const sameWork = turn && task.departmentId ? and(eq(tasks.turnId, turn), eq(tasks.departmentId, task.departmentId)) : undefined;
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
  const passed = await bestPassed(db, task.companyId, commit);
  const failed = await newestFailed(db, task.companyId, commit);
  return { commit, run: passed?.number ?? null, command: passed ? commandShown(passed.command) : null, scope: passed?.scope ?? null, failedRun: failed?.number ?? null, other: passed ? null : await passedElsewhere(db, task) };
}

/* The same in a sentence, for whoever asks for an approval, gives it, or releases on it. */
export function proofLine(p: CommitProof): string {
  const ran = p.scope ? `Test run ${p.run} passed on this commit with profile ${p.scope.profile}${scopeWords(p.scope)}` : `Test run ${p.run} (${p.command}) passed on this commit.`;
  const said = p.run !== null ? ran : 'No passed test run checked this commit.';
  const failed = p.failedRun !== null ? ` Test run ${p.failedRun} failed on it.` : '';
  const other = p.other ? ` Test run ${p.other.run} passed on ${p.other.commitSha}, which proves nothing about this one.` : '';
  return `${said}${failed}${other}`;
}
