import { REWORK_MS } from '@hornhoof/protocol/map';
import { and, eq, gt, max, or, sql } from 'drizzle-orm';
import { canReach, type Access } from '../../auth/access.js';
import type { Db } from '../../db/client.js';
import { taskEvents, tasks } from '../../db/schema.js';

/* The move that actually returns work, including when the last reviewer leaves. Older logs used the last verdict of a
   completed failed round. An unfinished panel has not increased bounces yet, even if one reviewer asked for changes. */
export async function reworkTimes(db: Db, companyId: string, now: Date, reach: Access): Promise<Map<string, string>> {
  const rows = await db.select({ departmentId: tasks.departmentId, productId: tasks.productId, at: max(taskEvents.createdAt) })
    .from(taskEvents).innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
    .where(and(eq(taskEvents.companyId, companyId), gt(taskEvents.createdAt, new Date(now.getTime() - REWORK_MS)),
      or(sql`${taskEvents.data}->>'rework' = 'true'`,
        and(eq(taskEvents.kind, 'verdict'), sql`(${taskEvents.data}->>'round')::integer < ${tasks.bounces}`))))
    .groupBy(tasks.departmentId, tasks.productId);
  const times = new Map<string, string>();
  for (const row of rows) {
    if (!row.departmentId || !row.at || !canReach(reach, { departmentId: row.productId ?? row.departmentId, parentId: row.departmentId })) continue;
    const at = new Date(row.at).toISOString();
    if (at > (times.get(row.departmentId) ?? '')) times.set(row.departmentId, at);
  }
  return times;
}
