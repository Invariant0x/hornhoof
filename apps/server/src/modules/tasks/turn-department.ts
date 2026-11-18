import { and, eq, isNull, or, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { departments, tasks, turns } from '../../db/schema.js';
import type { Tx } from './engine.js';
import { lastTurnNumber } from './numbers.js';

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

/* The work of a department's open turn: the results accepted into it and the work going on that is in no turn yet, as
   every task joins the open turn only as its result is accepted. */
export const workOfOpenTurn = (turnId: string): SQL => or(eq(tasks.turnId, turnId), isNull(tasks.turnId))!;

/* Whether a top-level department releases what it makes: one that keeps a repository does, through its turns. One without
   has nothing to release, and its work stays outside every turn. */
export const releasesWork = (department: Pick<Department, 'parentId' | 'repoUrl'> | null | undefined): boolean => !!department && !department.parentId && !!department.repoUrl;

/* The open turn of a top-level department that releases its work, opened with the next number of the company when it has
   none, so it always has a release ready. A department that keeps no repository gets none: no tag could ever end it. Under
   the company row, as every turn number is given. */
export async function ensureOpenTurn(tx: Tx, companyId: string, departmentId: string, from: Pick<typeof turns.$inferInsert, 'baseVersion' | 'baseCommit' | 'startCommit'> = {}): Promise<typeof turns.$inferSelect | null> {
  const [open] = await tx.select().from(turns).where(and(eq(turns.companyId, companyId), eq(turns.departmentId, departmentId), eq(turns.status, 'open')));
  if (open) return open;
  const [department] = await tx.select().from(departments).where(and(eq(departments.id, departmentId), eq(departments.companyId, companyId)));
  if (!releasesWork(department)) return null;
  const number = (await lastTurnNumber(tx, companyId)) + 1;
  const [opened] = await tx.insert(turns).values({ companyId, departmentId, number, goal: 'The next release.', status: 'open', openedAt: new Date(), ...from }).returning();
  return opened!;
}
