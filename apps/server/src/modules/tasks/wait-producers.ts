import type { WaitOwnerBinding, WaitPlan, WaitSourceKind, WaitSourceState } from '@hornhoof/protocol/waits';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, requests, taskWaits } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { candidates, decisionOwner } from './decisions.js';
import { CLOSED, refuse, requestSubject, type Actor, type Request, type Task, type Tx } from './engine.js';
import { departmentHead, planFromPolicy, setsWaitDates } from './wait-policy.js';
import { afterSourceKey, endOpenSource, endTaskWaits, lastOfSource, moveWaitOwner, recordLegacyWait, requestSourceKey, reviewSourceKey, syncSourceWaits, type TaskWait } from './wait-state.js';

/* strict: false for what Hornhoof asks or moves by itself and for what an owner must be able to say, which go on with no dates
   rather than stop: a reviewer's verdict, someone leaving, a task that stood still, a goal being missed. */
type Source = { kind: WaitSourceKind; sourceKey: string; owner: WaitOwnerBinding | null; plan?: WaitPlan | undefined; sourceState?: WaitSourceState; actor: Actor; strict?: boolean };

const policyPlan = async (tx: Tx, task: Task, source: Source): Promise<WaitPlan | null> =>
  task.departmentId ? planFromPolicy(tx, { companyId: task.companyId, departmentId: task.departmentId, kind: source.kind, stage: '', at: new Date() }) : null;

function unplanned(task: Task, source: Source): ApiError {
  if (!source.owner) return refuse(400, 'task_invalid', `This wait on #${task.number} has nobody to answer for it. Give the work a holder first.`);
  const way = source.kind === 'review' ? 'Ask' : 'Give a plan, or ask';
  return refuse(400, 'task_invalid', `#${task.number}'s department sets dates for its waits, and none for this kind of wait (${source.kind}). ${way} who owns the department to set a policy for it.`);
}

const refusesUnplanned = async (tx: Tx, task: Task, source: Source): Promise<boolean> =>
  Boolean(source.plan) || (source.strict !== false && Boolean(task.departmentId) && await setsWaitDates(tx, task.companyId, task.departmentId!));

/* The one gate every source goes through. A department that set a policy has said its waits have dates, so a new one with no
   owner or no plan is refused with the whole move; where it set none there is no date to make up, and the wait is kept without.
   One that stands keeps what it has, unless a promise is given for it now. */
export async function bindSource(tx: Tx, task: Task, source: Source): Promise<TaskWait> {
  const last = await lastOfSource(tx, task, source.kind, source.sourceKey);
  if (last && last.endedAt === null && !source.plan) return last;
  const common = { taskId: task.id, kind: source.kind, sourceKey: source.sourceKey, sourceRevision: last ? last.sourceRevision + 1 : 0, sourceState: source.sourceState ?? {}, actor: source.actor };
  const plan = source.plan ?? await policyPlan(tx, task, source);
  if (plan && source.owner) return syncSourceWaits(tx, { ...common, ownerBinding: source.owner, plan });
  if (await refusesUnplanned(tx, task, source)) throw unplanned(task, source);
  return recordLegacyWait(tx, { ...common, ...(source.owner ? { ownerBinding: source.owner } : {}) });
}

/* The first of these still here, else the head of the task's department. */
async function answeringFor(tx: Tx, task: Task, named: (string | null)[]): Promise<string | null> {
  const ids = named.filter((id): id is string => id !== null);
  const live = ids.length ? await tx.select({ id: agents.id }).from(agents).where(and(inArray(agents.id, ids), isNull(agents.removedAt))) : [];
  return ids.find(id => live.some(a => a.id === id)) ?? (task.departmentId ? departmentHead(tx, task.departmentId) : null);
}

/* Who can finish a task: whoever holds it, its executor, else the head of its department. */
async function finisherOf(tx: Tx, task: Task): Promise<WaitOwnerBinding | null> {
  const agentId = await answeringFor(tx, task, [task.assigneeAgentId, task.executorAgentId]);
  return agentId ? { agentId } : null;
}

export type AfterPlans = Record<string, WaitPlan>;

