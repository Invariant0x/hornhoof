import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, taskEvents, tasks } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { checkerFor } from './echelons-assign.js';
import { checkedProducer, currentHanded } from './echelons-candidates.js';
import { isStaged } from '@hornhoof/protocol/echelons';
import { changeRoute, checkedScopePaths, routeOf, type Route } from './echelons-store.js';
import { CLOSED, note, published, refuse, type Task, type TaskChange, type Tx, type Wake } from './engine.js';
import { turnkeyTeamOf, turnkeyWork } from './turnkey.js';
import { openTurnOf, workOfOpenTurn } from './turn-department.js';

export async function requireTaskHead(ctx: { db: Ctx['db'] | Tx }, task: Task, agentId: string): Promise<void> {
  const [actor] = await ctx.db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, task.companyId), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  if (!actor || (actor.kind !== 'orchestrator' && !(actor.kind === 'head' && actor.departmentId === task.departmentId))) throw refuse(403, 'task_not_yours', 'Only this department head or the orchestrator may revise the route.');
}

export function withCleanup(route: Route, enabled: boolean): Route['state'] {
  if (route.state.resultKind === 'coordination') return route.state;
  const review = route.state.stages.findIndex(step => step.stage === 'review');
  const at = route.state.stages.findIndex(step => step.stage === route.state.stage);
  if (at > review) throw refuse(409, 'task_invalid', 'Cleanup must be decided before Review hands this result forward.');
  if (enabled && !route.state.abilities.cleanup) throw refuse(409, 'task_invalid', 'The route of this department has no Cleanup stage.');
  const stages = route.state.stages.filter(step => step.stage !== 'cleanup');
  if (enabled) stages.splice(review + 1, 0, { stage: 'cleanup', status: 'pending', ownerAgentId: null, reason: 'requested_by_head', inputCandidateId: null, candidateId: null });
  return { ...route.state, stages };
}

type RouteChange = { state: Route['state']; set: Partial<Task>; paths: string[] };

const changedPaths = (route: Route, change: TaskChange): string[] => checkedScopePaths(change.paths ?? route.paths);

/* Work with no echelons is done by its holder alone and takes no stage, Cleanup or checker. It stays with a member of a
   turnkey team, as the team of who does a task is what takes it past the echelons. */
async function turnkeyChange(ctx: Ctx, task: Task, route: Route, change: TaskChange): Promise<RouteChange> {
  if (change.cleanup !== undefined) throw turnkeyWork(task);
  const paths = changedPaths(route, change);
  const ownerId = change.ownerAgentId ?? change.executor;
  if (!ownerId) return { state: route.state, set: {}, paths };
  await requireAvailableOwner(ctx, task, ownerId);
  if (!(await turnkeyTeamOf(ctx.db, task.companyId, ownerId))) throw refuse(409, 'task_invalid', `#${task.number} goes through no echelons, as a member of a turnkey team does it, so it stays with a member of a turnkey team. Give other work as a new task.`);
  return { state: route.state, set: { assigneeAgentId: ownerId, ...(task.executorAgentId || change.executor ? { executorAgentId: ownerId } : {}), status: 'open', silent: 0 }, paths };
}

export async function prepareRouteChange(ctx: Ctx, task: Task, route: Route, agentId: string, change: TaskChange): Promise<RouteChange> {
  if (route.state.resultKind === 'turnkey') return turnkeyChange(ctx, task, route, change);
  let state = change.cleanup === undefined ? route.state : withCleanup(route, change.cleanup);
  const paths = changedPaths(route, change);
  state = withRisk(state, agentId, change.riskClass);
  requireProducerChange(state, change.executor);
  const ownerId = change.ownerAgentId ?? change.executor;
  const owner = ownerId ? await changedOwner(ctx, task, route, state, ownerId, change.executor) : { state, set: {} };
  return { ...owner, paths };
}

function requireProducerChange(state: Route['state'], executor: TaskChange['executor']): void {
  if (executor && !['architecture', 'development'].includes(state.stage ?? '')) throw refuse(409, 'task_invalid', 'Change the current checking owner, not the original producer.');
}

