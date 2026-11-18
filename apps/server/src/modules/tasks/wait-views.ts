import type { TaskWaitView, WaitOwnerBinding } from '@hornhoof/protocol/waits';
import { and, asc, desc, eq, inArray, lt, notInArray, or, sql } from 'drizzle-orm';
import type { AgentViewer } from '../../auth/agent-view.js';
import { knowsAgentId } from '../../auth/agent-view.js';
import type { Db } from '../../db/client.js';
import { tasks, taskWaits } from '../../db/schema.js';
import type { Task, Tx } from './state.js';
import { afterSourceKey, waitOwner, type TaskWait } from './wait-state.js';

/* What a reader gets of the waits on a task: who answers by when and at which level, with no source, proof or route. */

const shownDate = (at: Date | null): string | null => at?.toISOString() ?? null;

export const waitView = (wait: TaskWait): TaskWaitView => ({
  id: wait.id,
  taskId: wait.taskId,
  kind: wait.kind,
  state: wait.state,
  generation: wait.generation,
  level: wait.level,
  owner: waitOwner(wait),
  ownerDueAt: shownDate(wait.ownerDueAt),
  headDueAt: shownDate(wait.headDueAt),
  decisionDueAt: shownDate(wait.decisionDueAt),
  nextActionAt: shownDate(wait.nextActionAt),
  stage: wait.sourceState.stage ?? null,
});

export const prerequisiteOf = (wait: TaskWait): string | null => (wait.kind === 'after' ? wait.sourceKey.slice(afterSourceKey('').length) : null);

/* The waits open on these tasks, what comes due first first, the ones with no date last. */
export async function openWaitsOf(db: Db | Tx, taskIds: string[]): Promise<Map<string, TaskWait[]>> {
  const rows = taskIds.length
    ? await db.select().from(taskWaits).where(and(inArray(taskWaits.taskId, taskIds), inArray(taskWaits.state, ['active', 'legacy_needs_plan'])))
      .orderBy(sql`${taskWaits.nextActionAt} asc nulls last`, asc(taskWaits.createdAt), asc(taskWaits.id))
    : [];
  const byTask = new Map<string, TaskWait[]>();
  for (const wait of rows) byTask.set(wait.taskId, [...(byTask.get(wait.taskId) ?? []), wait]);
  return byTask;
}

/* A wait for a task the reader does not see goes without a trace: not its name, nor that there is one. */
export const shownWaits = (waits: TaskWait[], seenPrerequisite: (id: string) => boolean): TaskWaitView[] =>
  waits.filter(wait => {
    const prerequisite = prerequisiteOf(wait);
    return prerequisite === null || seenPrerequisite(prerequisite);
  }).map(waitView);

function shownOwner(viewer: AgentViewer, owner: WaitOwnerBinding | null): WaitOwnerBinding | null {
  if (!owner || viewer.full) return owner;
  if ('agentId' in owner) return knowsAgentId(viewer, owner.agentId) ? owner : null;
  return owner.personId === viewer.personId ? owner : null;
}

/* Whom a wait answers to goes when that is an agent this person does not know of, or another person. */
export const maskWaits = (viewer: AgentViewer, waits: TaskWaitView[]): TaskWaitView[] => waits.map(wait => ({ ...wait, owner: shownOwner(viewer, wait.owner) }));

export type WaitPage = { waits: TaskWaitView[]; next: string | null };
export type WaitPlace = { at: Date; id: string };

export const pageAfter = (wait: Pick<TaskWait, 'createdAt' | 'id'>): string => `${wait.createdAt.toISOString()}_${wait.id}`;

/* Where a page goes on from, or null for what names no place in the list. */
export function placeOf(text: string): WaitPlace | null {
  const [moment, id, more] = text.split('_');
  if (!moment || !id || more !== undefined) return null;
  const at = new Date(moment);
  return Number.isNaN(at.getTime()) || !/^[0-9a-f-]{36}$/.test(id) ? null : { at, id };
}

/* The edges of a task to what this reader does not see, ended ones too: left out before paging, so no page or its end tells. */
async function hiddenEdges(db: Db, task: Pick<Task, 'id'>, sees: (t: Task) => boolean): Promise<string[]> {
  const edges = await db.select().from(taskWaits).where(and(eq(taskWaits.taskId, task.id), eq(taskWaits.kind, 'after')));
  const ids = edges.flatMap(wait => prerequisiteOf(wait) ?? []);
  const rows = ids.length ? await db.select().from(tasks).where(inArray(tasks.id, ids)) : [];
  const seen = new Set(rows.filter(sees).map(t => t.id));
  return edges.filter(wait => !seen.has(prerequisiteOf(wait)!)).map(wait => wait.sourceKey);
}

/* The whole record of the waits on a task, newest first, a page at a time. */
export async function waitHistory(db: Db, task: Pick<Task, 'id'>, sees: (t: Task) => boolean, page: { limit: number; before: WaitPlace | null }): Promise<WaitPage> {
  const hidden = await hiddenEdges(db, task, sees);
  const rows = await db.select().from(taskWaits).where(and(
    eq(taskWaits.taskId, task.id),
    hidden.length ? notInArray(taskWaits.sourceKey, hidden) : undefined,
    page.before ? or(lt(taskWaits.createdAt, page.before.at), and(eq(taskWaits.createdAt, page.before.at), lt(taskWaits.id, page.before.id))) : undefined,
  )).orderBy(desc(taskWaits.createdAt), desc(taskWaits.id)).limit(page.limit + 1);
  const shown = rows.slice(0, page.limit);
  return { waits: shown.map(waitView), next: rows.length > page.limit ? pageAfter(shown.at(-1)!) : null };
}
