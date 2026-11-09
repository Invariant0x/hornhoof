import { hashTestEnvironment, type ServerMessage } from '@hornhoof/protocol';
import { asc, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { testPartTimings, testParts, testRuns } from '../src/db/schema.js';
import { newEnvironmentRequest } from '../src/modules/testruns/describe.js';
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
  expect((await call('run_tests', {})).error).toBe(false);
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
