import { expireWait, markRecord } from './wait-expiry.js';
import { randomUUID } from 'node:crypto';
import { WaitOnInput, WaitPlan, type WaitOwnerBinding } from '@hornhoof/protocol/waits';
import { z } from 'zod';
import { and, desc, eq, gt, gte, inArray, isNotNull, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, agents, jobs, pendingWakes, tasks, testRuns, type ExternalWait } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { loadTask, refuse, type Moved, type Task, type Tx } from './state.js';
import { move } from './transitions.js';
import { note } from './events.js';
import { refusePaused } from './pause.js';
import { agentState } from '../conversation/state.js';
import { enqueueTurn, insertOrDeliverTurn, pump, reconnecting } from '../conversation/queue.js';
import { type TurnMessage } from '../conversation/turn-types.js';
import { conversationOf } from '../conversation/placement.js';
import { onAgent } from '../conversation/line.js';
import { withInputLock } from '../conversation/decision-context.js';
import { messageNotDelivered, NOT_DELIVERED, refusedMessage, taskNamed, undeliveredLine } from '../conversation/undelivered.js';
import { dropMail, inboxChanged } from '../conversation/inbox.js';
import { recordRequestedNotice, requestedWaitNotice } from './wait-notices.js';
import { tryWaitHealth } from './wait-monitor.js';
import { bindSource } from './wait-producers.js';
import { endSourceWait, supersedeWaitFor, waitForSourceKey } from './wait-state.js';
import { checkedWaitTarget } from './wait-target.js';
import { taskByRef } from './lookup.js';
import type { Actor } from './state.js';
import { routeOf, routeSnapshot } from './route-records.js';
import { onTask, taskWakeOf, waitingTaskTurn } from './wake-state.js';
const EXTERNAL_WAIT_MS = 2 * 3_600_000;
export const TaskReference = z.union([z.number().int().positive(), z.string().max(40)]).describe('The task number, like 12 or "#12", or its id.');
export const MESSAGE_TASK_HINT = ' With task, the message concerns that task and ends its external wait. Without task, it leaves waits unchanged.';
export const WaitInput = z.object({
  reason: z.string().trim().min(1).max(600).regex(/^[^\r\n\u2028\u2029]+$/).describe('One line naming what you need from the employee or external event.'),
  until: z.iso.datetime({ offset: true }).describe('An ISO date and time in the future, at most two hours from now.'),
  on: WaitOnInput.optional().describe('Who you wait for: an employee, or time, the CEO, a machine or another external event. Omitted means an external event.'),
  run: z.number().int().positive().optional().describe('The number of a run of yours on this task, when that run is what you wait for: its end ends this wait, and no other run does.'),
  plan: WaitPlan.optional().describe('Who answers by when, if someone promised dates: the owner\'s, the head\'s and the decision\'s, where they come from and the head\'s final review. Omit it when no one has; the deadline above is no promise.'),
});

/* Who the wait is on, when it names someone. */
const withOn = <T>(on: T | null | undefined) => (on ? { on } : {});

type WaitAsked = z.infer<typeof WaitInput>;

function waitOf(input: WaitAsked, now: Date): ExternalWait {
  const parsed = WaitInput.safeParse(input);
  if (!parsed.success) throw refuse(400, 'task_invalid', 'Name the external event in one line and give its deadline as an ISO date and time.');
  const until = new Date(parsed.data.until);
  const delay = until.getTime() - now.getTime();
  if (delay <= 0 || delay > EXTERNAL_WAIT_MS) throw refuse(400, 'task_invalid', 'The wait must end in the future, at most two hours from now.');
  return { reason: parsed.data.reason, since: now.toISOString(), until: until.toISOString(), operation: randomUUID(), ...withOn(parsed.data.on) };
}

