import type { Notification } from '@hornhoof/protocol';
import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { tasks } from '../../db/schema.js';

export async function operatorNotification(ctx: Ctx, job: { companyId: string; taskId: string | null }, detail?: Notification['detail']): Promise<Notification> {
  const [task] = job.taskId ? await ctx.db.select({ id: tasks.id, number: tasks.number }).from(tasks).where(and(eq(tasks.id, job.taskId), eq(tasks.companyId, job.companyId))) : [];
  return { source: 'program_operator', tasks: task ? [task] : [], ...(detail ? { detail } : {}) };
}
