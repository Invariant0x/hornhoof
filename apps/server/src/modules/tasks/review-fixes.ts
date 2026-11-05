import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { taskEvents } from '../../db/schema.js';
import { repoAt } from '../departments/repository.js';
import type { Task, Tx } from './engine.js';
import { exactComparison, ReviewRecord, ReviewSha, type Review } from './review-context.js';
import { findingsOf, reviewEvents, type Finding } from './review-findings.js';

const FixReview = z.object({ reviewerId: z.string(), revision: z.string(), reviewedCommit: ReviewSha, fixCommit: ReviewSha, findingIds: z.array(z.string()), paths: z.array(z.string()), status: z.enum(['ready', 'degraded']), reason: z.string().nullable() });
export type Fix = z.infer<typeof FixReview>;
type Live = Pick<Ctx, 'db'> & Partial<Pick<Ctx, 'config' | 'readCompare'>>;

const eligible = (finding: Finding): boolean => finding.blocking && ['security', 'data', 'spec'].includes(finding.category);

export async function fixReviews(db: Ctx['db'] | Tx, taskId: string): Promise<Fix[]> {
  const rows = await db.select({ data: taskEvents.data }).from(taskEvents).where(eq(taskEvents.taskId, taskId)).orderBy(taskEvents.id);
  const latest = rows.filter(row => 'fixReviews' in row.data).at(-1);
  const parsed = z.array(FixReview).safeParse(latest?.data.fixReviews);
  return parsed.success ? parsed.data : [];
}

async function fixRange(ctx: Live, task: Task, fix: Fix): Promise<Fix> {
  if (!ctx.config || !ctx.readCompare || fix.reviewedCommit === fix.fixCommit) return fix;
  try {
    const found = await repoAt({ db: ctx.db, config: ctx.config }, [task.productId, task.departmentId]);
    if (!found) return fix;
    const range = await ctx.readCompare(found.repo, { base: fix.reviewedCommit, head: fix.fixCommit }, 10_000);
    if (exactComparison(range, fix.reviewedCommit, fix.fixCommit)) return { ...fix, paths: range.paths, status: 'ready', reason: null };
  } catch { /* Remote text and repository secrets never enter task errors. */ }
  return fix;
}

type Event = Awaited<ReturnType<typeof reviewEvents>>[number];

function ownFindings(event: Event, issues: Finding[], revision: string): Finding[] {
  const original = issues.filter(issue => issue.reviewerId === event.agentId && issue.revision === revision).map(issue => issue.findingId);
  const ownIds = new Set(Array.isArray(event.data.unresolvedFindingIds) ? event.data.unresolvedFindingIds : original);
  return issues.filter(issue => ownIds.has(issue.findingId) && issue.reviewerId === event.agentId && eligible(issue));
}

function pendingFix(event: Event, issues: Finding[], commit: string): Fix | null {
  const review = ReviewRecord.safeParse(event.data.review);
  if (!event.agentId || !review.success || !review.data.commit) return null;
  const own = ownFindings(event, issues, review.data.revision);
  if (!own.length) return null;
  return { reviewerId: event.agentId, revision: review.data.revision, reviewedCommit: review.data.commit, fixCommit: commit, findingIds: own.map(issue => issue.findingId), paths: [], status: 'degraded', reason: 'fix-comparison-unavailable' };
}

/* The latest actual look pins the next range; unresolved findings keep their original identity. */
export async function prepareFixReviews(ctx: Live, task: Task, candidate: Review): Promise<Fix[]> {
  if (!candidate.commit) return [];
  const events = await reviewEvents(ctx.db, [task.id]);
  const issues = findingsOf(events);
  const failed = events.filter(e => e.kind === 'verdict' && e.data.pass === false && e.data.round === task.bounces - 1);
  const plans: Fix[] = [];
  for (const event of new Map(failed.map(e => [e.agentId, e])).values()) {
    const plan = pendingFix(event, issues, candidate.commit);
    if (plan) plans.push(await fixRange(ctx, task, plan));
  }
  return plans;
}
