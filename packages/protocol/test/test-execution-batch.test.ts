import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EnvironmentSnapshot, TestEnvironmentV1, TestExecution, TestEnvironmentReceipt, supportsTestProfile } from '../src/test-environment.js';

const commit = 'a'.repeat(40);
const node = { id: 'node', version: '22.23.4', fingerprint: 'b'.repeat(64) };
const executor = { id: 'hornhoof-test-execution', version: '2.0.0', fingerprint: 'c'.repeat(64) };
const policy = { version: 2 as const, oncePreparation: { profiles: ['final'], suiteIds: ['api'], commands: [{ program: 'node', args: ['types.js'], cwd: '.' }] } };
function snapshot(enabled = true, profile = 'final') {
  const manifest = {
    version: 1, defaultProfile: 'fast', runtimes: [{ id: 'node', version: '22' }],
    profiles: [{ id: 'fast', requiredSuiteIds: ['api', 'worker'] }, { id: 'final', requiredSuiteIds: ['api', 'worker'] }],
    dependencies: { adapter: 'none', inputs: [], install: [], paths: [], cache: 'none' },
    services: [], prepare: [], reset: null,
    suites: [
      { id: 'api', root: 'api', files: ['api/*.test.ts'], run: { program: 'node', args: ['tests.js'], cwd: 'api' }, split: { kind: 'argv-files' }, profiles: ['fast', 'final'] },
      { id: 'worker', root: 'worker', files: ['worker/*.test.ts'], run: { program: 'node', args: ['tests.js'], cwd: 'worker' }, split: { kind: 'argv-files' }, profiles: ['fast', 'final'] },
    ],
    impact: { adapter: 'whole-package', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'No migrations.' } },
    mutation: { status: 'unsupported', language: 'typescript', reason: 'Not part of this fixture.' },
    ...(enabled ? { execution: policy } : {}),
  };
  const manifestSource = JSON.stringify(manifest);
  return { profile, description: { version: 1, commitSha: commit,
    repositoryScope: { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: 'd'.repeat(64) },
    manifest, manifestSource, manifestHash: createHash('sha256').update(manifestSource).digest('hex'), inputDigests: [],
    inventory: [
      { suiteId: 'api', file: 'api/a.test.ts', selectionUnit: 'api/a.test.ts' },
      { suiteId: 'api', file: 'api/b.test.ts', selectionUnit: 'api/b.test.ts' },
      { suiteId: 'worker', file: 'worker/one.test.ts', selectionUnit: 'worker/one.test.ts' },
    ], runtimeCapabilities: [node, executor] } };
}
function batch() {
  return { snapshot: snapshot(true, 'fast'), selection: { kind: 'batch', version: 2, expectedCommitSha: commit, selections: [
    { kind: 'suite', suiteId: 'api', files: ['api/a.test.ts'], shard: { index: 1, count: 2 } },
    { kind: 'suite', suiteId: 'worker', files: ['worker/one.test.ts'], shard: { index: 1, count: 1 } },
  ] } };
}
function receipt() {
  return { version: 2, commitSha: commit, profile: 'fast', manifestHash: batch().snapshot.description.manifestHash,
    selection: batch().selection, outcomes: [{ index: 0, status: 'passed', exitCode: 0 }, { index: 1, status: 'passed', exitCode: 0 }],
    runtimes: [node, executor], dependencies: { key: null, hit: false }, environments: [],
    phases: { checkoutMs: 1, dependenciesMs: 2, environmentMs: 3, servicesMs: 4, commandMs: 5, cleanupMs: 6 } };
}

