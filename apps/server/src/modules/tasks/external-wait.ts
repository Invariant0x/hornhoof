import { randomUUID } from 'node:crypto';
import { WaitOnInput, WaitPlan, type WaitOwnerBinding } from '@hornhoof/protocol/waits';
import { z } from 'zod';
import { and, eq, inArray, isNotNull, lte, ne, notInArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, agents, jobs, pendingWakes, tasks, testRuns, type ExternalWait } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { loadTask, move, note, refuse, type Moved, type Task, type Tx, type Wake } from './engine.js';
import { wakeAll } from './wake.js';
import { agentState, conversationOf, enqueueTurn, insertOrDeliverTurn, onAgent, pump, type TurnMessage } from '../conversation/queue.js';
import { withInputLock } from '../conversation/decision-context.js';
import { messageNotDelivered } from '../conversation/live.js';
import { heardOfWait, recordWaitNotice, requestedWaitNotice } from './wait-notices.js';
import { checkWaitHealth } from './wait-monitor.js';
import { bindSource } from './wait-producers.js';
import { endSourceWait, setWaitStage, supersedeWaitFor, waitForSourceKey } from './wait-state.js';
import { checkedWaitTarget } from './wait-target.js';
import { taskByRef } from './views.js';
import type { Actor } from './engine.js';
import { onTask, taskWakeOf, waitingTaskTurn } from './wake-state.js';

