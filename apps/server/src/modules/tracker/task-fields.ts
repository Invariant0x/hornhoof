import type { TaskPriority } from '@hornhoof/protocol';
import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Spot } from '../../auth/access.js';
import { goals } from '../../db/schema.js';
import { refuse, type Task } from '../tasks/engine.js';
import { placeOnPipeline } from './pipelines.js';
import { placeOwner, requireAnswersFor } from './responsible.js';

/* What the tracker keeps of a task beside its work: the goal it serves, who answers for it, why it exists, by when. */
export type TrackerInput = { goalId?: string | null; responsiblePersonId?: string | null; why?: string; dueAt?: Date | null; priority?: TaskPriority | null; pipelineId?: string | null; pipelineStageId?: string | null };
export type TrackerFields = { goalId: string | null; responsiblePersonId: string; why: string; dueAt: Date | null; priority: TaskPriority | null; pipelineId: string | null; pipelineStageId: string | null };

/* A goal a task in this place may serve: the company's, or one of its department or of the department that holds it. */
export async function goalFor(ctx: Pick<Ctx, 'db'>, companyId: string, spot: Spot, goalId: string) {
  const [goal] = await ctx.db.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.companyId, companyId)));
  if (!goal) throw refuse(400, 'goal_invalid', 'There is no such goal.');
  if (![null, spot.departmentId, spot.parentId ?? null].includes(goal.departmentId)) throw refuse(400, 'goal_invalid', "A task serves a company goal or a goal of its own department.");
  return goal;
}

/* The tracker's fields of a new task, one rule for every way a task is made. Only a task with nothing above it serves a goal
   of its own; work under a task serves that task's. Who answers for it: the person named, who must reach its place, else
   the person of the task above it, else the goal's, else whoever takes the place's decisions. On a pipeline it starts on the
   stage named, else the first one of whoever holds it. */
export async function newTrackerFields(ctx: Pick<Ctx, 'db'>, companyId: string, spot: Spot, parent: Pick<Task, 'responsiblePersonId'> | null, input: TrackerInput, holderId: string): Promise<TrackerFields> {
  if (parent && input.goalId) throw refuse(400, 'goal_invalid', 'Work under a task serves the goal of the task above it, so it names none of its own.');
  const goal = input.goalId ? await goalFor(ctx, companyId, spot, input.goalId) : null;
  if (input.responsiblePersonId) await requireAnswersFor(ctx, companyId, input.responsiblePersonId, spot);
  const responsiblePersonId = input.responsiblePersonId ?? parent?.responsiblePersonId ?? goal?.responsiblePersonId ?? (await placeOwner(ctx, companyId, spot));
  const pipeline = input.pipelineId ? await placeOnPipeline(ctx.db, companyId, spot, holderId, input.pipelineId, input.pipelineStageId) : { pipelineId: null, pipelineStageId: null };
  return { goalId: goal?.id ?? null, responsiblePersonId, why: input.why?.trim() ?? '', dueAt: input.dueAt ?? null, priority: input.priority ?? null, ...pipeline };
}
