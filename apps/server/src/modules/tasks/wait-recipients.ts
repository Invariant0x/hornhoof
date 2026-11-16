import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, departments } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { liveSubscription } from '../conversation/queue.js';

export async function waitOrchestrator(ctx: Ctx, companyId: string): Promise<string | null> {
  const [agent] = await ctx.db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.kind, 'orchestrator'), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  if (!agent) return null;
  return await liveSubscription(ctx, agent.id) ? agent.id : null;
}

/* Who looks into silence nothing explains: the head of the department, or of the department a product is in. Silence is no
   proof of a fault, so it never goes to Operations from here: they hear of faults the failure route confirmed. */
export async function quietRecipient(ctx: Ctx, companyId: string, departmentId: string): Promise<string | null> {
  const [place] = await ctx.db.select(only(departments, 'parentId')).from(departments).where(eq(departments.id, departmentId));
  const places = [departmentId, ...(place?.parentId ? [place.parentId] : [])];
  const heads = await ctx.db.select({ id: agents.id, departmentId: agents.departmentId }).from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.kind, 'head'), inArray(agents.departmentId, places), isNull(agents.removedAt), isNull(agents.switchedOffAt))).orderBy(asc(agents.createdAt));
  for (const id of places) {
    for (const head of heads.filter(h => h.departmentId === id)) if (await liveSubscription(ctx, head.id)) return head.id;
  }
  return waitOrchestrator(ctx, companyId);
}
