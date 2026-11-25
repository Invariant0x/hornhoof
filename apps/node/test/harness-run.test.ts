import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
const ids = vi.hoisted(() => ({ jobUid: 2_000_000_000 + (process.getuid?.() ?? 0) % 1_000_000, builderUid: 2_001_000_000 + (process.getuid?.() ?? 0) % 1_000_000, chowned: [] as string[], handedOver: [] as { path: string; dependencies: boolean }[] }));
import type { HarnessClaim, HarnessUnit, ServerMessage, TestEnvironmentV1 } from '@hornhoof/protocol';
// Only the unavailable OS identity operations are doubled. Git, files, cache, commands and cleanup are real.
vi.mock('node:child_process', async original => {
  const module = await original<typeof import('node:child_process')>();
  return { ...module, spawn: (bin: string, args: string[], options: import('node:child_process').SpawnOptions) => module.spawn(bin, args, { ...options, uid: undefined, gid: undefined }) };
});
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), chownSync: () => {}, fchownSync: () => {} }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), chown: async (path: string) => { ids.chowned.push(path); } }));
vi.mock('../src/isolation.js', async original => {
  const module = await original<typeof import('../src/isolation.js')>();
  const { existsSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...module, userFor: () => ({ uid: ids.builderUid, gid: ids.builderUid }), ensurePasswd: () => {}, prepareFolder: (path: string, user: unknown) => { if (user) ids.handedOver.push({ path, dependencies: existsSync(`${path}/node_modules`) }); return module.prepareFolder(path, null); } };
});
import { pruneCache } from '../src/test-cache.js';
import { dependencyCacheKey, environmentCacheKey, harnessVersion, readTestEnvironment } from '../src/test-environment.js';
import { type HarnessRemote } from '../src/test-harness.js';
import { agentFs, ownFs } from '../src/agent-fs.js';
import { runTests, syncHarness, worktreeHarness, type Worktree } from '../src/tests.js';
import { eventually } from '../../../test-support/eventually.mjs';

const roots: string[] = [];
/* Times that never run out: the longest a timer waits, and a part's, whose output may still take a minute past it. */
const NEVER_MS = 2_147_483_647, NEVER_PART_MS = NEVER_MS - 60_000;
/* A clock that moves only when the test moves it, for the timers, the time and the waits that end at a moment, which Node's
   own AbortSignal.timeout would keep on the real clock. */
function fakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const timer = new AbortController();
    setTimeout(() => { timer.abort(new DOMException('The operation timed out.', 'TimeoutError')); }, ms);
    return timer.signal;
  });
  onTestFinished(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
}
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
      if (build?.bundle) return { state: 'ready', companyId: unit.repositoryScope.companyId, attempt: '33333333-3333-4333-8333-333333333333', digest: build.digest!, size: build.bundle.length, partBytes: 1024 * 1024 };
      if (build && build.builder !== name) return { state: 'wait', afterMs: 5 };
      builds.set(unit.key, { builder: name });
      return { state: 'build', companyId: unit.repositoryScope.companyId, attempt: '33333333-3333-4333-8333-333333333333', partBytes: 1024 * 1024 };
    },
    async upload(key, file, digest) { builds.set(key, { builder: null, bundle: await readFile(file), digest }); },
    async download(key, file) { await writeFile(file, builds.get(key)!.bundle!); },
    /* As Hornhoof does, only the machine that holds a build may give it back or fail it. */
    async failed(key, error) { if (builds.get(key)?.builder !== name) return; if (error) builds.set(key, { builder: null, failed: error }); else builds.delete(key); },
  });
  return { builds, remote, keysSeen };
}
const machine = (f: Fixture, name: string, harness?: HarnessRemote) => ({ dir: join(f.root, name), proc: join(f.root, 'proc'), user: { uid: ids.jobUid, gid: ids.jobUid }, hidden: [], prepareRepoBrowser: async () => {}, ...(harness ? { harness } : {}) });
async function productPart(f: Fixture, options: ReturnType<typeof machine>, commitSha = f.head()): Promise<Extract<ServerMessage, { type: 'tests.run' }>> {
  const description = await readTestEnvironment(f.repo, f.repositoryScope, commitSha, { cacheRoot: join(options.dir, 'cache'), deadline: Date.now() + NEVER_MS, signal: new AbortController().signal, log: () => {} });
  return { type: 'tests.run', partId: randomUUID(), repo: f.repo, repositoryScope: f.repositoryScope, commitSha, branch: null, task: 1, command: '', part: 1, parts: 1, timeoutMs: NEVER_PART_MS, environment: { snapshot: { description, profile: 'fast' }, selection: { kind: 'suite', suiteId: 'unit', files: ['test.js'] } } };
}
const manualPart = (f: Fixture, command: string): Extract<ServerMessage, { type: 'tests.run' }> => ({ type: 'tests.run', partId: randomUUID(), repo: f.repo, repositoryScope: f.repositoryScope, commitSha: f.head(), branch: null, task: 1, command, part: 1, parts: 1, timeoutMs: NEVER_PART_MS });
const asked = (f: Fixture, commitSha = f.head()): Extract<ServerMessage, { type: 'tests.harness' }> => ({ type: 'tests.harness', requestId: randomUUID(), repositoryScope: f.repositoryScope, repo: f.repo, commitSha });

