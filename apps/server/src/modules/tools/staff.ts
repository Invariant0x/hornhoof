import { modelsFor, type ModelOption } from '@hornhoof/protocol';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf, canReach, type Spot } from '../../auth/access.js';
import type { Db } from '../../db/client.js';
import { agents, departments, people, subscriptions, SUBSCRIPTION_STATUSES, teams, type Provider, type ScopeKind } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { deptName } from '../departments/templates.js';
import { holderOf, isOperations, isRequiredRole, REQUIRED_OPERATIONS_ROLES } from '../operations/required.js';
import type { Role, Skill } from '../templates/load.js';

const Id = z.string().trim().min(1).max(80);
const Name = z.string().trim().min(1).max(60);
const SkillIds = z.array(Id).max(60);

/* One line of the orchestrator's staff card. Left out: the name is the role's title, the model is Default, the CEO picks
   the subscription, and the skills are the role's. */
export const StaffLine = z.object({
  role: Id,
  name: Name.optional(),
  product: z.uuid().optional(),
  team: z.uuid().optional(),
  model: z.string().max(80).optional(),
  subscription: z.uuid().optional(),
  skills: z.object({ on: SkillIds.default([]), off: SkillIds.default([]) }).optional(),
  checked: z.boolean(),
});
export type StaffLine = z.infer<typeof StaffLine>;

export const StaffProposal = z.object({ department: z.uuid(), brief: z.string().trim().max(1500), people: z.array(StaffLine).min(1).max(30) });
export type StaffProposal = z.infer<typeof StaffProposal>;

/* One employee to hire, as the card sends it: every choice made. model '' is the program's Default. */
export const HireLine = z.object({
  role: Id,
  name: Name,
  product: z.uuid().nullable().optional(),
  team: z.uuid().nullable().optional(),
  model: z.string().max(80),
  subscription: z.uuid().nullable(),
  skills: SkillIds,
});
export type HireLine = z.infer<typeof HireLine>;

/* A subscription or API key that may serve a department, with the models it can run. */
export type Serving = { id: string; provider: Provider; kind: 'personal' | 'api_key'; label: string; owner: string; models: ModelOption[] };

type Dept = typeof departments.$inferSelect;

/* Providers whose programs run a deep model, which a top role needs too; Kimi and GLM plans serve standard and fast roles. */
/* An API by the token runs in Claude Code or Codex too, with whichever models its connection was given. */
const DEEP: readonly Provider[] = ['claude', 'codex', 'antigravity', 'anthropic_api', 'openai_api', 'openrouter', 'custom_api'];
export const runsTier = (provider: Provider, tier: Role['tier']) => tier === 'standard' || tier === 'fast' || DEEP.includes(provider);

/* Where an employee of the department works: its product inside it, or the department itself. */
export const spotIn = (dept: Dept, productId?: string | null): Spot =>
  productId ? { departmentId: productId, parentId: dept.id } : { departmentId: dept.id, parentId: dept.parentId };

/* A top-level department of the company, or null. */
export async function departmentOf(db: Db, companyId: string, id: string): Promise<Dept | null> {
  const [dept] = await db.select().from(departments).where(and(eq(departments.id, id), eq(departments.companyId, companyId), isNull(departments.parentId)));
  return dept ?? null;
}

type Sub = typeof subscriptions.$inferSelect;
type Owner = { id: string; name: string; scopeKind: ScopeKind; status: string };

/* Ready, or waiting for a new login or for the first setup of their program. */
const CONNECTED = ['ready', 'needs_login', 'needs_setup'] as const;

/* Subscriptions in these states the test accepts, oldest first. */
async function connected(db: Db, companyId: string, accept: (sub: Sub, owner: Owner) => boolean | Promise<boolean>, statuses: readonly Sub['status'][] = CONNECTED): Promise<Serving[]> {
  const rows = await db
    .select({ sub: subscriptions, owner: { id: people.id, name: people.name, scopeKind: people.scopeKind, status: people.status } })
    .from(subscriptions)
    .innerJoin(people, eq(people.id, subscriptions.ownerPersonId))
    .where(and(eq(subscriptions.companyId, companyId), isNull(subscriptions.removedAt), inArray(subscriptions.status, [...statuses])))
    .orderBy(asc(subscriptions.createdAt), asc(subscriptions.id));
  const out: Serving[] = [];
  for (const { sub, owner } of rows) {
    if (sub.kind === 'personal' && owner.status === 'disabled') continue;
    if (!(await accept(sub, owner))) continue;
    out.push({ id: sub.id, provider: sub.provider, kind: sub.kind, label: sub.label, owner: owner.name, models: modelsFor(sub.provider, sub.models) });
  }
  return out;
}

/* Whether a subscription may serve the place: a personal plan of someone who reaches it, or an API key for it, the
   department holding it, or any department. */
