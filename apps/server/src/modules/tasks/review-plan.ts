import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { taskEvents } from '../../db/schema.js';
import type { CompareResult } from '../testruns/compare.js';
import type { Task, Tx } from './engine.js';
import { changedLines, reviewContext, ReviewSha, type Review } from './review-context.js';

/* Initial policy from task 310; this is not an empirically selected optimum. */
const THRESHOLD = 800;
const Assignment = z.object({
  reviewerId: z.string(), taskId: z.string(), revision: z.string(), authorId: z.string(), authorVendor: z.string().nullable(),
  baseCommit: ReviewSha.nullable(), commit: ReviewSha.nullable(), paths: z.array(z.string()), commonContracts: z.array(z.string()),
  runs: z.array(z.object({ id: z.string(), commit: z.string().nullable(), verified: z.boolean() }).passthrough()),
  gateCounts: z.object({ passed: z.number(), returned: z.number() }),
});
export const ReviewPlan = z.object({ threshold: z.number(), large: z.boolean(), assignments: z.array(Assignment), integrationReviewerId: z.string().nullable(), degraded: z.array(z.string()) });
export type Plan = z.infer<typeof ReviewPlan>;
export type Candidate = { reviewerId: string; vendor: string | null; role: string };
type Slice = { taskId: string; authorId: string; review: Review | null };
const CONTRACTS = ['packages/protocol/**', '**/schema.*', '**/routes.*', '**/contracts/**'];
const contractPath = (path: string): boolean => /(^|\/)(protocol|contracts)\/|(^|\/)(schema|routes)\.[^/]+$/.test(path);

function eligible(slice: Slice, candidates: Candidate[]): Candidate[] {
  const vendor = slice.review?.authorVendor;
  return vendor ? candidates.filter(c => c.vendor && c.vendor !== vendor && c.reviewerId !== slice.authorId) : [];
}

function assigned(slice: Slice, candidate: Candidate, commonContracts: string[]): Plan['assignments'][number] {
  const review = slice.review;
  return {
    reviewerId: candidate.reviewerId, taskId: slice.taskId, revision: review?.revision ?? randomUUID(), authorId: slice.authorId, authorVendor: review?.authorVendor ?? null,
    baseCommit: review?.source?.baseCommit ?? null, commit: review?.commit ?? null, paths: review?.source?.paths ?? [], commonContracts,
    runs: review?.runs ?? [], gateCounts: review?.gateCounts ?? { passed: 0, returned: 0 },
  };
}

export function planReview(slices: Slice[], candidates: Candidate[], comparison: CompareResult): Plan {
  const large = comparison.complete && changedLines(comparison.diff) > THRESHOLD;
  const common = [...CONTRACTS, ...(comparison.complete ? comparison.paths.filter(contractPath) : [])];
  const degraded = new Set<string>();
  if (!comparison.complete) degraded.add('comparison-unavailable');
  if (slices.some(s => !s.review?.source)) degraded.add('source-inventory-unavailable');
  if (large && slices.length < 2) degraded.add('vertical-task-slices-required');
  const assignments: Plan['assignments'] = [];
  const loads = new Map<string, number>();
  for (const slice of slices) {
    const pool = eligible(slice, candidates);
    for (const role of new Set(candidates.map(c => c.role))) if (!pool.some(c => c.role === role)) degraded.add(`independent-reviewer-unavailable:${slice.taskId}:${role}`);
    const groups = new Map<string, Candidate[]>();
    for (const c of pool) {
      const key = large ? c.role : `${c.role}:${c.vendor}`;
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    if (!pool.length) degraded.add('independent-reviewer-unavailable');
    for (const group of groups.values()) {
      const best = group.toSorted((a, b) => (loads.get(a.reviewerId) ?? 0) - (loads.get(b.reviewerId) ?? 0))[0]!;
      assignments.push(assigned(slice, best, common));
      loads.set(best.reviewerId, (loads.get(best.reviewerId) ?? 0) + 1);
    }
  }
  if (large && loads.size < 2) degraded.add('two-independent-reviewers-unavailable');
  const contractAuthors = new Set(slices.filter(s => s.review?.source?.paths.some(contractPath)).flatMap(s => s.review?.authorVendor ? [s.review.authorVendor] : []));
  const integrator = candidates.find(c => c.vendor && !contractAuthors.has(c.vendor) && slices.every(s => s.review?.authorVendor !== c.vendor));
  if (!integrator) degraded.add('integration-reviewer-unavailable');
  return { threshold: THRESHOLD, large, assignments, integrationReviewerId: integrator?.reviewerId ?? null, degraded: [...degraded] };
}

/* Each code task remains its own slice, including when two source ranges touch the same file. */
export async function turnReviewPlan(db: Tx, scoped: Task[], candidates: Candidate[], comparison: CompareResult): Promise<Plan> {
  const made = await db.select({ taskId: taskEvents.taskId }).from(taskEvents)
    .where(and(inArray(taskEvents.taskId, scoped.map(t => t.id)), eq(taskEvents.kind, 'created'), sql`${taskEvents.data}->>'inTurnReview' = 'true'`));
  const code = new Set(made.map(e => e.taskId));
  const sources = scoped.filter(task => task.executorAgentId && code.has(task.id));
  const slices = await Promise.all(sources.map(async task => ({ taskId: task.id, authorId: task.executorAgentId!, review: await reviewContext(db, task.id) })));
  return planReview(slices, candidates, comparison);
}

export async function taskReviewPlan(db: Tx | import('../../db/client.js').Db, taskId: string): Promise<Plan | null> {
  const rows = await db.select({ data: taskEvents.data }).from(taskEvents).where(eq(taskEvents.taskId, taskId)).orderBy(asc(taskEvents.id));
  const found = rows.map(row => ReviewPlan.safeParse(row.data.reviewPlan)).findLast(parsed => parsed.success);
  return found?.success ? found.data : null;
}
