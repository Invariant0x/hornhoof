import { hideCredentialsIn } from '@hornhoof/protocol/redaction';
import { countOnly, idOnly, only } from '../../db/selections.js';
import { applyTurnCleanup, prepareRouteChange, publishRouteChanges, requireTaskHead } from './echelons-update.js';
import { newTrackerFields, type TrackerFields, type TrackerInput } from '../tracker/task-fields.js';
import { nudgeTrackerKeepers } from '../tracker/nudge.js';
import { writeEdit, type TaskEdit } from '../tracker/edit.js';
import { followedStage, holdPipelines, holdPlace } from '../tracker/pipelines.js';
import { submitAtTests, testsReport, type Verification } from './echelons-tests.js';
import { acceptCandidate, type AcceptanceInput } from './echelons-accept.js';
import { architectureReport, coordinationReport } from './echelons-report.js';
import { replayedSubmission, submissionOperation, type Submission } from './echelons-operations.js';
import { checkerFor, checkingIdentity, hasChecker, heldCheckingIdentity, producerIdentity } from './echelons-assign.js';
import { producedCandidate, currentCandidate, currentHanded, requireRepairHistory } from './echelons-candidates.js';
import { acceptDocument, documentHandIn } from './echelons-document.js';
import { forwardHandoff } from './echelons-handoff.js';
import { echelonVerdict } from './echelons-verdict.js';
import { turnkeyReport, turnkeyWork, wouldGoThroughEchelons } from './turnkey.js';
import { openTurnOf } from './turn-department.js';
import { createRoute, departmentStages, documentCheck, routeOf, changeRoute, cancelRoutes, endRoutes, skippedData, type Route } from './echelons-store.js';
import { isStaged, type EchelonStage } from '@hornhoof/protocol/echelons';
import type { StageRoute } from '../templates/load.js';
import { lastTaskNumber } from './numbers.js';
import type { ApprovalChannel, NotificationSource } from '@hornhoof/protocol';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { accessOf, canReach, type Access, type Spot } from '../../auth/access.js';
import type { Db } from '../../db/client.js';
import { agents, attachments, companies, jobs, people, requests, subscriptions, taskEvents, tasks, type DecisionTopic, type RequestOption, type TaskEventKind } from '../../db/schema.js';
import { ApiError, type ErrorReason } from '../../errors.js';
import { refuseNotUrgent, urgencyOfNew } from './urgency.js';
import { canDecide } from '../../auth/decisions.js';
import type { DecisionSubject } from '../../auth/decision-owner.js';
import { checkDelegation, contextMissing, requireDecider, type Delegation } from '../conversation/decision-context.js';
import { commitProof, proofLine } from '../testruns/commit-proof.js';
import { dropEarlierWakes, keepWakes } from './outbox.js';
import { returnAlongLine } from '../org/map-state.js';
import { handOff } from './pulses.js';
import { recordCause, type WakeCause } from './notification-cause.js';
import { preserveNote } from './long-text.js';
import { captureReview } from './review-context.js';
import { refusePaused } from './pause.js';
import { repoAt } from '../departments/repository.js';
import type { ReviewVerdict } from './review-verdict.js';
import { checkIndependent, currentIndependent, type IndependentDeclaration, type IndependentPartInput } from './independent.js';
import type { WaitPlan } from '@hornhoof/protocol/waits';
import { alertGoal, goalColumns, type NewGoal } from './wait-goals.js';
import { bindAfter, bindRequest, endAfter, endRequest, keepWaitsWithMove, rebindAfter, type AfterPlans } from './wait-producers.js';
import { stuckRecipient } from './stuck-route.js';
import { removedEmployee, notifyUnfilledStages, replaceFutureOwners, type UnfilledStage } from './echelons-future.js';

export type Task = typeof tasks.$inferSelect;
export type Request = typeof requests.$inferSelect;
/* Who moves a task: a person from the web app, or an agent from its tools. */
export type Actor = { personId: string; agentId?: undefined } | { agentId: string; personId?: undefined };
export type WakeWhy = 'assigned' | 'review' | 'done' | 'reported' | 'blocked' | 'cancelled' | 'answered' | 'comment' | 'updated' | 'reminder' | 'go_on' | 'turn' | 'switched' | 'explain' | 'subtasks' | 'after_cancelled' | 'unblocked' | 'tests' | 'work' | 'calls' | 'reviewed' | 'wait_ended';
/* An agent that has to act on a task now; Hornhoof queues a turn for it. note: what else it should know, after the rest. */
export type Wake = { agentId: string; taskId: string; why: WakeWhy; text?: string; note?: string; version?: number; cause?: WakeCause };
export type Moved = { task: Task; wakes: Wake[] };

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/* Task commands use the same context for agents and people. */
type Live = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'templates' | 'config' | 'readCompare' | 'readCommit'>>;

export const CLOSED: readonly Task['status'][] = ['done', 'cancelled'];
/* Turns in a row that end without moving the task before the agent's head is asked to step in. */
export const SILENT_TURNS = 3;
/* Turns in a row an agent may go on in, saying how far it got or working until its time runs out, before its head is asked:
   about six hours of work without handing anything in. */
export const GOING_ON_TURNS = 8;
const COMMIT = /^[0-9a-f]{40}$/;

const STATUS_CODES = { 400: 'validation', 403: 'forbidden', 404: 'not_found', 409: 'conflict' } as const;
export const refuse = (status: keyof typeof STATUS_CODES, reason: ErrorReason, message: string) => new ApiError(status, STATUS_CODES[status], message, reason);

const notYours = (t: Task, what: string) => refuse(403, 'task_not_yours', `#${t.number} ${what}.`);

export async function loadTask(db: Db | Tx, taskId: string): Promise<Task> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw refuse(404, 'task_unknown', `There is no task ${taskId}.`);
  return task;
}

function stillOpen(task: Task): void {
  if (CLOSED.includes(task.status)) throw refuse(409, 'task_closed', `#${task.number} is ${task.status} already.`);
}