async function servesPlace(db: Db, spot: Spot): Promise<(sub: Sub, owner: Owner) => Promise<boolean>> {
  const places = [spot.departmentId, spot.parentId].filter((id): id is string => Boolean(id));
  const teamIds = places.length ? (await db.select(idOnly(teams)).from(teams).where(inArray(teams.departmentId, places))).map(t => t.id) : [];
  return async (sub, owner) => {
    if (sub.kind === 'personal') return canReach(await accessOf(db, owner), spot);
    return sub.targetKind === 'any' || (sub.targetKind === 'department' && places.includes(sub.targetId ?? '')) || (sub.targetKind === 'team' && teamIds.includes(sub.targetId ?? ''));
  };
}

/* What a person or the orchestrator picks from for the place. */
export async function servingSubscriptions(ctx: Pick<Ctx, 'db'>, companyId: string, spot: Spot): Promise<Serving[]> {
  const { db } = ctx;
  const serves = await servesPlace(db, spot);
  const wide = new Set<string>();
  const serving = await connected(db, companyId, async (sub, owner) => {
    if (sub.targetKind === 'any') wide.add(sub.id);
    return serves(sub, owner);
  });
  /* Keys for any department come last, so a new employee starts on what was bought for its place when there is one. */
  return [...serving.filter(s => !wide.has(s.id)), ...serving.filter(s => wide.has(s.id))];
}

/* What Hornhoof may put an employee on by itself, oldest first: a plan still waiting for its machine counts, since the
   queue waits until it runs, and access stays as it is for anyone else. */
export async function placeableSubscriptions(ctx: Pick<Ctx, 'db'>, companyId: string, spot: Spot): Promise<Serving[]> {
  return connected(ctx.db, companyId, await servesPlace(ctx.db, spot), SUBSCRIPTION_STATUSES);
}

/* The orchestrator works for the whole company: a plan of someone who sees all of it, or a key not tied to a department. */
export const servesWholeCompany = (sub: Pick<Sub, 'kind' | 'targetKind'>, ownerScopeKind: ScopeKind | undefined) =>
  sub.kind === 'personal' ? ownerScopeKind === 'company' : sub.targetKind !== 'department' && sub.targetKind !== 'team';

export function orchestratorServing(ctx: Pick<Ctx, 'db'>, companyId: string): Promise<Serving[]> {
  return connected(ctx.db, companyId, (sub, owner) => servesWholeCompany(sub, owner.scopeKind));
}

/* What Hornhoof may put the orchestrator on by itself, oldest first, a plan still waiting for its machine too. */
export function placeableForOrchestrator(ctx: Pick<Ctx, 'db'>, companyId: string): Promise<Serving[]> {
  return connected(ctx.db, companyId, (sub, owner) => servesWholeCompany(sub, owner.scopeKind), SUBSCRIPTION_STATUSES);
}

type Line = { role: string; product?: string | null; team?: string | null; model?: string; subscription?: string | null; skills: { on: string[]; off: string[] } | string[] };

function checkLineTeam(role: Role, teamId: string | null | undefined, deptTeams: Set<string>, dept: Dept): string | null {
  if (!teamId) return null;
  if (role.kind === 'head') return 'A department head cannot be in a sub-unit.';
  if (!deptTeams.has(teamId)) return `There is no sub-unit with id ${teamId} in ${deptName(dept)}.`;
  return null;
}

function checkLockedSkills(role: Role, skills: Line['skills'], roleId: string): string | null {
  const { on, off } = Array.isArray(skills) ? { on: skills, off: [] } : skills;
  for (const s of role.skills.filter(x => x.locked)) {
    if (off.includes(s.id)) return `${s.id} is locked on for every ${role.kind === 'head' ? 'head' : 'employee'} and cannot be turned off.`;
    if (Array.isArray(skills) && !on.includes(s.id)) return `${roleId} must keep the locked skill ${s.id}.`;
  }
  return null;
}

function checkLineSkills(templates: Ctx['templates'], role: Role, skills: Line['skills'], roleId: string, teamProblem: string | null): string | null {
  if (teamProblem) return teamProblem;
  const { on, off } = Array.isArray(skills) ? { on: skills, off: [] } : skills;
  for (const id of [...on, ...off]) if (!templates.skills.has(id)) return `There is no skill ${id}.`;
  return checkLockedSkills(role, skills, roleId);
}

/* The tracker writes only in the agent's department. The other grants reach company resources. */
export const companySkill = (skill: Skill): boolean => skill.grants.some(grant => grant !== 'tracker');

/* A skill a line turns on beyond its role's own that grants company-wide tools. */
export function grantingSkillOn(templates: Ctx['templates'], lines: readonly Line[]): string | null {
  for (const line of lines) {
    const role = templates.roles.get(line.role);
    const on = Array.isArray(line.skills) ? line.skills : line.skills.on;
    const usual = new Set(role?.skills.filter(s => s.on).map(s => s.id) ?? []);
    const found = on.find(id => {
      const skill = templates.skills.get(id);
      return !usual.has(id) && skill && companySkill(skill);
    });
    if (found) return found;
  }
  return null;
}

