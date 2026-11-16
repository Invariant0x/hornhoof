import { and, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { companies, departments, turns } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { repoAt } from '../departments/repository.js';
import { refuse, type Task, type Tx } from './engine.js';
import { exactComparison } from './review-context.js';
import { ensureOpenTurn, openTurnOf } from './turn-department.js';

/* Where an accepted result goes, and how it joins a release. The open turn of a top-level department gathers the results
   accepted into its branch turn-<number>; its release takes that branch to main. A product, or a part of a department, that
   keeps a repository of its own has no turn: its results go to its main line straight, with a person approving each. */

type Reader = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'config' | 'readCommit' | 'readCompare' | 'readMerged' | 'readBranches' | 'createBranch'>>;
type Turn = typeof turns.$inferSelect;
type Repo = NonNullable<Awaited<ReturnType<typeof repoAt>>>['repo'];
export type IntegrationTarget = { repo: Repo; branch: string; turn: Turn | null };

const lockCompany = (tx: Tx, companyId: string) => tx.select(idOnly(companies)).from(companies).where(eq(companies.id, companyId)).for('no key update');

/* The repository the result is in and the branch it goes to: its department's open turn, opened if it has none, or its own
   main line. None where it keeps no repository. */
export async function integrationTarget(ctx: Reader, task: Pick<Task, 'companyId' | 'productId' | 'departmentId'>): Promise<IntegrationTarget | null> {
  if (!ctx.config) return null;
  const found = await repoAt({ db: ctx.db, config: ctx.config }, [task.productId, task.departmentId]);
  if (!found) return null;
  if (found.department.parentId) return { repo: found.repo, branch: found.repo.branch, turn: null };
  const turn = await openTurnOf(ctx.db, task.companyId, found.department.id)
    ?? await ctx.db.transaction(async tx => { await lockCompany(tx, task.companyId); return ensureOpenTurn(tx, task.companyId, found.department.id); });
  return { repo: found.repo, branch: `turn-${turn.number}`, turn };
}

/* Whether the result goes to its own main line straight, read without opening any turn: the first of its product and
   department that keeps a repository is a part of a department. A top-level department's results join its open turn, and
   one that keeps no repository has nothing to integrate. */
export async function goesStraightToMain(db: Ctx['db'] | Tx, task: Pick<Task, 'productId' | 'departmentId'>): Promise<boolean> {
  for (const id of [task.productId, task.departmentId]) {
    if (!id) continue;
    const [d] = await db.select({ repoUrl: departments.repoUrl, parentId: departments.parentId }).from(departments).where(eq(departments.id, id));
    if (d?.repoUrl) return d.parentId !== null;
  }
  return false;
}

/* A branch at head holds commit: it is there, or the branch went on from it. GitHub says so by the status of their comparison,
   however many files it has; where it cannot, only a whole comparison proves it. Anything unread proves nothing. */
export async function branchHolds(ctx: Reader, repo: Repo, head: string, commit: string): Promise<boolean> {
  if (head === commit) return true;
  try {
    const merged = await ctx.readMerged?.(repo, { base: head, head: commit }, 10_000);
    if (merged !== undefined && merged !== null) return merged;
    const compared = await ctx.readCompare?.(repo, { base: commit, head }, 10_000);
    return !!compared && exactComparison(compared, commit, head);
  } catch {
    return false;
  }
}

/* The head of a branch as the repository says it now, or why it could not say. */
export async function headOf(ctx: Reader, repo: Repo, branch: string): Promise<string | null> {
  if (!ctx.readCommit) return null;
  try {
    const at = await ctx.readCommit(repo, { branch }, 5_000);
    return 'problem' in at || at.branch !== branch ? null : at.commitSha;
  } catch {
    return null;
  }
}

type Maker = Pick<Ctx, 'db'> & Partial<Pick<Ctx, 'readBranches' | 'createBranch'>>;
type Heads = Awaited<ReturnType<NonNullable<Ctx['readBranches']>>>;
export type TurnBranch = { head: string; made: boolean } | { problem: string };

/* Where a turn's branch is made from: the commit the turn starts from, else the release it came from, else main's head. */
const startOf = (turn: Turn, heads: Record<string, string>, main: string): string | undefined => turn.startCommit ?? turn.baseCommit ?? heads[main];

/* The branch another made while this one was being made, read again after the push was refused. */
function madeMeanwhile(after: Heads, branch: string): TurnBranch | null {
  const head = 'problem' in after ? undefined : after.heads[branch];
  return head ? { head, made: false } : null;
}

/* A turn that started nowhere starts from the commit its branch was made from. */
async function keepStart(db: Maker['db'], turn: Turn, from: string): Promise<void> {
  if (turn.startCommit) return;
  await db.update(turns).set({ startCommit: from }).where(and(eq(turns.id, turn.id), eq(turns.status, 'open'), isNull(turns.startCommit)));
}

/* The branch of an open turn, made where the repository has none yet, from where the turn starts. It is only ever made, never
   moved: one that is there, or one another made meanwhile, stays as it is. */
export async function ensureTurnBranch(ctx: Maker, repo: Repo, turn: Turn): Promise<TurnBranch> {
  const branch = `turn-${turn.number}`;
  const { readBranches, createBranch } = ctx;
  if (!readBranches || !createBranch) return { problem: `${branch} could not be read. Try again.` };
  const heads = () => readBranches(repo, 5_000).catch((): Heads => ({ problem: `Hornhoof could not read the branches of ${repo.url}.` }));
  const before = await heads();
  if ('problem' in before) return { problem: `${branch} could not be read: ${before.problem}` };
  const there = before.heads[branch];
  if (there) return { head: there, made: false };
  const from = startOf(turn, before.heads, repo.branch);
  if (!from) return { problem: `${branch} is not in ${repo.url}, and neither is ${repo.branch} to make it from.` };
  const made = await createBranch(repo, branch, from, 10_000).catch(() => ({ problem: `Hornhoof could not create the branch ${branch} in ${repo.url}.` }));
  if ('problem' in made) return madeMeanwhile(await heads(), branch) ?? { problem: `${branch} is not in the repository yet, and ${made.problem}` };
  await keepStart(ctx.db, turn, from);
  return { head: from, made: true };
}

/* The head of the turn branch, made first where the repository has none yet, as after a migration or a repository just
   connected. */
async function turnHead(ctx: Reader, target: IntegrationTarget & { turn: Turn }): Promise<string> {
  const head = await headOf(ctx, target.repo, target.branch);
  if (head) return head;
  const branch = await ensureTurnBranch(ctx, target.repo, target.turn);
  if ('problem' in branch) throw refuse(409, 'task_changed', branch.problem);
  return branch.head;
}

/* The turn branch holds the result's commit, and the commit the turn started from, the head of the turn before it as that
   one was released: else what that turn left out would be lost from every release. */
export async function requireInTurn(ctx: Reader, target: IntegrationTarget & { turn: Turn }, commit: string, how: string): Promise<string> {
  const head = await turnHead(ctx, target);
  if (!(await branchHolds(ctx, target.repo, head, commit))) throw refuse(409, 'task_changed', `${target.branch} does not hold ${commit}: ${how}`);
  const start = target.turn.startCommit;
  if (start && !(await branchHolds(ctx, target.repo, head, start))) {
    throw refuse(409, 'task_invalid', `${target.branch} does not hold ${start}, the head of the turn before it as that one was released. Create ${target.branch} from ${start}, or take ${start} into it, then fast-forward it again.`);
  }
  return head;
}

/* In the transaction that gives the task its turn, with the company held first: the turn it was read into is still its
   department's open one. A release closed it meanwhile, so the result goes into the next one. */
export async function requireSameTurn(tx: Tx, task: Pick<Task, 'number' | 'companyId'>, turn: Turn, commit: string): Promise<void> {
  const [open] = await tx.select().from(turns).where(and(eq(turns.companyId, task.companyId), eq(turns.departmentId, turn.departmentId!), eq(turns.status, 'open')));
  if (open?.id === turn.id) return;
  const next = open ? `turn-${open.number}` : 'the next turn branch';
  throw refuse(409, 'task_changed', `Turn ${turn.number} was released while #${task.number} joined it, so the result goes into the next release: fast-forward ${next} to ${commit} and close #${task.number} again. If ${next} already holds ${commit}, it is the same commit and needs no new check; only a merge into the candidate makes a new candidate to check again.`);
}