/* Work under a task that is still open: a task is done only once all of it is. */
async function refuseOpenUnder(db: Db | Tx, task: Task): Promise<void> {
  const open = await db.select(only(tasks, 'number')).from(tasks).where(and(eq(tasks.parentId, task.id), notInArray(tasks.status, [...CLOSED]))).orderBy(asc(tasks.number));
  if (open.length) throw refuse(409, 'task_invalid', `#${task.number} still has open subtasks: ${open.map(t => `#${t.number}`).join(', ')}. Wait for them, or cancel them first.`);
}

/* Done means all of it: work under it still open would go on under a finished task, and the turn with it. A move that ends
   the work under it itself is checked once what goes with it ran (ran true), any other before. */
async function doneWhole(tx: Tx, task: Task, set: Partial<Task>, n: { endsWorkUnder?: true }, ran: boolean): Promise<void> {
  if (set.status === 'done' && Boolean(n.endsWorkUnder) === ran) await refuseOpenUnder(tx, task);
}

/* The last child wakes its current parent owner; each executable child already owns its Review. */
async function workUnderDone(tx: Tx, closed: Task, actorId: string | undefined): Promise<Wake[]> {
  const [parent] = await tx.select().from(tasks).where(eq(tasks.id, closed.parentId!));
  if (!parent?.assigneeAgentId || CLOSED.includes(parent.status) || parent.assigneeAgentId === actorId) return [];
  const [open] = await tx.select(idOnly(tasks)).from(tasks).where(and(eq(tasks.parentId, parent.id), notInArray(tasks.status, [...CLOSED]))).limit(1);
  return open || (await openAfter(tx, parent)).length ? [] : [{ agentId: parent.assigneeAgentId, taskId: parent.id, why: 'subtasks' }];
}

/* Names as a reader says them: "A", "A and B", "A, B and C". */
function joined(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');
}

/* Task numbers as a reader says them: "#2", "#2 and #3", "#2, #3 and #4". */
export function listed(rows: Pick<Task, 'number'>[]): string {
  return joined(rows.map(t => `#${t.number}`));
}

/* The tasks this one comes after that are not done yet, by number. */
export async function openAfter(db: Db | Tx, task: Pick<Task, 'after'>): Promise<Pick<Task, 'id' | 'number' | 'status'>[]> {
  if (!task.after.length) return [];
  return db.select({ id: tasks.id, number: tasks.number, status: tasks.status }).from(tasks).where(and(inArray(tasks.id, task.after), ne(tasks.status, 'done'))).orderBy(asc(tasks.number));
}

/* A task that still waits for what it comes after takes no work in for it. */
async function refuseWaiting(db: Db | Tx, task: Task): Promise<void> {
  const open = await openAfter(db, task);
  if (open.length) throw refuse(409, 'task_invalid', `#${task.number} waits for ${listed(open)} first. You are woken once it can start.`);
}

/* A promise stands for one of the tasks it comes after, and for nothing else. */
function checkAfterPlans(after: string[], plans: AfterPlans | undefined): void {
  if (Object.keys(plans ?? {}).some(id => !after.includes(id))) throw refuse(400, 'task_invalid', 'A plan names a task this one does not come after.');
}

/* What a task comes after: tasks of the company, each once and none cancelled. hold: they stay as read until the
   transaction ends, so none is done meanwhile unseen. */
async function checkAfter(db: Db | Tx, companyId: string, ids: string[], hold = false): Promise<Task[]> {
  if (new Set(ids).size !== ids.length) throw refuse(400, 'task_invalid', 'A task it comes after is listed twice.');
  const read = db.select().from(tasks).where(inArray(tasks.id, ids));
  const rows = ids.length ? await (hold ? read.orderBy(asc(tasks.id)).for('share') : read) : [];
  for (const id of ids) {
    const t = rows.find(r => r.id === id);
    if (!t || t.companyId !== companyId) throw refuse(400, 'task_invalid', `There is no task ${id} to come after.`);
    if (t.status === 'cancelled') throw refuse(400, 'task_invalid', `#${t.number} is cancelled, so nothing can come after it.`);
  }
  return rows;
}

/* A task never waits for itself, also not through the tasks it comes after. */
async function refuseCircle(db: Db | Tx, task: Task, ids: string[]): Promise<void> {
  const seen = new Set<string>();
  let level = ids;
  while (level.length) {
    if (level.includes(task.id)) throw refuse(400, 'task_invalid', `#${task.number} would wait for itself through what it comes after.`);
    const rows = await db.select(only(tasks, 'after')).from(tasks).where(inArray(tasks.id, level));
    level = rows.flatMap(r => r.after).filter(id => !seen.has(id) && Boolean(seen.add(id)));
  }
}

/* A task never waits for a task it is part of, however far up: that one is done only once the work under it is. */
async function refuseAbove(db: Db | Tx, parentId: string | null, ids: string[]): Promise<void> {
  for (let id = ids.length ? parentId : null; id; ) {
    const [up] = await db.select({ id: tasks.id, number: tasks.number, parentId: tasks.parentId }).from(tasks).where(eq(tasks.id, id));
    if (!up) return;
    if (ids.includes(up.id)) throw refuse(400, 'task_invalid', `#${up.number} is the task this work is part of, so it cannot come after it: #${up.number} is done only once the work under it is.`);
    id = up.parentId;
  }
}

/* Nor for work under it, however far down: that work is part of it. */
async function refuseBelow(db: Db | Tx, task: Task, ids: string[]): Promise<void> {
  let level = ids.length ? [task.id] : [];
  while (level.length) {
    const rows = await db.select({ id: tasks.id, number: tasks.number }).from(tasks).where(inArray(tasks.parentId, level));
    const under = rows.find(r => ids.includes(r.id));
    if (under) throw refuse(400, 'task_invalid', `#${under.number} is work under #${task.number}, so #${task.number} cannot come after it: the work under a task is part of it.`);
    level = rows.map(r => r.id);
  }
}

/* JSON lists of ids that hold any of these. */
const holdsAny = (list: typeof tasks.after, ids: string[]) => sql`${list} ?| array[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::text[]`;

/* The open tasks of the company that wait as said, in any turn or none, as a task may come after one of another
   department's turn: the index on what tasks come after finds them, so the rest of the company's history is not read. */
const comingAfter = (of: Task[], waits: SQL) => and(eq(tasks.companyId, of[0]!.companyId), waits, notInArray(tasks.status, [...CLOSED]));

/* A task is done: each task that came after it and waits for nothing else any more goes on with whoever holds it, and
   its log says why. rows: the tasks that started. Two tasks it waits for done at once would each see the other still
   open, so the waiting tasks are taken first and the second to be done sees the first. */
async function startAfter(tx: Tx, done: Task, actor: Actor): Promise<{ wakes: Wake[]; rows: Task[] }> {
  const waiting = await tx
    .select()
    .from(tasks)
    .where(comingAfter([done], sql`${tasks.after} @> ${JSON.stringify([done.id])}::jsonb`))
    .orderBy(asc(tasks.number))
    .for('update');
  const wakes: Wake[] = [];
  const rows: Task[] = [];
  for (const t of waiting) {
    await endAfter(tx, t, done, actor);
    if ((await openAfter(tx, t)).length) continue;
    const [row] = await tx.update(tasks).set({ version: sql`${tasks.version} + 1`, updatedAt: new Date() }).where(eq(tasks.id, t.id)).returning();
    const before = await tx.select(only(tasks, 'number')).from(tasks).where(inArray(tasks.id, t.after)).orderBy(asc(tasks.number));
    await tx.insert(taskEvents).values({ companyId: t.companyId, taskId: t.id, kind: 'started', text: `${listed(before)} ${before.length === 1 ? 'is' : 'are'} done, so it starts now.` });
    /* One that waits for a person's answer goes on with the answer. */
    if (row!.assigneeAgentId && ['open', 'working'].includes(row!.status)) wakes.push({ agentId: row!.assigneeAgentId, taskId: row!.id, why: 'assigned' });
    rows.push(row!);
  }
  return { wakes, rows };
}

/* Where a task sits, for the stream: its product inside its department, or the department; none for the orchestrator's. */
export const taskSpot = (t: Pick<Task, 'departmentId' | 'productId'>): Spot =>
  t.productId ? { departmentId: t.productId, parentId: t.departmentId } : { departmentId: t.departmentId, parentId: null };

const actorColumns = (a: Actor) => ({ personId: a.personId ?? null, agentId: a.agentId ?? null });

/* returned: the agent gives its work back to the one above it with this move, which the map shows on their line.
   endsWorkUnder: what goes with the move closes the open work under the task before it is done. */
type Note = { kind: TaskEventKind; actor: Actor; text?: string; data?: Record<string, unknown>; inlineText?: true; returned?: true; automatic?: NotificationSource; endsWorkUnder?: true };

export async function note(tx: Tx | Db, task: Pick<Task, 'id' | 'companyId'>, n: Note, config?: Pick<Ctx['config'], 'taskFilesBytes'>): Promise<{ id: number; createdAt: Date }> {
  n = hideCredentialsIn(n);
  const kept = await preserveNote(tx, task, n, config);
  const [row] = await tx
    .insert(taskEvents)
    .values({ companyId: task.companyId, taskId: task.id, kind: n.kind, ...actorColumns(n.actor), text: kept.text, data: kept.data })
    .returning({ id: taskEvents.id, createdAt: taskEvents.createdAt });
  return row!;
}

/* A line of Hornhoof's own, which nobody signed. */
export async function ownNote(tx: Tx, task: Pick<Task, 'id' | 'companyId'>, n: { kind: TaskEventKind; text: string; data: Record<string, unknown> }): Promise<void> {
  n = hideCredentialsIn(n);
  await tx.insert(taskEvents).values({ companyId: task.companyId, taskId: task.id, ...n });
}

/* A move by which an agent gives its work back lights its line to the one above it on the map: the task, when it did. */
async function givesBack(tx: Tx, row: Task, n: Note, event: { id: number; createdAt: Date }): Promise<Task | null> {
  if (!n.returned || !n.actor.agentId) return null;
  return (await returnAlongLine(tx, { agentId: n.actor.agentId, sourceKey: `task:${event.id}`, sourceTaskId: row.id, returnedAt: event.createdAt })) ? row : null;
}

/* The map reads its lines again when one of them changed, in the company of what changed it. */
function linesMoved(ctx: Live, changed: { companyId: string } | null): void {
  if (changed) ctx.bus.publish(changed.companyId, { type: 'org' });
}

async function lockMovePrerequisites(tx: Tx, task: Task, after: string[]): Promise<void> {
  await tx.select(idOnly(companies)).from(companies).where(eq(companies.id, task.companyId)).for('no key update');
  await tx.select(idOnly(tasks)).from(tasks).where(inArray(tasks.id, after)).orderBy(asc(tasks.id)).for('share');
  await refuseCircle(tx, task, after);
}

async function lockClosingParent(tx: Tx, task: Task, set: Partial<Task>): Promise<void> {
  if (!set.status || !CLOSED.includes(set.status) || !task.parentId) return;
  if (!set.after?.length) await tx.select(idOnly(companies)).from(companies).where(eq(companies.id, task.companyId)).for('no key update');
  await tx.select(idOnly(tasks)).from(tasks).where(eq(tasks.id, task.parentId)).for('no key update');
}

/* A change of status says in its line of the log where it went from and to, so the history tells how long each lasted. */
const statusNoted = (n: Note, from: Task['status'], to: Task['status']): Note => (from === to ? n : { ...n, data: { ...n.data, fromStatus: from, toStatus: to } });

/* One move: the task changes only if nobody moved it since it was read, and the move is written to its log. */
/* wakes: the turns the move needs, kept with it until they are queued. hold: the pipelines what goes with the move puts
   the task on, held before any task. */
export async function move(ctx: Live, task: Task, set: Partial<Task>, n: Note, also?: (tx: Tx, row: Task) => Promise<void>, wakes: Wake[] = [], hold: (string | null)[] = []): Promise<Task> {
  let started: Task[] = [];
  let lit: Task | null = null;
  let unstuck = false;
  const row = await ctx.db.transaction(async tx => {
    /* Two changes at once to what tasks come after would each miss the other's half of a circle: they go one at a time in
       a company, and the circle is looked for once it is this one's turn. What it comes after now is held until the move
       is kept, so one of them done meanwhile is seen, or sees this task wait for it. */
    /* A result joins a turn as a release closes the turn: the company goes first, then the task rows, as in every move of
       turns, so the release sees it or it sees the release. */
    if (n.data?.turnCleanup || n.data?.independentPart || set.turnId) await tx.select(idOnly(companies)).from(companies).where(eq(companies.id, task.companyId)).for('no key update');
    /* Its pipelines before any task, as a change of a pipeline takes them: the stage the task follows its holder to, or
       one what goes with the move names, stays until the move is in. */
    await holdPipelines(tx, hold);
    const followed = await followedStage(tx, task, set);
    if (set.after?.length) await lockMovePrerequisites(tx, task, set.after);
    /* Two tasks under one parent closing at once would each see the other still open, and nobody would hear that all of
       the work under it is closed: one that closes takes its parent first, so they close one after the other. */
    await lockClosingParent(tx, task, set);
    const [row] = await tx
      .update(tasks)
      .set({ externalWait: null, ...set, ...followed, ...(set.status && CLOSED.includes(set.status) ? { paused: null } : {}), version: task.version + 1, updatedAt: new Date() })
      .where(and(eq(tasks.id, task.id), eq(tasks.version, task.version)))
      .returning();
    if (!row) throw refuse(409, 'task_changed', `#${task.number} changed meanwhile. Read it again.`);
    await doneWhole(tx, task, set, n, false);
    await dropEarlierWakes(tx, task.id);
    const event = await note(tx, row, statusNoted(n, task.status, row.status), ctx.config);
    lit = await givesBack(tx, row, n, event);
    await also?.(tx, row);
    await doneWhole(tx, task, set, n, true);
    if (CLOSED.includes(row.status)) unstuck = await letStuckGo(tx, row.id);
    await keepWaitsWithMove(tx, task, row, { kind: n.kind, actor: n.actor, eventId: event.id });
    if (CLOSED.includes(row.status) && row.parentId) wakes.push(...(await workUnderDone(tx, row, n.actor.agentId)));
    /* What waited for it starts with the same move, so its turn is kept with it. */
    if (row.status === 'done') {
      const after = await startAfter(tx, row, n.actor);
      wakes.push(...after.wakes);
      started = after.rows;
    }
    recordCause(wakes, n, event.id, task);
    await keepWakes(tx, task.companyId, wakes);
    return row;
  });
  published(ctx, row);
  if (row.status !== task.status) await nudgeTrackerKeepers(ctx, row, n.actor.agentId);
  if (unstuck) ctx.bus.publish(row.companyId, { type: 'requests', spot: taskSpot(row) });
  for (const t of started) published(ctx, t);
  linesMoved(ctx, lit);
  await handOff(ctx, n.actor, row);
  return row;
}

export function published(ctx: Pick<Ctx, 'bus'>, task: Task): void {
  ctx.bus.publish(task.companyId, { type: 'task', id: task.id, spot: taskSpot(task) });
}

/* Whoever gave the task, when that was an agent other than the one acting. Whoever gave out a task that is done hears it
   only for a task of its own: work under a bigger task is heard of once, when the last of it closes. */
export const giver = (task: Task, why: WakeWhy, actorId?: string, text?: string): Wake[] =>
  task.createdByAgentId && task.createdByAgentId !== actorId && !(task.parentId && (why === 'done' || why === 'reported')) ? [{ agentId: task.createdByAgentId, taskId: task.id, why, ...(text ? { text } : {}) }] : [];

/* Whether the task waits for a person's word other than Hornhoof's note that it stood still. */
export async function waitsForPerson(db: Db | Tx, taskId: string): Promise<boolean> {
  const [open] = await db.select(idOnly(requests)).from(requests).where(and(eq(requests.taskId, taskId), eq(requests.status, 'open'), notInArray(requests.kind, ['stuck']))).limit(1);
  return !!open;
}

/* Hornhoof's notes that the task stood still are over once it moves again: handed on, handed in or reported. */
async function letStuckGo(tx: Tx, taskId: string): Promise<boolean> {
  const gone = await tx.update(requests).set({ status: 'withdrawn', answeredAt: new Date() }).where(and(eq(requests.taskId, taskId), eq(requests.status, 'open'), eq(requests.kind, 'stuck'))).returning({ id: requests.id });
  return gone.length > 0;
}

/* The notes go with the move, and people hear of it once the move is in. */
function stuckGoes(ctx: Live, task: Task): { also: (tx: Tx) => Promise<void>; tell: () => void } {
  let gone = false;
  return {
    also: async tx => {
      gone = await letStuckGo(tx, task.id);
    },
    tell: () => {
      if (gone) ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
    },
  };
}

export type NewTask = {
  resultKind?: 'code' | 'document' | 'coordination';
  title: string;
  brief: string;
  body: string;
  departmentId: string | null;
  productId?: string | null;
  parentId?: string | null;
  assigneeAgentId: string;
  /* Optional distinct employee who prepares the Architecture plan before Development starts with assigneeAgentId. */
  architectAgentId?: string;
  /* Executable work starts with this employee; coordination has no code producer. */
  executor?: boolean;
  reviewerAgentId?: string;
  securityAgentId?: string;
  testsAgentId?: string;
  cleanup?: boolean;
  paths?: string[];
  /* Tasks of the same turn that must be done first. */
  after?: string[];
  /* What the giver promises for each of them, by id, in place of the department's dates. */
  afterPlans?: AfterPlans;
  independentPart?: IndependentPartInput;
  independentNone?: string;
  workKind?: Task['workKind'];
  riskClass?: Task['riskClass'];
  /* Of a task with nothing above it; one under a task is what that task is. */
  urgent?: boolean;
  small?: boolean;
} & TrackerInput;

/* A live employee or orchestrator of the company. An assistant's own agent is its owner's, not the company's. */
export async function liveAgent(db: Db | Tx, companyId: string | null, id: string) {
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, id), isNull(agents.removedAt)));
  if (!agent || agent.kind === 'assistant' || (companyId && agent.companyId !== companyId)) throw refuse(400, 'task_invalid', `There is no employee ${id}.`);
  return agent;
}

/* A live agent that can take a turn needs an active subscription and must be switched on. */
async function workingAgent(db: Db | Tx, companyId: string | null, id: string) {
  const agent = await liveAgent(db, companyId, id);
  if (agent.switchedOffAt) throw refuse(409, 'switched_off', `${agent.name} is switched off right now. Give the work to someone who is on.`);
  const [sub] = agent.subscriptionId
    ? await db.select(idOnly(subscriptions)).from(subscriptions).where(and(eq(subscriptions.id, agent.subscriptionId), isNull(subscriptions.removedAt)))
    : [];
  if (!sub) throw refuse(409, 'no_subscription', `${agent.name} has no subscription to run on. Give them one on their card first.`);
  return agent;
}

