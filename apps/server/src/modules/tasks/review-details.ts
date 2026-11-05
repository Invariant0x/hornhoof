import type { PipelineHead } from '@hornhoof/protocol';
import type { Db } from '../../db/client.js';
import { reviewContext, type Review } from './review-context.js';
import { findingReport, findingTurnReport, type FindingReport, type TurnFindingReport } from './review-findings.js';
import { fixReviews, type Fix } from './review-fixes.js';
import { taskReviewPlan, type Plan } from './review-plan.js';

type Details = { review: Review | null; reviewPlan: Plan | null; fixReview: Fix | null; reviewFindings: FindingReport };
type PipelineFindings = { current: TurnFindingReport | null; previous: TurnFindingReport | null; baseline: TurnFindingReport | null };

/* The caller has already applied the task tool's visibility policy. */
export async function reviewDetails(db: Db, taskId: string, agentId: string): Promise<Details> {
  return { review: await reviewContext(db, taskId), reviewPlan: await taskReviewPlan(db, taskId), fixReview: (await fixReviews(db, taskId)).find(fix => fix.reviewerId === agentId) ?? null, reviewFindings: await findingReport(db, [taskId]) };
}

export async function pipelineFindings(db: Db, companyId: string, head: PipelineHead): Promise<PipelineFindings> {
  const read = async (at: { number: number } | null) => at ? findingTurnReport(db, companyId, at.number) : null;
  return { current: await read(head.turn), previous: await read(head.previous), baseline: await read(head.baseline) };
}
