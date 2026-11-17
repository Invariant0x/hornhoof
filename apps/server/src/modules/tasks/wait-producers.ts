import type { WaitOwnerBinding, WaitPlan, WaitSourceKind, WaitSourceState } from '@hornhoof/protocol/waits';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, requests, taskWaits } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { candidates, decisionOwner } from './decisions.js';
import { routeOf, type Route } from './echelons-store.js';
import { CLOSED, refuse, requestSubject, type Actor, type Request, type Task, type Tx } from './engine.js';
import { departmentHead, planFromPolicy, setsWaitDates } from './wait-policy.js';
import { afterSourceKey, endOpenSource, endTaskWaits, lastOfSource, moveWaitOwner, recordLegacyWait, requestSourceKey, reviewSourceKey, syncSourceWaits, type TaskWait } from './wait-state.js';

/* strict: false for what Hornhoof asks or moves by itself and for what someone must be able to say, which go on with no dates
   rather than stop: a question to a person, a reviewer's verdict, someone leaving, a task that stood still. */
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
const rowOf = (task: Task, source: Source, last: TaskWait | undefined) => ({
  taskId: task.id, kind: source.kind, sourceKey: source.sourceKey, sourceRevision: last ? last.sourceRevision + 1 : 0, sourceState: source.sourceState ?? {}, actor: source.actor,
});

export async function bindSource(tx: Tx, task: Task, source: Source): Promise<TaskWait> {
  const last = await lastOfSource(tx, task, source.kind, source.sourceKey);
  if (last && last.endedAt === null && !source.plan) return last;
  const common = rowOf(task, source, last);
  const plan = source.plan ?? await policyPlan(tx, task, source);
  if (plan && source.owner) return syncSourceWaits(tx, { ...common, ownerBinding: source.owner, plan });
  if (await refusesUnplanned(tx, task, source)) throw unplanned(task, source);
  return recordLegacyWait(tx, { ...common, ...(source.owner ? { ownerBinding: source.owner } : {}) });
}

/* The first of these still here, else the head of the task's department. */
async function answeringFor(tx: Tx, task: Task, named: (string | null)[]): Promise<string | null> {
  const ids = named.filter((id): id is string => id !== null);
  const live = ids.length ? await tx.select(idOnly(agents)).from(agents).where(and(inArray(agents.id, ids), isNull(agents.removedAt))) : [];
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

/* A question to a person answers to the one whose decision it is, each question on its own. Wanting dates never stops one: work
   that cannot go on must reach somebody, so with no promise and none from the department it waits with none. */
export async function bindRequest(tx: Tx, task: Task, request: Request, actor: Actor, plan?: WaitPlan): Promise<TaskWait> {
  return bindSource(tx, task, { kind: 'person', sourceKey: requestSourceKey(request.id), owner: await requestOwner(tx, task, request), plan, strict: false, actor });
}

/* An answer ends the wait of that one question: not the others, and it proves only that it was answered. */
export const endRequest = (tx: Tx, request: Pick<Request, 'id' | 'taskId'>, status: Request['status'], actor: Actor): Promise<void> =>
  endOpenSource(tx, { taskId: request.taskId, kind: 'person', sourceKey: requestSourceKey(request.id), outcome: 'resolved', proofRef: `request:${request.id}:${status}`, actor });

type WaitStep = { kind: string; actor: Actor; eventId: number };

/* Questions taken back in this move no longer wait for anybody. */
async function endWithdrawn(tx: Tx, row: Task, step: WaitStep, open: TaskWait[]): Promise<void> {
  const asked = new Map(open.filter(w => w.kind === 'person').map(w => [w.sourceKey.slice('request:'.length), w]));
  if (!asked.size) return;
  const gone = await tx.select({ id: requests.id, status: requests.status }).from(requests).where(and(inArray(requests.id, [...asked.keys()]), ne(requests.status, 'open')));
  for (const request of gone) {
    await endOpenSource(tx, { taskId: row.id, kind: 'person', sourceKey: requestSourceKey(request.id), outcome: 'cancelled', proofRef: `request:${request.id}:${request.status}`, actor: step.actor });
  }
}

function currentReviewSource(row: Task, route: Route): string | null {
  const checking = route.state.phase === 'active' && ['review', 'security', 'cleanup'].includes(route.state.stage ?? '') && !CLOSED.includes(row.status);
  return checking && row.assigneeAgentId && route.state.candidateId
    ? reviewSourceKey(row.id, route.state.stage!, route.state.candidateId, row.assigneeAgentId) : null;
}

/* A check waits on one candidate, stage and owner, including the owner's own repairs. */
async function keepReviews(tx: Tx, row: Task, step: WaitStep, open: TaskWait[]): Promise<void> {
  const key = currentReviewSource(row, await routeOf(tx, row));
  for (const wait of open.filter(wait => wait.kind === 'review')) {
    if (wait.sourceKey === key) continue;
    const resolved = step.kind === 'verdict' && wait.ownerAgentId === step.actor.agentId;
    await endOpenSource(tx, { taskId: row.id, kind: 'review', sourceKey: wait.sourceKey, outcome: resolved ? 'resolved' : 'superseded', proofRef: `moved:${step.eventId}`, actor: step.actor });
  }
  if (key) await bindSource(tx, row, { kind: 'review', sourceKey: key, owner: { agentId: row.assigneeAgentId! }, strict: step.kind === 'submitted', actor: step.actor });
}

/* A wait_for lasts until its holder moves the work on. Words that bring it back to look do not end it. */
async function endWaitFors(tx: Tx, row: Task, step: WaitStep, open: TaskWait[]): Promise<void> {
  for (const wait of open.filter(w => w.kind === 'external' && w.sourceKey.startsWith('wait_for:'))) {
    await endOpenSource(tx, { taskId: row.id, kind: 'external', sourceKey: wait.sourceKey, outcome: 'superseded', proofRef: `moved:${step.eventId}`, actor: step.actor });
  }
}

/* What a move of a task means for the waits on it, in the same write. */
export async function keepWaitsWithMove(tx: Tx, before: Task, row: Task, step: WaitStep): Promise<void> {
  const open = await openWaits(tx, row.id);
  await keepReviews(tx, row, step, open);
  await endWithdrawn(tx, row, step, open);
  if (CLOSED.includes(row.status)) {
    await endTaskWaits(tx, { taskId: row.id, outcome: row.status === 'done' ? 'resolved' : 'cancelled', proofRef: `task:${row.id}:${row.status}`, actor: step.actor });
    return;
  }
  if (row.assigneeAgentId !== before.assigneeAgentId) await followHolder(tx, row, step.actor);
  if (row.status !== before.status || row.assigneeAgentId !== before.assigneeAgentId || ['submitted', 'verdict', 'report'].includes(step.kind)) await endWaitFors(tx, row, step, open);
}
