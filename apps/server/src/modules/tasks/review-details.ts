import type { PipelineHead } from '@hornhoof/protocol';
import type { Db } from '../../db/client.js';
import { reviewContext, visibleReview, type Review } from './review-context.js';
import { findingReport, findingTurnReport, type FindingReport, type TurnFindingReport } from './review-findings.js';
import { fixReviews, type Fix } from './review-fixes.js';
import { taskReviewPlan, type Plan } from './review-plan.js';
import { authorQuality } from './review-quality.js';

type Details = { review: (Review & { qualityAtSubmission: Review['quality'] }) | null; reviewPlan: Plan | null; fixReview: Fix | null; reviewFindings: FindingReport };
type PipelineFindings = { current: TurnFindingReport | null; previous: TurnFindingReport | null; baseline: TurnFindingReport | null };

/* The caller has already applied the task tool's visibility policy. */
export async function reviewDetails(db: Db, taskId: string, agentId: string): Promise<Details> {
  const review = await reviewContext(db, taskId);
  const plan = await taskReviewPlan(db, taskId);
  const assignments = plan ? await Promise.all(plan.assignments.map(async area => ({ ...area, qualityAtSubmission: area.quality, quality: await authorQuality(db, area.taskId, area.commit) }))) : [];
  return { review: review ? await visibleReview(db, taskId, review) : null, reviewPlan: plan ? { ...plan, assignments } : null, fixReview: (await fixReviews(db, taskId)).find(fix => fix.reviewerId === agentId) ?? null, reviewFindings: await findingReport(db, [taskId]) };
}

export async function pipelineFindings(db: Db, companyId: string, head: PipelineHead): Promise<PipelineFindings> {
  const read = async (at: { number: number } | null) => at ? findingTurnReport(db, companyId, at.number) : null;
  return { current: await read(head.turn), previous: await read(head.previous), baseline: await read(head.baseline) };
}
