import { and, desc, eq, sql } from 'drizzle-orm';
import { taskEvents } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { type Task, type Tx } from './state.js';
import { openTurnOf } from './turn-department.js';
/* A head decision belongs to its department until its next release, the open turn; it is an event, not a compatibility
   switch. */
export async function turnCleanupDefault(tx: Tx, task: Task): Promise<boolean> {
  const turnId = task.turnId ?? (await openTurnOf(tx, task.companyId, task.departmentId))?.id;
  if (!turnId) return false;
  const [event] = await tx.select(only(taskEvents, 'data')).from(taskEvents).where(and(eq(taskEvents.companyId, task.companyId), eq(taskEvents.kind, 'updated'), sql`${taskEvents.data}->'turnCleanup'->>'turnId' = ${turnId}`, sql`${taskEvents.data}->'turnCleanup'->>'departmentId' = ${task.departmentId}`)).orderBy(desc(taskEvents.id)).limit(1);
  return (event?.data.turnCleanup as { enabled?: boolean } | undefined)?.enabled === true;
}