async function checkIndependentExecutor(db: Db, departmentId: string | null, part: IndependentPartInput): Promise<void> {
  const agent = await workingAgent(db, null, part.executor);
  if (agent.departmentId !== departmentId) throw refuse(403, 'task_not_yours', `${agent.name} does not work in this department.`);
}

async function insertIndependent(tx: Tx, parent: Task, part: IndependentPartInput, actor: Actor, plan: StageRoute): Promise<{ child: Task; wake: Wake }> {
  await tx.select(idOnly(companies)).from(companies).where(eq(companies.id, parent.companyId)).for('no key update');
  const last = await lastTaskNumber(tx, parent.companyId);
  const [child] = await tx.insert(tasks).values({
    companyId: parent.companyId,
    number: last + 1,
    parentId: parent.id,
    departmentId: parent.departmentId,
    productId: parent.productId,
    title: part.title.trim(),
    brief: part.brief.trim(),
    body: part.body,
    assigneeAgentId: part.executor,
    executorAgentId: part.executor,
    after: [],
    workKind: parent.workKind,
    riskClass: parent.riskClass,
    urgent: parent.urgent,
    /* A part of the same work answers to the same person and serves its whole's goal. */
    responsiblePersonId: parent.responsiblePersonId,
    dueAt: parent.dueAt,
    createdByPersonId: actor.personId ?? null,
    createdByAgentId: actor.agentId ?? null,
    updatedAt: new Date(),
  }).returning();
  /* A part of the same work may touch what its whole may, as the head approved it there. */
  const whole = await routeOf(tx, parent);
  const skipped = await createRoute(tx, child!, { paths: whole.paths, ...(whole.state.resultKind === 'document' ? { resultKind: 'document' } : {}) }, plan);
  const event = await note(tx, child!, { kind: 'created', actor, text: child!.brief, data: { toStatus: child!.status, assignee: child!.assigneeAgentId, after: [], independentPartOf: parent.id, ...skippedData(skipped) } });
  const wake: Wake = { agentId: child!.assigneeAgentId!, taskId: child!.id, why: 'assigned' };
  recordCause([wake], { kind: 'created', actor }, event.id, child!);
  return { child: child!, wake };
}

/* Who a new task gives work to, as urgent as it comes out: a word nobody may say is refused when the task is made. */
function checkNewHolders(ctx: Ctx, actor: Actor, companyId: string, parent: Task | null, input: NewTask, declaration: IndependentDeclaration | null): Promise<void> {
  const urgent = parent ? parent.urgent : input.urgent === true;
  const part = declaration?.kind === 'part' ? [declaration.part.executor] : [];
  const holders = [input.assigneeAgentId, ...(input.architectAgentId ? [input.architectAgentId] : []), ...part];
  return refuseNotUrgent(ctx, actor, companyId, { urgent, productId: input.productId ?? null }, holders);
}

type NewTaskSetup = { assignee: Awaited<ReturnType<typeof workingAgent>>; architect: Awaited<ReturnType<typeof workingAgent>> | null; parent: Task | null; declaration: IndependentDeclaration | null; plan: StageRoute; tracker: TrackerFields };

function checkNewTaskFields(input: NewTask): void {
  if (!input.title.trim()) throw refuse(400, 'task_invalid', 'A task needs a title.');
}

function inNewTaskScope(agent: typeof agents.$inferSelect, input: NewTask): boolean {
  return agent.departmentId === input.departmentId && (!agent.productId || agent.productId === input.productId);
}

async function stagedArchitect(ctx: Ctx, assignee: typeof agents.$inferSelect, architect: typeof agents.$inferSelect): Promise<typeof agents.$inferSelect | null> {
  if (!(await wouldGoThroughEchelons(ctx.db, { companyId: assignee.companyId, holderId: assignee.id }))) return null;
  if (!(await wouldGoThroughEchelons(ctx.db, { companyId: assignee.companyId, holderId: architect.id }))) {
    throw refuse(409, 'task_invalid', 'A member of a turnkey team takes only their own whole result, never a separate Architecture stage.');
  }
  return architect;
}

async function resolveArchitect(ctx: Ctx, assignee: typeof agents.$inferSelect, input: NewTask, plan: StageRoute): Promise<typeof agents.$inferSelect | null> {
  if (!input.architectAgentId) return null;
  const architect = await workingAgent(ctx.db, assignee.companyId, input.architectAgentId);
  if (!inNewTaskScope(architect, input)) throw refuse(400, 'task_invalid', 'Architecture needs an employee in the task scope.');
  const separate = architect.id !== assignee.id && !input.small && input.resultKind !== 'coordination' && plan.stages.some(step => step.stage === 'architecture');
  return separate ? stagedArchitect(ctx, assignee, architect) : null;
}

async function prepareNewTask(ctx: Ctx, actor: Actor, input: NewTask): Promise<NewTaskSetup> {
  const assignee = await workingAgent(ctx.db, null, input.assigneeAgentId);
  checkNewTaskFields(input);
  checkAfterPlans(input.after ?? [], input.afterPlans);
  const declaration = checkIndependent(input.after ?? [], input.independentPart, input.independentNone, null);
  if (declaration?.kind === 'part') await checkIndependentExecutor(ctx.db, input.departmentId, declaration.part);
  await requireNewCleanup(ctx, actor, assignee.companyId, input);
  await requireNewReviewer(ctx, assignee, input);
  const parent = input.parentId ? await loadTask(ctx.db, input.parentId) : null;
  if (parent) stillOpen(parent);
  await checkNewHolders(ctx, actor, assignee.companyId, parent, input, declaration);
  const tracker = await newTrackerFields(ctx, assignee.companyId, taskSpot({ departmentId: input.departmentId, productId: input.productId ?? null }), parent, input, assignee.id);
  const plan = await departmentStages(ctx, input.departmentId, tracker.pipelineId);
  const architect = await resolveArchitect(ctx, assignee, input, plan);
  return { assignee, architect, parent, declaration, plan, tracker };
}

async function requireNewCleanup(ctx: Ctx, actor: Actor, companyId: string, input: NewTask): Promise<void> {
  if (input.cleanup !== undefined) {
    const head = actor.agentId ? await liveAgent(ctx.db, companyId, actor.agentId) : null;
    if (head?.kind !== 'head' || head.departmentId !== input.departmentId) throw refuse(403, 'task_not_yours', 'Only the department head may request optional Cleanup.');
  }
}

async function requireNewReviewer(ctx: Ctx, assignee: typeof agents.$inferSelect, input: NewTask): Promise<void> {
  if (!input.reviewerAgentId) return;
  const reviewer = await workingAgent(ctx.db, assignee.companyId, input.reviewerAgentId);
  if (reviewer.id === assignee.id || !inNewTaskScope(reviewer, input)) throw refuse(400, 'task_invalid', 'Review needs another employee in the task scope.');
}

async function parentForNewTask(tx: Tx, parent: Task | null): Promise<Task | null> {
  if (!parent) return null;
  const [now] = await tx.select().from(tasks).where(eq(tasks.id, parent.id)).for('no key update');
  stillOpen(now!);
  const route = await routeOf(tx, now!);
  if (isStaged(route.state.resultKind) && !['architecture', 'development'].includes(route.state.stage ?? '')) throw refuse(409, 'task_invalid', 'A checking candidate cannot acquire unfinished child work.');
  const open = await openAfter(tx, now!);
  if (open.length) throw refuse(409, 'task_invalid', `#${now!.number} waits for ${listed(open)} first, so no work goes under it yet. You are woken once it can start.`);
  return now!;
}

function independentData(declaration: IndependentDeclaration | null): Record<string, unknown> {
  if (declaration?.kind === 'part') return { independentPart: declaration.part };
  if (declaration?.kind === 'none') return { independentNone: declaration.reason };
  return {};
}

function newTaskValues(actor: Actor, input: NewTask, { assignee, architect, parent, tracker }: NewTaskSetup, position: { urgent: boolean; number: number }): typeof tasks.$inferInsert {
  const initialOwner = architect ?? assignee;
  return {
        ...tracker,
        companyId: assignee.companyId,
        number: position.number,
        parentId: parent?.id ?? null,
        departmentId: input.departmentId,
        productId: input.productId ?? null,
        title: input.title.trim(),
        brief: input.brief.trim(),
        body: input.body,
        assigneeAgentId: initialOwner.id,
        executorAgentId: input.executor ? assignee.id : null,
        after: input.after ?? [],
        workKind: input.workKind,
        riskClass: input.riskClass,
        urgent: position.urgent,
        small: input.small === true,
        createdByPersonId: actor.personId ?? null,
        createdByAgentId: actor.agentId ?? null,
        updatedAt: new Date(),
      };
}

type CreatedTask = Moved & { independent: Task | null };

async function afterForNewTask(tx: Tx, companyId: string, parent: Task | null, input: NewTask): Promise<Task[]> {
  const after = await checkAfter(tx, companyId, input.after ?? [], true);
  await refuseAbove(tx, parent?.id ?? null, input.after ?? []);
  return after;
}

async function insertNewTask(tx: Tx, actor: Actor, input: NewTask, setup: NewTaskSetup): Promise<CreatedTask> {
  const { assignee, parent, declaration, plan } = setup;
  let independent: Task | null = null;
  const wakes: Wake[] = [];
  /* Numbers go up one by one per company, so creating tasks waits on the company row. */
  await tx.select(idOnly(companies)).from(companies).where(eq(companies.id, assignee.companyId)).for('no key update');
  /* Its pipeline before any task, as a change of the pipeline takes it: a stage taken off it since it was checked is a
     conflict. */
  await holdPlace(tx, setup.tracker);
  /* A parent cancelled meanwhile takes no new work; one cancelled after this waits and cancels the new task with it. */
  const above = await parentForNewTask(tx, parent);
  /* With the company held, so a change of urgency on its way reaches this task, or waits for it. */
  const urgent = await urgencyOfNew(tx, assignee.companyId, actor, above, input.urgent, input.departmentId);
  const last = await lastTaskNumber(tx, assignee.companyId);
  /* One of them done at this moment would not see the new task wait for it, so they are held while it is decided
     whether it waits: that one is done after the task is made, and starts it. */
  const after = await afterForNewTask(tx, assignee.companyId, parent, input);
  const waits = after.some(t => t.status !== 'done');
  const [row] = await tx
    .insert(tasks)
    .values(newTaskValues(actor, input, setup, { urgent, number: last + 1 }))
    .returning();
  const skipped = await createRoute(tx, row!, input, plan);
  const event = await note(tx, row!, { kind: 'created', actor, text: row!.brief, data: {
    toStatus: row!.status,
    assignee: row!.assigneeAgentId,
    after: row!.after,
    ...independentData(declaration),
    ...skippedData(skipped),
  } });
  await bindAfter(tx, row!, after, input.afterPlans, actor);
  if (declaration?.kind === 'part') {
    const made = await insertIndependent(tx, row!, declaration.part, actor, plan);
    independent = made.child;
    wakes.push(made.wake);
  }
  /* One that waits for what it comes after is not given out yet: the move that finishes the last of them wakes its holder. */
  if (!waits) wakes.push({ agentId: row!.assigneeAgentId!, taskId: row!.id, why: 'assigned' });
  recordCause(wakes, { kind: 'created', actor }, event.id, row!);
  await keepWakes(tx, row!.companyId, wakes);
  return { task: row!, wakes, independent };
}

/* Whether work of a department with no repository goes through its stages as a document: from an employee outside the
   turnkey teams, where the route of the department has a check and somebody else there carries its skill. Anywhere else such
   work is done as before, by its holder alone. */
async function handsInDocument(ctx: Ctx, input: NewTask): Promise<boolean> {
  const check = documentCheck(await departmentStages(ctx, input.departmentId));
  if (!check) return false;
  const author = await workingAgent(ctx.db, null, input.assigneeAgentId);
  if (!(await hasChecker(ctx.db, author, check))) return false;
  return wouldGoThroughEchelons(ctx.db, { companyId: author.companyId, holderId: author.id });
}

async function executorResult(ctx: Ctx, input: NewTask): Promise<NonNullable<NewTask['resultKind']>> {
  if (await repoAt(ctx, [input.productId ?? null, input.departmentId])) return 'code';
  return await handsInDocument(ctx, input) ? 'document' : 'coordination';
}

