import { WaitOnInput } from '@hornhoof/protocol/waits';
import { z } from 'zod';
import { and, eq, inArray, isNotNull, lte, notInArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, jobs, pendingWakes, tasks, type ExternalWait } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { loadTask, move, refuse, type Moved, type Task, type Wake } from './engine.js';
import { wakeAll } from './wake.js';
import { agentState, enqueueTurn, insertOrDeliverTurn, onAgent, pump, type TurnMessage } from '../conversation/queue.js';
import { withInputLock } from '../conversation/decision-context.js';
import { messageNotDelivered } from '../conversation/live.js';
import { recordWaitNotice, requestedWaitNotice } from './wait-notices.js';
import { checkWaitHealth } from './wait-monitor.js';
import { checkedWaitTarget } from './wait-target.js';
import { taskByRef } from './views.js';
import type { Actor } from './engine.js';
import { taskWakeOf, waitingTaskTurn } from './wake-state.js';

export const EXTERNAL_WAIT_MS = 2 * 3_600_000;
export const TaskReference = z.union([z.number().int().positive(), z.string().max(40)]).describe('The task number, like 12 or "#12", or its id.');
export const MESSAGE_TASK_HINT = ' With task, the message concerns that task and ends its external wait. Without task, it leaves waits unchanged.';
export const WaitInput = z.object({
  reason: z.string().trim().min(1).max(600).regex(/^[^\r\n\u2028\u2029]+$/).describe('One line naming what you need from the employee or external event.'),
  until: z.iso.datetime({ offset: true }).describe('An ISO date and time in the future, at most two hours from now.'),
  on: WaitOnInput.optional().describe('Who you wait for: an employee, or time, the CEO, a machine or another external event. Omitted means an external event.'),
});

function waitOf(input: z.infer<typeof WaitInput>, now: Date): ExternalWait {
  const parsed = WaitInput.safeParse(input);
  if (!parsed.success) throw refuse(400, 'task_invalid', 'Name the external event in one line and give its deadline as an ISO date and time.');
  const until = new Date(parsed.data.until);
  const delay = until.getTime() - now.getTime();
  if (delay <= 0 || delay > EXTERNAL_WAIT_MS) throw refuse(400, 'task_invalid', 'The wait must end in the future, at most two hours from now.');
  return { reason: parsed.data.reason, since: now.toISOString(), until: until.toISOString(), ...(parsed.data.on ? { on: parsed.data.on } : {}) };
}

/* A holder can end its turn while an external system works; the task keeps its workflow status. */
export async function waitFor(ctx: Ctx, agentId: string, taskId: string, input: z.infer<typeof WaitInput>, now?: Date): Promise<Moved> {
  const at = now ?? new Date();
  const moved = await onAgent(ctx, agentId, () => placeWait(ctx, agentId, taskId, input, at));
  await checkWaitHealth(ctx, at);
  return moved;
}

async function placeWait(ctx: Ctx, agentId: string, taskId: string, input: z.infer<typeof WaitInput>, now: Date): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  requireHolder(task, agentId);
  await waitingTaskTurn(ctx.db, agentId, taskId);
  const [message] = await ctx.db.select({ id: jobs.id }).from(jobs).innerJoin(agentEvents, eq(agentEvents.jobId, jobs.id)).where(and(
    eq(jobs.agentId, agentId), eq(jobs.taskId, taskId), eq(jobs.status, 'queued'), eq(agentEvents.kind, 'message'),
    sql`${agentEvents.data}->'taskWake'->>'why' in ('message', 'comment', 'unblocked')`,
  )).limit(1);
  const [comment] = await ctx.db.select({ id: pendingWakes.id }).from(pendingWakes).where(and(
    eq(pendingWakes.agentId, agentId), eq(pendingWakes.taskId, taskId), inArray(pendingWakes.why, ['comment', 'unblocked']),
  )).limit(1);
  if (message || comment) throw refuse(409, 'task_invalid', `A message on #${task.number} waits for you. End this turn and read it before waiting.`);
  const wait = waitOf(input, now);
  const on = await checkedWaitTarget(ctx, task.companyId, agentId, wait.on);
  const externalWait = { ...wait, ...(on ? { on } : {}) };
  const notice = await requestedWaitNotice(ctx, { ...task, externalWait, version: task.version + 1 }, agentId);
  const row = await move(ctx, task, { externalWait, silent: 0 }, { kind: 'updated', actor: { agentId }, text: `Waiting for "${externalWait.reason}" until ${externalWait.until}.`, data: { externalWait } }, async tx => { if (notice) await recordWaitNotice(tx, notice); });
  return { task: row, wakes: [] };
}

