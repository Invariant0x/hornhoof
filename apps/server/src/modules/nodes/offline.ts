import { and, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { machines, nodes } from '../../db/schema.js';
import { nodeIdentity } from './hub.js';
import { liveNode } from './nodes.js';

/* The machine a plan was heard from last while none of its machines is online, and when it last spoke: none if it never did. */
export type OfflineMachine = { hostname: string; since: string | null };

/* What a card of the plan's employee or of its task says while the plan cannot run: none while one machine of the plan is
   online, and none for a plan with no machine of its own, such as a key on the built-in node. */
export async function offlineMachine(ctx: Pick<Ctx, 'db' | 'hub'>, subscriptionId: string | null): Promise<OfflineMachine | null> {
  if (!subscriptionId) return null;
  const rows = await ctx.db
    .select({ id: nodes.id, hostname: machines.hostname, seen: nodes.lastSeenAt })
    .from(nodes)
    .innerJoin(machines, eq(machines.id, nodes.machineId))
    .where(and(eq(nodes.subscriptionId, subscriptionId), liveNode))
    .orderBy(sql`${nodes.lastSeenAt} desc nulls last`);
  const [last] = rows;
  if (!last || rows.some(r => ctx.hub.isOnline(nodeIdentity(r.id)))) return null;
  return { hostname: last.hostname, since: last.seen?.toISOString() ?? null };
}
