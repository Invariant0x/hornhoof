import { randomUUID } from 'node:crypto';
import { agents, companies, jobs, people, stagingBatches, stagingOperations, stagingPlans, stagingTrials, subscriptions,
  tasks, taskWorkspaceMergeReceipts, taskWorkspaces, taskWorkspaceSubmissions, testParts, testRuns, turns, workspaceRepositories } from '../src/db/schema.js';
import { createTestDb } from './helpers-db.js';

export const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40), CANDIDATE = 'c'.repeat(40);

/* Persisted private rows only. This fixture is not an admission or protected-node acknowledgement. */
export async function stagingStateFixture() {
  const db = await createTestDb();
  const [company] = await db.insert(companies).values({ name: 'Private staging fixture' }).returning();
  const [person] = await db.insert(people).values({ companyId: company!.id, name: 'Owner', email: 'owner@example.test', status: 'active', scopeKind: 'company' }).returning();
  const [subscription] = await db.insert(subscriptions).values({ companyId: company!.id, provider: 'claude', kind: 'personal', label: 'Fixture', ownerPersonId: person!.id, status: 'ready' }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company!.id, kind: 'worker', name: 'Worker', model: '' }).returning();
  const [turn] = await db.insert(turns).values({ companyId: company!.id, number: 8, goal: 'Fixture turn' }).returning();
  const [task] = await db.insert(tasks).values({ companyId: company!.id, turnId: turn!.id, number: 1, title: 'Accepted source' }).returning();
  const [job] = await db.insert(jobs).values({ companyId: company!.id, subscriptionId: subscription!.id, agentId: agent!.id, taskId: task!.id, prompt: 'Fixture', timeoutMs: 1000 }).returning();
  const [repository] = await db.insert(workspaceRepositories).values({ companyId: company!.id, canonicalUrl: 'https://git.example/team/project' }).returning();
  const [workspace] = await db.insert(taskWorkspaces).values({ companyId: company!.id, repositoryId: repository!.id, taskId: task!.id, agentId: agent!.id,
    builtin: true, assignmentEpoch: 0, bindingVersion: 1, taskBranch: 'task-1', baseSha: BASE, baseRef: 'turn-8', areas: ['apps'],
    requiredIntegrations: [{ kind: 'turn', ref: 'turn-8' }], submissionRevision: 1, phase: 'merge_pending' }).returning();
  const [submission] = await db.insert(taskWorkspaceSubmissions).values({ companyId: company!.id, workspaceId: workspace!.id, bindingVersion: 1, revision: 1,
    headSha: HEAD, publicationReceiptId: randomUUID(), publication: {}, phase: 'metadata_only', sealedAt: new Date() }).returning();
  const [plan] = await db.insert(stagingPlans).values({ companyId: company!.id, repositoryId: repository!.id, turnId: turn!.id, generation: 1,
    baseRef: 'turn-8', baseSha: BASE, requiredIntegrations: [{ kind: 'turn', ref: 'turn-8' }], enabled: true }).returning();
  const [batch] = await db.insert(stagingBatches).values({ companyId: company!.id, planId: plan!.id, planGeneration: 1, baseSha: BASE,
    submissionIds: [submission!.id], sourceSnapshot: [{ submissionId: submission!.id }], idempotencyKey: randomUUID(), phase: 'published', completedAt: new Date() }).returning();
  const [run] = await db.insert(testRuns).values({ companyId: company!.id, number: 1, taskId: task!.id, agentId: agent!.id, jobId: job!.id,
    kind: 'tests', branch: 'immutable-trial', commitSha: CANDIDATE, command: 'fixture affected tests', parts: 1, timeoutMs: 1000, status: 'passed', finishedAt: new Date() }).returning();
  const [part] = await db.insert(testParts).values({ companyId: company!.id, runId: run!.id, part: 1, builtin: true,
    commit: CANDIDATE, status: 'passed', exitCode: 0, finishedAt: new Date() }).returning();
  const [trial] = await db.insert(stagingTrials).values({ companyId: company!.id, batchId: batch!.id, ordinal: 1, submissionIds: [submission!.id],
    candidateSha: CANDIDATE, treeSha: 'd'.repeat(40), candidateRef: `refs/tags/turn-8-staging-${batch!.id}-${randomUUID()}`,
    testRunId: run!.id, partIds: [part!.id], phase: 'published' }).returning();
  for (const [kind, ref] of [['publish_staging', 'refs/heads/turn-8-staging'], ['publish_turn', 'refs/heads/turn-8']] as const) {
    await db.insert(stagingOperations).values({ companyId: company!.id, batchId: batch!.id, trialId: trial!.id, kind,
      idempotencyKey: `${batch!.id}:${kind}`, phase: 'confirmed', expectedRef: ref, expectedBeforeSha: BASE, expectedAfterSha: CANDIDATE,
      sourceNode: { kind: 'builtin' }, payload: {}, result: { status: 'published', ref, commitSha: CANDIDATE }, settledAt: new Date() });
  }
  const confirmedAt = new Date('2026-11-06T12:00:00.000Z');
  const [receipt] = await db.insert(taskWorkspaceMergeReceipts).values({ id: randomUUID(), companyId: company!.id, workspaceId: workspace!.id, bindingVersion: 1,
    repositoryId: repository!.id, taskId: task!.id, submissionRevision: 1, taskBranch: 'task-1', submittedHeadSha: HEAD,
    publicationReceiptId: submission!.publicationReceiptId!, integrationKind: 'turn', integrationRef: 'turn-8', integrationCommitSha: CANDIDATE,
    batchOrReleaseId: batch!.id, confirmedAt }).returning();
  const query = { repositoryId: repository!.id, taskId: task!.id, workspaceId: workspace!.id, bindingVersion: 1, submissionRevision: 1,
    taskBranch: 'task-1', submittedHeadSha: HEAD, publicationReceiptId: submission!.publicationReceiptId!, target: { kind: 'turn' as const, ref: 'turn-8' } };
  return { db, ctx: { db, companyId: company!.id }, company: company!, task: task!, job: job!, agent: agent!, repository: repository!, workspace: workspace!,
    submission: submission!, plan: plan!, batch: batch!, run: run!, part: part!, trial: trial!, receipt: receipt!, query };
}