describe('a harness that reaches every machine', () => {
  it('redacts the repository token before a manual preparation failure reaches the registry', async () => {
    const marker = 'synthetic-repository-token-696';
    const f = await fixture(manifest => { manifest.dependencies.install = [sh(`console.error('${marker}');process.exit(1)`)]; });
    f.repo.token = marker;
    const shared = registry(), options = machine(f, 'manual-secret', shared.remote('one'));
    const result = await runTests(manualPart(f, 'true'), options);
    const failures = [...shared.builds.values()].map(build => build.failed).filter(Boolean).join('\n');
    expect(failures).toContain('[hidden]');
    expect(failures).not.toContain(marker);
    expect(result.log).not.toContain(marker);
  });

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
    const before = shared.builds.size, version = harnessVersion(await readTestEnvironment(f.repo, f.repositoryScope, f.head(), { cacheRoot: join(one.dir, 'cache'), deadline: Date.now() + NEVER_MS, signal: new AbortController().signal, log: () => {} }));
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
    const f = await fixture(), description = await readTestEnvironment(f.repo, f.repositoryScope, f.head(), { cacheRoot: join(f.root, 'cache'), deadline: Date.now() + NEVER_MS, signal: new AbortController().signal, log: () => {} });
    const other = { ...description, runtimeCapabilities: description.runtimeCapabilities.map(runtime => ({ ...runtime, fingerprint: 'a'.repeat(64) })) };
    expect(harnessVersion(other)).toBe(harnessVersion(description));
    expect(dependencyCacheKey(other)).not.toBe(dependencyCacheKey(description));
  });

  it('builds each architecture its own whatever program builds it, as nothing else in a key need name the machine', async () => {
    const plain = (code: string) => ({ program: 'sh', args: ['-c', code], cwd: '.' });
    const f = await fixture(manifest => { manifest.runtimes = []; manifest.dependencies.install = [plain('mkdir node_modules')]; manifest.prepare[0]!.commands = [plain('mkdir template')]; });
    const description = await readTestEnvironment(f.repo, f.repositoryScope, f.head(), { cacheRoot: join(f.root, 'cache'), deadline: Date.now() + NEVER_MS, signal: new AbortController().signal, log: () => {} });
    const other = { ...description, runtimeCapabilities: description.runtimeCapabilities.map(runtime => ({ ...runtime, fingerprint: 'a'.repeat(64) })) };
    expect(harnessVersion(other)).toBe(harnessVersion(description));
    expect(dependencyCacheKey(other)).not.toBe(dependencyCacheKey(description));
    expect(environmentCacheKey(other, 'schema', 'k')).not.toBe(environmentCacheKey(description, 'schema', 'k'));
  });

  it('builds anew for another version of the program a shell line calls, and only for that', async () => {
    const line = (code: string) => ({ program: 'sh', args: ['-c', code], cwd: '.' });
    const keys = async (code: string) => {
      const f = await fixture(manifest => { manifest.runtimes = []; manifest.prepare[0]!.commands = [line(code)]; });
      const description = await readTestEnvironment(f.repo, f.repositoryScope, f.head(), { cacheRoot: join(f.root, 'cache'), deadline: Date.now() + NEVER_MS, signal: new AbortController().signal, log: () => {} });
      const newer = (id: string) => ({ ...description, runtimeCapabilities: [...description.runtimeCapabilities.filter(runtime => runtime.id !== id), { id, version: '99.0.0', fingerprint: 'a'.repeat(64) }] });
      return { node: environmentCacheKey(newer('node'), 'schema', 'k') !== environmentCacheKey(description, 'schema', 'k'), python: environmentCacheKey(newer('python'), 'schema', 'k') !== environmentCacheKey(description, 'schema', 'k') };
    };
    expect(await keys('set -e\nnpm ci --no-audit')).toEqual({ node: true, python: false });
    expect(await keys('set -e\npython3 -m venv x')).toEqual({ node: false, python: true });
    expect(await keys('set -e\ngo mod download')).toEqual({ node: false, python: false });
  });

  it('gets the browser a program in a folder pins, ahead of any run', async () => {
    const f = await fixture(manifest => { const [suite] = manifest.suites; suite!.root = 'web'; suite!.files = ['web/test.js']; manifest.prepare[0]!.commands[0] = sh("require('fs').mkdirSync('template')"); });
    await mkdir(join(f.source, 'web')); await writeFile(join(f.source, 'web/test.js'), '');
    await f.commit('web/package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/playwright': { version: '1.50.0' } } }));
    const folders: string[] = [], one = { ...machine(f, 'one', registry().remote('one')), prepareRepoBrowser: async (folder: string) => { folders.push(folder); } };
    const done = await syncHarness(asked(f), one);
    expect(done.result, JSON.stringify(done.result)).toMatchObject({ status: 'ready' });
    expect(folders.map(folder => folder.split('/repo').at(-1))).toEqual(['', '/web']);
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
    /* Stored, it becomes the node's; linked into a part, it stays so. */
    expect(ids.chowned.filter(path => path.endsWith('/node_modules/ready') && !path.includes('/payload/'))).toEqual([]);
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
    const f = await fixture(tools), a = await readTestEnvironment(f.repo, f.repositoryScope, f.head(), { cacheRoot: join(f.root, 'cache'), deadline: Date.now() + NEVER_MS, signal: new AbortController().signal, log: () => {} });
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

  it('ends its harness with one plain line when the transfer timed out and the build here did not finish in its window', async () => {
    const marks = await mkdtemp(join(tmpdir(), 'hh-fallback-'));
    onTestFinished(() => rm(marks, { recursive: true, force: true }));
    const started = join(marks, 'started');
    /* The build here begins and does not end by itself, as a slow install on a loaded machine. */
    const f = await fixture(manifest => { manifest.dependencies.install = [sh(`require('fs').writeFileSync(${JSON.stringify(started)}, ''); setInterval(() => {}, 1000)`)]; });
    const remote: HarnessRemote = {
      claim: async (unit: HarnessUnit) => ({ state: 'ready', companyId: unit.repositoryScope.companyId, attempt: '33333333-3333-4333-8333-333333333333', digest: 'b'.repeat(64), size: 10, partBytes: 10 }),
      download: async () => { throw new Error('The bundle transfer from Hornhoof did not finish within 5 min (0 bytes of 10 bytes, 0%).'); },
      upload: async () => undefined,
      failed: async () => undefined,
    };
    /* The window of the harness ends when the test says so, once the build here has begun. */
    const window = new AbortController();
    const one = { ...machine(f, 'one', remote), harnessClock: { timeout: () => window.signal } };
    const running = runTests(manualPart(f, 'echo the command ran'), one);
    await until(() => existsSync(started));
    window.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    const part = await running;
    expect(part, part.log).toMatchObject({ ok: true, exitCode: 0 });
    expect(part.log).toContain('the command ran');
    expect(part.log).not.toContain('aborted due to timeout');
    expect(part.log).toMatch(/The command starts without the prepared harness: it was not in place within 10 min\. The prepared dependencies [0-9a-f]{12} could not be taken from Hornhoof: The bundle transfer from Hornhoof did not finish within 5 min .*\. It was built here instead, and that build did not finish in the time left\. What to do: /);
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
    /* An author installs only when the log says so, and here nothing else would. */
    expect(part.log).toContain('starts without the prepared harness');
  });
});

