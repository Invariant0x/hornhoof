import type { EchelonsSnapshot } from '@hornhoof/protocol/echelons';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { taskRoutes } from '../../db/schema.js';
import type { Db } from '../../db/client.js';
import { ApiError } from '../../errors.js';
import { type Task, type Tx } from './state.js';
import { ownNote } from './events.js';
export type Route = typeof taskRoutes.$inferSelect;

export const AUTHOR_CHECK_PASSED = 'author_check_passed';

export function skippedAuthorReview(state: Route['state']) {
  return state.stages.find(step => step.stage === 'review' && step.status === 'skipped' && step.reason === AUTHOR_CHECK_PASSED);
}

export async function routeOf(db: Db | Tx, task: Pick<Task, 'id' | 'companyId'>): Promise<Route> {
  const [route] = await db.select().from(taskRoutes).where(and(eq(taskRoutes.taskId, task.id), eq(taskRoutes.companyId, task.companyId)));
  if (!route) throw new ApiError(409, 'conflict', 'This task has no required route. Complete the documented release data preparation.', 'task_invalid');
  return route;
}

export function routeSnapshot(route: Route, ownerAgentId: string | null): EchelonsSnapshot {
  return { ...route.state, revision: route.revision, ownerAgentId };
}

export async function routeSnapshots(db: Db | Tx, rows: Pick<Task, 'id' | 'companyId' | 'assigneeAgentId'>[]): Promise<Map<string, EchelonsSnapshot>> {
  const routes = rows.length ? await db.select().from(taskRoutes).where(inArray(taskRoutes.taskId, rows.map(t => t.id))) : [];
  return new Map(rows.map(task => {
    const route = routes.find(r => r.taskId === task.id && r.companyId === task.companyId);
    if (!route) throw new ApiError(409, 'conflict', 'A task has no required route. Complete the documented release data preparation.', 'task_invalid');
    return [task.id, routeSnapshot(route, task.assigneeAgentId)];
  }));
}

/* A task closed past its route keeps its stages as they stood, and its phase says only how the record ended: cancelled, the
   work ended unfinished; done, the orchestrator closed it, which accepts nothing. */
export async function endRoutes(tx: Tx, companyId: string, taskIds: string[], phase: 'done' | 'cancelled'): Promise<void> {
  if (!taskIds.length) return;
  await tx.update(taskRoutes).set({ state: sql`jsonb_set(${taskRoutes.state}, '{phase}', ${JSON.stringify(phase)}::jsonb)`, revision: sql`${taskRoutes.revision} + 1` })
    .where(and(inArray(taskRoutes.taskId, taskIds), eq(taskRoutes.companyId, companyId)));
}

export const cancelRoutes = (tx: Tx, companyId: string, taskIds: string[]): Promise<void> => endRoutes(tx, companyId, taskIds, 'cancelled');

/* The task version and route revision are changed in the same transaction. */
export async function changeRoute(tx: Tx, before: Route, state: Route['state'], paths = before.paths): Promise<void> {
  const [changed] = await tx.update(taskRoutes).set({ state, paths, revision: before.revision + 1 })
    .where(and(eq(taskRoutes.taskId, before.taskId), eq(taskRoutes.companyId, before.companyId), eq(taskRoutes.revision, before.revision))).returning({ id: taskRoutes.taskId });
  if (!changed) throw new ApiError(409, 'conflict', 'The route changed meanwhile. Read the task again.', 'task_changed');
  const previous = before.state.stages.find(step => step.stage === 'review' && step.status === 'active');
  if (!previous?.ownerAgentId) return;
  const next = state.stages.find(step => step.stage === 'review');
  if (next?.ownerAgentId === previous.ownerAgentId && next.inputCandidateId === previous.inputCandidateId
    && (next.status === 'active' || next.status === 'complete')) return;
  /* A displaced owner may have left no verdict or repair. Keep the assignment with the route change. */
  await ownNote(tx, { id: before.taskId, companyId: before.companyId }, {
    kind: 'comment', text: 'The previous Review assignment was recorded.',
    data: { pastReviewOwner: { agentId: previous.ownerAgentId, candidateId: previous.inputCandidateId } },
  });
}