/* One wait for each task it still comes after, each with its own promise or the department's dates. */
export async function bindAfter(tx: Tx, task: Task, before: Task[], plans: AfterPlans | undefined, actor: Actor): Promise<void> {
  for (const prerequisite of before) {
    if (prerequisite.status === 'done') continue;
    await bindSource(tx, task, { kind: 'after', sourceKey: afterSourceKey(prerequisite.id), owner: await finisherOf(tx, prerequisite), plan: plans?.[prerequisite.id], actor });
  }
}

const openWaits = (tx: Tx, taskId: string): Promise<TaskWait[]> =>
  tx.select().from(taskWaits).where(and(eq(taskWaits.taskId, taskId), inArray(taskWaits.state, ['active', 'legacy_needs_plan'])));

/* What it comes after changed: what it no longer waits for ends and what it waits for now is bound. */
export async function rebindAfter(tx: Tx, task: Task, before: Task[], plans: AfterPlans | undefined, actor: Actor): Promise<void> {
  const wanted = new Set(before.map(t => afterSourceKey(t.id)));
  for (const wait of await openWaits(tx, task.id)) {
    if (wait.kind === 'after' && !wanted.has(wait.sourceKey)) await endOpenSource(tx, { taskId: task.id, kind: 'after', sourceKey: wait.sourceKey, outcome: 'cancelled', proofRef: `update:${task.version}`, actor });
  }
  await bindAfter(tx, task, before, plans, actor);
}

/* The task it came after is done: that edge ends, whatever else it still waits for. */
export const endAfter = (tx: Tx, waiting: Task, done: Task, actor: Actor): Promise<void> =>
  endOpenSource(tx, { taskId: waiting.id, kind: 'after', sourceKey: afterSourceKey(done.id), outcome: 'resolved', proofRef: `task:${done.id}:done`, actor });

/* Whoever comes to hold a task answers for what waits on it. */
async function followHolder(tx: Tx, row: Task, actor: Actor): Promise<void> {
  const owner = await finisherOf(tx, row);
  if (!owner) return;
  const waiting = await tx.select().from(taskWaits).where(and(eq(taskWaits.companyId, row.companyId), eq(taskWaits.kind, 'after'), eq(taskWaits.sourceKey, afterSourceKey(row.id)), inArray(taskWaits.state, ['active', 'legacy_needs_plan'])));
  for (const wait of waiting) await moveWaitOwner(tx, wait, owner, actor);
}

/* The person whose decision a question is, as its card says; a company with nobody to ask has no one to name. */
async function requestOwner(tx: Tx, task: Task, request: Request): Promise<WaitOwnerBinding | null> {
  const everyone = await candidates({ db: tx as unknown as Db }, task.companyId);
  return everyone.some(p => p.isOwner && p.status === 'active') ? { personId: decisionOwner(requestSubject(request, task), everyone) } : null;
}

/* A question to a person answers to the one whose decision it is, each question on its own. */
export async function bindRequest(tx: Tx, task: Task, request: Request, actor: Actor, how: { plan?: WaitPlan | undefined; strict: boolean }): Promise<void> {
  await bindSource(tx, task, { kind: 'person', sourceKey: requestSourceKey(request.id), owner: await requestOwner(tx, task, request), plan: how.plan, strict: how.strict, actor });
}

/* An answer ends the wait of that one question: not the others, and it proves only that it was answered. */
export const endRequest = (tx: Tx, request: Pick<Request, 'id' | 'taskId'>, status: Request['status'], actor: Actor): Promise<void> =>
  endOpenSource(tx, { taskId: request.taskId, kind: 'person', sourceKey: requestSourceKey(request.id), outcome: 'resolved', proofRef: `request:${request.id}:${status}`, actor });

export type WaitStep = { kind: string; actor: Actor; eventId: number };

