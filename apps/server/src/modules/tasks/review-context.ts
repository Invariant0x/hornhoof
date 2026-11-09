import { randomUUID } from 'node:crypto';
import { Branch } from '@hornhoof/protocol';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, subscriptions, taskEvents, testParts, testRuns } from '../../db/schema.js';
import { repoAt } from '../departments/repository.js';
import type { CompareResult } from '../testruns/compare.js';
import type { CommitWanted, RepoAddress } from '../testruns/refs.js';
import { refuse, type Task, type Tx } from './engine.js';
import { authorQuality, CheckReceiptPart, checkReceiptPart, QualityEvidence, unavailableQuality } from './review-quality.js';
import { verifiedReuse } from './review-reuse.js';
import { ReviewSha } from './review-schema.js';

export { ReviewSha } from './review-schema.js';
const VENDORS: Partial<Record<string, string>> = { anthropic_api: 'claude', openai_api: 'codex' };
export const reviewVendor = (provider: string): string => VENDORS[provider] ?? provider;
const Counts = z.object({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), other: z.number().int().nonnegative() });
const Run = z.object({ id: z.string().uuid(), number: z.number().int(), authorId: z.string().uuid(), commit: z.string().nullable(), command: z.string(), status: z.string(), parts: Counts, receipts: z.array(CheckReceiptPart).default([]), verified: z.boolean() });
/* branch names where the work is when it is not on the task's own branch; commit, when given, must be its head. */
export const ReviewSubmission = z.object({ baseCommit: ReviewSha, branch: Branch.optional(), commit: ReviewSha.optional() }).strict();
const Source = z.object({ baseCommit: ReviewSha, commit: ReviewSha, paths: z.array(z.string()), changedLines: z.number().int().nonnegative() });
const CHECKED_STAGES = ['review', 'cleanup', 'security'] as const;
/* A checking stage's last verdict on this task, and the change from the commit it checked to the one handed in now: the
   paths the candidate changes that stayed as they were keep that verdict. With no comparison (a rewritten history, an
   unreadable repository) there is no change to look at alone, and the stage checks the whole candidate again. */
const Since = z.object({
  stage: z.enum(CHECKED_STAGES), candidateId: z.string().uuid(), commit: ReviewSha, pass: z.boolean(),
  delta: z.object({ paths: z.array(z.string()), changedLines: z.number().int().nonnegative(), unchangedPaths: z.array(z.string()) }).nullable(),
  reason: z.string().nullable(),
});
export type Checked = Pick<z.infer<typeof Since>, 'stage' | 'candidateId' | 'commit' | 'pass'>;
const LastVerdict = z.object({ stage: z.enum(CHECKED_STAGES), candidateId: z.string().uuid(), reviewedCommit: ReviewSha, pass: z.boolean() });
export const ReviewRecord = z.object({
  revision: z.string().uuid(), commit: ReviewSha.nullable(), branch: z.string().nullable(),
  authorId: z.string().uuid(), authorVendor: z.string().nullable(),
  status: z.enum(['pinned', 'degraded']), reason: z.string().nullable(),
  gateCounts: z.object({ source: z.literal('review-lifecycle').default('review-lifecycle'), passed: z.number().int().nonnegative(), returned: z.number().int().nonnegative() }),
  quality: QualityEvidence.default(unavailableQuality),
  qualityTaskId: z.string().uuid().optional(),
  runs: z.array(Run), source: Source.nullable().default(null),
  since: z.array(Since).default([]),
});
export type Review = z.infer<typeof ReviewRecord>;
type Reader = Pick<Ctx, 'db'> & Partial<Pick<Ctx, 'config' | 'readCommit' | 'readCompare'>>;
type Store = Ctx['db'] | Tx;
type Pin = Pick<Review, 'commit' | 'branch' | 'status' | 'reason'> & { commit: string; branch: string };
type TestRun = typeof testRuns.$inferSelect;
type Part = typeof testParts.$inferSelect;

/* CompareResult carries validated hunk patches, whose increment/decrement lines count too. */
export const changedLines = (diff: string): number => diff.split('\n').filter(line => /^[+-]/.test(line)).length;
/* The lines of a comparison: those its patches show, and those GitHub counted in a file it showed no patch of. */
const comparedLines = (compared: Extract<CompareResult, { complete: true }>): number =>
  changedLines(compared.diff) + (compared.omitted ?? []).reduce((sum, file) => sum + file.additions + file.deletions, 0);
export const exactComparison = (result: CompareResult, base: string, head: string): result is Extract<CompareResult, { complete: true }> => result.complete && result.baseSha === base && result.headSha === head;

export async function authorVendor(db: Store, authorId: string): Promise<string | null> {
  const [row] = await db.select({ provider: subscriptions.provider }).from(agents)
    .leftJoin(subscriptions, eq(subscriptions.id, agents.subscriptionId)).where(eq(agents.id, authorId));
  return row?.provider ? reviewVendor(row.provider) : null;
}

async function verifiedRun(run: TestRun, parts: Part[], commit: string | null): Promise<boolean> {
  if (commit === null || run.commitSha !== commit || run.status !== 'passed' || parts.length !== run.parts) return false;
  return parts.length ? parts.every(part => part.status === 'passed' && part.commit === commit && part.exitCode === 0 && !part.error) : verifiedReuse(run);
}

