import { note, published } from './events.js';
import { openAfter, type Live } from './state.js';
import { only } from '../../db/selections.js';
import { nudgeTrackerKeepers } from '../tracker/nudge.js';
import { and, eq, sql } from 'drizzle-orm';
import { jobs, tasks } from '../../db/schema.js';
/* A turn on a task went out: an open task is being worked on now. */
export async function startWork(ctx: Live, jobId: string): Promise<void> {
  const [job] = await ctx.db.select({ taskId: jobs.taskId, agentId: jobs.agentId }).from(jobs).where(eq(jobs.id, jobId));
  if (!job?.taskId || !job.agentId) return;
  /* One that still waits for what it comes after is not at work, whatever turn went out on it. */
  const [task] = await ctx.db.select(only(tasks, 'after')).from(tasks).where(eq(tasks.id, job.taskId));
  if (!task || (await openAfter(ctx.db, task)).length) return;
  const row = await ctx.db.transaction(async tx => {
    const [started] = await tx
      .update(tasks)
      .set({ status: 'working', version: sql`${tasks.version} + 1`, updatedAt: new Date() })
      .where(and(eq(tasks.id, job.taskId!), eq(tasks.status, 'open'), eq(tasks.assigneeAgentId, job.agentId!)))
      .returning();
    if (started) await note(tx, started, { kind: 'status', actor: { agentId: job.agentId! }, data: { fromStatus: 'open', toStatus: 'working' } });
    return started;
  });
  if (!row) return;
  published(ctx, row);
  await nudgeTrackerKeepers(ctx, row, job.agentId);
}
