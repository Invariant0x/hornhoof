/* What the tests of operations-required-existing.test.ts start from, also the ones that take a database of their own. */
import { inArray, type SQL } from 'drizzle-orm';
import type { Db } from '../src/db/client.js';
import { departments, pipelines, pipelineStages, turns } from '../src/db/schema.js';
import { idOnly } from '../src/db/selections.js';

/* Every department has its open turn, which ends before the department goes, as when the structure removes one. */
export async function removeDepartments(db: Db, where: SQL): Promise<void> {
  const places = db.select(idOnly(departments)).from(departments).where(where);
  const inPlaces = inArray(pipelines.departmentId, places);
  await db.delete(pipelineStages).where(inArray(pipelineStages.pipelineId, db.select(idOnly(pipelines)).from(pipelines).where(inPlaces)));
  await db.delete(pipelines).where(inPlaces);
  await db.update(turns).set({ status: 'closed', closedAt: new Date() }).where(inArray(turns.departmentId, places));
  await db.delete(departments).where(where);
}
