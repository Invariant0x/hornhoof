import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, taskEvents, tasks } from '../../db/schema.js';
import { checkerFor } from './echelons-assign.js';
import { currentCandidate } from './echelons-candidates.js';
import { changeRoute, routeOf, type Route } from './echelons-store.js';
import { RepoPath } from './review-schema.js';
import { CLOSED, note, published, refuse, type Task, type TaskChange, type Tx, type Wake } from './engine.js';

export async function requireTaskHead(ctx: { db: Ctx['db'] | Tx }, task: Task, agentId: string): Promise<void> {
  const [actor] = await ctx.db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, task.companyId), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  if (!actor || (actor.kind !== 'orchestrator' && !(actor.kind === 'head' && actor.departmentId === task.departmentId))) throw refuse(403, 'task_not_yours', 'Only this department head or the orchestrator may revise the route.');
}

export function withCleanup(route: Route, enabled: boolean): Route['state'] {
  if (route.state.resultKind === 'coordination') return route.state;
  const review = route.state.stages.findIndex(step => step.stage === 'review');
  const at = route.state.stages.findIndex(step => step.stage === route.state.stage);
  if (at > review) throw refuse(409, 'task_invalid', 'Cleanup must be decided before Review hands this result forward.');
  const stages = route.state.stages.filter(step => step.stage !== 'cleanup');
  if (enabled) stages.splice(review + 1, 0, { stage: 'cleanup', status: 'pending', ownerAgentId: null, reason: 'requested_by_head', inputCandidateId: null, candidateId: null });
  return { ...route.state, stages };
}

export async function prepareRouteChange(ctx: Ctx, task: Task, route: Route, agentId: string, change: TaskChange): Promise<{ state: Route['state']; set: Partial<Task>; paths: string[] }> {
  let state = change.cleanup === undefined ? route.state : withCleanup(route, change.cleanup);
  const set: Partial<Task> = {};
  const paths = change.paths ?? route.paths;
  if (paths.some(path => !RepoPath.safeParse(path).success)) throw refuse(400, 'task_invalid', 'Repository scope contains an invalid path pattern.');
  if (change.riskClass && change.riskClass !== 'none' && state.resultKind === 'code') {
    if (['tests', 'security'].includes(state.stage ?? '') && !state.security.required) throw refuse(409, 'task_invalid', 'A newly discovered risk must be resolved before this result proceeds.');
    state = { ...state, security: { required: true, reason: change.riskClass, addedBy: agentId }, stages: state.stages.map(step => step.stage === 'security' && step.status === 'skipped' ? { ...step, status: 'pending', reason: null } : step) };
  }
  if (change.executor && !['architecture', 'development'].includes(state.stage ?? '')) throw refuse(409, 'task_invalid', 'Change the current checking owner, not the original producer.');
  const ownerId = change.ownerAgentId ?? change.executor;
  if (ownerId) {
    const [owner] = await ctx.db.select().from(agents).where(and(eq(agents.id, ownerId), eq(agents.companyId, task.companyId), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
    if (!owner?.subscriptionId || owner.departmentId !== task.departmentId || (owner.productId && owner.productId !== task.productId)) throw refuse(403, 'task_not_yours', 'The new owner must be available in this task scope.');
    const abilities: Partial<Record<NonNullable<Route['state']['stage']>, string>> = { review: 'dev-review-diff', cleanup: 'dev-cleanup', security: 'dev-security-review', tests: 'dev-test-environment' };
    const ability = state.stage ? abilities[state.stage] : undefined;
    const assignment = ability ? await checkerFor(ctx, task, (await currentCandidate(ctx.db, task, route)).producedBy, ability, ownerId) : null;
    if (ability && !assignment) throw refuse(409, 'task_invalid', 'The proposed checker lacks the required ability or model capability.');
    state = { ...state, phase: 'active', assignment, stages: state.stages.map(step => step.stage === state.stage ? { ...step, status: 'active', ownerAgentId: ownerId, reason: null } : step) };
    Object.assign(set, { assigneeAgentId: ownerId, status: ability && state.stage !== 'tests' ? 'review' : 'open', silent: 0 });
    if (change.executor) set.executorAgentId = ownerId;
  }
  return { state, set, paths };
}

/* A head decision belongs to its department in this turn; it is an event, not a compatibility switch. */
export async function turnCleanupDefault(tx: Tx, task: Task): Promise<boolean> {
  if (!task.turnId) return false;
  const [event] = await tx.select({ data: taskEvents.data }).from(taskEvents).where(and(eq(taskEvents.companyId, task.companyId), eq(taskEvents.kind, 'updated'), sql`${taskEvents.data}->'turnCleanup'->>'turnId' = ${task.turnId}`, sql`${taskEvents.data}->'turnCleanup'->>'departmentId' = ${task.departmentId}`)).orderBy(desc(taskEvents.id)).limit(1);
  return (event?.data.turnCleanup as { enabled?: boolean } | undefined)?.enabled === true;
}

export async function applyTurnCleanup(tx: Tx, task: Task, agentId: string, enabled: boolean, wakes: Wake[]): Promise<Task[]> {
  const rows = await tx.select().from(tasks).where(and(eq(tasks.companyId, task.companyId), eq(tasks.turnId, task.turnId!), eq(tasks.departmentId, task.departmentId!))).orderBy(tasks.id).for('update');
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