function withRisk(state: Route['state'], agentId: string, risk: TaskChange['riskClass']): Route['state'] {
  if (risk && risk !== 'none' && isStaged(state.resultKind) && state.stages.some(step => step.stage === 'security')) {
    if (['tests', 'security'].includes(state.stage ?? '') && !state.security.required) throw refuse(409, 'task_invalid', 'A newly discovered risk must be resolved before this result proceeds.');
    return { ...state, security: { required: true, reason: risk, addedBy: agentId }, stages: state.stages.map(step => step.stage === 'security' && step.status === 'skipped' ? { ...step, status: 'pending', reason: null } : step) };
  }
  return state;
}

async function requireAvailableOwner(ctx: Ctx, task: Task, ownerId: string): Promise<void> {
  const [owner] = await ctx.db.select().from(agents).where(and(eq(agents.id, ownerId), eq(agents.companyId, task.companyId), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  if (!owner?.subscriptionId || owner.kind === 'assistant' || owner.departmentId !== task.departmentId || (owner.productId && owner.productId !== task.productId)) throw refuse(403, 'task_not_yours', 'The new owner must be available in this task scope.');
}

async function changedOwner(ctx: Ctx, task: Task, route: Route, state: Route['state'], ownerId: string, executor: TaskChange['executor']): Promise<{ state: Route['state']; set: Partial<Task> }> {
  await requireAvailableOwner(ctx, task, ownerId);
  const team = await turnkeyTeamOf(ctx.db, task.companyId, ownerId);
  if (team) throw refuse(409, 'task_invalid', `The new owner is in ${team.name}, a turnkey team, whose members take only work of their own and never enter the echelons.`);
  const ability = state.stage ? state.abilities[state.stage] : undefined;
  const assignment = ability ? await checkerFor(ctx, task, await checkedProducer(ctx.db, task, route, await currentHanded(ctx.db, task, route)), ability, ownerId) : null;
  if (ability && !assignment) throw refuse(409, 'task_invalid', 'The proposed checker lacks the required ability or model capability.');
  const next: Route['state'] = { ...state, phase: 'active', assignment, stages: state.stages.map(step => step.stage === state.stage ? { ...step, status: 'active', ownerAgentId: ownerId, reason: null } : step) };
  const set: Partial<Task> = { assigneeAgentId: ownerId, status: ability && state.stage !== 'tests' ? 'review' : 'open', silent: 0 };
  if (executor) set.executorAgentId = ownerId;
  return { state: next, set };
}

/* A head decision belongs to its department until its next release, the open turn; it is an event, not a compatibility
   switch. */
export async function turnCleanupDefault(tx: Tx, task: Task): Promise<boolean> {
  const turnId = task.turnId ?? (await openTurnOf(tx, task.companyId, task.departmentId))?.id;
  if (!turnId) return false;
  const [event] = await tx.select(only(taskEvents, 'data')).from(taskEvents).where(and(eq(taskEvents.companyId, task.companyId), eq(taskEvents.kind, 'updated'), sql`${taskEvents.data}->'turnCleanup'->>'turnId' = ${turnId}`, sql`${taskEvents.data}->'turnCleanup'->>'departmentId' = ${task.departmentId}`)).orderBy(desc(taskEvents.id)).limit(1);
  return (event?.data.turnCleanup as { enabled?: boolean } | undefined)?.enabled === true;
}

export async function applyTurnCleanup(tx: Tx, task: Task, turnId: string, agentId: string, enabled: boolean, wakes: Wake[]): Promise<Task[]> {
  const rows = await tx.select().from(tasks).where(and(eq(tasks.companyId, task.companyId), workOfOpenTurn(turnId), eq(tasks.departmentId, task.departmentId!))).orderBy(tasks.id).for('update');
  const changed: Task[] = [];
  for (const row of rows) {
    if (row.id === task.id || CLOSED.includes(row.status)) continue;
    const route = await routeOf(tx, row);
    if (route.state.resultKind !== 'code') continue;
    await changeRoute(tx, route, withCleanup(route, enabled));
    const [next] = await tx.update(tasks).set({ version: row.version + 1, updatedAt: new Date() }).where(eq(tasks.id, row.id)).returning();
    await note(tx, row, { kind: 'updated', actor: { agentId }, text: 'The head changed optional Cleanup for this turn.', data: { fields: ['cleanup'], enabled } });
    if (row.assigneeAgentId) wakes.push({ agentId: row.assigneeAgentId, taskId: row.id, why: 'updated' });
    changed.push(next!);
  }
  return changed;
}

export const publishRouteChanges = (ctx: Pick<Ctx, 'bus'>, rows: Task[]) => rows.forEach(row => published(ctx, row));
