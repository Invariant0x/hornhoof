import type { ExternalConsumer } from '@hornhoof/protocol';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, externalOperations, externalRecoveryCases, externalRecoveryMembers, jobs, people, subscriptions, taskEvents, tasks, taskWaits, testParts, testRuns, waitNotices } from '../src/db/schema.js';
import type { Actor, Tx } from '../src/modules/tasks/engine.js';
import type { TaskWait } from '../src/modules/tasks/wait-state.js';
import * as external from '../src/modules/failures/external.js';
import { createTestDb } from './helpers.js';

type WaitSource = { caseId: string; operationId: string; sourceRevision: number; actor: Actor };
const adapter = external as unknown as {
  syncGitOperationWait?: (tx: Tx, source: WaitSource) => Promise<TaskWait>;
  endGitOperationWait?: (tx: Tx, source: WaitSource & { proofRef: string }) => Promise<TaskWait | null>;
};
const FIRST = new Date('2030-01-01T10:00:00Z');
const DUE = new Date('2030-01-01T10:15:00Z');
const NEXT = new Date('2030-01-01T10:01:00Z');
const SHA = 'a'.repeat(40);

/* These rows represent an already-registered private source. This fixture is
   not a substitute for #456 registration, current credentials or a node grant. */
async function fixture() {
  const db = await createTestDb();
  const [company, foreign] = await db.insert(companies).values([{ name: 'Acme' }, { name: 'Other', singleton: false }]).returning();
  const [development, operations] = await db.insert(departments).values([
    { companyId: company!.id, templateKey: 'development', roleCode: 'DEV' },
    { companyId: company!.id, templateKey: 'operations', roleCode: 'OPS' },
  ]).returning();
  const [author, owner, head, stranger] = await db.insert(agents).values([
    { companyId: company!.id, departmentId: development!.id, kind: 'worker', name: 'Author', model: '' },
    { companyId: company!.id, departmentId: operations!.id, kind: 'worker', name: 'Operations', model: '' },
    { companyId: company!.id, departmentId: operations!.id, kind: 'head', name: 'Operations head', model: '' },
    { companyId: foreign!.id, kind: 'worker', name: 'Stranger', model: '' },
  ]).returning();
  const [person] = await db.insert(people).values({ companyId: company!.id, name: 'Pat', email: 'pat@example.test' }).returning();
  const [subscription] = await db.insert(subscriptions).values({ companyId: company!.id, ownerPersonId: person!.id, provider: 'codex', kind: 'personal', label: 'Plan' }).returning();
  const unrelated = { reason: 'Unrelated promise', since: FIRST.toISOString(), until: '2030-01-02T10:00:00Z' };
  const [task] = await db.insert(tasks).values({ companyId: company!.id, departmentId: development!.id, number: 1, title: 'Original work', status: 'working', assigneeAgentId: author!.id, externalWait: unrelated }).returning();
  const [job] = await db.insert(jobs).values({ companyId: company!.id, subscriptionId: subscription!.id, agentId: author!.id, taskId: task!.id, kind: 'conversation', status: 'running', prompt: 'Original work', timeoutMs: 60000 }).returning();
  const [episode] = await db.insert(externalRecoveryCases).values({ companyId: company!.id, scopeDigest: 'b'.repeat(64), adapter: 'git', endpointDigest: 'c'.repeat(64), credentialRevision: 1, failureFamily: 'transport', firstFailureAt: FIRST, opsDeadlineAt: DUE, nextAttemptAt: NEXT, policyRevision: 1, ownerAgentId: owner!.id }).returning();
  const newOperation = async (consumer: ExternalConsumer = { kind: 'agent_job', jobId: job!.id, workspaceBinding: 'd'.repeat(64) }) => {
    const [operation] = await db.insert(externalOperations).values({ companyId: company!.id, intentDigest: randomUUID().replaceAll('-', '').repeat(2), intent: { kind: 'git_push', repositoryId: randomUUID(), sourceSha: SHA, destinationRef: 'refs/heads/task-1' }, consumer, state: 'deferred' }).returning();
    await db.insert(externalRecoveryMembers).values({ companyId: company!.id, caseId: episode!.id, operationId: operation!.id });
    return operation!;
  };
  const operation = await newOperation();
  const source: WaitSource = { caseId: episode!.id, operationId: operation.id, sourceRevision: 1, actor: { agentId: author!.id } };
  const sync = (change: Partial<WaitSource> = {}) => db.transaction(tx => adapter.syncGitOperationWait?.(tx, { ...source, ...change }));
  const end = (change: Partial<WaitSource> = {}) => db.transaction(tx => adapter.endGitOperationWait?.(tx, { ...source, ...change, proofRef: `receipt:${operation.id}` }));
  return { db, company: company!, foreign: foreign!, development: development!, operations: operations!, author: author!, owner: owner!, head: head!, stranger: stranger!, task: task!, job: job!, episode: episode!, operation, unrelated, source, sync, end, newOperation };
}

