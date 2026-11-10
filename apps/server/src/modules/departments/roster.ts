import { asc, eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { departments } from '../../db/schema.js';
import { modelOnPlan } from '../agents/role-model.js';
import type { Role } from '../templates/load.js';
import { runsTier, servingSubscriptions, spotIn, type HireLine } from '../tools/staff.js';
import { deptName } from './templates.js';

type Dept = typeof departments.$inferSelect;
type Plan = Awaited<ReturnType<typeof servingSubscriptions>>[number];

/* The plan a role starts on: the first one serving the department that runs the role's tier, or none yet. */
export const planFor = (serving: readonly Plan[], role: Pick<Role, 'tier'>): Plan | undefined => serving.find(s => runsTier(s.provider, role.tier));

/* The people a department's template starts it with: one of each default role, a role kept per product once for each
   product, each on the first plan that serves the department and runs the role's tier, with the model that tier asks for
   there. A role no plan serves yet comes without one, and its employee waits for it. */
export async function templateRoster(ctx: Pick<Ctx, 'db' | 'templates'>, dept: Dept, serving: readonly Plan[]): Promise<HireLine[]> {
  const products = await ctx.db.select().from(departments).where(eq(departments.parentId, dept.id)).orderBy(asc(departments.position));
  const people: HireLine[] = [];
  for (const role of dept.templateKey ? ctx.templates.roster(dept.templateKey).filter(r => r.inDefault) : []) {
    const plan = planFor(serving, role);
    const line = { role: role.id, model: plan ? modelOnPlan(role.tier, plan) : '', subscription: plan?.id ?? null, skills: role.skills.filter(s => s.on).map(s => s.id) };
    if (role.perProduct && products.length) for (const p of products) people.push({ ...line, name: `${role.title.en} (${deptName(p)})`, product: p.id });
    else people.push({ ...line, name: role.title.en, product: null });
  }
  return people;
}

/* The same for a department as the database holds it now. */
export const rosterOf = async (ctx: Pick<Ctx, 'db' | 'templates'>, companyId: string, dept: Dept): Promise<HireLine[]> =>
  templateRoster(ctx, dept, await servingSubscriptions(ctx, companyId, spotIn(dept)));
