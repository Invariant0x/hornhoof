import type { RunKind } from '@hornhoof/protocol';
import { only } from '../../db/selections.js';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { jobs, tasks, testRuns } from '../../db/schema.js';
import { onTask } from '../tasks/file-policy.js';
import { refuse, type Task } from '../tasks/state.js';
import { taskByRef } from '../tasks/lookup.js';
import type { RunJob } from '../tools/job.js';
export type Run = typeof testRuns.$inferSelect;

/* The files of a run on its task: each part's log, and what a part of work made. */
export const logName = (run: Pick<Run, 'kind' | 'number'>, part: number) => `${run.kind}-${run.number}-${part}.log`;

/* The task a run is for: the one named, else the one the turn is on. */
export async function taskFor(ctx: Ctx, job: RunJob, ref: number | string | undefined, kind: RunKind): Promise<Task> {
  if (ref === undefined) {
    const [turn] = await ctx.db.select(only(jobs, 'taskId')).from(jobs).where(eq(jobs.id, job.id));
    const [task] = turn?.taskId ? await ctx.db.select().from(tasks).where(eq(tasks.id, turn.taskId)) : [];
    if (!task) throw refuse(400, 'task_invalid', `This turn is on no task: name the task ${kind === 'work' ? 'the work is for' : 'whose branch to test'} with task.`);
    return task;
  }
  const task = await taskByRef(ctx, job.companyId, ref);
  if (!task || !onTask(job, task)) throw refuse(404, 'task_unknown', `There is no task ${ref} you work on.`);
  return task;
}
