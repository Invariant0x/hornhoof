import type { EchelonsSnapshot, EchelonStep } from '@hornhoof/protocol/echelons';
import { and, eq, inArray } from 'drizzle-orm';
import { taskRoutes } from '../../db/schema.js';
import type { Db } from '../../db/client.js';
import { ApiError } from '../../errors.js';
import type { Task, Tx } from './engine.js';

export type Route = typeof taskRoutes.$inferSelect;
export type RouteInput = { reviewerAgentId?: string; securityAgentId?: string; testsAgentId?: string; cleanup?: boolean; paths?: string[] };

export async function createRoute(tx: Tx, task: Task, input: RouteInput): Promise<void> {
  const stage = task.small ? 'development' : 'architecture';
  const required = task.riskClass !== null && task.riskClass !== 'none';
  const step = (name: EchelonStep['stage'], ownerAgentId: string | null = null): EchelonStep => ({
    stage: name, status: name === stage ? 'active' : 'pending', ownerAgentId, reason: null, inputCandidateId: null, candidateId: null,
  });
  const architecture = step('architecture', task.assigneeAgentId);
  if (task.small) Object.assign(architecture, { status: 'skipped', reason: 'small_task', ownerAgentId: null });
  const security = step('security', input.securityAgentId ?? null);
  if (!required) Object.assign(security, { status: 'skipped', reason: 'no_declared_risk' });
  await tx.insert(taskRoutes).values({ taskId: task.id, companyId: task.companyId, paths: input.paths ?? [], state: {
    kind: 'development_echelons', version: 1, stage, phase: 'active', candidateId: null, assignment: null,
    stages: [architecture, step('development', task.executorAgentId ?? task.assigneeAgentId), step('review', input.reviewerAgentId ?? null), ...(input.cleanup ? [step('cleanup')] : []), security, step('tests', input.testsAgentId ?? null)],
    security: { required, reason: required ? task.riskClass : null, addedBy: required ? task.createdByAgentId : null },
  } });
}

export async function routeOf(db: Db | Tx, task: Pick<Task, 'id' | 'companyId'>): Promise<Route> {
  const [route] = await db.select().from(taskRoutes).where(and(eq(taskRoutes.taskId, task.id), eq(taskRoutes.companyId, task.companyId)));
  if (!route) throw new ApiError(409, 'conflict', 'This task has no required route. Complete the documented release data preparation.', 'task_invalid');
  return route;
}

export function routeSnapshot(route: Route, ownerAgentId: string | null): EchelonsSnapshot {
  return { ...route.state, revision: route.revision, ownerAgentId };
}

export async function routeSnapshots(db: Db, rows: Pick<Task, 'id' | 'companyId' | 'assigneeAgentId'>[]): Promise<Map<string, EchelonsSnapshot>> {
  const routes = rows.length ? await db.select().from(taskRoutes).where(inArray(taskRoutes.taskId, rows.map(t => t.id))) : [];
  return new Map(rows.map(task => {
    const route = routes.find(r => r.taskId === task.id && r.companyId === task.companyId);
    if (!route) throw new ApiError(409, 'conflict', 'A task has no required route. Complete the documented release data preparation.', 'task_invalid');
    return [task.id, routeSnapshot(route, task.assigneeAgentId)];
  }));
}

/* The task version and route revision are changed in the same transaction. */
export async function changeRoute(tx: Tx, before: Route, state: Route['state']): Promise<void> {
  const [changed] = await tx.update(taskRoutes).set({ state, revision: before.revision + 1 })
    .where(and(eq(taskRoutes.taskId, before.taskId), eq(taskRoutes.companyId, before.companyId), eq(taskRoutes.revision, before.revision))).returning({ id: taskRoutes.taskId });
  if (!changed) throw new ApiError(409, 'conflict', 'The route changed meanwhile. Read the task again.', 'task_changed');
}
