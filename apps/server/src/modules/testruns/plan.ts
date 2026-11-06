import { MAX_TEST_PARTS, type TestUnit } from '@hornhoof/protocol';
import { median } from './plan-statistics.js';

export type FileDuration = { suiteId: string; file: string; ms: number };
export type TestPartPlanInput = {
  units: TestUnit[];
  durations: FileDuration[];
  /* Supplied by the existing compatible physical-host admission, never a public machine choice. */
  availableMachines: number;
  costs: { setupMs: number; collectMs: number };
  unknownFileMs: number;
};
export type PlannedTestPart = { units: TestUnit[]; testMs: number };
export type PartEstimate = { parts: number; estimatedWallMs: number; costAdjustedMs: number };
export type TestPartPlan = {
  parts: PlannedTestPart[];
  oneMachineMs: number;
  estimatedWallMs: number;
  costAdjustedMs: number;
  alternatives: PartEstimate[];
  unknownUnits: TestUnit[];
  waitingForCapacity: boolean;
  reason: string;
};

type TimedUnit = { unit: TestUnit; ms: number; unknown: boolean };
type Group = { key: string; units: TestUnit[]; ms: number };
type Alternative = { parts: PlannedTestPart[]; estimate: PartEstimate };
const fileKey = (unit: Pick<TestUnit, 'suiteId' | 'file'>): string => JSON.stringify([unit.suiteId, unit.file]);
const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function nonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`Invalid ${label}: use a finite nonnegative number.`);
}
function validInput(input: TestPartPlanInput): void {
  if (!input.units.length) throw new Error('The test selection is empty.');
  if (new Set(input.units.map(fileKey)).size !== input.units.length) throw new Error('The test selection contains duplicate files.');
  if (!Number.isInteger(input.availableMachines) || input.availableMachines < 0) throw new RangeError('Invalid compatible machine capacity.');
  nonnegative(input.costs.setupMs, 'setup cost');
  nonnegative(input.costs.collectMs, 'collection cost');
  nonnegative(input.unknownFileMs, 'unknown-file estimate');
  if (!input.unknownFileMs) throw new RangeError('The unknown-file estimate must be positive.');
}

function durationIndex(durations: FileDuration[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (const duration of durations) {
    if (!Number.isFinite(duration.ms) || duration.ms < 0) continue;
    const key = fileKey(duration), values = index.get(key) ?? [];
    values.push(duration.ms);
    index.set(key, values);
  }
  return index;
}
function timedUnits(input: TestPartPlanInput): TimedUnit[] {
  const index = durationIndex(input.durations);
  return [...input.units].sort((a, b) => lexical(fileKey(a), fileKey(b))).map(unit => {
    const values = index.get(fileKey(unit));
    return { unit, ms: values ? median(values) : input.unknownFileMs, unknown: !values };
  });
}

/* A whole-package selection, or another descriptor-declared selectionUnit, cannot be split between machines. */
function groupsOf(timed: TimedUnit[]): Group[] {
  const groups = new Map<string, Group>();
  for (const item of timed) {
    const key = JSON.stringify([item.unit.suiteId, item.unit.selectionUnit]);
    const group = groups.get(key) ?? { key, units: [], ms: 0 };
    group.units.push(item.unit);
    group.ms += item.ms;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.ms - a.ms || lexical(a.key, b.key));
}
function distribute(groups: Group[], count: number): PlannedTestPart[] {
  const parts: PlannedTestPart[] = Array.from({ length: count }, () => ({ units: [], testMs: 0 }));
  for (const group of groups) {
    const part = parts.reduce((best, next) => next.testMs < best.testMs ? next : best);
    part.units.push(...group.units);
    part.testMs += group.ms;
  }
  return parts;
}
function alternative(groups: Group[], count: number, costs: TestPartPlanInput['costs']): Alternative {
  const parts = distribute(groups, count), longest = Math.max(...parts.map(part => part.testMs));
  /* Setup can overlap across machines; collecting every result still costs time. Charge the extra machines' setup
     separately when choosing, rather than claiming that extra resource cost is measured wall time. */
  const estimatedWallMs = costs.setupMs + longest + count * costs.collectMs;
  const costAdjustedMs = estimatedWallMs + (count - 1) * costs.setupMs;
  nonnegative(costAdjustedMs, 'estimated total cost');
  return { parts, estimate: { parts: count, estimatedWallMs, costAdjustedMs } };
}
function reasonFor(input: TestPartPlanInput, best: Alternative, oneMachineMs: number, unknown: number): string {
  const capacity = input.availableMachines ? `Selected ${best.parts.length} parts from ${input.availableMachines} free compatible machines.`
    : 'No compatible machine is free; queue one part.';
  const cost = ` The cost-adjusted estimate is ${best.estimate.costAdjustedMs} ms versus ${oneMachineMs} ms on one machine; extra machine setup ${input.costs.setupMs} ms and result collection ${input.costs.collectMs} ms per part.`;
  const fallback = unknown ? ` ${unknown} files use estimated ${input.unknownFileMs} ms each, not historical measurements.` : ' All file estimates use historical measurements.';
  return capacity + cost + fallback;
}

/* This is a pure estimate. The existing pool still owns compatibility, freshness, physical-host admission and dispatch. */
export function planTestParts(input: TestPartPlanInput): TestPartPlan {
  validInput(input);
  const timed = timedUnits(input), groups = groupsOf(timed);
  const limit = Math.min(MAX_TEST_PARTS, Math.max(1, input.availableMachines), groups.length);
  const options = Array.from({ length: limit }, (_, index) => alternative(groups, index + 1, input.costs));
  const best = options.reduce((chosen, next) => next.estimate.costAdjustedMs < chosen.estimate.costAdjustedMs ? next : chosen);
  const unknownUnits = timed.filter(item => item.unknown).map(item => item.unit);
  const oneMachineMs = options[0]!.estimate.estimatedWallMs;
  return { parts: best.parts, oneMachineMs, estimatedWallMs: best.estimate.estimatedWallMs,
    costAdjustedMs: best.estimate.costAdjustedMs, alternatives: options.map(option => option.estimate), unknownUnits,
    waitingForCapacity: input.availableMachines === 0, reason: reasonFor(input, best, oneMachineMs, unknownUnits.length) };
}