/* Questions taken back in this move no longer wait for anybody. */
async function endWithdrawn(tx: Tx, row: Task, step: WaitStep, open: TaskWait[]): Promise<void> {
  const asked = new Map(open.filter(w => w.kind === 'person').map(w => [w.sourceKey.slice('request:'.length), w]));
  if (!asked.size) return;
  const gone = await tx.select({ id: requests.id, status: requests.status }).from(requests).where(and(inArray(requests.id, [...asked.keys()]), ne(requests.status, 'open')));
  for (const request of gone) {
    await endOpenSource(tx, { taskId: row.id, kind: 'person', sourceKey: requestSourceKey(request.id), outcome: 'cancelled', proofRef: `request:${request.id}:${request.status}`, actor: step.actor });
  }
}

const atItsGate = (task: Task): boolean => task.stage > 0 && ['review', 'waiting'].includes(task.status);

/* Who answers for the check now: each reviewer on the panel, and while nobody is on to check it whoever it waits with. */
async function reviewersOf(tx: Tx, row: Task): Promise<string[]> {
  if (!atItsGate(row)) return [];
  if (row.panel.length) return row.panel;
  const holder = await answeringFor(tx, row, [row.assigneeAgentId]);
  return holder ? [holder] : [];
}

/* A verdict ends its reviewer's wait, and proves that much. A reviewer no longer wanted in this round stops being waited for. */
async function endReviews(tx: Tx, row: Task, step: WaitStep, open: TaskWait[], wanted: Set<string>): Promise<void> {
  for (const wait of open.filter(w => w.kind === 'review')) {
    const gave = step.kind === 'verdict' && wait.ownerAgentId === step.actor.agentId;
    if (!gave && wanted.has(wait.sourceKey)) continue;
    await endOpenSource(tx, { taskId: row.id, kind: 'review', sourceKey: wait.sourceKey, outcome: gave ? 'resolved' : 'cancelled', proofRef: gave ? `verdict:${step.eventId}` : `moved:${step.eventId}`, actor: step.actor });
  }
}

/* The gate waits for each reviewer on its own, for this round: what was bound for another round cannot come back. Only handing
   work in is refused without dates. A verdict or someone leaving goes on, and that work has no date to keep. */
async function keepReviews(tx: Tx, row: Task, step: WaitStep, open: TaskWait[]): Promise<void> {
  const reviewers = await reviewersOf(tx, row);
  await endReviews(tx, row, step, open, new Set(reviewers.map(id => reviewSourceKey(row.id, row.bounces, id))));
  for (const agentId of reviewers) {
    await bindSource(tx, row, { kind: 'review', sourceKey: reviewSourceKey(row.id, row.bounces, agentId), owner: { agentId }, strict: step.kind === 'submitted', actor: step.actor });
  }
}

/* The review of a turn is born at its gate, without a move. */
export const bindTurnReview = (tx: Tx, row: Task, step: WaitStep): Promise<void> => keepReviews(tx, row, step, []);

/* A wait_for lasts until its holder moves the work on. Words that bring it back to look do not end it. */
async function endWaitFors(tx: Tx, row: Task, step: WaitStep, open: TaskWait[]): Promise<void> {
  for (const wait of open.filter(w => w.kind === 'external' && w.sourceKey.startsWith('wait_for:'))) {
    await endOpenSource(tx, { taskId: row.id, kind: 'external', sourceKey: wait.sourceKey, outcome: 'superseded', proofRef: `moved:${step.eventId}`, actor: step.actor });
  }
}

/* What a move of a task means for the waits on it, in the same write. */
export async function keepWaitsWithMove(tx: Tx, before: Task, row: Task, step: WaitStep): Promise<void> {
  const open = await openWaits(tx, row.id);
  if (atItsGate(before) || atItsGate(row)) await keepReviews(tx, row, step, open);
  await endWithdrawn(tx, row, step, open);
  if (CLOSED.includes(row.status)) {
    await endTaskWaits(tx, { taskId: row.id, outcome: row.status === 'done' ? 'resolved' : 'cancelled', proofRef: `task:${row.id}:${row.status}`, actor: step.actor });
    return;
  }
  if (row.assigneeAgentId !== before.assigneeAgentId) await followHolder(tx, row, step.actor);
  if (row.status !== before.status || row.stage !== before.stage) await endWaitFors(tx, row, step, open);
}
