import { hashTestEnvironment, type NodeMessage, type TestsDescribed } from '@hornhoof/protocol';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, departments, jobs, tasks, testParts, testRuns } from '../src/db/schema.js';
import { BUILTIN } from './builtin.js';
import { acceptDescription, newEnvironmentRequest, repositoryScope, setProductPlanningPorts, testCapabilities } from '../src/modules/testruns/describe.js';
import { partDone, pumpTests } from '../src/modules/testruns/runs.js';
import { connectNode, listen, setUpCompany, testApp, TEST_COMMIT, until } from './helpers.js';
import { planningEnvironment } from './fixtures/run-planning/environment.js';

const NODE_KEY = 'batch-integration-node-0123456789abcdef';
const runtimes = [{ id: 'node', version: '22.23.4', fingerprint: 'b'.repeat(64) }, { id: 'python', version: '3.12.0', fingerprint: 'c'.repeat(64) }, { id: 'hornhoof-test-execution', version: '2.0.0', fingerprint: 'd'.repeat(64) }];
async function fixture(once = true, native = true) {
  const { app, db } = await testApp({ NODE_KEY, NODE_PING_MS: '2147483647' }), url = await listen(app);
  await setUpCompany(app);
  const [agent] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator')), companyId = agent!.companyId;
  const [department] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://example.test/fixture.git' }).returning();
  const [task] = await db.insert(tasks).values({ companyId, departmentId: department!.id, number: 1, title: 'Batch fixture', status: 'working', assigneeAgentId: agent!.id, executorAgentId: agent!.id }).returning();
  const [job] = await db.insert(jobs).values({ companyId, subscriptionId: agent!.subscriptionId!, agentId: agent!.id, taskId: task!.id, prompt: 'Fixture', timeoutMs: 10_000, status: 'running' }).returning();
  const [run] = await db.insert(testRuns).values({ companyId, departmentId: department!.id, taskId: task!.id, agentId: agent!.id, jobId: job!.id, number: 1, command: '', commitSha: TEST_COMMIT, timeoutMs: 10_000,
    environmentRequest: newEnvironmentRequest(repositoryScope(companyId, department!.id, department!.repoUrl!), { mode: 'product' }) }).returning();
  const node = await connectNode(url, NODE_KEY);
  node.send({ type: 'hello', version: '0.7.0', loggedIn: true, running: [], tests: [], load: { cpus: 8, load: 0.1, memFree: 16 * 1024 ** 3, memTotal: 16 * 1024 ** 3, tests: 0, jobs: 0 }, testEnvironmentVersion: 1, testRuntimes: native ? runtimes : runtimes.slice(0, 2) });
  await until(() => testCapabilities(app.ctx, BUILTIN).testEnvironmentVersion === 1);
  await pumpTests(app.ctx);
  const [stored] = await db.select().from(testRuns).where(eq(testRuns.id, run!.id)), request = stored!.environmentRequest!;
  expect(request.requestId).not.toBeNull();
  const input = await planningEnvironment(), description = input.snapshot.description;
  description.repositoryScope = request.repositoryScope; description.runtimeCapabilities = runtimes;
  description.manifest.execution = { version: 2, ...(once ? { oncePreparation: { profiles: ['fast'], suiteIds: ['vitest'], commands: [{ program: 'node', args: ['types.js'], cwd: '.' }] } } : {}) };
  description.manifestSource = JSON.stringify(description.manifest); description.manifestHash = await hashTestEnvironment(description.manifestSource);
  const reply: TestsDescribed = { type: 'tests.described', requestId: request.requestId!, commitSha: TEST_COMMIT, result: { status: 'ready', description } };
  const parts = () => db.select().from(testParts).where(eq(testParts.runId, run!.id)).orderBy(asc(testParts.part));
  const complete = async (ok: boolean) => {
    const [current] = await db.select().from(testRuns).where(eq(testRuns.id, run!.id)), [part] = await parts();
    const snapshot = current!.environmentSnapshot!, selection = part!.environmentSelection!.selection;
    expect(selection.kind).toBe('prepare');
    const message: Extract<NodeMessage, { type: 'tests.done' }> = { type: 'tests.done', partId: part!.id, ok, error: ok ? null : 'failed', exitCode: ok ? 0 : 7, commit: TEST_COMMIT, log: 'Fixture preparation result',
      environmentReceipt: { version: 2, profile: 'fast', selection: { kind: 'prepare', version: 2, expectedCommitSha: TEST_COMMIT }, commitSha: TEST_COMMIT, manifestHash: snapshot.description.manifestHash, runtimes,
        outcomes: ok ? [{ index: 0, status: 'passed', exitCode: 0 }, { index: 1, status: 'passed', exitCode: 0 }] : [{ index: 0, status: 'failed', exitCode: 7 }, { index: 1, status: 'not-run', exitCode: null }],
        dependencies: { key: null, hit: false }, environments: [], phases: { checkoutMs: 0, dependenciesMs: 0, environmentMs: 0, servicesMs: 0, commandMs: 0, cleanupMs: 0 } } };
    await partDone(app.ctx, BUILTIN, message);
  };
  return { app, db, run: run!, reply, parts, complete };
}