/* The one run this wait is for: of the one who waits, on this task, still going. A result already on its way cannot be waited for. */
async function namedRun(ctx: Ctx, task: Task, agentId: string, number: number): Promise<string> {
  const [run] = await ctx.db.select(idOnly(testRuns)).from(testRuns).where(and(
    eq(testRuns.companyId, task.companyId), eq(testRuns.number, number), eq(testRuns.taskId, task.id), eq(testRuns.agentId, agentId), eq(testRuns.status, 'running'),
  ));
  if (!run) throw refuse(409, 'task_invalid', `You have no run ${number} going on #${task.number}. If it ended, read its result instead of waiting for it.`);
  return run.id;
}

/* The record of who answers for the wait, written with it: the employee it names, else the one who waits. Its dates are its own
   promise or the department's, and a wrong or missing plan is refused with the wait. */
async function keepWaitRecord(tx: Tx, task: Task, wait: ExternalWait, plan: WaitAsked['plan'], agentId: string): Promise<void> {
  const sourceKey = waitForSourceKey(wait.operation!);
  const actor = { agentId };
  await supersedeWaitFor(tx, { taskId: task.id, by: sourceKey, actor });
  const ownerBinding: WaitOwnerBinding = { agentId: wait.on?.kind === 'employee' ? wait.on.employee : agentId };
  await bindSource(tx, task, { kind: 'external', sourceKey, owner: ownerBinding, plan, sourceState: { stage: 'waiting', ...(wait.run ? { run: wait.run } : {}) }, actor });
}

/* A holder can end its turn while an external system works; the task keeps its workflow status. heard: the last of the
   holder's events when its call to wait came, so that words which come into its turn while the call waits its line are known. */
export async function waitFor(ctx: Ctx, agentId: string, taskId: string, input: WaitAsked, now?: Date, heard?: number): Promise<Moved> {
  const at = now ?? new Date();
  const called = heard ?? (await lastEventOf(ctx, agentId));
  const moved = await onAgent(ctx, agentId, () => placeWait(ctx, agentId, taskId, input, at, called));
  await tryWaitHealth(ctx, at);
  return moved;
}

/* The last of the agent's events, which a call to wait counts words on its task from. */
export async function lastEventOf(ctx: Ctx, agentId: string): Promise<number> {
  const [last] = await ctx.db.select(only(agentEvents, 'seq')).from(agentEvents).where(eq(agentEvents.agentId, agentId)).orderBy(desc(agentEvents.seq)).limit(1);
  return last?.seq ?? 0;
}

/* Words on the task that came after the call to wait: into the running turn, they cannot have been read before it. */
async function newMessage(ctx: Ctx, agentId: string, taskId: string, heard: number): Promise<boolean> {
  const [message] = await ctx.db.select(only(agentEvents, 'seq')).from(agentEvents).where(and(
    eq(agentEvents.agentId, agentId), gt(agentEvents.seq, heard), eq(agentEvents.kind, 'message'), sql`${agentEvents.data}->'task'->>'id' = ${taskId}`,
  )).limit(1);
  return Boolean(message);
}

/* Whether words on the task wait for its holder, the end of a run among them: in a turn, or still in the outbox. */
async function unreadMessage(ctx: Ctx, agentId: string, taskId: string): Promise<boolean> {
  const [message] = await ctx.db.select(idOnly(jobs)).from(jobs).innerJoin(agentEvents, eq(agentEvents.jobId, jobs.id)).where(and(
    eq(jobs.agentId, agentId), eq(jobs.taskId, taskId), eq(jobs.status, 'queued'), eq(agentEvents.kind, 'message'),
    sql`${agentEvents.data}->'taskWake'->>'why' in ('message', 'comment', 'unblocked', 'tests', 'work')`,
  )).limit(1);
  const [comment] = await ctx.db.select(idOnly(pendingWakes)).from(pendingWakes).where(and(
    eq(pendingWakes.agentId, agentId), eq(pendingWakes.taskId, taskId), inArray(pendingWakes.why, ['comment', 'unblocked', 'tests', 'work']),
  )).limit(1);
  return Boolean(message || comment);
}

