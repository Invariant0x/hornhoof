import { createHash } from 'node:crypto';
import { hashTestEnvironment, parseTestEnvironment, TestService } from '../src/index.js';
import { existsSync, readFileSync } from 'node:fs';
import { TestEnvironmentV1 as environment } from '../src/index.js';
import { describe, expect, it } from 'vitest';
import { Command as command, RepositoryScope as scope } from '../src/index.js';

const repoScope = {
  companyId: '10000000-0000-4000-8000-000000000001',
  repositoryOwnerId: '10000000-0000-4000-8000-000000000002',
  repoUrlHash: 'a'.repeat(64),
};

describe('product test environment boundary primitives', () => {
  it('preserves a literal command and its checkout-relative working directory', () => {
    const value = { program: 'python3', args: ['-m', 'pytest', 'tests/a file.py'], cwd: 'services/api' };
    expect(command.safeParse(value)).toMatchObject({ success: true, data: value });
    expect(command.safeParse({ ...value, cwd: '.' }).success).toBe(true);
    expect(command.safeParse({ ...value, shell: true }).success).toBe(false);
  });

  it.each(['../other', '/tmp', 'C:/outside', 'inside/../../outside', 'inside\\outside', 'bad\0path'])('refuses a working directory outside the repository contract: %s', cwd => {
    expect(command.safeParse({ program: 'node', args: [], cwd }).success).toBe(false);
  });

  it('requires server-owned UUID scope and an exact repository URL digest', () => {
    expect(scope.safeParse(repoScope)).toMatchObject({ success: true, data: repoScope });
    expect(scope.safeParse({ ...repoScope, repoUrlHash: 'a' }).success).toBe(false);
    expect(scope.safeParse({ ...repoScope, companyId: 'somebody' }).success).toBe(false);
    expect(scope.safeParse({ ...repoScope, token: 'not-a-scope-field' }).success).toBe(false);
  });
});

const python = () => ({
  version: 1,
  defaultProfile: 'all',
  runtimes: [{ id: 'python', version: '>=3.11' }, { id: 'postgres', version: '17' }],
  profiles: [{ id: 'all', requiredSuiteIds: ['baskets'] }],
  dependencies: { adapter: 'python-target-v1', inputs: ['pyproject.toml'], install: [], paths: [], cache: 'none' },
  services: [{ id: 'pg', driver: 'postgres', runtime: 'postgres', profiles: ['all'], options: { database: 'baskets_test', locale: 'C.UTF-8', extensions: [] } }],
  prepare: [{ id: 'database', profiles: ['all'], serviceIds: ['pg'], inputs: ['migrations/*.sql', 'scripts/migrate.py'], commands: [{ program: 'python3', args: ['scripts/migrate.py'], cwd: '.' }], artifacts: [{ service: 'pg', path: '.' }] }],
  reset: [{ suiteIds: ['baskets'], scope: 'test', command: null, inputs: ['tests/db/conftest.py'] }],
  suites: [{ id: 'baskets', root: '.', files: ['tests/**/test_*.py'], run: { program: 'python3', args: ['-m', 'pytest'], cwd: '.' }, split: { kind: 'argv-files' }, profiles: ['all'] }],
  impact: { adapter: 'whole-package', fullPackageGlobs: [{ globs: ['migrations/**', 'pytest.ini'], suiteIds: ['baskets'] }], migrationCheck: { status: 'unsupported', reason: 'No rollback command is defined.' } },
  mutation: { status: 'unsupported', language: 'python', reason: 'This fixture describes parsing; no mutation plan has been configured.' },
});

