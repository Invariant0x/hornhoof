import { turnCleanupDefault } from './echelons-update.js';
import type { EchelonsSnapshot, EchelonStep } from '@hornhoof/protocol/echelons';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { departments, taskRoutes } from '../../db/schema.js';
import type { Db } from '../../db/client.js';
import { ApiError } from '../../errors.js';
import type { StageRoute } from '../templates/load.js';
import { refuse, type Task, type Tx } from './engine.js';
import { throughEchelons } from './turnkey.js';

export type Route = typeof taskRoutes.$inferSelect;
export type RouteInput = { resultKind?: 'code' | 'coordination'; reviewerAgentId?: string; securityAgentId?: string; testsAgentId?: string; cleanup?: boolean; paths?: string[] };

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

const NO_SECURITY: Route['state']['security'] = { required: false, reason: null, addedBy: null };

/* A stage the route of the department lacks takes no owner, and Cleanup cannot be asked for where there is none. */
function requireStages(task: Task, plan: StageRoute, input: RouteInput, cleanup: boolean): void {
  const asked: [EchelonStep['stage'], unknown][] = [['review', input.reviewerAgentId], ['security', input.securityAgentId], ['tests', input.testsAgentId], ['cleanup', cleanup]];
  const missing = asked.find(([stage, wanted]) => wanted && !plan.stages.some(step => step.stage === stage));
  if (missing) throw refuse(409, 'task_invalid', `The route of this department has no ${missing[0]} stage for #${task.number}.`);
}

function codeState(task: Task, input: RouteInput, cleanup: boolean, plan: StageRoute): Route['state'] {
  requireStages(task, plan, input, cleanup);
  const has = (name: EchelonStep['stage']) => plan.stages.some(step => step.stage === name);
  const stage = has('architecture') && !task.small ? 'architecture' : 'development';
  const { step: security, security: policy } = securityState(task, input, stage);
  const steps: Record<EchelonStep['stage'], EchelonStep | null> = {
    architecture: architectureStep(task, stage), development: routeStep('development', stage, task.executorAgentId ?? task.assigneeAgentId),
    review: routeStep('review', stage, input.reviewerAgentId ?? null), cleanup: cleanup ? routeStep('cleanup', stage) : null,
    security, tests: routeStep('tests', stage, input.testsAgentId ?? null),
  };
  return { kind: 'development_echelons', version: 1, resultKind: 'code', stage, phase: 'active', candidateId: null, assignment: null,
    stages: plan.stages.flatMap(step => steps[step.stage] ?? []), abilities: Object.fromEntries(plan.stages.flatMap(step => step.ability ? [[step.stage, step.ability]] : [])),
    security: has('security') ? policy : NO_SECURITY,
  };
}

/* Work done end to end by its holder alone: no stage, no candidate and nobody else called onto it, even when checkers are named. */
async function turnkeyRoute(tx: Tx, task: Task, input: RouteInput): Promise<void> {
  await tx.insert(taskRoutes).values({ taskId: task.id, companyId: task.companyId, paths: input.paths ?? [], state: {
    kind: 'development_echelons', version: 1, resultKind: 'turnkey', stage: null, phase: 'active', candidateId: null, assignment: null, stages: [], abilities: {}, security: NO_SECURITY,
  } });
}

/* The stages the work of a department goes through, as its template lays them out. */
export async function departmentStages(ctx: Pick<Ctx, 'db' | 'templates'>, departmentId: string | null): Promise<StageRoute> {
  const [department] = departmentId ? await ctx.db.select({ key: departments.templateKey }).from(departments).where(eq(departments.id, departmentId)) : [];
  return ctx.templates.stagesOf(department?.key ?? null);
}

/* A result made of the accepted results under it: no stage and no candidate of its own. */
export async function createCoordinationRoute(tx: Tx, task: Task): Promise<void> {
  await tx.insert(taskRoutes).values({ taskId: task.id, companyId: task.companyId, paths: [], state: {
    kind: 'development_echelons', version: 1, resultKind: 'coordination', stage: null, phase: 'active', candidateId: null, assignment: null, stages: [], abilities: {}, security: NO_SECURITY,
  } });
}

export async function createRoute(tx: Tx, task: Task, input: RouteInput, plan: StageRoute): Promise<void> {
  const resultKind = input.resultKind ?? (task.executorAgentId ? 'code' : 'coordination');
  if (resultKind === 'coordination') return createCoordinationRoute(tx, task);
  if (!(await throughEchelons(tx, task))) return turnkeyRoute(tx, task, input);
  /* The head's Cleanup for a whole turn reaches only the departments whose route has it. */
  const cleanup = input.cleanup ?? (plan.stages.some(step => step.stage === 'cleanup') && await turnCleanupDefault(tx, task));
  await tx.insert(taskRoutes).values({ taskId: task.id, companyId: task.companyId, paths: input.paths ?? [], state: codeState(task, input, cleanup, plan) });
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

/* A cancelled task keeps its stages as they stood, and its phase says the work ended unfinished. */
export async function cancelRoutes(tx: Tx, companyId: string, taskIds: string[]): Promise<void> {
  await tx.update(taskRoutes).set({ state: sql`jsonb_set(${taskRoutes.state}, '{phase}', '"cancelled"')`, revision: sql`${taskRoutes.revision} + 1` })
    .where(and(inArray(taskRoutes.taskId, taskIds), eq(taskRoutes.companyId, companyId)));
}

/* The task version and route revision are changed in the same transaction. */
export async function changeRoute(tx: Tx, before: Route, state: Route['state'], paths = before.paths): Promise<void> {
  const [changed] = await tx.update(taskRoutes).set({ state, paths, revision: before.revision + 1 })
    .where(and(eq(taskRoutes.taskId, before.taskId), eq(taskRoutes.companyId, before.companyId), eq(taskRoutes.revision, before.revision))).returning({ id: taskRoutes.taskId });
  if (!changed) throw new ApiError(409, 'conflict', 'The route changed meanwhile. Read the task again.', 'task_changed');
}
