import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { parseTestEnvironment } from '@hornhoof/protocol';
import * as environment from '../src/test-environment.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' }).trim();
const command = { program: 'node', args: ['-e', "require('node:fs').writeFileSync('executed','bad')"], cwd: '.' };
const manifest = () => ({
  version: 1, defaultProfile: 'fast', runtimes: [{ id: 'node', version: '22' }], profiles: [{ id: 'fast', requiredSuiteIds: ['api'] }],
  dependencies: { adapter: 'npm', inputs: ['package-lock.json', 'optional.json'], install: [command], paths: ['node_modules'], cache: 'copy' },
  services: [], prepare: [{ id: 'schema', profiles: ['fast'], serviceIds: [], inputs: ['migrations/*.sql'], commands: [command], artifacts: [{ path: 'template', format: 'directory' }] }],
  reset: [{ suiteIds: ['api'], scope: 'file', command: null, inputs: ['tests/fixture.ts'] }],
  suites: [{ id: 'api', root: 'app', files: ['app/test/**/*.test.ts'], run: { program: 'node', args: ['runner.js'], cwd: 'app' }, split: { kind: 'argv-files' }, profiles: ['fast'] }],
  impact: { adapter: 'whole-package', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'No rollback defined.' } },
  mutation: { status: 'unsupported', language: 'typescript', reason: 'No plan configured.' },
});
async function fixture(value: unknown = manifest()) {
  const root = await mkdtemp(join(tmpdir(), 'hh-description-')); folders.push(root);
  for (const dir of ['.hornhoof', 'migrations', 'tests', 'app/test']) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, '.hornhoof/test-environment.json'), JSON.stringify(value));
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  await writeFile(join(root, 'migrations/001.sql'), 'create table one(id int);');
  await writeFile(join(root, 'tests/fixture.ts'), '// reset fixture');
  await writeFile(join(root, 'app/test/a.test.ts'), '// test');
  await writeFile(join(root, 'app/test/-option.test.ts'), '// literal option-like file');
  git(root, 'init', '--quiet'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.test');
  git(root, 'add', '.'); git(root, 'commit', '--quiet', '-m', 'Descriptor'); const sha = git(root, 'rev-parse', 'HEAD');
  const cacheRoot = await mkdtemp(join(tmpdir(), 'hh-description-cache-')); folders.push(cacheRoot);
  const source = { url: pathToFileURL(root).href, token: '' };
  const scope = { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: createHash('sha256').update(source.url).digest('hex') };
  return { root, sha, source, scope, context: { cacheRoot, signal: new AbortController().signal, deadline: Date.now() + 10_000, log: () => {} } };
}

