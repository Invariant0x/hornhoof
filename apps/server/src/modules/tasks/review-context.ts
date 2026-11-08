import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, subscriptions, taskEvents, testParts, testRuns } from '../../db/schema.js';
import { repoAt } from '../departments/repository.js';
import type { CompareResult } from '../testruns/compare.js';
import type { RepoAddress } from '../testruns/refs.js';
import type { Task, Tx } from './engine.js';
import { authorQuality, CheckReceiptPart, checkReceiptPart, QualityEvidence, unavailableQuality } from './review-quality.js';
import { verifiedReuse } from './review-reuse.js';
import { ReviewSha } from './review-schema.js';

export { ReviewSha } from './review-schema.js';
const VENDORS: Partial<Record<string, string>> = { anthropic_api: 'claude', openai_api: 'codex' };
export const reviewVendor = (provider: string): string => VENDORS[provider] ?? provider;
const Counts = z.object({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), other: z.number().int().nonnegative() });
const Run = z.object({ id: z.string().uuid(), number: z.number().int(), authorId: z.string().uuid(), commit: z.string().nullable(), command: z.string(), status: z.string(), parts: Counts, receipts: z.array(CheckReceiptPart).default([]), verified: z.boolean() });
export const ReviewSubmission = z.object({ baseCommit: ReviewSha, authorCheckPlan: z.string().trim().min(1).max(3800).optional() }).strict();
const Source = z.object({ baseCommit: ReviewSha, commit: ReviewSha, paths: z.array(z.string()), changedLines: z.number().int().nonnegative() });
export const ReviewRecord = z.object({
  revision: z.string().uuid(), commit: ReviewSha.nullable(), branch: z.string().nullable(),
  authorId: z.string().uuid(), authorVendor: z.string().nullable(),
  status: z.enum(['pinned', 'degraded']), reason: z.string().nullable(),
  gateCounts: z.object({ source: z.literal('review-lifecycle').default('review-lifecycle'), passed: z.number().int().nonnegative(), returned: z.number().int().nonnegative() }),
  quality: QualityEvidence.default(unavailableQuality),
  qualityTaskId: z.string().uuid().optional(),
  runs: z.array(Run), source: Source.nullable().default(null),
});
export type Review = z.infer<typeof ReviewRecord>;
type Reader = Pick<Ctx, 'db'> & Partial<Pick<Ctx, 'config' | 'readCommit' | 'readCompare'>>;
type Store = Ctx['db'] | Tx;
type Pin = Pick<Review, 'commit' | 'branch' | 'status' | 'reason'>;
type TestRun = typeof testRuns.$inferSelect;
type Part = typeof testParts.$inferSelect;
const UNAVAILABLE: Pin = { commit: null, branch: null, status: 'degraded', reason: 'commit-unavailable' };

/* CompareResult carries validated hunk patches, whose increment/decrement lines count too. */
export const changedLines = (diff: string): number => diff.split('\n').filter(line => /^[+-]/.test(line)).length;
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

async function readPin(read: Ctx['readCommit'], repo: RepoAddress, task: number): Promise<Pin> {
  try {
    const at = await read(repo, { task }, 5_000);
    if ('commitSha' in at && ReviewSha.safeParse(at.commitSha).success) return { commit: at.commitSha, branch: at.branch, status: 'pinned', reason: null };
  } catch { /* Remote text never becomes an audit record. */ }
  return UNAVAILABLE;
}

async function sourceAt(ctx: Reader, repo: RepoAddress, commit: string | null, input?: z.infer<typeof ReviewSubmission>): Promise<Review['source']> {
  if (!commit || !input || !ctx.readCompare) return null;
  try {
    const compared = await ctx.readCompare(repo, { base: input.baseCommit, head: commit }, 10_000);
    if (exactComparison(compared, input.baseCommit, commit)) return { baseCommit: input.baseCommit, commit, paths: [...new Set(compared.paths)], changedLines: changedLines(compared.diff) };
  } catch { /* An incomplete source is degraded, never an invented inventory. */ }
  return null;
}

async function gateCounts(db: Store, taskId: string): Promise<Review['gateCounts']> {
  const verdicts = await db.select({ data: taskEvents.data }).from(taskEvents).where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.kind, 'verdict')));
  return { source: 'review-lifecycle', passed: verdicts.filter(v => v.data.pass === true).length, returned: verdicts.filter(v => v.data.pass === false).length };
}

/* Resolve the repository before a task transaction; an outage cannot roll back a submission. */
export async function captureReview(ctx: Reader, task: Task, input?: z.infer<typeof ReviewSubmission>): Promise<Review | null> {
  if (!ctx.config || !ctx.readCommit || !task.executorAgentId) return null;
  const found = await repoAt({ db: ctx.db, config: ctx.config }, [task.productId, task.departmentId]);
  if (!found) return null;
  const pin = await readPin(ctx.readCommit, found.repo, task.number);
  return { ...pin, revision: randomUUID(), authorId: task.executorAgentId, authorVendor: await authorVendor(ctx.db, task.executorAgentId), gateCounts: await gateCounts(ctx.db, task.id), qualityTaskId: task.id, quality: await authorQuality(ctx.db, task.id, pin.commit), runs: await authorRuns(ctx.db, task, pin.commit), source: await sourceAt(ctx, found.repo, pin.commit, input) };
}

/* Keep immutable submission facts separate from the consumer's current receipt validation. */
export async function visibleReview(db: Store, taskId: string, review: Review): Promise<Review & { qualityAtSubmission: Review['quality'] }> {
  const sourceId = review.qualityTaskId ?? review.quality.record?.taskId ?? taskId;
  return { ...review, qualityAtSubmission: review.quality, quality: await authorQuality(db, sourceId, review.commit) };
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