/* The notice the wait asks for, kept in the same write as the wait. */
const keepNotice = (notice: Awaited<ReturnType<typeof requestedWaitNotice>>) => async (tx: Parameters<typeof recordRequestedNotice>[0]) => {
  if (notice) await recordRequestedNotice(tx, notice);
};

async function placeWait(ctx: Ctx, agentId: string, taskId: string, input: WaitAsked, now: Date, heard: number): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  requireHolder(task, agentId);
  await waitingTaskTurn(ctx.db, agentId, taskId);
  if (await unreadMessage(ctx, agentId, taskId)) throw refuse(409, 'task_invalid', `A message on #${task.number} waits for you. End this turn and read it before waiting.`);
  if (await newMessage(ctx, agentId, taskId, heard)) throw refuse(409, 'task_invalid', `A message on #${task.number} came while you asked to wait. Read it, and wait again if you still need to.`);
  const wait = waitOf(input, now);
  const run = input.run ? { run: await namedRun(ctx, task, agentId, input.run) } : {};
  const externalWait = { ...wait, ...run, ...withOn(await checkedWaitTarget(ctx, task.companyId, agentId, wait.on)) };
  const notice = await requestedWaitNotice(ctx, { ...task, externalWait }, agentId);
  const row = await move(ctx, task, { externalWait, silent: 0 }, { kind: 'updated', actor: { agentId }, text: `Waiting for "${externalWait.reason}" until ${externalWait.until}.`, data: { externalWait } }, async tx => {
    await keepNotice(notice)(tx);
    await keepWaitRecord(tx, task, externalWait, input.plan, agentId);
  });
  return { task: row, wakes: [] };
}

/* A scheduled observation of active work uses the existing durable check timer. */
export async function trackWork(ctx: Ctx, agentId: string, taskId: string, reason: string, nextCheck: string, employee?: string): Promise<Moved> {
  const moved = await onAgent(ctx, agentId, async () => {
    const task = await loadTask(ctx.db, taskId);
    requireHolder(task, agentId);
    if (task.status === 'blocked' || task.status === 'waiting') throw refuse(409, 'task_invalid', 'Resolve the blocker or human question before recording work in progress.');
    const now = ctx.clock();
    const until = new Date(nextCheck);
    if (until.getTime() <= now) throw refuse(400, 'task_invalid', 'Set the next check in the future.');
    const on = await checkedWaitTarget(ctx, task.companyId, agentId, employee ? { kind: 'employee', employee } : undefined);
    const externalWait: ExternalWait = { reason, since: new Date(now).toISOString(), until: until.toISOString(), work: true, ...withOn(on) };
    const notice = await requestedWaitNotice(ctx, { ...task, externalWait }, agentId);
    const actor = { agentId };
    const row = await move(ctx, task, { status: task.status === 'open' ? 'working' : task.status, externalWait, silent: 0 }, {
      kind: 'updated', actor, text: `Work in progress: ${reason}. Next check at ${externalWait.until}.`, data: { externalWait },
    }, async tx => {
      await keepNotice(notice)(tx);
      if (task.externalWait?.operation) await endSourceWait(tx, { taskId, kind: 'external', sourceKey: waitForSourceKey(task.externalWait.operation), sourceRevision: 0, outcome: 'superseded', proofRef: 'track_work', actor });
    });
    return { task: row, wakes: [] };
  });
  if (employee) await tryWaitHealth(ctx, new Date(ctx.clock()));
  return moved;
}

