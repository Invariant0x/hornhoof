import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
const ids = vi.hoisted(() => ({ jobUid: 2_000_000_000 + (process.getuid?.() ?? 0) % 1_000_000, builderUid: 2_001_000_000 + (process.getuid?.() ?? 0) % 1_000_000, chowned: [] as string[], handedOver: [] as { path: string; dependencies: boolean }[] }));
import type { HarnessClaim, HarnessUnit, ServerMessage, TestEnvironmentV1 } from '@hornhoof/protocol';
// Only the unavailable OS identity operations are doubled. Git, files, cache, commands and cleanup are real.
vi.mock('node:child_process', async original => {
  const module = await original<typeof import('node:child_process')>();
  return { ...module, spawn: (bin: string, args: string[], options: import('node:child_process').SpawnOptions) => module.spawn(bin, args, { ...options, uid: undefined, gid: undefined }) };
});
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), chownSync: () => {} }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), chown: async (path: string) => { ids.chowned.push(path); } }));
vi.mock('../src/isolation.js', async original => {
  const module = await original<typeof import('../src/isolation.js')>();
  const { existsSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...module, userFor: () => ({ uid: ids.builderUid, gid: ids.builderUid }), ensurePasswd: () => {}, prepareFolder: (path: string, user: unknown) => { if (user) ids.handedOver.push({ path, dependencies: existsSync(`${path}/node_modules`) }); return module.prepareFolder(path, null); } };
});
import { pruneCache } from '../src/test-cache.js';
import { dependencyCacheKey, environmentCacheKey, harnessVersion, readTestEnvironment } from '../src/test-environment.js';
import { type HarnessRemote } from '../src/test-harness.js';
import { runTests, syncHarness } from '../src/tests.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { await rm(root, { recursive: true, force: true }); } });
const sh = (code: string) => ({ program: 'node', args: ['-e', code], cwd: '.' });
const INSTALL = (log: string) => `const f=require('fs');f.appendFileSync(${JSON.stringify(log)},'x');f.mkdirSync('node_modules/.bin',{recursive:true});f.writeFileSync('node_modules/ready','dep');f.writeFileSync('node_modules/.bin/tool','#!/bin/sh\\n',{mode:0o755})`;
const CHECK = "const f=require('fs');if(f.readFileSync('node_modules/ready','utf8')!=='dep')process.exit(7);if(f.readFileSync(process.env.HH_TEMPLATE+'/ready','utf8')!=='schema ready')process.exit(8);console.log('tests started without installing')";

/* The company's repository, one commit of it, and the registry of what is built, as Hornhoof keeps it. */
async function fixture(configure?: (manifest: TestEnvironmentV1) => void) {
  const root = await mkdtemp(join(tmpdir(), 'hh-harness-run-')); roots.push(root);
  const source = join(root, 'source'); await mkdir(join(source, '.hornhoof'), { recursive: true }); await mkdir(join(root, 'proc'));
  const installs = join(root, 'installs'); await writeFile(installs, '');
  const manifest: TestEnvironmentV1 = {
    version: 1, defaultProfile: 'fast', profiles: [{ id: 'fast', requiredSuiteIds: ['unit'] }], runtimes: [{ id: 'node', version: process.versions.node.split('.')[0]! }],
    dependencies: { adapter: 'npm', inputs: ['package-lock.json'], install: [sh(INSTALL(installs))], paths: ['node_modules'], cache: 'link' },
    services: [], prepare: [{ id: 'schema', profiles: ['fast'], serviceIds: [], inputs: ['migration.sql'], commands: [sh("const f=require('fs');if(f.readFileSync('node_modules/ready','utf8')!=='dep')process.exit(9);f.mkdirSync('template');f.writeFileSync('template/ready',f.readFileSync('migration.sql'))")], artifacts: [{ path: 'template', format: 'directory', env: 'HH_TEMPLATE' }] }],
    reset: null, suites: [{ id: 'unit', root: '.', files: ['test.js'], run: sh(CHECK), split: { kind: 'whole-package' }, profiles: ['fast'] }],
    impact: { adapter: 'whole-package', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'none' } }, mutation: { status: 'unsupported', language: 'javascript', reason: 'none' },
  };
  configure?.(manifest);
  await writeFile(join(source, '.hornhoof/test-environment.json'), JSON.stringify(manifest));
  await writeFile(join(source, 'package-lock.json'), '{"lockfileVersion":3}'); await writeFile(join(source, 'migration.sql'), 'schema ready'); await writeFile(join(source, 'test.js'), '');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, env: { ...process.env, GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.test', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.test' }, encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'One');
  const commit = async (path: string, text: string) => { await writeFile(join(source, path), text); git('add', '.'); git('commit', '-qm', 'Next'); return git('rev-parse', 'HEAD'); };
  const repo = { url: pathToFileURL(source).href, token: '' };
  const repositoryScope = { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: createHash('sha256').update(repo.url).digest('hex') };
  return { root, source, repo, repositoryScope, git, commit, installs, head: () => git('rev-parse', 'HEAD') };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const installed = async (f: Fixture) => (await readFile(f.installs, 'utf8')).length;