describe('persisted versioned product batches', () => {
  /* The batch waits for no preparation, only for the one machine here; the final checks of the prepared suite wait for it. */
  it.each([true, false])('persists preparation once and decides every remaining part by it on outcome=%s', async ok => {
    const f = await fixture();
    await acceptDescription(f.app.ctx, BUILTIN, f.reply); await pumpTests(f.app.ctx);
    const before = await f.parts();
    expect(before.map(part => ({ kind: part.environmentSelection!.selection.kind, after: part.environmentSelection!.after, status: part.status }))).toEqual([
      { kind: 'prepare', after: [], status: 'running' }, { kind: 'batch', after: [], status: 'queued' }, { kind: 'final', after: [1], status: 'queued' },
    ]);
    await acceptDescription(f.app.ctx, BUILTIN, f.reply); expect((await f.parts()).map(part => part.id)).toEqual(before.map(part => part.id));
    await f.complete(ok);
    const after = await f.parts();
    if (ok) expect(after.map(part => part.status)).toEqual(['passed', 'running', 'queued']);
    else expect(after.map(part => ({ status: part.status, error: part.error }))).toEqual([{ status: 'failed', error: 'failed' }, { status: 'failed', error: 'prerequisite_failed' }, { status: 'failed', error: 'prerequisite_failed' }]);
  });
  it('rejects description data for another commit even when its outer request matches', async () => {
    const f = await fixture();
    if (f.reply.result.status !== 'ready') throw new Error('Fixture description is absent.');
    f.reply.result.description.commitSha = 'f'.repeat(40);
    await acceptDescription(f.app.ctx, BUILTIN, f.reply);
    const [run] = await f.db.select().from(testRuns).where(eq(testRuns.id, f.run.id));
    expect(run!.environmentSnapshot).toBeNull(); expect(run!.environmentRequest!.problem?.code).toBe('description_mismatch');
  });
  it('keeps a V2 batch queued until a node advertises the native executor capability', async () => {
    const f = await fixture(false, false);
    /* A limit its files fit in at the estimate of a file no part measured, so they go out in one batch. */
    await f.db.update(testRuns).set({ timeoutMs: 30 * 60_000 }).where(eq(testRuns.id, f.run.id));
    await acceptDescription(f.app.ctx, BUILTIN, f.reply); await pumpTests(f.app.ctx);
    const parts = await f.parts();
    expect(parts.map(part => part.environmentSelection!.selection.kind)).toEqual(['batch', 'final']);
    expect(parts.every(part => part.status === 'queued')).toBe(true);
  });
  it('passes the locked exact run to the private history and transaction record ports once', async () => {
    const f = await fixture(false), seen: { stage: string; runId: string; commit: string | null; reason?: string }[] = [];
    setProductPlanningPorts(f.app.ctx, {
      history: async (run, snapshot) => {
        seen.push({ stage: 'history', runId: run.id, commit: run.commitSha });
        expect(snapshot.description.commitSha).toBe(run.commitSha);
        return { durations: snapshot.description.inventory.map(unit => ({ suiteId: unit.suiteId, file: unit.file, ms: 1 })), costs: { setupMs: 1, collectMs: 1 } };
      },
      record: async (tx, run, plan) => {
        const [stored] = await tx.select().from(testRuns).where(eq(testRuns.id, run.id));
        expect(stored!.commitSha).toBe(TEST_COMMIT); expect(stored!.environmentSnapshot).toBeNull();
        seen.push({ stage: 'record', runId: run.id, commit: run.commitSha, reason: plan.reason });
      },
    });
    await acceptDescription(f.app.ctx, BUILTIN, f.reply); await acceptDescription(f.app.ctx, BUILTIN, f.reply);
    expect(seen.map(value => ({ stage: value.stage, runId: value.runId, commit: value.commit }))).toEqual([
      { stage: 'history', runId: f.run.id, commit: TEST_COMMIT }, { stage: 'record', runId: f.run.id, commit: TEST_COMMIT },
    ]);
    expect(seen[1]!.reason).toContain('All file estimates use historical measurements.');
  });
});
