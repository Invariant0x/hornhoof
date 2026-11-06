import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { stagingBatches, stagingPlans, stagingTrials, taskWorkspaceMergeReceipts, testParts, testRuns } from '../src/db/schema.js';
import { settleRegisteredStagingTrial } from '../src/modules/tasks/staging-store.js';
import { HEAD, stagingStateFixture } from './staging-state-fixture.js';

async function checking() {
  const f = await stagingStateFixture();
  await f.db.delete(taskWorkspaceMergeReceipts);
  await f.db.update(stagingBatches).set({ phase: 'checking', completedAt: null });
  await f.db.update(stagingTrials).set({ phase: 'checking', partIds: [] });
  return { ...f, input: { trialId: f.trial.id, runId: f.run.id, expectedVersion: 0 } };
}

describe('durable native trial completion', () => {
  it('persists complete native GREEN and replays after restart without a second version increment', async () => {
    const f = await checking();
    const wanted = { status: 'passed', trialId: f.trial.id, version: 1, partIds: [f.part.id] };
    expect(await settleRegisteredStagingTrial(f.ctx, f.input)).toEqual(wanted);
    expect((await f.db.select().from(stagingTrials))[0]).toMatchObject({ phase: 'passed', version: 1, partIds: [f.part.id], failure: null });
    expect(await settleRegisteredStagingTrial({ db: f.db, companyId: f.company.id }, f.input)).toEqual(wanted);
    expect((await f.db.select().from(stagingTrials))[0]!.version).toBe(1);
    expect(await f.db.select().from(taskWorkspaceMergeReceipts)).toEqual([]);
  });
  it('does not release a running trial or create a publication intent from a partial result', async () => {
    const f = await checking(); await f.db.update(testRuns).set({ status: 'running', finishedAt: null });
    const before = await f.db.select().from(stagingTrials);
    expect(await settleRegisteredStagingTrial(f.ctx, f.input)).toEqual({ status: 'waiting' });
    expect(await f.db.select().from(stagingTrials)).toEqual(before);
  });
  it.each(['wrong pin', 'missing part', 'part unsettled', 'setup failure'] as const)('keeps %s unavailable without changing durable state', async state => {
    const f = await checking();
    if (state === 'wrong pin') await f.db.update(testParts).set({ commit: HEAD });
    if (state === 'missing part') await f.db.delete(testParts);
    if (state === 'part unsettled') await f.db.update(testParts).set({ finishedAt: null });
    if (state === 'setup failure') { await f.db.update(testRuns).set({ status: 'failed' }); await f.db.update(testParts).set({ status: 'failed', exitCode: 1, error: 'preparation failed' }); }
    const before = await f.db.select().from(stagingTrials);
    expect(await settleRegisteredStagingTrial(f.ctx, f.input)).toEqual({ status: 'unavailable' });
    expect(await f.db.select().from(stagingTrials)).toEqual(before);
  });
  it('records exit failure as unattributed and never turns a tail or caller claim into a culprit', async () => {
    const f = await checking(); await f.db.update(testRuns).set({ status: 'failed' });
    await f.db.update(testParts).set({ status: 'failed', exitCode: 1, error: 'failed', tail: 'FAILED tests/test_wrong.py::test_forged - assertion' });
    expect(await settleRegisteredStagingTrial(f.ctx, f.input)).toEqual({ status: 'unattributed', trialId: f.trial.id, version: 1, partIds: [f.part.id] });
    expect((await f.db.select().from(stagingTrials))[0]).toMatchObject({ phase: 'unattributed', failure: null, version: 1 });
  });
  it('rejects stale callbacks and another run or company without overwriting current state', async () => {
    const f = await checking(), before = await f.db.select().from(stagingTrials);
    for (const change of [{ runId: randomUUID() }, { expectedVersion: 1 }, { expectedVersion: -1 }, { trialId: randomUUID() }]) {
      expect(await settleRegisteredStagingTrial(f.ctx, { ...f.input, ...change })).toEqual({ status: 'stale' });
    }
    expect(await settleRegisteredStagingTrial({ ...f.ctx, companyId: randomUUID() }, f.input)).toEqual({ status: 'stale' });
    expect(await f.db.select().from(stagingTrials)).toEqual(before);
  });
  it('leaves disabled plans inert and refuses a superseded generation', async () => {
    const f = await checking(); await f.db.update(stagingPlans).set({ enabled: false });
    expect(await settleRegisteredStagingTrial(f.ctx, f.input)).toEqual({ status: 'disabled' });
    await f.db.update(stagingPlans).set({ enabled: true, isCurrent: false });
    expect(await settleRegisteredStagingTrial(f.ctx, f.input)).toEqual({ status: 'stale' });
    expect((await f.db.select().from(stagingTrials))[0]!.phase).toBe('checking');
  });
  it('never rewrites a published trial from a later native callback', async () => {
    const f = await stagingStateFixture(), before = await f.db.select().from(stagingTrials);
    expect(await settleRegisteredStagingTrial(f.ctx, { trialId: f.trial.id, runId: f.run.id, expectedVersion: 0 })).toEqual({ status: 'stale' });
    expect(await f.db.select().from(stagingTrials)).toEqual(before);
  });
  it('retains ordered native part IDs in the persisted proof', async () => {
    const f = await checking(); await f.db.update(testRuns).set({ parts: 2 });
    await f.db.update(testParts).set({ part: 2 }).where(eq(testParts.id, f.part.id));
    const [first] = await f.db.insert(testParts).values({ companyId: f.company.id, runId: f.run.id, part: 1, builtin: true,
      commit: f.trial.candidateSha, status: 'passed', exitCode: 0, finishedAt: new Date() }).returning();
    expect(await settleRegisteredStagingTrial(f.ctx, f.input)).toMatchObject({ status: 'passed', partIds: [first!.id, f.part.id] });
  });
});
