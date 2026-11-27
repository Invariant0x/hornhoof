import { and, asc, eq, gt, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { departments, notebookNotes } from '../../db/schema.js';

/* A deletion changes a book too, even when its last remaining note is older. */
const changedSince = (since: Date | null) => since ? or(gt(notebookNotes.updatedAt, since), gt(notebookNotes.removedAt, since)) : undefined;

type Collector = { roleKey: string | null; companyId: string; departmentId: string | null };

async function isCollector(db: Db, agent: Collector): Promise<boolean> {
  if (agent.roleKey !== 'OPS-BUGS' || !agent.departmentId) return false;
  const [ops] = await db.select({ id: departments.id }).from(departments)
    .where(and(eq(departments.id, agent.departmentId), eq(departments.companyId, agent.companyId), eq(departments.templateKey, 'operations')));
  return Boolean(ops);
}

export async function hasNotebookChanges(db: Db, collector: Collector, since: Date | null): Promise<boolean> {
  if (!await isCollector(db, collector)) return false;
  const [any] = await db.select({ id: notebookNotes.id }).from(notebookNotes)
    .where(and(eq(notebookNotes.companyId, collector.companyId), changedSince(since))).limit(1);
  return Boolean(any);
}

/* Only the revisions are shared. Existing notebook permissions determine who can read and edit their contents. */
export async function notebookReviews(db: Db, collector: Collector, since: Date | null) {
  if (!await isCollector(db, collector)) return {};
  const revision = sql`max(greatest(${notebookNotes.updatedAt}, ${notebookNotes.removedAt}))`.mapWith(notebookNotes.updatedAt);
  const books = await db.select({ departmentId: notebookNotes.departmentId, revision }).from(notebookNotes)
    .where(and(eq(notebookNotes.companyId, collector.companyId), changedSince(since)))
    .groupBy(notebookNotes.departmentId).orderBy(asc(notebookNotes.departmentId));
  return { notebookReviews: books };
}
