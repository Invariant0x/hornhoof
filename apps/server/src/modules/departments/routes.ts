import { DEPARTMENT_TEMPLATES, type TemplateKey } from '@hornhoof/protocol';
import { and, asc, eq, inArray, isNull, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requireCompanyScope, requirePerson } from '../../auth/session.js';
import { agentChanges, agents, companies, departments, proposals, teams } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { enqueueTurn, orchestratorOf, orchestratorState } from '../conversation/queue.js';
import { appendEvent } from '../events/store.js';
import { checkStaff, departmentOf, HireLine, runsTier, servingSubscriptions, spotIn } from '../tools/staff.js';
import { BuildItem, checkItems, isNew } from '../tools/structure.js';
import { deptName, TEMPLATE_TEXT } from './templates.js';

const IdParams = z.object({ id: z.uuid() });
const StaffBody = z.object({ proposalId: z.uuid().optional(), people: z.array(HireLine).min(1).max(30) });

const BuildBody = z.object({ proposalId: z.uuid().optional(), brief: z.string().trim().max(1500).optional(), items: z.array(BuildItem).min(1).max(20) });

type Created = { id: string; template: TemplateKey | null; name: string | null; products: string[] };
type Removed = { id: string; template: TemplateKey | null; name: string | null };

const roleOf = (key: TemplateKey) => DEPARTMENT_TEMPLATES.find(t => t.key === key)!.roleCode;

const listed = (d: { name: string | null; template: TemplateKey | null; products?: string[] }) => {
  const name = d.name ?? (d.template ? TEMPLATE_TEXT[d.template].name : '');
  return d.products?.length ? `${name} (products: ${d.products.join(', ')})` : name;
};

/* What he reads after the click, so he goes on from there. */
function builtNote(created: Created[], removed: Removed[]): string {
  const lines = ['Hornhoof applied the CEO\'s click.'];
  if (created.length) lines.push(`Created: ${created.map(listed).join('; ')}.`);
  if (removed.length) lines.push(`Removed: ${removed.map(listed).join('; ')}.`);
  lines.push('Continue in the CEO\'s language: say what is there now in a line or two, then offer to staff the new departments, one department at a time.');
  return lines.join('\n');
}

type Hired = { id: string; name: string; role: string; title: string };

/* What he reads after the CEO hired people, so he goes on from there. */
function staffedNote(department: string, hired: Hired[]): string {
  return [
    'Hornhoof applied the CEO\'s click.',
    `Hired in ${department}: ${hired.map(h => `${h.name} (${h.title})`).join(', ')}.`,
    'Continue in the CEO\'s language: say who is there now in a line or two. Their tasks come in a later version of Hornhoof; people can already write to them.',
  ].join('\n');
}

