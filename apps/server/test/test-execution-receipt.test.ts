import { EnvironmentSnapshot, TestExecution, TestEnvironmentReceipt, hashTestEnvironment, type NodeMessage } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { productReceipt } from '../src/modules/testruns/describe.js';
import { planningEnvironment } from './fixtures/run-planning/environment.js';

async function fixture(prepare = false) {
  const input = await planningEnvironment(), base = input.snapshot;
  const manifest = { ...base.description.manifest, execution: { version: 2, oncePreparation: { profiles: ['final'], suiteIds: ['vitest'], commands: [{ program: 'node', args: ['types.js'], cwd: '.' }] } } };
  const runtimes = [{ id: 'node', version: '22.23.4', fingerprint: 'b'.repeat(64) }, { id: 'python', version: '3.12.0', fingerprint: 'c'.repeat(64) }, { id: 'hornhoof-test-execution', version: '2.0.0', fingerprint: 'd'.repeat(64) }];
  const manifestSource = JSON.stringify(manifest);
  const snapshot = EnvironmentSnapshot.parse({ profile: prepare ? 'final' : 'fast', description: { ...base.description, manifest, manifestSource, manifestHash: await hashTestEnvironment(manifestSource), runtimeCapabilities: runtimes } });
  const selection = TestExecution.parse({ snapshot, selection: prepare ? { kind: 'prepare', version: 2, expectedCommitSha: input.expectedCommitSha } : {
    kind: 'batch', version: 2, expectedCommitSha: input.expectedCommitSha, selections: [
      { kind: 'suite', suiteId: 'vitest', files: ['web/test/a.test.ts'], shard: { index: 1, count: 2 } },
      { kind: 'suite', suiteId: 'pytest', files: ['python/tests/test_values.py'], shard: { index: 1, count: 1 } },
    ],
  } }).selection;
  const receipt = TestEnvironmentReceipt.parse({ version: 2, commitSha: input.expectedCommitSha, manifestHash: snapshot.description.manifestHash, profile: snapshot.profile, selection,
    outcomes: [{ index: 0, status: 'passed', exitCode: 0 }, { index: 1, status: 'passed', exitCode: 0 }],
    runtimes, dependencies: { key: null, hit: false }, environments: [], phases: { checkoutMs: 0, dependenciesMs: 0, environmentMs: 0, servicesMs: 0, commandMs: 0, cleanupMs: 0 } });
  const message: Extract<NodeMessage, { type: 'tests.done' }> = { type: 'tests.done', partId: 'part-id', ok: true, exitCode: 0, error: null, commit: input.expectedCommitSha, log: '', environmentReceipt: receipt };
  return { snapshot, assigned: { selection, after: [] }, message, receipt, runtimes };
}

describe('server versioned execution receipts', () => {
  it.each([false, true])('accepts every complete assigned outcome for prepare=%s', async prepare => {
    const f = await fixture(prepare);
    expect(productReceipt(f.snapshot, f.assigned, f.message, f.runtimes)).toEqual(f.receipt);
  });
  it('retains a failed batch receipt for diagnostics while keeping the part failed', async () => {
    const f = await fixture();
    const receipt = TestEnvironmentReceipt.parse({ ...f.receipt, outcomes: [{ index: 0, status: 'failed', exitCode: 7 }, { index: 1, status: 'passed', exitCode: 0 }] });
    expect(productReceipt(f.snapshot, f.assigned, { ...f.message, ok: false, error: 'failed', exitCode: 7, environmentReceipt: receipt }, f.runtimes)).toEqual(receipt);
  });
  it('refuses an incomplete preparation even when the message claims success', async () => {
    const f = await fixture(true), receipt = TestEnvironmentReceipt.parse({ ...f.receipt, outcomes: [{ index: 0, status: 'passed', exitCode: 0 }] });
    expect(productReceipt(f.snapshot, f.assigned, { ...f.message, environmentReceipt: receipt }, f.runtimes)).toBeNull();
  });
  it('refuses a successful message with a failed member', async () => {
    const f = await fixture(), receipt = TestEnvironmentReceipt.parse({ ...f.receipt, outcomes: [{ index: 0, status: 'failed', exitCode: 7 }, { index: 1, status: 'passed', exitCode: 0 }] });
    expect(productReceipt(f.snapshot, f.assigned, { ...f.message, environmentReceipt: receipt }, f.runtimes)).toBeNull();
  });
  it('refuses a receipt for another profile or another assigned selection', async () => {
    const f = await fixture();
    const receipt = TestEnvironmentReceipt.parse({ ...f.receipt, profile: 'final' });
    expect(productReceipt(f.snapshot, f.assigned, { ...f.message, environmentReceipt: receipt }, f.runtimes)).toBeNull();
    const other = TestExecution.parse({ snapshot: f.snapshot, selection: { kind: 'batch', version: 2, expectedCommitSha: f.snapshot.description.commitSha, selections: [
      { kind: 'suite', suiteId: 'vitest', files: ['web/test/b.test.ts'], shard: { index: 2, count: 2 } },
    ] } }).selection;
    expect(productReceipt(f.snapshot, { selection: other, after: [] }, f.message, f.runtimes)).toBeNull();
  });
  it('requires the authenticated native executor fingerprint', async () => {
    const f = await fixture(), known = f.runtimes.map(runtime => runtime.id === 'hornhoof-test-execution' ? { ...runtime, fingerprint: 'e'.repeat(64) } : runtime);
    expect(productReceipt(f.snapshot, f.assigned, f.message, known)).toBeNull();
  });
});