describe('test environment discovery from pinned Git blobs', () => {
  it('describes pinned bytes, tracked inventory and missing inputs without executing repository commands', async () => {
    const f = await fixture(), original = JSON.stringify(manifest());
    await writeFile(join(f.root, '.hornhoof/test-environment.json'), '{}'); git(f.root, 'commit', '--quiet', '-am', 'Move branch');
    const result = await environment.readTestEnvironment(f.source, f.scope, f.sha, f.context);
    expect(result.commitSha).toBe(f.sha); expect(result.manifestSource).toBe(original);
    expect(result.manifestHash).toBe(createHash('sha256').update(original).digest('hex'));
    expect(result.inputDigests).toEqual([
      { path: 'migrations/001.sql', digest: createHash('sha256').update('100644\0create table one(id int);').digest('hex') },
      { path: 'optional.json', digest: null },
      { path: 'package-lock.json', digest: createHash('sha256').update('100644\0{"lockfileVersion":3}').digest('hex') },
      { path: 'tests/fixture.ts', digest: createHash('sha256').update('100644\0// reset fixture').digest('hex') },
    ]);
    expect(result.inventory.map(unit => unit.file)).toEqual(['app/test/-option.test.ts', 'app/test/a.test.ts']);
    expect(result.runtimeCapabilities).toContainEqual(expect.objectContaining({ id: 'node', version: process.versions.node }));
    await expect(access(join(f.root, 'executed'))).rejects.toThrow();
  });

  it('distinguishes an absent descriptor from invalid JSON', async () => {
    const f = await fixture(); await rm(join(f.root, '.hornhoof/test-environment.json')); git(f.root, 'commit', '--quiet', '-am', 'Remove');
    await expect(environment.readTestEnvironment(f.source, f.scope, git(f.root, 'rev-parse', 'HEAD'), f.context)).rejects.toMatchObject({ problem: { code: 'environment_missing' } });
    await writeFile(join(f.root, '.hornhoof/test-environment.json'), '{invalid'); git(f.root, 'add', '.'); git(f.root, 'commit', '--quiet', '-m', 'Invalid');
    await expect(environment.readTestEnvironment(f.source, f.scope, git(f.root, 'rev-parse', 'HEAD'), f.context)).rejects.toMatchObject({ problem: { code: 'environment_invalid' } });
  });

  it('refuses a symlink descriptor and an LFS input pointer', async () => {
    const f = await fixture(); await rm(join(f.root, '.hornhoof/test-environment.json'));
    await symlink('../package-lock.json', join(f.root, '.hornhoof/test-environment.json')); git(f.root, 'add', '.'); git(f.root, 'commit', '--quiet', '-m', 'Link');
    await expect(environment.readTestEnvironment(f.source, f.scope, git(f.root, 'rev-parse', 'HEAD'), f.context)).rejects.toMatchObject({ problem: { code: 'environment_unsupported' } });
    await rm(join(f.root, '.hornhoof/test-environment.json')); await writeFile(join(f.root, '.hornhoof/test-environment.json'), JSON.stringify(manifest()));
    await writeFile(join(f.root, 'package-lock.json'), 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n'); git(f.root, 'add', '.'); git(f.root, 'commit', '--quiet', '-m', 'LFS');
    await expect(environment.readTestEnvironment(f.source, f.scope, git(f.root, 'rev-parse', 'HEAD'), f.context)).rejects.toMatchObject({ problem: { code: 'environment_unsupported' } });
  });

  it('does not claim fixture reset readiness when every declared fixture input is absent', async () => {
    const value = manifest(); value.reset[0].inputs = ['tests/missing-fixture.ts']; const f = await fixture(value);
    await expect(environment.readTestEnvironment(f.source, f.scope, f.sha, f.context)).rejects.toMatchObject({ problem: { code: 'environment_invalid' } });
  });
});


describe('literal test invocations', () => {
  it('versioned node execution advertises its actual executor capability', async () => {
    const f = await fixture();
    const capabilities = await environment.trustedTestRuntimes(f.context);
    expect(capabilities).toContainEqual({ id: 'hornhoof-test-execution', version: '2.0.0', fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it('native Vitest shard adapter passes its local coordinates and bounded JSON selection', async () => {
    const f = await fixture(), value = manifest();
    const parsed = parseTestEnvironment({ ...value, execution: { version: 2 }, suites: [{ ...value.suites[0], split: { kind: 'vitest-shard' } }] });
    const filesPath = join(f.root, 'shard.json'), context = { checkout: f.root, filesPath, shard: { index: 2, count: 3 } };
    const invocation = await environment.buildTestInvocation(parsed.suites[0]!, ['app/test/a.test.ts'], context);
    expect(invocation).toEqual({ command: { ...parsed.suites[0]!.run, args: ['runner.js', '--shard=2/3'] }, env: { HH_TEST_FILES: filesPath } });
    expect(JSON.parse(await readFile(filesPath, 'utf8'))).toEqual(['./test/a.test.ts']);
    await expect(environment.buildTestInvocation(parsed.suites[0]!, ['app/test/a.test.ts'], { checkout: f.root, filesPath: join(f.root, 'missing-shard.json') })).rejects.toThrow(/shard/i);
  });

  it('converts inventory paths to the working directory and protects option-like filenames', async () => {
    const f = await fixture(), suite = parseTestEnvironment(manifest()).suites[0];
    const invocation = await environment.buildTestInvocation(suite, ['app/test/-option.test.ts', 'app/test/a.test.ts'], { checkout: f.root, filesPath: join(f.root, 'files.json') });
    expect(invocation.command).toEqual({ program: 'node', args: ['runner.js', './test/-option.test.ts', './test/a.test.ts'], cwd: 'app' });
    expect(invocation.env).toEqual({});
    await expect(environment.buildTestInvocation(suite, ['app/test/unknown.test.ts', '../outside'], { checkout: f.root, filesPath: join(f.root, 'files.json') })).rejects.toThrow();
  });

  it('writes a literal JSON selection and leaves a whole-package command unsplit', async () => {
    const f = await fixture(), suite = parseTestEnvironment(manifest()).suites[0], filesPath = join(f.root, 'files.json');
    const json = await environment.buildTestInvocation({ ...suite, split: { kind: 'json-file' } }, ['app/test/a.test.ts'], { checkout: f.root, filesPath });
    expect(json.command).toEqual(suite.run); expect(json.env).toEqual({ HH_TEST_FILES: filesPath });
    expect(JSON.parse(await readFile(filesPath, 'utf8'))).toEqual(['./test/a.test.ts']);
    const whole = await environment.buildTestInvocation({ ...suite, split: { kind: 'whole-package' } }, ['app/test/a.test.ts'], { checkout: f.root, filesPath });
    expect(whole).toEqual({ command: suite.run, env: {} });
  });
});

it('invalidates only dependency or preparation keys whose declared inputs changed', async () => {
  const f = await fixture(), first = await environment.readTestEnvironment(f.source, f.scope, f.sha, f.context);
  const initialDependencies = environment.dependencyCacheKey(first), initialEnvironment = environment.environmentCacheKey(first, 'schema', initialDependencies);
  const readNext = async () => environment.readTestEnvironment(f.source, f.scope, git(f.root, 'rev-parse', 'HEAD'), { ...f.context, runtimes: first.runtimeCapabilities });
  await writeFile(join(f.root, 'app/test/a.test.ts'), '// ordinary source changed'); git(f.root, 'commit', '--quiet', '-am', 'Source only');
  const sourceOnly = await readNext();
  expect(environment.dependencyCacheKey(sourceOnly)).toBe(initialDependencies);
  expect(environment.environmentCacheKey(sourceOnly, 'schema', initialDependencies)).toBe(initialEnvironment);
  await writeFile(join(f.root, 'migrations/001.sql'), 'create table two(id int);'); git(f.root, 'commit', '--quiet', '-am', 'Migration');
  const migration = await readNext();
  expect(environment.dependencyCacheKey(migration)).toBe(initialDependencies);
  expect(environment.environmentCacheKey(migration, 'schema', initialDependencies)).not.toBe(initialEnvironment);
  await writeFile(join(f.root, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}'); git(f.root, 'commit', '--quiet', '-am', 'Dependencies');
  const dependencies = await readNext(), newKey = environment.dependencyCacheKey(dependencies);
  expect(newKey).not.toBe(initialDependencies);
  expect(environment.environmentCacheKey(dependencies, 'schema', newKey)).not.toBe(environment.environmentCacheKey(migration, 'schema', initialDependencies));
  expect(environment.dependencyCacheKey({ ...first, runtimeCapabilities: first.runtimeCapabilities.map(runtime => ({ ...runtime, fingerprint: 'f'.repeat(64) })) })).not.toBe(initialDependencies);
});

it('settles refused description requests before forgetting their active entry', async () => {
  const emitted: unknown[] = [];
  const control = new environment.NodeTestMessages({ dir: '/unused', capabilities: {}, stopped: () => false, testing: new Map(), unconfirmed: new Map(), run: async () => {}, emit: message => { emitted.push(message); } });
  await control.handle({ type: 'tests.describe', requestId: '55555555-5555-4555-8555-555555555555', commitSha: 'a'.repeat(40), repositoryScope: { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: 'b'.repeat(64) }, repo: { url: 'https://example.test/repo.git', token: '' } });
  expect(emitted).toMatchObject([{ result: { status: 'error', problem: { code: 'isolation_missing' } } }]);
  expect(control.activeDescriptions()).toEqual([]);
});

it('keys a later preparation from actual completed artifact bytes and rejects missing results', async () => {
  const value = manifest();
  value.prepare.unshift({ id: 'compile', profiles: ['fast'], serviceIds: [], inputs: ['app/test/*.ts'], commands: [], artifacts: [{ path: 'build/protocol', format: 'directory' }] });
  value.prepare[1].inputs.push('build/protocol/**');
  const f = await fixture(value), description = await environment.readTestEnvironment(f.source, f.scope, f.sha, f.context);
  const context = { ...f.context, checkout: f.root, profile: 'fast', completed: ['compile'] };
  await mkdir(join(f.root, 'build/protocol'), { recursive: true }); await writeFile(join(f.root, 'build/protocol/index.js'), 'export const value=1;');
  const inputs = await environment.readPreparationInputs(description, 'schema', context), dependencies = environment.dependencyCacheKey(description);
  const first = environment.environmentCacheKey(description, 'schema', dependencies, inputs);
  await writeFile(join(f.root, 'app/test/a.test.ts'), '// compiler input changed'); git(f.root, 'add', 'app/test/a.test.ts'); git(f.root, 'commit', '--quiet', '-m', 'Rebuild');
  const rebuilt = await environment.readTestEnvironment(f.source, f.scope, git(f.root, 'rev-parse', 'HEAD'), { ...f.context, runtimes: description.runtimeCapabilities });
  await rm(join(f.root, 'build'), { recursive: true }); await mkdir(join(f.root, 'build/protocol'), { recursive: true }); await writeFile(join(f.root, 'build/protocol/index.js'), 'export const value=1;');
  expect(environment.environmentCacheKey(rebuilt, 'schema', dependencies, await environment.readPreparationInputs(rebuilt, 'schema', context))).toBe(first);
  await writeFile(join(f.root, 'build/protocol/index.js'), 'export const value=2;');
  expect(environment.environmentCacheKey(rebuilt, 'schema', dependencies, await environment.readPreparationInputs(rebuilt, 'schema', context))).not.toBe(first);
  await rm(join(f.root, 'build'), { recursive: true });
  await expect(environment.readPreparationInputs(rebuilt, 'schema', context)).rejects.toMatchObject({ problem: { code: 'environment_invalid' } });
});

it('refuses self references, forward references and cycles in preparation inputs', async () => {
  const value = manifest(); value.prepare[0].inputs = ['template/**'];
  const f = await fixture(value), description = await environment.readTestEnvironment(f.source, f.scope, f.sha, f.context);
  const context = { ...f.context, checkout: f.root, profile: 'fast', completed: [] };
  await expect(environment.readPreparationInputs(description, 'schema', context)).rejects.toMatchObject({ problem: { code: 'environment_invalid' } });
  const forward = structuredClone(description); forward.manifest.prepare[0].inputs = ['future/**'];
  forward.manifest.prepare.push({ ...forward.manifest.prepare[0], id: 'later', inputs: ['template/**'], artifacts: [{ path: 'future', format: 'directory' }] });
  await expect(environment.readPreparationInputs(forward, 'schema', context)).rejects.toMatchObject({ problem: { code: 'environment_invalid' } });
});

it('cancels a granted part waiting for its disposable user without starting it or blocking the next part', async () => {
  const user = new environment.TestPartUser(), abort = new AbortController(), positions: number[] = [];
  let release!: () => void, started = false;
  const first = user.run(undefined, () => new Promise<void>(done => { release = done; }), () => {});
  await Promise.resolve(); onTestFinished(() => release());
  const second = user.run(abort.signal, async () => { started = true; }, position => { positions.push(position); });
  let cancelled = false; void second.catch(() => { cancelled = true; });
  const reason = new Error('The granted lease ended'); abort.abort(reason);
  await new Promise(resolve => setImmediate(resolve)); expect(cancelled).toBe(true);
  const rejected = expect(second).rejects.toBe(reason); release(); await first; await rejected;
  expect(started).toBe(false); expect(positions).toEqual([1]);
  await expect(user.run(undefined, async () => 'next', () => {})).resolves.toBe('next');
});

/* Candidate metadata must compare both pinned trees even when the repository has no periodic full-run policy. */
describe('the final candidate influencing fingerprints', () => {
  const describeCandidate = (f: Awaited<ReturnType<typeof fixture>>, head: string, prints?: Parameters<typeof environment.describeTestEnvironment>[4], base = f.sha): Promise<unknown> =>
    environment.describeTestEnvironment(f.source, f.scope, head, f.context, prints, base);

  const changed = async () => {
    const value = manifest(); value.impact.adapter = 'vitest-related';
    const f = await fixture(value);
    await writeFile(join(f.root, 'app/test/a.test.ts'), 'export const changed = true;');
    git(f.root, 'commit', '--quiet', '-am', 'Change one test');
    return { ...f, head: git(f.root, 'rev-parse', 'HEAD') };
  };

  it('returns distinct base and final fingerprints from pinned blobs without executing repository commands', async () => {
    const f = await changed();
    const result = await describeCandidate(f, f.head) as {
      description: { commitSha: string }; fingerprints: { file: string; fingerprint: string }[];
      baseFingerprints: { commitSha: string; fingerprints: { file: string; fingerprint: string }[] };
    };
    expect(result).toMatchObject({ description: { commitSha: f.head }, baseFingerprints: { commitSha: f.sha } });
    const base = new Map(result.baseFingerprints.fingerprints.map(print => [print.file, print.fingerprint]));
    const head = new Map(result.fingerprints.map(print => [print.file, print.fingerprint]));
    expect(head.get('app/test/a.test.ts')).not.toBe(base.get('app/test/a.test.ts'));
    expect(head.get('app/test/-option.test.ts')).toBe(base.get('app/test/-option.test.ts'));
    await expect(access(join(f.root, 'executed'))).rejects.toThrow();
  });

  it('does not turn an unreadable candidate base into a whole-profile test claim', async () => {
    const f = await changed();
    await expect(describeCandidate(f, f.head, undefined, 'f'.repeat(40))).rejects.toThrow();
  });

  it.each(['base', 'head'] as const)('does not silently omit unavailable %s fingerprints for a candidate', async side => {
    const f = await changed();
    const fingerprints: NonNullable<Parameters<typeof environment.describeTestEnvironment>[4]> = async (_source, _scope, description) => {
      if (description.commitSha === (side === 'base' ? f.sha : f.head)) throw new Error(`${side} fingerprints unavailable`);
      return [];
    };
    await expect(describeCandidate(f, f.head, fingerprints)).rejects.toThrow(`${side} fingerprints unavailable`);
  });
});

it('does not replay a cached description for the same head at another candidate base', async () => {
  const emitted: unknown[] = [];
  const control = new environment.NodeTestMessages({ dir: '/unused', capabilities: {}, stopped: () => false, testing: new Map(), unconfirmed: new Map(), run: async () => {}, emit: message => { emitted.push(message); } });
  const request = { type: 'tests.describe' as const, requestId: '55555555-5555-4555-8555-555555555555', commitSha: 'b'.repeat(40), baseCommit: 'a'.repeat(40), repositoryScope: { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: 'b'.repeat(64) }, repo: { url: 'https://example.test/repo.git', token: '' } };
  await control.handle(request);
  await control.handle({ ...request, baseCommit: 'c'.repeat(40) });
  expect(emitted.at(-1)).toMatchObject({ result: { status: 'error', problem: { code: 'description_mismatch' } } });
});

async function mutationCandidate(hasFastJudge = true) {
  const value = manifest();
  const sourcePaths = ['app/logic.ts', 'app/process.ts'];
  const f = await fixture({ ...value,
    profiles: [{ id: 'fast', requiredSuiteIds: ['api', 'mutation'] }],
    suites: [...value.suites, { id: 'mutation', root: '.', files: sourcePaths, run: { program: 'node', args: ['mutate.mjs'], cwd: '.' }, split: { kind: 'json-file' }, profiles: ['fast'] }],
    mutation: { status: 'supported', language: 'typescript', tool: 'mutator', command: { program: 'node', args: ['mutate.mjs'], cwd: '.' }, sourcePaths,
      fastTestPaths: ['app/test/a.test.ts'], coverageCommands: [value.suites[0].run], coverageFiles: ['coverage.json'] },
  });
  await writeFile(join(f.root, 'app/logic.ts'), 'export function total(n: number) { return n + 1; }\nexport function untouched(n: number) { return n * 2; }\n');
  await writeFile(join(f.root, 'app/process.ts'), 'export function start() { return process.cwd(); }\n');
  await writeFile(join(f.root, 'app/test/a.test.ts'), hasFastJudge ? "import { expect, it } from 'vitest';\nimport { total } from '../logic.js';\nit('total', () => { expect(total(1)).toBe(3); });\n" : '// No fast test reaches total.');
  git(f.root, 'add', '.'); git(f.root, 'commit', '--quiet', '-m', 'Candidate base');
  const base = git(f.root, 'rev-parse', 'HEAD');
  await writeFile(join(f.root, 'app/logic.ts'), 'export function total(n: number) { return n + 2; }\nexport function untouched(n: number) { return n * 2; }\n');
  await writeFile(join(f.root, 'app/process.ts'), 'export function start() { return process.env.NODE_ENV; }\n');
  git(f.root, 'commit', '--quiet', '-am', 'Candidate head');
  return { ...f, base, head: git(f.root, 'rev-parse', 'HEAD') };
}

it('describes the pinned candidate delta and only its changed pure functions with safe fast judges', async () => {
  const f = await mutationCandidate();
  const result = await environment.describeTestEnvironment(f.source, f.scope, f.head, f.context, undefined, f.base);
  expect(result).toMatchObject({ mutation: {
    delta: { baseCommit: f.base, commit: f.head, changes: expect.arrayContaining([{ path: 'app/logic.ts', ranges: [[1, 1]] }]) },
    selection: { status: 'ready', baseCommit: f.base, commit: f.head,
      selected: [{ file: 'app/logic.ts', name: 'total', lines: [1], tests: ['app/test/a.test.ts'] }],
      excluded: [expect.objectContaining({ file: 'app/process.ts', reason: 'purity_unproven' })],
    },
  } });
  await expect(access(join(f.root, 'executed'))).rejects.toThrow();
});

it('keeps missing fast mutation judges blocked instead of treating the file fingerprint as mutation evidence', async () => {
  const f = await mutationCandidate(false);
  const result = await environment.describeTestEnvironment(f.source, f.scope, f.head, f.context, undefined, f.base);
  expect(result).toMatchObject({ mutation: { selection: { status: 'blocked', selected: [], problems: [{ file: 'app/logic.ts', code: 'no_safe_fast_tests' }] } } });
});

it('passes the exact candidate pair and a bound delta file to the declared narrow mutation command', async () => {
  const f = await mutationCandidate();
  const result = await environment.describeTestEnvironment(f.source, f.scope, f.head, f.context, undefined, f.base);
  Reflect.set(result.description.manifest.mutation, 'candidateRun', {
    program: 'node', args: ['mutate.mjs', '--base', '{baseCommit}', '--head', '{commit}', '--plan-file', '{planFile}'], cwd: '.',
  });
  const snapshot = { description: result.description, profile: 'fast', candidate: { baseCommit: f.base, fingerprints: result.fingerprints!, baseFingerprints: result.baseFingerprints!.fingerprints, mutation: result.mutation! } };
  const suite = result.description.manifest.suites.find(suite => suite.id === 'mutation')!;
  const filesPath = join(f.root, 'selected.json');
  const invocation = await environment.buildTestInvocation(suite, ['app/logic.ts'], Object.assign({ checkout: f.root, filesPath }, { snapshot }));
  const planFile = `${filesPath}.mutation-plan.json`;
  expect(invocation.command).toEqual({ program: 'node', args: ['mutate.mjs', '--base', f.base, '--head', f.head, '--plan-file', planFile], cwd: '.' });
  expect(JSON.parse(await readFile(planFile, 'utf8'))).toMatchObject({ sha: f.head, base: f.base, hunks: { 'app/logic.ts': [[1, 1]] } });
  expect(JSON.parse(await readFile(filesPath, 'utf8'))).toEqual(['./app/logic.ts']);
});

it('refuses a broad mutation command when the candidate has no declared narrow invocation', async () => {
  const f = await mutationCandidate();
  const result = await environment.describeTestEnvironment(f.source, f.scope, f.head, f.context, undefined, f.base);
  const snapshot = { description: result.description, profile: 'fast', candidate: { baseCommit: f.base, fingerprints: result.fingerprints!, baseFingerprints: result.baseFingerprints!.fingerprints, mutation: result.mutation! } };
  const suite = result.description.manifest.suites.find(suite => suite.id === 'mutation')!;
  await expect(environment.buildTestInvocation(suite, ['app/logic.ts'], Object.assign({ checkout: f.root, filesPath: join(f.root, 'selected.json') }, { snapshot }))).rejects.toThrow(/mutation/i);
});

it('keeps different pure function selections out of the same final-file mutation cache key', async () => {
  const f = await mutationCandidate();
  await writeFile(join(f.root, 'app/logic.ts'), 'export function total(n: number) { return n + 2; }\nexport function untouched(n: number) { return n * 1; }\n');
  git(f.root, 'commit', '--quiet', '-am', 'Another candidate base');
  const otherBase = git(f.root, 'rev-parse', 'HEAD');
  await writeFile(join(f.root, 'app/logic.ts'), 'export function total(n: number) { return n + 2; }\nexport function untouched(n: number) { return n * 2; }\n');
  git(f.root, 'commit', '--quiet', '-am', 'Same final code, different delta');
  const head = git(f.root, 'rev-parse', 'HEAD');
  const original = await environment.describeTestEnvironment(f.source, f.scope, head, f.context, undefined, f.base);
  const later = await environment.describeTestEnvironment(f.source, f.scope, head, f.context, undefined, otherBase);
  expect(original.mutation?.selection.selected.map(fn => fn.name)).toEqual(['total']);
  expect(later.mutation?.selection.selected.map(fn => fn.name)).toEqual(['untouched']);
  const fingerprint = (value: typeof original) => value.fingerprints!.find(print => print.suiteId === 'mutation' && print.file === 'app/logic.ts')!.fingerprint;
  expect(fingerprint(original)).not.toBe(fingerprint(later));
});
