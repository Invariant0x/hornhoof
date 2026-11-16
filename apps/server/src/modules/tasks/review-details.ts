import type { PipelineHead } from '@hornhoof/protocol';
import type { Db } from '../../db/client.js';
import { reviewContext, type Review } from './review-context.js';
import { findingReport, findingTurnReport, type FindingReport, type TurnFindingReport } from './review-findings.js';

type Details = { review: Review | null; reviewFindings: FindingReport };
type PipelineFindings = { current: TurnFindingReport | null; previous: TurnFindingReport | null; baseline: TurnFindingReport | null };

/* The caller has already applied the task tool's visibility policy. */
export async function reviewDetails(db: Db, taskId: string): Promise<Details> {
  return { review: await reviewContext(db, taskId), reviewFindings: await findingReport(db, [taskId]) };
}

export async function pipelineFindings(db: Db, companyId: string, head: PipelineHead): Promise<PipelineFindings> {
  const read = async (at: { number: number } | null) => at ? findingTurnReport(db, companyId, at.number) : null;
  return { current: await read(head.turn), previous: await read(head.previous), baseline: await read(head.baseline) };
}
