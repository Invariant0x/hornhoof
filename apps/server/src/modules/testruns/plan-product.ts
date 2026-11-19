import { MAX_TEST_PARTS, TestExecution } from '@hornhoof/protocol';
import { planEnvironmentParts, unitKey, type PreparedEnvironmentPlanInput, type EnvironmentPartPlan } from './plan-environment.js';
import type { PartSpread, TestPartPlan } from './plan.js';
import type { ReuseDecision } from './reuse.js';

export type ProductPlan = { leaves: { selection: TestExecution['selection']; after: number[]; computer?: string; estimatedMs?: number }[]; estimate: TestPartPlan | null; reason: string };

/* A batch needs nothing the preparation makes, so it starts at once; a preparation that fails stops it (runs.ts). */
function batchLeaves(input: PreparedEnvironmentPlanInput, plan: EnvironmentPartPlan | null): ProductPlan['leaves'] {
  if (!plan) return [];
  const slowest = Math.max(1, ...(input.machines ?? []).map(machine => machine.pace));
  const unknown = new Set(plan.testPlan.unknownUnits.map(unitKey));
  return plan.parts.map((part, index) => ({
    selection: TestExecution.parse({ snapshot: input.snapshot, selection: { kind: 'batch', version: 2, expectedCommitSha: input.expectedCommitSha,
      selections: part.selections.map(selection => ({ ...selection, shard: part.suiteShards.find(shard => shard.suiteId === selection.suiteId)! })).map(selection => ({ ...selection, shard: { index: selection.shard.index, count: selection.shard.count } })),
    } }).selection,
    after: [],
    ...batchEstimate(input, plan.testPlan.parts[index]!, unknown, slowest),
    ...(part.machine ? { computer: part.machine.key } : {}),
  }));
}
function batchEstimate(input: PreparedEnvironmentPlanInput, part: TestPartPlan['parts'][number], unknown: Set<string>, pace: number): { estimatedMs?: number } {
  if (part.units.every(unit => unknown.has(unitKey(unit)))) return {};
  return { estimatedMs: input.costs.setupMs + input.costs.collectMs + (part.machine?.ms ?? part.testMs * pace) };
}
function finalLeaves(leaves: ProductPlan['leaves'], suiteIds: string[], onceIds: string[]): ProductPlan['leaves'] {
  return suiteIds.map(suiteId => ({ selection: { kind: 'final', suiteId, files: [] }, after: onceIds.includes(suiteId) ? [1] : leaves.flatMap((leaf, index) =>
    leaf.selection.kind === 'batch' && leaf.selection.selections.some(selection => selection.suiteId === suiteId) ? [index + 1] : []) }));
}
function preparationFor(input: PreparedEnvironmentPlanInput) {
  const { manifest } = input.snapshot.description;
  if (!manifest.execution) throw new Error('A versioned product plan needs its pinned execution policy.');
  const policy = manifest.execution.oncePreparation;
  return policy?.profiles.includes(input.snapshot.profile) ? policy : undefined;
}
function finalSuites(input: PreparedEnvironmentPlanInput, onceIds: string[]): string[] {
  const selected = new Set([...input.units.map(unit => unit.suiteId), ...onceIds]);
  return input.snapshot.description.manifest.suites.filter(suite => selected.has(suite.id) && suite.finalChecks?.length).map(suite => suite.id);
}
async function remainingPlan(input: PreparedEnvironmentPlanInput, remaining: PreparedEnvironmentPlanInput['units']): Promise<EnvironmentPartPlan | null> {
  const complete = await planEnvironmentParts(input);
  if (remaining.length === input.units.length) return complete;
  return remaining.length ? planEnvironmentParts({ ...input, units: remaining, purpose: 'affected' }) : null;
}
function planReason(preparation: ReturnType<typeof preparationFor>, planned: EnvironmentPartPlan | null): string {
  const prefix = preparation ? `One explicit preparation runs ${preparation.suiteIds.length} suites and ${preparation.commands.length} commands beside the batches. ` : '';
  return prefix + (planned?.testPlan.reason ?? (preparation ? 'All selected suites run once in preparation; no batch is needed.' : 'Every selected file was reused; no batch is needed.'));
}
/* The preparation runs where the batches were laid out to leave it room, when the machines go at different paces. */
function preparationLeaves(input: PreparedEnvironmentPlanInput, preparation: ReturnType<typeof preparationFor>, planned: EnvironmentPartPlan | null): ProductPlan['leaves'] {
  if (!preparation) return [];
  const computer = planned?.testPlan.preparationMachine;
  return [{ selection: TestExecution.parse({ snapshot: input.snapshot, selection: { kind: 'prepare', version: 2, expectedCommitSha: input.expectedCommitSha } }).selection, after: [], ...(computer ? { computer } : {}),
    ...(input.preparationMs === undefined ? {} : { estimatedMs: input.preparationMs * (input.machines?.find(machine => machine.key === computer)?.pace ?? 1) }) }];
}
function planEstimate(planned: EnvironmentPartPlan | null): TestPartPlan | null {
  if (!planned) return null;
  return planned.testPlan;
}
type ReusingInput = PreparedEnvironmentPlanInput & { reuse?: ReuseDecision };

/* What is left to run once what was reused and what the preparation runs are left out. */
function remainingWork(input: ReusingInput) {
  const policy = preparationFor(input), onceIds = policy?.suiteIds ?? [];
  return {
    onceIds, preparation: input.reuse?.preparation ? undefined : policy,
    remaining: input.units.filter(unit => !onceIds.includes(unit.suiteId) && !input.reuse?.reused.has(unitKey(unit))),
  };
}
/* Leave a quarter of the planning window for a slower machine or a file that grew. */
export const PART_SHARE = 0.75;
/* Every run goes out in as many parts as keep each within that share of the planning window, at once on the free machines and one after another
   on one; the first run of a release in two at least. */
export function partSpread(full: boolean, limitMs: number): { spread: PartSpread } {
  return { spread: { min: full ? 2 : 1, max: MAX_TEST_PARTS, ceilingMs: Math.floor(limitMs * PART_SHARE) } };
}
/* A run's parts share the part count with its preparation and final checks. */
function spreadWithin(spread: PartSpread | undefined, budget: number): { spread?: PartSpread } {
  if (!spread) return {};
  const max = Math.max(1, Math.min(spread.max, budget));
  return { spread: { ...spread, max, min: Math.min(spread.min, max) } };
}
/* Plans what is left to run. No file proves a final check, so it stays; a reused preparation leaves nothing for the rest to wait for. */
export async function planProductParts(input: ReusingInput): Promise<ProductPlan> {
  const { onceIds, preparation, remaining } = remainingWork(input);
  const finals = finalSuites(input, onceIds);
  const budget = MAX_TEST_PARTS - (preparation ? 1 : 0) - finals.length;
  if (budget < (remaining.length ? 1 : 0)) throw new Error('The product plan exceeds the supported part count.');
  const availableMachines = Math.min(input.availableMachines, Math.max(0, budget)), { preparationMs, spread, ...rest } = input;
  const planned = await remainingPlan({ ...rest, availableMachines, ...(preparation && preparationMs ? { preparationMs } : {}), ...spreadWithin(spread, budget) }, remaining);
  const leaves = preparationLeaves(input, preparation, planned);
  leaves.push(...batchLeaves(input, planned));
  leaves.push(...finalLeaves(leaves, finals, preparation?.suiteIds ?? []));
  return { leaves, estimate: planEstimate(planned), reason: planReason(preparation, planned) };
}
