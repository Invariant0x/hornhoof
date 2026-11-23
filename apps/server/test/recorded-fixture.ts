import type { Db } from '../src/db/client.js';
import { attachments } from '../src/db/schema.js';

/* A file on the task that a hand-in of work that is not code names as the place of its result (#1942). */
export async function attached(db: Db, task: { id: string; companyId: string }, agentId: string, name: string): Promise<{ file: string }> {
  await db.insert(attachments).values({ companyId: task.companyId, taskId: task.id, agentId, name, mediaType: 'text/plain', bytes: Buffer.from(name), size: name.length });
  return { file: name };
}

/* Where the result of a task of a department that keeps a repository is recorded. */
export const RECORDED = { path: 'reports/result.md' };
