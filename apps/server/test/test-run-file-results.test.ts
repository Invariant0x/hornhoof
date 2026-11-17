import { PREPARATION_UNIT, hashTestEnvironment, parseTestEnvironment, type NodeMessage, type TestsDescribed } from '@hornhoof/protocol';
import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, departments, jobs, tasks, testFileResults, testParts, testRuns, testSuiteMemory, turns } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { createCoordinationRoute } from '../src/modules/tasks/echelons-store.js';
import { BUILTIN } from './builtin.js';
import { acceptDescription, newEnvironmentRequest, noteTestCapabilities, repositoryScope, testCapabilities } from '../src/modules/testruns/describe.js';
import { keptEverything, keptFor, rememberKept } from '../src/modules/testruns/reuse.js';
import { partDone, pumpTests, runState } from '../src/modules/testruns/runs.js';
import { connectNode, listen, setUpCompany, testApp, TEST_COMMIT, until } from './helpers.js';

const NODE_KEY = 'file-results-node-0123456789abcdef';
const runtimes = [{ id: 'node', version: '22.23.4', fingerprint: 'b'.repeat(64) }, { id: 'hornhoof-test-execution', version: '2.0.0', fingerprint: 'd'.repeat(64) }];
const FILES = ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'];
const print = (name: string) => name.repeat(64).slice(0, 64);
const PRINTS = { 'test/a.test.ts': print('a'), 'test/b.test.ts': print('b'), 'test/c.test.ts': print('c') } as Record<string, string>;
const fingerprints = (over: Record<string, string> = {}) => FILES.map(file => ({ suiteId: 'unit', file, fingerprint: over[file] ?? PRINTS[file]! }));
/* What a runner said of a part where a failed and b and c passed. */
const FAILED_A = [{ suiteId: 'unit', file: 'test/a.test.ts', status: 'failed' as const }, { suiteId: 'unit', file: 'test/b.test.ts', status: 'passed' as const }, { suiteId: 'unit', file: 'test/c.test.ts', status: 'passed' as const }];

const manifest = (preparation = false, full = true) => parseTestEnvironment({
  version: 1, defaultProfile: 'fast', runtimes: [{ id: 'node', version: '22' }],
  profiles: [{ id: 'fast', requiredSuiteIds: ['unit'] }, { id: 'final', requiredSuiteIds: ['unit'] }, { id: 'full', requiredSuiteIds: ['unit'] }],
  dependencies: { adapter: 'none', inputs: [], install: [], paths: [], cache: 'none' }, services: [], prepare: [], reset: null,
  suites: [{ id: 'unit', root: '.', files: ['test/*.test.ts'], profiles: ['fast', 'final', 'full'], run: { program: 'node', args: ['--test'], cwd: '.' }, split: { kind: 'argv-files' }, keep: ['.metrics/mutate'] }],
  impact: { adapter: 'whole-package', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'None.' } },
  mutation: { status: 'unsupported', language: 'typescript', reason: 'None.' },
  execution: { version: 2, ...(full ? { fullRun: { replaces: 'final', profile: 'full' } } : {}), ...(preparation ? { oncePreparation: { profiles: ['fast', 'final', 'full'], suiteIds: ['unit'], commands: [{ program: 'node', args: ['--version'], cwd: '.' }] } } : {}) },
});