export async function createTask(ctx: Ctx, actor: Actor, input: NewTask): Promise<Moved> {
  input = hideCredentialsIn(input);
  if (input.resultKind === undefined && input.executor) {
    const resultKind = await executorResult(ctx, input);
    input = { ...input, resultKind, executor: resultKind !== 'coordination' };
  }
  const setup = await prepareNewTask(ctx, actor, input);
  const { task, wakes, independent } = await ctx.db.transaction(tx => insertNewTask(tx, actor, input, setup));
  published(ctx, task);
  await nudgeTrackerKeepers(ctx, task, actor.agentId);
  if (independent) published(ctx, independent);
  await handOff(ctx, actor, task);
  if (independent) await handOff(ctx, actor, independent);
  return { task, wakes };
}

export async function submissionTask(ctx: Live, agentId: string, taskId: string): Promise<Task> {
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  const kind = (await routeOf(ctx.db, task)).state.resultKind;
  if (kind === 'turnkey') throw turnkeyWork(task);
  if (!isStaged(kind)) throw refuse(400, 'task_invalid', `#${task.number} has a coordination result. Report its checked child results.`);
  if (task.assigneeAgentId !== agentId) throw notYours(task, 'is not waiting for your work');
  refusePaused(task);
  if (task.status === 'waiting' && (await waitsForPerson(ctx.db, task.id))) throw refuse(409, 'task_invalid', `#${task.number} waits for a person's answer first.`);
  await refuseWaiting(ctx.db, task);
  await refuseOpenUnder(ctx.db, task);
  return task;
}

/* The current producing owner records an immutable candidate and hands it forward. */
export async function submit(ctx: Live, agentId: string, taskId: string, r: Submission): Promise<Moved> {
  const before = await loadTask(ctx.db, taskId);
  await liveAgent(ctx.db, before.companyId, agentId);
  const operation = submissionOperation(r);
  const replay = await replayedSubmission(ctx.db, before, agentId, operation);
  if (replay) return replay;
  try {
    return await submitCandidate(ctx, agentId, taskId, r, operation);
  } catch (error) {
    if (operation && error instanceof ApiError && [403, 409].includes(error.status)) {
      const repeated = await replayedSubmission(ctx.db, await loadTask(ctx.db, taskId), agentId, operation);
      if (repeated) return repeated;
    }
    throw error;
  }
}

function requireSubmissionStage(task: Task, route: Route): void {
  if (route.state.resultKind === 'coordination') throw refuse(400, 'task_invalid', 'A coordination result has no code candidate. Report its checked child results.');
  if (!['development', 'review', 'security', 'cleanup', 'tests'].includes(route.state.stage ?? '') || route.state.phase !== 'active') throw notYours(task, 'is not waiting for code from your current stage');
}

/* The commit as it is handed in: read from the repository, inside the paths the head approved, and on top of what the
   stage received. */
async function commitHandIn(ctx: Live, agentId: string, task: Task, route: Route, r: Submission) {
  const prior = route.state.candidateId ? await currentCandidate(ctx.db, task, route) : null;
  const checkerStage = route.state.stage !== 'development';
  const review = await captureReview(ctx, { ...task, executorAgentId: agentId }, r.review, prior?.branch);
  const producer = await producerIdentity(ctx.db, task, agentId);
  if (prior && checkerStage) await checkingIdentity(ctx, task, route, prior);
  const candidate = producedCandidate(route, producer, review);
  if (prior) await requireRepairHistory(ctx, task, prior, candidate);
  return { input: checkerStage ? prior : null, candidate, review };
}

async function submitCandidate(ctx: Live, agentId: string, taskId: string, r: Submission, operation: ReturnType<typeof submissionOperation>): Promise<Moved> {
  const task = await submissionTask(ctx, agentId, taskId);
  const route = await routeOf(ctx.db, task);
  requireSubmissionStage(task, route);
  if (route.state.stage === 'tests') return submitAtTests(ctx, agentId, task, route, r, operation);
  const { input, candidate, review } = route.state.resultKind === 'document' ? await documentHandIn(ctx, agentId, task, route, r) : await commitHandIn(ctx, agentId, task, route, r);
  const next = await forwardHandoff(ctx, task, route, candidate);
  const unstuck = stuckGoes(ctx, task);
  const row = await move(ctx, task, next.set, {
    kind: 'submitted', actor: { agentId }, text: r.summary, returned: true,
    data: { evidence: r.evidence, candidate, ...(operation ? { operation } : {}), routeRevision: route.revision, ...(review ? { review } : {}), ...skippedData(next.skipped) },
  }, async tx => {
    if (input) await heldCheckingIdentity(tx, task, route, input);
    await changeRoute(tx, route, next.state);
    await unstuck.also(tx);
  }, next.wakes);
  unstuck.tell();
  return { task: row, wakes: next.wakes };
}

type Verdict = ReviewVerdict & { comment: string };

/* One current checker owns both its verdict and its fixes. */
export async function verdict(ctx: Live, agentId: string, taskId: string, v: Verdict): Promise<Moved> {
  return echelonVerdict(ctx, agentId, taskId, v);
}

function requireOwner(task: Task, agentId: string, refusal: string): void {
  stillOpen(task);
  if (task.assigneeAgentId !== agentId) throw notYours(task, refusal);
}

function requireReporter(task: Task, agentId: string): void {
  requireOwner(task, agentId, 'is not yours to report');
}

async function reportToResolver(ctx: Live, agentId: string, task: Task, summary: string, n: Note): Promise<Moved> {
  /* A person gave it, so an internal resolver has to unblock it. */
  const [asker] = await ctx.db.select().from(agents).where(eq(agents.id, agentId));
  const recipient = asker ? await stuckRecipient(ctx.db, asker, task) : null;
  let wakes: Wake[] = [];
  const row = await move(ctx, task, { status: 'waiting' }, n, async tx => {
    await letStuckGo(tx, task.id);
    const [note] = await tx.insert(requests).values({ companyId: task.companyId, taskId: task.id, agentId, kind: 'stuck', text: summary, decisionTopic: 'task', audience: 'internal', triageAgentId: recipient?.id ?? null }).returning();
    await bindRequest(tx, task, note!, { agentId });
    wakes = recipient ? [{ agentId: recipient.id, taskId: task.id, why: 'explain', text: note!.id }] : [];
    await keepWakes(tx, task.companyId, wakes);
  });
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  return { task: row, wakes };
}

type ReportInput = { done: boolean; summary: string; verification?: Verification; acceptance?: AcceptanceInput };
type ReportStage = 'acceptance' | 'tests' | 'architecture' | 'coordination' | 'turnkey';

function reportedStage(route: Route, done: boolean): ReportStage | null {
  if (route.state.resultKind === 'turnkey') return done ? 'turnkey' : null;
  if (done && route.state.phase === 'ready') return 'acceptance';
  if (route.state.stage === 'tests' && route.state.phase === 'active') return 'tests';
  if (done && route.state.stage === 'architecture') return 'architecture';
  if (done && route.state.resultKind === 'coordination') return 'coordination';
  return null;
}

async function reportStage(ctx: Live, task: Task, route: Route, agentId: string, input: ReportInput, stage: ReportStage): Promise<Moved> {
  stillOpen(task);
  await refuseWaiting(ctx.db, task);
  switch (stage) {
    case 'acceptance': return route.state.resultKind === 'document' ? acceptDocument(ctx, task, route, agentId, input.summary) : acceptCandidate(ctx, task, route, agentId, input.summary, input.acceptance);
    case 'tests': return testsReport(ctx, task, route, agentId, input.summary, input.verification, input.done);
    case 'architecture': return architectureReport(ctx, task, route, agentId, input.summary);
    case 'coordination': return coordinationReport(ctx, task, route, agentId, input.summary);
    case 'turnkey':
      if (input.verification || input.acceptance) throw turnkeyWork(task);
      return turnkeyReport(ctx, task, route, agentId, input.summary);
  }
}

export async function report(ctx: Live, agentId: string, taskId: string, r: ReportInput): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  refusePaused(task);
  const route = await routeOf(ctx.db, task);
  const stage = reportedStage(route, r.done);
  if (stage) return reportStage(ctx, task, route, agentId, r, stage);
  if (isStaged(route.state.resultKind)) throw refuse(400, 'task_invalid', 'Use the current executable stage command, or blocked when work cannot continue. A report cannot bypass Review and Tests.');
  requireReporter(task, agentId);
  await refuseWaiting(ctx.db, task);
  const n: Note = { kind: 'report', actor: { agentId }, text: r.summary, data: { done: r.done }, returned: true };
  const unstuck = stuckGoes(ctx, task);
  if (task.createdByAgentId) {
    const wakes = giver(task, 'blocked', agentId, r.summary);
    const row = await move(ctx, task, { status: 'blocked' }, n, unstuck.also, wakes);
    unstuck.tell();
    return { task: row, wakes };
  }
  return reportToResolver(ctx, agentId, task, r.summary, n);
}

/* The executor cannot go on without its head. */
export async function blocked(ctx: Live, agentId: string, taskId: string, why: string): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  if (task.assigneeAgentId !== agentId) throw notYours(task, 'is not with you');
  if (task.status === 'blocked') throw refuse(409, 'task_invalid', `#${task.number} is blocked already, and whoever gave it out was told. Go on if what you read lets you, else end this turn.`);
  refusePaused(task);
  await refuseWaiting(ctx.db, task);
  const wakes = giver(task, 'blocked', agentId, why);
  const row = await move(ctx, task, { status: 'blocked' }, { kind: 'blocked', actor: { agentId }, text: why, returned: true }, undefined, wakes);
  return { task: row, wakes };
}

/* Open tasks that come after any of the cancelled ones keep waiting, and whoever made each hears so: its agent, or the
   orchestrator for a person's. waiting: those whose maker cancelled, who hears it in the answer instead. */
async function afterCancelled(tx: Tx, actor: Actor, cancelled: Task[]): Promise<{ wakes: Wake[]; waiting: Task[] }> {
  if (!cancelled.length) return { wakes: [], waiting: [] };
  const left = await tx.select().from(tasks).where(comingAfter(cancelled, holdsAny(tasks.after, cancelled.map(t => t.id)))).orderBy(asc(tasks.number));
  const [orchestrator] = left.some(t => !t.createdByAgentId)
    ? await tx.select(idOnly(agents)).from(agents).where(and(eq(agents.companyId, cancelled[0]!.companyId), eq(agents.kind, 'orchestrator'), isNull(agents.removedAt)))
    : [];
  const wakes: Wake[] = [];
  const waiting: Task[] = [];
  for (const t of left) {
    const maker = t.createdByAgentId ?? orchestrator?.id;
    if (!maker) continue;
    if (maker === actor.agentId) waiting.push(t);
    else wakes.push({ agentId: maker, taskId: t.id, why: 'after_cancelled', text: listed(cancelled.filter(c => t.after.includes(c.id))) });
  }
  return { wakes, waiting };
}

/* Cancels every open task under the task, level by level, each saying why in its log; questions waiting on the task and
   on them are withdrawn. The cancelled tasks, in the order they ended. */
async function endUnder(tx: Tx, task: Task, actor: Actor, why: string): Promise<Task[]> {
  const ended: Task[] = [];
  let level = [task.id];
  while (level.length) {
    const was = new Map((await tx.select({ id: tasks.id, status: tasks.status }).from(tasks).where(and(inArray(tasks.parentId, level), notInArray(tasks.status, [...CLOSED]))).for('update')).map(t => [t.id, t.status]));
    const below = await tx
      .update(tasks)
      .set({ status: 'cancelled', closedAt: new Date(), assigneeAgentId: null, externalWait: null, paused: null, updatedAt: new Date(), version: sql`${tasks.version} + 1` })
      .where(and(inArray(tasks.parentId, level), notInArray(tasks.status, [...CLOSED])))
      .returning();
    for (const t of below) {
      const event = await note(tx, t, statusNoted({ kind: 'cancelled', actor, text: why }, was.get(t.id) ?? t.status, t.status));
      await keepWaitsWithMove(tx, t, t, { kind: 'cancelled', actor, eventId: event.id });
      /* Work cancelled with the task above it needs none of the turns kept for it. */
      await dropEarlierWakes(tx, t.id);
    }
    ended.push(...below);
    level = below.map(t => t.id);
  }
  await tx
    .update(requests)
    .set({ status: 'withdrawn', answeredAt: new Date() })
    .where(and(inArray(requests.taskId, [task.id, ...ended.map(t => t.id)]), eq(requests.status, 'open')));
  await cancelRoutes(tx, task.companyId, ended.map(t => t.id));
  return ended;
}

