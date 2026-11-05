import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { taskEvents } from '../../db/schema.js';
import type { CompareResult } from '../testruns/compare.js';
import type { Task, Tx } from './engine.js';
import { changedLines, reviewContext, ReviewSha, type Review } from './review-context.js';
import { QualityEvidence, unavailableQuality } from './review-quality.js';

/* Initial policy from task 310; this is not an empirically selected optimum. */
const THRESHOLD = 800;
const Assignment = z.object({
  reviewerId: z.string(), taskId: z.string(), revision: z.string(), authorId: z.string(), authorVendor: z.string().nullable(),
  baseCommit: ReviewSha.nullable(), commit: ReviewSha.nullable(), paths: z.array(z.string()), commonContracts: z.array(z.string()),
  runs: z.array(z.object({ id: z.string(), commit: z.string().nullable(), verified: z.boolean() }).passthrough()),
  gateCounts: z.object({ source: z.literal('review-lifecycle').default('review-lifecycle'), passed: z.number(), returned: z.number() }),
  quality: QualityEvidence.default(unavailableQuality),
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
  const review = slice.review ?? { revision: randomUUID(), authorVendor: null, commit: null, source: null, runs: [], gateCounts: { source: 'review-lifecycle' as const, passed: 0, returned: 0 }, quality: unavailableQuality() };
  const source = review.source ?? { baseCommit: null, paths: [] };
  return { reviewerId: candidate.reviewerId, taskId: slice.taskId, revision: review.revision, authorId: slice.authorId, authorVendor: review.authorVendor, baseCommit: source.baseCommit, commit: review.commit, paths: source.paths, commonContracts, runs: review.runs, gateCounts: review.gateCounts, quality: review.quality };
}

function candidateGroups(pool: Candidate[], large: boolean): Candidate[][] {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of pool) {
    const key = large ? candidate.role : `${candidate.role}:${candidate.vendor}`;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  return [...groups.values()];
}

function leastLoaded(pool: Candidate[], loads: Map<string, number>): Candidate {
  return pool.toSorted((a, b) => (loads.get(a.reviewerId) ?? 0) - (loads.get(b.reviewerId) ?? 0))[0]!;
}

function assignmentsFor(slices: Slice[], candidates: Candidate[], large: boolean, common: string[]): Plan['assignments'] {
  const assignments: Plan['assignments'] = [];
  const loads = new Map<string, number>();
  for (const slice of slices) {
    for (const group of candidateGroups(eligible(slice, candidates), large)) {
      const best = leastLoaded(group, loads);
      assignments.push(assigned(slice, best, common));
      loads.set(best.reviewerId, (loads.get(best.reviewerId) ?? 0) + 1);
    }
  }
  return assignments;
}

function missingReviewers(slices: Slice[], candidates: Candidate[]): string[] {
  const missing = new Set<string>();
  const roles = new Set(candidates.map(c => c.role));
  for (const slice of slices) {
    const pool = eligible(slice, candidates);
    if (!pool.length) missing.add('independent-reviewer-unavailable');
    for (const role of roles) if (!pool.some(c => c.role === role)) missing.add(`independent-reviewer-unavailable:${slice.taskId}:${role}`);
  }
  return [...missing];
}

function integrationReviewer(slices: Slice[], candidates: Candidate[]): string | null {
  const authors = new Set(slices.map(s => s.review?.authorVendor));
  return candidates.find(candidate => candidate.vendor && !authors.has(candidate.vendor))?.reviewerId ?? null;
}

function planConcerns(slices: Slice[], candidates: Candidate[], comparison: CompareResult, large: boolean, assignments: Plan['assignments'], integrator: string | null): string[] {
  const concerns = missingReviewers(slices, candidates);
  if (!comparison.complete) concerns.push('comparison-unavailable');
  if (slices.some(slice => !slice.review?.source)) concerns.push('source-inventory-unavailable');
  if (large && slices.length < 2) concerns.push('vertical-task-slices-required');
  if (large && new Set(assignments.map(a => a.reviewerId)).size < 2) concerns.push('two-independent-reviewers-unavailable');
  if (!integrator) concerns.push('integration-reviewer-unavailable');
  return concerns;
}

export function planReview(slices: Slice[], candidates: Candidate[], comparison: CompareResult): Plan {
  const large = comparison.complete && changedLines(comparison.diff) > THRESHOLD;
  const common = [...CONTRACTS, ...(comparison.complete ? comparison.paths.filter(contractPath) : [])];
  const assignments = assignmentsFor(slices, candidates, large, common);
  const integrationReviewerId = integrationReviewer(slices, candidates);
  return { threshold: THRESHOLD, large, assignments, integrationReviewerId, degraded: planConcerns(slices, candidates, comparison, large, assignments, integrationReviewerId) };
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

export async function degradedReviewNotes(db: import('../../db/client.js').Db, taskId: string): Promise<string[]> {
  const plan = await taskReviewPlan(db, taskId);
  return plan ? plan.degraded.map(reason => `Degraded review: ${reason}. The head must settle this before acceptance.`) : [];
}