function requireHolder(task: Task, agentId: string): void {
  if (!['open', 'working', 'review', 'waiting', 'blocked'].includes(task.status)) throw refuse(409, 'task_invalid', `#${task.number} cannot wait while ${task.status}.`);
  if (task.assigneeAgentId !== agentId) throw refuse(403, 'task_not_yours', `#${task.number} is not with you.`);
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

async function confirmMessage(ctx: Ctx, agentId: string, id: string): Promise<void> {
  /* Its machine gets ready for an update: the turn waits in line and goes out after it, so nothing is lost. */
  const drain = (await agentState(ctx, agentId)).machineDrain;
  if (drain && drain.state !== 'postponed') return;
  await ctx.db.update(jobs).set({ status: 'failed', error: 'message_not_delivered', finishedAt: new Date() }).where(and(eq(jobs.id, id), eq(jobs.status, 'queued')));
  const [job] = await ctx.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, id));
  if (!job || job.status === 'failed') throw messageNotDelivered();
}

/* A failed send preserves the previous wait unless another task action has already replaced it. */
async function restoreWait(ctx: Ctx, resumed: ResumedWait, actor: Actor): Promise<void> {
  try {
    await move(ctx, resumed.task, { externalWait: resumed.before }, { kind: 'updated', actor, text: 'The message did not go out. The previous wait continues.', data: { externalWait: resumed.before } });
  } catch (error) {
    if (!(error instanceof ApiError && error.reason === 'task_changed')) throw error;
  }
}

async function queueBoundMessage(ctx: Ctx, input: TaskMessage & { task: number | string }, turn: MessageTurn, required: boolean): Promise<QueuedMessage> {
  const task = await taskByRef(ctx, input.companyId, input.task);
  if (!task) throw refuse(404, 'task_unknown', `There is no task ${input.task} you can message.`);
  const recipient = input.agentId;
  const holder = task.assigneeAgentId === recipient || task.panel.includes(recipient);
  if (![task.assigneeAgentId, task.createdByAgentId, task.executorAgentId, ...task.panel, ...task.gates].includes(recipient)) throw refuse(403, 'task_not_yours', `#${task.number} does not involve this employee.`);
  const topic = taskTurn(task, turn.message);
  const id = await insertOrDeliverTurn(ctx, { ...turn, ...topic, taskId: holder ? task.id : undefined }, required);
  if (!task.externalWait || task.assigneeAgentId !== recipient) return { id };
  const resumed = await move(ctx, task, { externalWait: null, silent: 0 }, { kind: 'comment', actor: input.actor, text: input.text, data: { externalWait: null } });
  return { id, resumed: { task: resumed, before: task.externalWait } };
}

function taskTurn(task: Task, message: TurnMessage): { message: TurnMessage; taskId: string } {
  return { taskId: task.id, message: { ...message, task: { id: task.id, number: task.number }, taskWake: { ...taskWakeOf(task, { why: 'comment' }), why: 'message' } } };
}

export async function expireWait(ctx: Ctx, task: Task, unavailable?: string): Promise<boolean> {
  if (!task.externalWait || !task.assigneeAgentId) return false;
  const wakes: Wake[] = [{ agentId: task.assigneeAgentId, taskId: task.id, why: 'wait_ended', text: task.externalWait.reason, ...(unavailable ? { note: unavailable } : {}), version: task.version + 1 }];
  try {
    await move(ctx, task, { externalWait: null, silent: 0 }, { kind: 'updated', actor: { agentId: task.assigneeAgentId }, text: unavailable ?? `The wait for "${task.externalWait.reason}" ended.`, data: { externalWait: null, reason: task.externalWait.reason }, ...(unavailable ? { automatic: 'wait_unavailable' as const } : {}) }, undefined, wakes);
  } catch (error) {
    if (error instanceof ApiError && error.reason === 'task_changed') return false;
    throw error;
  }
  await wakeAll(ctx, wakes);
  return true;
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