/* What follows a close for the work cancelled under it: each of them shown again, and the trackers of other departments told. */
async function endedUnder(ctx: Live, task: Task, actor: Actor, ended: Task[]): Promise<void> {
  for (const t of ended) published(ctx, t);
  /* The task's own department heard of it with the move; work under it elsewhere is heard of in its own. */
  for (const departmentId of new Set(ended.map(t => t.departmentId).filter(d => d !== task.departmentId))) await nudgeTrackerKeepers(ctx, { companyId: task.companyId, departmentId }, actor.agentId);
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
}

type Closed = Moved & { closed: string[]; waiting: Task[] };

/* Ends the task and every open task under it; questions waiting on them are withdrawn. Whoever gave it out hears why.
   closed names every task that ended, for their turns to stop; waiting the open tasks that came after them, which the
   one who cancelled made. */
export async function cancel(ctx: Live, actor: Actor, taskId: string, why: string): Promise<Closed> {
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  const ended: Task[] = [];
  let waiting: Task[] = [];
  const wakes = giver(task, 'cancelled', actor.agentId, why.trim());
  const row = await move(ctx, task, { status: 'cancelled', closedAt: new Date(), assigneeAgentId: null }, { kind: 'cancelled', actor, text: why }, async (tx, row) => {
    ended.push(...(await endUnder(tx, task, actor, `#${task.number} was cancelled.`)));
    await cancelRoutes(tx, task.companyId, [taskId]);
    const after = await afterCancelled(tx, actor, [row, ...ended]);
    wakes.push(...after.wakes);
    waiting = after.waiting;
  }, wakes);
  await endedUnder(ctx, task, actor, ended);
  return { task: row, wakes, closed: [taskId, ...ended.map(t => t.id)], waiting };
}

/* The orchestrator closes a task in any state it stands in, past its route: done or cancelled, with its reason in the log as
   its own act. Done closes the record and nothing else: the work nobody finished under it is cancelled with it, its result
   is accepted by nobody and joins no turn, so no release or main takes it on this. Questions and waits on it end with it. */
export async function closeTask(ctx: Live, actor: Actor, taskId: string, close: { status: 'done' | 'cancelled'; why: string }): Promise<Closed> {
  const task = await loadTask(ctx.db, taskId);
  const why = close.why.trim();
  const [closer] = actor.agentId ? await ctx.db.select(only(agents, 'kind')).from(agents).where(and(eq(agents.id, actor.agentId), eq(agents.companyId, task.companyId), isNull(agents.removedAt))) : [];
  if (closer?.kind !== 'orchestrator') throw notYours(task, 'is closed past its route only by the orchestrator: close it through its own moves, or cancel it');
  stillOpen(task);
  if (!why) throw refuse(400, 'task_invalid', `Say why #${task.number} closes.`);
  if (close.status === 'cancelled') return cancel(ctx, actor, taskId, why);
  const ended: Task[] = [];
  let waiting: Task[] = [];
  const wakes = giver(task, 'reported', actor.agentId, `The orchestrator closed it: ${why}`);
  const row = await move(ctx, task, { status: 'done', closedAt: new Date(), assigneeAgentId: null, silent: 0 }, { kind: 'done', actor, text: why, data: { byOrchestrator: true }, endsWorkUnder: true }, async (tx, row) => {
    ended.push(...(await endUnder(tx, row, actor, `#${task.number} was closed by the orchestrator.`)));
    await endRoutes(tx, task.companyId, [taskId], 'done');
    const after = await afterCancelled(tx, actor, ended);
    wakes.push(...after.wakes);
    waiting = after.waiting;
  }, wakes);
  await endedUnder(ctx, task, actor, ended);
  return { task: row, wakes, closed: [taskId, ...ended.map(t => t.id)], waiting };
}

export type TaskChange = { echelonStage?: EchelonStage; ownerAgentId?: string; cleanup?: boolean; cleanupForTurn?: boolean; paths?: string[]; title?: string; brief?: string; body?: string; executor?: string; after?: string[]; afterPlans?: AfterPlans; independentPart?: IndependentPartInput; independentNone?: string; workKind?: NonNullable<Task['workKind']>; riskClass?: NonNullable<Task['riskClass']>; small?: boolean };

/* Retrying a task CAS never bypasses its current route or owner checks. */
async function onFresh<T>(ctx: Live, task: Task, fn: (task: Task) => Promise<T>): Promise<T | null> {
  for (let tries = 0; tries < 3; tries++) {
    try { return await fn(task); } catch (error) {
      if (!(error instanceof ApiError) || error.reason !== 'task_changed') throw error;
      task = await loadTask(ctx.db, task.id);
    }
  }
  return null;
}

type Leaver = { id: string; name: string; companyId: string };

function releasedRoute(route: Route, agentId: string, current: boolean): Route['state'] {
  return { ...route.state, ...(current ? { phase: 'waiting', assignment: null } : {}), stages: route.state.stages.map(step => {
    if (step.ownerAgentId !== agentId || ['complete', 'skipped'].includes(step.status)) return step;
    return { ...step, ownerAgentId: null, status: 'pending', reason: 'eligible_owner_required' };
  }) };
}

/* Leaving an assignment never skips the stage or erases an immutable candidate. */
export async function leaveWork(ctx: Ctx, actor: Actor, agent: Leaver): Promise<{ wakes: Wake[]; handed: string[] }> {
  const rows = await ctx.db.select().from(tasks).where(and(eq(tasks.companyId, agent.companyId), notInArray(tasks.status, [...CLOSED]))).orderBy(asc(tasks.id));
  const wakes: Wake[] = [], handed: string[] = [];
  const missing: UnfilledStage[] = [];
  const leaving = await removedEmployee(ctx, agent.companyId, agent.id);
  for (const row of rows) await onFresh(ctx, row, async task => {
    const route = await routeOf(ctx.db, task);
    const current = task.assigneeAgentId === agent.id;
    const future = route.state.stages.some(step => step.status === 'pending' && step.ownerAgentId === agent.id);
    if (!current && !future) return null;
    const replacements = leaving ? await replaceFutureOwners(ctx, task, route, leaving) : { state: route.state, set: {}, missing: [] };
    const state = releasedRoute({ ...route, state: replacements.state }, agent.id, current);
    const due = current ? giver(task, 'switched', agent.id, `${agent.name} is no longer available. Assign the current stage to an eligible employee.`) : [];
    await move(ctx, task, { ...replacements.set, ...(current ? { assigneeAgentId: null, status: 'waiting' as const } : {}) }, { kind: 'updated', actor, text: `${agent.name} left the assignment.`, data: { fields: ['owner'] } }, tx => changeRoute(tx, route, state), due);
    handed.push(task.id); wakes.push(...due); missing.push(...replacements.missing);
    return task;
  });
  if (leaving) await notifyUnfilledStages(ctx, leaving, missing);
  return { wakes, handed };
}

async function waitingRouteChecker(ctx: Live, task: Task, route: Route) {
  if (route.state.phase !== 'waiting' || !route.state.candidateId || !route.state.stage) return null;
  const ability = route.state.abilities[route.state.stage];
  if (!ability) return null;
  return checkerFor(ctx, task, (await currentHanded(ctx.db, task, route)).producedBy, ability, null);
}

export async function resumeWaitingRoutes(ctx: Live, actor: Actor, agent: Leaver, text: string): Promise<{ wakes: Wake[] }> {
  const rows = await ctx.db.select().from(tasks).where(and(eq(tasks.companyId, agent.companyId), eq(tasks.status, 'waiting'), isNull(tasks.assigneeAgentId))).orderBy(asc(tasks.id));
  const wakes: Wake[] = [];
  for (const row of rows) await onFresh(ctx, row, async task => {
    const route = await routeOf(ctx.db, task);
    const owner = await waitingRouteChecker(ctx, task, route);
    if (!owner) return null;
    const state = { ...route.state, phase: 'active' as const, assignment: owner, stages: route.state.stages.map(step => step.stage === route.state.stage ? { ...step, ownerAgentId: owner.agentId, status: 'active' as const, reason: null } : step) };
    /* An owner given a checking stage ran nothing yet: Tests is open work of its owner, the others are reviews. */
    const due: Wake[] = [{ agentId: owner.agentId, taskId: task.id, why: route.state.stage === 'tests' ? 'assigned' : 'review' }];
    await move(ctx, task, { assigneeAgentId: owner.agentId, status: route.state.stage === 'tests' ? 'open' : 'review' }, { kind: 'updated', actor, text, data: { fields: ['owner'] } }, tx => changeRoute(tx, route, state), due);
    wakes.push(...due);
    return task;
  });
  return { wakes };
}

/* The work kind is metadata. Changing it leaves active waits and queued task versions intact. */
async function relabelWorkKind(ctx: Live, agentId: string, task: Task, workKind: NonNullable<Task['workKind']>): Promise<Moved> {
  const row = await ctx.db.transaction(async tx => {
    const [fresh] = await tx.select().from(tasks).where(eq(tasks.id, task.id)).for('update');
    stillOpen(fresh!);
    if (fresh!.workKind === workKind) return fresh!;
    const [changed] = await tx.update(tasks).set({ workKind, updatedAt: new Date() }).where(eq(tasks.id, task.id)).returning();
    await note(tx, changed!, { kind: 'updated', actor: { agentId }, data: { fields: ['workKind'] } });
    return changed!;
  });
  published(ctx, row);
  return { task: row, wakes: [] };
}

/* Head revisions preserve the current stage and its immutable candidate. */
function requireTurnCleanupDecision(change: TaskChange): void {
  if (change.cleanupForTurn && change.cleanup === undefined) throw refuse(400, 'task_invalid', 'A turn Cleanup decision needs an open turn and an explicit option.');
}

/* The turn a head's Cleanup decision for the department holds in: its open turn, until its next release. */
async function cleanupTurn(db: Db, task: Task): Promise<string> {
  const turn = await openTurnOf(db, task.companyId, task.departmentId);
  if (!turn) throw refuse(400, 'task_invalid', 'A turn Cleanup decision needs an open turn and an explicit option.');
  return turn.id;
}

/* tracker: an edit of what the tracker keeps that goes with the change, written in the same move or not at all. */
export async function updateTask(ctx: Ctx, agentId: string, taskId: string, c: TaskChange, tracker?: TaskEdit): Promise<Moved> {
  c = hideCredentialsIn(c);
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  await requireTaskHead(ctx, task, agentId);
  requireTurnCleanupDecision(c);
  const route = await routeOf(ctx.db, task);
  if (!tracker && c.workKind !== undefined && Object.keys(c).every(key => key === 'workKind')) return relabelWorkKind(ctx, agentId, task, c.workKind);
  const revised = await prepareRouteChange(ctx, task, route, agentId, c);
  const set = revised.set;
  copyChangedFields(c, set);
  reopenRewrittenTask(task, revised.state, c, set);
  await changePrerequisites(ctx, task, route, c, set);
  const independentChange = await prepareIndependentChange(ctx, task, c);
  const { declaration } = independentChange;
  await requireChangeUrgency(ctx, agentId, task, set, independentChange.partOwner);
  let independent: Task | null = null;
  let changed: Task[] = [];
  const holder = set.assigneeAgentId ?? task.assigneeAgentId;
  const wakes: Wake[] = [];
  const policy = c.cleanupForTurn ? { turnId: await cleanupTurn(ctx.db, task), departmentId: task.departmentId, enabled: c.cleanup } : undefined;
  let edited: Task | null = null;
  const row = await move(ctx, task, set, { kind: 'updated', actor: { agentId }, data: { fields: Object.keys(c), ...independentData(declaration), ...(policy ? { turnCleanup: policy } : {}) } }, async (tx, row) => {
    if (policy) changed = await applyTurnCleanup(tx, task, policy.turnId, agentId, c.cleanup!, wakes);
    await changeRoute(tx, route, revised.state, revised.paths);
    if (set.after) await rebindAfter(tx, row, await checkAfter(tx, task.companyId, set.after), c.afterPlans, { agentId });
    independent = await insertIndependentChange(tx, row, agentId, independentChange, wakes);
    await wakeUpdatedHolder(tx, task, row, set, holder, wakes, c);
    await endFormerOwnerTurns(tx, task, set);
    if (tracker) edited = await writeEdit(tx, { agentId }, row, tracker);
  }, wakes, tracker ? [task.pipelineId, tracker.pipelineId ?? null] : []);
  if (independent) published(ctx, independent);
  publishRouteChanges(ctx, changed);
  return { task: edited ?? row, wakes };
}

