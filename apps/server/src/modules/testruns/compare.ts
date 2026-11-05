import { and, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { departments, taskEvents, tasks, turns } from '../../db/schema.js';
import type { Tx } from '../tasks/engine.js';
import { repoAt } from '../departments/repository.js';
import type { RepoAddress } from './refs.js';

export type CompareResult = { complete: true; baseSha: string; headSha: string; paths: string[]; diff: string } | { complete: false; reason: string };
export type CompareReader = (repo: RepoAddress, refs: { base: string; head: string }, timeoutMs?: number) => Promise<CompareResult>;
const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const File = z.object({ filename: z.string().min(1), previous_filename: z.string().optional(), patch: z.string(), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() });
const Comparison = z.object({ base_commit: z.object({ sha: Sha }), commits: z.array(z.object({ sha: Sha })), total_commits: z.number().int().nonnegative(), status: z.enum(['ahead', 'behind', 'diverged', 'identical']), files: z.array(File).max(299) });

function trustedHost(at: URL): boolean {
  return at.protocol === 'https:' && at.host === 'github.com' && !at.username && !at.password && !at.search && !at.hash;
}

function githubName(url: string): string | null {
  try {
    const at = new URL(url);
    if (!trustedHost(at)) return null;
    const parts = at.pathname.replace(/^\/|\/$/g, '').replace(/\.git$/, '').split('/');
    return parts.length === 2 && parts.every(p => /^[a-z0-9][a-z0-9_.-]*$/i.test(p)) ? parts.join('/') : null;
  } catch { return null; }
}

function completePatch(file: z.infer<typeof File>): boolean {
  const lines = file.patch.split('\n');
  return lines.filter(line => line.startsWith('+')).length === file.additions && lines.filter(line => line.startsWith('-')).length === file.deletions;
}

function completeInventory(data: z.infer<typeof Comparison>): boolean {
  return data.total_commits === data.commits.length && data.files.every(completePatch);
}

function parsedComparison(body: unknown): CompareResult {
  const parsed = Comparison.safeParse(body);
  if (!parsed.success || !completeInventory(parsed.data)) return { complete: false, reason: 'incomplete-comparison' };
  const data = parsed.data;
  const headSha = data.commits.at(-1)?.sha ?? (data.status === 'identical' ? data.base_commit.sha : null);
  if (!headSha) return { complete: false, reason: 'incomplete-comparison' };
  return { complete: true, baseSha: data.base_commit.sha, headSha, paths: data.files.flatMap(f => f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]), diff: data.files.map(f => f.patch).join('\n') };
}

/* GitHub caps comparisons at 300 files and may omit a large/binary patch. A cap or
   missing lines mean unknown, never a clean diff. No redirect or remote error text
   can carry the repository token into a message. */
export const readCompare: CompareReader = async (repo, refs, timeoutMs = 10_000) => {
  const name = githubName(repo.url);
  if (!name) return { complete: false, reason: 'unsupported-repository' };
  try {
    const response = await fetch(`https://api.github.com/repos/${name}/compare/${encodeURIComponent(refs.base)}...${encodeURIComponent(refs.head)}`, {
      redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'hornhoof', 'x-github-api-version': '2022-11-28', ...(repo.token ? { authorization: `Bearer ${repo.token}` } : {}) },
    });
    if (!response.ok) { await response.body?.cancel(); return { complete: false, reason: 'compare-unavailable' }; }
    return parsedComparison(await response.json());
  } catch { return { complete: false, reason: 'compare-unavailable' }; }
};

export type CompareSnapshot = { result: CompareResult; startedAt: Date; taskId: string; repositoryUrl: string | null };

/* Called before the move's transaction and company lock. Older minimal contexts
   have no reader/config; that is unknown too. Repository secrets stay in memory. */
type OptionalComparison = Pick<Ctx, 'db'> & Partial<Pick<Ctx, 'config' | 'readCompare'>>;
function hasReader(ctx: OptionalComparison): ctx is Pick<Ctx, 'db' | 'config'> & { readCompare: CompareReader } {
  return Boolean(ctx.config && ctx.readCompare);
}
function closesCode(task: typeof tasks.$inferSelect, status: string | undefined): boolean {
  return Boolean(task.parentId && task.turnId && ['done', 'cancelled'].includes(status ?? ''));
}

export async function compareForTask(ctx: OptionalComparison, task: typeof tasks.$inferSelect, status: string | undefined): Promise<CompareSnapshot | undefined> {
  if (!closesCode(task, status)) return undefined;
  const snapshot: CompareSnapshot = { result: { complete: false, reason: 'compare-unavailable' }, startedAt: new Date(), taskId: task.id, repositoryUrl: null };
  if (!hasReader(ctx)) return snapshot;
  try {
    const [turn] = await ctx.db.select({ number: turns.number }).from(turns).where(eq(turns.id, task.turnId!));
    const [parent] = await ctx.db.select({ productId: tasks.productId }).from(tasks).where(eq(tasks.id, task.parentId!));
    const found = await repoAt({ db: ctx.db, config: ctx.config }, [task.productId, parent?.productId ?? null, task.departmentId]);
    if (found && turn) {
      snapshot.repositoryUrl = found.repo.url;
      snapshot.result = await ctx.readCompare(found.repo, { base: 'main', head: `turn-${turn.number}` });
    }
  } catch { /* A comparison failure never rolls back a submission. */ }
  return snapshot;
}

/* Keep only commit provenance, never repository patch contents, in a task event. */
export const comparisonProof = (result: CompareResult) => result.complete
  ? { complete: true, baseSha: result.baseSha, headSha: result.headSha }
  : { complete: false };

/* A department review can cover products with separate repositories. A snapshot
   of one repository says nothing about another: selecting both gates is safer. */
async function uncoveredRepository(db: Ctx['db'] | Tx, taskIds: string[], compared: string | null): Promise<boolean> {
  const code = await db.select({ productId: tasks.productId, departmentId: tasks.departmentId }).from(tasks)
    .innerJoin(taskEvents, and(eq(taskEvents.taskId, tasks.id), eq(taskEvents.kind, 'created'), sql`${taskEvents.data}->>'inTurnReview' = 'true'`))
    .where(inArray(tasks.id, taskIds));
  const ids = code.flatMap(task => [task.productId, task.departmentId]).filter((id): id is string => id !== null);
  const repos = await db.select({ id: departments.id, url: departments.repoUrl }).from(departments).where(inArray(departments.id, ids));
  const urls = new Map(repos.map(repo => [repo.id, repo.url]));
  return code.some(task => (urls.get(task.productId ?? '') ?? urls.get(task.departmentId ?? '')) !== compared);
}

/* If another merge closed while HTTP was in flight, this comparison may predate it.
   The caller already holds the company lock; only database reads happen here. */
export async function comparisonForReview(db: Ctx['db'] | Tx, taskIds: string[], snapshot?: CompareSnapshot): Promise<CompareResult> {
  if (!snapshot) return { complete: false, reason: 'compare-unavailable' };
  if (await uncoveredRepository(db, taskIds, snapshot.repositoryUrl)) return { complete: false, reason: 'uncovered-repository' };
  const [concurrent] = await db.select({ id: taskEvents.id }).from(taskEvents).where(and(inArray(taskEvents.taskId, taskIds), ne(taskEvents.taskId, snapshot.taskId), eq(taskEvents.kind, 'submitted'), sql`${taskEvents.data}->>'merged' = 'true'`, gt(taskEvents.createdAt, snapshot.startedAt))).limit(1);
  return concurrent ? { complete: false, reason: 'comparison-outdated' } : snapshot.result;
}
