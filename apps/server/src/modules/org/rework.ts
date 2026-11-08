import { REWORK_MS } from '@hornhoof/protocol/map';
import { and, eq, gt, max, sql } from 'drizzle-orm';
import { canReach, type Access } from '../../auth/access.js';
import type { Db } from '../../db/client.js';
import { taskEvents, tasks } from '../../db/schema.js';

/* Repairs are produced by the current checker in the same candidate chain. */
export async function reworkTimes(db: Db, companyId: string, now: Date, reach: Access): Promise<Map<string, string>> {
  const rows = await db.select({ departmentId: tasks.departmentId, productId: tasks.productId, at: max(taskEvents.createdAt) })
    .from(taskEvents).innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
    .where(and(eq(taskEvents.companyId, companyId), gt(taskEvents.createdAt, new Date(now.getTime() - REWORK_MS)),
      eq(taskEvents.kind, 'submitted'), sql`${taskEvents.data}->'candidate'->>'parentId' IS NOT NULL`))
    .groupBy(tasks.departmentId, tasks.productId);
  const times = new Map<string, string>();
  for (const row of rows) {
    if (!row.departmentId || !row.at || !canReach(reach, { departmentId: row.productId ?? row.departmentId, parentId: row.departmentId })) continue;
    const at = new Date(row.at).toISOString();
    if (at > (times.get(row.departmentId) ?? '')) times.set(row.departmentId, at);
  }
  return times;
}
