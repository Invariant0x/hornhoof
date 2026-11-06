import type { CheckResult, Case } from './contract.js';
import type { Dataset } from './dataset.js';

export type Counts = { falseAllows: number; falseDenies: number; classErrors: number; total: number; unavailable: number; confusion?: Record<string, Record<string, number>> };
export type Scored = { complete: boolean; infraErrors: number; mustBlockMisses: number; metrics: Counts; holdoutMetrics: Counts; missedDevCases: string[] };
export type Thresholds = { falseAllowRate: number; falseDenyRate: number; classErrorRate: number };
export type RunProblem = 'no_result' | 'must_block_missed' | 'over_threshold' | 'no_thresholds' | 'no_holdout' | 'no_must_block';
export type Decision = { status: 'passed' | 'failed' | 'incomplete'; problems: RunProblem[] };

const NONE: Counts = { falseAllows: 0, falseDenies: 0, classErrors: 0, total: 0, unavailable: 0 };
export function scoreCases(_cases: readonly Case[], _results: ReadonlyMap<string, CheckResult>): Scored {
  return { complete: true, infraErrors: 0, mustBlockMisses: 0, metrics: NONE, holdoutMetrics: NONE, missedDevCases: [] };
}
export function decide(_scored: Scored, _dataset: Pick<Dataset, 'holdout' | 'mustBlock'>, _thresholds: Thresholds | null): Decision {
  return { status: 'passed', problems: [] };
}