/* The holder clears its check or older wait and goes on in its current turn. */
export function endOwnWait(ctx: Ctx, agentId: string, taskId: string): Promise<{ task: Task; reason: string; work: boolean }> {
  return onAgent(ctx, agentId, async () => {
    const task = await loadTask(ctx.db, taskId);
    requireHolder(task, agentId);
    const wait = task.externalWait;
    if (!wait) throw refuse(409, 'task_invalid', `#${task.number} has no progress check or external wait of yours to clear.`);
    const actor = { agentId };
    const text = wait.work ? `The holder cleared the progress check for "${wait.reason}".` : `The wait for "${wait.reason}" is over, says its holder.`;
    const moved = await move(ctx, task, { externalWait: null, silent: 0 }, { kind: 'updated', actor, text, data: { externalWait: null, reason: wait.reason } }, async tx => {
      if (wait.operation) await endSourceWait(tx, { taskId: task.id, kind: 'external', sourceKey: waitForSourceKey(wait.operation), sourceRevision: 0, outcome: 'cancelled', proofRef: 'end_wait', actor });
    });
    return { task: moved, reason: wait.reason, work: Boolean(wait.work) };
  });
}

const OPEN = new Set(['open', 'working', 'review', 'waiting', 'blocked']);
type Sender = Pick<typeof agents.$inferSelect, 'id' | 'kind' | 'departmentId'>;
const actsOnTask = (task: Task, agentId: string): boolean => onTask(task, agentId) || task.executorAgentId === agentId;
const overseesTask = (task: Task, sender: Sender): boolean =>
  sender.kind === 'orchestrator' || (sender.kind === 'head' && task.departmentId !== null && sender.departmentId === task.departmentId);
const senderMayWrite = (task: Task, sender: Sender | undefined): boolean => Boolean(sender && (actsOnTask(task, sender.id) || overseesTask(task, sender)));

function requireHolder(task: Task, agentId: string): void {
  if (!OPEN.has(task.status)) throw refuse(409, 'task_invalid', `#${task.number} cannot wait while ${task.status}.`);
  if (task.assigneeAgentId !== agentId) throw refuse(403, 'task_not_yours', `#${task.number} is not with you.`);
  refusePaused(task);
}

/* The recipient holds the task, or the sender acts on it or oversees it as orchestrator or head of its department. An
   employee also writes on any task to the orchestrator, which oversees them all, as when it answers what it was asked.
   A closed task is held by nobody, and the one who did it, its head and the orchestrator still write about it. */
function requireMessageTask(task: Task, recipient: Sender | undefined, sender: Sender | undefined): void {
  const toOrchestrator = Boolean(sender && recipient?.kind === 'orchestrator');
  if (task.assigneeAgentId !== recipient?.id && !toOrchestrator && !senderMayWrite(task, sender)) throw refuse(403, 'task_not_yours', `#${task.number} is not with you.`);
  if (OPEN.has(task.status) && task.paused) throw refuse(409, 'task_paused', `#${task.number} is paused, so a message about it wakes nobody. Send it without the task, or resume the task first.`);
}

type TaskMessage = { companyId: string; agentId: string; task?: number | string; actor: Actor; text: string };
type MessageTurn = Parameters<typeof enqueueTurn>[1] & { message: TurnMessage };

type ResumedWait = { task: Task; before: ExternalWait };
type QueuedMessage = { id: string; resumed?: ResumedWait; repeated?: true };
/* The turn a message went into or waits with, and whether it went there before, from the same turn of its sender. */
export type SentMessage = { id: string; repeated: boolean };

/* Input precedes the agent line, as it does for a decision that changes its own agent. An employee's message that is
   refused is kept where failures reads it, and its sender hears why, to whom and on which task. */
export async function queueTaskMessage(ctx: Ctx, input: TaskMessage, turn: MessageTurn): Promise<string> {
  return (await sendTaskMessage(ctx, input, turn)).id;
}

/* The same, saying whether the words went before: a sender whose call broke off, or never heard its answer, sends them
   again from the same turn, and they go once. */
