import { and, desc, eq, inArray } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Ctx } from '../../app.js';
import { agents, departments, improvements, IMPROVEMENT_STATUSES, people } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { deptName } from '../departments/templates.js';

export type ImprovementStatus = (typeof IMPROVEMENT_STATUSES)[number];
/* How many closed ones are listed; every one that waits or is in work is. */
const CLOSED_LISTED = 200;
const ACTIVE: readonly ImprovementStatus[] = ['open', 'taken'];

/* Improvements as people and the orchestrator read them, the latest changed first, each with who found it and where. */
export async function listImprovements(ctx: Pick<Ctx, 'db'>, companyId: string, statuses: readonly ImprovementStatus[] = IMPROVEMENT_STATUSES) {
  const read = (of: readonly ImprovementStatus[], limit?: number) => {
    const q = ctx.db
      .select({ i: improvements, agent: { id: agents.id, name: agents.name }, department: departments, decidedBy: people.name })
      .from(improvements)
      .innerJoin(agents, eq(agents.id, improvements.agentId))
      .leftJoin(departments, eq(departments.id, agents.departmentId))
      .leftJoin(people, eq(people.id, improvements.decidedBy))
      .where(and(eq(improvements.companyId, companyId), inArray(improvements.status, [...of])))
      .orderBy(desc(improvements.updatedAt));
    return limit ? q.limit(limit) : q;
  };
  const active = statuses.filter(s => ACTIVE.includes(s));
  const closed = statuses.filter(s => !ACTIVE.includes(s));
  const rows = [...(active.length ? await read(active) : []), ...(closed.length ? await read(closed, CLOSED_LISTED) : [])].sort((a, b) => b.i.updatedAt.getTime() - a.i.updatedAt.getTime());
  return rows.map(({ i, agent, department, decidedBy }) => ({
    id: i.id,
    title: i.title,
    text: i.text,
    seen: i.seen,
    status: i.status,
    result: i.result,
    at: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
    agent,
    department: department ? { id: department.id, name: deptName(department) } : null,
    decidedBy,
  }));
}

/* People who see the whole company hear that the list changed. */
export const improvementsChanged = (ctx: Pick<Ctx, 'bus'>, companyId: string) => ctx.bus.publish(companyId, { type: 'improvements', spot: { departmentId: null } });

/* Moves an improvement on from one of the statuses it may leave, as one statement, so two people cannot both take it. */
export async function moveImprovement(ctx: Pick<Ctx, 'db' | 'bus'>, companyId: string, id: string, from: ImprovementStatus, to: PgUpdateSetSource<typeof improvements>) {
  const [moved] = await ctx.db
    .update(improvements)
    .set({ ...to, updatedAt: new Date() })
    .where(and(eq(improvements.id, id), eq(improvements.companyId, companyId), eq(improvements.status, from)))
    .returning();
  if (!moved) {
    const [there] = await ctx.db.select({ status: improvements.status }).from(improvements).where(and(eq(improvements.id, id), eq(improvements.companyId, companyId)));
    if (!there) throw new ApiError(404, 'not_found', 'There is no such improvement.', 'improvement_unknown');
    throw new ApiError(409, 'conflict', `This improvement is ${there.status} already.`, 'improvement_decided');
  }
  improvementsChanged(ctx, companyId);
  return moved;
}
