import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NodeMessage, RuntimeCapability, ServerMessage, TestEnvironmentV1 } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
const ids = vi.hoisted(() => ({ jobUid: 2_000_000_000 + (process.getuid?.() ?? 0) % 1_000_000, builderUid: 2_001_000_000 + (process.getuid?.() ?? 0) % 1_000_000 }));
// The real server and the real node code, with real git, files and HTTP. Only the unavailable OS identity operations are doubled.
vi.mock('node:child_process', async original => {
  const module = await original<typeof import('node:child_process')>();
  return { ...module, spawn: (bin: string, args: string[], options: import('node:child_process').SpawnOptions) => module.spawn(bin, args, { ...options, uid: undefined, gid: undefined }) };
});
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), chownSync: () => {} }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), chown: async () => {} }));
vi.mock('../../node/src/isolation.js', async original => {
  const module = await original<{ prepareFolder: (path: string, user: null) => string }>();
  return { ...module, userFor: () => ({ uid: ids.builderUid, gid: ids.builderUid }), ensurePasswd: () => {}, prepareFolder: (path: string) => module.prepareFolder(path, null) };
});
import { departments, harnessBuilds, harnessProducts, jobs, testParts, testRuns } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { hashToken } from '../src/crypto/tokens.js';
import { harnessRound } from '../src/modules/testruns/harness.js';
import { until, type FakeNode } from './helpers.js';
import { company } from './test-runs-company.js';

/* The node's own modules, by a name the server's types do not follow. */
type Done = Extract<NodeMessage, { type: 'tests.done' }>;
type Synced = Extract<NodeMessage, { type: 'tests.harness.done' }>;
type Run = Extract<ServerMessage, { type: 'tests.run' }>;
type Sync = Extract<ServerMessage, { type: 'tests.harness' }>;
type Describe = Extract<ServerMessage, { type: 'tests.describe' }>;
type NodeOptions = { dir: string; proc: string; user: { uid: number; gid: number }; hidden: string[]; prepareRepoBrowser: () => Promise<void>; harness: unknown };
const from = (path: string) => new URL(`../../node/src/${path}`, import.meta.url).href;
const { runTests, syncHarness } = await import(/* @vite-ignore */ from('tests.ts')) as { runTests: (message: Run, options: NodeOptions) => Promise<Done>; syncHarness: (message: Sync, options: NodeOptions) => Promise<Synced> };
type Claim = { state: string; afterMs?: number };
type Remote = { claim: (unit: unknown, signal: AbortSignal) => Promise<Claim> };
const { harnessRemote } = await import(/* @vite-ignore */ from('test-harness.ts')) as { harnessRemote: (server: string, key: string) => Remote };
/* While one machine builds, the server tells the others to wait five seconds and ask again. They still wait and ask again
   here, but for a moment: a build of these few files is done by then, and the seconds were most of these tests' time. */
const askingSoon = (remote: Remote): Remote => ({
  ...remote,
  claim: async (unit, signal) => {
    const answer = await remote.claim(unit, signal);
    return answer.state === 'wait' ? { ...answer, afterMs: 50 } : answer;
  },
});
const { readTestEnvironment, trustedTestRuntimes } = await import(/* @vite-ignore */ from('test-environment.ts')) as {
  readTestEnvironment: (repo: Describe['repo'], scope: Describe['repositoryScope'], sha: string, context: object) => Promise<object>;
  trustedTestRuntimes: (context: object) => Promise<RuntimeCapability[]>;
};

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
afterAll(() => { vi.restoreAllMocks(); });

const sh = (code: string) => ({ program: 'node', args: ['-e', code], cwd: '.' });
/* A time limit of the node's code that never runs out during a test: the largest delay a timer takes. */
const NEVER_MS = 2_147_483_647;
const running = async (root: string) => ({ cacheRoot: join(root, 'scratch'), deadline: Date.now() + NEVER_MS, signal: new AbortController().signal, log: () => {} });
/* What the node said so far is handled: a mark it sends comes back after it, as the server handles a node's messages one
   after another. */
