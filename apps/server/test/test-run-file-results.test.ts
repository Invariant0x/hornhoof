import { PREPARATION_UNIT, hashTestEnvironment, parseTestEnvironment, type NodeMessage, type TestsDescribed } from '@hornhoof/protocol';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, departments, jobs, tasks, testFileResults, testParts, testRuns, testSuiteMemory, turns } from '../src/db/schema.js';
import { createRoute } from '../src/modules/tasks/echelons-store.js';
import { verifiedReuse } from '../src/modules/tasks/review-reuse.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { acceptDescription, newEnvironmentRequest, repositoryScope, testCapabilities } from '../src/modules/testruns/describe.js';
import { keptFor, rememberKept } from '../src/modules/testruns/reuse.js';
import { reusableUnits } from '../src/modules/testruns/reuse-evidence.js';
import { partDone, pumpTests, runState } from '../src/modules/testruns/runs.js';
import { connectNode, listen, setUpCompany, testApp, TEST_COMMIT, until } from './helpers.js';

const NODE_KEY = 'file-results-node-0123456789abcdef';
const runtimes = [{ id: 'node', version: '22.23.4', fingerprint: 'b'.repeat(64) }, { id: 'hornhoof-test-execution', version: '2.0.0', fingerprint: 'd'.repeat(64) }];
const FILES = ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'];
const print = (name: string) => name.repeat(64).slice(0, 64);
const PRINTS = { 'test/a.test.ts': print('a'), 'test/b.test.ts': print('b'), 'test/c.test.ts': print('c') } as Record<string, string>;
const fingerprints = (over: Record<string, string> = {}) => FILES.map(file => ({ suiteId: 'unit', file, fingerprint: over[file] ?? PRINTS[file]! }));

const manifest = (everyTurns = 5, preparation = false) => parseTestEnvironment({
  version: 1, defaultProfile: 'fast', runtimes: [{ id: 'node', version: '22' }],
  profiles: [{ id: 'fast', requiredSuiteIds: ['unit'] }, { id: 'final', requiredSuiteIds: ['unit'] }, { id: 'full', requiredSuiteIds: ['unit'] }],
  dependencies: { adapter: 'none', inputs: [], install: [], paths: [], cache: 'none' }, services: [], prepare: [], reset: null,
  suites: [{ id: 'unit', root: '.', files: ['test/*.test.ts'], profiles: ['fast', 'final', 'full'], run: { program: 'node', args: ['--test'], cwd: '.' }, split: { kind: 'argv-files' }, keep: ['.metrics/mutate'] }],
  impact: { adapter: 'whole-package', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'None.' } },
  mutation: { status: 'unsupported', language: 'typescript', reason: 'None.' },
  execution: { version: 2, fullRun: { everyTurns, replaces: 'final', profile: 'full' }, ...(preparation ? { oncePreparation: { profiles: ['fast', 'final', 'full'], suiteIds: ['unit'], commands: [{ program: 'node', args: ['--version'], cwd: '.' }] } } : {}) },
});

