import type { WaitOwnerBinding, WaitPlan, WaitSourceKind, WaitSourceState } from '@hornhoof/protocol/waits';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, requestInternal, requests, tasks, taskWaits, type QuestionRecoveryIntent } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { candidates, decisionOwner } from './decisions.js';
import { CLOSED, refuse, requestSubject, type Actor, type Request, type Task, type Tx } from './engine.js';
import { classificationRequired, sourceClosed, staleRevision, staleRoute } from './question-authority.js';
import { departmentHead, planFromPolicy, setsWaitDates } from './wait-policy.js';
import { afterSourceKey, endOpenSource, endSourceWait, endTaskWaits, lastOfSource, moveWaitOwner, recordLegacyWait, requestSourceKey, reviewSourceKey, syncSourceWaits, type TaskWait } from './wait-state.js';

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
export async function bindRequest(tx: Tx, task: Task, request: Request, actor: Actor, how: { plan?: WaitPlan | undefined; strict: boolean }): Promise<TaskWait> {
  return bindSource(tx, task, { kind: 'person', sourceKey: requestSourceKey(request.id), owner: await requestOwner(tx, task, request), plan: how.plan, strict: how.strict, actor });
}

/* An answer ends the wait of that one question: not the others, and it proves only that it was answered. */
export const endRequest = (tx: Tx, request: Pick<Request, 'id' | 'taskId'>, status: Request['status'], actor: Actor): Promise<void> =>
  endOpenSource(tx, { taskId: request.taskId, kind: 'person', sourceKey: requestSourceKey(request.id), outcome: 'resolved', proofRef: `request:${request.id}:${status}`, actor });

export const questionSourceKey = (request: string) => `question:${request}`;

/* A question is named by what the caller last read of it, and acted on only if that is what it still is. */
export type QuestionGuard = { taskId: string; requestId: string; expectedRevision: number; expectedRouteRevision: number; actor: Actor };

const noSuchQuestion = () => refuse(404, 'request_unknown', 'There is no such question.');

/* The task and then its question, as a cancel takes them, as they are now under their locks. */
async function lockedQuestion(tx: Tx, guard: QuestionGuard): Promise<{ task: Task; request: Request }> {
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, guard.taskId)).for('update');
  if (!task) throw noSuchQuestion();
  const [request] = await tx.select().from(requests).where(and(eq(requests.id, guard.requestId), eq(requests.taskId, task.id), eq(requests.companyId, task.companyId))).for('update');
  if (!request) throw noSuchQuestion();
  if (request.questionRevision !== guard.expectedRevision) throw staleRevision();
  if (request.routeRevision !== guard.expectedRouteRevision) throw staleRoute();
  return { task, request };
}

/* The person a question put before people answers to: the one whose decision it is, or the one who alone can do what it asks. */
async function questionPerson(tx: Tx, task: Task, request: Request): Promise<string> {
  const authority = request.classification?.authority;
  if (!authority) throw classificationRequired();
  const owner = authority.purpose.kind === 'decision' ? await requestOwner(tx, task, request) : { personId: authority.recipientPersonIds[0] };
  const personId = owner && 'personId' in owner ? owner.personId : undefined;
  if (!personId || !authority.recipientPersonIds.includes(personId)) throw staleRoute();
  return personId;
}

const ownerOfQuestion = async (tx: Tx, task: Task, request: Request): Promise<WaitOwnerBinding | null> => {
  if (request.audience === 'human') return { personId: await questionPerson(tx, task, request) };
  return request.triageAgentId ? { agentId: request.triageAgentId } : null;
};

/* What keeps a question from being lost where nobody can have it yet, or nobody gave it dates. Never a date of its own. */
async function keepRecovery(tx: Tx, request: Request, reason: QuestionRecoveryIntent['reason'] | null): Promise<void> {
  const recoveryIntent = reason ? { sourceKey: questionSourceKey(request.id), reason, recordedAt: new Date().toISOString() } : null;
  await tx.insert(requestInternal).values({ requestId: request.id, companyId: request.companyId, recoveryIntent }).onConflictDoUpdate({ target: requestInternal.requestId, set: { recoveryIntent } });
}

const kindOfQuestion = (request: Pick<Request, 'audience'>): 'external' | 'person' => (request.audience === 'human' ? 'person' : 'external');

const onRoute = (request: Pick<Request, 'id' | 'routeRevision'>) => `question:${request.id}:route:${request.routeRevision}`;

/* A promise given stays under the new route. With none the wait keeps what is known of it: another who comes to answer for it on
   the same route does so by name alone, and a new route is a new wait under its own revision. */
