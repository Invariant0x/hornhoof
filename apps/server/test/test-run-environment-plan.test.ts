import { describe, expect, it } from 'vitest';
import { EnvironmentSnapshot, hashTestEnvironment, parseTestEnvironment } from '@hornhoof/protocol';
import { planEnvironmentParts, type PreparedEnvironmentPlanInput } from '../src/modules/testruns/plan-environment.js';

async function fixture(options: { whole?: boolean; pythonFinalOnly?: boolean } = {}): Promise<PreparedEnvironmentPlanInput> {
  const shared = ['fast', 'final'];
  const manifest = parseTestEnvironment({
    version: 1, defaultProfile: 'fast', runtimes: [{ id: 'node', version: '22' }, { id: 'python', version: '3.12' }],
    profiles: [{ id: 'fast', requiredSuiteIds: options.pythonFinalOnly ? ['vitest'] : ['vitest', 'pytest'] },
      { id: 'final', requiredSuiteIds: ['vitest', 'pytest'] }],
    dependencies: { adapter: 'none', inputs: [], install: [], paths: [], cache: 'none' },
    services: [], prepare: [], reset: null,
    suites: [
      { id: 'vitest', root: 'web', files: ['web/test/*.test.ts'], profiles: shared,
        run: { program: 'npx', args: ['--no-install', 'vitest', 'run'], cwd: 'web' },
        split: { kind: options.whole ? 'whole-package' : 'argv-files' },
        finalChecks: [{ program: 'npx', args: ['tsc', '--noEmit'], cwd: 'web' }] },
      { id: 'pytest', root: 'python', files: ['python/tests/test_*.py'], profiles: options.pythonFinalOnly ? ['final'] : shared,
        run: { program: 'python3', args: ['-m', 'pytest'], cwd: 'python' }, split: { kind: 'argv-files' }, finalChecks: [] },
    ],
    impact: { adapter: 'whole-package', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'No migration command.' } },
    mutation: { status: 'unsupported', language: 'typescript', reason: 'Not part of this fixture.' },
  });
  const units = [
    { suiteId: 'vitest', file: 'web/test/a.test.ts', selectionUnit: options.whole ? 'web' : 'web/test/a.test.ts' },
    { suiteId: 'vitest', file: 'web/test/b.test.ts', selectionUnit: options.whole ? 'web' : 'web/test/b.test.ts' },
    { suiteId: 'pytest', file: 'python/tests/test_values.py', selectionUnit: 'python/tests/test_values.py' },
  ];
  const manifestSource = JSON.stringify(manifest);
  const snapshot = EnvironmentSnapshot.parse({ profile: 'fast', description: {
    version: 1, repositoryScope: { companyId: '11111111-1111-4111-8111-111111111111',
      repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: 'f'.repeat(64) },
    commitSha: 'a'.repeat(40), manifestSource, manifest, manifestHash: await hashTestEnvironment(manifestSource),
    inputDigests: [], inventory: units, runtimeCapabilities: [],
  } });
  return { snapshot, expectedCommitSha: 'a'.repeat(40), purpose: 'affected', units: [...units],
    durations: units.map(u => ({ suiteId: u.suiteId, file: u.file, ms: 30_000 })),
    availableMachines: 3, costs: { setupMs: 100, collectMs: 10 }, unknownFileMs: 30_000 };
}

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
