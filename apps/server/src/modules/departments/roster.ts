import type { CompanyTemplateStaff } from '@hornhoof/protocol';
import { asc, eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { departments, teams } from '../../db/schema.js';
import { modelOnPlan } from '../agents/role-model.js';
import type { Tx } from '../tasks/state.js';
import type { Role, TeamTemplate } from '../templates/load.js';
import { runsTier, servingSubscriptions, spotIn, type HireLine } from '../tools/staff.js';
import { deptName } from './templates.js';

type Dept = typeof departments.$inferSelect;
type Plan = Awaited<ReturnType<typeof servingSubscriptions>>[number];

/* The plan a role starts on: the first one serving the department that runs the role's tier, or none yet. */
export const planFor = (serving: readonly Plan[], role: Pick<Role, 'tier'>): Plan | undefined => serving.find(s => runsTier(s.provider, role.tier));

/* The template's default roles, plus any roles needed for the build. A role kept per product comes once for each product.
   Each employee takes the first plan that runs its tier, or waits for one. */
export async function templateRoster(ctx: Pick<Ctx, 'db' | 'templates'>, dept: Dept, serving: readonly Plan[], extraRoles?: ReadonlySet<string>): Promise<HireLine[]> {
  const products = await ctx.db.select().from(departments).where(eq(departments.parentId, dept.id)).orderBy(asc(departments.position));
  const people: HireLine[] = [];
  for (const role of dept.templateKey ? ctx.templates.roster(dept.templateKey).filter(r => r.inDefault || extraRoles?.has(r.id)) : []) {
    const plan = planFor(serving, role);
    const line = { role: role.id, model: plan ? modelOnPlan(role.tier, plan) : '', subscription: plan?.id ?? null, skills: role.skills.filter(s => s.on).map(s => s.id) };
    if (role.perProduct && products.length) for (const p of products) people.push({ ...line, name: `${role.title.en} (${deptName(p)})`, product: p.id });
    else people.push({ ...line, name: role.title.en, product: null });
  }
  return people;
}

/* The members a team of a template starts with, for the sub-unit made for it: each on the first plan that runs the
   strongest model, which a turnkey team asks for, or waiting for one, with the skills of its role and those the team
   adds. Several of one role are numbered. */
function teamRoster(ctx: Pick<Ctx, 'templates'>, team: TeamTemplate, teamId: string, serving: readonly Plan[]): HireLine[] {
  return team.members.flatMap(({ role: id, count }) => {
    const role = ctx.templates.roles.get(id)!;
    const tier = team.turnkey ? 'top' : role.tier;
    const plan = planFor(serving, { tier });
    const skills = [...new Set([...role.skills.filter(s => s.on).map(s => s.id), ...team.skills])];
    const line = { role: role.id, team: teamId, product: null, model: plan ? modelOnPlan(tier, plan) : '', subscription: plan?.id ?? null, skills };
    return Array.from({ length: count }, (_, i) => ({ ...line, name: `${role.title.en}${count > 1 ? ` ${i + 1}` : ''} (${team.title.en})` }));
  });
}

/* The teams of a department's template, made as its sub-units, and the members each starts with. */
export async function templateTeams(ctx: Pick<Ctx, 'templates'>, tx: Tx, dept: Dept, serving: readonly Plan[]): Promise<HireLine[]> {
  const lines: HireLine[] = [];
  for (const team of dept.templateKey ? ctx.templates.teamsOf(dept.templateKey) : []) {
    const [made] = await tx.insert(teams).values({ companyId: dept.companyId, departmentId: dept.id, name: team.title.en, about: team.description.en, turnkey: team.turnkey, urgentOnly: team.urgentOnly }).returning({ id: teams.id });
    lines.push(...teamRoster(ctx, team, made!.id, serving));
  }
  return lines;
}

/* The people a product added to a department starts with: one of each default role its template keeps per product, as a
   department made with its people has for each of its products. */
export function productRoster(ctx: Pick<Ctx, 'templates'>, dept: Dept, product: Dept, serving: readonly Plan[]): HireLine[] {
  return (dept.templateKey ? ctx.templates.roster(dept.templateKey).filter(r => r.inDefault && r.perProduct) : []).map(role => {
    const plan = planFor(serving, role);
    return { role: role.id, name: `${role.title.en} (${deptName(product)})`, product: product.id, model: plan ? modelOnPlan(role.tier, plan) : '', subscription: plan?.id ?? null, skills: role.skills.filter(s => s.on).map(s => s.id) };
  });
}

/* The people a ready-made company starts a department with: as many of each role as the company's template says, with the
   role's skills, each on the first plan that may serve the department and runs the role's tier, or waiting for one.
   Several of one role are numbered. */
export function companyRoster(ctx: Pick<Ctx, 'templates'>, staff: readonly CompanyTemplateStaff[], serving: readonly Plan[]): HireLine[] {
  return staff.flatMap(({ role: id, count }) => {
    const role = ctx.templates.roles.get(id)!;
    const plan = planFor(serving, role);
    const line = { role: role.id, product: null, model: plan ? modelOnPlan(role.tier, plan) : '', subscription: plan?.id ?? null, skills: role.skills.filter(s => s.on).map(s => s.id) };
    return Array.from({ length: count }, (_, i) => ({ ...line, name: `${role.title.en}${count > 1 ? ` ${i + 1}` : ''}` }));
  });
}

/* A department built with staff also hires the positions that hold its pipeline stages. */
export async function rosterOf(ctx: Pick<Ctx, 'db' | 'templates'>, companyId: string, dept: Dept): Promise<HireLine[]> {
  const catalog = dept.templateKey ? ctx.templates.catalogs.get(dept.templateKey) : undefined;
  const owners = new Set(catalog?.pipelines.flatMap(p => p.stages.map(s => s.ownerRole)));
  return templateRoster(ctx, dept, await servingSubscriptions(ctx, companyId, spotIn(dept)), owners);
}
