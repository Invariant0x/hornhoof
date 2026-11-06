import { APPROVAL_CHANNELS, ApprovalChannel, ApprovalRule, kindKey, ruleOf } from '@hornhoof/protocol';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf, listsDepartment } from '../../auth/access.js';
import { actsAsCeo } from '../../auth/decisions.js';
import { requirePerson, type Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { approvalPolicies, departments, people, requests, tasks } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { candidates, departmentOwners } from '../tasks/decisions.js';

/* A department's owner and how its approvals go. The CEO names the owner; the owner, the CEO and the delegate set the rules.
   The rules belong to the department, so nothing here that changes the owner touches them. */

type DeptRow = typeof departments.$inferSelect;

const IdParams = z.object({ id: z.uuid() });
const RuleParams = z.object({ id: z.uuid(), channel: ApprovalChannel });
const OwnerBody = z.object({ personId: z.uuid().nullable() }).strict();

const NO_ACCESS = 'Only an active person with access to this department can own it. Give them access first.';
const ON_DEPARTMENT = 'A product has no owner or rules of its own: it goes by the department that holds it.';

export async function ownDepartment(db: Pick<Db, 'select'>, companyId: string, id: string): Promise<DeptRow> {
  const [dept] = await db.select().from(departments).where(and(eq(departments.id, id), eq(departments.companyId, companyId)));
  if (!dept) throw new ApiError(404, 'not_found', 'This department does not exist.', 'department_unknown');
  if (dept.parentId) throw new ApiError(400, 'validation', ON_DEPARTMENT, 'owner_on_department');
  return dept;
}

/* The rule of each channel, those nobody set asking every time. */
export async function departmentRules(db: Pick<Db, 'select'>, departmentId: string) {
  const rows = await db.select().from(approvalPolicies).where(eq(approvalPolicies.departmentId, departmentId));
  return APPROVAL_CHANNELS.map(channel => ({ channel, ...ruleOf(rows.find(r => r.channel === channel)) }));
}

/* The active person who owns the department now with their name; null means the CEO. */
export async function departmentOwner(ctx: Pick<Ctx, 'db'>, companyId: string, departmentId: string): Promise<{ id: string; name: string } | null> {
  const id = (await departmentOwners(ctx, companyId)).get(departmentId);
  if (!id) return null;
  const [person] = await ctx.db.select({ id: people.id, name: people.name }).from(people).where(eq(people.id, id));
  return person ?? null;
}

/* Whether a person approved this kind of work on this channel of the department before. A kind nobody approved stays new:
   neither a wait nor a refusal makes it known. */
export async function kindKnown(db: Pick<Db, 'select'>, companyId: string, departmentId: string, channel: ApprovalChannel, kind: string): Promise<boolean> {
  const [found] = await db
    .select({ id: requests.id })
    .from(requests)
    .innerJoin(tasks, eq(tasks.id, requests.taskId))
    .where(and(eq(requests.companyId, companyId), eq(requests.approvalChannel, channel), eq(requests.approvalKind, kindKey(kind)), eq(requests.status, 'approved'), eq(tasks.departmentId, departmentId)))
    .limit(1);
  return found !== undefined;
}

/* Who may be named: active people with access to the department, other than the CEO, whom no owner already means. */
async function ownerCandidates(ctx: Pick<Ctx, 'db'>, companyId: string, departmentId: string) {
  const able = (await candidates(ctx, companyId)).filter(p => p.status === 'active' && !p.isOwner && listsDepartment(p.access, departmentId)).map(p => p.id);
  const rows = await ctx.db.select({ id: people.id, name: people.name, title: people.title }).from(people).where(eq(people.companyId, companyId));
  return rows.filter(p => able.includes(p.id));
}

export const mayChangeRules = async (db: Pick<Db, 'select'>, me: Person, departmentId: string) => actsAsCeo(me) || (await accessOf(db, me)).owns?.has(departmentId) === true;

async function policyView(ctx: Pick<Ctx, 'db'>, me: Person, dept: DeptRow) {
  const canSetOwner = actsAsCeo(me);
  return {
    departmentId: dept.id,
    owner: await departmentOwner(ctx, me.companyId, dept.id),
    canSetOwner,
    canChangePolicy: await mayChangeRules(ctx.db, me, dept.id),
    candidates: canSetOwner ? await ownerCandidates(ctx, me.companyId, dept.id) : [],
    rules: await departmentRules(ctx.db, dept.id),
  };
}

/* The person to name as owner, or a refusal: active, of this company, with access to the department itself. The CEO is who
   no owner means already, so naming the CEO names nobody. */
async function ownerToName(ctx: Pick<Ctx, 'db'>, companyId: string, personId: string | null, departmentId: string): Promise<string | null> {
  if (!personId) return null;
  const person = (await candidates(ctx, companyId)).find(p => p.id === personId);
  if (!person || person.status !== 'active' || !listsDepartment(person.access, departmentId)) throw new ApiError(400, 'validation', NO_ACCESS, 'owner_no_access');
  return person.isOwner ? null : person.id;
}

const parseRule = (body: unknown): ApprovalRule => {
  const rule = ApprovalRule.safeParse(body);
  if (rule.success) return rule.data;
  throw new ApiError(400, 'validation', 'Choose one of the three ways. "Up to a limit" takes a limit of 0 or more, and only that way takes one.', 'policy_invalid');
};

export function approvalPolicyRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  const changed = (companyId: string, departmentId: string) => {
    ctx.bus.publish(companyId, { type: 'org' });
    ctx.bus.publish(companyId, { type: 'requests', spot: { departmentId } });
  };
  const logged = (req: FastifyRequest, me: Person, what: object) => req.log.info({ ...what, personId: me.id, viaAgent: me.via ?? null }, 'department approvals changed');

  app.put('/api/departments/:id/owner', async req => {
    const me = await requirePerson(req, db);
    if (!actsAsCeo(me)) throw new ApiError(403, 'forbidden', 'Only the CEO or the CEO delegate names who owns a department.', 'owner_ceo_only');
    const dept = await ownDepartment(db, me.companyId, IdParams.parse(req.params).id);
    const ownerPersonId = await ownerToName(ctx, me.companyId, OwnerBody.parse(req.body).personId, dept.id);
    await db.update(departments).set({ ownerPersonId }).where(eq(departments.id, dept.id));
    logged(req, me, { departmentId: dept.id, ownerPersonId });
    changed(me.companyId, dept.id);
    return { ownerPersonId };
  });

  app.get('/api/departments/:id/approval-policy', async req => {
    const me = await requirePerson(req, db);
    const dept = await ownDepartment(db, me.companyId, IdParams.parse(req.params).id);
    if (!listsDepartment(await accessOf(db, me), dept.id)) throw new ApiError(404, 'not_found', 'This department does not exist.', 'department_unknown');
    return policyView(ctx, me, dept);
  });

  app.put('/api/departments/:id/approval-policy/:channel', async req => {
    const me = await requirePerson(req, db);
    const { id, channel } = RuleParams.parse(req.params);
    const dept = await ownDepartment(db, me.companyId, id);
    if (!(await mayChangeRules(db, me, dept.id))) throw new ApiError(403, 'forbidden', 'Only this department\'s owner, the CEO or the CEO delegate changes how its approvals go.', 'policy_not_allowed');
    const rule = parseRule(req.body);
    const stored = { mode: rule.mode, limitAmount: rule.mode === 'within_limits' ? rule.limit : null, limitUnit: rule.mode === 'within_limits' ? (rule.unit ?? null) : null, updatedBy: me.id, updatedAt: new Date() };
    await db
      .insert(approvalPolicies)
      .values({ companyId: me.companyId, departmentId: dept.id, channel, ...stored })
      .onConflictDoUpdate({ target: [approvalPolicies.departmentId, approvalPolicies.channel], set: stored });
    logged(req, me, { departmentId: dept.id, channel, rule });
    changed(me.companyId, dept.id);
    return policyView(ctx, me, dept);
  });
}