/* An agent's clone of the repository, as the node makes it for the agent's program in the machine's folder. */
async function worktree(f: Fixture, options: ReturnType<typeof machine>, commitSha = f.head()): Promise<Worktree> {
  const checkout = join(options.dir, 'work', 'agents', randomUUID(), 'shop');
  execFileSync('git', ['clone', '-q', f.source, checkout]);
  return { id: randomUUID(), checkout, commitSha, repo: f.repo, repositoryScope: f.repositoryScope, owner: { uid: ids.jobUid, gid: ids.jobUid }, fs: ownFs };
}
const PLACED = /^Dependencies in place from the shared harness after \d+ s\.$/;
const leftOver = async (options: ReturnType<typeof machine>) => (await readdir(join(options.dir, 'runs')).catch(() => [] as string[])).filter(name => name.startsWith('worktree-'));
/* The machine's turn for heavy work, held by a test part until it lets go. */
function heldTurn() {
  let release!: () => void;
  const free = new Promise<void>(resolve => { release = resolve; }), asked = { count: 0 }, inside = { count: 0 }, grants = { count: 0 };
  const slot = async <T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    asked.count++; await free; inside.count++; grants.count++;
    try { return await run(signal); } finally { inside.count--; }
  };
  return { slot, release, asked, inside, grants };
}
/* A machine's registry that notes what it was told and did, and whether it held the machine's turn meanwhile. */
function noted(remote: HarnessRemote, turn: ReturnType<typeof heldTurn>) {
  const claims: { state: string; inside: number }[] = [], downloads: number[] = [];
  return {
    claims, downloads,
    remote: {
      ...remote,
      async claim(unit, signal) { const claim = await remote.claim(unit, signal); claims.push({ state: claim.state, inside: turn.inside.count }); return claim; },
      async download(key, file, claim, signal) { downloads.push(turn.inside.count); return remote.download(key, file, claim, signal); },
    } satisfies HarnessRemote,
  };
}
const until = (check: () => boolean) => eventually(check);