export async function sendTaskMessage(ctx: Ctx, input: TaskMessage, turn: MessageTurn): Promise<SentMessage> {
  try {
    return await withInputLock(ctx, input.agentId, () => queueMessage(ctx, input, turn));
  } catch (error) {
    const sender = input.actor.agentId;
    throw sender ? await refusedMessage(ctx, { companyId: input.companyId, agentId: sender }, { recipient: input.agentId, task: input.task }, error) : error;
  }
}

/* The turn an employee's words went into before, from the same turn of the same sender, on the same task or on none: the
   input lock holds the recipient's words in line, so a repeat comes after them. Words whose turn never went out, failed or
   dropped as stale before it started, did not reach the recipient, and go again. */
async function sentBefore(ctx: Ctx, agentId: string, message: TurnMessage, taskId: string | null): Promise<string | null> {
  if (!message.by || !message.byTurn) return null;
  const [sender] = await ctx.db.select(only(jobs, 'startedAt')).from(jobs).where(eq(jobs.id, message.byTurn));
  if (!sender?.startedAt) return null;
  const [before] = await ctx.db.select(only(agentEvents, 'jobId')).from(agentEvents).innerJoin(jobs, eq(jobs.id, agentEvents.jobId)).where(and(
    eq(agentEvents.agentId, agentId), gte(agentEvents.createdAt, sender.startedAt), sql`${agentEvents.data}->>'from' = 'agent'`, eq(agentEvents.kind, 'message'),
    sql`${agentEvents.data}->>'by' = ${message.by}`, sql`${agentEvents.data}->>'byTurn' = ${message.byTurn}`, sql`${agentEvents.data}->>'text' = ${message.text}`,
    taskId ? sql`${agentEvents.data}->'task'->>'id' = ${taskId}` : sql`${agentEvents.data}->'task' is null`,
    or(isNotNull(jobs.startedAt), notInArray(jobs.status, ['failed', 'obsolete'])),
  )).limit(1);
  return before?.jobId ?? null;
}

/* An employee's message goes into the turn that runs or waits in its recipient's line; a person's may wait for whatever
   holds that line back. */
async function queueMessage(ctx: Ctx, input: TaskMessage, turn: MessageTurn): Promise<SentMessage> {
  const required = !!input.actor.agentId;
  const queued: QueuedMessage = await onAgent(ctx, input.agentId, async () => {
    if (input.task !== undefined) return queueBoundMessage(ctx, { ...input, task: input.task }, turn);
    const before = await sentBefore(ctx, input.agentId, turn.message, null);
    return before ? { id: before, repeated: true } : { id: await insertOrDeliverTurn(ctx, turn) };
  });
  if (queued.repeated) return { id: queued.id, repeated: true };
  try {
    await pump(ctx, input.agentId);
    if (required) await onAgent(ctx, input.agentId, () => confirmMessage(ctx, input, queued.id));
  } catch (error) {
    const resumed = queued.resumed;
    if (resumed) await onAgent(ctx, input.agentId, () => restoreWait(ctx, resumed, input.actor));
    throw error;
  }
  return { id: queued.id, repeated: false };
}

type AgentNow = Awaited<ReturnType<typeof agentState>>;

/* The update its machine gets ready for, which a turn waits out. */
const updating = (state: AgentNow): boolean => Boolean(state.machineDrain);

/* What its plan holds a turn back for, which the sender should not wait out: its limit, or the share set for tasks. */
const planHold = (state: AgentNow, onTask: boolean): string | null => (state.limitUntil ? 'plan_at_limit' : state.budgetUntil && onTask ? 'plan_budget' : null);

/* Whether a turn waits in line for something that ends by itself: the turn that runs, a turn ahead of it, or its machine
   getting back on the line. */
async function waitsInLine(ctx: Ctx, agentId: string, turn: { id: string; createdAt: Date }, state: AgentNow): Promise<boolean> {
  if (state.busy) return true;
  const [ahead] = await ctx.db.select(idOnly(jobs)).from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'queued'), ne(jobs.id, turn.id), lte(jobs.createdAt, turn.createdAt))).limit(1);
  if (ahead) return true;
  return state.reason === 'machine_offline' && (await reconnecting(ctx, agentId));
}