async function mutationReceiptFixture() {
  const f = await fixture(), description = structuredClone(f.snapshot.description), file = 'logic/totals.ts';
  const command = { program: 'node', args: ['mutate.mjs'], cwd: '.' };
  description.manifest.mutation = { status: 'supported', language: 'typescript', tool: 'mutator', command, sourcePaths: [file], fastTestPaths: ['web/test/a.test.ts'], coverageCommands: [command], coverageFiles: ['coverage.json'] };
  description.manifest.suites.push({ id: 'mutation', root: '.', files: [file], run: command, split: { kind: 'json-file' }, profiles: ['fast', 'final'] });
  for (const profile of description.manifest.profiles) profile.requiredSuiteIds.push('mutation');
  description.inventory.push({ suiteId: 'mutation', file, selectionUnit: file });
  description.manifestSource = JSON.stringify(description.manifest);
  description.manifestHash = await hashTestEnvironment(description.manifestSource);
  const baseCommit = '1'.repeat(40), commit = description.commitSha;
  const mutation = { delta: { baseCommit, commit, changes: [{ path: file, ranges: [[1, 1] as [number, number]] }] },
    selection: { version: 1 as const, status: 'ready' as const, baseCommit, commit,
      selected: [{ file, name: 'total', startLine: 1, endLine: 1, lines: [1], tests: ['web/test/a.test.ts'], reason: 'changed_pure_function' as const }], excluded: [], problems: [] },
  };
  const fingerprints = description.inventory.map(unit => ({ suiteId: unit.suiteId, file: unit.file, fingerprint: 'e'.repeat(64) }));
  const snapshot = EnvironmentSnapshot.parse({ description, profile: 'fast', candidate: { baseCommit, mutation, fingerprints, baseFingerprints: fingerprints.map(print => ({ ...print, fingerprint: 'f'.repeat(64) })) } });
  const selection = TestExecution.parse({ snapshot, selection: { kind: 'batch', version: 2, expectedCommitSha: commit,
    selections: [{ kind: 'suite', suiteId: 'mutation', files: [file], shard: { index: 1, count: 1 } }] } }).selection;
  const receipt = TestEnvironmentReceipt.parse({ ...f.receipt, manifestHash: description.manifestHash, selection, outcomes: [{ index: 0, status: 'passed', exitCode: 0 }] });
  return { ...f, snapshot, receipt, mutation, assigned: { selection, after: [] } };
}

it('requires the actual narrow mutation outcome even when the process and batch report passed', async () => {
  const f = await mutationReceiptFixture();
  expect(productReceipt(f.snapshot, f.assigned, { ...f.message, environmentReceipt: f.receipt }, f.runtimes)).toBeNull();
});

it('retains exact base/head/function mutation evidence from the assigned suite', async () => {
  const f = await mutationReceiptFixture();
  const receipt = Object.assign({}, f.receipt, { mutations: [{ suiteId: 'mutation', selection: f.mutation.selection }] });
  expect(productReceipt(f.snapshot, f.assigned, { ...f.message, environmentReceipt: receipt }, f.runtimes)).toEqual(receipt);
});

it.each(['base', 'head', 'function-lines', 'empty', 'duplicate'] as const)('refuses %s mutation provenance in an otherwise passed batch', async problem => {
  const f = await mutationReceiptFixture(), selection = structuredClone(f.mutation.selection);
  if (problem === 'base') selection.baseCommit = '2'.repeat(40);
  if (problem === 'head') selection.commit = '2'.repeat(40);
  if (problem === 'function-lines') Object.assign(selection.selected[0]!, { endLine: 2, lines: [1, 2] });
  if (problem === 'empty') selection.selected = [];
  const mutations = [{ suiteId: 'mutation', selection }];
  if (problem === 'duplicate') mutations.push(mutations[0]!);
  const receipt = Object.assign({}, f.receipt, { mutations });
  expect(productReceipt(f.snapshot, f.assigned, { ...f.message, environmentReceipt: receipt }, f.runtimes)).toBeNull();
});

it('refuses a noncanonical legacy receipt even when its unlisted files match the assignment', async () => {
  const f = await fixture(), selection = { kind: 'suite' as const, suiteId: 'vitest', files: ['web/test/not-in-inventory.test.ts'] };
  const { profile: _profile, selection: _selection, outcomes: _outcomes, ...identity } = f.receipt as Extract<TestEnvironmentReceipt, { version: 2 }>;
  const receipt = TestEnvironmentReceipt.parse({ ...identity, version: 1, ...selection });
  expect(productReceipt(f.snapshot, { selection, after: [] }, { ...f.message, environmentReceipt: receipt }, f.runtimes)).toBeNull();
});