async function fixture(turnNumber = 3, preparation = false, full = true) {
  const { app, db } = await testApp({ NODE_KEY, NODE_PING_MS: '2147483647' }), url = await listen(app);
  await setUpCompany(app);
  const [agent] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator')), companyId = agent!.companyId;
  const [department] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://example.test/fixture.git' }).returning();
  await db.update(turns).set({ status: 'closed' }).where(eq(turns.companyId, companyId));
  const [turn] = await db.insert(turns).values({ companyId, departmentId: department!.id, number: turnNumber + 100, goal: 'Fixture', status: 'open' }).returning();
  await db.update(turns).set({ number: turnNumber }).where(eq(turns.id, turn!.id));
  const [task] = await db.insert(tasks).values({ companyId, departmentId: department!.id, number: 1, title: 'Reuse fixture', status: 'working', assigneeAgentId: agent!.id, executorAgentId: agent!.id, turnId: turn!.id }).returning();
  await db.transaction(tx => createCoordinationRoute(tx, task!));
  const [job] = await db.insert(jobs).values({ companyId, subscriptionId: agent!.subscriptionId!, agentId: agent!.id, taskId: task!.id, prompt: 'Fixture', timeoutMs: 10_000, status: 'running' }).returning();
  const node = await connectNode(url, NODE_KEY);
  node.send({ type: 'hello', version: '0.7.0', loggedIn: true, running: [], tests: [], load: { cpus: 8, load: 0.1, memFree: 16 * 1024 ** 3, memTotal: 16 * 1024 ** 3, tests: 0, jobs: 0 }, testEnvironmentVersion: 1, testRuntimes: runtimes });
  await until(() => testCapabilities(app.ctx, BUILTIN).testEnvironmentVersion === 1);
  const scope = repositoryScope(companyId, department!.id, department!.repoUrl!);
  let number = 0;

  /* A run through the real path: requested, described by the node, planned, given out. It is of the turn's branch unless it says. */
  const start = async ({ minutes, ...request }: { suite?: string; minutes?: number }, given?: ReturnType<typeof fingerprints> | null, branch = `turn-${turnNumber}`, described = runtimes) => {
    const prints = given === undefined ? [...fingerprints(), ...(preparation ? [{ ...PREPARATION_UNIT, fingerprint: print('e') }] : [])] : given;
    number += 1;
    const [run] = await db.insert(testRuns).values({ companyId, departmentId: department!.id, taskId: task!.id, agentId: agent!.id, jobId: job!.id, number, branch, command: '', commitSha: TEST_COMMIT, timeoutMs: (minutes ?? 10) * 60_000,
      environmentRequest: newEnvironmentRequest(scope, { mode: 'product', ...request }, minutes) }).returning();
    await pumpTests(app.ctx);
    const [stored] = await db.select().from(testRuns).where(eq(testRuns.id, run!.id));
    const value = manifest(preparation, full), manifestSource = JSON.stringify(value);
    const description = { version: 1 as const, repositoryScope: scope, commitSha: TEST_COMMIT, manifestSource, manifest: value, manifestHash: await hashTestEnvironment(manifestSource), inputDigests: [], inventory: FILES.map(file => ({ suiteId: 'unit', file, selectionUnit: file })), runtimeCapabilities: described };
    const reply: TestsDescribed = { type: 'tests.described', requestId: stored!.environmentRequest!.requestId!, commitSha: TEST_COMMIT, result: { status: 'ready', description, ...(prints ? { fingerprints: prints } : {}) } };
    await acceptDescription(app.ctx, BUILTIN, reply);
    await pumpTests(app.ctx);
    return run!.id;
  };
  const partsOf = (runId: string) => db.select().from(testParts).where(eq(testParts.runId, runId)).orderBy(asc(testParts.part));
  const runOf = async (runId: string) => (await db.select().from(testRuns).where(eq(testRuns.id, runId)))[0]!;
  const ranFiles = async (runId: string) => (await partsOf(runId)).flatMap(part => {
    const selection = part.environmentSelection!.selection;
    return selection.kind === 'batch' ? selection.selections.flatMap(member => member.files) : [];
  }).sort();
  /* The node's end of every open part of a run, also of a part that waited for the node until another ended. */
  const finish = async (runId: string, how: { ok?: boolean; files?: { suiteId: string; file: string; status: 'passed' | 'failed'; note?: string }[]; commit?: string; runtimes?: typeof runtimes } = {}) => {
    const ended = new Set<string>();
    while ((await partsOf(runId)).some(part => part.status === 'running' && !ended.has(part.id))) await finishRunning(runId, how, ended);
  };
  const finishRunning = async (runId: string, how: Parameters<typeof finish>[1] = {}, ended: Set<string>) => {
    const { ok = true, commit = TEST_COMMIT } = how, run = await runOf(runId);
    for (const part of await partsOf(runId)) {
      if (part.status !== 'running' || ended.has(part.id)) continue;
      ended.add(part.id);
      const selection = part.environmentSelection!.selection;
      if (selection.kind !== 'batch' && selection.kind !== 'prepare') throw new Error('This fixture plans versioned parts.');
      const count = selection.kind === 'batch' ? selection.selections.length : run.environmentSnapshot!.description.manifest.execution!.oncePreparation!.commands.length + run.environmentSnapshot!.description.manifest.execution!.oncePreparation!.suiteIds.length;
      const message: Extract<NodeMessage, { type: 'tests.done' }> = { type: 'tests.done', partId: part.id, ok, error: ok ? null : 'failed', exitCode: ok ? 0 : 1, commit, log: 'Fixture result',
        ...(how.files ? { files: how.files } : {}),
        environmentReceipt: { version: 2, profile: run.environmentSnapshot!.profile, selection, commitSha: TEST_COMMIT, manifestHash: run.environmentSnapshot!.description.manifestHash, runtimes: how.runtimes ?? runtimes,
          outcomes: Array.from({ length: count }, (_, index) => ok ? { index, status: 'passed' as const, exitCode: 0 } : { index, status: 'failed' as const, exitCode: 1 }),
          dependencies: { key: null, hit: false }, environments: [], phases: { checkoutMs: 0, dependenciesMs: 0, environmentMs: 0, servicesMs: 0, commandMs: 0, cleanupMs: 0 } } };
      await partDone(app.ctx, BUILTIN, message);
    }
    await pumpTests(app.ctx);
  };
  /* Another slot of the machine takes the parts of a run that wait while a part of an older run still runs, as a second machine would. */
  const runBeside = (runId: string) => db.update(testParts).set({ status: 'running', builtin: true, startedAt: new Date() }).where(and(eq(testParts.runId, runId), eq(testParts.status, 'queued')));
  const greenRows = () => db.select().from(testFileResults).orderBy(asc(testFileResults.file));
  const told = async () => {
    const rows = await db.select(only(jobs, 'prompt')).from(jobs).where(eq(jobs.agentId, agent!.id));
    return rows.map(row => row.prompt).join('\n');
  };
  return { app, db, agent: agent!, job: job!, task: task!, start, finish, runBeside, partsOf, runOf, ranFiles, greenRows, told, companyId };
}

