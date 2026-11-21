import { ownBranch } from '@hornhoof/protocol';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { tasks } from '../../db/schema.js';
import type { BranchesAt, RepoAddress } from '../testruns/refs.js';
import { GitHubRateLimited } from '../testruns/github-limit.js';
import { worksIn, type Reader } from './inside.js';
import { repoAt } from './repository.js';

/* A task of the department that was accepted or handed in, whose branch is not in the main line yet: merged is false, or
   null where the repository cannot tell, as one off GitHub. */
export type DepartmentBranch = { task: number; title: string; status: 'done' | 'review'; branch: string; commit: string; merged: false | null };
export type DepartmentBranches = { branches: DepartmentBranch[]; problem: string | null };

/* The newest tasks looked at, and the most branches said. */
const LOOKED_AT = 40;
const SHOWN = 20;
/* A department's page and a task's read wait no longer than this for the repository. */
const READ_MS = 5_000;

type Readers = Pick<Ctx, 'db' | 'config'> & Partial<Pick<Ctx, 'readBranches' | 'readMerged' | 'githubLimits'>>;
type Repo = RepoAddress & { branch: string };
type Found = { task: typeof tasks.$inferSelect; repo: Repo; branch: string; commit: string };

const NONE: DepartmentBranches = { branches: [], problem: null };

/* The branch of each task in its repository's heads, if it has exactly one. */
function branchOf(task: { number: number }, heads: Record<string, string>): { branch: string; commit: string } | null {
  const own = ownBranch(Object.keys(heads), task.number);
  return 'branch' in own ? { branch: own.branch, commit: heads[own.branch]! } : null;
}

/* Each repository once: the tasks of a product go to its repository when it has one, the others to the department's. */
async function headsByRepo(ctx: Readers & Pick<Required<Readers>, 'readBranches'>, rows: (typeof tasks.$inferSelect)[]) {
  const repos = new Map<string, { repo: Repo; read: Promise<BranchesAt> } | null>();
  for (const task of rows) {
    const key = task.productId ?? '';
    if (repos.has(key)) continue;
    const at = await repoAt(ctx, [task.productId, task.departmentId]);
    repos.set(key, at ? { repo: at.repo, read: ctx.readBranches(at.repo, READ_MS) } : null);
  }
  return repos;
}

type Places = Awaited<ReturnType<typeof headsByRepo>>;

/* The newest accepted and handed-in tasks of the department, but the one being read. */
function lookedAt(ctx: Readers, departmentId: string, except: string | null) {
  return ctx.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.departmentId, departmentId), inArray(tasks.status, ['done', 'review']), except ? ne(tasks.id, except) : undefined))
    .orderBy(desc(tasks.number))
    .limit(LOOKED_AT);
}

/* Each task with a branch of its own in its repository, and what kept a repository from saying its branches. */
async function onBranches(rows: (typeof tasks.$inferSelect)[], repos: Places): Promise<{ found: Found[]; problems: string[] }> {
  const found: Found[] = [];
  const problems = new Set<string>();
  for (const task of rows) {
    const place = repos.get(task.productId ?? '');
    const read = place ? await place.read : null;
    if (read && 'problem' in read) problems.add(read.problem);
    const at = read && 'heads' in read ? branchOf(task, read.heads) : null;
    if (at) found.push({ task, repo: place!.repo, ...at });
  }
  return { found, problems: [...problems] };
}

/* The branches GitHub does not show in the main line, and those it cannot tell of. */
async function notMerged(ctx: Readers, found: Found[]): Promise<DepartmentBranch[]> {
  const readMerged = ctx.readMerged ?? (async () => null);
  const merged = await Promise.all(found.map(async f => {
    if (ctx.githubLimits?.known(f.repo)) return null;
    try { return await readMerged(f.repo, { base: f.repo.branch, head: f.commit }, READ_MS); }
    catch (error) {
      if (!(error instanceof GitHubRateLimited)) throw error;
      ctx.githubLimits?.refused(f.repo, error.limit);
      return null;
    }
  }));
  return found.flatMap((f, i): DepartmentBranch[] =>
    merged[i] === true ? [] : [{ task: f.task.number, title: f.task.title, status: f.task.status as 'done' | 'review', branch: f.branch, commit: f.commit, merged: merged[i] === false ? false : null }]);
}

/* What the department's accepted and handed-in tasks left on branches the main line does not have yet, newest first. A
   task in the department's own repository counts, as does one of its products. except: the task being read. */
export async function departmentBranches(ctx: Readers, departmentId: string, except: string | null = null): Promise<DepartmentBranches> {
  if (!ctx.readBranches) return NONE;
  const rows = await lookedAt(ctx, departmentId, except);
  const { found, problems } = await onBranches(rows, await headsByRepo({ ...ctx, readBranches: ctx.readBranches }, rows));
  return { branches: (await notMerged(ctx, found)).slice(0, SHOWN), problem: problems[0] ?? null };
}

/* What an agent reading a task of its department learns of the work before it, only when there is something to say. An
   agent of another department given the task learns nothing of it, nor why it could not be read. */
export async function earlierWork(ctx: Readers, reader: Reader, task: { id: string; departmentId: string | null }): Promise<{ departmentBranches?: DepartmentBranch[]; departmentBranchesProblem?: string }> {
  if (!task.departmentId || !(await worksIn(ctx.db, reader, task.departmentId))) return {};
  const { branches, problem } = await departmentBranches(ctx, task.departmentId, task.id);
  return { ...(branches.length ? { departmentBranches: branches } : {}), ...(problem ? { departmentBranchesProblem: problem } : {}) };
}
