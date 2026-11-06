import type { CheckBinding, RunModelCheck } from './contract.js';
import type { Dataset } from './dataset.js';
import type { Counts, Decision, Scored, Thresholds } from './score.js';

export type Evaluation = Omit<Scored, 'missedDevCases'> & { bindingDigest: string; reportId: string; datasetHash: string; evaluatedAt: string };
export type Report = { status: Decision['status']; problems: Decision['problems']; infraErrors: number; mustBlockMisses: number; all: Counts; holdout: Counts; missedDevCases: string[] };
export type RunOutcome = { evaluation: Evaluation; decision: Decision; report: Report };

export async function evaluateCheck(_binding: CheckBinding, _dataset: Dataset, _thresholds: Thresholds | null, _call: RunModelCheck, _ids: { reportId: string; now: Date }): Promise<RunOutcome> {
  throw new Error('Not written yet.');
}
export const reportText = (_report: Report): string => '';
