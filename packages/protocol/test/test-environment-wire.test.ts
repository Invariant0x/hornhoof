import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as protocol from '../src/index.js';

const manifestSource = readFileSync(new URL('./fixtures/hornhoof-test-environment-v1.json', import.meta.url), 'utf8');
const description = () => ({
  version: 1,
  repositoryScope: { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: 'a'.repeat(64) },
  commitSha: 'b'.repeat(40), manifestSource,
  manifestHash: createHash('sha256').update(manifestSource).digest('hex'),
  manifest: protocol.parseTestEnvironment(manifestSource),
  inputDigests: [{ path: 'package-lock.json', digest: 'c'.repeat(64) }],
  inventory: [{ suiteId: 'protocol', file: 'packages/protocol/test/index.test.ts', selectionUnit: 'packages/protocol/test/index.test.ts' }],
  runtimeCapabilities: [{ id: 'node', version: '22.23.4', fingerprint: 'd'.repeat(64) }],
});
const snapshot = () => ({ description: description(), profile: 'fast' });

describe('bounded product environment evidence', () => {
  it('validates original manifest bytes and the normalized snapshot without credentials', async () => {
    const value = description();
    expect(await protocol.validateEnvironmentDescription(value)).toEqual(value);
    await expect(protocol.validateEnvironmentDescription({ ...value, manifestHash: 'f'.repeat(64) })).rejects.toThrow(/hash/i);
    await expect(protocol.validateEnvironmentDescription({ ...value, manifest: { ...value.manifest, defaultProfile: 'final' } })).rejects.toThrow();
    await expect(protocol.validateEnvironmentDescription({ ...value, token: 'not-an-evidence-field' })).rejects.toThrow();
    await expect(protocol.validateEnvironmentDescription({ ...value, commitSha: 'b'.repeat(64) })).rejects.toThrow();
  });

  it('rejects duplicate paths, unknown suite IDs and a response over 3MiB', () => {
    const value = description();
    expect(protocol.EnvironmentDescription.safeParse({ ...value, inputDigests: [...value.inputDigests, ...value.inputDigests] }).success).toBe(false);
    expect(protocol.EnvironmentDescription.safeParse({ ...value, inventory: [{ ...value.inventory[0], suiteId: 'unknown' }] }).success).toBe(false);
    const inputDigests = Array.from({ length: 1000 }, (_, index) => ({ path: `${index}/${'x'.repeat(4000)}`, digest: 'c'.repeat(64) }));
    expect(protocol.EnvironmentDescription.safeParse({ ...value, inputDigests }).success).toBe(false);
  });

  it('validates profile eligibility and literal selection against the pinned inventory', () => {
    const value = { snapshot: snapshot(), selection: { kind: 'suite', suiteId: 'protocol', files: ['packages/protocol/test/index.test.ts'] } };
    expect(protocol.TestExecution.safeParse(value).success).toBe(true);
    expect(protocol.TestExecution.safeParse({ ...value, selection: { ...value.selection, files: ['packages/protocol/test/other.test.ts'] } }).success).toBe(false);
    expect(protocol.TestExecution.safeParse({ ...value, selection: { ...value.selection, suiteId: 'server-postgres' } }).success).toBe(false);
    expect(protocol.TestExecution.safeParse({ ...value, snapshot: { ...value.snapshot, profile: 'unknown' } }).success).toBe(false);
    expect(protocol.TestExecution.safeParse({ ...value, selection: { kind: 'final', suiteId: 'protocol', files: [] } }).success).toBe(true);
    expect(protocol.TestExecution.safeParse({ ...value, selection: { kind: 'final', suiteId: 'protocol', files: value.selection.files } }).success).toBe(false);
  });

  it('records cache misses and phase durations without fabricated cache hits or negative times', () => {
    const value = { version: 1, commitSha: 'b'.repeat(40), manifestHash: 'c'.repeat(64), suiteId: 'protocol', kind: 'suite', files: ['packages/protocol/test/index.test.ts'], runtimes: description().runtimeCapabilities, dependencies: { key: null, hit: false }, environments: [], phases: { checkoutMs: 10, dependenciesMs: 20, environmentMs: 0, servicesMs: 0, commandMs: 100, cleanupMs: 5 } };
    expect(protocol.TestEnvironmentReceipt.safeParse(value).success).toBe(true);
    expect(protocol.TestEnvironmentReceipt.safeParse({ ...value, dependencies: { key: null, hit: true } }).success).toBe(false);
    expect(protocol.TestEnvironmentReceipt.safeParse({ ...value, phases: { ...value.phases, commandMs: -1 } }).success).toBe(false);
    expect(protocol.TestEnvironmentReceipt.safeParse({ ...value, servicePassword: 'not-a-receipt-field' }).success).toBe(false);
  });
});


