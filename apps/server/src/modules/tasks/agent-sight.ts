import { eq } from 'drizzle-orm';
import { agents } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { worksIn, type Reader } from '../departments/inside.js';
import type { Task } from './state.js';
import { taskDetail, type TaskDetail } from './views.js';

type Ctx = Parameters<typeof taskDetail>[0];

/* Which machine of the holder is offline goes to the holder itself and to the agents of its department. */
async function knowsMachineOf(db: Ctx['db'], reader: Reader, holderId: string | null): Promise<boolean> {
  if (!holderId || holderId === reader.id) return true;
  const [holder] = await db.select(only(agents, 'departmentId')).from(agents).where(eq(agents.id, holderId));
  return worksIn(db, reader, holder?.departmentId ?? null);
}

/* One task as an agent reads it with its tools. */
export async function agentTaskDetail(ctx: Ctx, reader: Reader, task: Task, sees: (t: Task) => boolean): Promise<TaskDetail> {
  const detail = await taskDetail(ctx, task, sees);
  return detail.assigneeOffline && !(await knowsMachineOf(ctx.db, reader, task.assigneeAgentId)) ? { ...detail, assigneeOffline: null } : detail;
}
