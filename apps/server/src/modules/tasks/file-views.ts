import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { attachments, departments, type RequestOption } from '../../db/schema.js';
import { type Task } from './state.js';

/* The files on a task, the newest under each name, without their bytes. */
export async function filesOf(db: Db, taskId: string): Promise<{ id: string; name: string; size: number; agentId: string; personId: string | null; at: Date }[]> {
  const rows = await db
    .select({ id: attachments.id, name: attachments.name, size: attachments.size, agentId: attachments.agentId, personId: attachments.personId, at: attachments.createdAt })
    .from(attachments)
    .where(and(eq(attachments.taskId, taskId), isNull(attachments.operatorCaseId)))
    .orderBy(desc(attachments.createdAt));
  const newest = new Map<string, (typeof rows)[number] & { name: string }>();
  for (const r of rows) if (r.name !== null && !newest.has(r.name)) newest.set(r.name, { ...r, name: r.name });
  return [...newest.values()];
}

/* Where a commit of the task's repository can be seen: on GitHub, from the product's repository, else the department's. */
export async function commitUrl(db: Db, task: Pick<Task, 'departmentId' | 'productId'>, commit: string | null): Promise<string | null> {
  if (!commit) return null;
  const ids = [task.productId, task.departmentId].filter((x): x is string => Boolean(x));
  if (!ids.length) return null;
  const rows = await db.select({ id: departments.id, repoUrl: departments.repoUrl }).from(departments).where(inArray(departments.id, ids));
  const repo = ids.map(id => rows.find(r => r.id === id)?.repoUrl).find(Boolean);
  if (!repo) return null;
  const url = new URL(repo);
  if (url.host !== 'github.com') return null;
  return `https://github.com${url.pathname.replace(/\.git$/, '').replace(/\/$/, '')}/commit/${commit}`;
}

/* The pictures each request shows on its own, apart from those of its options, in the order they were sent. */
export async function picturesOf(db: Db, rows: { id: string; options: RequestOption[] }[]): Promise<Map<string, string[]>> {
  const ids = rows.map(r => r.id);
  const found = ids.length
    ? await db.select({ id: attachments.id, requestId: attachments.requestId }).from(attachments).where(and(inArray(attachments.requestId, ids), isNull(attachments.operatorCaseId))).orderBy(asc(attachments.createdAt))
    : [];
  return new Map(rows.map(r => [r.id, found.filter(a => a.requestId === r.id && !r.options.some(o => o.image === a.id)).map(a => a.id)]));
}
