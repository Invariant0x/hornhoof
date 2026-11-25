import { eq } from 'drizzle-orm';
import type { Db } from '../src/db/client.js';
import { attachments, tasks } from '../src/db/schema.js';
import { stored } from './files-fixture.js';

/* A file on the task that a hand-in of work that is not code names as the place of its result (#1942). */
export async function attached(db: Db, task: { id: string; companyId: string }, agentId: string, name: string): Promise<{ file: string }> {
  await db.insert(attachments).values({ companyId: task.companyId, taskId: task.id, agentId, name, mediaType: 'text/plain', sha256: await stored(db, Buffer.from(name)), size: name.length });
  return { file: name };
}

/* Where the result of a task of a department that keeps a repository is recorded. */
export const RECORDED = { path: 'reports/result.md' };

/* A hand-in of work that is not code, by task id: a file the agent attaches to the task and names as where the result is. */
export async function recorded(ctx: { db: Db }, taskId: string, agentId: string): Promise<{ recorded: { file: string } }> {
  const [task] = await ctx.db.select({ id: tasks.id, companyId: tasks.companyId }).from(tasks).where(eq(tasks.id, taskId));
  return { recorded: await attached(ctx.db, task!, agentId, 'result.md') };
}