async function fixture(turnNumber = 3, everyTurns = 5, preparation = false) {
  const { app, db } = await testApp({ NODE_KEY, NODE_PING_MS: '50' }), url = await listen(app);
  await setUpCompany(app);
  const [agent] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator')), companyId = agent!.companyId;
  const [department] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://example.test/fixture.git' }).returning();
  await db.update(turns).set({ status: 'closed' }).where(eq(turns.companyId, companyId));
  const [turn] = await db.insert(turns).values({ companyId, number: turnNumber + 100, goal: 'Fixture', status: 'open' }).returning();
  await db.update(turns).set({ number: turnNumber }).where(eq(turns.id, turn!.id));
  const [task] = await db.insert(tasks).values({ companyId, departmentId: department!.id, number: 1, title: 'Reuse fixture', status: 'working', assigneeAgentId: agent!.id, executorAgentId: agent!.id, turnId: turn!.id }).returning();
  await db.transaction(tx => createRoute(tx, task!, { resultKind: 'coordination' }));
  const [job] = await db.insert(jobs).values({ companyId, subscriptionId: agent!.subscriptionId!, agentId: agent!.id, taskId: task!.id, prompt: 'Fixture', timeoutMs: 10_000, status: 'running' }).returning();
  const node = await connectNode(url, NODE_KEY);
  node.send({ type: 'hello', version: '0.7.0', loggedIn: true, running: [], tests: [], load: { cpus: 8, load: 0.1, memFree: 16 * 1024 ** 3, memTotal: 16 * 1024 ** 3, tests: 0, jobs: 0 }, testEnvironmentVersion: 1, testRuntimes: runtimes });
  await until(() => testCapabilities(app.ctx, BUILTIN).testEnvironmentVersion === 1);
  const scope = repositoryScope(companyId, department!.id, department!.repoUrl!);
  let number = 0;

  /* A run through the real path: requested, described by the node, planned, given out. It is of the turn's branch unless it says. */
  const start = async (request: { profile?: string; suite?: string }, given?: ReturnType<typeof fingerprints> | null, branch = `turn-${turnNumber}`, described = runtimes) => {
    const prints = given === undefined ? [...fingerprints(), ...(preparation ? [{ ...PREPARATION_UNIT, fingerprint: print('e') }] : [])] : given;
    number += 1;
    const [run] = await db.insert(testRuns).values({ companyId, departmentId: department!.id, taskId: task!.id, agentId: agent!.id, jobId: job!.id, number, branch, command: '', commitSha: TEST_COMMIT, timeoutMs: 600_000,
      environmentRequest: newEnvironmentRequest(scope, { mode: 'product', ...request }) }).returning();
    await pumpTests(app.ctx);
    const [stored] = await db.select().from(testRuns).where(eq(testRuns.id, run!.id));
    const value = manifest(everyTurns, preparation), manifestSource = JSON.stringify(value);
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
  /* The node's end of every open part of a run. */
  const finish = async (runId: string, how: { ok?: boolean; files?: { suiteId: string; file: string; status: 'passed' | 'failed'; note?: string }[]; commit?: string } = {}) => {
    const { ok = true, commit = TEST_COMMIT } = how, run = await runOf(runId);
    for (const part of await partsOf(runId)) {
      if (part.status !== 'running') continue;
      const selection = part.environmentSelection!.selection;
      if (selection.kind !== 'batch' && selection.kind !== 'prepare') throw new Error('This fixture plans versioned parts.');
      const count = selection.kind === 'batch' ? selection.selections.length : run.environmentSnapshot!.description.manifest.execution!.oncePreparation!.commands.length + run.environmentSnapshot!.description.manifest.execution!.oncePreparation!.suiteIds.length;
      const message: Extract<NodeMessage, { type: 'tests.done' }> = { type: 'tests.done', partId: part.id, ok, error: ok ? null : 'failed', exitCode: ok ? 0 : 1, commit, log: 'Fixture result',
        ...(how.files ? { files: how.files } : {}),
        environmentReceipt: { version: 2, profile: run.environmentSnapshot!.profile, selection, commitSha: TEST_COMMIT, manifestHash: run.environmentSnapshot!.description.manifestHash, runtimes,
          outcomes: Array.from({ length: count }, (_, index) => ok ? { index, status: 'passed' as const, exitCode: 0 } : { index, status: 'failed' as const, exitCode: 1 }),
          dependencies: { key: null, hit: false }, environments: [], phases: { checkoutMs: 0, dependenciesMs: 0, environmentMs: 0, servicesMs: 0, commandMs: 0, cleanupMs: 0 } } };
      await partDone(app.ctx, BUILTIN, message);
    }
    await pumpTests(app.ctx);
  };
  const greenRows = () => db.select().from(testFileResults).orderBy(asc(testFileResults.file));
  const told = async () => {
    const rows = await db.select({ prompt: jobs.prompt }).from(jobs).where(eq(jobs.agentId, agent!.id));
    return rows.map(row => row.prompt).join('\n');
  };
  return { app, db, agent: agent!, job: job!, task: task!, start, finish, partsOf, runOf, ranFiles, greenRows, told, companyId };
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
  it('revalidates files executed in shared preparation and refuses a source that lost its assigned selection', async () => {
    const f = await fixture(3, 5, true);
    const id = await f.start({ profile: 'final' });
    await f.finish(id);
    const source = await f.runOf(id), scope = source.environmentSnapshot!.description.repositoryScope;
    const units = fingerprints().map(unit => ({ ...unit, runId: id, commitSha: TEST_COMMIT }));
    const preparation = (await f.partsOf(id)).find(part => part.environmentSelection?.selection.kind === 'prepare');
    expect(preparation).toBeDefined();
    expect(await reusableUnits(f.db, scope, units)).toEqual(units);
    await f.db.update(testParts).set({ environmentSelection: null }).where(eq(testParts.id, preparation!.id));
    expect(await reusableUnits(f.db, scope, units)).toEqual([]);
  });

  it('does not run a file again at the same fingerprint, and the run still ends and tells its agent', async () => {
    const f = await fixture();
    const first = await f.start({ profile: 'final' });
    expect(await f.ranFiles(first)).toEqual(FILES);
    await f.finish(first);
    expect((await f.greenRows()).map(row => row.file)).toEqual(FILES);
    expect((await f.runOf(first)).fileCache).toMatchObject({ verifiedFingerprints: fingerprints() });
    const shown = await runState(f.app.ctx, { id: f.job.id, companyId: f.companyId, agentId: f.agent.id, agentKind: 'orchestrator' } as never, 1);
    expect(shown).toMatchObject({ reuse: { mode: 'cached', fingerprints: 3, kept: 3 } });

    const second = await f.start({ profile: 'final' });
    expect(await f.ranFiles(second)).toEqual([]);
    const ended = await f.runOf(second);
    expect(ended).toMatchObject({ status: 'passed', parts: 0 });
    expect(ended.fileCache).toMatchObject({ mode: 'cached', turn: 3, reused: 3 });
    expect(await f.partsOf(second)).toEqual([]);
    await until(async () => (await f.told()).includes('Test run 2 passed'));
    expect(await f.told()).toContain('3 test files kept their fingerprint and a green result, so nothing had to run.');
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

  it('runs everything on the fifth turn, whatever is green, then goes back to reusing', async () => {
    const f = await fixture(5);
    const before = await f.start({ profile: 'fast' });
    await f.finish(before);
    const full = await f.start({ profile: 'final' });
    expect(await f.ranFiles(full)).toEqual(FILES);
    const run = await f.runOf(full);
    expect(run.environmentSnapshot!.profile).toBe('full');
    expect(run.fileCache).toMatchObject({ mode: 'full', turn: 5, reused: 0 });
    await f.finish(full);
    await until(async () => (await f.told()).includes('Test run 2 passed'));
    expect(await f.told()).toContain('This was the full run of turn 5: nothing was reused.');
    const next = await f.start({ profile: 'final' });
    expect(await f.ranFiles(next)).toEqual([]);
    expect((await f.runOf(next)).fileCache).toMatchObject({ mode: 'cached', turn: 5, reused: 3 });
  });

  it('counts a task without a turn by the turn open now, and runs no full run with none open', async () => {
    const f = await fixture(5);
    await f.db.update(tasks).set({ turnId: null }).where(eq(tasks.id, f.task.id));
    await f.finish(await f.start({ profile: 'fast' }));
    const full = await f.start({ profile: 'final' });
    expect((await f.runOf(full)).fileCache).toMatchObject({ mode: 'full', turn: 5 });
    await f.finish(full);
    await f.db.update(turns).set({ status: 'closed' }).where(eq(turns.companyId, f.companyId));
    expect((await f.runOf(await f.start({ profile: 'final' }))).fileCache).toMatchObject({ mode: 'cached', turn: null });
  });

  it('does not take one suite under the full profile for the full run of its turn', async () => {
    const f = await fixture(5);
    const one = await f.start({ profile: 'full', suite: 'unit' });
    expect((await f.runOf(one)).fileCache).toMatchObject({ mode: 'cached', turn: 5 });
    await f.finish(one);
    const full = await f.start({ profile: 'final' });
    expect(await f.ranFiles(full)).toEqual(FILES);
    expect((await f.runOf(full)).fileCache).toMatchObject({ mode: 'full', turn: 5 });
  });

  it('runs everything again after a full run with a part that said nothing of its files, not after one that named what failed', async () => {
    const f = await fixture(5);
    await f.finish(await f.start({ profile: 'fast' }));
    await f.finish(await f.start({ profile: 'final' }), { ok: false });
    const again = await f.start({ profile: 'final' });
    expect(await f.ranFiles(again)).toEqual(FILES);
    expect((await f.runOf(again)).fileCache).toMatchObject({ mode: 'full', turn: 5 });
    await f.finish(again, { ok: false, files: [{ suiteId: 'unit', file: 'test/a.test.ts', status: 'failed' }, { suiteId: 'unit', file: 'test/b.test.ts', status: 'passed' }, { suiteId: 'unit', file: 'test/c.test.ts', status: 'passed' }] });
    const next = await f.start({ profile: 'final' });
    expect((await f.runOf(next)).fileCache).toMatchObject({ mode: 'cached', turn: 5 });
    expect(await f.ranFiles(next)).toEqual(['test/a.test.ts']);
  });

  /* The fingerprints name the runtimes of the machine that described the run. A part that ran on a machine of other runtimes
     proves its files there, not at those fingerprints. */
  it('keeps no green result of a part that ran on a machine of other runtimes than the run was described on', async () => {
    const f = await fixture();
    const other = runtimes.map(runtime => (runtime.id === 'node' ? { ...runtime, fingerprint: 'c'.repeat(64) } : runtime));
    const first = await f.start({ profile: 'final' }, undefined, undefined, other);
    expect(await f.ranFiles(first)).toEqual(FILES);
    await f.finish(first);
    expect(await f.runOf(first)).toMatchObject({ status: 'passed' });
    expect(await f.greenRows()).toEqual([]);
    const shown = await runState(f.app.ctx, { id: f.job.id, companyId: f.companyId, agentId: f.agent.id, agentKind: 'orchestrator' } as never, 1);
    expect(shown).toMatchObject({ reuse: { mode: 'cached', fingerprints: 3, kept: 0 } });
  });

  it('takes back a green result when the file then fails at the same fingerprint, as in two runs at once', async () => {
    const f = await fixture();
    const one = await f.start({}), two = await f.start({});
    await f.finish(one);
    await f.finish(two, { ok: false, files: [{ suiteId: 'unit', file: 'test/a.test.ts', status: 'failed' }] });
    expect(await f.ranFiles(await f.start({}))).toEqual(['test/a.test.ts']);
  });

  describe('what a release relies on', () => {
    const TASK_BRANCH = 'task-1';

    it('takes no result of a task branch: its job wrote its own report', async () => {
      const f = await fixture();
      await f.finish(await f.start({ profile: 'final' }, undefined, TASK_BRANCH));
      expect(await f.ranFiles(await f.start({ profile: 'final' }))).toEqual(FILES);
    });

    it('takes the results of the main branch and of the turn, and a task branch takes them too', async () => {
      const f = await fixture();
      await f.finish(await f.start({ profile: 'final' }, undefined, 'main'));
      expect(await f.ranFiles(await f.start({ profile: 'final' }))).toEqual([]);
      expect(await f.ranFiles(await f.start({ profile: 'final' }, undefined, TASK_BRANCH))).toEqual([]);
      expect(await f.ranFiles(await f.start({ profile: 'fast' }, undefined, TASK_BRANCH))).toEqual([]);
    });

    it('leaves other work free to reuse what a task branch proved', async () => {
      const f = await fixture();
      await f.finish(await f.start({ profile: 'fast' }, undefined, TASK_BRANCH));
      expect(await f.ranFiles(await f.start({ profile: 'fast' }, undefined, 'task-2'))).toEqual([]);
    });

    it('does not let a task branch change what the turn proved', async () => {
      const f = await fixture();
      await f.finish(await f.start({ profile: 'final' }));
      await f.db.update(testFileResults).set({ note: 'from the turn' });
      await f.finish(await f.start({ profile: 'full' }, undefined, TASK_BRANCH), { files: FILES.map(file => ({ suiteId: 'unit', file, status: 'passed' as const, note: 'from a task branch' })) });
      expect((await f.greenRows()).map(row => row.note)).toEqual(['from the turn', 'from the turn', 'from the turn']);
    });

    it('runs the full run on the turn\'s branch alone, and a run of a task branch does not stand in for it', async () => {
      const f = await fixture(5);
      const onTask = await f.start({ profile: 'final' }, undefined, TASK_BRANCH);
      expect((await f.runOf(onTask)).fileCache).toMatchObject({ mode: 'cached', turn: 5 });
      await f.finish(onTask);
      const named = await f.start({ profile: 'full' }, undefined, TASK_BRANCH);
      expect((await f.runOf(named)).fileCache).toMatchObject({ mode: 'full', turn: 5 });
      await f.finish(named);
      const full = await f.start({ profile: 'final' });
      expect((await f.runOf(full)).fileCache).toMatchObject({ mode: 'full', turn: 5 });
      expect(await f.ranFiles(full)).toEqual(FILES);
    });

    it('keeps what a suite left only from its own line', async () => {
      const f = await fixture();
      const kept = [{ suiteId: 'unit', files: [{ path: '.metrics/mutate/a.edn', text: '{}' }] }];
      const onTask = await f.runOf(await f.start({ profile: 'final' }, undefined, TASK_BRANCH));
      await rememberKept(f.app.ctx, onTask, { commit: TEST_COMMIT, kept });
      expect(await f.db.select().from(testSuiteMemory)).toEqual([]);
      const onTurn = await f.runOf(await f.start({ profile: 'final' }));
      await rememberKept(f.app.ctx, onTurn, { commit: TEST_COMMIT, kept });
      expect((await f.db.select().from(testSuiteMemory)).map(row => row.files)).toEqual([kept[0]!.files]);
    });
  });

  it('runs everything sooner at a lower number from the manifest', async () => {
    const f = await fixture(3, 3);
    const first = await f.start({ profile: 'fast' });
    await f.finish(first);
    expect(await f.ranFiles(await f.start({ profile: 'final' }))).toEqual(FILES);
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
    await f.finish(await f.start({ profile: 'fast' }));
    const full = await f.start({ profile: 'final' });
    await f.finish(full, { ok: false, files: [{ suiteId: 'unit', file: 'test/a.test.ts', status: 'failed' }, { suiteId: 'unit', file: 'test/b.test.ts', status: 'passed' }, { suiteId: 'unit', file: 'test/c.test.ts', status: 'passed' }] });
    const run = await f.runOf(full);
    expect(run.fileCache!.mismatches).toEqual([{ suiteId: 'unit', file: 'test/a.test.ts' }]);
    await until(async () => (await f.told()).includes('Test run 2 failed'));
    expect(await f.told()).toContain('Mismatch with the kept results: test/a.test.ts was green at this same fingerprint and failed now.');
    expect((await f.greenRows()).map(row => row.file)).toEqual(['test/b.test.ts', 'test/c.test.ts']);
    const shown = await runState(f.app.ctx, { id: f.job.id, companyId: f.companyId, agentId: f.agent.id, agentKind: 'orchestrator' } as never, 2);
    expect(shown).toMatchObject({ reuse: { mode: 'full', turn: 5, mismatches: ['test/a.test.ts'], failedFiles: ['test/a.test.ts'] } });
    expect(await f.ranFiles(await f.start({ profile: 'final' }))).toEqual(['test/a.test.ts']);
  });

  it('runs everything for a node that sends no fingerprints and keeps nothing', async () => {
    const f = await fixture();
    await f.finish(await f.start({}));
    const old = await f.start({});
    expect((await f.runOf(old)).fileCache).toMatchObject({ mode: 'cached', reused: 3 });
    const none = await fixture();
    const run = await none.start({}, null);
    expect(await none.ranFiles(run)).toEqual(FILES);
    expect((await none.runOf(run)).fileCache).toMatchObject({ mode: 'off', reused: 0 });
    await none.finish(run);
    expect(await none.greenRows()).toEqual([]);
    await until(async () => (await none.told()).includes('Test run 1 passed'));
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
    await f.finish(await f.start({ profile: 'full' }));
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
    const f = await fixture(), run = await f.runOf(await f.start({}));
    const remember = (path: string, text: string) => rememberKept(f.app.ctx, run, { commit: TEST_COMMIT, kept: [{ suiteId: 'unit', files: [{ path, text }] }] });
    await remember('.metrics/mutate/a.edn', 'a'.repeat(600 * 1024));
    await remember('.metrics/mutate/b.edn', 'b'.repeat(600 * 1024));
    const [part] = await f.partsOf(run.id);
    expect((await keptFor(f.app.ctx, run, part!))?.[0]?.files.map(file => file.path)).toEqual(['.metrics/mutate/b.edn']);
  });

  it('marks the pinned commit on GitHub once a run of the whole product passed, also when every file kept its green result', async () => {
    const f = await fixture(), marks = marked(f);
    await f.finish(await f.start({ profile: 'final' }));
    expect(marks).toEqual([{ commit: TEST_COMMIT, state: 'success' }]);
    const reused = await f.start({ profile: 'final' });
    expect(await f.runOf(reused)).toMatchObject({ status: 'passed', parts: 0 });
    expect(marks).toEqual([{ commit: TEST_COMMIT, state: 'success' }, { commit: TEST_COMMIT, state: 'success' }]);
  });

  it('marks failure when a run of the whole product failed', async () => {
    const f = await fixture(), marks = marked(f);
    await f.finish(await f.start({ profile: 'final' }), { ok: false });
    expect(marks).toEqual([{ commit: TEST_COMMIT, state: 'failure' }]);
  });

  it('leaves no mark for the everyday profile or for one suite: neither stands for the whole product', async () => {
    const f = await fixture(), marks = marked(f);
    await f.finish(await f.start({}));
    await f.finish(await f.start({ profile: 'final', suite: 'unit' }));
    expect(marks).toEqual([]);
  });

  it('tells the agent on the task that GitHub now shows the mark', async () => {
    const f = await fixture();
    marked(f);
    await f.finish(await f.start({ profile: 'final' }));
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


describe('zero-part product reuse receipts', () => {
  it.each([false, true])('accepts complete server reuse after closeFileCache, preparation=%s', async preparation => {
    const f = await fixture(3, 5, preparation);
    const verifies = async () => verifiedReuse(await f.runOf(id));
    await f.finish(await f.start({ profile: 'final' }));
    const id = await f.start({ profile: 'final' }), ended = await f.runOf(id);
    expect(ended).toMatchObject({ status: 'passed', parts: 0, fileCache: { mode: 'cached', reused: 3, preparationReused: preparation, fingerprints: [] } });
    expect(await verifies()).toBe(true);

    const snapshot = ended.environmentSnapshot!, request = ended.environmentRequest!, cache = ended.fileCache!;
    const described = (over: Partial<typeof snapshot.description>) => ({ ...snapshot, description: { ...snapshot.description, ...over } });
    const invalid: [string, Partial<typeof ended>][] = [
      ['absent receipt', { fileCache: null }],
      ['empty receipt', { fileCache: { ...cache, reused: 0 } }],
      ['partial receipt', { fileCache: { ...cache, reused: 2 } }],
      ['oversized receipt', { fileCache: { ...cache, reused: 4 } }],
      ['reuse off', { fileCache: { ...cache, mode: 'off' } }],
      ['full run cannot reuse', { fileCache: { ...cache, mode: 'full' } }],
      ['missing snapshot', { environmentSnapshot: null }],
      ['missing request', { environmentRequest: null }],
      ['wrong snapshot commit', { environmentSnapshot: described({ commitSha: 'f'.repeat(40) }) }],
      ['wrong repository', { environmentRequest: { ...request, repositoryScope: { ...request.repositoryScope, repoUrlHash: 'f'.repeat(64) } } }],
      ['wrong repository owner', { environmentRequest: { ...request, repositoryScope: { ...request.repositoryScope, repositoryOwnerId: f.agent.id } } }],
      ['foreign company', { environmentSnapshot: described({ repositoryScope: { ...snapshot.description.repositoryScope, companyId: f.agent.id } }) }],
      ['wrong manifest', { environmentHash: 'f'.repeat(64) }],
      ['unbound manifest bytes', { environmentSnapshot: described({ manifestHash: 'f'.repeat(64) }), environmentHash: 'f'.repeat(64) }],
      ['wrong profile', { environmentSnapshot: { ...snapshot, profile: 'fast' } }],
      ['unknown suite', { environmentRequest: { ...request, suite: 'foreign' } }],
      ['empty inventory', { environmentSnapshot: described({ inventory: [] }) }],
      ['partial inventory', { environmentSnapshot: described({ inventory: snapshot.description.inventory.slice(1) }) }],
      ['duplicate inventory', { environmentSnapshot: described({ inventory: [snapshot.description.inventory[0]!, snapshot.description.inventory[0]!, snapshot.description.inventory[2]!] }) }],
      ['description problem', { environmentRequest: { ...request, problem: { code: 'description_mismatch', detail: 'Fixture mismatch' } } }],
      ...(preparation ? [['missing preparation', { fileCache: { ...cache, preparationReused: false } }] as [string, Partial<typeof ended>]] : []),
    ];
    for (const [why, change] of invalid) {
      await f.db.update(testRuns).set({ ...ended, ...change }).where(eq(testRuns.id, id));
      expect.soft(await verifies(), why).toBe(false);
    }
    await f.db.update(testRuns).set(ended).where(eq(testRuns.id, id));
    expect(await verifies()).toBe(true);
  });
});
