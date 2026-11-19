import { idOnly } from '../../db/selections.js';
import { and, asc, eq, inArray, isNull, ne, notInArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { type Spot } from '../../auth/access.js';
import type { Db } from '../../db/client.js';
import { agents, requests, subscriptions, tasks } from '../../db/schema.js';
import { ApiError, type ErrorReason } from '../../errors.js';
import type { DecisionSubject } from '../../auth/decision-owner.js';
import { type WakeCause } from './notification-cause.js';
export type Task = typeof tasks.$inferSelect;
export type Request = typeof requests.$inferSelect;
/* Who moves a task: a person from the web app, or an agent from its tools. */
export type Actor = { personId: string; agentId?: undefined } | { agentId: string; personId?: undefined };
export type WakeWhy = 'assigned' | 'review' | 'done' | 'reported' | 'blocked' | 'cancelled' | 'answered' | 'comment' | 'updated' | 'reminder' | 'go_on' | 'turn' | 'switched' | 'explain' | 'subtasks' | 'after_cancelled' | 'unblocked' | 'tests' | 'work' | 'calls' | 'reviewed' | 'wait_ended' | 'work_check';
/* An agent that has to act on a task now; Hornhoof queues a turn for it. note: what else it should know, after the rest. */
export type Wake = { agentId: string; taskId: string; why: WakeWhy; text?: string; note?: string; version?: number; cause?: WakeCause };
export type Moved = { task: Task; wakes: Wake[] };

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/* Task commands use the same context for agents and people. */
export type Live = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'templates' | 'config' | 'readCompare' | 'readCommit'>>;

export const CLOSED: readonly Task['status'][] = ['done', 'cancelled'];
/* Turns in a row that end without moving the task before the agent's head is asked to step in. */
export const SILENT_TURNS = 3;
/* Turns in a row an agent may go on in, saying how far it got or working until its time runs out, before its head is asked:
   about six hours of work without handing anything in. */
export const GOING_ON_TURNS = 8;
export const COMMIT = /^[0-9a-f]{40}$/;

export const STATUS_CODES = { 400: 'validation', 403: 'forbidden', 404: 'not_found', 409: 'conflict' } as const;
export const refuse = (status: keyof typeof STATUS_CODES, reason: ErrorReason, message: string) => new ApiError(status, STATUS_CODES[status], message, reason);

export const notYours = (t: Task, what: string) => refuse(403, 'task_not_yours', `#${t.number} ${what}.`);

export async function loadTask(db: Db | Tx, taskId: string): Promise<Task> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw refuse(404, 'task_unknown', `There is no task ${taskId}.`);
  return task;
}

export function stillOpen(task: Task): void {
  if (CLOSED.includes(task.status)) throw refuse(409, 'task_closed', `#${task.number} is ${task.status} already.`);
}

/* Names as a reader says them: "A", "A and B", "A, B and C". */
export function joined(names: string[]): string {
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

/* Where a task sits, for the stream: its product inside its department, or the department; none for the orchestrator's. */
export const taskSpot = (t: Pick<Task, 'departmentId' | 'productId'>): Spot =>
  t.productId ? { departmentId: t.productId, parentId: t.departmentId } : { departmentId: t.departmentId, parentId: null };

/* Whoever gave the task, when that was an agent other than the one acting. Whoever gave out a task that is done hears it
   only for a task of its own: work under a bigger task is heard of once, when the last of it closes. */
export const giver = (task: Task, why: WakeWhy, actorId?: string, text?: string): Wake[] =>
  task.createdByAgentId && task.createdByAgentId !== actorId && !(task.parentId && (why === 'done' || why === 'reported')) ? [{ agentId: task.createdByAgentId, taskId: task.id, why, ...(text ? { text } : {}) }] : [];

/* Whether the task waits for a person's word other than Hornhoof's note that it stood still. */
export async function waitsForPerson(db: Db | Tx, taskId: string): Promise<boolean> {
  const [open] = await db.select(idOnly(requests)).from(requests).where(and(eq(requests.taskId, taskId), eq(requests.status, 'open'), notInArray(requests.kind, ['stuck']))).limit(1);
  return !!open;
}

/* A live employee or orchestrator of the company. An assistant's own agent is its owner's, not the company's. */
export async function liveAgent(db: Db | Tx, companyId: string | null, id: string) {
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, id), isNull(agents.removedAt)));
  if (!agent || agent.kind === 'assistant' || (companyId && agent.companyId !== companyId)) throw refuse(400, 'task_invalid', `There is no employee ${id}.`);
  return agent;
}

/* A live agent that can take a turn needs an active subscription and must be switched on. */
export async function workingAgent(db: Db | Tx, companyId: string | null, id: string) {
  const agent = await liveAgent(db, companyId, id);
  if (agent.switchedOffAt) throw refuse(409, 'switched_off', `${agent.name} is switched off right now. Give the work to someone who is on.`);
  const [sub] = agent.subscriptionId
    ? await db.select(idOnly(subscriptions)).from(subscriptions).where(and(eq(subscriptions.id, agent.subscriptionId), isNull(subscriptions.removedAt)))
    : [];
  if (!sub) throw refuse(409, 'no_subscription', `${agent.name} has no subscription to run on. Give them one on their card first.`);
  return agent;
}

export function requireOwner(task: Task, agentId: string, refusal: string): void {
  stillOpen(task);
  if (task.assigneeAgentId !== agentId) throw notYours(task, refusal);
}

/* Only the current task owner asks on it. */
export function mayAsk(task: Task, agentId: string): void {
  requireOwner(task, agentId, 'is not with you');
}

/* What a request is, for whom may take it. */
export const requestSubject = (r: Pick<Request, 'kind' | 'decisionTopic'> & Partial<Pick<Request, 'recipientPersonId'>>, t: Pick<Task, 'departmentId' | 'productId'>): DecisionSubject => ({
  source: 'request',
  kind: r.kind,
  topic: r.decisionTopic,
  recipient: r.recipientPersonId,
  spot: taskSpot(t),
});
