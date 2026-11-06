import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { stagingBatches, stagingOperations, stagingTrials, taskWorkspaceMergeReceipts, taskWorkspaces, taskWorkspaceSubmissions, testParts, testRuns } from '../src/db/schema.js';
import { readRegisteredStagingInclusion } from '../src/modules/tasks/staging-receipts.js';
import { CANDIDATE, HEAD, stagingStateFixture } from './staging-state-fixture.js';

const missing = { code: 'integration_plan_missing', retryable: true };
const stale = { code: 'binding_stale', retryable: false };

describe('private persisted staging inclusion', () => {
  it('reads the exact current H to M receipt without an ancestry or submission phase assumption', async () => {
    const f = await stagingStateFixture();
    expect(HEAD).not.toBe(CANDIDATE);
    expect(await readRegisteredStagingInclusion(f.ctx, f.query)).toEqual({ receiptId: f.receipt.id, repositoryId: f.repository.id, taskId: f.task.id,
      workspaceId: f.workspace.id, bindingVersion: 1, submissionRevision: 1, taskBranch: 'task-1', submittedHeadSha: HEAD,
      publicationReceiptId: f.submission.publicationReceiptId, integrationKind: 'turn', integrationRef: 'turn-8', integrationCommitSha: CANDIDATE,
      batchOrReleaseId: f.batch.id, confirmedAt: '2026-11-06T12:00:00.000Z' });
  });
  it('does not create a receipt from publication metadata or branch status', async () => {
    const f = await stagingStateFixture(); await f.db.delete(taskWorkspaceMergeReceipts);
    expect(await readRegisteredStagingInclusion(f.ctx, f.query)).toEqual(missing);
    expect(await f.db.select().from(taskWorkspaceMergeReceipts)).toEqual([]);
  });
  it('refuses another company, repository, target or caller acknowledgement', async () => {
    const f = await stagingStateFixture();
    expect(await readRegisteredStagingInclusion({ ...f.ctx, companyId: randomUUID() }, f.query)).toEqual(stale);
    for (const change of [{ repositoryId: randomUUID() }, { target: { kind: 'turn' as const, ref: 'turn-9' } }, { ready: true }]) {
      expect(await readRegisteredStagingInclusion(f.ctx, { ...f.query, ...change })).toEqual(stale);
    }
  });
  it.each([
    { submissionRevision: 2 }, { submittedHeadSha: 'd'.repeat(40) }, { bindingVersion: 2 }, { publicationReceiptId: randomUUID() }, { taskBranch: 'task-old' },
  ])('refuses a stale current tuple %j', async change => {
    const f = await stagingStateFixture();
    expect(await readRegisteredStagingInclusion(f.ctx, { ...f.query, ...change })).toEqual(stale);
  });
  it('refuses retained old bindings and revisions even when their receipt still exists', async () => {
    const f = await stagingStateFixture(); await f.db.update(taskWorkspaces).set({ submissionRevision: 2 });
    expect(await readRegisteredStagingInclusion(f.ctx, f.query)).toEqual(stale);
    await f.db.update(taskWorkspaces).set({ submissionRevision: 1, isCurrent: false });
    expect(await readRegisteredStagingInclusion(f.ctx, f.query)).toEqual(stale);
  });
  it('does not satisfy a main release target using a turn receipt', async () => {
    const f = await stagingStateFixture();
    expect(await readRegisteredStagingInclusion(f.ctx, { ...f.query, target: { kind: 'main', ref: 'main' } })).toEqual(missing);
  });
  it.each(['batch', 'trial', 'operation', 'native'] as const)('requires completed %s provenance', async which => {
    const f = await stagingStateFixture();
    if (which === 'batch') await f.db.update(stagingBatches).set({ phase: 'publishing' });
    if (which === 'trial') await f.db.update(stagingTrials).set({ phase: 'publishing' });
    if (which === 'operation') await f.db.update(stagingOperations).set({ phase: 'sent' }).where(eq(stagingOperations.kind, 'publish_turn'));
    if (which === 'native') await f.db.update(testRuns).set({ status: 'running', finishedAt: null });
    expect(await readRegisteredStagingInclusion(f.ctx, f.query)).toEqual(missing);
  });
  it('rejects exact-pin drift, a missing native part and a wrong operation target', async () => {
    const f = await stagingStateFixture(); await f.db.update(testParts).set({ commit: HEAD });
    expect(await readRegisteredStagingInclusion(f.ctx, f.query)).toEqual(missing);
    await f.db.update(testParts).set({ commit: CANDIDATE });
    await f.db.update(stagingOperations).set({ expectedRef: 'refs/heads/main' }).where(eq(stagingOperations.kind, 'publish_turn'));
    expect(await readRegisteredStagingInclusion(f.ctx, f.query)).toEqual(missing);
    await f.db.delete(testParts);
    expect(await readRegisteredStagingInclusion(f.ctx, f.query)).toEqual(missing);
  });
  it('requires the submission member and both exact publication operations', async () => {
    const f = await stagingStateFixture(); await f.db.update(stagingBatches).set({ submissionIds: [randomUUID()] });
    expect(await readRegisteredStagingInclusion(f.ctx, f.query)).toEqual(missing);
    await f.db.update(stagingBatches).set({ submissionIds: [f.submission.id] });
    await f.db.delete(stagingOperations).where(eq(stagingOperations.kind, 'publish_staging'));
    expect(await readRegisteredStagingInclusion(f.ctx, f.query)).toEqual(missing);
  });
  it('returns a copy and never changes any stored source or receipt', async () => {
    const f = await stagingStateFixture(), before = await f.db.select().from(taskWorkspaceSubmissions);
    const value = await readRegisteredStagingInclusion(f.ctx, f.query);
    expect(value).toHaveProperty('integrationCommitSha', CANDIDATE);
    if ('receiptId' in value) value.integrationCommitSha = HEAD;
    expect((await f.db.select().from(taskWorkspaceMergeReceipts))[0]!.integrationCommitSha).toBe(CANDIDATE);
    expect(await f.db.select().from(taskWorkspaceSubmissions)).toEqual(before);
  });
});
