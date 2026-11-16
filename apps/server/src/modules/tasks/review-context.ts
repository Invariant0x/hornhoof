import { randomUUID } from 'node:crypto';
import { Branch } from '@hornhoof/protocol';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, subscriptions, taskEvents } from '../../db/schema.js';
import { repoAt } from '../departments/repository.js';
import type { CompareResult } from '../testruns/compare.js';
import type { CommitWanted, RepoAddress } from '../testruns/refs.js';
import { modelProvider } from './echelons-policy.js';
import { refuse, type Task, type Tx } from './engine.js';
import { ReviewSha } from './review-schema.js';

export { ReviewSha } from './review-schema.js';
/* branch names where the work is when it is not on the task's own branch; commit, when given, must be its head. */
export const ReviewSubmission = z.object({ baseCommit: ReviewSha, branch: Branch.optional(), commit: ReviewSha.optional() }).strict();
const Source = z.object({ baseCommit: ReviewSha, commit: ReviewSha, paths: z.array(z.string()), changedLines: z.number().int().nonnegative() });
/* Records made before checks went local also hold the author's test runs and check quality, which are left out. */
export const ReviewRecord = z.object({
  revision: z.string().uuid(), commit: ReviewSha.nullable(), branch: z.string().nullable(),
  authorId: z.string().uuid(), authorVendor: z.string().nullable(),
  status: z.enum(['pinned', 'degraded']), reason: z.string().nullable(),
  source: Source.nullable().default(null),
});
export type Review = z.infer<typeof ReviewRecord>;
type Reader = Pick<Ctx, 'db'> & Partial<Pick<Ctx, 'config' | 'readCommit' | 'readCompare'>>;
type Store = Ctx['db'] | Tx;
type Pin = Pick<Review, 'commit' | 'branch' | 'status' | 'reason'> & { commit: string; branch: string };

/* CompareResult carries validated hunk patches, whose increment/decrement lines count too. */
export const changedLines = (diff: string): number => diff.split('\n').filter(line => /^[+-]/.test(line)).length;
/* The lines of a comparison: those its patches show, and those GitHub counted in a file it showed no patch of. */
const comparedLines = (compared: Extract<CompareResult, { complete: true }>): number =>
  changedLines(compared.diff) + (compared.omitted ?? []).reduce((sum, file) => sum + file.additions + file.deletions, 0);
export const exactComparison = (result: CompareResult, base: string, head: string): result is Extract<CompareResult, { complete: true }> => result.complete && result.baseSha === base && result.headSha === head;

export async function authorVendor(db: Store, authorId: string): Promise<string | null> {
  const [row] = await db.select({ provider: subscriptions.provider }).from(agents)
    .leftJoin(subscriptions, eq(subscriptions.id, agents.subscriptionId)).where(eq(agents.id, authorId));
  return row?.provider ? modelProvider(row.provider) : null;
}

/* No stage passes without a commit: a branch that cannot be read refuses the submission with git's reason. */
async function readPin(read: Ctx['readCommit'], repo: RepoAddress, want: CommitWanted, named?: string): Promise<Pin> {
  let at: Awaited<ReturnType<Ctx['readCommit']>>;
  try { at = await read(repo, want, 5_000); }
  catch { throw refuse(409, 'repo_invalid', 'The repository could not be read, so the submission has no commit. Try again.'); }
  if ('problem' in at) throw refuse(409, 'repo_invalid', at.problem);
  if (!ReviewSha.safeParse(at.commitSha).success) throw refuse(409, 'repo_invalid', `The branch ${at.branch} has no full commit name.`);
  if (named && named !== at.commitSha) throw refuse(409, 'task_changed', `The branch ${at.branch} is at ${at.commitSha}, not at the named commit ${named}. Push it or name the head.`);
  return { commit: at.commitSha, branch: at.branch, status: 'pinned', reason: null };
}

async function sourceAt(ctx: Reader, repo: RepoAddress, commit: string, input?: z.infer<typeof ReviewSubmission>): Promise<NonNullable<Review['source']>> {
  if (!input) throw refuse(400, 'task_invalid', 'Name review.baseCommit, the commit the change starts from.');
  let compared: Awaited<ReturnType<NonNullable<Ctx['readCompare']>>> | null = null;
  try { compared = ctx.readCompare ? await ctx.readCompare(repo, { base: input.baseCommit, head: commit }, 10_000) : null; }
  catch { /* An incomplete source is refused below, never an invented inventory. */ }
  if (!compared || !exactComparison(compared, input.baseCommit, commit)) throw refuse(409, 'repo_invalid', `The change from ${input.baseCommit} to ${commit} could not be compared. Check that the base is in the branch's history.`);
  return { baseCommit: input.baseCommit, commit, paths: [...new Set(compared.paths)], changedLines: comparedLines(compared) };
}

/* Resolve the repository before a task transaction; an outage refuses the submission rather than record it without a
   commit. A repair keeps the branch of the candidate it repairs unless another is named. */
export async function captureReview(ctx: Reader, task: Task, input?: z.infer<typeof ReviewSubmission>, branch?: string): Promise<Review> {
  if (!ctx.config || !ctx.readCommit || !task.executorAgentId) throw refuse(409, 'repo_invalid', 'The repository cannot be read here, so the submission has no commit.');
  const found = await repoAt({ db: ctx.db, config: ctx.config }, [task.productId, task.departmentId]);
  if (!found) throw refuse(409, 'repo_invalid', 'This task has no repository, so it has no code candidate. Report its result instead.');
  const named = input?.branch ?? branch;
  const pin = await readPin(ctx.readCommit, found.repo, named ? { branch: named } : { task: task.number }, input?.commit);
  return { ...pin, revision: randomUUID(), authorId: task.executorAgentId, authorVendor: await authorVendor(ctx.db, task.executorAgentId), source: await sourceAt(ctx, found.repo, pin.commit, input) };
}

/* Event records, rather than a live branch lookup, define what a reviewer was assigned. */
export async function reviewContext(db: Store, taskId: string): Promise<Review | null> {
  const records = await db.select({ data: taskEvents.data }).from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), inArray(taskEvents.kind, ['submitted', 'created']))).orderBy(desc(taskEvents.id));
  for (const record of records) {
    const parsed = ReviewRecord.safeParse(record.data.review);
    if (parsed.success) return parsed.data;
  }
  return null;
}
