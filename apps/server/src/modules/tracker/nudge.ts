import { and, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { agents, departments } from '../../db/schema.js';
import type { Templates } from '../templates/load.js';

/* A round comes this long after the change that asks for it, so that many changes at once make one round. */
const AFTER_CHANGE_MINUTES = 5;
/* And never sooner than this after the last round. */
const BETWEEN_ROUNDS_MINUTES = 15;

/* The skills that let an employee keep the tracker. */
const trackerSkills = (templates: Templates): string[] => [...templates.skills.values()].filter(s => s.grants.includes('tracker')).map(s => s.id);

/* A task or goal of a department was made or changed status: the employees who keep its tracker, in it or its products,
   look soon. Their next round comes a few minutes on, never sooner than a while after their last round, and a round due
   sooner stays as it is. The one who made the change does not wake itself; one whose timer never ran keeps its first round. */
export async function nudgeTrackerKeepers(ctx: { db: Db } & Partial<Pick<Ctx, 'templates'>>, place: { companyId: string; departmentId: string | null }, except?: string | null): Promise<void> {
  if (!ctx.templates || !place.departmentId) return;
  const skills = trackerSkills(ctx.templates);
  if (!skills.length) return;
  const [dept] = await ctx.db.select({ top: sql<string>`coalesce(${departments.parentId}, ${departments.id})` }).from(departments).where(eq(departments.id, place.departmentId));
  if (!dept) return;
  const products = ctx.db.select({ id: departments.id }).from(departments).where(eq(departments.parentId, dept.top));
  const minutes = (n: SQL | number) => sql`make_interval(mins => ${n})`;
  const soon = sql`greatest(${agents.timerAt} + ${minutes(BETWEEN_ROUNDS_MINUTES)}, now() + ${minutes(AFTER_CHANGE_MINUTES)})`;
  await ctx.db
    .update(agents)
    .set({ timerNudgedAt: sql`least(coalesce(${agents.timerNudgedAt}, 'infinity'::timestamptz), ${soon})` })
    .where(
      and(
        eq(agents.companyId, place.companyId),
        or(eq(agents.departmentId, dept.top), inArray(agents.departmentId, products)),
        isNotNull(agents.timerAt),
        isNotNull(agents.timerMinutes),
        isNull(agents.removedAt),
        sql`${agents.skills} ?| array[${sql.join(skills.map(s => sql`${s}`), sql`, `)}]::text[]`,
        /* Only sooner than its own round would come anyway. */
        sql`${soon} < ${agents.timerAt} + ${minutes(sql`${agents.timerMinutes}`)}`,
        except ? ne(agents.id, except) : undefined,
      ),
    );
}