describe("an agent's worktree", () => {
  it('gets the dependencies of its commit before its program starts, built once and taken by every other machine and by test runs', async () => {
    const f = await fixture(), shared = registry();
    const one = machine(f, 'one', shared.remote('one')), two = machine(f, 'two', shared.remote('two'));
    const mine = await worktree(f, one), theirs = await worktree(f, two);
    expect(await worktreeHarness(mine, one)).toMatch(PLACED);
    expect(await worktreeHarness(theirs, two)).toMatch(PLACED);
    for (const tree of [mine, theirs]) expect(await readFile(join(tree.checkout, 'node_modules', 'ready'), 'utf8')).toBe('dep');
    expect(await installed(f)).toBe(1);
    /* The key of a test run of the same commit, so a part there takes the same build. */
    const description = await readTestEnvironment(f.repo, f.repositoryScope, f.head(), { cacheRoot: join(two.dir, 'cache'), deadline: Date.now() + NEVER_MS, signal: new AbortController().signal, log: () => {} });
    expect(new Set(shared.keysSeen)).toEqual(new Set([dependencyCacheKey(description)]));
    const part = await runTests(await productPart(f, two), two);
    expect(part, part.log).toMatchObject({ ok: true, environmentReceipt: { dependencies: { hit: true } } });
    expect(await installed(f)).toBe(1);
    expect(await leftOver(one)).toEqual([]);
  });

  it("gives them as the agent's own files to change, not as links to what the machine keeps", async () => {
    const f = await fixture(), one = machine(f, 'one', registry().remote('one')), tree = await worktree(f, one);
    ids.chowned.length = 0;
    expect(await worktreeHarness(tree, one)).toMatch(PLACED);
    const ready = join(tree.checkout, 'node_modules', 'ready'), placed = await stat(ready);
    expect(placed.nlink).toBe(1);
    expect(placed.mode & 0o200).toBe(0o200);
    expect((await stat(join(tree.checkout, 'node_modules', '.bin', 'tool'))).mode & 0o111).toBe(0o111);
    expect(ids.chowned.some(path => path.endsWith('/node_modules/ready'))).toBe(true);
    await writeFile(ready, 'changed by the agent');
    const part = await runTests(await productPart(f, one), one);
    expect(part, part.log).toMatchObject({ ok: true, environmentReceipt: { dependencies: { hit: true } } });
  });

  it('waits for the machine that builds them and takes its build', async () => {
    const f = await fixture(), shared = registry();
    const one = machine(f, 'one', shared.remote('one')), two = machine(f, 'two', shared.remote('two'));
    const [a, b] = await Promise.all([worktreeHarness(await worktree(f, one), one), worktreeHarness(await worktree(f, two), two)]);
    expect([a, b]).toEqual([expect.stringMatching(PLACED), expect.stringMatching(PLACED)]);
    expect(await installed(f)).toBe(1);
  });

  it('leaves a worktree that holds them already as it is, without reading its commit', async () => {
    const f = await fixture(), shared = registry(), one = machine(f, 'one', shared.remote('one'));
    const tree = await worktree(f, one, 'f'.repeat(40));
    await mkdir(join(tree.checkout, 'node_modules'));
    await writeFile(join(tree.checkout, 'node_modules', 'mine'), 'own install');
    expect(await worktreeHarness(tree, one)).toBeNull();
    expect(await readdir(join(tree.checkout, 'node_modules'))).toEqual(['mine']);
    expect(shared.keysSeen).toEqual([]);
    expect(await installed(f)).toBe(0);
  });

  it('leaves a worktree as it is where a link stands in their place, even one that leads nowhere', async () => {
    const f = await fixture(), shared = registry(), one = machine(f, 'one', shared.remote('one'));
    const tree = await worktree(f, one);
    execFileSync('ln', ['-s', join(f.root, 'gone'), join(tree.checkout, 'node_modules')]);
    expect(await worktreeHarness(tree, one)).toBeNull();
    expect((await lstat(join(tree.checkout, 'node_modules'))).isSymbolicLink()).toBe(true);
    expect(shared.keysSeen).toEqual([]);
    expect(await installed(f)).toBe(0);
  });

  it('costs nothing and says nothing where the repository keeps no test environment', async () => {
    const f = await fixture(), shared = registry(), one = machine(f, 'one', shared.remote('one'));
    /* A commit nobody could fetch, so any reading of it would fail. */
    const tree = await worktree(f, one, 'f'.repeat(40));
    await rm(join(tree.checkout, '.hornhoof'), { recursive: true });
    expect(await worktreeHarness(tree, one)).toBeNull();
    await expect(lstat(join(one.dir, 'cache'))).rejects.toThrow(/ENOENT/);
    expect(shared.keysSeen).toEqual([]);
    /* One that is there but cannot be read is read from the commit, and what goes wrong there is said. */
    const broken = await worktree(f, one, 'f'.repeat(40));
    await writeFile(join(broken.checkout, '.hornhoof/test-environment.json'), 'not a manifest');
    await expect(worktreeHarness(broken, one)).rejects.toThrow();
  });

  it('reads its manifest only as a plain file, never through a link and never waiting on a pipe', async () => {
    const f = await fixture(), one = machine(f, 'one', registry().remote('one'));
    const manifest = (tree: Worktree) => join(tree.checkout, '.hornhoof/test-environment.json');
    /* A manifest elsewhere that would say there is nothing to share, if the link to it were followed. */
    const elsewhere = join(f.root, 'elsewhere.json');
    await writeFile(elsewhere, (await readFile(join(f.source, '.hornhoof/test-environment.json'), 'utf8')).replace('"cache":"link"', '"cache":"none"'));
    const linked = await worktree(f, one, 'f'.repeat(40));
    await rm(manifest(linked)); execFileSync('ln', ['-s', elsewhere, manifest(linked)]);
    await expect(worktreeHarness(linked, one)).rejects.toThrow(/not our ref|fetch/);
    /* A pipe nobody writes into, read by the agents' own user as a node that runs as root does. */
    const piped = await worktree(f, one, 'f'.repeat(40)), helper = agentFs({ uid: process.getuid!(), gid: process.getgid!() });
    await rm(manifest(piped)); execFileSync('mkfifo', [manifest(piped)]);
    try {
      /* It ends, whatever it says; one that waited on the pipe would never end, nor the test with it. */
      await worktreeHarness({ ...piped, fs: helper }, one).catch((error: unknown) => String(error));
    } finally { helper.stop(); }
  });

  it("takes a ready build while a test part holds the machine's turn for heavy work", async () => {
    const f = await fixture(), shared = registry();
    const one = machine(f, 'one', shared.remote('one')), two = machine(f, 'two', shared.remote('two'));
    expect(await worktreeHarness(await worktree(f, one), one)).toMatch(PLACED);
    const turn = heldTurn();
    try {
      /* Another machine downloads it, and this one has it already. */
      expect(await worktreeHarness(await worktree(f, two), { ...two, slot: turn.slot })).toMatch(PLACED);
      expect(await worktreeHarness(await worktree(f, one), { ...one, slot: turn.slot })).toMatch(PLACED);
    } finally { turn.release(); }
    expect(turn.asked.count).toBe(0);
    expect(await installed(f)).toBe(1);
  });

  it("builds them only in the machine's turn for heavy work, and shares them then", async () => {
    const f = await fixture(), shared = registry(), one = machine(f, 'one', shared.remote('one')), turn = heldTurn();
    let placed = false;
    const placing = worktreeHarness(await worktree(f, one), { ...one, slot: turn.slot }).finally(() => { placed = true; });
    /* It waits for the turn it asked for, which the test part holds. */
    await until(() => turn.asked.count === 1);
    expect(placed).toBe(false);
    expect(await installed(f)).toBe(0);
    turn.release();
    expect(await placing).toMatch(PLACED);
    expect(await installed(f)).toBe(1);
    expect([...shared.builds.values()]).toEqual([expect.objectContaining({ bundle: expect.any(Buffer) })]);
  });

  it("lets the machine's turn go when another machine's build is ready by then, and takes it without the turn", async () => {
    const f = await fixture(), shared = registry(), turn = heldTurn(), mine = noted(shared.remote('one'), turn);
    const one = machine(f, 'one', mine.remote), two = machine(f, 'two', shared.remote('two'));
    const placing = worktreeHarness(await worktree(f, one), { ...one, slot: turn.slot });
    await until(() => turn.asked.count === 1);
    expect(await worktreeHarness(await worktree(f, two), two)).toMatch(PLACED);
    turn.release();
    expect(await placing).toMatch(PLACED);
    expect(await installed(f)).toBe(1);
    expect(mine.downloads).toEqual([0]);
  });

  it("lets the machine's turn go when another machine builds them by then, and waits for it without the turn", async () => {
    const f = await fixture(), shared = registry(), turn = heldTurn(), mine = noted(shared.remote('one'), turn);
    const one = machine(f, 'one', mine.remote), two = machine(f, 'two', shared.remote('two'));
    const placing = worktreeHarness(await worktree(f, one), { ...one, slot: turn.slot });
    await until(() => turn.asked.count === 1);
    /* The other machine claims the unit while this one waits for its turn. */
    shared.builds.set(shared.keysSeen[0]!, { builder: 'two' });
    turn.release();
    await until(() => mine.claims.some(claim => claim.state === 'wait'));
    /* It builds them as a harness sync does, holding its claim until the build is up. A worktree there would first give the
       claim back and then take it again in its own turn, and this machine, asking every few milliseconds, may take the
       build in between and build them itself. */
    expect(await syncHarness(asked(f), two)).toMatchObject({ result: { status: 'ready' } });
    expect(await placing).toMatch(PLACED);
    expect(await installed(f)).toBe(1);
    /* In its turn it asked once, was told to wait and gave the turn back. */
    expect(mine.claims.filter(claim => claim.inside > 0).map(claim => claim.state)).toEqual(['wait']);
    expect(turn.grants.count).toBe(1);
    expect(mine.downloads).toEqual([0]);
  });

  it('says why when they cannot be built, and leaves nothing behind', async () => {
    const f = await fixture(manifest => { manifest.dependencies.install = [sh('process.exit(3)')]; }), one = machine(f, 'one', registry().remote('one'));
    const tree = await worktree(f, one);
    await expect(worktreeHarness(tree, one)).rejects.toThrow(/exit 3/);
    await expect(lstat(join(tree.checkout, 'node_modules'))).rejects.toThrow(/ENOENT/);
    expect(await leftOver(one)).toEqual([]);
  });

  it('waits only so long for another machine', async () => {
    const f = await fixture(), shared = registry();
    let claims = 0;
    const busy: HarnessRemote = { ...shared.remote('one'), claim: async () => { claims++; return { state: 'wait', afterMs: 5 }; } };
    /* The machine's runtimes are known already, so nothing on the way to the registry runs on the real clock. */
    const runtimes = (await readTestEnvironment(f.repo, f.repositoryScope, f.head(), { cacheRoot: join(f.root, 'cache'), deadline: Date.now() + NEVER_MS, signal: new AbortController().signal, log: () => {} })).runtimeCapabilities;
    const one = { ...machine(f, 'one', busy), limitMs: 300, runtimes }, tree = await worktree(f, one);
    fakeClock();
    let ended = false;
    const placing = worktreeHarness(tree, one).finally(() => { ended = true; }), refused = expect(placing).rejects.toThrow();
    await until(() => claims > 0);
    await vi.advanceTimersByTimeAsync(299);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await refused;
    expect(await installed(f)).toBe(0);
  });

  it('leaves the dependencies to the agent where the repository shares none', async () => {
    const f = await fixture(manifest => { manifest.dependencies.cache = 'none'; manifest.prepare = []; }), one = machine(f, 'one', registry().remote('one'));
    const tree = await worktree(f, one);
    expect(await worktreeHarness(tree, one)).toBeNull();
    await expect(lstat(join(tree.checkout, 'node_modules'))).rejects.toThrow(/ENOENT/);
    expect(await installed(f)).toBe(0);
  });

  it('stops with the turn it was for', async () => {
    const f = await fixture(), one = machine(f, 'one', registry().remote('one')), stop = new AbortController();
    const tree = await worktree(f, one);
    stop.abort();
    await expect(worktreeHarness(tree, { ...one, signal: stop.signal })).rejects.toThrow();
    expect(await installed(f)).toBe(0);
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
  const context = (dir: string) => ({ cacheRoot: dir, deadline: Date.now() + NEVER_MS, signal: new AbortController().signal, log: () => {} });

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
