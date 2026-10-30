import { DEPARTMENT_TEMPLATES, type TemplateKey } from '@hornhoof/protocol';
import { and, eq, inArray, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requireCompanyScope, requirePerson } from '../../auth/session.js';
import { companies, departments, proposals, teams } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { enqueueTurn, orchestratorOf, orchestratorState } from '../conversation/queue.js';
import { appendEvent } from '../events/store.js';
import { BuildItem, checkItems, isNew } from '../tools/structure.js';
import { TEMPLATE_TEXT } from './templates.js';

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
  lines.push('Continue in the CEO\'s language: say what is there now in a line or two. Hornhoof cannot put people or agents into departments yet; that comes in the next version, so do not offer to plan the staff.');
  return lines.join('\n');
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
          .where(and(eq(proposals.id, body.proposalId), eq(proposals.companyId, me.companyId), eq(proposals.status, 'pending')))
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
}
