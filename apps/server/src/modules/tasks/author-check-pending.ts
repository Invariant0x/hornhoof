import { EchelonModel } from '@hornhoof/protocol/echelons';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { ApiError } from '../../errors.js';
import { agentIdentity, checkingIdentity } from './echelons-assign.js';
import { currentCandidate } from './echelons-candidates.js';
import { sameChecker } from './echelons-policy.js';
import { routeOf } from './echelons-store.js';
import type { Task, Tx } from './engine.js';
import { ReviewRecord } from './review-context.js';

const WriteStage = z.enum(['development', 'review', 'security', 'cleanup']);
const Binding = z.object({ stage: WriteStage, candidateId: z.uuid().nullable(), routeRevision: z.number().int().positive(), producer: EchelonModel });
export const AuthorCheckPending = Binding.extend({
  version: z.literal(1), runId: z.uuid(), summary: z.string(), evidence: z.string(), baseCommit: z.string(), authorCheckPlan: z.string(), review: ReviewRecord, operationId: z.uuid().optional(),
}).strict();
export type PendingSubmission = z.infer<typeof AuthorCheckPending>;
type Store = Ctx['db'] | Tx;
const stale = () => new ApiError(409, 'conflict', 'The author-check producer, stage or candidate changed. Read the task before submitting again.', 'task_changed');

export async function authorCheckBinding(db: Store, task: Task, agentId: string): Promise<z.infer<typeof Binding>> {
  const route = await routeOf(db, task);
  const stage = WriteStage.safeParse(route.state.stage);
  if (['done', 'cancelled'].includes(task.status) || task.assigneeAgentId !== agentId || route.state.resultKind !== 'code' || route.state.phase !== 'active' || !stage.success) throw stale();
  const producer = stage.data === 'development' ? await agentIdentity(db, task.companyId, agentId) : await checkingIdentity({ db }, task, route, await currentCandidate(db, task, route));
  if (!producer) throw stale();
  return { stage: stage.data, candidateId: route.state.candidateId, routeRevision: route.revision, producer };
}

export async function assertAuthorCheckBinding(db: Store, task: Task, pending: PendingSubmission, run?: { companyId: string; taskId: string; agentId: string; commitSha: string | null; branch: string | null }): Promise<void> {
  const live = await authorCheckBinding(db, task, pending.producer.agentId);
  if (live.stage !== pending.stage || live.candidateId !== pending.candidateId || live.routeRevision !== pending.routeRevision || !sameChecker(live.producer, pending.producer)) throw stale();
  if (run && (run.companyId !== task.companyId || run.taskId !== task.id || run.agentId !== live.producer.agentId || run.commitSha !== pending.review.commit || run.branch !== pending.review.branch)) throw stale();
}

export function pendingSubmission(data: Record<string, unknown>): PendingSubmission | null {
  return AuthorCheckPending.safeParse(data.authorCheckPending).data ?? null;
}

export function outcomeRun(data: Record<string, unknown>): { runId?: string; status?: string } | null {
  const value = data.authorCheckOutcome;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as { runId?: string; status?: string } : null;
}