it('returns a validation failure for malformed original JSON instead of throwing from safeParse', () => {
  expect(protocol.EnvironmentDescription.safeParse({ ...description(), manifestSource: '{invalid' }).success).toBe(false);
});

it('rejects a fabricated hit for an uncached environment unit', () => {
  const value = { version: 1, commitSha: 'b'.repeat(40), manifestHash: 'c'.repeat(64), suiteId: 'protocol', kind: 'suite', files: [], runtimes: [], dependencies: { key: null, hit: false }, environments: [{ unitId: 'pglite', key: null, hit: true }], phases: { checkoutMs: 0, dependenciesMs: 0, environmentMs: 0, servicesMs: 0, commandMs: 0, cleanupMs: 0 } };
  expect(protocol.TestEnvironmentReceipt.safeParse(value).success).toBe(false);
});

it('exchanges bounded descriptions and product selections while retaining legacy messages', () => {
  const requestId = '33333333-3333-4333-8333-333333333333', value = description();
  const request = { type: 'tests.describe', requestId, repositoryScope: value.repositoryScope, repo: { url: 'https://example.test/repo.git', token: 'temporary-fixture' }, commitSha: value.commitSha };
  expect(protocol.parseServerMessage(JSON.stringify(request))).toEqual(request);
  expect(protocol.parseServerMessage(JSON.stringify({ type: 'tests.describe.cancel', requestId }))).toEqual({ type: 'tests.describe.cancel', requestId });
  const reply = { type: 'tests.described', requestId, commitSha: value.commitSha, result: { status: 'ready', description: value } };
  expect(protocol.parseNodeMessage(JSON.stringify(reply))).toEqual(reply);
  expect(protocol.parseNodeMessage(JSON.stringify({ ...reply, result: { status: 'error', problem: { code: 'environment_missing', detail: 'No descriptor exists at this SHA.' } } }))?.type).toBe('tests.described');
  const run = { type: 'tests.run', partId: requestId, repo: request.repo, branch: 'main', commitSha: value.commitSha, task: 1, part: 1, parts: 1, timeoutMs: 60_000, repositoryScope: value.repositoryScope, environment: { snapshot: snapshot(), selection: { kind: 'suite', suiteId: 'protocol', files: [value.inventory[0].file] } } };
  expect(protocol.parseServerMessage(JSON.stringify(run))).toMatchObject({ type: 'tests.run', command: '', environment: run.environment });
  expect(protocol.parseServerMessage(JSON.stringify({ ...run, command: 'npm test' }))).toBeNull();
  const manual = { ...run, environment: undefined };
  expect(protocol.parseServerMessage(JSON.stringify({ ...manual, command: 'npm test' }))?.type).toBe('tests.run');
  expect(protocol.parseServerMessage(JSON.stringify(manual))).toBeNull();
});

it('retains additive runtime capability fields in hello and status', () => {
  const runtimes = description().runtimeCapabilities;
  expect(protocol.parseNodeMessage(JSON.stringify({ type: 'hello', version: 'test', loggedIn: true, running: [], testEnvironmentVersion: 1, testRuntimes: runtimes }))).toMatchObject({ testEnvironmentVersion: 1, testRuntimes: runtimes });
  expect(protocol.parseNodeMessage(JSON.stringify({ type: 'status', loggedIn: true, limits: null, testEnvironmentVersion: 1, testRuntimes: runtimes }))).toMatchObject({ testEnvironmentVersion: 1, testRuntimes: runtimes });
});