/* Why a turn that did not go out cannot wait its line, or null when it waits for something that ends by itself. One its
   plan cannot run for now does not: the sender hears at once and can tell someone else, as it does of one whose employee
   cannot run for any other reason. An employee that can run takes it once its window does: the window may still give
   back the words of the turn that ended, or not have taken the turn that went to it, and the turn goes out with the next
   try, which the minute round makes if nothing comes before. */
async function notWaiting(ctx: Ctx, agentId: string, id: string): Promise<string | null> {
  const [turn] = await ctx.db.select({ id: jobs.id, taskId: jobs.taskId, createdAt: jobs.createdAt }).from(jobs).where(and(eq(jobs.id, id), eq(jobs.status, 'queued')));
  if (!turn) return 'turn_not_sent';
  const state = await agentState(ctx, agentId);
  if (updating(state)) return null;
  const held = planHold(state, turn.taskId !== null);
  if (held) return held;
  if (state.reason === null) return null;
  return (await waitsInLine(ctx, agentId, turn, state)) ? null : state.reason;
}

/* A letter in the inbox waits there for the turn that takes it, which other letters wait for too, whatever holds that turn back. */
async function inInbox(ctx: Ctx, id: string): Promise<boolean> {
  const [kept] = await ctx.db.select(only(jobs, 'inboxWake')).from(jobs).where(eq(jobs.id, id));
  return kept?.inboxWake === true;
}

/* The turn of a message that cannot wait fails with the line that says why, unless it went out or failed on its way. */
async function failUndelivered(ctx: Ctx, input: TaskMessage, id: string, why: string) {
  const line = undeliveredLine({ reason: why, recipient: input.agentId, task: taskNamed(input.task) });
  await ctx.db.update(jobs).set({ status: 'failed', error: NOT_DELIVERED, result: line, finishedAt: new Date() }).where(and(eq(jobs.id, id), eq(jobs.status, 'queued')));
  const [job] = await ctx.db.select({ status: jobs.status, error: jobs.error }).from(jobs).where(eq(jobs.id, id));
  return job;
}

/* A turn that failed on its own way out names its own reason. */
const ownReason = (job: { error: string | null } | undefined, why: string): string => (job?.error && job.error !== NOT_DELIVERED ? job.error : why);

/* A turn that cannot go out nor wait its line fails with why, its sender hears so, and its letter waits for nobody. */
async function confirmMessage(ctx: Ctx, input: TaskMessage, id: string): Promise<void> {
  const why = (await inInbox(ctx, id)) ? null : await notWaiting(ctx, input.agentId, id);
  if (why === null) return;
  const job = await failUndelivered(ctx, input, id, why);
  if (job && job.status !== 'failed') return;
  if (await dropMail(ctx.db, input.agentId, id)) await inboxChanged(ctx, input.agentId);
  throw messageNotDelivered(ownReason(job, why));
}

/* A failed send preserves the previous wait unless another task action has already replaced it. */
async function restoreWait(ctx: Ctx, resumed: ResumedWait, actor: Actor): Promise<void> {
  try {
    await move(ctx, resumed.task, { externalWait: resumed.before }, { kind: 'updated', actor, text: 'The message did not go out. The previous wait continues.', data: { externalWait: resumed.before } }, markRecord(resumed.before, 'waiting'));
  } catch (error) {
    if (!(error instanceof ApiError && error.reason === 'task_changed')) throw error;
  }
}

