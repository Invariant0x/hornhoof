import { and, desc, eq, inArray, or } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { departments, testRuns, turns } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { repoAt } from '../departments/repository.js';
import { type Task } from '../tasks/engine.js';
import { routeOf } from '../tasks/echelons-store.js';
import { openTurnOf } from '../tasks/turn-department.js';
import { commandShown } from './commit-proof.js';
import type { CommitAt } from './refs.js';

type Run = typeof testRuns.$inferSelect;
type Reader = Pick<Ctx, 'db' | 'config' | 'readCommit'>;
/* Where the branches read so far stand, so a task with many runs on a branch asks its repository once. */
type Heads = Map<string, Promise<CommitAt | null>>;

export type Freshness = 'current' | 'stale' | 'unknown';
export type Evidence = { commitSha: string | null; head: string | null; freshness: Freshness; why: string | null };
/* A test run as a task shows it. proves: it passed, and what it checked is what its branch holds now (T10). */
export type RunEvidence = Evidence & { run: number; status: Run['status']; branch: string | null; command: string; proves: boolean };

/* How long whoever reads a task waits for a repository to say where a branch is. */
const READ_MS = 5_000;
const RUNS_SHOWN = 10;

/* A run proves something about the commit it pinned and no other: its proof stands while what is under review is at that
   very commit, and a new one makes it stale. Without either commit nobody can tell. */
export function freshnessOf(commitSha: string | null, head: string | null): Freshness {
  if (!commitSha || !head) return 'unknown';
  return commitSha === head ? 'current' : 'stale';
}

const unknown = (commitSha: string | null, why: string): Evidence => ({ commitSha, head: null, freshness: 'unknown', why });

function headOf(ctx: Reader, departmentId: string | null, branch: string, heads: Heads): Promise<CommitAt | null> {
  const key = `${departmentId}/${branch}`;
  const known = heads.get(key);
  if (known) return known;
  const read = repoAt(ctx, [departmentId])
    .then(found => (found ? ctx.readCommit(found.repo, { branch }, READ_MS) : null))
    .catch(() => ({ problem: "Hornhoof could not read this repository's settings." }));
  heads.set(key, read);
  return read;
}

/* Whether a run still proves its branch, asked of the repository now. It says why it cannot tell rather than throw, as a
   task should still show when the repository is away. */
export async function evidenceOf(ctx: Reader, run: Pick<Run, 'branch' | 'commitSha' | 'departmentId'>, heads: Heads = new Map()): Promise<Evidence> {
  const { branch, commitSha } = run;
  if (!branch || !commitSha) return unknown(commitSha, 'This run pinned no commit.');
  const at = await headOf(ctx, run.departmentId, branch, heads);
  if (!at) return unknown(commitSha, 'Its repository is no longer set.');
  if ('problem' in at) return unknown(commitSha, at.problem);
  const freshness = freshnessOf(commitSha, at.commitSha);
  return { commitSha, head: at.commitSha, freshness, why: freshness === 'stale' ? `The branch is at ${at.commitSha} now, not at the ${commitSha} this run checked.` : null };
}

/* The turn's branch, for the tasks about the turn's work as a whole, as its release: the turn such a task went into, else
   its department's open turn. */
async function turnBranchOf(db: Reader['db'], task: Task): Promise<string | null> {
  const [own] = task.turnId ? await db.select(only(turns, 'number')).from(turns).where(eq(turns.id, task.turnId)) : [];
  const turn = own ?? (await openTurnOf(db, task.companyId, task.departmentId));
  if (!turn || (await routeOf(db, task)).state.resultKind !== 'coordination') return null;
  return `turn-${turn.number}`;
}

/* Where a task's turn branch is: its product's repository, or for a task of the whole department every repository the
   department and its products keep, as a turn may change several. */
async function turnPlaces(db: Reader['db'], task: Task): Promise<string[]> {
  if (task.productId || !task.departmentId) return [task.productId, task.departmentId].filter((id): id is string => Boolean(id));
  const products = await db.select(idOnly(departments)).from(departments).where(eq(departments.parentId, task.departmentId));
  return [task.departmentId, ...products.map(p => p.id)];
}

/* The newest test runs of a task, and those on its turn's branch in its own repositories where that is what the task is
   about, each with the commit it pinned and whether it still proves its branch. */
export async function taskEvidence(ctx: Reader, task: Task): Promise<RunEvidence[]> {
  const branch = await turnBranchOf(ctx.db, task);
  const onTurnBranch = branch ? and(eq(testRuns.branch, branch), inArray(testRuns.departmentId, await turnPlaces(ctx.db, task))) : undefined;
  const runs = await ctx.db
    .select()
    .from(testRuns)
    .where(and(eq(testRuns.companyId, task.companyId), eq(testRuns.kind, 'tests'), or(eq(testRuns.taskId, task.id), onTurnBranch)))
    .orderBy(desc(testRuns.number))
    .limit(RUNS_SHOWN);
  const heads: Heads = new Map();
  return Promise.all(
    runs.map(async run => {
      const evidence = await evidenceOf(ctx, run, heads);
      return { run: run.number, status: run.status, branch: run.branch, command: commandShown(run.command), ...evidence, proves: run.status === 'passed' && evidence.freshness === 'current' };
    }),
  );
}