/* The registry's rules, without its server: one builder per key, the rest take its bundle. */
function registry() {
  const builds = new Map<string, { builder: string | null; bundle?: Buffer; digest?: string; failed?: string }>(), keysSeen: string[] = [];
  const remote = (name: string): HarnessRemote => ({
    async claim(unit: HarnessUnit): Promise<HarnessClaim> {
      keysSeen.push(unit.key);
      const build = builds.get(unit.key);
      if (build?.failed) return { state: 'failed', error: build.failed, afterMs: 1000 };
      if (build?.bundle) return { state: 'ready', digest: build.digest!, size: build.bundle.length, partBytes: 1024 * 1024 };
      if (build && build.builder !== name) return { state: 'wait', afterMs: 5 };
      builds.set(unit.key, { builder: name });
      return { state: 'build', partBytes: 1024 * 1024 };
    },
    async upload(key, file, digest) { builds.set(key, { builder: null, bundle: await readFile(file), digest }); },
    async download(key, file) { await writeFile(file, builds.get(key)!.bundle!); },
    async failed(key, error) { if (error) builds.set(key, { builder: null, failed: error }); else builds.delete(key); },
  });
  return { builds, remote, keysSeen };
}
const machine = (f: Fixture, name: string, harness?: HarnessRemote) => ({ dir: join(f.root, name), proc: join(f.root, 'proc'), user: { uid: ids.jobUid, gid: ids.jobUid }, hidden: [], prepareRepoBrowser: async () => {}, ...(harness ? { harness } : {}) });
async function productPart(f: Fixture, options: ReturnType<typeof machine>, commitSha = f.head()): Promise<Extract<ServerMessage, { type: 'tests.run' }>> {
  const description = await readTestEnvironment(f.repo, f.repositoryScope, commitSha, { cacheRoot: join(options.dir, 'cache'), deadline: Date.now() + 10_000, signal: new AbortController().signal, log: () => {} });
  return { type: 'tests.run', partId: randomUUID(), repo: f.repo, repositoryScope: f.repositoryScope, commitSha, branch: null, task: 1, command: '', part: 1, parts: 1, timeoutMs: 20_000, environment: { snapshot: { description, profile: 'fast' }, selection: { kind: 'suite', suiteId: 'unit', files: ['test.js'] } } };
}
const manualPart = (f: Fixture, command: string): Extract<ServerMessage, { type: 'tests.run' }> => ({ type: 'tests.run', partId: randomUUID(), repo: f.repo, repositoryScope: f.repositoryScope, commitSha: f.head(), branch: null, task: 1, command, part: 1, parts: 1, timeoutMs: 20_000 });
const asked = (f: Fixture, commitSha = f.head()): Extract<ServerMessage, { type: 'tests.harness' }> => ({ type: 'tests.harness', requestId: randomUUID(), repositoryScope: f.repositoryScope, repo: f.repo, commitSha });

