import { createHash } from 'node:crypto';
import { ownBranch } from '@hornhoof/protocol';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { tasks } from '../../db/schema.js';
import type { MergeReader } from '../testruns/compare.js';
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
/* Every task read of every agent of the department says these branches, and GitHub's request limit is the whole server's:
   one read asks GitHub's compare of no more branches than this, and cannot tell of the others yet, which a later one asks of. */
export const COMPARES_PER_READ = 10;
/* A branch not in main, or one GitHub could not tell of, is asked of again once main moved, or after this at most. */
export const UNSETTLED_MS = 5 * 60_000;
const ANSWERS_KEPT = 4_096;

type Readers = Pick<Ctx, 'db' | 'config' | 'clock' | 'mergedAnswers'> & Partial<Pick<Ctx, 'readBranches' | 'readMerged'>>;
type Repo = RepoAddress & { branch: string };
type Found = { task: typeof tasks.$inferSelect; repo: Repo; branch: string; commit: string; main: string | null };
type Said = { merged: boolean | null; main: string | null; at: number };

/* What GitHub said of whether a branch's commit is in the main line, by repository, token, main line and commit. A commit in
   the main line stays there, so that answer holds for good; any other holds while main is at the commit it was at then, and
   for a few minutes at most. The oldest go first once there are many. */
export class MergedAnswers {
  private readonly said = new Map<string, Said>();

  static key(repo: Repo, commit: string): string {
    return createHash('sha256').update(JSON.stringify([repo.url, repo.token, repo.branch, commit])).digest('hex');
  }

  get(key: string, main: string | null, now: number): boolean | null | undefined {
    const said = this.said.get(key);
    return said && (said.merged === true || (said.main === main && now - said.at < UNSETTLED_MS)) ? said.merged : undefined;
  }

  keep(key: string, said: Said): void {
    this.said.delete(key);
    if (this.said.size >= ANSWERS_KEPT) this.said.delete(this.said.keys().next().value!);
    this.said.set(key, said);
  }
}

const NONE: DepartmentBranches = { branches: [], problem: null };

/* The branch of each task in its repository's heads, if it has exactly one, and where the main line is. */
function branchOf(task: { number: number }, heads: Record<string, string>, main: string): { branch: string; commit: string; main: string | null } | null {
  const own = ownBranch(Object.keys(heads), task.number);
  return 'branch' in own ? { branch: own.branch, commit: heads[own.branch]!, main: heads[main] ?? null } : null;
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
    const at = read && 'heads' in read ? branchOf(task, read.heads, place!.repo.branch) : null;
    if (at) found.push({ task, repo: place!.repo, ...at });
  }
  return { found, problems: [...problems] };
}

/* GitHub's answer for one branch, kept for the reads after. While the request limit of the repository's token is used up,
   the server's readers ask GitHub nothing until its reset and say so: no answer to keep, and unknown for now. */
async function askMerged(ctx: Readers, readMerged: MergeReader, f: Found, key: string, now: number): Promise<boolean | null> {
  try {
    const merged = await readMerged(f.repo, { base: f.repo.branch, head: f.commit }, READ_MS);
    ctx.mergedAnswers.keep(key, { merged, main: f.main, at: now });
    return merged;
  } catch (error) {
    if (error instanceof GitHubRateLimited) return null;
    throw error;
  }
}

/* Whether a branch is in main: as GitHub said before where that still holds, else asked now while the read may still ask,
   else unknown. It counts what the read may still ask before its first wait, so the newest branches are the ones asked. */
async function mergedOf(ctx: Readers, f: Found, read: { left: number; now: number }): Promise<boolean | null> {
  const key = MergedAnswers.key(f.repo, f.commit);
  const said = ctx.mergedAnswers.get(key, f.main, read.now);
  if (said !== undefined) return said;
  if (!ctx.readMerged || read.left === 0) return null;
  read.left--;
  return askMerged(ctx, ctx.readMerged, f, key, read.now);
}

/* The branches GitHub does not show in the main line, and those it cannot tell of, asking it of a few at most. */
async function notMerged(ctx: Readers, found: Found[]): Promise<DepartmentBranch[]> {
  const read = { left: COMPARES_PER_READ, now: ctx.clock() };
  const merged = await Promise.all(found.map(f => mergedOf(ctx, f, read)));
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
