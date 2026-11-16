import { inArray, isNotNull, and, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { jobs, people, taskEvents } from '../../db/schema.js';
import type { Task } from './engine.js';
import type { TaskWait } from './wait-state.js';

/* What a task's time says, worked out on the server: since when it is in its status, how long its turns ran, and whom it
   waits for since when. A task stands still when it is waiting, blocked or paused, for as long as inStatusSince says. */
export type TimeFacts = {
  inStatusSince: string;
  workSeconds: number;
  waitsOn: { who: { kind: 'person' | 'agent'; id: string; name: string } | null; since: string }[];
};

/* Since when each task is in its status: its last change of status, or, for a task from before the log said so, its last
   line, or its start. */
async function statusSince(db: Ctx['db'], rows: Pick<Task, 'id'>[]): Promise<Map<string, Date>> {
  const found = await db
    .selectDistinctOn([taskEvents.taskId], { taskId: taskEvents.taskId, at: taskEvents.createdAt })
    .from(taskEvents)
    .where(inArray(taskEvents.taskId, rows.map(t => t.id)))
    .orderBy(taskEvents.taskId, sql`(${taskEvents.data} ? 'toStatus') desc`, sql`${taskEvents.id} desc`);
  return new Map(found.map(r => [r.taskId, r.at]));
}

/* Seconds each task's turns ran: every one that started, to its end, or to now while it runs. */
async function workedSeconds(db: Ctx['db'], rows: Pick<Task, 'id'>[], now: number): Promise<Map<string, number>> {
  const ran = await db
    .select({ taskId: jobs.taskId, status: jobs.status, startedAt: jobs.startedAt, finishedAt: jobs.finishedAt })
    .from(jobs)
    .where(and(inArray(jobs.taskId, rows.map(t => t.id)), isNotNull(jobs.startedAt)));
  const seconds = new Map<string, number>();
  for (const j of ran) {
    const end = j.finishedAt?.getTime() ?? (j.status === 'running' ? now : null);
    if (end === null || !j.taskId) continue;
    seconds.set(j.taskId, (seconds.get(j.taskId) ?? 0) + Math.max(0, Math.round((end - j.startedAt!.getTime()) / 1000)));
  }
  return seconds;
}

/* The facts of every task at once, in as many reads as for one. agentName: the names of employees already read. */
export async function timeFacts(db: Ctx['db'], rows: Pick<Task, 'id' | 'createdAt'>[], waits: (t: Pick<Task, 'id'>) => TaskWait[], agentName: (id: string) => string | undefined, now = Date.now()): Promise<Map<string, TimeFacts>> {
  if (!rows.length) return new Map();
  const since = await statusSince(db, rows);
  const seconds = await workedSeconds(db, rows, now);
  const personIds = [...new Set(rows.flatMap(t => waits(t).flatMap(w => (w.ownerPersonId ? [w.ownerPersonId] : []))))];
  const named = new Map((personIds.length ? await db.select({ id: people.id, name: people.name }).from(people).where(inArray(people.id, personIds)) : []).map(p => [p.id, p.name]));
  const who = (w: TaskWait): TimeFacts['waitsOn'][number]['who'] => {
    if (w.ownerPersonId) return { kind: 'person', id: w.ownerPersonId, name: named.get(w.ownerPersonId) ?? '' };
    if (w.ownerAgentId) return { kind: 'agent', id: w.ownerAgentId, name: agentName(w.ownerAgentId) ?? '' };
    return null;
  };
  return new Map(rows.map(t => [t.id, {
    inStatusSince: (since.get(t.id) ?? t.createdAt).toISOString(),
    workSeconds: seconds.get(t.id) ?? 0,
    waitsOn: waits(t).map(w => ({ who: who(w), since: w.createdAt.toISOString() })),
  }]));
}