describe('a harness that reaches every machine', () => {
  it('is built once however many machines get it ready, and a new run on any of them starts with no install and no build', async () => {
    const f = await fixture(), shared = registry();
    const one = machine(f, 'one', shared.remote('one')), two = machine(f, 'two', shared.remote('two'));
    const first = await syncHarness(asked(f), one);
    expect(first.result).toMatchObject({ status: 'ready' });
    expect(await syncHarness(asked(f), two)).toMatchObject({ result: first.result });
    expect(await installed(f)).toBe(1);
    await writeFile(f.installs, '');
    const part = await runTests(await productPart(f, two), two);
    expect(part, part.log).toMatchObject({ ok: true, environmentReceipt: { dependencies: { hit: true }, environments: [{ unitId: 'schema', hit: true }] } });
    expect(part.log).toContain('tests started without installing');
    expect(await installed(f)).toBe(0);
  });

  it('updates once when the lock file changes, keeps what did not change, and reaches every machine', async () => {
    const f = await fixture(), shared = registry();
    const one = machine(f, 'one', shared.remote('one')), two = machine(f, 'two', shared.remote('two'));
    await syncHarness(asked(f), one); await syncHarness(asked(f), two);
    const before = shared.builds.size, version = harnessVersion(await readTestEnvironment(f.repo, f.repositoryScope, f.head(), { cacheRoot: join(one.dir, 'cache'), deadline: Date.now() + 10_000, signal: new AbortController().signal, log: () => {} }));
    await writeFile(f.installs, '');
    const next = await f.commit('package-lock.json', '{"lockfileVersion":3,"changed":true}');
    const [a, b] = [await syncHarness(asked(f, next), one), await syncHarness(asked(f, next), two)];
    expect(await installed(f)).toBe(1);
    expect(a.result).toEqual(b.result);
    expect(a.result).toMatchObject({ status: 'ready' });
    expect((a.result as { version: string }).version).not.toBe(version);
    expect(shared.builds.size).toBe(before + 2);
    const part = await runTests(await productPart(f, two, next), two);
    expect(part, part.log).toMatchObject({ ok: true, environmentReceipt: { dependencies: { hit: true } } });
  });

  it('updates only what changed: a new migration leaves the dependencies alone', async () => {
    const f = await fixture(), shared = registry(), one = machine(f, 'one', shared.remote('one'));
    const first = await syncHarness(asked(f), one);
    await writeFile(f.installs, '');
    const next = await f.commit('migration.sql', 'schema ready 2');
    const second = await syncHarness(asked(f, next), one);
    expect(await installed(f)).toBe(0);
    const keys = (done: typeof first) => (done.result as { keys: string[] }).keys;
    expect(keys(second)[0]).toBe(keys(first)[0]);
    expect(keys(second)[1]).not.toBe(keys(first)[1]);
  });

  it('keeps the last version when an update fails: the run on the broken commit fails with why, the run on the good one goes on', async () => {
    const f = await fixture(), shared = registry(), two = machine(f, 'two', shared.remote('two'));
    const good = f.head();
    await syncHarness(asked(f), two);
    const fails = await fixture(manifest => { manifest.dependencies.install = [sh("console.log('the install said this');process.exit(3)")]; });
    const brokenRegistry = registry(), broken = machine(fails, 'one', brokenRegistry.remote('one'));
    const done = await syncHarness(asked(fails), broken);
    expect(done.result).toMatchObject({ status: 'error', problem: { code: 'build_failed' } });
    expect([...brokenRegistry.builds.values()][0]!.failed).toContain('the install said this');
    const again = await syncHarness(asked(fails), machine(fails, 'two', brokenRegistry.remote('two')));
    expect(again.result).toMatchObject({ status: 'error', problem: { code: 'build_failed' } });
    const part = await runTests(await productPart(f, two, good), two);
    expect(part, part.log).toMatchObject({ ok: true });
  });

  it('builds each architecture its own, under one version', async () => {
    const f = await fixture(), description = await readTestEnvironment(f.repo, f.repositoryScope, f.head(), { cacheRoot: join(f.root, 'cache'), deadline: Date.now() + 10_000, signal: new AbortController().signal, log: () => {} });
    const other = { ...description, runtimeCapabilities: description.runtimeCapabilities.map(runtime => ({ ...runtime, fingerprint: 'a'.repeat(64) })) };
    expect(harnessVersion(other)).toBe(harnessVersion(description));
    expect(dependencyCacheKey(other)).not.toBe(dependencyCacheKey(description));
  });

  it('builds each architecture its own whatever program builds it, as nothing else in a key need name the machine', async () => {
    const plain = (code: string) => ({ program: 'sh', args: ['-c', code], cwd: '.' });
    const f = await fixture(manifest => { manifest.runtimes = []; manifest.dependencies.install = [plain('mkdir node_modules')]; manifest.prepare[0]!.commands = [plain('mkdir template')]; });
    const description = await readTestEnvironment(f.repo, f.repositoryScope, f.head(), { cacheRoot: join(f.root, 'cache'), deadline: Date.now() + 10_000, signal: new AbortController().signal, log: () => {} });
    const other = { ...description, runtimeCapabilities: description.runtimeCapabilities.map(runtime => ({ ...runtime, fingerprint: 'a'.repeat(64) })) };
    expect(harnessVersion(other)).toBe(harnessVersion(description));
    expect(dependencyCacheKey(other)).not.toBe(dependencyCacheKey(description));
    expect(environmentCacheKey(other, 'schema', 'k')).not.toBe(environmentCacheKey(description, 'schema', 'k'));
  });

  it('answers at once for a version it holds, without a checkout', async () => {
    const f = await fixture(), shared = registry();
    let checkouts = 0;
    const one = { ...machine(f, 'one', shared.remote('one')), prepareRepoBrowser: async () => { checkouts++; } };
    const first = await syncHarness(asked(f), one);
    shared.keysSeen.length = 0;
    expect(await syncHarness(asked(f), one)).toMatchObject({ result: first.result });
    expect(shared.keysSeen).toEqual([]);
    expect(checkouts).toBe(1);
  });

  it('gets the harness again when what it held is gone', async () => {
    const f = await fixture(), shared = registry(), one = machine(f, 'one', shared.remote('one'));
    const first = await syncHarness(asked(f), one);
    await rm(join(one.dir, 'cache', 'dependencies'), { recursive: true, force: true });
    await writeFile(f.installs, '');
    expect(await syncHarness(asked(f), one)).toMatchObject({ result: first.result });
    expect(await installed(f)).toBe(0);
  });

  it('leaves no folder behind, however it ends', async () => {
    const f = await fixture(), one = machine(f, 'one', registry().remote('one'));
    await syncHarness(asked(f), one);
    expect(await readdir(join(one.dir, 'runs'))).toEqual([]);
  });

  it('says it was stopped, not that the product is broken', async () => {
    const f = await fixture(), stop = new AbortController(), one = machine(f, 'one', registry().remote('one'));
    stop.abort(new Error('The machine went away.'));
    expect((await syncHarness(asked(f), { ...one, signal: stop.signal })).result).toMatchObject({ status: 'error', problem: { code: 'cancelled' } });
  });

  it('says what a repository it cannot read lacks, without calling it a build failure', async () => {
    const f = await fixture(), one = machine(f, 'one', registry().remote('one'));
    const missing = asked(f, 'f'.repeat(40));
    expect((await syncHarness(missing, one)).result).toMatchObject({ status: 'error', problem: { code: 'commit_unavailable' } });
  });
});

