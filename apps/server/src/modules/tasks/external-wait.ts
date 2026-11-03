import { z } from 'zod';
import { and, eq, isNotNull, lte, notInArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, jobs, tasks, type ExternalWait } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { loadTask, move, refuse, type Moved, type Task, type Wake } from './engine.js';
import { wakeAll } from './wake.js';
import { enqueueTurn, insertTurn, onAgent, pump, type TurnMessage } from '../conversation/queue.js';
import { taskByRef } from './views.js';
import type { Actor } from './engine.js';
import { taskWakeOf, waitingTaskTurn } from './wake-state.js';

export const EXTERNAL_WAIT_MS = 2 * 3_600_000;
export const TaskReference = z.union([z.number().int().positive(), z.string().max(40)]).describe('The task number, like 12 or "#12", or its id.');
export const MESSAGE_TASK_HINT = ' With task, the message concerns that task and ends its external wait. Without task, it leaves waits unchanged.';
export const WaitInput = z.object({
  reason: z.string().trim().min(1).max(600).regex(/^[^\r\n\u2028\u2029]+$/).describe('One line naming the external event you wait for.'),
  until: z.iso.datetime({ offset: true }).describe('An ISO date and time in the future, at most two hours from now.'),
});

function waitOf(input: z.infer<typeof WaitInput>, now: Date): ExternalWait {
  const parsed = WaitInput.safeParse(input);
  if (!parsed.success) throw refuse(400, 'task_invalid', 'Name the external event in one line and give its deadline as an ISO date and time.');
  const until = new Date(parsed.data.until);
  const delay = until.getTime() - now.getTime();
  if (delay <= 0 || delay > EXTERNAL_WAIT_MS) throw refuse(400, 'task_invalid', 'The wait must end in the future, at most two hours from now.');
  return { reason: parsed.data.reason, since: now.toISOString(), until: until.toISOString() };
}

/* A holder can end its turn while an external system works; the task keeps its workflow status. */
export function waitFor(ctx: Ctx, agentId: string, taskId: string, input: z.infer<typeof WaitInput>, now?: Date): Promise<Moved> {
  return onAgent(ctx, agentId, () => placeWait(ctx, agentId, taskId, input, now ?? new Date()));
}

async function placeWait(ctx: Ctx, agentId: string, taskId: string, input: z.infer<typeof WaitInput>, now: Date): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  requireHolder(task, agentId);
  await waitingTaskTurn(ctx.db, agentId, taskId);
  const [message] = await ctx.db.select({ id: jobs.id }).from(jobs).innerJoin(agentEvents, eq(agentEvents.jobId, jobs.id)).where(and(
    eq(jobs.agentId, agentId), eq(jobs.taskId, taskId), eq(jobs.status, 'queued'), eq(agentEvents.kind, 'message'),
    sql`${agentEvents.data}->'taskWake'->>'why' = 'message'`,
  )).limit(1);
  if (message) throw refuse(409, 'task_invalid', `A message on #${task.number} waits for you. End this turn and read it before waiting.`);
  const externalWait = waitOf(input, now);
  const row = await move(ctx, task, { externalWait, silent: 0 }, { kind: 'updated', actor: { agentId }, text: `Waiting for "${externalWait.reason}" until ${externalWait.until}.`, data: { externalWait } });
  return { task: row, wakes: [] };
}

function requireHolder(task: Task, agentId: string): void {
  if (!['open', 'working', 'review', 'waiting', 'blocked'].includes(task.status)) throw refuse(409, 'task_invalid', `#${task.number} cannot wait while ${task.status}.`);
  if (task.assigneeAgentId !== agentId) throw refuse(403, 'task_not_yours', `#${task.number} is not with you.`);
}

type TaskMessage = { companyId: string; agentId: string; task?: number | string; actor: Actor; text: string };
type MessageTurn = Parameters<typeof enqueueTurn>[1] & { message: TurnMessage };

/* Queueing and waiting use the same agent line, so an unread message cannot slip behind a new wait. */
export async function queueTaskMessage(ctx: Ctx, input: TaskMessage, turn: MessageTurn): Promise<string> {
  if (input.task === undefined) return enqueueTurn(ctx, turn);
  const bound = { ...input, task: input.task };
  const id = await onAgent(ctx, input.agentId, () => queueBoundMessage(ctx, bound, turn));
  await pump(ctx, input.agentId);
  return id;
}

async function queueBoundMessage(ctx: Ctx, input: TaskMessage & { task: number | string }, turn: MessageTurn): Promise<string> {
  const task = await taskByRef(ctx, input.companyId, input.task);
  if (!task) throw refuse(404, 'task_unknown', `There is no task ${input.task} you can message.`);
  requireHolder(task, input.agentId);
  const id = await insertTurn(ctx, { ...turn, ...taskTurn(task, turn.message) });
  if (task.externalWait) await move(ctx, task, { externalWait: null, silent: 0 }, { kind: 'comment', actor: input.actor, text: input.text, data: { externalWait: null } });
  return id;
}

function taskTurn(task: Task, message: TurnMessage): { message: TurnMessage; taskId: string } {
  return { taskId: task.id, message: { ...message, task: { id: task.id, number: task.number }, taskWake: { ...taskWakeOf(task, { why: 'comment' }), why: 'message' } } };
}

async function expireWait(ctx: Ctx, task: Task): Promise<boolean> {
  if (!task.externalWait || !task.assigneeAgentId) return false;
  const wakes: Wake[] = [{ agentId: task.assigneeAgentId, taskId: task.id, why: 'wait_ended', text: task.externalWait.reason, version: task.version + 1 }];
  try {
    await move(ctx, task, { externalWait: null, silent: 0 }, { kind: 'updated', actor: { agentId: task.assigneeAgentId }, text: `The wait for "${task.externalWait.reason}" ended.`, data: { externalWait: null, reason: task.externalWait.reason } }, undefined, wakes);
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
