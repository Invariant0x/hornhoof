import { ExternalConsumer } from '@hornhoof/protocol';
import type { WaitOwnerBinding, WaitPlan, WaitSourceState } from '@hornhoof/protocol/waits';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { agents, departments, externalOperations, externalRecoveryCases, externalRecoveryMembers, jobs, tasks, testParts, testRuns } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { CLOSED, refuse, type Actor, type Tx } from '../tasks/engine.js';
import { endSourceWait, operationSourceKey, recordLegacyWait, syncSourceWaits, type TaskWait } from '../tasks/wait-state.js';

type Operation = typeof externalOperations.$inferSelect;
type Episode = typeof externalRecoveryCases.$inferSelect;

/* Private coordinator input, never a node/tool grant. The coordinator advances
   its source revision in the same transaction; physical attempt generation is
   a different fence. Registration and authenticated outcomes are separate. */
export type GitOperationWaitSource = { caseId: string; operationId: string; sourceRevision: number; actor: Actor };

const missingSource = () => refuse(404, 'task_unknown', 'There is no registered operation on this source.');
const changedSource = () => refuse(409, 'task_changed', 'This operation has moved on.');

async function taskOfOperation(tx: Tx, operation: Operation): Promise<string> {
  const consumer = ExternalConsumer.parse(operation.consumer);
  if (consumer.kind === 'server_read') throw new ApiError(503, 'unavailable', 'A registered server continuation is not available.');
  if (consumer.kind === 'test_part') return taskOfPart(tx, operation.companyId, consumer);
  const [job] = await tx.select({ taskId: jobs.taskId }).from(jobs).where(and(eq(jobs.id, consumer.jobId), eq(jobs.companyId, operation.companyId)));
  if (!job?.taskId) throw missingSource();
  return job.taskId;
}

async function taskOfPart(tx: Tx, companyId: string, consumer: Extract<ExternalConsumer, { kind: 'test_part' }>): Promise<string> {
  const [part] = await tx.select({ taskId: testRuns.taskId, commitSha: testRuns.commitSha }).from(testRuns)
    .innerJoin(testParts, and(eq(testParts.runId, testRuns.id), eq(testParts.companyId, companyId)))
    .where(and(eq(testRuns.companyId, companyId), eq(testRuns.id, consumer.runId), eq(testParts.id, consumer.attemptId), eq(testParts.part, consumer.ordinal)));
  if (!part) throw missingSource();
  if (part.commitSha !== consumer.commitSha) throw changedSource();
  return part.taskId;
}

/* Read only to find the task, then lock task -> source -> wait. Callers handling
   several tasks lock them all in UUID order before entering this adapter. */
async function lockedSource(tx: Tx, input: GitOperationWaitSource) {
  const [seen] = await tx.select().from(externalOperations).where(eq(externalOperations.id, input.operationId));
  if (!seen) throw missingSource();
  const taskId = await taskOfOperation(tx, seen);
  const [task] = await tx.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.companyId, seen.companyId))).for('update');
  if (!task) throw missingSource();
  const source = await lockedRecords(tx, input, task.companyId);
  if (await taskOfOperation(tx, source.operation) !== task.id) throw changedSource();
  return { task, ...source };
}

async function lockedRecords(tx: Tx, input: GitOperationWaitSource, companyId: string) {
  const [episode] = await tx.select().from(externalRecoveryCases).where(and(eq(externalRecoveryCases.id, input.caseId), eq(externalRecoveryCases.companyId, companyId))).for('update');
  const [operation] = await tx.select().from(externalOperations).where(and(eq(externalOperations.id, input.operationId), eq(externalOperations.companyId, companyId))).for('update');
  const [member] = await tx.select().from(externalRecoveryMembers).where(and(eq(externalRecoveryMembers.caseId, input.caseId), eq(externalRecoveryMembers.operationId, input.operationId), eq(externalRecoveryMembers.companyId, companyId))).for('update');
  if (!episode || !operation || !member) throw missingSource();
  return { episode, operation, member };
}

async function operationsOwner(tx: Tx, episode: Episode) {
  if (!episode.ownerAgentId) return undefined;
  const [owner] = await tx.select({ id: agents.id, departmentId: departments.id }).from(agents)
    .innerJoin(departments, and(eq(departments.id, agents.departmentId), eq(departments.companyId, episode.companyId), eq(departments.templateKey, 'operations')))
    .where(and(eq(agents.id, episode.ownerAgentId), eq(agents.companyId, episode.companyId), isNull(agents.removedAt)));
  return owner;
}

async function operationsPlan(tx: Tx, episode: Episode, source: GitOperationWaitSource, owner: { departmentId: string } | undefined): Promise<WaitPlan | null> {
  if (!owner) return null;
  const [head] = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, episode.companyId), eq(agents.departmentId, owner.departmentId), eq(agents.kind, 'head'), isNull(agents.removedAt)))
    .orderBy(asc(agents.id)).limit(1);
  if (!head) return null;
  const due = episode.opsDeadlineAt.toISOString();
  return { version: 1, ownerDueAt: due, headDueAt: due, decisionDueAt: due,
    provenance: { kind: 'source_contract', actor: source.actor, ref: operationSourceKey(source.operationId), revision: episode.policyRevision, origin: 'external_git' },
    finalReview: { headAgentId: head.id, anchorAt: due, intervalMs: null } };
}

const waitingState = (operation: Operation, episode: Episode): WaitSourceState => ({
  stage: operation.state === 'deferred' ? 'retry' : 'waiting', route: 'operations',
  ...(episode.nextAttemptAt ? { nextActionAt: episode.nextAttemptAt.toISOString() } : {}),
});

/* Accountability for an already-registered operation, in the source's own
   transaction. It neither registers execution nor sends a notice. */
export async function syncGitOperationWait(tx: Tx, input: GitOperationWaitSource): Promise<TaskWait> {
  const { task, episode, operation, member } = await lockedSource(tx, input);
  if (CLOSED.includes(task.status)) throw refuse(409, 'task_closed', 'This task is closed.');
  if (episode.resolvedAt || member.endedAt || !['deferred', 'outcome_unknown'].includes(operation.state)) throw changedSource();
  const owner = await operationsOwner(tx, episode);
  const ownerBinding: WaitOwnerBinding | undefined = owner ? { agentId: owner.id } : undefined;
  const plan = await operationsPlan(tx, episode, input, owner);
  const source = { taskId: task.id, kind: 'external' as const, sourceKey: operationSourceKey(operation.id), sourceRevision: input.sourceRevision, sourceState: waitingState(operation, episode), actor: input.actor };
  if (!plan || !ownerBinding) return recordLegacyWait(tx, { ...source, ownerBinding });
  return syncSourceWaits(tx, { ...source, ownerBinding, plan });
}

/* Ending accountability is not publication or PASS. A permanent refusal ends
   the wait while preserving the operation's failed_permanent result. */
export async function endGitOperationWait(tx: Tx, input: GitOperationWaitSource & { proofRef: string }): Promise<TaskWait | null> {
  const { task, operation } = await lockedSource(tx, input);
  if (!['satisfied', 'failed_permanent', 'cancelled'].includes(operation.state)) throw changedSource();
  return endSourceWait(tx, { taskId: task.id, kind: 'external', sourceKey: operationSourceKey(operation.id), sourceRevision: input.sourceRevision,
    outcome: operation.state === 'cancelled' ? 'cancelled' : 'resolved', proofRef: input.proofRef, actor: input.actor });
}
