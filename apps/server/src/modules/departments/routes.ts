import { DEPARTMENT_TEMPLATES, MAX_INSTRUCTIONS, type TemplateKey } from '@hornhoof/protocol';
import { and, asc, eq, inArray, isNotNull, isNull, max, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requireCompanyScope, requirePerson } from '../../auth/session.js';
import { agentChanges, agents, companies, departments, proposals, tasks, teams } from '../../db/schema.js';
import { encryptSecret } from '../../crypto/secrets.js';
import { Repo } from '@hornhoof/protocol';
import { ApiError } from '../../errors.js';
import { instructionsOf } from '../agents/instructions.js';
import { enqueueTurn, orchestratorOf, orchestratorState } from '../conversation/queue.js';
import { appendEvent } from '../events/store.js';
import { checkStaff, departmentOf, HireLine, runsTier, servingSubscriptions, spotIn } from '../tools/staff.js';
import { BuildItem, checkItems, isNew } from '../tools/structure.js';
import { authorOf } from './repository.js';
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
    'Continue in the CEO\'s language: say who is there now in a line or two. The department takes tasks now, through its head.',
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
          /* Removed employees and staff proposals keep their history without the department; a waiting proposal ends. */
          await tx
            .update(agents)
            .set({ departmentId: null, productId: null, teamId: null })
            .where(and(or(inArray(agents.departmentId, inside), inArray(agents.productId, inside)), isNotNull(agents.removedAt)));
          await tx.update(proposals).set({ status: 'dismissed' }).where(and(inArray(proposals.departmentId, inside), eq(proposals.status, 'pending')));
          await tx.update(proposals).set({ departmentId: null }).where(inArray(proposals.departmentId, inside));
          /* Finished tasks keep their log without the department. */
          await tx.update(tasks).set({ departmentId: null }).where(inArray(tasks.departmentId, inside));
          await tx.update(tasks).set({ productId: null }).where(inArray(tasks.productId, inside));
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
     subscription that serves the department and runs the role's tier, with the program's Default model. Every staff card
     picks from its roles, products and subscriptions. */
  /* The git repository the department's agents work in. Only the whole company sets it; the token never comes back. */
  const RepoBody = z.object({ url: z.string(), branch: z.string().default('main'), token: z.string().trim().max(500).optional(), author: z.unknown().optional() }).strict();
  const repoView = (d: typeof departments.$inferSelect) => (d.repoUrl ? { url: d.repoUrl, branch: d.repoBranch ?? 'main', tokenLast4: d.repoTokenLast4, author: authorOf(d) } : null);

  app.put('/api/departments/:id/repository', async req => {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    const { id } = IdParams.parse(req.params);
    const body = RepoBody.parse(req.body);
    const checked = Repo.pick({ url: true, branch: true, author: true }).safeParse({ url: body.url.trim(), branch: body.branch.trim(), author: body.author });
    if (!checked.success) throw new ApiError(400, 'validation', 'Use an https address, a plain branch name, and an author name on one line with a full email.', 'repo_invalid');
    const [dept] = await db.select().from(departments).where(and(eq(departments.id, id), eq(departments.companyId, me.companyId)));
    if (!dept) throw new ApiError(404, 'not_found', 'This department does not exist.', 'department_unknown');
    /* A new token replaces the saved one; without one the saved token stays, unless the address moves to another host. */
    const host = (url: string | null) => (url ? new URL(url).host : null);
    const token = body.token
      ? { repoTokenEnc: encryptSecret(body.token, ctx.config.secret), repoTokenLast4: body.token.slice(-4) }
      : host(dept.repoUrl) !== host(checked.data.url)
        ? { repoTokenEnc: null, repoTokenLast4: null }
        : {};
    /* Left out, the saved author stays; null takes it away. */
    const given = checked.data.author;
    const author = given === undefined ? {} : { repoAuthorName: given?.name ?? null, repoAuthorEmail: given?.email ?? null };
    const [row] = await db
      .update(departments)
      .set({ repoUrl: checked.data.url, repoBranch: checked.data.branch, ...token, ...author })
      .where(eq(departments.id, id))
      .returning();
    ctx.bus.publish(me.companyId, { type: 'org' });
    return { repository: repoView(row!) };
  });

  app.delete('/api/departments/:id/repository', async (req, reply) => {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    const { id } = IdParams.parse(req.params);
    await db
      .update(departments)
      .set({ repoUrl: null, repoBranch: null, repoTokenEnc: null, repoTokenLast4: null, repoAuthorName: null, repoAuthorEmail: null })
      .where(and(eq(departments.id, id), eq(departments.companyId, me.companyId)));
    ctx.bus.publish(me.companyId, { type: 'org' });
    return reply.code(204).send();
  });

  app.get('/api/departments/:id/roster', async req => {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    const dept = await departmentOf(db, me.companyId, IdParams.parse(req.params).id);
    if (!dept) throw new ApiError(404, 'not_found', 'This department does not exist.', 'department_unknown');
    const products = await db.select().from(departments).where(eq(departments.parentId, dept.id)).orderBy(asc(departments.position));
    const serving = await servingSubscriptions(ctx, me.companyId, spotIn(dept));
    const roles = (dept.templateKey ? ctx.templates.roster(dept.templateKey) : []).map(role => ({
      id: role.id,
      title: role.title,
      kind: role.kind,
      tier: role.tier,
      perProduct: role.perProduct,
      inDefault: role.inDefault,
      skills: role.skills.filter(s => s.on).map(s => s.id),
      subscription: serving.find(s => runsTier(s.provider, role.tier))?.id ?? null,
    }));
    const people: HireLine[] = [];
    for (const role of roles.filter(r => r.inDefault)) {
      const line = { role: role.id, model: '', subscription: role.subscription, skills: role.skills };
      if (role.perProduct && products.length) for (const p of products) people.push({ ...line, name: `${role.title.en} (${deptName(p)})`, product: p.id });
      else people.push({ ...line, name: role.title.en, product: null });
    }
    return { people, roles, products: products.map(p => ({ id: p.id, name: deptName(p) })), subscriptions: serving };
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
          .returning();
        /* A turn carries the instructions whole, so a hire whose skills make them too long would never run. */
        if ((await instructionsOf({ db: tx, templates: ctx.templates }, agent!)).text.length > MAX_INSTRUCTIONS) {
          throw new ApiError(400, 'validation', `${line.name}'s instructions would be longer than ${MAX_INSTRUCTIONS} characters. Turn some skills off.`, 'instructions_too_long');
        }
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