export const EXTERNAL_WAIT_MS = 2 * 3_600_000;
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
  const [run] = await ctx.db.select({ id: testRuns.id }).from(testRuns).where(and(
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

/* Where the record of a wait stands now that the wait itself ended or came back: it has not ended by that. */
const markRecord = (wait: ExternalWait, stage: 'waiting' | 'check_back') => async (tx: Tx, task: Task): Promise<void> => {
  if (wait.operation) await setWaitStage(tx, { taskId: task.id, kind: 'external', sourceKey: waitForSourceKey(wait.operation), stage });
};

/* A holder can end its turn while an external system works; the task keeps its workflow status. */
export async function waitFor(ctx: Ctx, agentId: string, taskId: string, input: WaitAsked, now?: Date): Promise<Moved> {
  const at = now ?? new Date();
  const moved = await onAgent(ctx, agentId, () => placeWait(ctx, agentId, taskId, input, at));
  await checkWaitHealth(ctx, at);
  return moved;
}

/* Whether words on the task wait for its holder, the end of a run among them: in a turn, or still in the outbox. */
async function unreadMessage(ctx: Ctx, agentId: string, taskId: string): Promise<boolean> {
  const [message] = await ctx.db.select({ id: jobs.id }).from(jobs).innerJoin(agentEvents, eq(agentEvents.jobId, jobs.id)).where(and(
    eq(jobs.agentId, agentId), eq(jobs.taskId, taskId), eq(jobs.status, 'queued'), eq(agentEvents.kind, 'message'),
    sql`${agentEvents.data}->'taskWake'->>'why' in ('message', 'comment', 'unblocked', 'tests', 'work')`,
  )).limit(1);
  const [comment] = await ctx.db.select({ id: pendingWakes.id }).from(pendingWakes).where(and(
    eq(pendingWakes.agentId, agentId), eq(pendingWakes.taskId, taskId), inArray(pendingWakes.why, ['comment', 'unblocked', 'tests', 'work']),
  )).limit(1);
  return Boolean(message || comment);
}

/* The notice the wait asks for, kept in the same write as the wait. */
const keepNotice = (notice: Awaited<ReturnType<typeof requestedWaitNotice>>) => async (tx: Parameters<typeof recordWaitNotice>[0]) => {
  if (notice) await recordWaitNotice(tx, notice);
};

async function placeWait(ctx: Ctx, agentId: string, taskId: string, input: WaitAsked, now: Date): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  requireHolder(task, agentId);
  await waitingTaskTurn(ctx.db, agentId, taskId);
  if (await unreadMessage(ctx, agentId, taskId)) throw refuse(409, 'task_invalid', `A message on #${task.number} waits for you. End this turn and read it before waiting.`);
  const wait = waitOf(input, now);
  const run = input.run ? { run: await namedRun(ctx, task, agentId, input.run) } : {};
  const externalWait = { ...wait, ...run, ...withOn(await checkedWaitTarget(ctx, task.companyId, agentId, wait.on)) };
  const notice = (await heardOfWait(ctx.db, task, agentId, externalWait, now)) ? null : await requestedWaitNotice(ctx, { ...task, externalWait, version: task.version + 1 }, agentId);
  const row = await move(ctx, task, { externalWait, silent: 0 }, { kind: 'updated', actor: { agentId }, text: `Waiting for "${externalWait.reason}" until ${externalWait.until}.`, data: { externalWait } }, async tx => {
    await keepNotice(notice)(tx);
    await keepWaitRecord(tx, task, externalWait, input.plan, agentId);
  });
  return { task: row, wakes: [] };
}

/* The holder says its wait is over, having read what it waited for. Nobody is told: it goes on in the turn it is in. */
export function endOwnWait(ctx: Ctx, agentId: string, taskId: string): Promise<{ task: Task; reason: string }> {
  return onAgent(ctx, agentId, async () => {
    const task = await loadTask(ctx.db, taskId);
    requireHolder(task, agentId);
    const wait = task.externalWait;
    if (!wait) throw refuse(409, 'task_invalid', `#${task.number} has no wait of yours to end.`);
    const actor = { agentId };
    const moved = await move(ctx, task, { externalWait: null, silent: 0 }, { kind: 'updated', actor, text: `The wait for "${wait.reason}" is over, says its holder.`, data: { externalWait: null, reason: wait.reason } }, async tx => {
      if (wait.operation) await endSourceWait(tx, { taskId: task.id, kind: 'external', sourceKey: waitForSourceKey(wait.operation), sourceRevision: 0, outcome: 'cancelled', proofRef: 'end_wait', actor });
    });
    return { task: moved, reason: wait.reason };
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
}

/* The recipient holds the task, or the sender acts on it or oversees it as orchestrator or head of its department. */
function requireMessageTask(task: Task, recipientId: string, sender: Sender | undefined): void {
  if (!OPEN.has(task.status)) throw refuse(409, 'task_invalid', `#${task.number} is ${task.status}.`);
  if (task.assigneeAgentId !== recipientId && !senderMayWrite(task, sender)) throw refuse(403, 'task_not_yours', `#${task.number} is not with you.`);
}

type TaskMessage = { companyId: string; agentId: string; task?: number | string; actor: Actor; text: string };
type MessageTurn = Parameters<typeof enqueueTurn>[1] & { message: TurnMessage };

type ResumedWait = { task: Task; before: ExternalWait };
type QueuedMessage = { id: string; resumed?: ResumedWait };

/* Input precedes the agent line, as it does for a decision that changes its own agent. */
export function queueTaskMessage(ctx: Ctx, input: TaskMessage, turn: MessageTurn): Promise<string> {
  return withInputLock(ctx, input.agentId, () => queueMessage(ctx, input, turn));
}

async function queueMessage(ctx: Ctx, input: TaskMessage, turn: MessageTurn): Promise<string> {
  const required = !!input.actor.agentId;
  const queued: QueuedMessage = await onAgent(ctx, input.agentId, async () => input.task === undefined
    ? { id: await insertOrDeliverTurn(ctx, turn, required) }
    : queueBoundMessage(ctx, { ...input, task: input.task }, turn, required));
  try {
    await pump(ctx, input.agentId);
    if (required) await onAgent(ctx, input.agentId, () => confirmMessage(ctx, input.agentId, queued.id));
  } catch (error) {
    const resumed = queued.resumed;
    if (resumed) await onAgent(ctx, input.agentId, () => restoreWait(ctx, resumed, input.actor));
    throw error;
  }
  return queued.id;
}

/* Whether a turn that did not go out waits for something that ends by itself: the update its machine gets ready for, the
   turn that runs or a turn ahead of it. One its plan cannot run for now, at its limit or past the share set for tasks,
   does not: the sender hears at once and can tell someone else. */
async function waitsItsLine(ctx: Ctx, agentId: string, id: string): Promise<boolean> {
  const [turn] = await ctx.db.select({ taskId: jobs.taskId, createdAt: jobs.createdAt }).from(jobs).where(and(eq(jobs.id, id), eq(jobs.status, 'queued')));
  if (!turn) return false;
  const state = await agentState(ctx, agentId);
  if (state.machineDrain && state.machineDrain.state !== 'postponed') return true;
  if (state.limitUntil || (state.budgetUntil && turn.taskId)) return false;
  if (state.busy) return true;
  const [ahead] = await ctx.db.select({ id: jobs.id }).from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'queued'), ne(jobs.id, id), lte(jobs.createdAt, turn.createdAt))).limit(1);
  return Boolean(ahead);
}