describe('what a part gets of a shared tree', () => {
  it('gives dependencies read-only by links, so a part cannot spoil them for the next one, and writes of its own stay its own', async () => {
    const write = "const f=require('fs');try{f.writeFileSync('node_modules/ready','spoiled');process.exit(5)}catch(e){if(e.code!=='EACCES')throw e}f.writeFileSync('node_modules/.own','mine');f.rmSync('node_modules/.bin/tool');f.writeFileSync('node_modules/.bin/tool','replaced');console.log('own writes pass')";
    const f = await fixture(manifest => { manifest.suites[0]!.run = sh(write); }), one = machine(f, 'one', registry().remote('one'));
    const first = await runTests(await productPart(f, one), one);
    expect(first, first.log).toMatchObject({ ok: true }); expect(first.log).toContain('own writes pass');
    const [key] = (await readdir(join(one.dir, 'cache', 'dependencies'))).filter(name => /^[a-f0-9]{64}$/.test(name));
    const stored = join(one.dir, 'cache', 'dependencies', key!, 'payload', 'node_modules');
    expect(await readFile(join(stored, 'ready'), 'utf8')).toBe('dep');
    expect((await lstat(join(stored, 'ready'))).mode & 0o222).toBe(0);
    expect(await readFile(join(stored, '.bin', 'tool'), 'utf8')).toBe('#!/bin/sh\n');
    const second = await runTests(await productPart(f, one), one);
    expect(second, second.log).toMatchObject({ ok: true, environmentReceipt: { dependencies: { hit: true } } });
  });

  it('hands a folder to its user before linking anything into it, as a handover afterwards would reach the stored files', async () => {
    const f = await fixture(), one = machine(f, 'one', registry().remote('one'));
    ids.chowned.length = 0; ids.handedOver.length = 0;
    const part = await runTests(await productPart(f, one), one);
    expect(part, part.log).toMatchObject({ ok: true });
    expect(ids.handedOver.some(({ path }) => path.endsWith('/repo'))).toBe(true);
    expect(ids.handedOver.some(({ path }) => /\/builders\/unit-[^/]+$/.test(path))).toBe(true);
    expect(ids.handedOver.filter(({ dependencies }) => dependencies)).toEqual([]);
    expect(ids.chowned.filter(path => path.endsWith('/node_modules')).length).toBeGreaterThan(0);
    expect(ids.chowned.filter(path => path.endsWith('/node_modules/ready'))).toEqual([]);
    expect(ids.chowned.filter(path => path.endsWith('/template/ready')).length).toBeGreaterThan(0);
  });

  it('gives what a unit prepared as a part\'s own copy to write in', async () => {
    const check = "const f=require('fs');f.writeFileSync(process.env.HH_TEMPLATE+'/ready','changed by this part');console.log('wrote its own copy')";
    const f = await fixture(manifest => { manifest.suites[0]!.run = sh(check); }), one = machine(f, 'one', registry().remote('one'));
    const first = await runTests(await productPart(f, one), one);
    expect(first, first.log).toMatchObject({ ok: true });
    const second = await runTests(await productPart(f, one), one);
    expect(second, second.log).toMatchObject({ ok: true, environmentReceipt: { environments: [{ hit: true }] } });
  });

  it('copies when the repository says nothing may be shared read-only', async () => {
    const write = "const f=require('fs');f.writeFileSync('node_modules/ready','changed by this part');console.log('wrote its own copy')";
    const f = await fixture(manifest => { manifest.dependencies.cache = 'copy'; manifest.suites[0]!.run = sh(write); }), one = machine(f, 'one', registry().remote('one'));
    const first = await runTests(await productPart(f, one), one);
    expect(first, first.log).toMatchObject({ ok: true }); expect(first.log).toContain('wrote its own copy');
  });

  it('reports that a unit came from another machine', async () => {
    const f = await fixture(), shared = registry(), one = machine(f, 'one', shared.remote('one')), two = machine(f, 'two', shared.remote('two'));
    await runTests(await productPart(f, one), one);
    const part = await runTests(await productPart(f, two), two);
    expect(part, part.log).toMatchObject({ ok: true, environmentReceipt: { dependencies: { hit: true, fetched: true }, environments: [{ hit: true, fetched: true }] } });
  });

  it('does not ask a machine\'s programs again when it knows them from its start', async () => {
    const f = await fixture(), on = machine(f, 'one'), part = await productPart(f, on), { description } = part.environment!.snapshot;
    const known = description.runtimeCapabilities.map(runtime => (runtime.id === 'hornhoof-test-execution' ? { ...runtime, fingerprint: 'f'.repeat(64) } : runtime));
    const done = await runTests(part, { ...on, runtimes: known });
    expect(done, done.log).toMatchObject({ ok: true });
    expect(done.environmentReceipt!.runtimes).toEqual(known);
  });

  it('still works on a machine with no registry', async () => {
    const f = await fixture(), one = machine(f, 'one');
    const part = await runTests(await productPart(f, one), one);
    expect(part, part.log).toMatchObject({ ok: true, environmentReceipt: { dependencies: { hit: false } } });
  });
});

