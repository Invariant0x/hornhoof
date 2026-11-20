import { note, published } from './events.js';
import { openAfter, type Live } from './state.js';
import { nudgeTrackerKeepers } from '../tracker/nudge.js';
import { and, eq, sql } from 'drizzle-orm';
import { jobs, tasks } from '../../db/schema.js';
import { workStartNote } from './turnkey.js';
/* A turn on a task went out: an open task is being worked on now. Turnkey work notes where the turn branch and main were then,
   which every start its holder names must hold. */
export async function startWork(ctx: Live, jobId: string): Promise<void> {
  const [job] = await ctx.db.select({ taskId: jobs.taskId, agentId: jobs.agentId }).from(jobs).where(eq(jobs.id, jobId));
  if (!job?.taskId || !job.agentId) return;
  /* One that still waits for what it comes after is not at work, whatever turn went out on it. */
  const [task] = await ctx.db.select({ id: tasks.id, companyId: tasks.companyId, productId: tasks.productId, departmentId: tasks.departmentId, status: tasks.status, assigneeAgentId: tasks.assigneeAgentId, after: tasks.after })
    .from(tasks).where(eq(tasks.id, job.taskId));
  if (!task || (await openAfter(ctx.db, task)).length) return;
  const start = await workStartNote(ctx, task, job.agentId);
  const row = await ctx.db.transaction(async tx => {
    const [started] = await tx
      .update(tasks)
      .set({ status: 'working', version: sql`${tasks.version} + 1`, updatedAt: new Date() })
      .where(and(eq(tasks.id, job.taskId!), eq(tasks.status, 'open'), eq(tasks.assigneeAgentId, job.agentId!)))
      .returning();
    if (started) await note(tx, started, { kind: 'status', actor: { agentId: job.agentId! }, data: { fromStatus: 'open', toStatus: 'working', ...start } });
    return started;
  });
  if (!row) return;
  published(ctx, row);
  await nudgeTrackerKeepers(ctx, row, job.agentId);
}