async function withoutDates(tx: Tx, source: { taskId: string; sourceKey: string; sourceRevision: number; ownerBinding: WaitOwnerBinding; actor: Actor }, kind: 'external' | 'person', task: Task, proofRef: string): Promise<TaskWait> {
  const last = await lastOfSource(tx, task, kind, source.sourceKey);
  const open = last?.endedAt === null ? last : null;
  if (open?.plan) return syncSourceWaits(tx, { ...source, kind, sourceState: open.sourceState, plan: open.plan });
  if (open?.sourceRevision === source.sourceRevision) {
    await moveWaitOwner(tx, open, source.ownerBinding, source.actor);
    return (await lastOfSource(tx, task, kind, source.sourceKey))!;
  }
  if (open) await endOpenSource(tx, { taskId: source.taskId, kind, sourceKey: source.sourceKey, outcome: 'superseded', proofRef, actor: source.actor });
  return recordLegacyWait(tx, { ...source, kind, sourceState: {} });
}

/* Keeps the wait of a question as the question is now, read under its locks: of an agent while it stays inside, of a person
   once it is put before one, and the kind it was before ends in the same write. sourceRevision is the question's route.
   With nobody to have it, or no promise and no dates from the department, no date is made up: the recovery intent stays. */
export async function syncQuestionWait(tx: Tx, guard: QuestionGuard & { plan?: WaitPlan | undefined }): Promise<TaskWait | null> {
  const { task, request } = await lockedQuestion(tx, guard);
  if (request.status !== 'open') throw sourceClosed();
  const kind = kindOfQuestion(request);
  const sourceKey = questionSourceKey(request.id);
  const proofRef = onRoute(request);
  await endOpenSource(tx, { taskId: task.id, kind: kind === 'person' ? 'external' : 'person', sourceKey, outcome: 'superseded', proofRef, actor: guard.actor });
  const ownerBinding = await ownerOfQuestion(tx, task, request);
  if (!ownerBinding) {
    await endOpenSource(tx, { taskId: task.id, kind, sourceKey, outcome: 'superseded', proofRef, actor: guard.actor });
    await keepRecovery(tx, request, 'internal_route_unavailable');
    return null;
  }
  const plan = guard.plan ?? await policyPlan(tx, task, { kind, sourceKey, owner: ownerBinding, actor: guard.actor });
  await keepRecovery(tx, request, plan ? null : 'plan_unavailable');
  const source = { taskId: task.id, sourceKey, sourceRevision: request.routeRevision, ownerBinding, actor: guard.actor };
  return plan ? syncSourceWaits(tx, { ...source, kind, sourceState: {}, plan }) : withoutDates(tx, source, kind, task, proofRef);
}

/* Ends the wait of that one question, of the kind it waits as now; the question itself ends in the write that calls this. */
export async function endQuestionWait(tx: Tx, guard: QuestionGuard & { outcome: 'resolved' | 'cancelled' | 'superseded'; proofRef: string }): Promise<void> {
  const { task, request } = await lockedQuestion(tx, guard);
  await endSourceWait(tx, { taskId: task.id, kind: kindOfQuestion(request), sourceKey: questionSourceKey(request.id), outcome: guard.outcome, proofRef: guard.proofRef, sourceRevision: request.routeRevision, actor: guard.actor });
}

/* Another holds the task: what was read of its questions before no longer acts on them, and what a person was shown of one no longer
   stands. A goal in danger is about the goal and not about who holds the work. */
async function questionsFollowHolder(tx: Tx, row: Task, actor: Actor): Promise<void> {
  const open = await tx.select().from(requests).where(and(eq(requests.taskId, row.id), eq(requests.status, 'open'), isNull(requests.goalState))).for('update');
  for (const question of open) {
    const [moved] = await tx.update(requests).set({ routeRevision: question.routeRevision + 1 }).where(eq(requests.id, question.id)).returning();
    if (moved!.audience === 'internal') await syncQuestionWait(tx, { taskId: row.id, requestId: moved!.id, expectedRevision: moved!.questionRevision, expectedRouteRevision: moved!.routeRevision, actor });
  }
}

export type WaitStep = { kind: string; actor: Actor; eventId: number };

const isQuestionWait = (w: TaskWait): boolean => w.kind === 'person' || (w.kind === 'external' && w.sourceKey.startsWith('question:'));

/* Questions taken back in this move no longer wait for anybody. */
async function endWithdrawn(tx: Tx, row: Task, step: WaitStep, open: TaskWait[]): Promise<void> {
  const asked = open.filter(isQuestionWait).map(wait => ({ wait, id: wait.sourceKey.slice(wait.sourceKey.indexOf(':') + 1) }));
  if (!asked.length) return;
  const gone = new Map((await tx.select({ id: requests.id, status: requests.status }).from(requests).where(and(inArray(requests.id, asked.map(a => a.id)), ne(requests.status, 'open')))).map(r => [r.id, r.status]));
  for (const { wait, id } of asked) {
    const status = gone.get(id);
    if (status) await endOpenSource(tx, { taskId: row.id, kind: wait.kind, sourceKey: wait.sourceKey, outcome: 'cancelled', proofRef: `request:${id}:${status}`, actor: step.actor });
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
  if (row.assigneeAgentId !== before.assigneeAgentId) {
    await followHolder(tx, row, step.actor);
    await questionsFollowHolder(tx, row, step.actor);
  }
  if (row.status !== before.status || row.stage !== before.stage) await endWaitFors(tx, row, step, open);
}
