import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EnvironmentSnapshot, RuntimeCapability, runsInClass, runtimeClass, type RuntimeCapability as Runtime } from '../src/test-environment.js';

const commit = 'a'.repeat(40);
const x64 = { os: 'linux', arch: 'x64', libc: 'glibc' };
/* The runtimes a Linux x64 node names, and another build of them, as on an arm64 machine. */
const described: Runtime[] = [
  { id: 'node', version: '22.23.4', fingerprint: '1'.repeat(64), platform: x64 },
  { id: 'postgres', version: '17.11', fingerprint: '2'.repeat(64), platform: x64 },
  { id: 'hornhoof-test-execution', version: '2.0.0', fingerprint: '3'.repeat(64), platform: x64 },
];
const rebuilt = (change: (runtime: Runtime) => Partial<Runtime>): Runtime[] => described.map(runtime => ({ ...runtime, ...change(runtime) }));
const arm64 = rebuilt(runtime => ({ fingerprint: runtime.fingerprint.replace(/./g, 'a'), platform: { ...x64, arch: 'arm64' } }));

function snapshot(profile = 'final'): EnvironmentSnapshot {
  const manifest = {
    version: 1, defaultProfile: 'fast', runtimes: [{ id: 'node', version: '22' }, { id: 'postgres', version: '17' }],
    profiles: [{ id: 'fast', requiredSuiteIds: ['api'] }, { id: 'final', requiredSuiteIds: ['api'] }],
    dependencies: { adapter: 'none', inputs: [], install: [], paths: [], cache: 'none' },
    services: [{ id: 'pg', driver: 'postgres', runtime: 'postgres', profiles: ['final'], options: { database: 'test' } }], prepare: [], reset: null,
    suites: [{ id: 'api', root: 'api', files: ['api/*.test.ts'], run: { program: 'node', args: ['tests.js'], cwd: 'api' }, split: { kind: 'argv-files' }, profiles: ['fast', 'final'] }],
    impact: { adapter: 'whole-package', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'No migrations.' } },
    mutation: { status: 'unsupported', language: 'typescript', reason: 'Not part of this fixture.' },
    execution: { version: 2, oncePreparation: { profiles: ['final'], suiteIds: [], commands: [{ program: 'node', args: ['types.js'], cwd: '.' }] } },
  };
  const manifestSource = JSON.stringify(manifest);
  return EnvironmentSnapshot.parse({ profile, description: { version: 1, commitSha: commit,
    repositoryScope: { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: 'd'.repeat(64) },
    manifest, manifestSource, manifestHash: createHash('sha256').update(manifestSource).digest('hex'), inputDigests: [],
    inventory: [{ suiteId: 'api', file: 'api/a.test.ts', selectionUnit: 'api/a.test.ts' }], runtimeCapabilities: described } });
}

describe('the class of runtimes a test part runs on', () => {
  it('takes the runtimes of another build and another processor of the same system and major versions', () => {
    expect(runsInClass(snapshot(), described)).toBe(true);
    expect(runsInClass(snapshot(), arm64)).toBe(true);
    expect(runsInClass(snapshot(), rebuilt(runtime => (runtime.id === 'node' ? { version: '22.24.1' } : {})))).toBe(true);
    expect(arm64.map(runtimeClass)).toEqual(described.map(runtimeClass));
  });

  it('refuses another system, another libc and another major version of a runtime the profile needs', () => {
    expect(runsInClass(snapshot(), rebuilt(runtime => ({ platform: { ...runtime.platform!, os: 'darwin' } })))).toBe(false);
    expect(runsInClass(snapshot(), rebuilt(runtime => ({ platform: { ...runtime.platform!, libc: 'musl' } })))).toBe(false);
    expect(runsInClass(snapshot(), rebuilt(runtime => (runtime.id === 'node' ? { version: '24.1.0' } : {})))).toBe(false);
    expect(runsInClass(snapshot(), rebuilt(runtime => (runtime.id === 'postgres' ? { version: '18.0' } : {})))).toBe(false);
    expect(runsInClass(snapshot(), described.filter(runtime => runtime.id !== 'postgres'))).toBe(false);
  });

  it('looks only at the runtimes the profile needs', () => {
    const withoutPostgres = described.filter(runtime => runtime.id !== 'postgres');
    expect(runsInClass(snapshot('fast'), withoutPostgres)).toBe(true);
    expect(runsInClass(snapshot('fast'), [...withoutPostgres, { id: 'python', version: '3.11.2', fingerprint: '4'.repeat(64), platform: { ...x64, os: 'darwin' } }])).toBe(true);
  });

  it('counts a runtime that does not name its system as only itself', () => {
    const unnamed = described.map(runtime => ({ id: runtime.id, version: runtime.version, fingerprint: runtime.fingerprint }));
    expect(runtimeClass(unnamed[0]!)).toBeNull();
    expect(runsInClass(snapshot(), unnamed)).toBe(false);
    const own = EnvironmentSnapshot.parse({ ...snapshot(), description: { ...snapshot().description, runtimeCapabilities: unnamed } });
    expect(runsInClass(own, unnamed)).toBe(true);
    expect(runsInClass(own, unnamed.map(runtime => ({ ...runtime, fingerprint: 'e'.repeat(64) })))).toBe(false);
    expect(runsInClass(own, described)).toBe(false);
  });

  it('names a system, processor and libc in plain words only', () => {
    expect(RuntimeCapability.safeParse(described[0]).success).toBe(true);
    expect(RuntimeCapability.safeParse({ ...described[0], platform: { ...x64, os: 'Linux x64; rm' } }).success).toBe(false);
    expect(RuntimeCapability.safeParse({ ...described[0], platform: { os: 'linux', arch: 'x64' } }).success).toBe(false);
  });
});