describe('a project whose tools come with its harness', () => {
  const plain = (code: string) => ({ program: 'sh', args: ['-c', code], cwd: '.' });
  const tools = (manifest: TestEnvironmentV1) => {
    manifest.runtimes = [];
    manifest.dependencies = { adapter: 'tools', inputs: [], install: [plain('mkdir -p .tools/bin && printf "#!/bin/sh\\necho the tool at \\$TOOL_HOME\\n" > .tools/bin/hello && chmod +x .tools/bin/hello'), { program: 'hello', args: [], cwd: '.' }], paths: ['.tools'], cache: 'link', env: { TOOL_HOME: '.tools' }, bin: ['.tools/bin'] };
    manifest.prepare = [{ id: 'schema', profiles: ['fast'], serviceIds: [], inputs: ['migration.sql'], commands: [plain('mkdir template shared && hello > template/ready && hello > shared/ready')], artifacts: [{ path: 'template', format: 'directory', env: 'HH_TEMPLATE' }, { path: 'shared', format: 'directory', link: true }] }];
    manifest.suites[0]!.run = { program: 'hello', args: [], cwd: '.' };
  };

  it('finds them by name while it is built, in what it prepares, in its tests and in a manual command, at the path of each', async () => {
    const f = await fixture(tools), one = machine(f, 'one', registry().remote('one'));
    const part = await runTests(await productPart(f, one), one);
    expect(part, part.log).toMatchObject({ ok: true });
    expect(part.log).toMatch(/the tool at \S*\/runs\/[^/\s]+\/repo\/\.tools/);
    const manual = await runTests(manualPart(f, 'hello'), one);
    expect(manual, manual.log).toMatchObject({ ok: true, exitCode: 0 });
    expect(manual.log).toMatch(/the tool at \S*\/repo\/\.tools/);
  });

  it('builds again when what names them changes, as what it builds may depend on it', async () => {
    const f = await fixture(tools), a = await readTestEnvironment(f.repo, f.repositoryScope, f.head(), { cacheRoot: join(f.root, 'cache'), deadline: Date.now() + 10_000, signal: new AbortController().signal, log: () => {} });
    const moved = { ...a, manifest: { ...a.manifest, dependencies: { ...a.manifest.dependencies, bin: ['.tools'] } } };
    expect(dependencyCacheKey(moved)).not.toBe(dependencyCacheKey(a));
    const named = { ...a, manifest: { ...a.manifest, dependencies: { ...a.manifest.dependencies, env: { OTHER_HOME: '.tools' } } } };
    expect(dependencyCacheKey(named)).not.toBe(dependencyCacheKey(a));
  });

  it('shares what a unit marks read-only by links, and gives the rest of it as a part\'s own copy', async () => {
    const check = "const f=require('fs');f.writeFileSync('template/ready','mine');try{f.writeFileSync('shared/ready','spoiled');process.exit(5)}catch(e){if(e.code!=='EACCES')throw e}console.log('the shared part stays')";
    const f = await fixture(manifest => { tools(manifest); manifest.runtimes = [{ id: 'node', version: process.versions.node.split('.')[0]! }]; manifest.suites[0]!.run = sh(check); }), one = machine(f, 'one', registry().remote('one'));
    const part = await runTests(await productPart(f, one), one);
    expect(part, part.log).toMatchObject({ ok: true }); expect(part.log).toContain('the shared part stays');
    const again = await runTests(await productPart(f, one), one);
    expect(again, again.log).toMatchObject({ ok: true, environmentReceipt: { environments: [{ hit: true }] } });
  });
});

