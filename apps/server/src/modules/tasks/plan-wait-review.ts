import { and, eq, gt, inArray, isNotNull, isNull, notExists, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agentFallbacks, agents, requests, tasks } from '../../db/schema.js';
import { openPersonRequests } from './decisions.js';

/* Old work records carry a reason in prose. Make them visible for review when the holder changes plan, including when
   the record was made after the switch. Changing a plan grants no permission to clear an unclassified instruction. */
export function fallbackWaitReviews(db: Db, companyId: string, filter: { since?: Date | null; holders?: string[] }, now: Date) {
  const until = sql<string>`${tasks.externalWait}->>'until'`;
  const due = sql`${tasks.externalWait}->'planAccess' IS NOT NULL AND ${until} <= ${now.toISOString()}`;
  return db.select({ taskId: tasks.id, primary: agentFallbacks.homeSubscriptionId, active: agents.subscriptionId, since: agentFallbacks.createdAt })
    .from(tasks).innerJoin(agents, and(eq(agents.id, tasks.assigneeAgentId), eq(agents.companyId, tasks.companyId)))
    .leftJoin(agentFallbacks, and(eq(agentFallbacks.agentId, agents.id), eq(agentFallbacks.companyId, tasks.companyId), eq(agentFallbacks.subscriptionId, agents.subscriptionId)))
    .where(and(eq(tasks.companyId, companyId), isNotNull(tasks.externalWait), isNull(tasks.paused), inArray(tasks.status, ['open', 'working', 'review']),
      isNull(agents.removedAt), isNull(agents.switchedOffAt), sql`(${tasks.externalWait}->'on' IS NULL OR ${tasks.externalWait} #>> '{on,event}' = 'other') AND ${tasks.externalWait}->'run' IS NULL`,
      notExists(db.select({ id: requests.id }).from(requests).where(and(eq(requests.taskId, tasks.id), eq(requests.companyId, tasks.companyId), openPersonRequests()))),
      or(and(isNotNull(agentFallbacks.agentId), sql`${tasks.externalWait}->'planAccess' IS NULL`), due),
      filter.holders ? inArray(agents.id, filter.holders) : undefined,
      filter.since ? or(gt(agentFallbacks.createdAt, filter.since), sql`${tasks.externalWait}->>'since' > ${filter.since.toISOString()}`, and(due, sql`${until} > ${filter.since.toISOString()}`)) : undefined));
}
