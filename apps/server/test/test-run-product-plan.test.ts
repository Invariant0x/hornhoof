import { hashTestEnvironment } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { planProductParts } from '../src/modules/testruns/plan-product.js';
import { planningEnvironment } from './fixtures/run-planning/environment.js';

async function fixture(once = false) {
  const input = await planningEnvironment(), manifest = input.snapshot.description.manifest;
  manifest.execution = { version: 2, ...(once ? { oncePreparation: { profiles: ['fast', 'final'], suiteIds: ['vitest'], commands: [{ program: 'node', args: ['types.js'], cwd: '.' }] } } : {}) };
  input.snapshot.description.manifestSource = JSON.stringify(manifest);
  input.snapshot.description.manifestHash = await hashTestEnvironment(input.snapshot.description.manifestSource);
  return input;
}
const batches = (plan: Awaited<ReturnType<typeof planProductParts>>) => plan.leaves.flatMap(leaf => leaf.selection.kind === 'batch' ? [leaf.selection] : []);

describe('versioned product execution planning', () => {
  it('runs a small selection in one mixed batch and retains the post-suite checks', async () => {
    const input = await fixture(); input.availableMachines = 1;
    const plan = await planProductParts(input);
    expect(plan.leaves).toHaveLength(2);
    expect(batches(plan)[0]!.selections.map(selection => selection.suiteId)).toEqual(['pytest', 'vitest']);
    expect(plan.leaves[1]).toEqual({ selection: { kind: 'final', suiteId: 'vitest', files: [] }, after: [1] });
    expect(plan.reason).toContain('1 parts');
  });
  it('uses free capacity for balanced batches with suite-local coordinates and the exact source', async () => {
    const input = await fixture(), plan = await planProductParts(input), selected = batches(plan);
    expect(selected).toHaveLength(3);
    expect(selected.every(selection => selection.expectedCommitSha === input.expectedCommitSha)).toBe(true);
    expect(selected.flatMap(batch => batch.selections.flatMap(suite => suite.files)).sort()).toEqual(input.units.map(unit => unit.file).sort());
    expect(selected.flatMap(batch => batch.selections).filter(suite => suite.suiteId === 'vitest').map(suite => suite.shard)).toEqual([{ index: 1, count: 2 }, { index: 2, count: 2 }]);
    expect(plan.estimate!.parts.map(part => part.testMs)).toEqual([30_000, 30_000, 30_000]);
  });
  it('gates all batches on a separate preparation without running its suite again', async () => {
    const input = await fixture(true), plan = await planProductParts(input);
    expect(plan.leaves).toEqual([
      { selection: { kind: 'prepare', version: 2, expectedCommitSha: input.expectedCommitSha }, after: [] },
      { selection: { kind: 'batch', version: 2, expectedCommitSha: input.expectedCommitSha, selections: [{ kind: 'suite', suiteId: 'pytest', files: ['python/tests/test_values.py'], shard: { index: 1, count: 1 } }] }, after: [1] },
      { selection: { kind: 'final', suiteId: 'vitest', files: [] }, after: [1] },
    ]);
  });
  it('retains every suite prerequisite for a final leaf after splitting', async () => {
    const plan = await planProductParts(await fixture());
    const suiteParts = plan.leaves.flatMap((leaf, index) => leaf.selection.kind === 'batch' && leaf.selection.selections.some(suite => suite.suiteId === 'vitest') ? [index + 1] : []);
    expect(plan.leaves.find(leaf => leaf.selection.kind === 'final')!.after).toEqual(suiteParts);
  });
  it('queues one batch when no compatible machine is free instead of inventing capacity', async () => {
    const input = await fixture(); input.availableMachines = 0;
    const plan = await planProductParts(input);
    expect(batches(plan)).toHaveLength(1); expect(plan.estimate!.waitingForCapacity).toBe(true);
    expect(plan.reason).toContain('No compatible machine is free');
  });
  it('checks the real expected candidate and the full final inventory before excluding once-only work', async () => {
    const input = await fixture(true);
    await expect(planProductParts({ ...input, expectedCommitSha: 'f'.repeat(40) })).rejects.toThrow(/commit/i);
    await expect(planProductParts({ ...input, purpose: 'final', units: [input.units[2]!] })).rejects.toThrow(/final.*inventory/i);
  });
  it('reserves the ten-part budget for preparation and all existing final leaves', async () => {
    const input = await fixture(true), manifest = input.snapshot.description.manifest, base = manifest.suites[0]!;
    manifest.suites = Array.from({ length: 8 }, (_, index) => ({ ...base, id: `suite-${index}`, profiles: ['fast'], files: [`web/test/${index}.test.ts`] }));
    manifest.profiles = [{ id: 'fast', requiredSuiteIds: manifest.suites.map(suite => suite.id) }];
    manifest.execution!.oncePreparation!.profiles = ['fast']; manifest.execution!.oncePreparation!.suiteIds = ['suite-0'];
    input.units = manifest.suites.map((suite, index) => ({ suiteId: suite.id, file: `web/test/${index}.test.ts`, selectionUnit: `web/test/${index}.test.ts` }));
    input.snapshot.description.inventory = input.units; input.availableMachines = 20;
    input.snapshot.description.manifestSource = JSON.stringify(manifest); input.snapshot.description.manifestHash = await hashTestEnvironment(input.snapshot.description.manifestSource);
    const plan = await planProductParts(input);
    expect(plan.leaves).toHaveLength(10); expect(batches(plan)).toHaveLength(1);
    expect(plan.leaves.filter(leaf => leaf.selection.kind === 'final')).toHaveLength(8);
  });
});
