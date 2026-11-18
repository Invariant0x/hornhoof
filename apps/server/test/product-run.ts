import { EnvironmentSnapshot, hashTestEnvironment, parseTestEnvironment, type RepositoryScope, type TestEnvironmentReceipt } from '@hornhoof/protocol';

/* A whole run of a product's tests as the machines leave it, for tests that need a run a release accepts: the snapshot of the
   product described on a commit, and each part's selection and receipt. Nothing here starts an app or opens a database. */

export const PRODUCT_FILES = ['checks/a.test.ts', 'checks/b.test.ts'];
const RUNTIMES = [{ id: 'node', version: '22.0.0', fingerprint: 'e'.repeat(64) }, { id: 'hornhoof-test-execution', version: '2.0.0', fingerprint: 'f'.repeat(64) }];

/* What the machine that described a commit said of the product: its manifest, whose full run is the profile full, and its test files. */
export async function productSnapshot(repositoryScope: RepositoryScope, commitSha: string): Promise<EnvironmentSnapshot> {
  const manifest = parseTestEnvironment({
    version: 1, defaultProfile: 'fast', runtimes: [{ id: 'node', version: '22' }],
    profiles: [{ id: 'fast', requiredSuiteIds: ['unit'] }, { id: 'full', requiredSuiteIds: ['unit'] }],
    dependencies: { adapter: 'none', inputs: [], install: [], paths: [], cache: 'none' }, services: [], prepare: [], reset: null,
    suites: [{ id: 'unit', root: '.', files: ['checks/*.test.ts'], profiles: ['fast', 'full'], run: { program: 'node', args: ['--test'], cwd: '.' }, split: { kind: 'argv-files' } }],
    impact: { adapter: 'whole-package', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'None.' } },
    mutation: { status: 'unsupported', language: 'typescript', reason: 'None.' },
    execution: { version: 2, fullRun: { replaces: 'fast', profile: 'full' } },
  });
  const manifestSource = JSON.stringify(manifest);
  return EnvironmentSnapshot.parse({ profile: 'full', description: { version: 1, repositoryScope, commitSha, manifestSource, manifest, manifestHash: await hashTestEnvironment(manifestSource),
    inputDigests: [], inventory: PRODUCT_FILES.map(file => ({ suiteId: 'unit', file, selectionUnit: file })), runtimeCapabilities: RUNTIMES } });
}

export const partSelection = (commit: string, file: string) => ({ kind: 'batch' as const, version: 2 as const, expectedCommitSha: commit, selections: [{ kind: 'suite' as const, suiteId: 'unit', files: [file], shard: { index: 1, count: 1 } }] });

/* What the node that ran a part sent with its end. */
export const partReceipt = (snapshot: EnvironmentSnapshot, selection: ReturnType<typeof partSelection>, passed: boolean): TestEnvironmentReceipt => ({
  version: 2, profile: snapshot.profile, selection, commitSha: snapshot.description.commitSha, manifestHash: snapshot.description.manifestHash, runtimes: RUNTIMES,
  outcomes: [passed ? { index: 0, status: 'passed', exitCode: 0 } : { index: 0, status: 'failed', exitCode: 1 }],
  dependencies: { key: null, hit: false }, environments: [], phases: { checkoutMs: 0, dependenciesMs: 0, environmentMs: 0, servicesMs: 0, commandMs: 0, cleanupMs: 0 },
});