function futureAssignmentOnly(change: TaskChange): boolean {
  return change.echelonStage !== undefined && Object.keys(change).every(key => ['echelonStage', 'ownerAgentId'].includes(key));
}

function copyChangedFields(change: TaskChange, set: Partial<Task>): void {
  for (const key of ['title', 'brief', 'body', 'workKind', 'riskClass', 'small'] as const) if (change[key] !== undefined) Object.assign(set, { [key]: change[key] });
}

function rewrittenText(task: Task, change: TaskChange): boolean {
  return (['title', 'brief', 'body'] as const).some(key => change[key] !== undefined && change[key] !== task[key]);
}

function reopenRewrittenTask(task: Task, state: Route['state'], change: TaskChange, set: Partial<Task>): void {
  if (rewrittenText(task, change) && task.status === 'blocked' && task.assigneeAgentId && state.phase === 'active') {
    Object.assign(set, { status: ['review', 'cleanup', 'security'].includes(state.stage ?? '') ? 'review' : 'open', silent: 0 });
  }
}

async function changePrerequisites(ctx: Ctx, task: Task, route: Route, change: TaskChange, set: Partial<Task>): Promise<void> {
  if (change.after === undefined) return;
  if (isStaged(route.state.resultKind) && !['architecture', 'development'].includes(route.state.stage ?? '')) throw refuse(409, 'task_invalid', 'A checking result cannot acquire unfinished prerequisites.');
  checkAfterPlans(change.after, change.afterPlans);
  await checkAfter(ctx.db, task.companyId, change.after);
  await refuseAbove(ctx.db, task.parentId, change.after);
  await refuseBelow(ctx.db, task, change.after);
  set.after = change.after;
}

function changesIndependence(change: TaskChange): boolean {
  return change.after !== undefined || change.independentPart !== undefined || change.independentNone !== undefined;
}

type IndependentChange = { declaration: IndependentDeclaration | null; createsIndependent: boolean; partOwner: string | null; plan: StageRoute | null };

function independentAddition(declaration: IndependentDeclaration | null, existing: IndependentDeclaration | null): Omit<IndependentChange, 'declaration' | 'plan'> {
  if (declaration?.kind !== 'part' || existing?.kind === 'part') return { createsIndependent: false, partOwner: null };
  return { createsIndependent: true, partOwner: declaration.part.executor };
}

async function prepareIndependentChange(ctx: Ctx, task: Task, change: TaskChange): Promise<IndependentChange> {
  if (!changesIndependence(change)) return { declaration: null, createsIndependent: false, partOwner: null, plan: null };
  const existing = await currentIndependent(ctx.db, task.id);
  const declaration = checkIndependent(change.after ?? task.after, change.independentPart, change.independentNone, existing);
  if (declaration?.kind === 'part') await checkIndependentExecutor(ctx.db, task.departmentId, declaration.part);
  return { declaration, ...independentAddition(declaration, existing), plan: await departmentStages(ctx, task.departmentId, task.pipelineId) };
}

async function requireChangeUrgency(ctx: Ctx, agentId: string, task: Task, set: Partial<Task>, partOwner: string | null): Promise<void> {
  const newOwner = set.assigneeAgentId === task.assigneeAgentId ? null : set.assigneeAgentId;
  await refuseNotUrgent(ctx, { agentId }, task.companyId, task, [newOwner, partOwner].filter((id): id is string => Boolean(id)));
}

async function insertIndependentChange(tx: Tx, row: Task, agentId: string, change: IndependentChange, wakes: Wake[]): Promise<Task | null> {
  if (!change.createsIndependent || change.declaration?.kind !== 'part' || !change.plan) return null;
  const made = await insertIndependent(tx, row, change.declaration.part, { agentId }, change.plan);
  wakes.push(made.wake);
  return made.child;
}

async function wakeUpdatedHolder(tx: Tx, task: Task, row: Task, set: Partial<Task>, holder: string | null, wakes: Wake[], change: TaskChange): Promise<void> {
  if (futureAssignmentOnly(change)) return;
  if (!(await openAfter(tx, row)).length && holder) wakes.push({ agentId: holder, taskId: task.id, why: set.assigneeAgentId ? (row.status === 'review' ? 'review' : 'assigned') : 'updated' });
}

async function endFormerOwnerTurns(tx: Tx, task: Task, set: Partial<Task>): Promise<void> {
  if (set.assigneeAgentId && set.assigneeAgentId !== task.assigneeAgentId) {
    await tx.update(jobs).set({ status: 'failed', error: 'handed_on', finishedAt: new Date() }).where(and(eq(jobs.taskId, task.id), eq(jobs.agentId, task.assigneeAgentId!), eq(jobs.status, 'queued')));
    await letStuckGo(tx, task.id);
  }
}

/* Comments from others end an external wait. A giver's answer also opens a blocked member task for its executor, once in a
   piece of work: held says it stays blocked as its executor blocked it again after a comment opened it. */
export async function comment(ctx: Live, actor: Actor, taskId: string, text: string): Promise<Moved & { held?: true }> {
  text = hideCredentialsIn(text);
  const task = await loadTask(ctx.db, taskId);
  if (!text.trim()) throw refuse(400, 'task_invalid', 'A comment needs text.');
  const words = text.trim();
  if (task.paused) return logComment(ctx, actor, task, words);
  return (await unblockByComment(ctx, actor, task, words)) ?? (await resumeByComment(ctx, actor, task, words)) ?? logComment(ctx, actor, task, words);
}

async function unblockByComment(ctx: Live, actor: Actor, task: Task, text: string): Promise<(Moved & { held?: true }) | null> {
  if (!actor.agentId || task.status !== 'blocked' || !task.executorAgentId || task.assigneeAgentId !== task.executorAgentId || !(await gaveOut(ctx.db, task, actor.agentId))) return null;
  if (await openedByComment(ctx.db, task.id)) return { ...(await logComment(ctx, actor, task, text)), held: true };
  const wakes: Wake[] = [{ agentId: task.executorAgentId, taskId: task.id, why: 'unblocked', text }];
  return { task: await move(ctx, task, { status: 'open', silent: 0 }, { kind: 'comment', actor, text, data: { unblocked: true } }, undefined, wakes), wakes };
}

/* What begins a new piece of work on a task: a move of its work, or its words or owner rewritten. */
const NEW_PIECE: TaskEventKind[] = ['created', 'assigned', 'started', 'submitted', 'verdict', 'report', 'answered'];

/* Whether a comment opened the task again since its last piece of work began: the answer it was blocked for came then. */
async function openedByComment(db: Db, taskId: string): Promise<boolean> {
  const [piece] = await db.select(idOnly(taskEvents)).from(taskEvents).where(and(eq(taskEvents.taskId, taskId), or(
    inArray(taskEvents.kind, NEW_PIECE),
    and(eq(taskEvents.kind, 'updated'), sql`${taskEvents.data}->'fields' ?| array['title', 'brief', 'body', 'owner', 'assigneeAgentId']`),
  ))).orderBy(desc(taskEvents.id)).limit(1);
  const [opened] = await db.select(idOnly(taskEvents)).from(taskEvents).where(and(
    eq(taskEvents.taskId, taskId), eq(taskEvents.kind, 'comment'), sql`${taskEvents.data}->>'unblocked' = 'true'`, gt(taskEvents.id, piece?.id ?? 0),
  )).limit(1);
  return Boolean(opened);
}

async function resumeByComment(ctx: Live, actor: Actor, task: Task, text: string): Promise<Moved | null> {
  if (!task.externalWait || !task.assigneeAgentId || actor.agentId === task.assigneeAgentId || CLOSED.includes(task.status)) return null;
  const wakes = commentWakes(task, actor, text);
  return { task: await move(ctx, task, { externalWait: null, silent: 0 }, { kind: 'comment', actor, text, data: { externalWait: null } }, undefined, wakes), wakes };
}

function commentWakes(task: Task, actor: Actor, text: string): Wake[] {
  if (CLOSED.includes(task.status) || task.paused) return [];
  if (task.status === 'blocked' && !actor.personId) return [];
  const recipients = new Set([task.assigneeAgentId]);
  recipients.delete(actor.agentId ?? null);
  return [...recipients].filter((id): id is string => id !== null).map(agentId => ({ agentId, taskId: task.id, why: 'comment', text }));
}

async function logComment(ctx: Live, actor: Actor, task: Task, text: string): Promise<Moved> {
  const wakes = commentWakes(task, actor, text);
  await ctx.db.transaction(async tx => {
    const event = await note(tx, task, { kind: 'comment', actor, text }, ctx.config);
    recordCause(wakes, { kind: 'comment', actor, text }, event.id, task);
    await keepWakes(tx, task.companyId, wakes);
  });
  published(ctx, task);
  return { task, wakes };
}

/* Whoever gave the task out: the agent that made it, or the orchestrator, who runs every task. */
async function gaveOut(db: Db, task: Task, agentId: string): Promise<boolean> {
  if (task.createdByAgentId === agentId) return true;
  const [agent] = await db.select(only(agents, 'kind')).from(agents).where(eq(agents.id, agentId));
  return agent?.kind === 'orchestrator';
}

/* What an agent asks: words, an approval of an exact commit, or a pick of one of 2 to 4 ways. images: pictures it sent
   with hh-attach, link: where to see the work, topic: what it is about, which says whose decision it is. */
export type Ask = {
  kind: 'question' | 'approval' | 'choice';
  text: string;
  commit?: string;
  /* What an approval a department's policy asks for is about, in place of a commit. */
  approval?: { channel: ApprovalChannel; kind: string; amount: number | null };
  images?: string[];
  options?: RequestOption[];
  link?: string | null;
  topic?: DecisionTopic;
  /* Who answers by when, if someone promised dates. */
  plan?: WaitPlan;
  /* A goal in danger, as someone who may say so said it. */
  goal?: NewGoal;
  /* The server's own: what must be kept in the step that makes the request. No tool passes it. */
  onCreated?: (tx: Tx, request: Request) => Promise<void>;
};

/* An approval of a commit lets it into the release, whatever the agent says it is about. */
const topicOf = (q: Ask): DecisionTopic | null => (q.commit ? 'release' : (q.topic ?? null));

/* An approval says what it approves: an exact commit, or what a department's policy asks it about. */
const namesItsWork = (q: Ask): boolean => q.approval !== undefined || COMMIT.test(q.commit ?? '');

const approvalColumns = (a: Ask['approval']) => ({ approvalChannel: a?.channel ?? null, approvalKind: a?.kind ?? null, approvalAmount: a?.amount ?? null });

/* Only the current task owner asks on it. */
export function mayAsk(task: Task, agentId: string): void {
  requireOwner(task, agentId, 'is not with you');
}

