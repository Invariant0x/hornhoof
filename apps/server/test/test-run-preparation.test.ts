import { hashTestEnvironment, type ServerMessage } from '@hornhoof/protocol';
import { asc, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { testParts, testRuns } from '../src/db/schema.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { testCapabilities } from '../src/modules/testruns/describe.js';
import { checkTestTimes, pumpTests, TEST_MINUTES_MAX } from '../src/modules/testruns/runs.js';
import { until } from './helpers.js';
import { company, done, idle, nextOf } from './test-runs-company.js';

const FILES = Array.from({ length: 12 }, (_, index) => `checks/${String(index).padStart(2, '0')}.ts`);
const RUNTIMES = [
  { id: 'node', version: '22.23.4', fingerprint: 'b'.repeat(64), platform: { os: 'linux', arch: 'x64', libc: 'glibc' } },
  { id: 'hornhoof-test-execution', version: '2.0.0', fingerprint: 'c'.repeat(64), platform: { os: 'linux', arch: 'x64', libc: 'glibc' } },
];

/* A product whose every run of the profile first checks the whole of it once, here by its lint, beside the batches of its tests. */
async function described(request: Extract<ServerMessage, { type: 'tests.describe' }>) {
  const manifest = {
    version: 1 as const, defaultProfile: 'fast', runtimes: [{ id: 'node', version: '22' }], profiles: [{ id: 'fast', requiredSuiteIds: ['unit'] }],
    dependencies: { adapter: 'none' as const, inputs: [], install: [], paths: [], cache: 'none' as const }, services: [], prepare: [], reset: null,
    suites: [{ id: 'unit', root: '.', files: ['checks/*.ts'], run: { program: 'node', args: ['runner.js'], cwd: '.' }, split: { kind: 'argv-files' as const }, profiles: ['fast'] }],
    impact: { adapter: 'whole-package', fullPackageGlobs: [], migrationCheck: { status: 'unsupported' as const, reason: 'Not applicable.' } }, mutation: { status: 'unsupported' as const, language: 'typescript', reason: 'Not configured.' },
    execution: { version: 2 as const, oncePreparation: { profiles: ['fast'], suiteIds: [], commands: [{ program: 'node', args: ['lint.js'], cwd: '.' }] } },
  };
  const manifestSource = JSON.stringify(manifest);
  return { type: 'tests.described' as const, requestId: request.requestId, commitSha: request.commitSha, result: { status: 'ready' as const, description: {
    version: 1 as const, repositoryScope: request.repositoryScope, commitSha: request.commitSha, manifestSource, manifestHash: await hashTestEnvironment(manifestSource), manifest,
    inputDigests: [], inventory: FILES.map(file => ({ suiteId: 'unit', file, selectionUnit: file })), runtimeCapabilities: RUNTIMES,
  } } };
}

/* A run of the whole product on two computers, given out: the preparation on one, a batch on the other. */
async function started() {
  const c = await company();
  const machines = [await c.planless(c.ceo, 'one-pc', idle({ load: 0.1, host: '1'.repeat(64) })), await c.planless(c.ceo, 'two-pc', idle({ load: 0.1, host: '2'.repeat(64) }))];
  for (const machine of machines) machine.node.send({ type: 'status', loggedIn: true, limits: null, testEnvironmentVersion: 1, testRuntimes: RUNTIMES });
  await until(() => machines.every(machine => testCapabilities(c.app.ctx, nodeIdentity(machine.nodeId)).testEnvironmentVersion === 1));
  const { call } = await c.turn(c.bruno);
  expect((await call('run_tests', { branch: 'main' })).error).toBe(false);
  const [run] = await c.db.select().from(testRuns);
  const describer = machines.find(machine => machine.nodeId === run!.environmentRequest!.nodeId)!;
  describer.node.send(await described(await nextOf(describer.node, 'tests.describe')));
  const parts = () => c.db.select().from(testParts).where(eq(testParts.runId, run!.id)).orderBy(asc(testParts.part));
  await until(async () => (await parts()).length > 1);
  await pumpTests(c.app.ctx);
  const [preparation, ...batches] = await parts();
  expect(preparation!.environmentSelection!.selection.kind).toBe('prepare');
  const running = batches.filter(part => part.status === 'running');
  const on = (part: { nodeId: string | null }) => machines.find(machine => machine.nodeId === part.nodeId)!;
  return { c, call, run: run!, parts, preparation: preparation!, batches, running, on };
}

it('starts a batch at once beside the preparation, on the computer the preparation left free', async () => {
  const { call, run, preparation, batches, running, on } = await started();
  expect(preparation.status).toBe('running');
  expect(batches.every(part => part.environmentSelection!.selection.kind === 'batch' && part.environmentSelection!.after.length === 0)).toBe(true);
  expect(running).toHaveLength(1);
  expect(running[0]!.nodeId).not.toBe(preparation.nodeId);
  const given = await nextOf(on(running[0]!).node, 'tests.run');
  expect(given.environment!.selection.kind).toBe('batch');
  await call('stop_tests', { run: run.number });
});

/* A failed preparation fails the run whatever the batches come to, so none of them keeps a machine busy for it: those running stop on
   their machines, and those waiting never start. */
it.each(['reported', 'timed out'])('stops every batch of the run when its preparation fails, as %s', async how => {
  const { c, run, parts, preparation, running, on } = await started();
  expect(running).toHaveLength(1);
  const batchNode = on(running[0]!).node, given = await nextOf(batchNode, 'tests.run');
  if (how === 'reported') {
    const prepared = await nextOf(on(preparation).node, 'tests.run');
    on(preparation).node.send(done(prepared, { ok: false, error: 'failed', exitCode: 1, commit: run.commitSha }));
    /* The server answers the end once it has dealt with it. */
    await nextOf(on(preparation).node, 'tests.ack');
  } else {
    await c.db.update(testParts).set({ startedAt: new Date(Date.now() - 2 * TEST_MINUTES_MAX * 60_000) }).where(eq(testParts.id, preparation.id));
    await checkTestTimes(c.app.ctx);
  }
  const ended = await parts();
  expect(ended[0]).toMatchObject({ status: 'failed', error: how === 'reported' ? 'failed' : 'timeout' });
  expect(ended.slice(1).map(part => ({ status: part.status, error: part.error }))).toEqual(ended.slice(1).map(() => ({ status: 'failed', error: 'prerequisite_failed' })));
  expect((await c.db.select().from(testRuns).where(eq(testRuns.id, run.id)))[0]!.status).toBe('failed');
  expect(await nextOf(batchNode, 'tests.cancel')).toEqual({ type: 'tests.cancel', partId: given.partId });
});