describe('versioned product batches and explicit preparation', () => {
  it('accepts an explicit pinned manifest policy without reinterpreting finalChecks', () => {
    expect(TestEnvironmentV1.safeParse(snapshot().description.manifest).success).toBe(true);
  });
  it('preserves every selected suite and its local coordinates in the existing envelope', () => {
    const value = batch();
    expect(TestExecution.safeParse(value).success).toBe(true);
    expect(TestExecution.parse(value)).toEqual(value);
  });
  it('accepts a preparation leaf only for the declared profile and source', () => {
    const value = { snapshot: snapshot(), selection: { kind: 'prepare', version: 2, expectedCommitSha: commit } };
    expect(TestExecution.safeParse(value).success).toBe(true);
    expect(TestExecution.safeParse({ ...value, snapshot: snapshot(true, 'fast') }).success).toBe(false);
    expect(TestExecution.safeParse({ ...value, selection: { ...value.selection, commands: [{ program: 'other', args: [], cwd: '.' }] } }).success).toBe(false);
  });
  it('rejects an expected commit different from the snapshot before any selection executes', () => {
    const value = batch(); value.selection.expectedCommitSha = 'e'.repeat(40);
    expect(TestExecution.safeParse(value).success).toBe(false);
  });
  it('rejects a foreign file anywhere in a batch instead of executing its valid prefix', () => {
    const value = batch(); value.selection.selections[1]!.files = ['worker/foreign.test.ts'];
    expect(TestExecution.safeParse(value).success).toBe(false);
  });
  it('rejects duplicate suites instead of running a suite twice', () => {
    const value = batch(); value.selection.selections.push(value.selection.selections[0]!);
    expect(TestExecution.safeParse(value).success).toBe(false);
  });
  it('does not schedule a once-only suite again in the following batch', () => {
    expect(TestExecution.safeParse({ ...batch(), snapshot: snapshot() }).success).toBe(false);
  });
  it.each([{ index: 0, count: 2 }, { index: 3, count: 2 }, { index: 1, count: 0 }, { index: 1, count: 11 }])('rejects invalid local shard coordinates %j', shard => {
    const value = batch(); value.selection.selections[0]!.shard = shard;
    expect(TestExecution.safeParse(value).success).toBe(false);
  });
  it('requires native execution V2 capability, not just an ordinary node runtime', () => {
    const base = EnvironmentSnapshot.parse(snapshot(false)), manifest = { ...base.description.manifest, execution: policy };
    const manifestSource = JSON.stringify(manifest), manifestHash = createHash('sha256').update(manifestSource).digest('hex');
    const value = { ...base, description: { ...base.description, manifest, manifestSource, manifestHash } };
    expect(supportsTestProfile(value, [node])).toBe(false);
    expect(supportsTestProfile(value, [node, executor])).toBe(true);
    expect(supportsTestProfile(value, [node, { ...executor, version: '1.0.0' }])).toBe(false);
  });
  it('keeps legacy V1 selections valid without inventing a capability requirement', () => {
    const value = { snapshot: snapshot(false), selection: { kind: 'suite', suiteId: 'worker', files: ['worker/one.test.ts'] } };
    expect(TestExecution.safeParse(value).success).toBe(true);
    expect(supportsTestProfile(EnvironmentSnapshot.parse(value.snapshot), [node])).toBe(true);
    expect(TestExecution.safeParse({ ...batch(), snapshot: snapshot(false) }).success).toBe(false);
  });
  it('rejects unknown execution versions', () => {
    const value = batch(); value.selection.version = 3;
    expect(TestExecution.safeParse(value).success).toBe(false);
  });
  it('retains a receipt for all outcomes rather than only the first suite', () => {
    const value = receipt();
    expect(TestEnvironmentReceipt.safeParse(value).success).toBe(true);
    expect(TestEnvironmentReceipt.parse(value)).toEqual(value);
  });
  it('rejects an incomplete batch receipt', () => {
    const value = receipt(); value.outcomes.pop();
    expect(TestEnvironmentReceipt.safeParse(value).success).toBe(false);
  });
  it('rejects an outcome which calls a nonzero command exit successful', () => {
    const value = receipt(); value.outcomes[0]!.exitCode = 1;
    expect(TestEnvironmentReceipt.safeParse(value).success).toBe(false);
  });
});
