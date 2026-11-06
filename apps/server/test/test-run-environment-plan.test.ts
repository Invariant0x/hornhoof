import { describe, expect, it } from 'vitest';
import { planEnvironmentParts } from '../src/modules/testruns/plan-environment.js';
import { planningEnvironment as fixture } from './fixtures/run-planning/environment.js';

describe('pinned environment part planning', () => {
  it('retains the exact source, environment and all selected Vitest and pytest files', async () => {
    const input = await fixture(), plan = await planEnvironmentParts(input);
    expect(plan.commitSha).toBe(input.expectedCommitSha);
    expect(plan.manifestHash).toBe(input.snapshot.description.manifestHash);
    expect(plan.profile).toBe('fast');
    expect(plan.parts).toHaveLength(3);
    expect(plan.parts.flatMap(part => part.selections.flatMap(selection => selection.files)).sort()).toEqual(input.units.map(u => u.file).sort());
    expect(plan.postSuiteChecks).toEqual([{ suiteId: 'vitest', commands: input.snapshot.description.manifest.suites[0]!.finalChecks }]);
    expect(plan.ports.finalPreparation).toBe('not-required');
  });

  it('rejects a snapshot for another prepared candidate instead of repinning a branch', async () => {
    await expect(planEnvironmentParts({ ...await fixture(), expectedCommitSha: 'b'.repeat(40) })).rejects.toThrow(/commit/i);
  });

  it('binds suite-local coordinates to the canonical mixed environment plan', async () => {
    const plan = await planEnvironmentParts(await fixture());
    const coordinates = plan.parts.flatMap(part => part.suiteShards);
    expect(coordinates.filter(shard => shard.suiteId === 'vitest')).toEqual([
      { suiteId: 'vitest', index: 1, count: 2 }, { suiteId: 'vitest', index: 2, count: 2 },
    ]);
    expect(coordinates.filter(shard => shard.suiteId === 'pytest')).toEqual([{ suiteId: 'pytest', index: 1, count: 1 }]);
  });

  it('rejects an unbound manifest hash', async () => {
    const input = await fixture(); input.snapshot.description.manifestHash = '0'.repeat(64);
    await expect(planEnvironmentParts(input)).rejects.toThrow(/hash/i);
  });

  it('rejects a selected file that is absent from the canonical snapshot inventory', async () => {
    const input = await fixture(); input.units[0] = { ...input.units[0]!, file: 'web/test/foreign.test.ts' };
    await expect(planEnvironmentParts(input)).rejects.toThrow(/canonical.*inventory/i);
  });

  it('rejects a forged selection group on an otherwise canonical file', async () => {
    const input = await fixture(); input.units[0] = { ...input.units[0]!, selectionUnit: 'other-package' };
    await expect(planEnvironmentParts(input)).rejects.toThrow(/canonical.*inventory/i);
  });

  it('rejects tests from a suite outside the selected profile', async () => {
    await expect(planEnvironmentParts(await fixture({ pythonFinalOnly: true }))).rejects.toThrow(/profile/i);
  });

  it('does not split or truncate a whole-package suite', async () => {
    const input = await fixture({ whole: true }); input.units = [input.units[0]!];
    await expect(planEnvironmentParts(input)).rejects.toThrow(/whole-package/i);
  });

  it('retains multiple suite selections in one logical part and names the missing batch port', async () => {
    const input = await fixture(); input.availableMachines = 1;
    const plan = await planEnvironmentParts(input);
    expect(plan.parts).toHaveLength(1);
    expect(plan.parts[0]!.selections.map(selection => selection.suiteId)).toEqual(['pytest', 'vitest']);
    expect(plan.parts[0]!.selections.every(selection => selection.kind === 'suite')).toBe(true);
    expect(plan.ports.suiteBatch).toBe('required');
    expect(plan.testPlan.reason).toContain('1');
  });

  it('rejects a partial final-candidate inventory', async () => {
    const input = await fixture(); input.purpose = 'final'; input.units = [input.units[0]!];
    await expect(planEnvironmentParts(input)).rejects.toThrow(/final.*inventory/i);
  });

  it('names the missing global preparation phase without relabeling or dropping existing final checks', async () => {
    const input = await fixture(); input.purpose = 'final'; input.snapshot.profile = 'final';
    const plan = await planEnvironmentParts(input);
    expect(plan.ports.finalPreparation).toBe('missing');
    expect(plan.postSuiteChecks).toEqual([{ suiteId: 'vitest', commands: input.snapshot.description.manifest.suites[0]!.finalChecks }]);
    expect(plan.parts.flatMap(part => part.selections).every(selection => selection.kind === 'suite')).toBe(true);
  });
});
