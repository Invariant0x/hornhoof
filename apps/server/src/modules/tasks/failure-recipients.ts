import { and, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, departments } from '../../db/schema.js';
import { orchestratorOf } from '../conversation/turn-records.js';
export async function headOf(ctx: Ctx, agent: typeof agents.$inferSelect) {
  const [dept] = agent.departmentId ? await ctx.db.select().from(departments).where(eq(departments.id, agent.departmentId)) : [];
  const [head] = dept ? await ctx.db.select().from(agents).where(and(eq(agents.departmentId, dept.parentId ?? dept.id), eq(agents.kind, 'head'), isNull(agents.removedAt), isNull(agents.switchedOffAt))).limit(1) : [];
  return head && head.id !== agent.id ? head : orchestratorOf(ctx, agent.companyId);
}
