import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const shared = vi.hoisted(() => ({ jobUid: 2_000_000_000 + (process.getuid?.() ?? 0) % 1_000_000, builderUid: 2_001_000_000 + (process.getuid?.() ?? 0) % 1_000_000, handedOver: (() => {}) as (path: string) => void }));
import type { TestEnvironmentV1, ServerMessage } from '@hornhoof/protocol';
// Only the unavailable OS identity operations are doubled. Git, files, cache, commands and cleanup are real.
vi.mock('node:child_process', async original => {
  const module = await original<typeof import('node:child_process')>();
  return { ...module, spawn: (bin: string, args: string[], options: import('node:child_process').SpawnOptions) => module.spawn(bin, args, { ...options, uid: undefined, gid: undefined }) };
});
vi.mock('node:fs', async original => {
  const module = await original<typeof import('node:fs')>();
  const jobOwned = <T extends import('node:fs').Stats>(stat: T): T => Object.assign(stat, { uid: stat.uid === process.getuid?.() ? shared.jobUid : stat.uid });
  return { ...module, chownSync: () => {}, fstatSync: (fd: number) => jobOwned(module.fstatSync(fd)) };
});
vi.mock('../src/isolation.js', async original => {
  const module = await original<typeof import('../src/isolation.js')>();
  return { ...module, userFor: () => ({ uid: shared.builderUid, gid: shared.builderUid }), ensurePasswd: () => {}, prepareFolder: (path: string) => { shared.handedOver(path); return module.prepareFolder(path, null); } };
});
import { readTestEnvironment } from '../src/test-environment.js';
import { runTests } from '../src/tests.js';

const roots: string[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-09T12:00:00Z')); });
afterEach(() => vi.useRealTimers());
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const report = (files: object[]) => `require('fs').writeFileSync(process.env.HH_TEST_REPORT, ${JSON.stringify(JSON.stringify({ files }))});`;

async function fixture(script: string, suite: Partial<TestEnvironmentV1['suites'][number]> = {}, hidden: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'hh-product-results-')); roots.push(root);
  const source = join(root, 'source'); await mkdir(join(source, '.hornhoof'), { recursive: true }); await mkdir(join(root, 'proc')); await mkdir(join(source, 'test'));
  const manifest: TestEnvironmentV1 = { version: 1, defaultProfile: 'fast', profiles: [{ id: 'fast', requiredSuiteIds: ['unit'] }], runtimes: [{ id: 'node', version: process.versions.node.split('.')[0]! }],
    dependencies: { adapter: 'none', inputs: [], install: [], paths: [], cache: 'none' }, services: [], prepare: [], reset: null,
    suites: [{ id: 'unit', root: '.', files: ['test/*.js'], run: { program: 'node', args: ['run.js'], cwd: '.' }, split: { kind: 'argv-files' }, profiles: ['fast'], ...suite }],
    impact: { adapter: 'whole-package', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'None.' } }, mutation: { status: 'unsupported', language: 'typescript', reason: 'None.' } };
  await writeFile(join(source, '.hornhoof/test-environment.json'), JSON.stringify(manifest));
  await writeFile(join(source, 'run.js'), script); await writeFile(join(source, 'test/a.js'), ''); await writeFile(join(source, 'test/b.js'), '');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'Fixture');
  const commitSha = git('rev-parse', 'HEAD'), repo = { url: pathToFileURL(source).href, token: '' }, dir = join(root, 'node');
  await mkdir(dir, { recursive: true });
  const repositoryScope = { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: createHash('sha256').update(repo.url).digest('hex') };
  const description = await readTestEnvironment(repo, repositoryScope, commitSha, { cacheRoot: join(dir, 'cache'), deadline: Date.now() + 10_000, signal: new AbortController().signal, log: () => {} });
  const message: Extract<ServerMessage, { type: 'tests.run' }> = { type: 'tests.run', partId: 'part-one', repo, repositoryScope, commitSha, branch: null, task: 1, command: '', part: 1, parts: 1, timeoutMs: 20_000,
    environment: { snapshot: { description, profile: 'fast' }, selection: { kind: 'suite', suiteId: 'unit', files: ['test/a.js', 'test/b.js'] } } };
  const run = (over: Partial<typeof message> = {}) => runTests({ ...message, ...over }, { dir, proc: join(root, 'proc'), user: { uid: shared.jobUid, gid: shared.jobUid }, hidden, prepareRepoBrowser: async () => {} });
  return { run };
}

it('says how each file went when the runner reports it', async () => {
  const f = await fixture(report([{ file: 'test/a.js', status: 'passed', ms: 5 }, { file: 'test/b.js', status: 'failed' }]) + 'process.exit(1);');
  const done = await f.run();
  expect(done).toMatchObject({ ok: false, exitCode: 1 });
  expect(done.files).toEqual([{ suiteId: 'unit', file: 'test/a.js', status: 'passed', ms: 5 }, { suiteId: 'unit', file: 'test/b.js', status: 'failed' }]);
});

