import { hashTestEnvironment, type ServerMessage } from '@hornhoof/protocol';
import { asc, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { testPartTimings, testParts, testRuns } from '../src/db/schema.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { newEnvironmentRequest, testCapabilities } from '../src/modules/testruns/describe.js';
import { measuredHistory } from '../src/modules/testruns/plan-measured.js';
import { AWAY_MS, checkTestTimes, pumpTests } from '../src/modules/testruns/runs.js';
import { until } from './helpers.js';
import { company, done, idle, nextOf } from './test-runs-company.js';

const FILES = Array.from({ length: 30 }, (_, index) => `test/${String(index).padStart(2, '0')}.ts`);
/* What each file takes on the faster machine; the slower one took 2.3 times as long for the same files. */
const msOf = (file: string): number => 4000 + (Number(/\d+/.exec(file)![0]) % 7) * 3000;
const RUNTIMES = [
  { id: 'node', version: '22.23.4', fingerprint: 'b'.repeat(64), platform: { os: 'linux', arch: 'x64', libc: 'glibc' } },
  { id: 'hornhoof-test-execution', version: '2.0.0', fingerprint: 'c'.repeat(64), platform: { os: 'linux', arch: 'x64', libc: 'glibc' } },
];

async function described(request: Extract<ServerMessage, { type: 'tests.describe' }>) {
  const manifest = {
    version: 1 as const, defaultProfile: 'fast', runtimes: [{ id: 'node', version: '22' }], profiles: [{ id: 'fast', requiredSuiteIds: ['unit'] }],
    dependencies: { adapter: 'none' as const, inputs: [], install: [], paths: [], cache: 'none' as const }, services: [], prepare: [], reset: null,
    suites: [{ id: 'unit', root: '.', files: ['test/*.ts'], run: { program: 'node', args: ['runner.js'], cwd: '.' }, split: { kind: 'argv-files' as const }, profiles: ['fast'] }],
    impact: { adapter: 'whole-package', fullPackageGlobs: [], migrationCheck: { status: 'unsupported' as const, reason: 'Not applicable.' } }, mutation: { status: 'unsupported' as const, language: 'typescript', reason: 'Not configured.' },
    execution: { version: 2 as const },
  };
  const manifestSource = JSON.stringify(manifest);
  return { type: 'tests.described' as const, requestId: request.requestId, commitSha: request.commitSha, result: { status: 'ready' as const, description: {
    version: 1 as const, repositoryScope: request.repositoryScope, commitSha: request.commitSha, manifestSource, manifestHash: await hashTestEnvironment(manifestSource), manifest,
    inputDigests: [], inventory: FILES.map(file => ({ suiteId: 'unit', file, selectionUnit: file })), runtimeCapabilities: RUNTIMES,
  } } };
}

it('lays a run out by what each machine took for the same files before, and gives each part to the machine it was laid out for', async () => {
  const c = await company();
  const fastHost = 'f'.repeat(64), slowHost = '5'.repeat(64);
  const fast = await c.planless(c.ceo, 'fast-pc', idle({ load: 0.1, host: fastHost })), slow = await c.planless(c.ceo, 'slow-pc', idle({ load: 0.1, host: slowHost }));
  for (const machine of [fast, slow]) machine.node.send({ type: 'status', loggedIn: true, limits: null, testEnvironmentVersion: 1, testRuntimes: RUNTIMES });
  const { testCapabilities } = await import('../src/modules/testruns/describe.js');
  const { nodeIdentity } = await import('../src/modules/nodes/hub.js');
  await until(() => [fast, slow].every(machine => testCapabilities(c.app.ctx, nodeIdentity(machine.nodeId)).testEnvironmentVersion === 1));
  const { call } = await c.turn(c.bruno);
  expect((await call('run_tests', { branch: 'main' })).error).toBe(false);
  const [run] = await c.db.select().from(testRuns);
  const describer = (await c.db.select().from(testRuns))[0]!.environmentRequest!.nodeId === fast.nodeId ? fast : slow;
  const request = await nextOf(describer.node, 'tests.describe');
  /* An earlier run of this repository: each machine ran two thirds of the files, a third of them on both. The slower machine took
     2.3 times as long for each file and for its part, which ran four files at a time. */
  const [earlier] = await c.db.insert(testRuns).values({ companyId: run!.companyId, departmentId: run!.departmentId, taskId: run!.taskId, agentId: run!.agentId, jobId: run!.jobId, number: 99, command: '', commitSha: run!.commitSha, timeoutMs: 600_000, status: 'passed',
    environmentRequest: newEnvironmentRequest(request.repositoryScope, { mode: 'product' }) }).returning();
  const timings = (host: string, files: string[], pace: number) => files.map(file => ({ package: '.', file, totalMs: Math.round(msOf(file) * pace), setupMs: null, testsMs: null, teardownMs: null, slowest: [] }));
  const ranOn = [{ host: fastHost, files: FILES.filter((_, index) => index % 3 !== 0), pace: 1 }, { host: slowHost, files: FILES.filter((_, index) => index % 3 !== 1), pace: 2.3 }];
  for (const [index, { host, files, pace }] of ranOn.entries()) {
    const commandMs = (files.reduce((sum, file) => sum + msOf(file), 0) * pace) / 4;
    const phases = { checkoutMs: 1000, dependenciesMs: 1000, environmentMs: 1000, servicesMs: 1000, commandMs, cleanupMs: 1000 };
    const environmentSelection = { selection: { kind: 'batch' as const, version: 2 as const, expectedCommitSha: run!.commitSha!, selections: [{ kind: 'suite' as const, suiteId: 'unit', files, shard: { index: 1, count: 1 } }] }, after: [] };
    const [part] = await c.db.insert(testParts).values({ companyId: run!.companyId, runId: earlier!.id, part: index + 1, status: 'passed', computer: `host:${host}`, finishedAt: new Date(),
      environmentSelection, environmentReceipt: { phases } as never }).returning();
    await c.db.insert(testPartTimings).values({ partId: part!.id, companyId: run!.companyId, runId: earlier!.id, files: timings(host, files, pace) });
  }
  describer.node.send(await described(request));
  await until(async () => (await c.db.select().from(testParts).where(eq(testParts.runId, run!.id))).length === 2);
  await pumpTests(c.app.ctx);
  const parts = await c.db.select().from(testParts).where(eq(testParts.runId, run!.id)).orderBy(asc(testParts.part));
  const filesOf = (part: typeof parts[number]) => { const selection = part.environmentSelection!.selection; return selection.kind === 'batch' ? selection.selections.flatMap(member => member.files) : []; };
  const onFast = parts.find(part => part.environmentSelection!.computer === `host:${fastHost}`)!, onSlow = parts.find(part => part.environmentSelection!.computer === `host:${slowHost}`)!;
  expect([onFast.nodeId, onSlow.nodeId]).toEqual([fast.nodeId, slow.nodeId]);
  /* The faster machine has more to do, and both should take about as long. */
  const work = (part: typeof parts[number]) => filesOf(part).reduce((sum, file) => sum + msOf(file), 0);
  expect(work(onFast)).toBeGreaterThan(2 * work(onSlow));
  expect(Math.abs(work(onFast) - 2.3 * work(onSlow)) / work(onFast)).toBeLessThan(0.15);
  expect([...filesOf(onFast), ...filesOf(onSlow)].sort()).toEqual(FILES);
  /* The slower machine goes away for good. Its part does not wait for it: once lost, it goes to the machine that is left. */
  const fastPart = await nextOf(fast.node, 'tests.run');
  slow.node.close(); await slow.node.closed;
  await checkTestTimes(c.app.ctx, new Date(Date.now() + AWAY_MS + 60_000));
  expect((await c.db.select().from(testParts).where(eq(testParts.id, onSlow.id)))).toEqual([]);
  /* What its runner said each file took is kept as the part ends, for the next plan. */
  fast.node.send(done(fastPart, { ok: false, error: 'failed', exitCode: 1, commit: run!.commitSha, files: [{ suiteId: 'unit', file: 'test/00.ts', status: 'failed', ms: 4100 }] }));
  const moved = await nextOf(fast.node, 'tests.run');
  expect(moved.environment!.selection).toEqual(onSlow.environmentSelection!.selection);
  expect((await c.db.select().from(testPartTimings).where(eq(testPartTimings.partId, fastPart.partId)))[0]?.files).toMatchObject([{ package: '.', file: 'test/00.ts', totalMs: 4100 }]);
  await call('stop_tests', { run: run!.number });
});

/* The whole way, with nothing put in by hand: the parts of each run end with what their runner said each file took, and a later run
   of the repository is laid out by what they kept, under the keys its plan gives the free computers. The first run cannot tell a
   slow machine from big files; the second, laid out by those sizes, runs files on the other machine too, and that ties the paces. */
it('lays a later run out by what the parts of the earlier ones said each file took on their computers', async () => {
  const c = await company();
  const fastHost = 'f'.repeat(64), slowHost = '5'.repeat(64);
  const machines = [{ ...await c.planless(c.ceo, 'fast-pc', idle({ load: 0.1, host: fastHost })), pace: 1 }, { ...await c.planless(c.ceo, 'slow-pc', idle({ load: 0.1, host: slowHost })), pace: 2.5 }];
  for (const machine of machines) machine.node.send({ type: 'status', loggedIn: true, limits: null, testEnvironmentVersion: 1, testRuntimes: RUNTIMES });
  await until(() => machines.every(machine => testCapabilities(c.app.ctx, nodeIdentity(machine.nodeId)).testEnvironmentVersion === 1));
  const { call } = await c.turn(c.bruno);
  const partsOf = (runId: string) => c.db.select().from(testParts).where(eq(testParts.runId, runId)).orderBy(asc(testParts.part));
  const filesOf = (part: typeof testParts.$inferSelect) => { const selection = part.environmentSelection!.selection; return selection.kind === 'batch' ? selection.selections.flatMap(member => member.files) : []; };
  /* A run of the whole product, each part answered by the machine that got it, at its pace and four files at a time, with a log that
     says nothing of the files: what each took is only in what its runner reported. */
  const runOnce = async () => {
    expect((await call('run_tests', { branch: 'main' })).error).toBe(false);
    const [run] = await c.db.select().from(testRuns).where(eq(testRuns.status, 'running'));
    const describer = machines.find(machine => machine.nodeId === run!.environmentRequest!.nodeId)!;
    describer.node.send(await described(await nextOf(describer.node, 'tests.describe')));
    await until(async () => (await partsOf(run!.id)).length > 0);
    await pumpTests(c.app.ctx);
    const laidOut = await partsOf(run!.id);
    for (const part of laidOut) {
      const machine = machines.find(machine => machine.nodeId === part.nodeId)!, given = await nextOf(machine.node, 'tests.run'), selection = given.environment!.selection;
      if (selection.kind !== 'batch') throw new Error('Only batches were laid out.');
      const commandMs = (filesOf(part).reduce((sum, file) => sum + msOf(file), 0) * machine.pace) / 4;
      const environmentReceipt = { version: 2, profile: 'fast', selection, commitSha: given.commitSha, manifestHash: given.environment!.snapshot.description.manifestHash, runtimes: RUNTIMES,
        outcomes: selection.selections.map((_, index) => ({ index, status: 'passed', exitCode: 0 })), dependencies: { key: null, hit: false }, environments: [],
        phases: { checkoutMs: 1000, dependenciesMs: 1000, environmentMs: 1000, servicesMs: 1000, commandMs, cleanupMs: 1000 } };
      machine.node.send(done(given, { commit: given.commitSha, environmentReceipt, files: filesOf(part).map(file => ({ suiteId: 'unit', file, status: 'passed', ms: msOf(file) * machine.pace })) }));
      await nextOf(machine.node, 'tests.ack');
    }
    expect((await c.db.select().from(testRuns).where(eq(testRuns.id, run!.id)))[0]!.status).toBe('passed');
    return partsOf(run!.id);
  };
  const first = await runOnce();
  /* Each part kept what its runner said, under the folder of its suite, and the computer it ran on. */
  for (const part of first) {
    const pace = part.nodeId === machines[0]!.nodeId ? 1 : 2.5;
    expect((await c.db.select().from(testPartTimings).where(eq(testPartTimings.partId, part.id)))[0]!.files).toEqual(filesOf(part).map(file => ({ package: '.', file, totalMs: msOf(file) * pace, setupMs: null, testsMs: null, teardownMs: null, slowest: [] })));
  }
  expect(first.map(part => part.computer).sort()).toEqual([`host:${fastHost}`, `host:${slowHost}`].sort());
  await runOnce();
  const third = await runOnce();
  const onFast = third.find(part => part.environmentSelection!.computer === `host:${fastHost}`)!, onSlow = third.find(part => part.environmentSelection!.computer === `host:${slowHost}`)!;
  expect([onFast.nodeId, onSlow.nodeId]).toEqual([machines[0]!.nodeId, machines[1]!.nodeId]);
  const work = (part: typeof third[number]) => filesOf(part).reduce((sum, file) => sum + msOf(file), 0);
  expect(work(onFast)).toBeGreaterThan(2 * work(onSlow));
  expect(Math.abs(work(onFast) - 2.5 * work(onSlow)) / work(onFast)).toBeLessThan(0.15);
});

it('reads how long a preparation that passed took before, at the middle pace of the machines', async () => {
  const c = await company();
  const fastHost = 'f'.repeat(64), slowHost = '5'.repeat(64);
  const fast = await c.planless(c.ceo, 'fast-pc', idle({ load: 0.1, host: fastHost })), slow = await c.planless(c.ceo, 'slow-pc', idle({ load: 0.1, host: slowHost }));
  for (const machine of [fast, slow]) machine.node.send({ type: 'status', loggedIn: true, limits: null, testEnvironmentVersion: 1, testRuntimes: RUNTIMES });
  await until(() => [fast, slow].every(machine => testCapabilities(c.app.ctx, nodeIdentity(machine.nodeId)).testEnvironmentVersion === 1));
  const { call } = await c.turn(c.bruno);
  expect((await call('run_tests', { branch: 'main' })).error).toBe(false);
  const [run] = await c.db.select().from(testRuns);
  const describer = run!.environmentRequest!.nodeId === fast.nodeId ? fast : slow;
  const request = await nextOf(describer.node, 'tests.describe');
  const [earlier] = await c.db.insert(testRuns).values({ companyId: run!.companyId, departmentId: run!.departmentId, taskId: run!.taskId, agentId: run!.agentId, jobId: run!.jobId, number: 99, command: '', commitSha: run!.commitSha, timeoutMs: 600_000, status: 'passed',
    environmentRequest: newEnvironmentRequest(request.repositoryScope, { mode: 'product' }) }).returning();
  const phases = (commandMs: number) => ({ checkoutMs: 1000, dependenciesMs: 1000, environmentMs: 1000, servicesMs: 1000, commandMs, cleanupMs: 1000 });
  const prepare = { selection: { kind: 'prepare' as const, version: 2 as const, expectedCommitSha: run!.commitSha! }, after: [] };
  /* Batches on both machines, the slower one 2.3 times as long for the same files, and three preparations: two that passed on the
     slower machine in 50 and 60 s, and one that failed at once on the faster one. */
  const ranOn = [{ host: fastHost, files: FILES.filter((_, index) => index % 3 !== 0), pace: 1 }, { host: slowHost, files: FILES.filter((_, index) => index % 3 !== 1), pace: 2.3 }];
  const rows = [
    ...ranOn.map(({ host, files, pace }) => ({ host, status: 'passed' as const, receipt: phases((files.reduce((sum, file) => sum + msOf(file), 0) * pace) / 4),
      selection: { selection: { kind: 'batch' as const, version: 2 as const, expectedCommitSha: run!.commitSha!, selections: [{ kind: 'suite' as const, suiteId: 'unit', files, shard: { index: 1, count: 1 } }] }, after: [] },
      timings: files.map(file => ({ package: '.', file, totalMs: Math.round(msOf(file) * pace), setupMs: null, testsMs: null, teardownMs: null, slowest: [] })) })),
    { host: slowHost, status: 'passed' as const, receipt: phases(46_000), selection: prepare, timings: [] },
    { host: slowHost, status: 'passed' as const, receipt: phases(56_000), selection: prepare, timings: [] },
    { host: fastHost, status: 'failed' as const, receipt: phases(1000), selection: prepare, timings: [] },
  ];
  for (const [index, row] of rows.entries()) {
    const [part] = await c.db.insert(testParts).values({ companyId: run!.companyId, runId: earlier!.id, part: index + 1, status: row.status, computer: `host:${row.host}`, finishedAt: new Date(Date.now() - (rows.length - index) * 1000),
      environmentSelection: row.selection, environmentReceipt: { phases: row.receipt } as never }).returning();
    await c.db.insert(testPartTimings).values({ partId: part!.id, companyId: run!.companyId, runId: earlier!.id, files: row.timings });
  }
  const history = await measuredHistory(c.app.ctx)(run, { profile: 'fast', description: (await described(request)).result.description } as never);
  expect(history!.paces!.get(`host:${slowHost}`)).toBeGreaterThan(1);
  expect(history!.preparationMs).toBeCloseTo(55_000 / history!.paces!.get(`host:${slowHost}`)!, 0);
  await call('stop_tests', { run: run!.number });
});