describe('a manual command', () => {
  it('starts with the harness in place, and the variables it names', async () => {
    const f = await fixture(), shared = registry(), one = machine(f, 'one', shared.remote('one'));
    await syncHarness(asked(f), one);
    await writeFile(f.installs, '');
    const part = await runTests(manualPart(f, `node -e "${CHECK.replaceAll('"', '\\"')}"`), one);
    expect(part, part.log).toMatchObject({ ok: true, exitCode: 0 });
    expect(part.log).toContain('tests started without installing');
    expect(await installed(f)).toBe(0);
  });

  it('runs even when its harness cannot be built, as it may install for itself', async () => {
    const f = await fixture(manifest => { manifest.dependencies.install = [sh('process.exit(3)')]; }), one = machine(f, 'one', registry().remote('one'));
    const part = await runTests(manualPart(f, 'echo the command ran'), one);
    expect(part, part.log).toMatchObject({ ok: true, exitCode: 0 });
    expect(part.log).toContain('the command ran');
    expect(part.log).toContain('starts without the prepared harness');
  });

  it('prepares nothing on a machine that shares nothing, or for a part of work', async () => {
    const f = await fixture(), one = machine(f, 'one');
    const plain = await runTests(manualPart(f, 'test ! -e node_modules && echo nothing prepared'), one);
    expect(plain, plain.log).toMatchObject({ ok: true }); expect(await installed(f)).toBe(0);
    const shared = machine(f, 'two', registry().remote('two'));
    const work = await runTests({ ...manualPart(f, 'test ! -e node_modules && echo nothing prepared'), kind: 'work', commitSha: null, branch: 'HEAD' }, shared);
    expect(await installed(f)).toBe(0); expect(work.log).not.toContain('prepared harness');
  });

  it('leaves a manifest that shares nothing to its command', async () => {
    const f = await fixture(manifest => { manifest.dependencies.cache = 'none'; manifest.prepare = []; }), one = machine(f, 'one', registry().remote('one'));
    const part = await runTests(manualPart(f, 'echo own install'), one);
    expect(part, part.log).toMatchObject({ ok: true }); expect(await installed(f)).toBe(0);
  });
});