describe('registered Git operation accountability', () => {
  it('derives the task, Operations owner and one-shot plan from private records', async () => {
    const f = await fixture();
    const wait = await f.sync();
    expect(wait).toMatchObject({ taskId: f.task.id, companyId: f.company.id, sourceKey: `operation:${f.operation.id}`, kind: 'external', state: 'active', sourceRevision: 1, generation: 1, ownerAgentId: f.owner.id, sourceState: { stage: 'retry', route: 'operations', nextActionAt: NEXT.toISOString() } });
    expect(wait!.plan).toEqual({ version: 1, ownerDueAt: DUE.toISOString(), headDueAt: DUE.toISOString(), decisionDueAt: DUE.toISOString(), provenance: { kind: 'source_contract', actor: { agentId: f.author.id }, ref: `operation:${f.operation.id}`, revision: 1, origin: 'external_git' }, finalReview: { headAgentId: f.head.id, anchorAt: DUE.toISOString(), intervalMs: null } });
    expect(await f.db.select().from(waitNotices)).toEqual([]);
    expect(JSON.stringify(await f.db.select().from(taskEvents))).not.toContain(f.operation.intentDigest);
  });

  it('keeps one wait and the original deadline when only the next attempt changes', async () => {
    const f = await fixture();
    const first = await f.sync();
    expect(first).toBeDefined();
    expect(await f.sync()).toEqual(first);
    const next = new Date('2030-01-01T10:03:00Z');
    await f.db.update(externalRecoveryCases).set({ nextAttemptAt: next }).where(eq(externalRecoveryCases.id, f.episode.id));
    await f.db.update(externalOperations).set({ generation: 9, state: 'outcome_unknown' }).where(eq(externalOperations.id, f.operation.id));
    const updated = await f.sync({ sourceRevision: 2 });
    expect(updated).toMatchObject({ id: first!.id, generation: 1, sourceRevision: 2, sourceState: { stage: 'waiting', nextActionAt: next.toISOString() }, ownerDueAt: DUE });
    expect((await f.db.select().from(taskWaits))).toHaveLength(1);
    await expect(f.sync({ sourceRevision: 1 })).rejects.toMatchObject({ status: 409, reason: 'task_changed' });
  });

  it('ends only the settled operation and preserves unrelated task waiting', async () => {
    const f = await fixture();
    const first = await f.sync();
    expect(first).toBeDefined();
    const second = await f.newOperation();
    const other = await f.sync({ operationId: second.id });
    expect(other).toBeDefined();
    await expect(f.end()).rejects.toMatchObject({ status: 409, reason: 'task_changed' });
    await f.db.update(externalOperations).set({ state: 'satisfied', finishedAt: new Date() }).where(eq(externalOperations.id, f.operation.id));
    const ended = await f.end({ sourceRevision: 2 });
    expect(ended).toMatchObject({ id: first!.id, state: 'resolved', sourceRevision: 2 });
    expect(await f.end({ sourceRevision: 2 })).toEqual(ended);
    expect((await f.db.select().from(taskWaits).where(eq(taskWaits.id, other!.id)))[0]!.state).toBe('active');
    expect((await f.db.select().from(tasks).where(eq(tasks.id, f.task.id)))[0]!.externalWait).toEqual(f.unrelated);
    expect(await f.db.select().from(jobs)).toHaveLength(1);
  });

  it.each(['cancelled', 'failed_permanent'] as const)('ends a %s operation without inventing success', async state => {
    const f = await fixture();
    expect(await f.sync()).toBeDefined();
    await f.db.update(externalOperations).set({ state }).where(eq(externalOperations.id, f.operation.id));
    expect(await f.end({ sourceRevision: 2 })).toMatchObject({ state: state === 'cancelled' ? 'cancelled' : 'resolved' });
    expect((await f.db.select().from(externalOperations))[0]!.state).toBe(state);
  });

  it('rejects a foreign actor and a source outside the selected episode without wait writes', async () => {
    const f = await fixture();
    await expect(f.sync({ actor: { agentId: f.stranger.id } })).rejects.toMatchObject({ status: 403 });
    await expect(f.sync({ caseId: randomUUID() })).rejects.toMatchObject({ status: 404 });
    expect(await f.db.select().from(taskWaits)).toEqual([]);
    expect(await f.db.select().from(taskEvents)).toEqual([]);
  });

  it('refuses to create a wait on a closed task', async () => {
    const f = await fixture();
    await f.db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(eq(tasks.id, f.task.id));
    await expect(f.sync()).rejects.toMatchObject({ status: 409, reason: 'task_closed' });
    expect(await f.db.select().from(taskWaits)).toEqual([]);
  });

  it('rolls source and wait changes back in the caller transaction', async () => {
    const f = await fixture();
    await expect(f.db.transaction(async tx => {
      await tx.update(externalRecoveryCases).set({ nextAttemptAt: DUE }).where(eq(externalRecoveryCases.id, f.episode.id));
      expect(await adapter.syncGitOperationWait?.(tx, f.source)).toBeDefined();
      throw new Error('Abort source transition');
    })).rejects.toThrow('Abort source transition');
    expect(await f.db.select().from(taskWaits)).toEqual([]);
    expect(await f.db.select().from(taskEvents)).toEqual([]);
    expect((await f.db.select().from(externalRecoveryCases))[0]!.nextAttemptAt).toEqual(NEXT);
  });

  it.each(['owner_missing', 'owner_removed', 'head_removed', 'owner_outside_operations'] as const)('shows an honest unplanned wait when %s', async missing => {
    const f = await fixture();
    if (missing === 'owner_missing') await f.db.update(externalRecoveryCases).set({ ownerAgentId: null }).where(eq(externalRecoveryCases.id, f.episode.id));
    if (missing === 'owner_removed') await f.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, f.owner.id));
    if (missing === 'head_removed') await f.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, f.head.id));
    if (missing === 'owner_outside_operations') await f.db.update(agents).set({ departmentId: f.development.id }).where(eq(agents.id, f.owner.id));
    const wait = await f.sync();
    expect(wait).toMatchObject({ state: 'legacy_needs_plan', plan: null, ownerDueAt: null, headDueAt: null, decisionDueAt: null, nextReviewAt: null });
    expect((await f.db.select().from(externalRecoveryCases))[0]!.opsDeadlineAt).toEqual(DUE);
    expect(await f.db.select().from(waitNotices)).toEqual([]);
  });

  it('keeps a committed test part accountable after the author job ends', async () => {
    const f = await fixture();
    const [run] = await f.db.insert(testRuns).values({ companyId: f.company.id, number: 1, taskId: f.task.id, agentId: f.author.id, jobId: f.job.id, command: 'test', timeoutMs: 60000, commitSha: SHA }).returning();
    const [part] = await f.db.insert(testParts).values({ companyId: f.company.id, runId: run!.id, part: 1 }).returning();
    await f.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, f.job.id));
    const operation = await f.newOperation({ kind: 'test_part', runId: run!.id, ordinal: 1, attemptId: part!.id, commitSha: SHA });
    expect(await f.sync({ operationId: operation.id })).toMatchObject({ taskId: f.task.id, state: 'active' });
    await f.db.update(testRuns).set({ commitSha: 'e'.repeat(40) }).where(eq(testRuns.id, run!.id));
    await expect(f.sync({ operationId: operation.id, sourceRevision: 2 })).rejects.toMatchObject({ status: 409 });
  });

  it('does not invent a task for an unregistered server continuation', async () => {
    const f = await fixture();
    const operation = await f.newOperation({ kind: 'server_read', requestId: randomUUID(), registeredContinuation: 'test_run_admission' });
    await expect(f.sync({ operationId: operation.id })).rejects.toMatchObject({ status: 503, code: 'unavailable' });
    expect(await f.db.select().from(taskWaits)).toEqual([]);
    expect(await f.db.select().from(tasks)).toHaveLength(1);
  });
});