/* The CEO's click: the only way departments come and go in M3. */
export function departmentRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  app.post('/api/departments/build', async (req, reply) => {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    const body = BuildBody.parse(req.body);

    const result = await db.transaction(async tx => {
      let brief = body.brief;
      let agentId: string | null = null;
      if (body.proposalId) {
        const [taken] = await tx
          .update(proposals)
          .set({ status: 'applied', appliedBy: me.id, appliedAt: new Date() })
          .where(and(eq(proposals.id, body.proposalId), eq(proposals.companyId, me.companyId), eq(proposals.kind, 'structure'), eq(proposals.status, 'pending')))
          .returning({ brief: proposals.brief, agentId: proposals.agentId });
        if (!taken) throw new ApiError(409, 'conflict', 'This card was already applied or replaced by a newer one.', 'proposal_closed');
        brief ??= taken.brief;
        agentId = taken.agentId;
      }
      const problem = await checkItems(tx, me.companyId, body.items);
      if (problem) throw new ApiError(400, 'validation', problem, 'structure_invalid');

      const [last] = await tx.select({ n: max(departments.position) }).from(departments).where(eq(departments.companyId, me.companyId));
      let position = (last?.n ?? -1) + 1;
      /* created also lists a department that got products, with just the new ones; fresh holds the new top-level ids. */
      const created: Created[] = [];
      const removed: Removed[] = [];
      const fresh: string[] = [];
      const addProducts = async (parent: { id: string; roleCode: string }, names: string[]) => {
        for (const name of names) {
          await tx.insert(departments).values({ companyId: me.companyId, name, parentId: parent.id, roleCode: parent.roleCode, position: position++ });
        }
      };

      for (const item of body.items) {
        if (isNew(item)) {
          const [dept] = await tx
            .insert(departments)
            .values({ companyId: me.companyId, templateKey: item.template, name: item.name ?? null, roleCode: roleOf(item.template), about: item.note, position: position++ })
            .returning();
          await addProducts(dept!, item.products ?? []);
          created.push({ id: dept!.id, template: item.template, name: dept!.name, products: item.products ?? [] });
          fresh.push(dept!.id);
          continue;
        }
        const [dept] = await tx.select().from(departments).where(eq(departments.id, item.department));
        if (!dept) continue;
        if (item.remove) {
          const inside = [dept.id, ...(await tx.select({ id: departments.id }).from(departments).where(eq(departments.parentId, dept.id))).map(d => d.id)];
          await tx.delete(teams).where(inArray(teams.departmentId, inside));
          await tx.delete(departments).where(eq(departments.parentId, dept.id));
          await tx.delete(departments).where(eq(departments.id, dept.id));
          removed.push({ id: dept.id, template: dept.templateKey, name: dept.name });
          continue;
        }
        if (item.products?.length) {
          await addProducts(dept, item.products);
          created.push({ id: dept.id, template: dept.templateKey, name: dept.name, products: item.products });
        }
      }
      if (brief) await tx.update(companies).set({ brief }).where(eq(companies.id, me.companyId));
      return { created, removed, fresh, agentId };
    });

    const orchestrator = await orchestratorOf(ctx, me.companyId);
    const agentId = result.agentId ?? orchestrator?.id;
    if (agentId) {
      await appendEvent(ctx, {
        companyId: me.companyId,
        agentId,
        kind: 'applied',
        data: { proposalId: body.proposalId ?? null, created: result.created, removed: result.removed },
        personId: me.id,
      });
    }
    ctx.bus.publish(me.companyId, { type: 'org' });
    for (const id of result.fresh) ctx.bus.publish(me.companyId, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id } });
    if (agentId && (await orchestratorState(ctx, me.companyId)).ready) {
      await enqueueTurn(ctx, { companyId: me.companyId, agentId, prompt: builtNote(result.created, result.removed), createdBy: null });
    }
    reply.code(201);
    return { created: result.fresh, removed: result.removed.map(r => r.id) };
  });

  /* The default roster for the card by hand: one line per default role, a perProduct role once per product, on the first
     subscription that serves the department and runs the role's tier, with the program's Default model. */
  app.get('/api/departments/:id/roster', async req => {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    const dept = await departmentOf(db, me.companyId, IdParams.parse(req.params).id);
    if (!dept) throw new ApiError(404, 'not_found', 'This department does not exist.', 'department_unknown');
    const products = await db.select().from(departments).where(eq(departments.parentId, dept.id)).orderBy(asc(departments.position));
    const serving = await servingSubscriptions(ctx, me.companyId, spotIn(dept));
    const people: HireLine[] = [];
    for (const role of dept.templateKey ? ctx.templates.roster(dept.templateKey).filter(r => r.inDefault) : []) {
      const line = { role: role.id, model: '', subscription: serving.find(s => runsTier(s.provider, role.tier))?.id ?? null, skills: role.skills.filter(s => s.on).map(s => s.id) };
      if (role.perProduct && products.length) for (const p of products) people.push({ ...line, name: `${role.title.en} (${deptName(p)})`, product: p.id });
      else people.push({ ...line, name: role.title.en, product: null });
    }
    return { people };
  });

  /* The CEO's click on a staff card: the only way employees are hired. */
  app.post('/api/departments/:id/staff', async (req, reply) => {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    const dept = await departmentOf(db, me.companyId, IdParams.parse(req.params).id);
    if (!dept) throw new ApiError(404, 'not_found', 'This department does not exist.', 'department_unknown');
    const body = StaffBody.parse(req.body);
    const invalid = (message: string) => new ApiError(400, 'validation', message, 'staff_invalid');

    const result = await db.transaction(async tx => {
      let agentId: string | null = null;
      if (body.proposalId) {
        const [taken] = await tx
          .update(proposals)
          .set({ status: 'applied', appliedBy: me.id, appliedAt: new Date() })
          .where(and(eq(proposals.id, body.proposalId), eq(proposals.companyId, me.companyId), eq(proposals.kind, 'staff'), eq(proposals.departmentId, dept.id), eq(proposals.status, 'pending')))
          .returning({ agentId: proposals.agentId });
        if (!taken) throw new ApiError(409, 'conflict', 'This card was already applied or replaced by a newer one.', 'proposal_closed');
        agentId = taken.agentId;
      }
      const problem = await checkStaff({ db: tx, templates: ctx.templates }, me.companyId, dept, body.people);
      if (problem) throw invalid(problem);
      const heads = body.people.filter(l => ctx.templates.roles.get(l.role)!.kind === 'head');
      if (heads.length > 1) throw invalid(`${deptName(dept)} can have one head; the card has ${heads.length}.`);
      if (heads.length) {
        const [head] = await tx.select({ name: agents.name }).from(agents).where(and(eq(agents.departmentId, dept.id), eq(agents.kind, 'head'), isNull(agents.removedAt)));
        if (head) throw invalid(`${deptName(dept)} already has a head, ${head.name}.`);
      }

      const hired: Hired[] = [];
      for (const line of body.people) {
        const role = ctx.templates.roles.get(line.role)!;
        const hashes = Object.fromEntries([[role.id, role.hash], ...line.skills.map(id => [id, ctx.templates.skills.get(id)!.hash])]);
        const [agent] = await tx
          .insert(agents)
          .values({
            companyId: me.companyId,
            kind: role.kind === 'head' ? 'head' : 'worker',
            name: line.name,
            model: line.model,
            departmentId: dept.id,
            productId: line.product ?? null,
            subscriptionId: line.subscription,
            roleKey: role.id,
            skills: line.skills,
            templateHashes: hashes,
            createdBy: me.id,
          })
          .returning({ id: agents.id });
        await tx.insert(agentChanges).values({ companyId: me.companyId, agentId: agent!.id, personId: me.id, field: 'hired', before: null, after: line });
        hired.push({ id: agent!.id, name: line.name, role: role.id, title: role.title.en });
      }
      return { hired, agentId };
    });

    const orchestrator = await orchestratorOf(ctx, me.companyId);
    const agentId = result.agentId ?? orchestrator?.id;
    if (agentId) {
      await appendEvent(ctx, {
        companyId: me.companyId,
        agentId,
        kind: 'applied',
        data: { proposalId: body.proposalId ?? null, kind: 'staff', department: dept.id, hired: result.hired.map(({ id, name, role }) => ({ id, name, role })) },
        personId: me.id,
      });
    }
    ctx.bus.publish(me.companyId, { type: 'org' });
    ctx.bus.publish(me.companyId, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: dept.id } });
    if (agentId && (await orchestratorState(ctx, me.companyId)).ready) {
      await enqueueTurn(ctx, { companyId: me.companyId, agentId, prompt: staffedNote(deptName(dept), result.hired), createdBy: null });
    }
    reply.code(201);
    return { hired: result.hired.map(h => h.id) };
  });
}
