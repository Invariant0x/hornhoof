import { EndSourceWait, ReplanWait, signalsOnce, SyncSourceWaits, validSourceKey, WaitOwnerBinding, WaitPlan, WaitSourceKind, WaitSourceState, type WaitOutcome } from '@hornhoof/protocol/waits';
import { and, asc, desc, eq, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { runsDepartment } from '../../auth/departments.js';
import type { Checker } from '../../checker.js';
import { agents, people, tasks, taskWaits, waitNotices } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { CLOSED, note, ownNote, refuse, type Actor, type Task, type Tx } from './engine.js';
import { nextReview, planFromPolicy, setsWaitDates, waitRoute } from './wait-policy.js';

/* The record of who answers for each thing a task waits on, and until when. Its source ends it: a date passing proves nothing.
   Every port runs in the caller's transaction, so a source's change and its wait commit together, with no network inside.

   Lock order, everywhere: the affected tasks by id, then their source rows, then wait rows, then notice rows. The task's row
   is what lets two writers of one source go one after the other. */

export type TaskWait = typeof taskWaits.$inferSelect;

export const waitForSourceKey = (operation: string) => `wait_for:${operation}`;
export const operationSourceKey = (operation: string) => `operation:${operation}`;
export const runSourceKey = (run: string) => `run:${run}`;
export const afterSourceKey = (task: string) => `task:${task}`;
export const requestSourceKey = (request: string) => `request:${request}`;
export const reviewSourceKey = (task: string, stage: string, candidate: string, reviewer: string) => `review:${task}:${stage}:${candidate}:${reviewer}`;

const OPEN_STATES = ['active', 'legacy_needs_plan'] as const;
const isOpen = (wait: TaskWait): boolean => wait.endedAt === null;
const staleSource = () => refuse(409, 'task_changed', 'This source has moved on since what you read.');

function parsed<T>(schema: Checker<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw refuse(400, 'task_invalid', `A wait needs a real source, a real owner and a whole plan: ${result.error.issues[0]!.message}`);
  return result.data;
}

const normalDate = (moment: string): string => new Date(moment).toISOString();

const normalPlan = (plan: WaitPlan): WaitPlan => ({
  ...plan,
  ownerDueAt: normalDate(plan.ownerDueAt),
  headDueAt: normalDate(plan.headDueAt),
  decisionDueAt: normalDate(plan.decisionDueAt),
  finalReview: { ...plan.finalReview, anchorAt: normalDate(plan.finalReview.anchorAt) },
});

const normalState = (state: WaitSourceState): WaitSourceState => (state.nextActionAt ? { ...state, nextActionAt: normalDate(state.nextActionAt) } : state);

/* A database hands jsonb back with its keys in its own order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

async function lockedTask(tx: Tx, taskId: string): Promise<Task> {
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update');
  if (!task) throw refuse(404, 'task_unknown', 'There is no such task.');
  return task;
}

async function isAgentOf(tx: Tx, companyId: string, agentId: string, working: boolean): Promise<boolean> {
  const [agent] = await tx.select(idOnly(agents)).from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId), ...(working ? [isNull(agents.removedAt)] : [])));
  return Boolean(agent);
}

async function isPersonOf(tx: Tx, companyId: string, personId: string, working: boolean): Promise<boolean> {
  const [person] = await tx.select(idOnly(people)).from(people).where(and(eq(people.id, personId), eq(people.companyId, companyId), ...(working ? [eq(people.status, 'active')] : [])));
  return Boolean(person);
}

/* working: still here today. A promise made by someone since gone stays a promise of the company. */
const isOfCompany = (tx: Tx, companyId: string, who: WaitOwnerBinding, working: boolean): Promise<boolean> =>
  'agentId' in who ? isAgentOf(tx, companyId, who.agentId, working) : isPersonOf(tx, companyId, who.personId, working);

async function requireActor(tx: Tx, companyId: string, actor: Actor): Promise<void> {
  const who = actor.agentId ? { agentId: actor.agentId } : { personId: actor.personId! };
  if (!(await isOfCompany(tx, companyId, who, true))) throw refuse(403, 'task_not_yours', 'This wait is not for you to change.');
}

async function requireOwner(tx: Tx, companyId: string, owner: WaitOwnerBinding): Promise<void> {
  if (!(await isOfCompany(tx, companyId, owner, true))) throw refuse(400, 'task_invalid', 'The owner of a wait must be an employee or a person of this company, still here.');
}

async function requirePlan(tx: Tx, companyId: string, plan: WaitPlan): Promise<void> {
  if (!(await isOfCompany(tx, companyId, plan.provenance.actor, false))) throw refuse(400, 'task_invalid', 'A plan\'s dates must come from someone of this company.');
  const [head] = await tx.select(idOnly(agents)).from(agents).where(and(eq(agents.id, plan.finalReview.headAgentId), eq(agents.companyId, companyId), eq(agents.kind, 'head'), isNull(agents.removedAt)));
  if (!head) throw refuse(400, 'task_invalid', 'The final review of a plan needs a real head of this company.');
}

const ownerColumns = (owner: WaitOwnerBinding | undefined) => {
  const agentId = owner && 'agentId' in owner ? owner.agentId : null;
  const personId = owner && 'personId' in owner ? owner.personId : null;
  return { ownerAgentId: agentId, ownerPersonId: personId, attentionAgentId: agentId, attentionPersonId: personId };
};

export const waitOwner = (wait: TaskWait): WaitOwnerBinding | null => {
  if (wait.ownerAgentId) return { agentId: wait.ownerAgentId };
  return wait.ownerPersonId ? { personId: wait.ownerPersonId } : null;
};

const datesOf = (plan: WaitPlan) => ({ plan, ownerDueAt: new Date(plan.ownerDueAt), headDueAt: new Date(plan.headDueAt), decisionDueAt: new Date(plan.decisionDueAt) });

/* A source that signals once and has signalled has no review left, under any plan it gets later. */
const firstReview = (source: Pick<TaskWait, 'kind' | 'sourceKey'>, ordinal: number, plan: WaitPlan): Date | null =>
  signalsOnce(source.kind, source.sourceKey) && ordinal > 0 ? null : new Date(plan.finalReview.anchorAt);

const nextActionOf = (state: WaitSourceState, plan: WaitPlan): Date => new Date(state.nextActionAt ?? plan.ownerDueAt);

/* What was written for the owner and dates before can no longer go out; what was already sent is checked again where it acts. */
async function cancelNotices(tx: Tx, waitId: string, now: Date): Promise<void> {
  await tx.update(waitNotices).set({ cancelledAt: now }).where(and(eq(waitNotices.waitId, waitId), isNull(waitNotices.deliveredAt), isNull(waitNotices.cancelledAt)));
}

const logged = (wait: TaskWait, more: Record<string, unknown> = {}) => ({ wait: { id: wait.id, kind: wait.kind, generation: wait.generation, ...more } });

export async function lastOfSource(tx: Tx, task: Pick<Task, 'id' | 'companyId'>, kind: WaitSourceKind, sourceKey: string): Promise<TaskWait | undefined> {
  const [wait] = await tx.select().from(taskWaits).where(and(eq(taskWaits.companyId, task.companyId), eq(taskWaits.taskId, task.id), eq(taskWaits.kind, kind), eq(taskWaits.sourceKey, sourceKey)))
    .orderBy(desc(taskWaits.generation)).limit(1).for('update');
  return wait;
}

type Bound = { owner: WaitOwnerBinding; plan: WaitPlan; sourceState: WaitSourceState; sourceRevision: number };

async function createWait(tx: Tx, task: Task, source: Pick<TaskWait, 'kind' | 'sourceKey'>, bound: Bound, actor: Actor, last?: TaskWait): Promise<TaskWait> {
  const reviewOrdinal = last?.reviewOrdinal ?? 0;
  const [wait] = await tx.insert(taskWaits).values({
    companyId: task.companyId, taskId: task.id, ...source, state: 'active', generation: (last?.generation ?? 0) + 1, sourceRevision: bound.sourceRevision, sourceState: bound.sourceState,
    ...ownerColumns(bound.owner), ...datesOf(bound.plan), nextActionAt: nextActionOf(bound.sourceState, bound.plan), reviewOrdinal, nextReviewAt: firstReview(source, reviewOrdinal, bound.plan),
    ...await waitRoute(tx, task),
  }).returning();
  await note(tx, task, { kind: 'updated', actor, text: 'A wait on this task has an owner and dates.', data: logged(wait!) });
  return wait!;
}

/* A new owner or plan is a new generation: the time spent and the record stay, and the old one's notices go. A new plan starts
   its levels again; a new owner on the same dates goes on from where they stand. */
async function rebind(tx: Tx, task: Task, wait: TaskWait, bound: Bound, actor: Actor, reason: string): Promise<TaskWait> {
  const now = new Date();
  const replanned = !same(wait.plan, bound.plan);
  const fromPlan = replanned ? { level: 0, nextActionAt: nextActionOf(bound.sourceState, bound.plan), nextReviewAt: firstReview(wait, wait.reviewOrdinal, bound.plan) } : {};
  const [kept] = await tx.update(taskWaits).set({
    state: 'active', generation: wait.generation + 1, sourceRevision: bound.sourceRevision, sourceState: bound.sourceState,
    ...ownerColumns(bound.owner), ...datesOf(bound.plan), ...fromPlan, ...await waitRoute(tx, task), routeRevision: wait.routeRevision + 1, updatedAt: now,
  }).where(eq(taskWaits.id, wait.id)).returning();
  await cancelNotices(tx, wait.id, now);
  await note(tx, task, { kind: 'updated', actor, text: reason, data: logged(kept!) });
  return kept!;
}

const boundAlike = (wait: TaskWait, bound: Bound): boolean => same(waitOwner(wait), bound.owner) && same(wait.plan, bound.plan);

async function reviseWait(tx: Tx, task: Task, wait: TaskWait, bound: Bound, actor: Actor): Promise<TaskWait> {
  if (bound.sourceRevision < wait.sourceRevision) throw staleSource();
  const unchanged = boundAlike(wait, bound);
  if (bound.sourceRevision === wait.sourceRevision && wait.state !== 'legacy_needs_plan') {
    if (unchanged && same(wait.sourceState, bound.sourceState)) return wait;
    throw staleSource();
  }
  if (!unchanged) return rebind(tx, task, wait, bound, actor, 'A wait on this task has a new owner or new dates.');
  const [kept] = await tx.update(taskWaits).set({
    sourceRevision: bound.sourceRevision, sourceState: bound.sourceState, updatedAt: new Date(), ...(bound.sourceState.nextActionAt ? { nextActionAt: new Date(bound.sourceState.nextActionAt) } : {}),
  }).where(eq(taskWaits.id, wait.id)).returning();
  return kept!;
}

/* Keeps a source's wait up to date, or refuses the whole write: a new source never goes on without a real owner and a plan. */
export async function syncSourceWaits(tx: Tx, input: SyncSourceWaits & { actor: Actor }): Promise<TaskWait> {
  const { actor, ...source } = input;
  const valid = parsed(SyncSourceWaits, source);
  const task = await lockedTask(tx, valid.taskId);
  if (CLOSED.includes(task.status)) throw refuse(409, 'task_closed', `#${task.number} is ${task.status}.`);
  await requireActor(tx, task.companyId, actor);
  await requireOwner(tx, task.companyId, valid.ownerBinding);
  const plan = normalPlan(valid.plan);
  await requirePlan(tx, task.companyId, plan);
  const bound = { owner: valid.ownerBinding, plan, sourceState: normalState(valid.sourceState), sourceRevision: valid.sourceRevision };
  const named = { kind: valid.kind, sourceKey: valid.sourceKey };
  const last = await lastOfSource(tx, task, valid.kind, valid.sourceKey);
  if (!last) return createWait(tx, task, named, bound, actor);
  if (isOpen(last)) return reviseWait(tx, task, last, bound, actor);
  if (last.sourceRevision >= valid.sourceRevision) throw staleSource();
  return createWait(tx, task, named, bound, actor, last);
}

const LegacyWait = z.strictObject({
  taskId: z.uuid(),
  kind: WaitSourceKind,
  sourceKey: z.string(),
  sourceRevision: z.number().int().min(0),
  ownerBinding: WaitOwnerBinding.optional(),
  sourceState: WaitSourceState,
}).refine(input => validSourceKey(input.kind, input.sourceKey), 'This source key does not name a source of this kind.');

/* A source no one has planned yet: what is known of it stays and it can end like any other, with no date, level or alarm made up. */
export async function recordLegacyWait(tx: Tx, input: z.input<typeof LegacyWait> & { actor: Actor }): Promise<TaskWait> {
  const { actor, ...source } = input;
  const valid = parsed(LegacyWait, source);
  const task = await lockedTask(tx, valid.taskId);
  await requireActor(tx, task.companyId, actor);
  if (valid.ownerBinding) await requireOwner(tx, task.companyId, valid.ownerBinding);
  const last = await lastOfSource(tx, task, valid.kind, valid.sourceKey);
  if (last && isOpen(last)) return last;
  const [wait] = await tx.insert(taskWaits).values({
    companyId: task.companyId, taskId: task.id, kind: valid.kind, sourceKey: valid.sourceKey, sourceRevision: valid.sourceRevision, state: 'legacy_needs_plan',
    generation: (last?.generation ?? 0) + 1, ...ownerColumns(valid.ownerBinding), sourceState: normalState(valid.sourceState),
  }).returning();
  return wait!;
}

async function closeWait(tx: Tx, task: Task, wait: TaskWait, end: { outcome: WaitOutcome; proofRef: string; sourceRevision: number; actor: Actor }): Promise<TaskWait> {
  const now = new Date();
  const [kept] = await tx.update(taskWaits).set({
    state: end.outcome, outcome: end.outcome, proofRef: end.proofRef, endedAt: now, sourceRevision: Math.max(wait.sourceRevision, end.sourceRevision), updatedAt: now,
  }).where(eq(taskWaits.id, wait.id)).returning();
  await cancelNotices(tx, wait.id, now);
  /* One nobody planned promised nothing, so its end is news to nobody: the source's own move says what happened. */
  if (wait.state === 'active') await note(tx, task, { kind: 'updated', actor: end.actor, text: `A wait on this task ended: ${end.outcome}.`, data: logged(kept!, { outcome: end.outcome }) });
  return kept!;
}

/* The source itself says it ended, with its proof. Only that source's wait ends, in the write that changes the source; a
   repeated callback changes nothing and an old one is refused. */
export async function endSourceWait(tx: Tx, input: EndSourceWait & { actor: Actor }): Promise<TaskWait | null> {
  const { actor, ...source } = input;
  const valid = parsed(EndSourceWait, source);
  const task = await lockedTask(tx, valid.taskId);
  await requireActor(tx, task.companyId, actor);
  const wait = await lastOfSource(tx, task, valid.kind, valid.sourceKey);
  if (!wait) return null;
  if (!isOpen(wait)) {
    if (wait.outcome === valid.outcome) return wait;
    throw staleSource();
  }
  if (valid.sourceRevision < wait.sourceRevision) throw staleSource();
  return closeWait(tx, task, wait, { outcome: valid.outcome, proofRef: valid.proofRef, sourceRevision: valid.sourceRevision, actor });
}

/* A task that closes takes every wait still open on it along. */
export async function endTaskWaits(tx: Tx, input: { taskId: string; outcome: WaitOutcome; proofRef: string; actor: Actor }): Promise<TaskWait[]> {
  const task = await lockedTask(tx, input.taskId);
  const open = await tx.select().from(taskWaits).where(and(eq(taskWaits.taskId, task.id), inArray(taskWaits.state, OPEN_STATES))).orderBy(asc(taskWaits.id)).for('update');
  return Promise.all(open.map(wait => closeWait(tx, task, wait, { ...input, sourceRevision: wait.sourceRevision })));
}

async function closeOpen(tx: Tx, task: Task, which: SQL, end: { outcome: WaitOutcome; proofRef: string; actor: Actor }): Promise<void> {
  const open = await tx.select().from(taskWaits).where(and(eq(taskWaits.taskId, task.id), inArray(taskWaits.state, OPEN_STATES), which)).orderBy(asc(taskWaits.id)).for('update');
  for (const wait of open) await closeWait(tx, task, wait, { ...end, sourceRevision: wait.sourceRevision });
}

/* The source says it ended, in the write that ends it: what is open of it ends at the revision it stands at, and nothing else. */
export async function endOpenSource(tx: Tx, input: { taskId: string; kind: WaitSourceKind; sourceKey: string; outcome: WaitOutcome; proofRef: string; actor: Actor }): Promise<void> {
  const task = await lockedTask(tx, input.taskId);
  await closeOpen(tx, task, and(eq(taskWaits.kind, input.kind), eq(taskWaits.sourceKey, input.sourceKey))!, input);
}

/* Another now answers for a source: with a plan a new generation on the same dates, without one only the name changes. */
export async function moveWaitOwner(tx: Tx, wait: TaskWait, owner: WaitOwnerBinding, actor: Actor): Promise<void> {
  if (same(waitOwner(wait), owner)) return;
  if (wait.state === 'legacy_needs_plan') {
    await tx.update(taskWaits).set({ ...ownerColumns(owner), updatedAt: new Date() }).where(eq(taskWaits.id, wait.id));
    return;
  }
  await syncSourceWaits(tx, { taskId: wait.taskId, kind: wait.kind, sourceKey: wait.sourceKey, sourceRevision: wait.sourceRevision + 1, ownerBinding: owner, plan: wait.plan!, sourceState: wait.sourceState, actor });
}

/* A new wait_for takes the place of the one before it on the task, which may have come back and still be open. */
export async function supersedeWaitFor(tx: Tx, input: { taskId: string; by: string; actor: Actor }): Promise<void> {
  const task = await lockedTask(tx, input.taskId);
  await closeOpen(tx, task, and(eq(taskWaits.kind, 'external'), like(taskWaits.sourceKey, 'wait_for:%'))!, { outcome: 'superseded', proofRef: input.by, actor: input.actor });
}

/* A run ended: its own wait ends, and each wait_for that named it, and nothing else on the task. */
export async function endRunWaits(tx: Tx, input: { taskId: string; runId: string; outcome: WaitOutcome; proofRef: string; actor: Actor }): Promise<void> {
  const task = await lockedTask(tx, input.taskId);
  const ofRun = or(
    and(eq(taskWaits.kind, 'run'), eq(taskWaits.sourceKey, runSourceKey(input.runId))),
    and(eq(taskWaits.kind, 'external'), sql`${taskWaits.sourceState}->>'run' = ${input.runId}`),
  )!;
  await closeOpen(tx, task, ofRun, input);
}

type RunSource = { id: string; taskId: string; companyId: string; agentId: string; departmentId: string | null };
type RunStage = NonNullable<WaitSourceState['stage']>;
const planOfStage = async (tx: Tx, run: RunSource, stage: RunStage, at: Date): Promise<WaitPlan | null> =>
  run.departmentId ? planFromPolicy(tx, { companyId: run.companyId, departmentId: run.departmentId, kind: 'run', stage, at }) : null;

/* Whoever starts a run answers for it. Its dates come from what the department set for each stage: nothing else, not its limit. */
export async function recordRunWait(tx: Tx, run: RunSource, stage: RunStage, at: Date): Promise<TaskWait> {
  const source = { taskId: run.taskId, kind: 'run' as const, sourceKey: runSourceKey(run.id), sourceRevision: 0, ownerBinding: { agentId: run.agentId }, sourceState: { stage }, actor: { agentId: run.agentId } };
  const plan = await planOfStage(tx, run, stage, at);
  if (plan) return syncSourceWaits(tx, { ...source, plan });
  if (run.departmentId && await setsWaitDates(tx, run.companyId, run.departmentId)) throw refuse(400, 'task_invalid', `This department sets dates for its waits, and none for a run at its ${stage} stage. Ask who owns the department to set a policy for it.`);
  return recordLegacyWait(tx, source);
}

/* A run moved to another stage. A stage with a policy has a clock of its own, from now; without one the dates it has stay. */
export async function moveRunStage(tx: Tx, run: RunSource, stage: RunStage, at: Date): Promise<void> {
  const sourceKey = runSourceKey(run.id);
  const [seen] = await tx.select(only(taskWaits, 'sourceState')).from(taskWaits).where(and(eq(taskWaits.taskId, run.taskId), eq(taskWaits.sourceKey, sourceKey), inArray(taskWaits.state, OPEN_STATES)));
  if (!seen || seen.sourceState.stage === stage) return;
  const task = await lockedTask(tx, run.taskId);
  const wait = await lastOfSource(tx, task, 'run', sourceKey);
  if (!wait || !isOpen(wait)) return;
  const moved = { sourceState: { ...wait.sourceState, stage }, sourceRevision: wait.sourceRevision + 1 };
  const plan = await planOfStage(tx, run, stage, at);
  if (plan) await rebind(tx, task, wait, { ...moved, owner: { agentId: run.agentId }, plan }, { agentId: run.agentId }, `A run on this task reached its ${stage} stage, with dates of its own.`);
  else await tx.update(taskWaits).set({ ...moved, updatedAt: at }).where(eq(taskWaits.id, wait.id));
}

/* Those who answer for the wait may change it: naming someone in a plan gives them no more than that. */
async function agentMayReplan(tx: Tx, task: Task, wait: TaskWait, agentId: string): Promise<boolean> {
  if (wait.ownerAgentId === agentId || wait.plan?.finalReview.headAgentId === agentId) return true;
  const [agent] = await tx.select({ kind: agents.kind, departmentId: agents.departmentId }).from(agents).where(eq(agents.id, agentId));
  return agent?.kind === 'orchestrator' || (agent?.kind === 'head' && agent.departmentId === task.departmentId);
}

/* A person who runs the task's department too, every one of them where several do, as the CEO and the delegate do. */
async function personMayReplan(tx: Tx, task: Task, wait: TaskWait, personId: string): Promise<boolean> {
  if (wait.ownerPersonId === personId || wait.finalDecisionPersonId === personId) return true;
  const [person] = await tx
    .select({ id: people.id, companyId: people.companyId, scopeKind: people.scopeKind, status: people.status, isOwner: people.isOwner, isCeoDelegate: people.isCeoDelegate })
    .from(people)
    .where(and(eq(people.id, personId), eq(people.companyId, task.companyId)));
  return person ? runsDepartment(tx, person, task.departmentId) : false;
}

const mayReplan = (tx: Tx, task: Task, wait: TaskWait, actor: Actor): Promise<boolean> =>
  actor.agentId ? agentMayReplan(tx, task, wait, actor.agentId) : personMayReplan(tx, task, wait, actor.personId!);

function replanned(wait: TaskWait, valid: ReplanWait): { owner: WaitOwnerBinding; plan: WaitPlan } {
  const owner = valid.ownerBinding ?? waitOwner(wait);
  const plan = valid.plan ? normalPlan(valid.plan) : wait.plan;
  if (!owner || !plan) throw refuse(400, 'task_invalid', 'A wait with no plan yet needs a whole plan and its owner.');
  if ((plan.finalReview.intervalMs === null) !== signalsOnce(wait.kind, wait.sourceKey)) throw refuse(400, 'task_invalid', 'Only an external operation reviews once; every other source repeats until it ends.');
  return { owner, plan };
}

/* Someone who answers for the wait gives it a new owner or new dates, having read the generation they change. */
export async function replanWait(tx: Tx, input: ReplanWait & { actor: Actor }): Promise<TaskWait> {
  const { actor, ...source } = input;
  const valid = parsed(ReplanWait, source);
  const [seen] = await tx.select(only(taskWaits, 'taskId')).from(taskWaits).where(eq(taskWaits.id, valid.waitId));
  if (!seen) throw refuse(404, 'task_unknown', 'There is no such wait.');
  const task = await lockedTask(tx, seen.taskId);
  const [wait] = await tx.select().from(taskWaits).where(eq(taskWaits.id, valid.waitId)).for('update');
  await requireActor(tx, task.companyId, actor);
  if (!(await mayReplan(tx, task, wait!, actor))) throw refuse(403, 'task_not_yours', 'This wait is not for you to change.');
  if (!isOpen(wait!)) throw refuse(409, 'task_closed', 'This wait has ended.');
  if (wait!.generation !== valid.expectedGeneration) throw staleSource();
  const { owner, plan } = replanned(wait!, valid);
  await requireOwner(tx, task.companyId, owner);
  await requirePlan(tx, task.companyId, plan);
  return rebind(tx, task, wait!, { owner, plan, sourceState: wait!.sourceState, sourceRevision: wait!.sourceRevision }, actor, `A wait on this task has a new owner or new dates: ${valid.reason}`);
}

/* Where a source stands now, with its record and its accountable dates as they are: a wait coming back to be looked at has not
   ended, and proves nothing about what it waited for. */
export async function setWaitStage(tx: Tx, input: { taskId: string; kind: WaitSourceKind; sourceKey: string; stage: NonNullable<WaitSourceState['stage']> }): Promise<TaskWait | null> {
  const task = await lockedTask(tx, input.taskId);
  const wait = await lastOfSource(tx, task, input.kind, input.sourceKey);
  if (!wait || !isOpen(wait)) return null;
  const [kept] = await tx.update(taskWaits).set({ sourceState: { ...wait.sourceState, stage: input.stage }, updatedAt: new Date() }).where(eq(taskWaits.id, wait.id)).returning();
  return kept!;
}

export type FinalReviewStep = { wait: TaskWait; ordinal: number; skipped: number };

/* The final review due now, once: whoever holds this step writes its one notice in the same transaction. The sequence goes on
   from its anchor and no promise moves. A source that signals once stands at the top level after it, with none left. */
export async function claimFinalReview(tx: Tx, input: { waitId: string; expectedGeneration: number; at: Date }): Promise<FinalReviewStep | null> {
  const [seen] = await tx.select(only(taskWaits, 'taskId')).from(taskWaits).where(eq(taskWaits.id, input.waitId));
  if (!seen) return null;
  const task = await lockedTask(tx, seen.taskId);
  const [wait] = await tx.select().from(taskWaits).where(eq(taskWaits.id, input.waitId)).for('update');
  if (wait!.state !== 'active' || wait!.generation !== input.expectedGeneration || !wait!.nextReviewAt || wait!.nextReviewAt > input.at) return null;
  const review = wait!.plan!.finalReview;
  const next = nextReview(review, wait!.nextReviewAt, input.at);
  const ordinal = wait!.reviewOrdinal + 1;
  const [kept] = await tx.update(taskWaits).set({ reviewOrdinal: ordinal, nextReviewAt: next.at, updatedAt: new Date(), ...(next.at ? {} : { level: 3 }) }).where(eq(taskWaits.id, wait!.id)).returning();
  await ownNote(tx, task, { kind: 'wait_due', text: 'The final review of a wait on this task is due.', data: logged(kept!, { reviewOrdinal: ordinal, skipped: next.skipped }) });
  return { wait: kept!, ordinal, skipped: next.skipped };
}