describe('what a machine keeps', () => {
  const entries = async (dir: string, ages: number[]) => {
    await mkdir(join(dir, '.locks'), { recursive: true, mode: 0o700 });
    const names = ages.map((_, index) => String(index).padStart(64, 'a'));
    for (const [index, name] of names.entries()) {
      await mkdir(join(dir, name), { recursive: true }); await writeFile(join(dir, name, 'USED'), '');
      const at = new Date(Date.now() - ages[index]!);
      await utimes(join(dir, name, 'USED'), at, at);
    }
    return names;
  };
  const HOUR = 3_600_000;
  const context = (dir: string) => ({ cacheRoot: dir, deadline: Date.now() + 10_000, signal: new AbortController().signal, log: () => {} });

  it('keeps the ones used last, and whatever a running part may still read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hh-prune-')); roots.push(root); await chmod(root, 0o700);
    const names = await entries(root, [1, 5 * HOUR, 6 * HOUR, 7 * HOUR]);
    await pruneCache(root, 2, context(root));
    expect((await readdir(root)).filter(name => name !== '.locks').sort()).toEqual([names[0], names[1]].sort());
    const busy = await mkdtemp(join(tmpdir(), 'hh-prune-')); roots.push(busy); await chmod(busy, 0o700);
    const fresh = await entries(busy, [1, 2, 3]);
    await pruneCache(busy, 1, context(busy));
    expect((await readdir(busy)).filter(name => name !== '.locks').sort()).toEqual([...fresh].sort());
  });

  it('lets go of what nobody used for a long time, and of what a crash left behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hh-prune-')); roots.push(root); await chmod(root, 0o700);
    await entries(root, [8 * 24 * HOUR]);
    const left = join(root, '.staging-old'), young = join(root, '.staging-new'); await mkdir(left); await mkdir(young);
    const old = new Date(Date.now() - 48 * HOUR); await utimes(left, old, old);
    await pruneCache(root, 8, context(root));
    expect((await readdir(root)).sort()).toEqual(['.locks', '.staging-new']);
    expect((await stat(young)).isDirectory()).toBe(true);
  });
});
