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
  /* The free machines and their paces, the time each takes for work of 1 ms at the middle pace, when they are known. */
  machines?: MachinePace[];
  /* How long a preparation takes, at the middle pace, that the first machine runs before its part. */
  preparationMs?: number;
  /* A run's parts: no fewer than min and no more than max, and enough of them that each ends within ceilingMs. */
  spread?: PartSpread;
};
export type PartSpread = { min: number; max: number; ceilingMs: number };
type MachinePace = { key: string; pace: number };
/* machine: the machine a part is laid out for and how long it should take there, when the machines go at different paces. */
type PlannedTestPart = { units: TestUnit[]; testMs: number; machine?: { key: string; ms: number } };
type PartEstimate = { parts: number; estimatedWallMs: number; costAdjustedMs: number };
export type TestPartPlan = {
  parts: PlannedTestPart[];
  oneMachineMs: number;
  estimatedWallMs: number;
  costAdjustedMs: number;
  alternatives: PartEstimate[];
  unknownUnits: TestUnit[];
  waitingForCapacity: boolean;
  reason: string;
  /* The machine laid out to run the preparation first, when the machines go at different paces. */
  preparationMachine?: string;
};

type TimedUnit = { unit: TestUnit; ms: number; unknown: boolean };
type Group = { key: string; units: TestUnit[]; ms: number };
/* partMs: how long the longest part may take on the machine it goes to, with its setup. */
type Alternative = { parts: PlannedTestPart[]; estimate: PartEstimate; partMs: number };
export const fileKey = (unit: Pick<TestUnit, 'suiteId' | 'file'>): string => JSON.stringify([unit.suiteId, unit.file]);
export const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

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
  nonnegative(input.preparationMs ?? 0, 'preparation estimate');
  if (!input.unknownFileMs) throw new RangeError('The unknown-file estimate must be positive.');
  if (input.spread) validSpread(input.spread);
}
function validSpread({ min, max, ceilingMs }: PartSpread): void {
  if (!Number.isInteger(min) || min < 1 || !Number.isInteger(max) || max < min) throw new RangeError('Invalid part spread: use whole numbers with 1 <= min <= max.');
  if (!Number.isFinite(ceilingMs) || ceilingMs <= 0) throw new RangeError('Invalid part ceiling: use a finite positive number.');
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
/* Machines whose paces differ by less than this go at one pace: their parts are laid out evenly and may run on any of them. */
const ONE_PACE = 1.1;
/* The fastest machines first; without known paces, as many of one pace as there are free machines. */
function pacesOf(input: TestPartPlanInput): MachinePace[] {
  const known = [...(input.machines ?? [])].filter(machine => Number.isFinite(machine.pace) && machine.pace > 0).sort((a, b) => a.pace - b.pace || lexical(a.key, b.key));
  return known.length ? known : Array.from({ length: Math.max(1, input.availableMachines) }, () => ({ key: '', pace: 1 }));
}
/* Each group goes where it would end soonest on that part's machine, so a faster machine gets more. The first machine starts
   with the preparation, so it gets that much less; a part it has nothing for is left out. */
function distribute(groups: Group[], machines: MachinePace[], paced: boolean, preparationMs: number): { parts: PlannedTestPart[]; longest: number } {
  const parts = machines.map((machine, index) => ({ units: [] as TestUnit[], testMs: 0, startMs: index ? 0 : preparationMs, pace: machine.pace, key: machine.key }));
  const end = (part: (typeof parts)[number], ms = 0) => (part.startMs + part.testMs + ms) * (paced ? part.pace : 1);
  for (const group of groups) {
    const part = parts.reduce((best, next) => end(next, group.ms) < end(best, group.ms) ? next : best);
    part.units.push(...group.units);
    part.testMs += group.ms;
  }
  const longest = Math.max(...parts.map(part => paced ? Math.round(end(part)) : end(part)));
  return { longest, parts: parts.filter(part => part.units.length).map(({ units, testMs, pace, key }) => ({ units, testMs, ...(paced ? { machine: { key, ms: Math.round(testMs * pace) } } : {}) })) };
}
/* A part laid out for no machine may go to any, so it may take as long as the slowest one takes. With more parts than lanes, the
   machines free at once, the lanes share the work of all of them. */
function alternative(groups: Group[], machines: MachinePace[], costs: TestPartPlanInput['costs'], paced: boolean, preparationMs: number, slowest = 1, lanes = machines.length): Alternative {
  const count = machines.length, { parts, longest } = distribute(groups, machines, paced, preparationMs);
  const busiest = count > lanes ? Math.max(longest, (preparationMs + parts.reduce((sum, part) => sum + part.testMs, 0)) / lanes) : longest;
  const partMs = costs.setupMs + Math.max(...parts.map(part => part.machine ? part.machine.ms : part.testMs * slowest));
  /* Setup can overlap across machines; collecting every result still costs time. Charge the extra machines' setup
     separately when choosing, rather than claiming that extra resource cost is measured wall time. */
  const estimatedWallMs = costs.setupMs + busiest + count * costs.collectMs;
  const costAdjustedMs = estimatedWallMs + (count - 1) * costs.setupMs;
  nonnegative(costAdjustedMs, 'estimated total cost');
  return { parts, partMs, estimate: { parts: count, estimatedWallMs, costAdjustedMs } };
}
/* Each count a run may take. A count beyond the free machines waits for machines as they free, at one pace, so its
   parts are laid out evenly and counted at the pace of the slowest machine. */
function spreadOptions(groups: Group[], machines: MachinePace[], input: TestPartPlanInput, paced: boolean, spread: PartSpread): { options: Alternative[]; least: number; most: number } {
  const most = Math.min(spread.max, MAX_TEST_PARTS, groups.length), least = Math.min(spread.min, most);
  const slowest = machines[machines.length - 1]!.pace, preparationMs = input.preparationMs ?? 0;
  const options = Array.from({ length: most - least + 1 }, (_, index) => least + index).map(count => count <= machines.length
    ? alternative(groups, machines.slice(0, count), input.costs, paced, preparationMs, slowest)
    : alternative(groups, Array.from({ length: count }, () => ({ key: '', pace: slowest })), input.costs, false, preparationMs, slowest, machines.length));
  return { options, least, most };
}
const cheapest = (options: Alternative[]): Alternative => options.reduce((chosen, next) => next.estimate.costAdjustedMs < chosen.estimate.costAdjustedMs ? next : chosen);
/* The cheapest count whose every part ends within the ceiling; when none does, the one whose longest part is shortest. */
function withinCeiling(options: Alternative[], ceilingMs: number): Alternative {
  const fitting = options.filter(option => option.partMs <= ceilingMs);
  return fitting.length ? cheapest(fitting) : options.reduce((chosen, next) => next.partMs < chosen.partMs ? next : chosen);
}
function spreadReason(spread: PartSpread, least: number, most: number, best: Alternative): string {
  const fits = best.partMs <= spread.ceilingMs ? '' : `; no count fits that, so its longest part is estimated at ${best.partMs} ms`;
  return ` This run takes ${least} to ${most} parts of at most ${spread.ceilingMs} ms each${fits}.`;
}
type Choice = { single: Alternative; options: Alternative[]; best: Alternative; note: string };
/* The layouts a run may take and the one it takes: the cheapest that fits its ceiling, or the cheapest of all for a run without one. */
function choose(groups: Group[], machines: MachinePace[], input: TestPartPlanInput, paced: boolean): Choice {
  const preparationMs = input.preparationMs ?? 0, single = alternative(groups, machines.slice(0, 1), input.costs, paced, preparationMs);
  if (!input.spread) {
    const limit = Math.min(MAX_TEST_PARTS, machines.length, groups.length);
    const options = [single, ...Array.from({ length: limit - 1 }, (_, index) => alternative(groups, machines.slice(0, index + 2), input.costs, paced, preparationMs))];
    return { single, options, best: cheapest(options), note: '' };
  }
  const { options, least, most } = spreadOptions(groups, machines, input, paced, input.spread);
  const best = withinCeiling(options, input.spread.ceilingMs);
  return { single, options, best, note: spreadReason(input.spread, least, most, best) };
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
  const timed = timedUnits(input), groups = groupsOf(timed), machines = pacesOf(input);
  const paced = machines[machines.length - 1]!.pace / machines[0]!.pace >= ONE_PACE;
  const preparationMs = input.preparationMs ?? 0, { single, options, best, note } = choose(groups, machines, input, paced);
  const bound = best.parts.some(part => part.machine);
  /* At one pace any machine takes any part: the part laid out beside the preparation goes last, for the machine it frees. */
  const parts = preparationMs && !bound && best.parts.length === best.estimate.parts ? [...best.parts.slice(1), best.parts[0]!] : best.parts;
  const unknownUnits = timed.filter(item => item.unknown).map(item => item.unit);
  const oneMachineMs = single.estimate.estimatedWallMs;
  const reason = reasonFor(input, best, oneMachineMs, unknownUnits.length) + note;
  return { parts, oneMachineMs, estimatedWallMs: best.estimate.estimatedWallMs,
    costAdjustedMs: best.estimate.costAdjustedMs, alternatives: options.map(option => option.estimate), unknownUnits,
    waitingForCapacity: input.availableMachines === 0, reason,
    ...(preparationMs && bound ? { preparationMachine: machines[0]!.key } : {}) };
}