async function handled(node: FakeNode): Promise<void> {
  const jobId = randomUUID();
  node.send({ type: 'job.done', jobId, ok: true, sessionId: 'mark', result: '', tail: '', error: null });
  await until(() => node.acks.includes(jobId));
}
/* What a build does, in a file it appends to: the proof of how many times it ran, whichever machine ran it. */
async function repository(root: string) {
  const source = join(root, 'source'), log = join(root, 'builds');
  await mkdir(join(source, '.hornhoof'), { recursive: true }); await writeFile(log, '');
  const manifest = (install: string): TestEnvironmentV1 => ({
    version: 1, defaultProfile: 'fast', profiles: [{ id: 'fast', requiredSuiteIds: ['unit'] }], runtimes: [{ id: 'node', version: process.versions.node.split('.')[0]! }],
    dependencies: { adapter: 'npm', inputs: ['package-lock.json'], install: [sh(install)], paths: ['node_modules'], cache: 'link' },
    services: [], prepare: [{ id: 'schema', profiles: ['fast'], serviceIds: [], inputs: ['migration.sql'], commands: [sh(`const f=require('fs');f.appendFileSync(${JSON.stringify(log)},'schema\\n');f.mkdirSync('template');f.writeFileSync('template/ready',f.readFileSync('migration.sql'))`)], artifacts: [{ path: 'template', format: 'directory', env: 'HH_TEMPLATE' }] }],
    reset: null, suites: [{ id: 'unit', root: '.', files: ['test.js'], run: sh("const f=require('fs');if(f.readFileSync('node_modules/ready','utf8')!=='dep'||!f.readFileSync(process.env.HH_TEMPLATE+'/ready','utf8'))process.exit(7);console.log('tests started without installing')"), split: { kind: 'whole-package' }, profiles: ['fast'] }],
    impact: { adapter: 'whole-package', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'none' } }, mutation: { status: 'unsupported', language: 'javascript', reason: 'none' },
  });
  const install = `const f=require('fs');f.appendFileSync(${JSON.stringify(log)},'install\\n');f.mkdirSync('node_modules');f.writeFileSync('node_modules/ready','dep')`;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, env: { ...process.env, GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.test', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.test' }, encoding: 'utf8' }).trim();
  const commit = async (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) await writeFile(join(source, path), text);
    git('add', '.'); git('commit', '-qm', 'Next');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  const first = await commit({ '.hornhoof/test-environment.json': JSON.stringify(manifest(install)), 'package-lock.json': '{"lockfileVersion":3}', 'migration.sql': 'one', 'test.js': '' });
  const breaks = (lock: string) => commit({ '.hornhoof/test-environment.json': JSON.stringify(manifest("console.log('this version does not exist');process.exit(3)")), 'package-lock.json': lock });
  const builds = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean);
  const clearBuilds = () => writeFile(log, '');
  return { url: pathToFileURL(source).href, first, commit, breaks, builds, clearBuilds, manifest };
}

async function world() {
  const root = await mkdtemp(join(tmpdir(), 'hh-harness-e2e-')); folders.push(root);
  await mkdir(join(root, 'proc')); await mkdir(join(root, 'scratch'), { mode: 0o700 });
  const c = await company({ HARNESS_DIR: join(root, 'bundles') });
  const repo = await repository(root), runtimes = await trustedTestRuntimes(await running(root));
  await c.db.update(departments).set({ repoUrl: repo.url, repoTokenEnc: null }).where(eq(departments.id, c.dev.id));
  let head = repo.first;
  c.app.ctx.readCommit = async (_repo, want) => ({ branch: 'branch' in want ? want.branch : `task-${want.task}`, commitSha: 'branch' in want && want.branch.startsWith('at-') ? want.branch.slice(3) : head });
  const stops: (() => void)[] = [];
  /* A machine: the real node code behind a connection to the real server, with a folder of its own. */
  const machine = async (token: string, name: string, connect = c.machine) => {
    const joined = await connect(token, name), options: NodeOptions = { dir: join(root, name), proc: join(root, 'proc'), user: { uid: ids.jobUid, gid: ids.jobUid }, hidden: [], prepareRepoBrowser: async () => {}, harness: askingSoon(harnessRemote(new URL(c.url.replace(/^ws/, 'http')).origin, 'key' in joined ? joined.key : '')) };
    const { node } = joined as { node: FakeNode };
    node.send({ type: 'status', loggedIn: true, limits: null, testEnvironmentVersion: 1, testRuntimes: runtimes, testHarness: 1 });
    let stopped = false;
    stops.push(() => { stopped = true; });
    const serve = async () => {
      while (!stopped) {
        const message = await node.next();
        if (message.type === 'tests.harness') node.send(await syncHarness(message, options));
        if (message.type === 'tests.describe') node.send({ type: 'tests.described', requestId: message.requestId, commitSha: message.commitSha, result: { status: 'ready', description: await readTestEnvironment(message.repo, message.repositoryScope, message.commitSha, await running(root)) as never } });
        if (message.type === 'tests.run') { node.send({ type: 'tests.started', partId: message.partId }); node.send(await runTests(message, options)); }
      }
    };
    void serve().catch(() => {});
    await handled(node);
    return { ...joined, options, nodeId: (joined as { nodeId: string }).nodeId };
  };
  const product = async () => (await c.db.select().from(harnessProducts).where(eq(harnessProducts.departmentId, c.dev.id)))[0];
  const reached = (commit: string, count: number) => until(async () => Object.values((await product())?.machines ?? {}).filter(m => m.commitSha === commit && m.at).length >= count);
  const moveHead = (commit: string) => { head = commit; };
  /* A run the way an agent starts it, with the result the server records. */
  const runOn = async (branch: string) => {
    const { call } = await c.turn(c.bruno);
    const started = await call('run_tests', { branch });
    expect(started.error, started.text).toBe(false);
    const [run] = await c.db.select().from(testRuns).orderBy(testRuns.createdAt).then(rows => rows.slice(-1));
    await until(async () => (await c.db.select().from(testRuns).where(eq(testRuns.id, run!.id)))[0]!.status !== 'running');
    const [ended] = await c.db.select().from(testRuns).where(eq(testRuns.id, run!.id)), parts = await c.db.select().from(testParts).where(eq(testParts.runId, run!.id));
    return { status: ended!.status, parts };
  };
  return { ...c, root, repo, machine, product, reached, moveHead, runOn, stop: () => { for (const stop of stops) stop(); } };
}

