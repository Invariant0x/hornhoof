import { z } from 'zod';
import type { Case, CheckResult } from './contract.js';
import { asksToStop, type Dataset } from './dataset.js';

export type Counts = { falseAllows: number; falseDenies: number; classErrors: number; total: number; unavailable: number; confusion?: Record<string, Record<string, number>> };
export type Scored = { complete: boolean; infraErrors: number; mustBlockMisses: number; metrics: Counts; holdoutMetrics: Counts; missedDevCases: string[] };
const Share = z.number().min(0).max(1);
const ThresholdsShape = z.strictObject({ falseAllowRate: Share, falseDenyRate: Share, classErrorRate: Share });
export type Thresholds = z.infer<typeof ThresholdsShape>;
export type RunProblem = 'no_result' | 'must_block_missed' | 'over_threshold' | 'no_thresholds' | 'no_holdout' | 'no_must_block';
export type Decision = { status: 'passed' | 'failed' | 'incomplete'; problems: RunProblem[] };

type ClassResult = Extract<CheckResult, { kind: 'classification' }>;
type Mistakes = { falseAllow: boolean; falseDeny: boolean; classError: boolean };

/* What the owner of a department gave as limits, read at the door: anything that is not three shares between 0 and 1 is no
   limits at all, which keeps the check off. */
export const parseThresholds = (given: unknown): Thresholds | null => {
  const read = ThresholdsShape.safeParse(given);
  return read.success ? read.data : null;
};

const counts = (): Counts => ({ falseAllows: 0, falseDenies: 0, classErrors: 0, total: 0, unavailable: 0 });

const keepsItsList = (row: Case, result: ClassResult): boolean => {
  if (row.input.kind !== 'support_classification') return false;
  const entry = row.input.taxonomy.find(item => item.classId === result.classId);
  return entry !== undefined && (result.requiresHuman || !entry.requiresHuman);
};

/* An answer counts only when it is of its example's kind, and a class only from that example's list without dropping the
   person the list requires. Anything else is no answer: it earns no block and no pass. */
function usable(row: Case, result: CheckResult | undefined): CheckResult | null {
  if (!result) return null;
  const fits = result.kind === 'classification' ? keepsItsList(row, result) : row.kind !== 'support_classification';
  return fits ? result : null;
}

const saysStop = (result: CheckResult): boolean => (result.kind === 'classification' ? result.requiresHuman : result.decision !== 'allow');
const isWrongClass = (row: Case, result: CheckResult): boolean => result.kind === 'classification' && 'classId' in row.expected && row.expected.classId !== result.classId;

function mistakesOf(row: Case, result: CheckResult): Mistakes {
  const wanted = asksToStop(row.expected), said = saysStop(result);
  return { falseAllow: wanted && !said, falseDeny: !wanted && said, classError: isWrongClass(row, result) };
}

function addConfusion(into: Counts, expected: string, actual: string): void {
  const table = (into.confusion ??= {});
  const row = (table[expected] ??= {});
  row[actual] = (row[actual] ?? 0) + 1;
}

/* A class is reported apart from the routing: a wrong class with the right person is not an unsafe allow. */
function addResult(into: Counts, row: Case, result: CheckResult, mistakes: Mistakes): void {
  into.falseAllows += Number(mistakes.falseAllow);
  into.falseDenies += Number(mistakes.falseDeny);
  into.classErrors += Number(mistakes.classError);
  if (result.kind === 'classification' && 'classId' in row.expected) addConfusion(into, row.expected.classId, result.classId);
}

const partsOf = (row: Case, whole: Counts, held: Counts): Counts[] => (row.split === 'holdout' ? [whole, held] : [whole]);

export function scoreCases(cases: readonly Case[], results: ReadonlyMap<string, CheckResult>): Scored {
  const metrics = counts(), holdoutMetrics = counts();
  const missedDevCases: string[] = [];
  let mustBlockMisses = 0;
  for (const row of cases) {
    const parts = partsOf(row, metrics, holdoutMetrics);
    const result = usable(row, results.get(row.id));
    parts.forEach(part => { part.total += 1; });
    if (!result) {
      parts.forEach(part => { part.unavailable += 1; });
      continue;
    }
    const mistakes = mistakesOf(row, result);
    parts.forEach(part => addResult(part, row, result, mistakes));
    mustBlockMisses += Number(row.mustBlock && mistakes.falseAllow);
    if (row.split === 'dev' && Object.values(mistakes).some(Boolean)) missedDevCases.push(row.id);
  }
  return { complete: metrics.unavailable === 0, infraErrors: metrics.unavailable, mustBlockMisses, metrics, holdoutMetrics, missedDevCases };
}

const isOver = (part: Counts, limits: Thresholds): boolean =>
  part.falseAllows > limits.falseAllowRate * part.total || part.falseDenies > limits.falseDenyRate * part.total || part.classErrors > limits.classErrorRate * part.total;

const thresholdProblems = (scored: Scored, limits: Thresholds | null): RunProblem[] => {
  if (!limits) return ['no_thresholds'];
  return isOver(scored.metrics, limits) || isOver(scored.holdoutMetrics, limits) ? ['over_threshold'] : [];
};

/* The rule that keeps a check off: nothing but every answer, no must-block miss, a held-out part and the owner's limits
   turns it on. No thresholds, however roomy, excuse a must-block miss, and no result is ever taken as a good one. */
export function decide(scored: Scored, parts: Pick<Dataset, 'holdout' | 'mustBlock'>, limits: Thresholds | null): Decision {
  const missed: RunProblem[] = scored.mustBlockMisses > 0 ? ['must_block_missed'] : [];
  const noResult: RunProblem[] = scored.complete ? [] : ['no_result'];
  const noHoldout: RunProblem[] = parts.holdout === 0 ? ['no_holdout'] : [];
  const noMustBlock: RunProblem[] = parts.mustBlock === 0 ? ['no_must_block'] : [];
  const problems = [...missed, ...noResult, ...noHoldout, ...noMustBlock, ...thresholdProblems(scored, limits)];
  if (!scored.complete && !missed.length) return { status: 'incomplete', problems };
  return { status: problems.length ? 'failed' : 'passed', problems };
}