describe('canonical TestEnvironmentV1', () => {
  it('accepts the frozen Hornhoof manifest, including service-root artifacts and file reset', () => {
    const manifest: unknown = JSON.parse(readFileSync(new URL('./fixtures/hornhoof-test-environment-v1.json', import.meta.url), 'utf8'));
    expect(environment.safeParse(manifest)).toMatchObject({ success: true, data: manifest });
  });

  it('accepts the Python fixture reset implemented by conftest without a standalone reset command', () => {
    const root = new URL('../../../apps/server/test/fixtures/test-environment-python/', import.meta.url);
    expect(existsSync(new URL('tests/db/conftest.py', root))).toBe(true);
    expect(existsSync(new URL('scripts/migrate.py', root))).toBe(true);
    const manifest = python();
    expect(environment.safeParse(manifest)).toMatchObject({ success: true, data: manifest });
  });

  it('accepts an impact rule that names the tests reading its files, and refuses an empty list of them', () => {
    const base = python(), rule = { globs: ['data/**'], suiteIds: ['baskets'], tests: ['tests/test_data.py'] };
    const manifest = { ...base, impact: { ...base.impact, fullPackageGlobs: [rule] } };
    expect(environment.safeParse(manifest)).toMatchObject({ success: true, data: manifest });
    expect(environment.safeParse({ ...base, impact: { ...base.impact, fullPackageGlobs: [{ ...rule, tests: [] }] } }).success).toBe(false);
  });

  it('accepts the same product without services or reset and asks for no database runtime', () => {
    expect(existsSync(new URL('../../../apps/server/test/fixtures/test-environment-python/no-services/tests/test_labels.py', import.meta.url))).toBe(true);
    const base = python();
    const manifest = { ...base, runtimes: [{ id: 'python', version: '>=3.11' }], services: [], prepare: [], reset: null, suites: [{ ...base.suites[0], files: ['tests/test_labels.py'] }] };
    expect(environment.safeParse(manifest)).toMatchObject({ success: true, data: manifest });
  });

  it.each([
    { reset: [] },
    { reset: [{ suiteIds: ['baskets'], scope: 'session', command: null, inputs: ['tests/db/conftest.py'] }] },
    { reset: [{ suiteIds: ['missing'], scope: 'file', command: null, inputs: ['tests/db/conftest.py'] }] },
    { reset: [{ suiteIds: ['baskets'], scope: 'file', command: null, inputs: [] }] },
    { version: 2 },
    { version: undefined, schemaVersion: 1 },
    { defaultProfile: 'missing' },
    { profiles: [{ id: 'all', requiredSuiteIds: ['missing'] }] },
    { profiles: [{ id: 'other', requiredSuiteIds: ['baskets'] }], defaultProfile: 'other' },
    { services: undefined },
    { dependencies: [] },
    { mutation: null },
    { mutation: { status: 'unsupported', language: 'python', reason: '', command: { program: 'true', args: [], cwd: '.' } } },
  ])('rejects an incomplete or incompatible description: %j', change => {
    expect(environment.safeParse({ ...python(), ...change }).success).toBe(false);
  });

  it('rejects duplicate identifiers and references to services outside the unit', () => {
    const manifest = python();
    expect(environment.safeParse({ ...manifest, suites: [manifest.suites[0], manifest.suites[0]] }).success).toBe(false);
    expect(environment.safeParse({ ...manifest, prepare: [{ ...manifest.prepare[0], serviceIds: ['missing'] }] }).success).toBe(false);
    expect(environment.safeParse({ ...manifest, prepare: [{ ...manifest.prepare[0], artifacts: [{ service: 'other', path: '.' }] }] }).success).toBe(false);
    expect(environment.safeParse({ ...manifest, suites: [{ ...manifest.suites[0], split: { kind: 'argv-files', shell: true } }] }).success).toBe(false);
  });
});


describe('bounded source bytes and their snapshot identity', () => {
  it('refuses a normalized manifest exceeding64KiB', () => {
    expect(environment.safeParse({ ...python(), mutation: { status: 'unsupported', language: 'python', reason: 'x'.repeat(65_536) } }).success).toBe(false);
  });

  it('parses original JSON bytes while enforcing the limit before normalization', () => {
    expect(parseTestEnvironment(JSON.stringify(python()))).toEqual(python());
    expect(() => parseTestEnvironment(' '.repeat(65_536) + JSON.stringify(python()))).toThrow();
  });

  it('hashes the original UTF8 bytes including whitespace rather than the parsed object', async () => {
    const source = JSON.stringify(python());
    expect(await hashTestEnvironment(source)).toBe(createHash('sha256').update(source).digest('hex'));
    expect(await hashTestEnvironment(source + '\n')).not.toBe(await hashTestEnvironment(source));
  });
});
it('matches numeric runtime prefixes and excludes services outside the selected profile', async () => {
  const module = await import('../src/test-environment.js');
  expect(module.runtimeVersionMatches('22', '22.15.0')).toBe(true);
  expect(module.runtimeVersionMatches('22.1', '22.10.0')).toBe(false);
  expect(module.runtimeVersionMatches('>=22', '22.15.0')).toBe(false);
  const manifest = parseTestEnvironment(JSON.parse(readFileSync(new URL('../../../.hornhoof/test-environment.json', import.meta.url), 'utf8')));
  expect(module.requiredTestRuntimes(manifest, 'fast')).toEqual([{ id: 'node', version: '22' }, { id: 'hornhoof-test-execution', version: '2.0.0' }]);
  expect(module.requiredTestRuntimes(manifest, 'final')).toContainEqual({ id: 'postgres', version: '17' });
});

it('rejects service identifiers the integrated provider cannot prepare', () => {
  expect(TestService.safeParse({ id: 'db.primary', driver: 'postgres', runtime: 'pg', profiles: ['all'], options: { database: 'test' } }).success).toBe(false);
});
