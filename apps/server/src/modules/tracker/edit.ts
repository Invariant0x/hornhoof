import { and, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { pipelineStages, tasks } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { note, published, refuse, taskSpot, type Actor, type Task, type Tx } from '../tasks/engine.js';
import { holdPipelines, placeOnPipeline, stageGone } from './pipelines.js';
import { requireAnswersFor } from './responsible.js';
import { goalFor } from './task-fields.js';

/* What may change of a task beside its work: its texts for people and what the tracker keeps. Who does it, its status, its
   place and its route change elsewhere. null takes a goal, a date or a pipeline off. */
export type TaskEdit = {
  title?: string;
  brief?: string;
  why?: string;
  goalId?: string | null;
  responsiblePersonId?: string;
  dueAt?: Date | null;
  pipelineId?: string | null;
  pipelineStageId?: string | null;
};

/* The names the history and the screens use for what changed, in the order the card shows them. */
const FIELDS = [['title', 'title'], ['brief', 'brief'], ['why', 'why'], ['goalId', 'goal'], ['responsiblePersonId', 'responsible'], ['dueAt', 'due'], ['pipelineId', 'pipeline'], ['pipelineStageId', 'stage']] as const;

const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

/* The checked change of a task, and the names of what it changes: a goal only for a task with nothing above it, a person who
   reaches its place, a pipeline of its department, a stage of its pipeline. A new pipeline without a stage starts where
   whoever holds the task stands on it. */
export async function trackerSet(ctx: Pick<Ctx, 'db'>, task: Task, edit: TaskEdit): Promise<{ set: Partial<Task>; fields: string[] }> {
  const spot = taskSpot(task);
  const set: Partial<Task> = {};
  if (edit.title !== undefined) set.title = edit.title.trim();
  if (edit.brief !== undefined) set.brief = edit.brief.trim();
  if (edit.why !== undefined) set.why = edit.why.trim();
  if (edit.dueAt !== undefined) set.dueAt = edit.dueAt;
  if (edit.goalId !== undefined && edit.goalId !== task.goalId) {
    if (edit.goalId && task.parentId) throw refuse(400, 'goal_invalid', 'Work under a task serves the goal of the task above it, so it names none of its own.');
    set.goalId = edit.goalId ? (await goalFor(ctx, task.companyId, spot, edit.goalId)).id : null;
  }
  if (edit.responsiblePersonId !== undefined && edit.responsiblePersonId !== task.responsiblePersonId) {
    await requireAnswersFor(ctx, task.companyId, edit.responsiblePersonId, spot);
    set.responsiblePersonId = edit.responsiblePersonId;
  }
  if (edit.pipelineId === null) Object.assign(set, { pipelineId: null, pipelineStageId: null });
  else if (edit.pipelineId !== undefined && edit.pipelineId !== task.pipelineId) Object.assign(set, await placeOnPipeline(ctx.db, task.companyId, spot, task.assigneeAgentId, edit.pipelineId, edit.pipelineStageId));
  else if (edit.pipelineStageId !== undefined) set.pipelineStageId = await stageOf(ctx, task, edit.pipelineStageId);
  const fields = FIELDS.filter(([key]) => key in set && !same(set[key], task[key])).map(([, name]) => name);
  return { set, fields };
}

/* A stage of the pipeline the task is on, or none: back to not started. */
async function stageOf(ctx: Pick<Ctx, 'db'>, task: Task, stageId: string | null): Promise<string | null> {
  if (stageId === null) return null;
  if (!task.pipelineId) throw refuse(400, 'pipeline_invalid', 'Put the task on a pipeline first.');
  const [stage] = await ctx.db.select({ id: pipelineStages.id }).from(pipelineStages).where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.pipelineId, task.pipelineId)));
  if (!stage) throw refuse(400, 'pipeline_invalid', 'This stage is not of the task\'s pipeline.');
  return stage.id;
}

/* What the writer of an edit saw of the task: the version of its work and the revision of what the tracker keeps. */
export type Seen = { version: number; revision: number };
export const seenOf = (task: Pick<Task, 'version' | 'trackerRevision'>): Seen => ({ version: task.version, revision: task.trackerRevision });
const sameAs = (task: Pick<Task, 'version' | 'trackerRevision'>, seen: Seen) => task.version === seen.version && task.trackerRevision === seen.revision;
/* The next revision of what the tracker keeps, for every change of it. */
export const nextRevision = () => sql`${tasks.trackerRevision} + 1`;

/* An edit of what the tracker keeps, made only on the task as its writer saw it: a move of its work or another edit of it
   since then refuses it, so neither is written over. It gives no work and is no move of it: it wakes nobody, leaves what
   the task waits for as it is, and keeps the task's version and its time of the last change, by which turns kept for it
   and the quiet department's alarm tell the work going on. Its own revision grows instead. Its line in the history says
   what changed. It is checked on the task as read first, so a wrong edit is refused before it waits on anything, and
   again as it is written. */
export async function editTask(ctx: Pick<Ctx, 'db' | 'bus'>, actor: Actor, task: Task, edit: TaskEdit, seen: Seen): Promise<Task> {
  const changed = () => refuse(409, 'task_changed', `#${task.number} changed meanwhile. Read it again.`);
  if (!sameAs(task, seen)) throw changed();
  if (!(await trackerSet(ctx, task, edit)).fields.length) return task;
  const row = await ctx.db.transaction(async tx => {
    /* The pipelines first, then the task, as a change of a pipeline takes them. */
    await holdPipelines(tx, [task.pipelineId, edit.pipelineId]);
    const [fresh] = await tx.select().from(tasks).where(eq(tasks.id, task.id)).for('update');
    if (!fresh || !sameAs(fresh, seen)) throw changed();
    return writeEdit(tx, actor, fresh, edit);
  });
  if (!row) return task;
  published(ctx, row);
  return row;
}

/* Writes an edit of what the tracker keeps inside the change that writes it, its pipelines held by then: checked once more
   on the task as it is, it writes what still holds, and a stage taken off its pipeline since the first check is a
   conflict, not a broken write. None: nothing to change. */
export async function writeEdit(tx: Tx, actor: Actor, task: Task, edit: TaskEdit): Promise<Task | null> {
  const { set, fields } = await trackerSet({ db: tx }, task, edit).catch((err: unknown) => {
    throw err instanceof ApiError && err.reason === 'pipeline_invalid' ? stageGone() : err;
  });
  if (!fields.length) return null;
  const [row] = await tx.update(tasks).set({ ...set, trackerRevision: nextRevision() }).where(eq(tasks.id, task.id)).returning();
  await note(tx, row!, { kind: 'edited', actor, data: { fields } });
  return row!;
}