/* What is wrong with these lines for the department, in plain English for the agent or the card to fix, or null. */
export async function checkStaff(ctx: Pick<Ctx, 'db' | 'templates'>, companyId: string, dept: Dept, lines: Line[]): Promise<string | null> {
  const { db, templates } = ctx;
  if (!dept.templateKey) return `${deptName(dept)} has no template, so Hornhoof has no roles for it.`;
  const products = new Set((await db.select(idOnly(departments)).from(departments).where(eq(departments.parentId, dept.id))).map(p => p.id));
  const deptTeams = new Set((await db.select(idOnly(teams)).from(teams).where(eq(teams.departmentId, dept.id))).map(t => t.id));
  const serving = new Map<string, Map<string, Serving>>();
  const servingAt = async (product: string | null) => {
    const key = product ?? '';
    if (!serving.has(key)) serving.set(key, new Map((await servingSubscriptions(ctx, companyId, spotIn(dept, product))).map(s => [s.id, s])));
    return serving.get(key)!;
  };

  for (const line of lines) {
    const role = templates.roles.get(line.role);
    if (!role || role.department !== dept.templateKey) return `${line.role} is not a role of ${deptName(dept)}. Call staffing_options to see its roster.`;
    if (line.product && !products.has(line.product)) return `There is no product with id ${line.product} in ${deptName(dept)}.`;
    const sub = line.subscription ? (await servingAt(line.product ?? null)).get(line.subscription) : undefined;
    if (line.subscription && !sub) return `The subscription ${line.subscription} cannot serve ${deptName(dept)}. Pick one from staffing_options.`;
    if (line.model) {
      if (!sub) return `${line.role}: a model needs a subscription to run on; leave the model out for Default.`;
      if (!sub.models.some(m => m.id === line.model)) return `${sub.label} cannot run the model ${line.model}. It runs: ${sub.models.map(m => m.id).join(', ') || 'only its Default'}.`;
    }
    const skillProblem = checkLineSkills(templates, role, line.skills, line.role, checkLineTeam(role, line.team, deptTeams, dept));
    if (skillProblem) return skillProblem;
  }
  return null;
}

/* A card for Operations lists the roles it must have, ticked, whatever the agent sent. */
export function withRequiredRoles(dept: Dept, people: StaffLine[]): StaffLine[] {
  if (!isOperations(dept)) return people;
  const absent = REQUIRED_OPERATIONS_ROLES.filter(role => !people.some(line => line.role === role));
  return [...absent.map(role => ({ role, checked: true })), ...people.map(line => (isRequiredRole(line.role) ? { ...line, checked: true } : line))];
}

/* Whether a role is one Operations must have, and who holds it now: what a card shows beside the role. */
export async function requiredState(db: Db, dept: Dept): Promise<(role: string) => { required: boolean; holder: string | null }> {
  const staff = await db.select({ name: agents.name, kind: agents.kind, roleKey: agents.roleKey }).from(agents).where(and(eq(agents.departmentId, dept.id), isNull(agents.removedAt)));
  return role => ({ required: isRequiredRole(role), holder: holderOf(staff, role)?.name ?? null });
}

/* What the orchestrator reads before proposing a roster. */
export async function staffingOptions(ctx: Pick<Ctx, 'db' | 'templates'>, companyId: string, dept: Dept) {
  const products = await ctx.db.select().from(departments).where(eq(departments.parentId, dept.id)).orderBy(asc(departments.position));
  const employees = await ctx.db
    .select({ id: agents.id, name: agents.name, role: agents.roleKey, kind: agents.kind, product: agents.productId, model: agents.model })
    .from(agents)
    .where(and(eq(agents.departmentId, dept.id), isNull(agents.removedAt)));
  const state = await requiredState(ctx.db, dept);
  return {
    department: { id: dept.id, name: deptName(dept), products: products.map(p => ({ id: p.id, name: deptName(p) })), employees },
    roster: dept.templateKey
      ? ctx.templates.roster(dept.templateKey).map(r => ({ role: r.id, title: r.title.en, kind: r.kind, tier: r.tier, perProduct: r.perProduct, inDefault: r.inDefault, timer: r.timer, skills: r.skills, ...state(r.id) }))
      : [],
    subscriptions: (await servingSubscriptions(ctx, companyId, spotIn(dept))).map(({ id, provider, label, owner, models }) => ({ id, provider, label, owner, models })),
  };
}

/* The skills a hired employee starts with: the role's, with the line's changes. */
export function skillsFor(role: Role, line: StaffLine): string[] {
  const on = new Set(role.skills.filter(s => s.on).map(s => s.id));
  for (const id of line.skills?.on ?? []) on.add(id);
  for (const id of line.skills?.off ?? []) on.delete(id);
  return [...on];
}