const unitsOf = async (c: Awaited<ReturnType<typeof world>>) => c.db.select().from(harnessBuilds);
const turnsOf = async (c: Awaited<ReturnType<typeof world>>, agentId: string) => (await c.db.select(only(jobs, 'prompt')).from(jobs).where(eq(jobs.agentId, agentId))).map(job => job.prompt);

describe('one harness for a product, across all its machines', () => {
  it('masks a manual preparation token before its HTTP failure reaches the registry, product and head', async () => {
    const c = await world(), one = await c.machine(c.ceo, 'manual-secret');
    const marker = 'synthetic-private-repository-token-696';
    const commitSha = await c.repo.commit({ '.hornhoof/test-environment.json': JSON.stringify(c.repo.manifest(`console.error('${marker}');process.exit(1)`)) });
    const result = await runTests({ type: 'tests.run', partId: '33333333-3333-4333-8333-333333333333', repo: { url: c.repo.url, token: marker }, repositoryScope: { companyId: c.dev.companyId, repositoryOwnerId: c.dev.id, repoUrlHash: hashToken(c.repo.url) }, commitSha, branch: null, task: 1, command: 'true', part: 1, parts: 1, timeoutMs: NEVER_MS }, one.options);
    const failure = (await unitsOf(c)).find(build => build.status === 'failed')!.error!;
    const problem = (await c.product())!.problem!.detail;
    const prompts = (await turnsOf(c, c.head.id)).join('\n');
    for (const output of [failure, problem, prompts, result.log]) {
      expect(output).not.toContain(marker);
      expect(output).toContain('[hidden]');
    }
    c.stop();
  });

  it('is built once and reaches every machine; a run on any of them starts without installing or building; a change updates only what it touches, once, everywhere', async () => {
    const c = await world(), one = await c.machine(c.ceo, 'one'), two = await c.machine(c.ann, 'two');

    await harnessRound(c.app.ctx);
    await c.reached(c.repo.first, 2);
    expect((await c.repo.builds()).sort()).toEqual(['install', 'schema']);
    expect(await c.product()).toMatchObject({ goodCommit: c.repo.first, problem: null });
    const units = await unitsOf(c);
    expect(units.map(unit => unit.unit).sort()).toEqual(['dependencies', 'schema']);
    for (const unit of units) {
      expect(unit.status).toBe('ready');
      expect(unit.copies.sort()).toEqual([one.nodeId, two.nodeId].sort());
    }

    await c.repo.clearBuilds();
    const run = await c.runOn(`at-${c.repo.first}`);
    expect(run.status).toBe('passed');
    expect(run.parts[0]!.environmentReceipt).toMatchObject({ dependencies: { hit: true }, environments: [{ unitId: 'schema', hit: true }] });
    expect(await c.repo.builds()).toEqual([]);

    const version = (await c.product())!.version;
    const locked = await c.repo.commit({ 'package-lock.json': '{"lockfileVersion":3,"changed":true}' });
    c.moveHead(locked);
    await harnessRound(c.app.ctx);
    await c.reached(locked, 2);
    /* Once each on two machines: what is built with the dependencies comes after them, as it may come out differently. */
    expect((await c.repo.builds()).sort()).toEqual(['install', 'schema']);
    expect(await c.product()).toMatchObject({ goodCommit: locked });
    expect((await c.product())!.version).not.toBe(version);

    await c.repo.clearBuilds();
    const migrated = await c.repo.commit({ 'migration.sql': 'two' });
    c.moveHead(migrated);
    await harnessRound(c.app.ctx);
    await c.reached(migrated, 2);
    expect(await c.repo.builds()).toEqual(['schema']);

    await c.repo.clearBuilds();
    const after = await c.runOn(`at-${migrated}`);
    expect(after.status).toBe('passed');
    expect(after.parts[0]!.environmentReceipt).toMatchObject({ dependencies: { hit: true }, environments: [{ hit: true }] });
    expect(await c.repo.builds()).toEqual([]);
    c.stop();
  }, 120_000);

  it('gives a new machine what is built at its first round, without building', async () => {
    const c = await world();
    await c.machine(c.ceo, 'one');
    await harnessRound(c.app.ctx);
    await c.reached(c.repo.first, 1);
    await c.repo.clearBuilds();
    const late = await c.machine(c.ann, 'late');
    await harnessRound(c.app.ctx);
    await c.reached(c.repo.first, 2);
    expect(await c.repo.builds()).toEqual([]);
    expect((await unitsOf(c)).every(unit => unit.copies.includes(late.nodeId))).toBe(true);
    c.stop();
  }, 60_000);

  it('keeps the last good version when an update fails: the head hears once, only the broken commit stops, and a fixed lock file goes on', async () => {
    const c = await world();
    await c.machine(c.ceo, 'one'); await c.machine(c.ann, 'two');
    await harnessRound(c.app.ctx);
    await c.reached(c.repo.first, 2);

    const broken = await c.repo.breaks('{"lockfileVersion":3,"broken":true}');
    c.moveHead(broken);
    await harnessRound(c.app.ctx);
    await c.reached(broken, 2);
    expect(await c.product()).toMatchObject({ goodCommit: c.repo.first, problem: { code: 'build_failed', commitSha: broken } });
    const told = (await turnsOf(c, c.head.id)).filter(prompt => prompt.includes('this version does not exist'));
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('The last version that worked stays in use');

    const good = await c.runOn(`at-${c.repo.first}`);
    expect(good.status).toBe('passed');
    const bad = await c.runOn(`at-${broken}`);
    expect(bad.status).toBe('failed');
    expect(bad.parts[0]!.tail).toContain('this version does not exist');
    c.stop();
  }, 90_000);

  it('builds the same version again for a machine of another architecture, and hands it only to machines of that architecture', async () => {
    const c = await world();
    await c.machine(c.ceo, 'one');
    await harnessRound(c.app.ctx);
    await c.reached(c.repo.first, 1);
    const version = (await c.product())!.version;
    await c.repo.clearBuilds();

    const arch = Object.getOwnPropertyDescriptor(process, 'arch')!, other = process.arch === 'x64' ? 'arm64' : 'x64';
    Object.defineProperty(process, 'arch', { ...arch, value: other });
    try {
      const runtimes = await trustedTestRuntimes(await running(c.root)), different = await c.machine(c.ann, 'different');
      const { node } = different as unknown as { node: FakeNode };
      node.send({ type: 'status', loggedIn: true, limits: null, testEnvironmentVersion: 1, testRuntimes: runtimes, testHarness: 1 });
      await handled(node);
      await harnessRound(c.app.ctx);
      await c.reached(c.repo.first, 2);
    } finally { Object.defineProperty(process, 'arch', arch); }

    expect((await c.repo.builds()).sort()).toEqual(['install', 'schema']);
    const units = await unitsOf(c);
    expect(units).toHaveLength(4);
    expect(new Set(units.map(unit => unit.version))).toEqual(new Set([units[0]!.version]));
    expect(new Set(units.map(unit => unit.platform)).size).toBe(2);
    expect((await c.product())!.version).toBe(version);
    c.stop();
  }, 60_000);
});