async function confirmMessage(ctx: Ctx, agentId: string, id: string): Promise<void> {
  if (await waitsItsLine(ctx, agentId, id)) return;
  await ctx.db.update(jobs).set({ status: 'failed', error: 'message_not_delivered', finishedAt: new Date() }).where(and(eq(jobs.id, id), eq(jobs.status, 'queued')));
  const [job] = await ctx.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, id));
  if (!job || job.status === 'failed') throw messageNotDelivered();
}

/* A failed send preserves the previous wait unless another task action has already replaced it. */
async function restoreWait(ctx: Ctx, resumed: ResumedWait, actor: Actor): Promise<void> {
  try {
    await move(ctx, resumed.task, { externalWait: resumed.before }, { kind: 'updated', actor, text: 'The message did not go out. The previous wait continues.', data: { externalWait: resumed.before } }, markRecord(resumed.before, 'waiting'));
  } catch (error) {
    if (!(error instanceof ApiError && error.reason === 'task_changed')) throw error;
  }
}

async function queueBoundMessage(ctx: Ctx, input: TaskMessage & { task: number | string }, turn: MessageTurn, required: boolean): Promise<QueuedMessage> {
  const task = await taskByRef(ctx, input.companyId, input.task);
  if (!task) throw refuse(404, 'task_unknown', `There is no task ${input.task} you can message.`);
  const [sender] = input.actor.agentId
    ? await ctx.db.select({ id: agents.id, kind: agents.kind, departmentId: agents.departmentId }).from(agents).where(eq(agents.id, input.actor.agentId))
    : [];
  requireMessageTask(task, input.agentId, sender);
  const id = await insertOrDeliverTurn(ctx, { ...turn, ...taskTurn(task, input.agentId, turn.message) }, required);
  if (!task.externalWait || task.assigneeAgentId !== input.agentId) return { id };
  const resumed = await move(ctx, task, { externalWait: null, silent: 0 }, { kind: 'comment', actor: input.actor, text: input.text, data: { externalWait: null }, inlineText: true }, markRecord(task.externalWait, 'check_back'));
  return { id, resumed: { task: resumed, before: task.externalWait } };
}

function taskTurn(task: Task, agentId: string, message: TurnMessage): { message: TurnMessage; taskId: string } {
  const to = task.assigneeAgentId === agentId ? {} : { to: agentId };
  return { taskId: task.id, message: { ...message, task: { id: task.id, number: task.number }, taskWake: { ...taskWakeOf(task, { why: 'comment' }), why: 'message', ...to } } };
}

const waitEndedWake = (task: Task, agentId: string, reason: string, unavailable?: string): Wake =>
  ({ agentId, taskId: task.id, why: 'wait_ended', text: reason, ...(unavailable ? { note: unavailable } : {}), version: task.version + 1 });

const waitEndedFact = (agentId: string, reason: string, unavailable?: string) =>
  ({ kind: 'updated' as const, actor: { agentId }, text: unavailable ?? `The wait for "${reason}" ended.`, data: { externalWait: null, reason }, ...(unavailable ? { automatic: 'wait_unavailable' as const } : {}) });

export async function expireWait(ctx: Ctx, task: Task, unavailable?: string): Promise<boolean> {
  if (!task.externalWait || !task.assigneeAgentId) return false;
  const wakes = [waitEndedWake(task, task.assigneeAgentId, task.externalWait.reason, unavailable)];
  try {
    await move(ctx, task, { externalWait: null, silent: 0 }, waitEndedFact(task.assigneeAgentId, task.externalWait.reason, unavailable), markRecord(task.externalWait, 'check_back'), wakes);
  } catch (error) {
    if (error instanceof ApiError && error.reason === 'task_changed') return false;
    throw error;
  }
  await wakeAll(ctx, wakes);
  return true;
}

/* A run ended, and the one who started it holds its task: the wait for that run goes in the write that ends the run and keeps
   its wake, so a crash cannot leave one without the other. It keeps the wakes other moves kept, which are other news. A wait
   for anything else stays, and so does someone else's: the result reaches its starter anyway, and it can end_wait. */
const ownsRunTask = (task: Task | undefined, agentId: string): task is Task => Boolean(task && OPEN.has(task.status) && task.assigneeAgentId === agentId);
const runEndUpdate = (task: Task, bound: boolean) => ({ version: task.version + 1, updatedAt: new Date(), ...(bound ? { externalWait: null, silent: 0 } : {}) });

export type RunEnding = { waited: boolean; goesOn: ExternalWait | null };

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
    notInArray(tasks.status, ['planned', 'done', 'cancelled']),
  ));
  let ended = 0;
  for (const task of due) if (await expireWait(ctx, task)) ended++;
  return ended;
}
