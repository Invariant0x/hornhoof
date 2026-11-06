import { MAX_TEST_PARTS, TestExecution } from '@hornhoof/protocol';
import { planEnvironmentParts, type PreparedEnvironmentPlanInput, type EnvironmentPartPlan } from './plan-environment.js';
import type { TestPartPlan } from './plan.js';

export type ProductPlan = { leaves: { selection: TestExecution['selection']; after: number[] }[]; estimate: TestPartPlan | null; reason: string };

function batchLeaves(input: PreparedEnvironmentPlanInput, plan: EnvironmentPartPlan | null, prepared: boolean): ProductPlan['leaves'] {
  return (plan?.parts ?? []).map(part => ({
    selection: TestExecution.parse({ snapshot: input.snapshot, selection: { kind: 'batch', version: 2, expectedCommitSha: input.expectedCommitSha,
      selections: part.selections.map(selection => ({ ...selection, shard: part.suiteShards.find(shard => shard.suiteId === selection.suiteId)! })).map(selection => ({ ...selection, shard: { index: selection.shard.index, count: selection.shard.count } })),
    } }).selection,
    after: prepared ? [1] : [],
  }));
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
  const prefix = preparation ? `One explicit preparation runs ${preparation.suiteIds.length} suites and ${preparation.commands.length} commands before batches. ` : '';
  return prefix + (planned?.testPlan.reason ?? 'All selected suites run once in preparation; no batch is needed.');
}
function preparationLeaves(input: PreparedEnvironmentPlanInput, preparation: ReturnType<typeof preparationFor>): ProductPlan['leaves'] {
  if (!preparation) return [];
  return [{ selection: TestExecution.parse({ snapshot: input.snapshot, selection: { kind: 'prepare', version: 2, expectedCommitSha: input.expectedCommitSha } }).selection, after: [] }];
}
function planEstimate(planned: EnvironmentPartPlan | null): TestPartPlan | null {
  if (!planned) return null;
  return planned.testPlan;
}
export async function planProductParts(input: PreparedEnvironmentPlanInput): Promise<ProductPlan> {
  const preparation = preparationFor(input), onceIds = preparation?.suiteIds ?? [], finals = finalSuites(input, onceIds);
  const remaining = input.units.filter(unit => !onceIds.includes(unit.suiteId));
  const budget = MAX_TEST_PARTS - (preparation ? 1 : 0) - finals.length;
  if (budget < (remaining.length ? 1 : 0)) throw new Error('The product plan exceeds the supported part count.');
  const availableMachines = Math.min(input.availableMachines, Math.max(0, budget));
  const planned = await remainingPlan({ ...input, availableMachines }, remaining);
  const leaves = preparationLeaves(input, preparation);
  leaves.push(...batchLeaves(input, planned, preparation !== undefined));
  leaves.push(...finalLeaves(leaves, finals, onceIds));
  return { leaves, estimate: planEstimate(planned), reason: planReason(preparation, planned) };
}