/* The current task owner asks a person and the task waits for the answer. */
export async function ask(ctx: Live, agentId: string, taskId: string, q: Ask): Promise<Moved & { request: Request }> {
  const task = await loadTask(ctx.db, taskId);
  mayAsk(task, agentId);
  refusePaused(task);
  if (!q.text.trim()) throw refuse(400, 'task_invalid', 'Say what you need.');
  if (q.kind === 'approval' && !namesItsWork(q)) throw refuse(400, 'task_invalid', 'An approval names the full 40-character commit.');
  if (q.kind !== 'approval' && q.commit) throw refuse(400, 'task_invalid', 'Only an approval names a commit; ask for an approval instead.');
  const options = q.kind === 'choice' ? (q.options ?? []) : [];
  if (q.kind === 'choice' && (options.length < 2 || options.length > 4)) throw refuse(400, 'task_invalid', 'A choice offers 2 to 4 ways.');
  if (q.kind !== 'choice' && q.options?.length) throw refuse(400, 'task_invalid', 'Ways to pick from make a choice; a choice names no commit.');
  const pictures = [...(q.images ?? []), ...options.flatMap(o => (o.image ? [o.image] : []))];
  await checkPictures(ctx.db, task.companyId, agentId, pictures);
  let request: Request | undefined;
  let wakes: Wake[] = [];
  const row = await move(ctx, task, { status: 'waiting', silent: 0 }, { kind: 'asked', actor: { agentId }, text: q.text.trim(), data: { kind: q.kind, commit: q.commit ?? null } }, async tx => {
    [request] = await tx
      .insert(requests)
      .values({
        companyId: task.companyId,
        taskId,
        agentId,
        kind: q.kind,
        text: q.text.trim(),
        commit: q.commit ?? null,
        options,
        link: q.link ?? null,
        decisionTopic: topicOf(q),
        ...approvalColumns(q.approval),
        ...goalColumns(q.goal),
      })
      .returning();
    const wait = await bindRequest(tx, task, request!, { agentId }, q.plan);
    if (q.goal) await alertGoal(tx, task, request!, wait);
    await q.onCreated?.(tx, request!);
    wakes = await explaining(tx, task, agentId, request!.id);
    await keepWakes(tx, task.companyId, wakes);
    if (!pictures.length) return;
    const shown = await tx
      .update(attachments)
      .set({ requestId: request!.id })
      .where(and(inArray(attachments.id, pictures), eq(attachments.agentId, agentId), isNull(attachments.requestId), isNull(attachments.operatorCaseId)))
      .returning({ id: attachments.id });
    if (shown.length !== pictures.length) throw refuse(409, 'task_changed', 'A picture was shown meanwhile. Send it again with hh-attach.');
  });
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  return { task: row, request: request!, wakes };
}

/* What an employee asks people reaches the orchestrator first, to put into plain words for them; not what it asks itself. */
async function explaining(db: Db | Tx, task: Task, agentId: string, requestId: string): Promise<Wake[]> {
  const [orchestrator] = await db
    .select(idOnly(agents))
    .from(agents)
    .where(and(eq(agents.companyId, task.companyId), eq(agents.kind, 'orchestrator'), isNull(agents.removedAt)));
  return orchestrator && orchestrator.id !== agentId ? [{ agentId: orchestrator.id, taskId: task.id, why: 'explain', text: requestId }] : [];
}

/* The agent holding the task ended a turn without moving it: a reminder, and from SILENT_TURNS its head is asked. */
export async function silentTurn(ctx: Live, agentId: string, task: Task): Promise<Moved> {
  if (task.externalWait || task.paused) return { task, wakes: [] };
  return remindOnSilence(ctx, agentId, task);
}

async function remindOnSilence(ctx: Live, agentId: string, task: Task): Promise<Moved> {
  const silent = task.silent + 1;
  if (silent < SILENT_TURNS) {
    const wakes: Wake[] = [{ agentId, taskId: task.id, why: 'reminder' }];
    const row = await move(ctx, task, { silent }, { kind: 'reminded', actor: { agentId }, data: { silent } }, undefined, wakes);
    return { task: row, wakes };
  }
  return askAboutStill(ctx, agentId, task, silent, `Ended ${silent} turns in a row on #${task.number} without moving it. Tell it how to go on, or cancel the task.`);
}

/* Hornhoof gives member work its executor has not handed in to another executor, as when the executor's plan is at its
   limit: one note in the task says why, and the turns that waited for the one who did it are over. */
export async function handOver(ctx: Live, task: Task, to: string, text: string): Promise<Moved> {
  const route = await routeOf(ctx.db, task);
  requireUnsubmittedWork(task, route);
  const owner = await workingAgent(ctx.db, task.companyId, to);
  if (owner.departmentId !== task.departmentId || (owner.productId && owner.productId !== task.productId)) throw refuse(403, 'task_not_yours', 'The replacement is outside the task scope.');
  const state = { ...route.state, assignment: null, stages: route.state.stages.map(step => step.stage === route.state.stage ? { ...step, ownerAgentId: to } : step) };
  const from = task.executorAgentId!;
  const wakes: Wake[] = [{ agentId: to, taskId: task.id, why: 'assigned' }];
  const row = await move(
    ctx,
    task,
    { executorAgentId: to, assigneeAgentId: to, status: 'open', silent: 0 },
    { kind: 'assigned', actor: { agentId: from }, text, data: { assignee: to }, automatic: 'limit' },
    async tx => {
      await changeRoute(tx, route, state);
      await tx.update(jobs).set({ status: 'failed', error: 'handed_on', finishedAt: new Date() }).where(and(eq(jobs.agentId, from), eq(jobs.taskId, task.id), eq(jobs.status, 'queued')));
    },
    wakes,
  );
  return { task: row, wakes };
}

function requireUnsubmittedWork(task: Task, route: Route): void {
  if (!isStaged(route.state.resultKind) || route.state.candidateId || !['architecture', 'development'].includes(route.state.stage ?? '') || task.assigneeAgentId !== task.executorAgentId) throw refuse(409, 'task_invalid', 'Only unsubmitted work can change executor automatically.');
}

/* Repeated startup failures stop task turns and notify the giver, or ask a person when there is no other giver. */
export async function brokeDown(ctx: Live, agentId: string, task: Task, text: string): Promise<Moved> {
  if (task.createdByAgentId && task.createdByAgentId !== agentId) {
    const wakes = giver(task, 'blocked', agentId, text);
    return { task: await move(ctx, task, { status: 'blocked', silent: 0 }, { kind: 'blocked', actor: { agentId }, text, automatic: 'failure' }, undefined, wakes), wakes };
  }
  return askAboutStill(ctx, agentId, task, task.silent, text);
}

/* Hornhoof stops waking the agent on the task and asks its head, or the orchestrator about a head. */
async function askAboutStill(ctx: Live, agentId: string, task: Task, silent: number, text: string): Promise<Moved> {
  const [asker] = await ctx.db.select().from(agents).where(eq(agents.id, agentId));
  const recipient = asker ? await stuckRecipient(ctx.db, asker, task) : null;
  let wakes: Wake[] = [];
  const row = await move(ctx, task, { silent, status: 'waiting' }, { kind: 'stuck', actor: { agentId }, text }, async tx => {
    const [note] = await tx.insert(requests).values({
      companyId: task.companyId,
      taskId: task.id,
      agentId,
      kind: 'stuck',
      text,
      decisionTopic: 'task',
      audience: 'internal',
      triageAgentId: recipient?.id ?? null,
      sourceKey: `stuck:${task.id}:${task.version}`,
    }).returning();
    wakes = recipient ? [{ agentId: recipient.id, taskId: task.id, why: 'explain', text: note!.id }] : [];
    await keepWakes(tx, task.companyId, wakes);
  });
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  return { task: row, wakes };
}

/* Events that do not move a task: what an agent says in it and Hornhoof's own notes about its turns. */
/* status: work started, which the turn did, not the task. edited: what the tracker keeps of it, which gives no work. */
export const NOT_A_MOVE = ['comment', 'reminded', 'continued', 'stuck', 'interrupted', 'wake_skipped', 'wake_obsolete', 'wait_due', 'wait_card', 'away', 'status', 'edited'] as const;

/* Comments and notes about a turn ending do not begin a new piece of work. */
export async function lastMove(db: Db | Tx, taskId: string) {
  const [last] = await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, taskId), notInArray(taskEvents.kind, [...NOT_A_MOVE]))).orderBy(desc(taskEvents.createdAt), desc(taskEvents.id)).limit(1);
  return last;
}

/* How many turns the agent went on through on the task since it last moved, as the stuck counter counts them: a turn that
   waited in line until its node came back is not one. */
async function turnsGoneOn(db: Db, agentId: string, task: Task): Promise<number> {
  const last = await lastMove(db, task.id);
  const [before] = await db
    .select(countOnly())
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.agentId, agentId), eq(taskEvents.kind, 'continued'), sql`${taskEvents.data}->>'afterReturn' is distinct from 'true'`, last ? gt(taskEvents.createdAt, last.createdAt) : undefined));
  return Number(before?.n ?? 0);
}

async function goOn(ctx: Live, agentId: string, task: Task, set: Partial<Task>, data: Record<string, unknown>): Promise<Moved> {
  const wakes: Wake[] = [{ agentId, taskId: task.id, why: 'go_on' }];
  const row = await move(ctx, task, set, { kind: 'continued', actor: { agentId }, data }, undefined, wakes);
  return { task: row, wakes };
}

/* The agent holding the task worked through a turn without handing anything in, but said in the task how far it got or
   worked until its time ran out: it goes on in another turn, from GOING_ON_TURNS such turns in a row its head is asked. */
export async function wentOn(ctx: Live, agentId: string, task: Task): Promise<Moved> {
  const turns = (await turnsGoneOn(ctx.db, agentId, task)) + 1;
  if (turns >= GOING_ON_TURNS) return askAboutStill(ctx, agentId, task, 0, `Went on for ${turns} turns in a row on #${task.number} without handing anything in. Tell it how to go on, or cancel the task.`);
  return goOn(ctx, agentId, task, { silent: 0 }, { turns });
}

/* Whether a turn of the agent on the task already went uncounted since the task last moved, because it waited in line until
   its node came back. Only one does: a node that goes away around every turn must not keep an agent from looking stuck. */
export async function uncountedSinceMove(db: Db, agentId: string, task: Task): Promise<boolean> {
  const last = await lastMove(db, task.id);
  const [one] = await db
    .select(idOnly(taskEvents))
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.agentId, agentId), eq(taskEvents.kind, 'continued'), sql`${taskEvents.data}->>'afterReturn' = 'true'`, last ? gt(taskEvents.createdAt, last.createdAt) : undefined))
    .limit(1);
  return one !== undefined;
}

/* A turn that waited in line until the agent's node came back worked and goes on too, but a machine coming back says nothing
   of the agent standing still: it counts for neither stuck counter. */
export async function wentOnAfterReturn(ctx: Live, agentId: string, task: Task): Promise<Moved> {
  return goOn(ctx, agentId, task, {}, { turns: await turnsGoneOn(ctx.db, agentId, task), afterReturn: true });
}

/* pick: the way a person took, from 0, in a choice. */
export type Answer = { answer?: string; approve?: boolean; retry?: boolean; pick?: number };

const sentByAgent = (picture: { companyId: string; agentId: string | null; personId: string | null }, companyId: string, agentId: string): boolean =>
  picture.companyId === companyId && picture.agentId === agentId && !picture.personId;

/* Pictures are the agent's own, from hh-attach, each shown once. A file put on a task is no picture, whatever it holds, and
   one a person sent the agent stays in that conversation. */
async function checkPictures(db: Db, companyId: string, agentId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  if (new Set(ids).size !== ids.length) throw refuse(400, 'task_invalid', 'A picture is listed twice.');
  const rows = await db
    .select({ id: attachments.id, companyId: attachments.companyId, agentId: attachments.agentId, personId: attachments.personId, requestId: attachments.requestId, taskId: attachments.taskId, name: attachments.name })
    .from(attachments)
    .where(and(inArray(attachments.id, ids), isNull(attachments.operatorCaseId)));
  for (const id of ids) {
    const problem = notAPicture(id, rows.find(r => r.id === id), companyId, agentId);
    if (problem) throw refuse(400, 'task_invalid', problem);
  }
}

type PictureRow = { companyId: string; agentId: string | null; personId: string | null; requestId: string | null; taskId: string | null; name: string | null };

/* Why an attachment is no picture this agent may show in a request, or null when it is one. */
function notAPicture(id: string, found: PictureRow | undefined, companyId: string, agentId: string): string | null {
  if (!found || !sentByAgent(found, companyId, agentId)) return `${id} is not a picture you sent. Send it with hh-attach and use the id it prints.`;
  if (found.taskId) return `${id} is a file on a task, not a picture. Send the picture with hh-attach FILE, without --task.`;
  if (found.name !== null) return `${id} is a chat file, not a picture. Send the picture with hh-attach FILE, without --chat.`;
  if (found.requestId) return `${id} is shown in another request already. Send it again with hh-attach.`;
  return null;
}

/* What a request is, for whom may take it. */
export const requestSubject = (r: Pick<Request, 'kind' | 'decisionTopic'>, t: Pick<Task, 'departmentId' | 'productId'>): DecisionSubject => ({
  source: 'request',
  kind: r.kind,
  topic: r.decisionTopic,
  spot: taskSpot(t),
});

/* Who answers, as the request is kept: a person with the right to take it, or the orchestrator for one, in a turn that
   still answers that person. */
