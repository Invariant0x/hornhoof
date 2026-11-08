import { turnCleanupDefault } from './echelons-update.js';
import type { EchelonsSnapshot, EchelonStep } from '@hornhoof/protocol/echelons';
import { and, eq, inArray } from 'drizzle-orm';
import { taskRoutes } from '../../db/schema.js';
import type { Db } from '../../db/client.js';
import { ApiError } from '../../errors.js';
import type { Task, Tx } from './engine.js';

export type Route = typeof taskRoutes.$inferSelect;
export type RouteInput = { resultKind?: EchelonsSnapshot['resultKind']; reviewerAgentId?: string; securityAgentId?: string; testsAgentId?: string; cleanup?: boolean; paths?: string[] };

function routeStep(name: EchelonStep['stage'], current: EchelonStep['stage'], ownerAgentId: string | null = null): EchelonStep {
  return { stage: name, status: name === current ? 'active' : 'pending', ownerAgentId, reason: null, inputCandidateId: null, candidateId: null };
}

function architectureStep(task: Task, current: EchelonStep['stage']): EchelonStep {
  const step = routeStep('architecture', current, task.assigneeAgentId);
  if (task.small) Object.assign(step, { status: 'skipped', reason: 'small_task', ownerAgentId: null });
  return step;
}

function securityState(task: Task, input: RouteInput, current: EchelonStep['stage']): { step: EchelonStep; security: Route['state']['security'] } {
  const required = task.riskClass !== null && task.riskClass !== 'none';
  const step = routeStep('security', current, input.securityAgentId ?? null);
  if (!required) Object.assign(step, { status: 'skipped', reason: 'no_declared_risk' });
  return { step, security: { required, reason: required ? task.riskClass : null, addedBy: required ? task.createdByAgentId : null } };
}

function codeState(task: Task, input: RouteInput, cleanup: boolean): Route['state'] {
  const stage = task.small ? 'development' : 'architecture';
  const { step: security, security: policy } = securityState(task, input, stage);
  return { kind: 'development_echelons', version: 1, resultKind: 'code', stage, phase: 'active', candidateId: null, assignment: null,
    stages: [architectureStep(task, stage), routeStep('development', stage, task.executorAgentId ?? task.assigneeAgentId), routeStep('review', stage, input.reviewerAgentId ?? null),
      ...(cleanup ? [routeStep('cleanup', stage)] : []), security, routeStep('tests', stage, input.testsAgentId ?? null)], security: policy,
  };
}

export async function createRoute(tx: Tx, task: Task, input: RouteInput): Promise<void> {
  const cleanup = input.cleanup ?? await turnCleanupDefault(tx, task);
  const resultKind = input.resultKind ?? (task.executorAgentId ? 'code' : 'coordination');
  if (resultKind === 'coordination') {
    await tx.insert(taskRoutes).values({ taskId: task.id, companyId: task.companyId, paths: [], state: {
      kind: 'development_echelons', version: 1, resultKind, stage: null, phase: 'active', candidateId: null, assignment: null, stages: [],
      security: { required: false, reason: null, addedBy: null },
    } });
    return;
  }
  await tx.insert(taskRoutes).values({ taskId: task.id, companyId: task.companyId, paths: input.paths ?? [], state: codeState(task, input, cleanup) });
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

/* The task version and route revision are changed in the same transaction. */
export async function changeRoute(tx: Tx, before: Route, state: Route['state'], paths = before.paths): Promise<void> {
  const [changed] = await tx.update(taskRoutes).set({ state, paths, revision: before.revision + 1 })
    .where(and(eq(taskRoutes.taskId, before.taskId), eq(taskRoutes.companyId, before.companyId), eq(taskRoutes.revision, before.revision))).returning({ id: taskRoutes.taskId });
  if (!changed) throw new ApiError(409, 'conflict', 'The route changed meanwhile. Read the task again.', 'task_changed');
}
