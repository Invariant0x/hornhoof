import { and, asc, eq, inArray, notInArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { jobs, tasks } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { agentIdentity, checkerFor, departmentHead, keptFromReview, PRODUCER_REVIEW } from './echelons-assign.js';
import { checkedProducer, currentHanded } from './echelons-candidates.js';
import { reviewEligibility, sameChecker, type CheckerIdentity } from './echelons-policy.js';
import { changeRoute, routeOf, type Route } from './route-records.js';
import { CLOSED, giver, loadTask, type Actor, type Task, type Wake } from './state.js';
import { move } from './transitions.js';

type Holder = { id: string; name: string; companyId: string };

/* Why the new identity no longer takes the stage, in words the head can act on. */
async function whyNot(ctx: Ctx, task: Task, route: Route, holder: Holder, producer: CheckerIdentity, kept: ReadonlySet<string>): Promise<string> {
  if (kept.has(holder.id)) return PRODUCER_REVIEW;
  const now = await agentIdentity(ctx.db, task.companyId, holder.id);
  if (!now) return 'Its plan or model has no known strength, or it has no plan.';
  const rule = reviewEligibility(producer, now);
  if (rule === 'weaker_model') return `Its new model is weaker than the model that produced the candidate (${producer.model}), so it can no longer check it.`;
  if (rule === 'self_review') return 'It would check its own work.';
  return `It lacks the ${route.state.stage ?? 'checking'} ability or is outside the task scope.`;
}

/* A checking stage is pinned to the plan, program, model and strength its owner had when it was assigned, and a result is
   refused once the owner's card says otherwise. Whoever changes the card calls this: the pin follows the owner when the new
   identity still passes every rule that chose it (ability, known strength, independence of the producers). When it does
   not, the stage is not re-pinned: it waits with its reason, the owner gets no further turn on it, and the head is told. */
export async function repinAssignments(ctx: Ctx, actor: Actor, holder: Holder): Promise<{ wakes: Wake[] }> {
  const rows = await ctx.db.select().from(tasks).where(and(eq(tasks.companyId, holder.companyId), eq(tasks.assigneeAgentId, holder.id), notInArray(tasks.status, [...CLOSED]))).orderBy(asc(tasks.id));
  const wakes: Wake[] = [];
  const released: string[] = [];
  for (const row of rows) {
    for (let tries = 0, task = row; tries < 3; tries++) {
      try {
        const outcome = await repinOne(ctx, actor, holder, task);
        if (outcome.released) released.push(task.id);
        wakes.push(...outcome.wakes);
        break;
      } catch (error) {
        if (!(error instanceof ApiError) || error.reason !== 'task_changed') throw error;
        task = await loadTask(ctx.db, task.id);
      }
    }
  }
  /* Turns it would have taken on a stage it no longer holds would only confuse it. */
  if (released.length) await ctx.db.update(jobs).set({ status: 'failed', error: 'checker_changed', finishedAt: new Date() }).where(and(eq(jobs.agentId, holder.id), eq(jobs.status, 'queued'), inArray(jobs.taskId, released)));
  return { wakes };
}

async function repinOne(ctx: Ctx, actor: Actor, holder: Holder, task: Task): Promise<{ released: boolean; wakes: Wake[] }> {
  const route = await routeOf(ctx.db, task);
  const { stage, assignment } = route.state;
  const ability = stage ? route.state.abilities[stage] : undefined;
  if (!stage || !ability || route.state.phase !== 'active' || assignment?.agentId !== holder.id) return { released: false, wakes: [] };
  const handed = await currentHanded(ctx.db, task, route);
  const producer = await checkedProducer(ctx.db, task, route, handed);
  const kept = await keptFromReview(ctx.db, task, stage, handed);
  const identity = kept.has(holder.id) ? null : await checkerFor(ctx, task, producer, ability, holder.id);
  if (identity && sameChecker(identity, assignment)) return { released: false, wakes: [] };
  if (identity) {
    const note = { kind: 'updated' as const, actor, text: `${holder.name} changed its plan or model, so its ${stage} assignment follows it.`, data: { fields: ['owner'] } };
    await move(ctx, task, {}, note, tx => changeRoute(tx, route, { ...route.state, assignment: identity }));
    return { released: false, wakes: [] };
  }
  const reason = await whyNot(ctx, task, route, holder, producer, kept);
  const text = `${holder.name} changed its plan or model and can no longer hold the ${stage} stage of #${task.number}. ${reason} Assign the stage to an eligible employee.`;
  const state: Route['state'] = { ...route.state, phase: 'waiting', assignment: null,
    stages: route.state.stages.map(step => step.stage === stage ? { ...step, ownerAgentId: null, status: 'pending', reason: 'eligible_owner_required' } : step) };
  const head = await departmentHead(ctx.db, task).catch(() => null);
  const wakes: Wake[] = head ? [{ agentId: head, taskId: task.id, why: 'switched', text }] : giver(task, 'switched', undefined, text);
  await move(ctx, task, { assigneeAgentId: null, status: 'waiting' }, { kind: 'updated', actor, text, data: { fields: ['owner'] } }, tx => changeRoute(tx, route, state), wakes);
  return { released: true, wakes };
}
