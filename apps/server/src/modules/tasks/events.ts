import { taskSpot, type Task, type Actor, type Tx } from './state.js';
import { hideCredentialsIn } from '@hornhoof/protocol/redaction';
import { idOnly } from '../../db/selections.js';
import type { NotificationSource } from '@hornhoof/protocol';
import { and, desc, eq, gt, notInArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { taskEvents, type TaskEventKind } from '../../db/schema.js';
import { preserveNote } from './long-text.js';
export const actorColumns = (a: Actor) => ({ personId: a.personId ?? null, agentId: a.agentId ?? null });

/* returned: the agent gives its work back to the one above it with this move, which the map shows on their line.
   endsWorkUnder: what goes with the move closes the open work under the task before it is done. */
export type Note = { kind: TaskEventKind; actor: Actor; text?: string; data?: Record<string, unknown>; inlineText?: true; returned?: true; automatic?: NotificationSource; endsWorkUnder?: true };

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

export function published(ctx: Pick<Ctx, 'bus'>, task: Task): void {
  ctx.bus.publish(task.companyId, { type: 'task', id: task.id, spot: taskSpot(task) });
}

/* Events that do not move a task: what an agent says in it and Hornhoof's own notes about its turns. */
/* status: work started, which the turn did, not the task. edited: what the tracker keeps of it, which gives no work. */
export const NOT_A_MOVE = ['comment', 'reminded', 'continued', 'stuck', 'interrupted', 'wake_skipped', 'wake_obsolete', 'wait_due', 'wait_card', 'away', 'status', 'edited'] as const;

/* Comments and notes about a turn ending do not begin a new piece of work. */
export async function lastMove(db: Db | Tx, taskId: string) {
  const [last] = await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, taskId), notInArray(taskEvents.kind, [...NOT_A_MOVE]))).orderBy(desc(taskEvents.createdAt), desc(taskEvents.id)).limit(1);
  return last;
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