async function mayAnswer(tx: Tx, actor: Actor, found: Request, task: Task, on?: Delegation): Promise<string> {
  if (on) await checkDelegation(tx, on);
  const personId = on?.personId ?? actor.personId;
  if (!personId) throw contextMissing();
  await requireDecider(tx, found.companyId, personId, requestSubject(found, task));
  return personId;
}

/* What the request and its log keep of the orchestrator's answer for a person: which turn, on whose words. */
function auditOf(on: Delegation | undefined) {
  if (!on) return { audit: {}, forWhom: {} };
  return {
    audit: { answeredByAgentId: on.agentId, answerJobId: on.jobId, answerSourceSeq: on.sourceSeq },
    forWhom: { onBehalfOfPersonId: on.personId, jobId: on.jobId, sourceSeq: on.sourceSeq },
  };
}

/* The answers someone else took first, or a right that went meanwhile: the words still reach the agent. */
const PASSED_OVER = new Set<ErrorReason | undefined>(['request_closed', 'decision_not_allowed']);

/* The person whose answer it is, also when the orchestrator passed it on. */
const answerer = (personId: string | null, actor: Actor): Actor => (personId ? { personId } : actor);

/* What an approval let through or stopped: its commit, or the channel and kind a department's policy asked it for. */
const approvedWhat = (r: Pick<Request, 'commit' | 'approvalChannel' | 'approvalKind'>) => r.commit ?? `${r.approvalChannel}, ${r.approvalKind}`;
const approveOrDecline = (r: Pick<Request, 'commit'>) => (r.commit ? 'Approve or decline this commit.' : 'Approve or decline this.');
/* What the note on an answer says it let through: only an approval has one. */
const answeredWork = (r: Pick<Request, 'kind' | 'commit' | 'approvalChannel' | 'approvalKind'>) => (r.kind === 'approval' ? approvedWhat(r) : r.commit);
/* The test run that proves an approved commit, as the release rests on that commit. */
const proofWords = async (db: Db, task: Task, found: Request, a: Answer) => (a.approve && found.commit ? ` ${proofLine(await commitProof(db, task, found.commit))}` : '');

/* An answer in words, for the one who asked and the log. */
async function answerWords(db: Db, task: Task, found: Request, a: Answer, text: string, option: RequestOption | undefined): Promise<string> {
  const more = text ? ` ${text}` : '';
  if (found.kind === 'approval') return `${a.approve ? 'Approved' : 'Declined'} ${approvedWhat(found)}.${await proofWords(db, task, found, a)}${more}`;
  return option ? `Picked ${a.pick! + 1}: ${option.label}.${more}` : text || 'Try again.';
}

/* Words are a neutral answer; an explicit pick must still name a valid option. */
function checkChoiceAnswer(found: Pick<Request, 'options'>, a: Answer, text: string, option: RequestOption | undefined): void {
  if (a.approve !== undefined) throw refuse(400, 'task_invalid', 'Only a commit is approved; answer in words.');
  if (a.pick !== undefined && !option) throw refuse(400, 'task_invalid', `Pick one of the ${found.options.length} ways.`);
  if (!option && !text) throw refuse(400, 'task_invalid', 'Write an answer.');
}

/* The status of a code task at each checking stage of its route: Tests is open work of its owner, the others are reviews. */
const STATUS_AT_STAGE: Partial<Record<string, Task['status']>> = { tests: 'open', review: 'review', security: 'review', cleanup: 'review' };

/* What a task that waited on a person goes back to once nothing more is asked of anyone: the status of the stage its route is
   at. One whose route waits for an owner stays waiting, where the next eligible owner is looked for. Null leaves it as it is. */
async function statusAfterWait(tx: Tx, task: Task, was: Task['status'] | undefined): Promise<Task['status'] | null> {
  if (was !== 'waiting') return null;
  const [left] = await tx.select(countOnly()).from(requests).where(and(eq(requests.taskId, task.id), eq(requests.status, 'open')));
  if (Number(left!.n)) return null;
  const route = await routeOf(tx, task);
  if (!isStaged(route.state.resultKind)) return 'working';
  if (route.state.phase === 'waiting') return null;
  return STATUS_AT_STAGE[route.state.stage ?? 'development'] ?? 'working';
}

/* A person answers: the request closes, the task goes on where it stood, and the agent that asked wakes with the answer.
   on: the orchestrator answers for the person its turn answers, under that agent's input lock. */
/* How an answer came: inline in words the window already delivered, from the person's assistant, or from the orchestrator
   of its own as the owner's, each recorded with it. */
type AnswerWay = { inlineText?: true; assistant?: string; orchestrator?: string };

export async function answer(ctx: Live, actor: Actor, requestId: string, a: Answer, on?: Delegation, { inlineText, assistant, orchestrator }: AnswerWay = {}): Promise<{ request: Request; task: Task; wakes: Wake[] }> {
  const [found] = await ctx.db.select().from(requests).where(eq(requests.id, requestId));
  if (!found) throw refuse(404, 'request_unknown', 'There is no such request.');
  if (found.status !== 'open') throw refuse(409, 'request_closed', 'This request is answered already.');
  const text = a.answer?.trim() ?? '';
  let status: Request['status'];
  const option = found.kind === 'choice' && a.pick !== undefined ? found.options[a.pick] : undefined;
  if (found.kind !== 'choice' && a.pick !== undefined) throw refuse(400, 'task_invalid', 'Only a choice is answered with a pick.');
  if (found.kind === 'approval') {
    if (a.approve === undefined) throw refuse(400, 'task_invalid', approveOrDecline(found));
    status = a.approve ? 'approved' : 'declined';
  } else if (found.kind === 'choice') {
    checkChoiceAnswer(found, a, text, option);
    status = 'answered';
  } else {
    if (a.approve !== undefined) throw refuse(400, 'task_invalid', 'Only a commit is approved; answer in words.');
    if (!text && !(found.kind === 'stuck' && a.retry)) throw refuse(400, 'task_invalid', 'Write an answer.');
    status = 'answered';
  }
  const task = await loadTask(ctx.db, found.taskId);
  const said = await answerWords(ctx.db, task, found, a, text, option);
  let wakes: Wake[] = [];
  const row = await ctx.db.transaction(async tx => {
    /* The task first and then its request, in the order a cancel takes them, so the two never wait on each other. As the task
       is now, not as it was read before: one closed meanwhile stays closed. */
    const [current] = await tx.select(only(tasks, 'status')).from(tasks).where(eq(tasks.id, task.id)).for('update');
    const answeredBy = await mayAnswer(tx, actor, found, task, on);
    const { audit, forWhom } = auditOf(on);
    const [request] = await tx
      .update(requests)
      .set({ status, answer: text || null, picked: option ? a.pick! : null, answeredBy, ...audit, ...(orchestrator ? { answeredByAgentId: orchestrator } : {}), answeredByAssistantId: assistant ?? null, answeredAt: new Date() })
      .where(and(eq(requests.id, requestId), eq(requests.status, 'open')))
      .returning();
    if (!request) throw refuse(409, 'request_closed', 'This request is answered already.');
    await endRequest(tx, request, status, answerer(answeredBy, actor));
    await tx.update(tasks).set({ externalWait: null, silent: 0, version: sql`${tasks.version} + 1`, updatedAt: new Date() })
      .where(and(eq(tasks.id, task.id), isNotNull(tasks.externalWait)));
    const back = await statusAfterWait(tx, task, current?.status);
    const answered: Note = { kind: 'answered', actor, text: said, data: { requestId, kind: found.kind, status, ...forWhom, ...(assistant ? { assistantId: assistant } : {}), ...(orchestrator ? { byOrchestrator: true } : {}) }, inlineText };
    const event = await note(tx, task, back ? statusNoted(answered, 'waiting', back) : answered, ctx.config);
    if (back) {
      await tx
        .update(tasks)
        .set({ status: back, silent: 0, version: sql`${tasks.version} + 1`, updatedAt: new Date() })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, 'waiting')));
    }
    const [after] = await tx.select().from(tasks).where(eq(tasks.id, task.id));
    /* A task that stood still goes on with whoever holds it now. */
    const goesOn = after!.assigneeAgentId;
    wakes = CLOSED.includes(after!.status) || !goesOn ? [] : [{ agentId: goesOn, taskId: task.id, why: 'answered', text: said }];
    recordCause(wakes, { kind: 'answered', actor: answerer(answeredBy, actor), text: said, data: { status, commit: answeredWork(found) } }, event.id, task);
    await keepWakes(tx, task.companyId, wakes);
    return request;
  });
  const now = await loadTask(ctx.db, task.id);
  published(ctx, now);
  if (now.status !== task.status) await nudgeTrackerKeepers(ctx, now, actor.agentId);
  await handOff(ctx, actor, now);
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  return { request: row, task: now, wakes };
}

/* Whether a person's words take this open request: they reach its task and may take its decision. */
function takes(person: Parameters<typeof canDecide>[1], access: Access, r: Parameters<typeof requestSubject>[0] & Parameters<typeof requestSubject>[1] & { companyId: string }): boolean {
  return canReach(access, taskSpot(r)) && canDecide(requestSubject(r, r), person, access, r.companyId);
}

/* A person spoke to the agent directly, in its window or its terminal: what they said answers the questions it asked people
   and tells it how to go on where it was stuck, on the tasks that person reaches. A commit to approve and a choice wait for
   their own answer. The task's own turn still follows, which watches that the task moves. */
export async function answerDirectly(ctx: Live, personId: string, agentId: string, text: string, { assistant }: { assistant?: string } = {}): Promise<Wake[]> {
  const said = text.trim();
  if (!said) return [];
  const [person] = await ctx.db
    .select({ id: people.id, companyId: people.companyId, status: people.status, scopeKind: people.scopeKind, isOwner: people.isOwner, isCeoDelegate: people.isCeoDelegate })
    .from(people)
    .where(eq(people.id, personId));
  if (!person) return [];
  const access = await accessOf(ctx.db, person);
  const open = await ctx.db
    .select({ id: requests.id, companyId: requests.companyId, kind: requests.kind, decisionTopic: requests.decisionTopic, departmentId: tasks.departmentId, productId: tasks.productId })
    .from(requests)
    .innerJoin(tasks, eq(tasks.id, requests.taskId))
    .where(and(eq(requests.agentId, agentId), eq(requests.status, 'open'), inArray(requests.kind, ['question', 'stuck']), or(ne(requests.kind, 'stuck'), eq(requests.audience, 'human'))))
    .orderBy(asc(requests.createdAt));
  const wakes: Wake[] = [];
  for (const r of open) {
    /* Only what this person may take: the words still reach the agent, and someone else's question stays open. */
    if (!takes(person, access, r)) continue;
    try {
      /* The window already delivered these words; its complete mirror must not introduce a later file-quota failure. */
      wakes.push(...(await answer(ctx, { personId }, r.id, { answer: said }, undefined, { inlineText: true, assistant })).wakes);
    } catch (err) {
      /* Someone answered it in the task meanwhile, or the person's right went meanwhile. */
      if (!(err instanceof ApiError && PASSED_OVER.has(err.reason))) throw err;
    }
  }
  return wakes;
}

/* A turn on a task went out: an open task is being worked on now. */
export async function startWork(ctx: Live, jobId: string): Promise<void> {
  const [job] = await ctx.db.select({ taskId: jobs.taskId, agentId: jobs.agentId }).from(jobs).where(eq(jobs.id, jobId));
  if (!job?.taskId || !job.agentId) return;
  /* One that still waits for what it comes after is not at work, whatever turn went out on it. */
  const [task] = await ctx.db.select(only(tasks, 'after')).from(tasks).where(eq(tasks.id, job.taskId));
  if (!task || (await openAfter(ctx.db, task)).length) return;
  const row = await ctx.db.transaction(async tx => {
    const [started] = await tx
      .update(tasks)
      .set({ status: 'working', version: sql`${tasks.version} + 1`, updatedAt: new Date() })
      .where(and(eq(tasks.id, job.taskId!), eq(tasks.status, 'open'), eq(tasks.assigneeAgentId, job.agentId!)))
      .returning();
    if (started) await note(tx, started, { kind: 'status', actor: { agentId: job.agentId! }, data: { fromStatus: 'open', toStatus: 'working' } });
    return started;
  });
  if (!row) return;
  published(ctx, row);
  await nudgeTrackerKeepers(ctx, row, job.agentId);
}