async function runRecord(run: TestRun, allParts: Part[], commit: string | null): Promise<Review['runs'][number]> {
  const parts = allParts.filter(part => part.runId === run.id);
  const passed = parts.filter(part => part.status === 'passed').length;
  const failed = parts.filter(part => part.status === 'failed').length;
  return { id: run.id, number: run.number, authorId: run.agentId, commit: run.commitSha, command: run.command, status: run.status, parts: { passed, failed, other: parts.length - passed - failed }, receipts: parts.map(checkReceiptPart), verified: await verifiedRun(run, parts, commit) };
}

async function authorRuns(db: Store, task: Task, commit: string | null, branch?: string): Promise<Review['runs']> {
  const scope = branch ? and(eq(testRuns.branch, branch), inArray(testRuns.departmentId, [task.productId, task.departmentId].filter((id): id is string => id !== null))) : and(eq(testRuns.taskId, task.id), eq(testRuns.agentId, task.executorAgentId!));
  const runs = await db.select().from(testRuns).where(and(eq(testRuns.companyId, task.companyId), scope, eq(testRuns.kind, 'tests'))).orderBy(desc(testRuns.number));
  const parts = runs.length ? await db.select().from(testParts).where(inArray(testParts.runId, runs.map(run => run.id))) : [];
  return Promise.all(runs.map(run => runRecord(run, parts, commit)));
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

/* What each checking stage last decided on this task, in route order. */
export async function lastVerdicts(db: Store, taskId: string): Promise<Checked[]> {
  const rows = await db.select({ data: taskEvents.data }).from(taskEvents).where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.kind, 'verdict'))).orderBy(desc(taskEvents.id));
  const last = new Map<Checked['stage'], Checked>();
  for (const { data } of rows) {
    const verdict = LastVerdict.safeParse(data);
    if (verdict.success && !last.has(verdict.data.stage)) last.set(verdict.data.stage, { stage: verdict.data.stage, candidateId: verdict.data.candidateId, commit: verdict.data.reviewedCommit, pass: verdict.data.pass });
  }
  return CHECKED_STAGES.flatMap(stage => last.get(stage) ?? []);
}

async function sinceChecked(ctx: Reader, repo: RepoAddress, source: NonNullable<Review['source']>, checked: Checked): Promise<Review['since'][number]> {
  let compared: CompareResult | null = null;
  try { compared = ctx.readCompare ? await ctx.readCompare(repo, { base: checked.commit, head: source.commit }, 10_000) : null; }
  catch { /* An unread comparison shows no change, so nothing is taken over from the earlier verdict. */ }
  if (!compared || !exactComparison(compared, checked.commit, source.commit)) return { ...checked, delta: null, reason: compared?.complete === false ? compared.reason : 'The change could not be compared.' };
  const paths = [...new Set(compared.paths)];
  return { ...checked, delta: { paths, changedLines: comparedLines(compared), unchangedPaths: source.paths.filter(path => !paths.includes(path)) }, reason: null };
}

async function gateCounts(db: Store, taskId: string): Promise<Review['gateCounts']> {
  const verdicts = await db.select({ data: taskEvents.data }).from(taskEvents).where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.kind, 'verdict')));
  return { source: 'review-lifecycle', passed: verdicts.filter(v => v.data.pass === true).length, returned: verdicts.filter(v => v.data.pass === false).length };
}

/* Resolve the repository before a task transaction; an outage refuses the submission rather than record it without a
   commit. A repair keeps the branch of the candidate it repairs unless another is named. */
export async function captureReview(ctx: Reader, task: Task, input?: z.infer<typeof ReviewSubmission>, branch?: string, checked: Checked[] = []): Promise<Review> {
  if (!ctx.config || !ctx.readCommit || !task.executorAgentId) throw refuse(409, 'repo_invalid', 'The repository cannot be read here, so the submission has no commit.');
  const found = await repoAt({ db: ctx.db, config: ctx.config }, [task.productId, task.departmentId]);
  if (!found) throw refuse(409, 'repo_invalid', 'This task has no repository, so it has no code candidate. Report its result instead.');
  const named = input?.branch ?? branch;
  const pin = await readPin(ctx.readCommit, found.repo, named ? { branch: named } : { task: task.number }, input?.commit);
  const source = await sourceAt(ctx, found.repo, pin.commit, input);
  const since = await Promise.all(checked.map(stage => sinceChecked(ctx, found.repo, source, stage)));
  return { ...pin, revision: randomUUID(), authorId: task.executorAgentId, authorVendor: await authorVendor(ctx.db, task.executorAgentId), gateCounts: await gateCounts(ctx.db, task.id), qualityTaskId: task.id, quality: await authorQuality(ctx.db, task.id, pin.commit, task.executorAgentId), runs: await authorRuns(ctx.db, task, pin.commit), source, since };
}

/* Keep immutable submission facts separate from the consumer's current receipt validation. */
export async function visibleReview(db: Store, taskId: string, review: Review): Promise<Review & { qualityAtSubmission: Review['quality'] }> {
  const sourceId = review.qualityTaskId ?? review.quality.record?.taskId ?? taskId;
  return { ...review, qualityAtSubmission: review.quality, quality: await authorQuality(db, sourceId, review.commit, review.authorId) };
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