async function queueBoundMessage(ctx: Ctx, input: TaskMessage & { task: number | string }, turn: MessageTurn): Promise<QueuedMessage> {
  const task = await taskByRef(ctx, input.companyId, input.task);
  if (!task) throw refuse(404, 'task_unknown', `There is no task ${input.task} you can message.`);
  const party = (id: string) => ctx.db.select({ id: agents.id, kind: agents.kind, departmentId: agents.departmentId }).from(agents).where(eq(agents.id, id));
  const [sender] = input.actor.agentId ? await party(input.actor.agentId) : [];
  const [recipient] = await party(input.agentId);
  requireMessageTask(task, recipient, sender);
  const before = await sentBefore(ctx, input.agentId, turn.message, task.id);
  if (before) return { id: before, repeated: true };
  /* A word about a closed task, such as that it is done, goes as a message naming it: no work is left on it to wake. */
  if (!OPEN.has(task.status)) return { id: await insertOrDeliverTurn(ctx, { ...turn, message: { ...turn.message, task: { id: task.id, number: task.number } } }) };
  const id = await insertOrDeliverTurn(ctx, { ...turn, ...await taskTurn(ctx, task, input.agentId, turn.message) });
  if (!task.externalWait || task.assigneeAgentId !== input.agentId) return { id };
  const resumed = await move(ctx, task, { externalWait: null, silent: 0 }, { kind: 'comment', actor: input.actor, text: input.text, data: { externalWait: null }, inlineText: true }, markRecord(task.externalWait, 'check_back'));
  return { id, resumed: { task: resumed, before: task.externalWait } };
}

async function taskTurn(ctx: Ctx, task: Task, agentId: string, message: TurnMessage): Promise<{ message: TurnMessage; taskId: string }> {
  const to = task.assigneeAgentId === agentId ? {} : { to: agentId };
  return { taskId: task.id, message: { ...message, task: { id: task.id, number: task.number }, taskWake: { ...taskWakeOf(task, { why: 'comment' }, routeSnapshot(await routeOf(ctx.db, task), task.assigneeAgentId)), why: 'message', ...to } } };
}

/* A run ended, and the one who started it holds its task: the wait for that run goes in the write that ends the run and keeps
   its wake, so a crash cannot leave one without the other. It keeps the wakes other moves kept, which are other news. A wait
   for anything else stays, and so does someone else's: the result reaches its starter anyway, and it can end_wait. */
const ownsRunTask = (task: Task | undefined, agentId: string): task is Task => Boolean(task && OPEN.has(task.status) && task.assigneeAgentId === agentId);
const runEndUpdate = (task: Task, bound: boolean) => ({ version: task.version + 1, updatedAt: new Date(), ...(bound ? { externalWait: null, silent: 0 } : {}) });

type RunEnding = { waited: boolean; goesOn: ExternalWait | null };

export async function endWaitForRun(tx: Tx, taskId: string, agentId: string, run: { id: string; label: string }): Promise<RunEnding> {
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update');
  if (!ownsRunTask(task, agentId)) return { waited: false, goesOn: null };
  const bound = task.externalWait?.run === run.id;
  // Invalidate a wait that checked unread messages before this result committed, even when no wait is installed yet.
  await tx.update(tasks).set(runEndUpdate(task, bound)).where(eq(tasks.id, taskId));
  if (!bound) return { waited: false, goesOn: task.externalWait };
  const { reason } = task.externalWait!;
  await note(tx, task, { kind: 'updated', actor: { agentId }, text: `${run.label} ended, and with it the wait for "${reason}".`, data: { externalWait: null, reason } });
  return { waited: true, goesOn: null };
}

/* The task move and its wake commit together. Repeated or concurrent sweeps can end each wait only once. */
export async function checkExternalWaits(ctx: Ctx, now = new Date()): Promise<number> {
  const due = await ctx.db.select().from(tasks).where(and(
    isNotNull(tasks.externalWait),
    lte(sql<string>`${tasks.externalWait}->>'until'`, now.toISOString()),
    notInArray(tasks.status, ['done', 'cancelled']),
  ));
  let ended = 0;
  for (const task of due) if (await expireWait(ctx, task, undefined, now)) ended++;
  return ended;
}
export { expireWait } from './wait-expiry.js';
