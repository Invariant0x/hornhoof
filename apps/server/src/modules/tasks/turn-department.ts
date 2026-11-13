import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { departments, turns } from '../../db/schema.js';

type Reader = Pick<Db, 'select'>;
type Department = typeof departments.$inferSelect;

/* The top-level department a place is in: a department itself, and a product or sub-department the department above it,
   however far up. None for a place that is gone. */
export async function topDepartment(db: Reader, departmentId: string | null | undefined): Promise<Department | null> {
  const seen = new Set<string>();
  for (let id = departmentId ?? null; id && !seen.has(id); ) {
    seen.add(id);
    const [row] = await db.select().from(departments).where(eq(departments.id, id));
    if (!row) return null;
    if (!row.parentId) return row;
    id = row.parentId;
  }
  return null;
}

/* The turn a place's department runs now: the open turn of its top-level department, if any. */
export async function openTurnOf(db: Reader, companyId: string, departmentId: string | null | undefined): Promise<typeof turns.$inferSelect | null> {
  const top = await topDepartment(db, departmentId);
  if (!top || top.companyId !== companyId) return null;
  const [turn] = await db.select().from(turns).where(and(eq(turns.companyId, companyId), eq(turns.departmentId, top.id), eq(turns.status, 'open')));
  return turn ?? null;
}
