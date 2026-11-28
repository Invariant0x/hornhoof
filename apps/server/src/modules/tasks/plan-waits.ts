import { and, eq, inArray, isNotNull, isNull, notExists, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, requests, subscriptions, tasks } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { heldUntil } from '../conversation/limits.js';
import { openPersonRequests } from './decisions.js';
import { openAfter, refuse, type Task, type Tx, type Wake } from './state.js';
import { move } from './transitions.js';
import { wakeAll } from './wake.js';

export type AvailableWorkPlan = { id: string; model: string; label: string };
type CheckPlan = (ctx: Ctx, companyId: string, holderId: string) => Promise<AvailableWorkPlan | null>;

/* Check again under the task version guard. A reassignment, new prerequisite or human question wins over a stale observation. */
async function confirmStep(tx: Tx, task: Task, holderId: string, plan: AvailableWorkPlan): Promise<void> {
  const [assigned] = await tx.select({ kind: agents.kind, model: agents.model, limits: subscriptions.limits,
    budget: subscriptions.budget, limitsUpdatedAt: subscriptions.limitsUpdatedAt }).from(agents)
    .innerJoin(subscriptions, and(eq(subscriptions.id, agents.subscriptionId), eq(subscriptions.companyId, task.companyId),
      eq(subscriptions.status, 'ready'), isNull(subscriptions.removedAt))).where(and(eq(agents.id, holderId), eq(agents.companyId, task.companyId),
    eq(agents.subscriptionId, plan.id), eq(agents.model, plan.model), isNull(agents.removedAt), isNull(agents.switchedOffAt))).for('share');
  const [question] = await tx.select(idOnly(requests)).from(requests).where(and(eq(requests.companyId, task.companyId), eq(requests.taskId, task.id), openPersonRequests())).limit(1);
  if (!assigned || heldUntil(assigned, assigned.kind, assigned.model) || question || (await openAfter(tx, task)).length) throw refuse(409, 'task_changed', 'The next step is still held or its assignment changed.');
}

async function recheck(ctx: Ctx, task: Task, plan: AvailableWorkPlan) {
  const wait = task.externalWait!;
  const holderId = wait.planAccess!.holderId;
  const text = `Subscription "${plan.label}" can take the next step: ${wait.reason}`;
  const wakes: Wake[] = [{ agentId: holderId, taskId: task.id, why: 'work_check', text, version: task.version + 1 }];
  try {
    await move(ctx, task, { externalWait: null, silent: 0 }, { kind: 'updated', actor: { agentId: holderId }, automatic: 'work_check',
      text, data: { externalWait: null, resumedOnPlan: plan.id, requiredPlan: wait.planAccess!.required, reason: wait.reason } },
    tx => confirmStep(tx, task, holderId, plan), wakes);
  } catch (err) {
    if (err instanceof ApiError && err.reason === 'task_changed') return;
    throw err;
  }
  await wakeAll(ctx, wakes);
}

/* Reconstruct eligibility from durable waits and current assignments on each reconciliation, including after a restart. */
export async function recheckWorkPlans(ctx: Ctx, check: CheckPlan): Promise<void> {
  const waiting = await ctx.db.select().from(tasks).where(and(isNotNull(tasks.externalWait), isNull(tasks.paused),
    notExists(ctx.db.select(idOnly(requests)).from(requests).where(and(eq(requests.companyId, tasks.companyId), eq(requests.taskId, tasks.id), openPersonRequests()))),
    inArray(tasks.status, ['open', 'working', 'review']), sql`${tasks.externalWait}->>'work' = 'true'
      AND ${tasks.externalWait}->'planAccess'->>'holderId' = ${tasks.assigneeAgentId}::text
      AND ${tasks.externalWait}->'on' IS NULL AND ${tasks.externalWait}->'run' IS NULL`));
  const plans = new Map<string, AvailableWorkPlan | null>();
  for (const task of waiting) {
    const access = task.externalWait!.planAccess!;
    if (!plans.has(access.holderId)) plans.set(access.holderId, await check(ctx, task.companyId, access.holderId));
    const plan = plans.get(access.holderId);
    if (!plan || (access.required !== 'any_eligible' && access.required !== plan.id)) continue;
    if (!(await openAfter(ctx.db, task)).length) await recheck(ctx, task, plan);
  }
}
