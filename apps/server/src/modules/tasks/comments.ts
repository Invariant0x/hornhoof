import { move } from './transitions.js';
import { note, published } from './events.js';
import { CLOSED, refuse, loadTask, type Task, type Actor, type Wake, type Moved, type Live } from './state.js';
import { hideCredentialsIn } from '@hornhoof/protocol/redaction';
import { idOnly, only } from '../../db/selections.js';
import { and, desc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, taskEvents, type TaskEventKind } from '../../db/schema.js';
import { keepWakes } from './outbox.js';
import { recordCause } from './notification-cause.js';
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

export async function unblockByComment(ctx: Live, actor: Actor, task: Task, text: string): Promise<(Moved & { held?: true }) | null> {
  if (!actor.agentId || task.status !== 'blocked' || !task.executorAgentId || task.assigneeAgentId !== task.executorAgentId || !(await gaveOut(ctx.db, task, actor.agentId))) return null;
  if (await openedByComment(ctx.db, task.id)) return { ...(await logComment(ctx, actor, task, text)), held: true };
  const wakes: Wake[] = [{ agentId: task.executorAgentId, taskId: task.id, why: 'unblocked', text }];
  return { task: await move(ctx, task, { status: 'open', silent: 0 }, { kind: 'comment', actor, text, data: { unblocked: true } }, undefined, wakes), wakes };
}

/* What begins a new piece of work on a task: a move of its work, or its words or owner rewritten. */
export const NEW_PIECE: TaskEventKind[] = ['created', 'assigned', 'started', 'submitted', 'verdict', 'report', 'answered'];

/* Whether a comment opened the task again since its last piece of work began: the answer it was blocked for came then. */
export async function openedByComment(db: Db, taskId: string): Promise<boolean> {
  const [piece] = await db.select(idOnly(taskEvents)).from(taskEvents).where(and(eq(taskEvents.taskId, taskId), or(
    inArray(taskEvents.kind, NEW_PIECE),
    and(eq(taskEvents.kind, 'updated'), sql`${taskEvents.data}->'fields' ?| array['title', 'brief', 'body', 'owner', 'assigneeAgentId']`),
  ))).orderBy(desc(taskEvents.id)).limit(1);
  const [opened] = await db.select(idOnly(taskEvents)).from(taskEvents).where(and(
    eq(taskEvents.taskId, taskId), eq(taskEvents.kind, 'comment'), sql`${taskEvents.data}->>'unblocked' = 'true'`, gt(taskEvents.id, piece?.id ?? 0),
  )).limit(1);
  return Boolean(opened);
}

export async function resumeByComment(ctx: Live, actor: Actor, task: Task, text: string): Promise<Moved | null> {
  if (!task.externalWait || !task.assigneeAgentId || actor.agentId === task.assigneeAgentId || CLOSED.includes(task.status)) return null;
  const wakes = commentWakes(task, actor, text);
  return { task: await move(ctx, task, { externalWait: null, silent: 0 }, { kind: 'comment', actor, text, data: { externalWait: null } }, undefined, wakes), wakes };
}

export function commentWakes(task: Task, actor: Actor, text: string): Wake[] {
  if (CLOSED.includes(task.status) || task.paused) return [];
  if (task.status === 'blocked' && !actor.personId) return [];
  const recipients = new Set([task.assigneeAgentId]);
  recipients.delete(actor.agentId ?? null);
  return [...recipients].filter((id): id is string => id !== null).map(agentId => ({ agentId, taskId: task.id, why: 'comment', text }));
}

export async function logComment(ctx: Live, actor: Actor, task: Task, text: string): Promise<Moved> {
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
export async function gaveOut(db: Db, task: Task, agentId: string): Promise<boolean> {
  if (task.createdByAgentId === agentId) return true;
  const [agent] = await db.select(only(agents, 'kind')).from(agents).where(eq(agents.id, agentId));
  return agent?.kind === 'orchestrator';
}
