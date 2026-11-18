/* What the tests of operations-required-existing.test.ts start from, also the ones that take a database of their own. */
import { inArray, type SQL } from 'drizzle-orm';
import type { Db } from '../src/db/client.js';
import { departments, turns } from '../src/db/schema.js';
import { idOnly } from '../src/db/selections.js';

/* Every department has its open turn, which ends before the department goes, as when the structure removes one. */
export async function removeDepartments(db: Db, where: SQL): Promise<void> {
  await db.update(turns).set({ status: 'closed', closedAt: new Date() }).where(inArray(turns.departmentId, db.select(idOnly(departments)).from(departments).where(where)));
  await db.delete(departments).where(where);
}