/* What a run asked GitHub to set on a commit, in the order it asked. */
function marked(f: Awaited<ReturnType<typeof fixture>>): { commit: string; state: string }[] {
  const marks: { commit: string; state: string }[] = [];
  f.app.ctx.markCommit = async (_repo, commit, mark) => {
    marks.push({ commit, state: mark.state });
    return { ok: true };
  };
  return marks;
}

describe('reusing green test results', () => {
  /* A release runs every test file once, in its first run; a later run of it runs only what failed or changed. */
  it('runs every test file in the first run of a release, then only what failed or changed', async () => {
    const f = await fixture();
    const first = await f.start({});
    expect(await f.ranFiles(first)).toEqual(FILES);
    const run = await f.runOf(first);
    expect(run.environmentSnapshot!.profile).toBe('full');
    expect(run.fileCache).toMatchObject({ mode: 'full', release: 'turn-3', reused: 0 });
    await f.finish(first, { ok: false, files: [{ suiteId: 'unit', file: 'test/a.test.ts', status: 'failed' }, { suiteId: 'unit', file: 'test/b.test.ts', status: 'passed' }, { suiteId: 'unit', file: 'test/c.test.ts', status: 'passed' }] });
    await until(async () => (await f.told()).includes('Test run 1 failed'));
    expect(await f.told()).toContain('This was the first run of release turn-3: every test file ran, nothing was reused.');
    const second = await f.start({}, fingerprints({ 'test/c.test.ts': print('d') }));
    expect(await f.ranFiles(second)).toEqual(['test/a.test.ts', 'test/c.test.ts']);
    expect((await f.runOf(second)).fileCache).toMatchObject({ mode: 'cached', release: 'turn-3', reused: 1 });
  });

  /* A manifest that names no full run reuses nothing: no run of it leaves a file out, and a later run of a release only takes
     longer. */
  it('runs every test file in each run of a release when the manifest names no full run', async () => {
    const f = await fixture(3, false, false);
    const first = await f.start({});
    expect(await f.ranFiles(first)).toEqual(FILES);
    await f.finish(first);
    await until(async () => (await f.told()).includes('Test run 1 passed'));
    const second = await f.start({});
    expect(await f.ranFiles(second)).toEqual(FILES);
    expect((await f.runOf(second)).fileCache).toBeNull();
  });

  it('runs everything anew in the first run of each release, of another turn as of a release branch', async () => {
    const f = await fixture();
    await f.finish(await f.start({}));
    for (const branch of ['turn-4', 'release-0.3.1']) {
      const id = await f.start({}, undefined, branch);
      expect(await f.ranFiles(id)).toEqual(FILES);
      expect((await f.runOf(id)).fileCache).toMatchObject({ mode: 'full', release: branch, reused: 0 });
      await f.finish(id);
      expect(await f.ranFiles(await f.start({}, undefined, branch))).toEqual([]);
    }
  });

  it('takes on main the release whose branch checked the same commit, and makes a commit no release checked a release of its own', async () => {
    const f = await fixture();
    await f.finish(await f.start({}));
    const merged = await f.start({}, undefined, 'main');
    expect(await f.ranFiles(merged)).toEqual([]);
    expect((await f.runOf(merged)).fileCache).toMatchObject({ mode: 'cached', release: 'turn-3', reused: 3 });
    const g = await fixture();
    const own = await g.start({}, undefined, 'main');
    expect(await g.ranFiles(own)).toEqual(FILES);
    expect((await g.runOf(own)).fileCache).toMatchObject({ mode: 'full', release: TEST_COMMIT });
    await g.finish(own);
    expect((await g.runOf(await g.start({}, undefined, 'main'))).fileCache).toMatchObject({ mode: 'cached', release: TEST_COMMIT, reused: 3 });
  });

  it('takes only what its release proved: a file its full run did not prove runs again, though an older release proved it', async () => {
    const f = await fixture();
    await f.finish(await f.start({}, undefined, 'turn-2'));
    const full = await f.start({});
    await f.finish(full, { ok: false });
    expect(await f.runOf(full)).toMatchObject({ status: 'failed' });
    const next = await f.start({});
    expect((await f.runOf(next)).fileCache).toMatchObject({ mode: 'cached', release: 'turn-3', reused: 0 });
    expect(await f.ranFiles(next)).toEqual(FILES);
  });

  it("counts neither one suite nor a run that has not ended as its release's first run", async () => {
    const f = await fixture();
    const one = await f.start({ suite: 'unit' });
    expect((await f.runOf(one)).fileCache).toMatchObject({ mode: 'cached', release: 'turn-3' });
    await f.finish(one);
    const open = await f.start({}), beside = await f.start({});
    expect((await f.runOf(open)).fileCache).toMatchObject({ mode: 'full' });
    expect((await f.runOf(beside)).fileCache).toMatchObject({ mode: 'full' });
    await f.finish(open);
    expect((await f.runOf(await f.start({}))).fileCache).toMatchObject({ mode: 'cached', reused: 3 });
  });

  it('does not run a file again at the same fingerprint, and the run still ends and tells its agent', async () => {
    const f = await fixture();
    const first = await f.start({});
    expect(await f.ranFiles(first)).toEqual(FILES);
    await f.finish(first);
    expect((await f.greenRows()).map(row => row.file)).toEqual(FILES);
    expect((await f.runOf(first)).fileCache).toMatchObject({ verifiedFingerprints: fingerprints() });
    const shown = await runState(f.app.ctx, { id: f.job.id, companyId: f.companyId, agentId: f.agent.id, agentKind: 'orchestrator' } as never, 1);
    expect(shown).toMatchObject({ reuse: { mode: 'full', release: 'turn-3', fingerprints: 3, kept: 3 } });

    const second = await f.start({});
    expect(await f.ranFiles(second)).toEqual([]);
    const ended = await f.runOf(second);
    expect(ended).toMatchObject({ status: 'passed', parts: 0 });
    expect(ended.fileCache).toMatchObject({ mode: 'cached', release: 'turn-3', reused: 3 });
    expect(await f.partsOf(second)).toEqual([]);
    await until(async () => (await f.told()).includes('Test run 2 passed'));
    expect(await f.told()).toContain('3 test files kept their fingerprint and a green result, so nothing had to run.');
  });

  /* A file has a new fingerprint once what it imports changed: its green result at the old one stands for nothing, so a failure
     there fails the run and the file runs again after. */
  it('runs a file again once its fingerprint changed, and its old green result cannot stand for it', async () => {
    const f = await fixture();
    await f.finish(await f.start({}));
    const changed = fingerprints({ 'test/b.test.ts': print('e') });
    const next = await f.start({}, changed);
    expect(await f.ranFiles(next)).toEqual(['test/b.test.ts']);
    await f.finish(next, { ok: false, files: [{ suiteId: 'unit', file: 'test/b.test.ts', status: 'failed' }] });
    expect(await f.runOf(next)).toMatchObject({ status: 'failed' });
    expect((await f.greenRows()).filter(row => row.file === 'test/b.test.ts').map(row => row.fingerprint)).toEqual([print('b')]);
    expect(await f.ranFiles(await f.start({}, changed))).toEqual(['test/b.test.ts']);
  });

  it('runs only the file whose dependency changed', async () => {
    const f = await fixture();
    const first = await f.start({});
    await f.finish(first);
    const second = await f.start({}, fingerprints({ 'test/b.test.ts': print('d') }));
    expect(await f.ranFiles(second)).toEqual(['test/b.test.ts']);
    expect((await f.runOf(second)).fileCache).toMatchObject({ mode: 'cached', reused: 2 });
    await f.finish(second);
    expect((await f.greenRows()).filter(row => row.file === 'test/b.test.ts').map(row => row.fingerprint).sort()).toEqual([print('b'), print('d')]);
    expect((await f.runOf(second)).status).toBe('passed');
  });

  /* A part that runs into its limit sends the whole release check again, so the first run takes an hour a part and at least two. */
  it('gives each part of the first run of a release an hour when no limit was asked and splits it in two on one machine, and keeps a limit that was asked', async () => {
    const f = await fixture(5);
    const full = await f.start({});
    expect((await f.runOf(full)).timeoutMs).toBe(3_600_000);
    expect((await f.partsOf(full)).filter(part => part.environmentSelection!.selection.kind === 'batch')).toHaveLength(2);
    expect(await f.ranFiles(full)).toEqual(FILES);
    expect((await f.runOf(await f.start({ minutes: 45 }, undefined, 'turn-6'))).timeoutMs).toBe(45 * 60_000);
    await f.finish(full);
    expect((await f.runOf(await f.start({}))).timeoutMs).toBe(600_000);
  });

  it('gives no part to a node of other runtimes than its run was described on, and keeps no green result from a receipt that names others', async () => {
    const f = await fixture();
    const other = runtimes.map(runtime => (runtime.id === 'node' ? { ...runtime, fingerprint: 'c'.repeat(64) } : runtime));
    const elsewhere = await f.start({}, undefined, undefined, other);
    expect((await f.partsOf(elsewhere)).map(part => [part.status, part.nodeId])).toEqual((await f.partsOf(elsewhere)).map(() => ['queued', null]));
    await f.app.ctx.db.update(testRuns).set({ status: 'failed', finishedAt: new Date() }).where(eq(testRuns.id, elsewhere));
    /* The node took a part on the described runtimes, then its Node changed: its receipt names runtimes the description does not. */
    const changed = await f.start({});
    expect(await f.ranFiles(changed)).toEqual(FILES);
    noteTestCapabilities(f.app.ctx, BUILTIN, { testEnvironmentVersion: 1, testRuntimes: other });
    await f.finish(changed, { runtimes: other });
    expect(await f.runOf(changed)).toMatchObject({ status: 'failed' });
    expect((await f.partsOf(changed)).every(part => part.environmentReceipt === null)).toBe(true);
    expect(await f.greenRows()).toEqual([]);
    const shown = await runState(f.app.ctx, { id: f.job.id, companyId: f.companyId, agentId: f.agent.id, agentKind: 'orchestrator' } as never, 2);
    expect(shown).toMatchObject({ reuse: { mode: 'cached', fingerprints: 3, kept: 0 } });
  });

  /* Fingerprints name the class of the runtimes, so machines of another build or processor of that class prove the same files. */
  it('keeps what a part proved on another build and processor of the class its run was described on, and a second run of the commit described there runs no file again', async () => {
    const f = await fixture();
    const on = (arch: string, build: string, os = 'linux') => runtimes.map(runtime => ({ ...runtime, fingerprint: build.repeat(64), platform: { os, arch, libc: 'glibc' } }));
    const x64 = on('x64', '1'), arm64 = on('arm64', '2');
    noteTestCapabilities(f.app.ctx, BUILTIN, { testEnvironmentVersion: 1, testRuntimes: arm64 });
    const first = await f.start({}, undefined, undefined, x64);
    expect(await f.ranFiles(first)).toEqual(FILES);
    await f.finish(first, { runtimes: arm64 });
    expect(await f.runOf(first)).toMatchObject({ status: 'passed' });
    expect((await f.greenRows()).map(row => row.file)).toEqual(FILES);
    const second = await f.start({}, undefined, undefined, arm64);
    expect(await f.ranFiles(second)).toEqual([]);
    expect(await f.runOf(second)).toMatchObject({ status: 'passed', fileCache: { reused: 3 } });
    /* A machine of another system is not of the class: what its receipt names proves nothing here. */
    const darwin = on('arm64', '3', 'darwin');
    await f.db.delete(testFileResults);
    const third = await f.start({}, undefined, undefined, x64);
    expect(await f.ranFiles(third)).toEqual(FILES);
    noteTestCapabilities(f.app.ctx, BUILTIN, { testEnvironmentVersion: 1, testRuntimes: darwin });
    await f.finish(third, { runtimes: darwin });
    expect(await f.runOf(third)).toMatchObject({ status: 'failed' });
    expect(await f.greenRows()).toEqual([]);
  });

  it('takes back a green result when the file then fails at the same fingerprint, as in two runs at once', async () => {
    const f = await fixture();
    const one = await f.start({}), two = await f.start({});
    await f.finish(one);
    await f.finish(two, { ok: false, files: [{ suiteId: 'unit', file: 'test/a.test.ts', status: 'failed' }] });
    expect(await f.ranFiles(await f.start({}))).toEqual(['test/a.test.ts']);
  });

  /* Each release proves its own files: what another release passed at the same fingerprint stands for nothing in this one. */
  it('runs a file its release failed again, though the next release then passed it at the same fingerprint', async () => {
    const f = await fixture();
    await f.finish(await f.start({}), { ok: false, files: FAILED_A });
    /* The next release changed b and c, and passed a as it is. */
    await f.finish(await f.start({}, fingerprints({ 'test/b.test.ts': print('e'), 'test/c.test.ts': print('f') }), 'turn-4'));
    const next = await f.start({});
    expect(await f.ranFiles(next)).toEqual(['test/a.test.ts']);
    expect((await f.runOf(next)).fileCache).toMatchObject({ mode: 'cached', release: 'turn-3', reused: 2 });
  });

  /* Two releases checked at once keep one row of a file at a fingerprint, whichever wrote it last. A file of this release that failed runs
     again whatever the other release left there, and so does one whose row the other release took over: the safe side. */
  it('runs a file its release failed again while another release ran beside it and passed every file at the same fingerprints', async () => {
    const f = await fixture();
    const here = await f.start({}), beside = await f.start({}, undefined, 'turn-4');
    await f.finish(here, { ok: false, files: FAILED_A });
    await f.finish(beside);
    expect((await f.greenRows()).map(row => row.runId)).toEqual([beside, beside, beside]);
    const next = await f.start({});
    expect(await f.ranFiles(next)).toEqual(FILES);
    expect((await f.runOf(next)).fileCache).toMatchObject({ mode: 'cached', release: 'turn-3', reused: 0 });
  });

  /* A part of an older run may answer after a newer run of the release failed its file: the newest run's word on the file stands. */
  it('runs a file again that the newest run of its release failed, though an older run of it passed the file after that', async () => {
    const f = await fixture();
    await f.finish(await f.start({}), { ok: false, files: FAILED_A });
    const older = await f.start({}), newer = await f.start({});
    expect([await f.ranFiles(older), await f.ranFiles(newer)]).toEqual([['test/a.test.ts'], ['test/a.test.ts']]);
    await f.runBeside(newer);
    await f.finish(newer, { ok: false, files: [{ suiteId: 'unit', file: 'test/a.test.ts', status: 'failed' }] });
    await f.finish(older);
    expect(await f.ranFiles(await f.start({}))).toEqual(['test/a.test.ts']);
  });

  it('keeps the green result of a newer run of its release when an older run passes the file after it', async () => {
    const f = await fixture();
    await f.finish(await f.start({}), { ok: false, files: FAILED_A });
    const older = await f.start({}), failing = await f.start({});
    await f.runBeside(failing);
    await f.finish(failing, { ok: false, files: [{ suiteId: 'unit', file: 'test/a.test.ts', status: 'failed' }] });
    const passing = await f.start({});
    await f.runBeside(passing);
    await f.finish(passing);
    await f.finish(older);
    expect((await f.greenRows()).find(row => row.file === 'test/a.test.ts')?.runId).toBe(passing);
    expect(await f.ranFiles(await f.start({}))).toEqual([]);
  });

  /* A run that was stopped, or whose preparation failed, checked its release only in part: what it passed closes no file that failed. */
  it.each(['was stopped', 'failed in its preparation'] as const)('runs a failed file again that a run of its release passed, when that run then %s', async end => {
    const f = await fixture();
    await f.finish(await f.start({}), { ok: false, files: FAILED_A });
    const cut = await f.start({});
    await f.finish(cut);
    expect((await f.greenRows()).find(row => row.file === 'test/a.test.ts')?.runId).toBe(cut);
    /* As the run stands when it was stopped, or its preparation failed, after this part passed. */
    if (end === 'was stopped') await f.db.update(testRuns).set({ status: 'stopped' }).where(eq(testRuns.id, cut));
    else {
      await f.db.insert(testParts).values({ companyId: f.companyId, runId: cut, part: 2, status: 'failed', environmentSelection: { selection: { kind: 'prepare', version: 2, expectedCommitSha: TEST_COMMIT }, after: [] } });
      await f.db.update(testRuns).set({ status: 'failed', parts: 2 }).where(eq(testRuns.id, cut));
    }
    expect(await f.ranFiles(await f.start({}))).toEqual(['test/a.test.ts']);
  });

  it('keeps no result of a file that failed and keeps those that passed beside it', async () => {
    const f = await fixture();
    const first = await f.start({});
    await f.finish(first, { ok: false, files: [{ suiteId: 'unit', file: 'test/a.test.ts', status: 'failed' }, { suiteId: 'unit', file: 'test/b.test.ts', status: 'passed' }, { suiteId: 'unit', file: 'test/c.test.ts', status: 'passed' }] });
    expect((await f.greenRows()).map(row => row.file)).toEqual(['test/b.test.ts', 'test/c.test.ts']);
    await until(async () => (await f.told()).includes('Test run 1 failed'));
    expect(await f.told()).toContain('Failed test files: test/a.test.ts.');
    expect(await f.ranFiles(await f.start({}))).toEqual(['test/a.test.ts']);
  });

  it('keeps nothing of a part that failed without saying which file, or that checked another commit', async () => {
    const f = await fixture();
    await f.finish(await f.start({}), { ok: false });
    expect(await f.greenRows()).toEqual([]);
    await f.finish(await f.start({}), { commit: 'f'.repeat(40) });
    expect(await f.greenRows()).toEqual([]);
    await f.finish(await f.start({}), { ok: false, commit: 'f'.repeat(40), files: [{ suiteId: 'unit', file: 'test/a.test.ts', status: 'passed' }] });
    expect(await f.greenRows()).toEqual([]);
  });

  it('shows a mismatch when a file green at its fingerprint fails in the full run, and stops trusting that result', async () => {
    const f = await fixture(5);
    await f.finish(await f.start({}, undefined, 'turn-4'));
    const full = await f.start({});
    await f.finish(full, { ok: false, files: [{ suiteId: 'unit', file: 'test/a.test.ts', status: 'failed' }, { suiteId: 'unit', file: 'test/b.test.ts', status: 'passed' }, { suiteId: 'unit', file: 'test/c.test.ts', status: 'passed' }] });
    const run = await f.runOf(full);
    expect(run.fileCache!.mismatches).toEqual([{ suiteId: 'unit', file: 'test/a.test.ts' }]);
    await until(async () => (await f.told()).includes('Test run 2 failed'));
    expect(await f.told()).toContain('Mismatch with the kept results: test/a.test.ts was green at this same fingerprint and failed now.');
    expect((await f.greenRows()).map(row => row.file)).toEqual(['test/b.test.ts', 'test/c.test.ts']);
    const shown = await runState(f.app.ctx, { id: f.job.id, companyId: f.companyId, agentId: f.agent.id, agentKind: 'orchestrator' } as never, 2);
    expect(shown).toMatchObject({ reuse: { mode: 'full', release: 'turn-5', mismatches: ['test/a.test.ts'], failedFiles: ['test/a.test.ts'] } });
    expect(await f.ranFiles(await f.start({}))).toEqual(['test/a.test.ts']);
  });

  it('runs everything for a node that sends no fingerprints and keeps nothing', async () => {
    const none = await fixture();
    const run = await none.start({}, null);
    expect(await none.ranFiles(run)).toEqual(FILES);
    await none.finish(run);
    expect(await none.greenRows()).toEqual([]);
    const next = await none.start({}, null);
    expect(await none.ranFiles(next)).toEqual(FILES);
    expect((await none.runOf(next)).fileCache).toMatchObject({ mode: 'off', reused: 0 });
    await none.finish(next);
    await until(async () => (await none.told()).includes('Test run 2 passed'));
    expect(await none.told()).toContain('Nothing was reused: the machine that described this commit sent no fingerprints.');
  });

  it('shows what a result came to, when the file runs and when it does not run again', async () => {
    const f = await fixture(), note = '2 killed, 7 survived, 0 uncovered of 9 sites', line = `Notes on test files: test/a.test.ts: ${note}.`;
    const first = await f.start({});
    await f.finish(first, { files: [{ suiteId: 'unit', file: 'test/a.test.ts', status: 'passed', note }] });
    await until(async () => (await f.told()).includes('Test run 1 passed'));
    expect((await f.told()).split(line)).toHaveLength(2);
    const second = await f.start({});
    expect(await f.ranFiles(second)).toEqual([]);
    await until(async () => (await f.told()).includes('Test run 2 passed'));
    expect((await f.told()).split(line)).toHaveLength(3);
    const shown = await runState(f.app.ctx, { id: f.job.id, companyId: f.companyId, agentId: f.agent.id, agentKind: 'orchestrator' } as never, 2);
    expect(shown).toMatchObject({ reuse: { notes: [{ file: 'test/a.test.ts', note }] } });
  });

  it('forgets what a result came to once a passing run says nothing of the file', async () => {
    const f = await fixture();
    await f.finish(await f.start({}), { files: [{ suiteId: 'unit', file: 'test/a.test.ts', status: 'passed', note: 'old' }] });
    await f.finish(await f.start({}, undefined, 'turn-4'));
    expect((await f.greenRows()).map(row => row.note)).toEqual([null, null, null]);
  });

  it('keeps what each part of a run left, by file, whichever part ended last', async () => {
    const f = await fixture(), run = await f.runOf(await f.start({}));
    const remember = (...files: { path: string; text: string }[]) => rememberKept(f.app.ctx, run, { commit: TEST_COMMIT, kept: [{ suiteId: 'unit', files }] });
    const memory = async () => (await f.db.select().from(testSuiteMemory))[0]!.files.map(file => `${file.path}=${file.text.slice(0, 3)}`).sort();
    await remember({ path: '.metrics/mutate/a.edn', text: 'one' });
    await remember({ path: '.metrics/mutate/b.edn', text: 'two' });
    expect(await memory()).toEqual(['.metrics/mutate/a.edn=one', '.metrics/mutate/b.edn=two']);
    await remember({ path: '.metrics/mutate/a.edn', text: 'new' });
    expect(await memory()).toEqual(['.metrics/mutate/a.edn=new', '.metrics/mutate/b.edn=two']);
  });

  it('starts over from the last part when all that was kept no longer fits one message', async () => {
    const f = await fixture();
    await f.finish(await f.start({}));
    const run = await f.runOf(await f.start({}, fingerprints({ 'test/a.test.ts': print('d') })));
    const remember = (path: string, text: string) => rememberKept(f.app.ctx, run, { commit: TEST_COMMIT, kept: [{ suiteId: 'unit', files: [{ path, text }] }] });
    await remember('.metrics/mutate/a.edn', 'a'.repeat(600 * 1024));
    await remember('.metrics/mutate/b.edn', 'b'.repeat(600 * 1024));
    const [part] = await f.partsOf(run.id);
    expect((await keptFor(f.app.ctx, run, part!))?.[0]?.files.map(file => file.path)).toEqual(['.metrics/mutate/b.edn']);
  });

  it('marks the pinned commit on GitHub once a run of the whole product passed, also when every file kept its green result', async () => {
    const f = await fixture(), marks = marked(f);
    await f.finish(await f.start({}));
    expect(marks).toEqual([{ commit: TEST_COMMIT, state: 'success' }]);
    const reused = await f.start({});
    expect(await f.runOf(reused)).toMatchObject({ status: 'passed', parts: 0 });
    expect(marks).toEqual([{ commit: TEST_COMMIT, state: 'success' }, { commit: TEST_COMMIT, state: 'success' }]);
  });

  it('marks failure when a run of the whole product failed', async () => {
    const f = await fixture(), marks = marked(f);
    await f.finish(await f.start({}), { ok: false });
    expect(marks).toEqual([{ commit: TEST_COMMIT, state: 'failure' }]);
  });

  it('leaves no mark for one suite: it does not stand for the whole product', async () => {
    const f = await fixture(), marks = marked(f);
    await f.finish(await f.start({ suite: 'unit' }));
    expect(marks).toEqual([]);
  });

  /* The check of a release: whatever is green at these fingerprints, its first run runs every file again, and its end marks the commit. */
  it('runs every file in the first run of a release branch, though each is green at its fingerprint, and marks its commit', async () => {
    const f = await fixture();
    await f.finish(await f.start({}, undefined, 'main'));
    expect((await f.greenRows()).map(row => row.file)).toEqual(FILES);
    const marks = marked(f), id = await f.start({}, undefined, 'release-1.2.3');
    expect((await f.runOf(id)).fileCache).toMatchObject({ mode: 'full', release: 'release-1.2.3', reused: 0 });
    expect(await f.ranFiles(id)).toEqual(FILES);
    await f.finish(id);
    expect(marks).toEqual([{ commit: TEST_COMMIT, state: 'success' }]);
  });

  it('tells the agent of a run that stands for no whole product that it leaves no mark', async () => {
    const f = await fixture();
    marked(f);
    await f.finish(await f.start({ suite: 'unit' }, undefined, 'release-1.2.3'));
    await until(async () => (await f.told()).includes('Test run 1 passed'));
    expect(await f.told()).toContain('It leaves no hornhoof/tests on its commit: only a run of the whole product, with no one suite, does.');
  });

  it('tells the agent on the task that GitHub now shows the mark', async () => {
    const f = await fixture();
    marked(f);
    await f.finish(await f.start({}));
    await until(async () => (await f.told()).includes('Test run 1 passed'));
    expect(await f.told()).toContain(`GitHub now shows hornhoof/tests = success on ${TEST_COMMIT}.`);
  });

  it('does not reuse the green result of another repository', async () => {
    const f = await fixture();
    await f.finish(await f.start({}));
    await f.db.update(testFileResults).set({ repoUrlHash: 'e'.repeat(64) });
    expect(await f.ranFiles(await f.start({}))).toEqual(FILES);
  });
});

describe('a run with nothing left to run', () => {
  it.each([false, true])('ends passed with no part and still checks its release, preparation=%s', async preparation => {
    const f = await fixture(3, preparation);
    await f.finish(await f.start({}));
    const ended = await f.runOf(await f.start({}));
    expect(ended).toMatchObject({ status: 'passed', parts: 0, fileCache: { mode: 'cached', reused: 3, preparationReused: preparation, fingerprints: [] } });
    expect(keptEverything(ended)).toBe(true);
  });
});
