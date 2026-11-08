import type { Db } from '../../db/client.js';
import { refuse, type Task } from './engine.js';
import { reviewContext, visibleReview, type Review } from './review-context.js';
import { assertReviewVendor, issuesForVerdict, type NewIssue } from './review-findings.js';
import { fixReviews, type Fix } from './review-fixes.js';
import { taskReviewPlan, type Plan } from './review-plan.js';

export type ReviewVerdict = { pass: boolean; reviewedCommit?: string; security?: string; escalate?: boolean; issues?: NewIssue[]; evidence?: object[] };

/* Live branch freshness remains a separate fact; it cannot certify a different pinned candidate. */
export function bindReviewEvidence<T extends object>(runs: T[], commit: string | null): T[] {
  return runs.map(run => {
    if (!('proves' in run)) return run;
    if (commit !== null && 'commitSha' in run && run.commitSha === commit) return run;
    return { ...run, proves: false, why: `This run does not match the pinned review commit ${commit ?? '(unavailable)'}.` };
  });
}

function assertPinnedPass(review: Review | null, pass: boolean): void {
  if (review && pass && !review.commit) throw refuse(400, 'task_invalid', 'The review commit is unavailable; an unpinned PASS cannot certify it.');
}

function assertCommit(review: Review | null, verdict: ReviewVerdict): void {
  if (verdict.reviewedCommit !== undefined && verdict.reviewedCommit !== review?.commit) throw refuse(400, 'task_invalid', 'The reviewed commit must match the pinned review revision.');
  assertPinnedPass(review, verdict.pass);
  if (verdict.issues?.length && verdict.reviewedCommit !== review?.commit) throw refuse(400, 'task_invalid', 'Name the exact pinned commit for structured findings.');
}

function assertAssignment(plan: Plan | null, agentId: string): void {
  if (plan && plan.integrationReviewerId !== agentId && !plan.assignments.some(a => a.reviewerId === agentId)) throw refuse(403, 'task_not_yours', 'This review has no independent slice assigned to you.');
}

function assertFix(fix: Fix | undefined, verdict: ReviewVerdict): void {
  if (!fix) return;
  if (verdict.issues?.length) throw refuse(400, 'task_invalid', 'A repeat checks only the original finding IDs; it cannot introduce new findings.');
  if (verdict.pass && fix.status !== 'ready') throw refuse(400, 'task_invalid', 'The fix range is unavailable; PASS would claim a check that could not be made.');
}

function fixResolution(fix: Fix | undefined, pass: boolean): Record<string, unknown> {
  return fix ? { [pass ? 'resolvedFindingIds' : 'unresolvedFindingIds']: fix.findingIds, fixReviews: [fix] } : {};
}

export async function verdictReview(db: Db, task: Task, agentId: string, verdict: ReviewVerdict): Promise<Record<string, unknown>> {
  const review = await reviewContext(db, task.id);
  assertCommit(review, verdict);
  const plan = await taskReviewPlan(db, task.id);
  assertAssignment(plan, agentId);
  await assertReviewVendor(db, agentId, review, plan);
  const fix = (await fixReviews(db, task.id)).find(item => item.reviewerId === agentId);
  assertFix(fix, verdict);
  const issues = await issuesForVerdict(db, task, agentId, review, plan, verdict.issues ?? [], verdict.pass);
  return { ...(review ? { review: await visibleReview(db, task.id, review) } : {}), ...(verdict.evidence?.length ? { evidence: bindReviewEvidence(verdict.evidence, review?.commit ?? null) } : {}), ...(verdict.issues !== undefined ? { issues } : {}), ...fixResolution(fix, verdict.pass) };
}
