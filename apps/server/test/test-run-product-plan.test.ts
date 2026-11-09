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
  it('starts the batches beside a separate preparation, without running its suite again, and keeps its final checks after it', async () => {
    const input = await fixture(true), plan = await planProductParts(input);
    expect(plan.leaves).toEqual([
      { selection: { kind: 'prepare', version: 2, expectedCommitSha: input.expectedCommitSha }, after: [] },
      { selection: { kind: 'batch', version: 2, expectedCommitSha: input.expectedCommitSha, selections: [{ kind: 'suite', suiteId: 'pytest', files: ['python/tests/test_values.py'], shard: { index: 1, count: 1 } }] }, after: [] },
      { selection: { kind: 'final', suiteId: 'vitest', files: [] }, after: [1] },
    ]);
    expect(plan.reason).toContain('One explicit preparation runs 1 suites and 1 commands beside the batches.');
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
  it('keeps the final checks of a suite whose files were all reused: no file proves them', async () => {
    const input = await fixture(), reused = new Set(input.units.map(unit => `${unit.suiteId}\0${unit.file}`));
    const plan = await planProductParts({ ...input, reuse: { reused, preparation: false } });
    expect(plan.leaves).toEqual([{ selection: { kind: 'final', suiteId: 'vitest', files: [] }, after: [] }]);
  });
  it('waits for no preparation that was reused, also for the final checks of its suites', async () => {
    const input = await fixture(true), reused = new Set(input.units.map(unit => `${unit.suiteId}\0${unit.file}`));
    const plan = await planProductParts({ ...input, reuse: { reused, preparation: true } });
    expect(plan.leaves).toEqual([{ selection: { kind: 'final', suiteId: 'vitest', files: [] }, after: [] }]);
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

async function candidateFixture(options: { whole?: boolean; added?: boolean } = {}) {
  const input = options.whole ? await planningEnvironment({ whole: true }) : await fixture(true);
  if (options.whole) {
    const manifest = input.snapshot.description.manifest;
    manifest.execution = { version: 2 };
    input.snapshot.description.manifestSource = JSON.stringify(manifest);
    input.snapshot.description.manifestHash = await hashTestEnvironment(input.snapshot.description.manifestSource);
  }
  const fingerprints = input.units.map((unit, index) => ({ suiteId: unit.suiteId, file: unit.file, fingerprint: String(index + 1).repeat(64) }));
  const baseFingerprints = fingerprints.flatMap((print, index) => options.added && index === 1 ? [] : [{ ...print, fingerprint: index === 1 ? 'f'.repeat(64) : print.fingerprint }]);
  const candidate = { baseCommit: 'b'.repeat(40), baseFingerprints, fingerprints };
  Object.assign(input.snapshot, { candidate });
  return { input, candidate };
}

describe('candidate scope before product part planning', () => {
  it('plans no command when every influencing fingerprint is unchanged at the bound base', async () => {
    const { input, candidate } = await candidateFixture();
    candidate.baseFingerprints = candidate.fingerprints.map(print => ({ ...print }));
    const plan = await planProductParts(input);
    expect(plan.leaves).toEqual([]);
    expect(plan.estimate).toBeNull();
    expect(plan.reason).toMatch(/no.*changed influencing fingerprint/i);
  });
  it.each([false, true])('plans only changed influencing fingerprints, including newly added tests=%s', async added => {
    const { input } = await candidateFixture({ added });
    const plan = await planProductParts(input);
    expect(plan.leaves.some(leaf => leaf.selection.kind === 'prepare')).toBe(false);
    expect(batches(plan).flatMap(batch => batch.selections.flatMap(suite => suite.files))).toEqual(['web/test/b.test.ts']);
    expect(plan.leaves.filter(leaf => leaf.selection.kind === 'final')).toEqual([{ selection: { kind: 'final', suiteId: 'vitest', files: [] }, after: [1] }]);
  });

  it('keeps an indivisible suite group together when one influencing fingerprint changes', async () => {
    const { input } = await candidateFixture({ whole: true });
    const plan = await planProductParts(input);
    expect(batches(plan).flatMap(batch => batch.selections.flatMap(suite => suite.files)).sort()).toEqual(['web/test/a.test.ts', 'web/test/b.test.ts']);
  });

  it('rejects a caller selection that omits an affected canonical unit', async () => {
    const { input } = await candidateFixture();
    await expect(planProductParts({ ...input, units: [input.units[0]!] })).rejects.toThrow();
  });

  it('requires complete and unique final fingerprints before omitting any test', async () => {
    for (const problem of ['missing', 'duplicate'] as const) {
      const { input, candidate } = await candidateFixture();
      if (problem === 'missing') candidate.fingerprints.pop();
      else candidate.fingerprints.push(candidate.fingerprints[0]!);
      await expect(planProductParts(input)).rejects.toThrow();
    }
  });
});
