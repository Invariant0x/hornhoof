import { EnvironmentSnapshot, hashTestEnvironment, parseTestEnvironment } from '@hornhoof/protocol';
import type { PreparedEnvironmentPlanInput } from '../../../src/modules/testruns/plan-environment.js';

export async function planningEnvironment(options: { whole?: boolean; pythonFinalOnly?: boolean } = {}): Promise<PreparedEnvironmentPlanInput> {
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