/* What an agent reads of a failed part is its last lines, and a service it started may say a lot as it stops. */
it('ends the log of a failed part with the name and error of each test that failed, after whatever a service said', async () => {
  const noise = "for (let i = 0; i < 300; i++) console.log('2026-11-09 14:32:36.195 UTC [191469] LOG:  checkpoint starting: shutdown immediate ' + i);";
  const failures = [{ name: 'services > starts postgres', message: 'AssertionError: expected 1 to be 2\n- Expected\n+ Received' }];
  const f = await fixture(report([{ file: 'test/a.js', status: 'passed' }, { file: 'test/b.js', status: 'failed', failures }]) + noise + 'process.exit(1);');
  const done = await f.run();
  expect(done).toMatchObject({ ok: false, exitCode: 1 });
  const end = done.log.replace(/\s+$/, '').split('\n').slice(-20).join('\n');
  expect(end.split('\n').slice(-2)).toEqual(['Failed tests:', 'test/b.js > services > starts postgres: AssertionError: expected 1 to be 2']);
  expect(end.length).toBeLessThanOrEqual(2000);
  expect(done.files).toEqual([{ suiteId: 'unit', file: 'test/a.js', status: 'passed' }, { suiteId: 'unit', file: 'test/b.js', status: 'failed' }]);
});

it('names at most ten failed tests at the end, each on one short line, and how many more failed', async () => {
  const failures = Array.from({ length: 14 }, (_, index) => ({ name: `case ${index} ${'x'.repeat(400)}`, message: `Error: ${'y'.repeat(400)}` }));
  const done = await (await fixture(report([{ file: 'test/b.js', status: 'failed', failures }]) + 'process.exit(1);')).run();
  const end = done.log.replace(/\s+$/, '').split('\n').slice(-20).join('\n');
  expect(end.match(/^test\/b\.js > case/gm)).toHaveLength(10);
  expect(end).toContain('and 4 more');
  expect(end.length).toBeLessThanOrEqual(2000);
});

it.each(['clipped message', 'clipped name', 'multiline message', 'multiline name'])('hides the complete secret before shortening a %s in the failure summary', async kind => {
  const secret = kind.startsWith('multiline') ? 'private-key-first-line\nprivate-key-second-line' : 'private-token-0123456789abcdefghijklmnop';
  const text = kind.startsWith('multiline') ? secret : 'x'.repeat(110) + secret + ' tail';
  const failures = [{ name: kind.endsWith('name') ? text : 'case', message: kind.endsWith('message') ? text : 'Error: failed' }];
  const f = await fixture(report([{ file: 'test/b.js', status: 'failed', failures }]) + 'process.exit(1);', {}, [secret]);
  const done = await f.run();
  expect(done).toMatchObject({ ok: false, exitCode: 1 });
  expect(done.log).toContain('[hidden]');
  expect(done.log).not.toContain(secret.split('\n')[0]!.slice(0, 12));
  const end = done.log.trimEnd().split('\n').at(-1)!;
  expect(end.length).toBeLessThanOrEqual(150);
});

it('says the same of a run that passed, and nothing when the runner reports nothing', async () => {
  expect((await (await fixture(report([{ file: 'test/a.js', status: 'passed' }]))).run()).files).toEqual([{ suiteId: 'unit', file: 'test/a.js', status: 'passed' }]);
  const silent = await (await fixture('process.exit(0);')).run();
  expect(silent).toMatchObject({ ok: true }); expect(silent.files).toBeUndefined();
});

it('reads no report through a link the job left', async () => {
  const f = await fixture("const f=require('fs');f.writeFileSync('/tmp/hh-product-results-target-'+process.pid,'{\"files\":[{\"file\":\"test/a.js\",\"status\":\"passed\"}]}');f.symlinkSync('/tmp/hh-product-results-target-'+process.pid,process.env.HH_TEST_REPORT);");
  const done = await f.run();
  expect(done.ok).toBe(true); expect(done.files).toBeUndefined();
});

it('gives a suite back what it kept and takes what it leaves', async () => {
  const script = "const f=require('fs');const had=f.existsSync('.metrics/mutate/a.edn')?f.readFileSync('.metrics/mutate/a.edn','utf8'):'none';f.mkdirSync('.metrics/mutate',{recursive:true});f.writeFileSync('.metrics/mutate/a.edn','after '+had);";
  const f = await fixture(script, { keep: ['.metrics/mutate'] });
  const first = await f.run();
  expect(first.kept).toEqual([{ suiteId: 'unit', files: [{ path: '.metrics/mutate/a.edn', text: 'after none' }] }]);
  const second = await f.run({ partId: 'part-two', kept: first.kept });
  expect(second.kept).toEqual([{ suiteId: 'unit', files: [{ path: '.metrics/mutate/a.edn', text: 'after after none' }] }]);
});

/* A folder is handed over once and whole, and a file put in later would stay the node's, where the job cannot read it. */
it('hands a checkout to the job user with what came back into it', async () => {
  const f = await fixture('', { keep: ['.metrics/mutate'] }), there: boolean[] = [];
  shared.handedOver = path => { if (basename(path) === 'repo') there.push(existsSync(join(path, '.metrics/mutate/a.edn'))); };
  await f.run({ kept: [{ suiteId: 'unit', files: [{ path: '.metrics/mutate/a.edn', text: 'kept' }] }] }).finally(() => { shared.handedOver = () => {}; });
  expect(there).toEqual([true]);
});

/* What cannot be read only means less is reused: how the run went stands. */
it('says how the run went when its checkout is gone before the results are read', async () => {
  const done = await (await fixture("require('fs').rmSync(process.cwd(), { recursive: true });", { keep: ['.metrics/mutate'] })).run();
  expect(done).toMatchObject({ ok: true }); expect(done.files).toBeUndefined(); expect(done.kept).toBeUndefined();
});

it('takes nothing from a suite that keeps nothing', async () => {
  const done = await (await fixture("const f=require('fs');f.mkdirSync('.metrics');f.writeFileSync('.metrics/a','left');")).run();
  expect(done.kept).toBeUndefined();
});
