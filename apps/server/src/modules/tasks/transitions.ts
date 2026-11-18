import { note, published, type Note } from './events.js';
import { CLOSED, refuse, listed, openAfter, taskSpot, type Task, type Actor, type Wake, type Tx, type Live } from './state.js';
import { idOnly, only } from '../../db/selections.js';
import { nudgeTrackerKeepers } from '../tracker/nudge.js';
import { followedStage, holdPipelines } from '../tracker/pipelines.js';
import { and, asc, eq, inArray, notInArray, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { companies, requests, taskEvents, tasks } from '../../db/schema.js';
import { dropEarlierWakes, keepWakes } from './outbox.js';
import { returnAlongLine } from '../org/map-state.js';
import { handOff } from './pulses.js';
import { recordCause } from './notification-cause.js';
import { endAfter, keepWaitsWithMove } from './wait-producers.js';
/* Work under a task that is still open: a task is done only once all of it is. */
export async function refuseOpenUnder(db: Db | Tx, task: Task): Promise<void> {
  const open = await db.select(only(tasks, 'number')).from(tasks).where(and(eq(tasks.parentId, task.id), notInArray(tasks.status, [...CLOSED]))).orderBy(asc(tasks.number));
  if (open.length) throw refuse(409, 'task_invalid', `#${task.number} still has open subtasks: ${open.map(t => `#${t.number}`).join(', ')}. Wait for them, or cancel them first.`);
}

/* Done means all of it: work under it still open would go on under a finished task, and the turn with it. A move that ends
   the work under it itself is checked once what goes with it ran (ran true), any other before. */
export async function doneWhole(tx: Tx, task: Task, set: Partial<Task>, n: { endsWorkUnder?: true }, ran: boolean): Promise<void> {
  if (set.status === 'done' && Boolean(n.endsWorkUnder) === ran) await refuseOpenUnder(tx, task);
}

/* The last child wakes its current parent owner; each executable child already owns its Review. */
export async function workUnderDone(tx: Tx, closed: Task, actorId: string | undefined): Promise<Wake[]> {
  const [parent] = await tx.select().from(tasks).where(eq(tasks.id, closed.parentId!));
  if (!parent?.assigneeAgentId || CLOSED.includes(parent.status) || parent.assigneeAgentId === actorId) return [];
  const [open] = await tx.select(idOnly(tasks)).from(tasks).where(and(eq(tasks.parentId, parent.id), notInArray(tasks.status, [...CLOSED]))).limit(1);
  return open || (await openAfter(tx, parent)).length ? [] : [{ agentId: parent.assigneeAgentId, taskId: parent.id, why: 'subtasks' }];
}

/* A task never waits for itself, also not through the tasks it comes after. */
export async function refuseCircle(db: Db | Tx, task: Task, ids: string[]): Promise<void> {
  const seen = new Set<string>();
  let level = ids;
  while (level.length) {
    if (level.includes(task.id)) throw refuse(400, 'task_invalid', `#${task.number} would wait for itself through what it comes after.`);
    const rows = await db.select(only(tasks, 'after')).from(tasks).where(inArray(tasks.id, level));
    level = rows.flatMap(r => r.after).filter(id => !seen.has(id) && Boolean(seen.add(id)));
  }
}

/* The open tasks of the company that wait as said, in any turn or none, as a task may come after one of another
   department's turn: the index on what tasks come after finds them, so the rest of the company's history is not read. */
export const comingAfter = (of: Task[], waits: SQL) => and(eq(tasks.companyId, of[0]!.companyId), waits, notInArray(tasks.status, [...CLOSED]));

/* A task is done: each task that came after it and waits for nothing else any more goes on with whoever holds it, and
   its log says why. rows: the tasks that started. Two tasks it waits for done at once would each see the other still
   open, so the waiting tasks are taken first and the second to be done sees the first. */
export async function startAfter(tx: Tx, done: Task, actor: Actor): Promise<{ wakes: Wake[]; rows: Task[] }> {
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

/* A move by which an agent gives its work back lights its line to the one above it on the map: the task, when it did. */
export async function givesBack(tx: Tx, row: Task, n: Note, event: { id: number; createdAt: Date }): Promise<Task | null> {
  if (!n.returned || !n.actor.agentId) return null;
  return (await returnAlongLine(tx, { agentId: n.actor.agentId, sourceKey: `task:${event.id}`, sourceTaskId: row.id, returnedAt: event.createdAt })) ? row : null;
}

/* The map reads its lines again when one of them changed, in the company of what changed it. */
export function linesMoved(ctx: Live, changed: { companyId: string } | null): void {
  if (changed) ctx.bus.publish(changed.companyId, { type: 'org' });
}

export async function lockMovePrerequisites(tx: Tx, task: Task, after: string[]): Promise<void> {
  await tx.select(idOnly(companies)).from(companies).where(eq(companies.id, task.companyId)).for('no key update');
  await tx.select(idOnly(tasks)).from(tasks).where(inArray(tasks.id, after)).orderBy(asc(tasks.id)).for('share');
  await refuseCircle(tx, task, after);
}

export async function lockClosingParent(tx: Tx, task: Task, set: Partial<Task>): Promise<void> {
  if (!set.status || !CLOSED.includes(set.status) || !task.parentId) return;
  if (!set.after?.length) await tx.select(idOnly(companies)).from(companies).where(eq(companies.id, task.companyId)).for('no key update');
  await tx.select(idOnly(tasks)).from(tasks).where(eq(tasks.id, task.parentId)).for('no key update');
}

/* A change of status says in its line of the log where it went from and to, so the history tells how long each lasted. */
export const statusNoted = (n: Note, from: Task['status'], to: Task['status']): Note => (from === to ? n : { ...n, data: { ...n.data, fromStatus: from, toStatus: to } });

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

/* Hornhoof's notes that the task stood still are over once it moves again: handed on, handed in or reported. */
export async function letStuckGo(tx: Tx, taskId: string): Promise<boolean> {
  const gone = await tx.update(requests).set({ status: 'withdrawn', answeredAt: new Date() }).where(and(eq(requests.taskId, taskId), eq(requests.status, 'open'), eq(requests.kind, 'stuck'))).returning({ id: requests.id });
  return gone.length > 0;
}
