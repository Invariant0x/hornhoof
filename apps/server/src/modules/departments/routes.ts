import { seedCatalogPipelines } from '../tracker/pipelines.js';
import { idOnly, only } from '../../db/selections.js';
import { notificationMessage } from '../events/notifications.js';
import { DEPARTMENT_TEMPLATES, type TemplateKey } from '@hornhoof/protocol';
import { ensureOpenTurn } from '../tasks/turn-department.js';
import { and, asc, eq, inArray, isNotNull, isNull, max, ne, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf } from '../../auth/access.js';
import { ownsPlace, viewerOf } from '../../auth/agent-view.js';
import type { DecisionSubject } from '../../auth/decision-owner.js';
import { actsAsCeo, requireDecision } from '../../auth/decisions.js';
import { requireDepartmentChanger, runsDepartment } from '../../auth/departments.js';
import { actorOf, employeeChangedBy, personOf, requireCompanyScope, requirePerson, type Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { agentChanges, agents, companies, departments, goals, personAccess, pipelines, pipelineStages, proposals, subscriptions, tasks, teams, turns } from '../../db/schema.js';
import { encryptSecret } from '../../crypto/secrets.js';
import { Repo, repoFolder } from '@hornhoof/protocol';
import { ApiError } from '../../errors.js';
import { delegationOf, lockedFor, standingPrincipal, stillDecides, type Delegation } from '../conversation/decision-context.js';
import { enqueueTurn } from '../conversation/queue.js';
import { orchestratorState } from '../conversation/state.js';
import { orchestratorOf } from '../conversation/turn-records.js';
import { appendEvent } from '../events/store.js';
import type { Tx } from '../tasks/state.js';
import { backOn } from '../tasks/wake.js';
import { planFor, productRoster, rosterOf, templateRoster, templateTeams } from './roster.js';
import { checkStaff, departmentOf, grantingSkillOn, HireLine, requiredState, servingSubscriptions, spotIn } from '../tools/staff.js';
import { BuildItem, checkItems, inPlaces, isNew, type TeamChange } from '../tools/structure.js';
import { linesToHire, tryPlaceOperator, type Present } from '../operations/ensure.js';
import { approvalPolicyRoutes } from './approval-policy.js';
import { repoHostRoutes } from './repo-hosts.js';
import { waitPolicyRoutes } from './wait-policy-routes.js';
import { hireEmployee, type Hired } from './hire.js';
import { checkFolderFree, repoView } from './repository.js';
import { departmentBranches } from './branches.js';
import { coversEveryPart } from '../testruns/github-status.js';
import { deptName, TEMPLATE_TEXT } from './templates.js';
import { nextRevision } from '../tracker/revision.js';
import { slotCapOfNew } from '../tasks/slots.js';

const IdParams = z.object({ id: z.uuid() });
const TeamParams = z.object({ id: z.uuid(), teamId: z.uuid() });
const TeamBody = z.object({ name: z.string().trim().min(1).max(60) }).strict();
/* turnkey: each member does a task end to end alone, with no echelons; it holds for tasks given from then on. */
const TeamPatch = TeamBody.partial().extend({ urgentOnly: z.boolean().optional(), turnkey: z.boolean().optional() }).strict().refine(patch => patch.name !== undefined || patch.urgentOnly !== undefined || patch.turnkey !== undefined, { message: 'Say what changes.' });
export const StaffBody = z.object({ proposalId: z.uuid().optional(), people: z.array(HireLine).min(1).max(30) });

export const BuildBody = z.object({ proposalId: z.uuid().optional(), brief: z.string().trim().max(1500).optional(), items: z.array(BuildItem).min(1).max(20) });

export const RepoBody = z
  .object({
    url: z.string(),
    branch: z.string().default('main'),
    token: z.string().trim().max(500).optional(),
    author: z.unknown().optional(),
    /* The free memory, in GB, a machine needs to take a test run of it; null takes the default again. */
    testMemoryGb: z.number().int().min(1).max(512).nullable().optional(),
    /* The command that runs the whole test suite, as run_tests takes it; empty or null takes it away. */
    fullTestCommand: z.string().trim().max(4000).nullable().optional(),
    /* The release workflow, by the path of its file (a bare file name is taken to be in .github/workflows); empty or null takes it away. */
    releaseWorkflow: z.string().trim().max(250).nullable().optional(),
  })
  .strict();

/* Another repository of a department, under the name of the product it comes as: the end of its address unless given. */
export const RepositoryBody = RepoBody.extend({ name: z.string().trim().min(1).max(60).optional() });

/* What a repository's save says of its full test command: left out, the saved one stays. */
function fullCommandPatch(given: string | null | undefined): { repoFullTestCommand?: string | null } {
  if (given === undefined) return {};
  if (given && !coversEveryPart(given)) throw new ApiError(400, 'validation', 'A full test command that names its part with {part} says how many there are with {parts}.', 'repo_command_invalid');
  return { repoFullTestCommand: given || null };
}

const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;

/* What a repository's save says of its release workflow: left out, the saved one stays; empty or null takes it away. A person
   names it, never an agent's guess: it is the one workflow whose full run lets a release record. */
export function releaseWorkflowPatch(given: string | null | undefined): { repoReleaseWorkflow?: string | null } {
  if (given === undefined) return {};
  if (!given) return { repoReleaseWorkflow: null };
  const path = given.includes('/') ? given : `.github/workflows/${given}`;
  if (!WORKFLOW_PATH.test(path)) throw new ApiError(400, 'validation', 'Name the release workflow by the path of its file, as .github/workflows/release.yml.', 'repo_release_workflow_invalid');
  return { repoReleaseWorkflow: path };
}

type Created = { id: string; template: TemplateKey | null; name: string | null; products: string[] };
type Removed = { id: string; template: TemplateKey | null; name: string | null };

const roleOf = (key: TemplateKey) => DEPARTMENT_TEMPLATES.find(t => t.key === key)!.roleCode;

const listed = (d: { name: string | null; template: TemplateKey | null; products?: string[] }) => {
  const name = d.name ?? (d.template ? TEMPLATE_TEXT[d.template].name : '');
  return d.products?.length ? `${name} (products: ${d.products.join(', ')})` : name;
};

/* Whose click it was, as he reads it: the CEO's, or by name that of a person who runs these departments, or sees the whole
   company, without being the CEO. */
async function clickOf(db: Db, me: Person, changed: readonly { id: string; name: string | null; templateKey: TemplateKey | null }[]): Promise<string> {
  if (actsAsCeo(me)) return 'the CEO\'s click';
  const runs: string[] = [];
  for (const dept of changed) if (await runsDepartment(db, me, dept.id)) runs.push(deptName(dept));
  return `the click of ${me.name}${runs.length ? `, responsible for ${runs.join(', ')}` : ''}`;
}

/* What he reads after the click, so he goes on from there. */
function builtNote(click: string, created: Created[], removed: Removed[], hired: Hired[], waiting: string[]): string {
  const lines = [`Hornhoof applied ${click}.`];
  if (created.length) lines.push(`Created: ${created.map(listed).join('; ')}.`);
  if (removed.length) lines.push(`Removed: ${removed.map(listed).join('; ')}.`);
  if (hired.length) lines.push(`Hired with their departments, by the templates: ${hired.map(h => `${h.name} (${h.title})`).join(', ')}.`);
  if (waiting.length) lines.push(`No subscription serves these yet, so they wait for one: ${waiting.join(', ')}.`);
  lines.push(hired.length
    ? 'Continue in the CEO\'s language: say what is there now and who was hired in a line or two, then offer to staff the departments that came without people, one department at a time.'
    : 'Continue in the CEO\'s language: say what is there now in a line or two, then offer to staff the new departments, one department at a time.');
  return lines.join('\n');
}

/* What he reads after people were hired from the screen, so he goes on from there. */
function staffedNote(click: string, department: string, hired: Hired[], present: Present[]): string {
  return [
    `Hornhoof applied ${click}.`,
    hired.length ? `Hired in ${department}: ${hired.map(h => `${h.name} (${h.title})`).join(', ')}.` : `Nobody new in ${department}.`,
    ...(present.length ? [`Already there, so not hired again: ${present.map(p => p.name).join(', ')}.`] : []),
    'Continue in the CEO\'s language: say who is there now in a line or two. The department takes tasks now, through its head.',
  ].join('\n');
}

const CARD: DecisionSubject = { source: 'proposal' };

/* A structure change that only adds and removes products and changes sub-units of departments that are there, and leaves
   the company's brief, is a decision of those departments: a product's is the department's that holds it. Making or
   removing a department, or a card, is the CEO's. */
async function structureSubject(db: Db, companyId: string, body: z.infer<typeof BuildBody>): Promise<DecisionSubject> {
  if (body.proposalId || body.brief !== undefined) return CARD;
  const changed: string[] = [];
  for (const item of body.items) {
    if (isNew(item)) return CARD;
    const [dept] = await db.select(only(departments, 'parentId')).from(departments).where(and(eq(departments.id, item.department), eq(departments.companyId, companyId)));
    if (item.remove && !dept?.parentId) return CARD;
    changed.push(dept?.parentId ?? item.department);
  }
  return { source: 'proposal', departments: changed };
}

/* Checks that a sub-unit belongs to this department of this company before changing or removing it. */
async function requireDepartmentTeam(tx: Db | Tx, companyId: string, departmentId: string, teamId: string): Promise<void> {
  const [team] = await tx
    .select(idOnly(teams))
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.departmentId, departmentId), eq(teams.companyId, companyId)));
  if (!team) throw new ApiError(404, 'not_found', 'This sub-unit does not exist.', 'unknown_place');
}

/* Removes a sub-unit and moves its live employees back into the department's pipeline. */
export async function clearTeam(tx: Db | Tx, me: Person, departmentId: string, teamId: string): Promise<string[]> {
  await requireDepartmentTeam(tx, me.companyId, departmentId, teamId);
  const members = await tx
    .select(idOnly(agents))
    .from(agents)
    .where(and(eq(agents.departmentId, departmentId), eq(agents.teamId, teamId), isNull(agents.removedAt)));
  await tx.update(agents).set({ teamId: null }).where(and(eq(agents.departmentId, departmentId), eq(agents.teamId, teamId)));
  if (members.length) {
    await tx.insert(agentChanges).values(members.map(m => ({ companyId: me.companyId, agentId: m.id, ...employeeChangedBy(me), field: 'team' as const, before: teamId, after: null })));
  }
  await tx.delete(personAccess).where(eq(personAccess.teamId, teamId));
  await tx.update(subscriptions).set({ targetKind: 'department', targetId: departmentId }).where(and(eq(subscriptions.targetKind, 'team'), eq(subscriptions.targetId, teamId)));
  await tx.delete(teams).where(and(eq(teams.id, teamId), eq(teams.departmentId, departmentId), eq(teams.companyId, me.companyId)));
  return members.map(m => m.id);
}

/* Creates, renames and removes sub-units of a department in one structure change. */
export async function applyTeams(tx: Db | Tx, me: Person, departmentId: string, list: TeamChange[] = []): Promise<string[]> {
  const freed: string[] = [];
  for (const t of list) {
    if (typeof t === 'string') await tx.insert(teams).values({ companyId: me.companyId, departmentId, name: t });
    else if (t.remove) freed.push(...(await clearTeam(tx, me, departmentId, t.id)));
    else if (t.name) {
      await requireDepartmentTeam(tx, me.companyId, departmentId, t.id);
      await tx.update(teams).set({ name: t.name }).where(and(eq(teams.id, t.id), eq(teams.departmentId, departmentId), eq(teams.companyId, me.companyId)));
    }
  }
  return freed;
}

async function wakeFreed(ctx: Ctx, me: Person, freed: string[]): Promise<void> {
  for (const id of freed) await backOn(ctx, actorOf(me), id);
}

/* Sub-unit routes on a department: create, rename and delete a sub-unit outside the pipeline. */
function teamRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  const view = (t: typeof teams.$inferSelect) => ({ id: t.id, name: t.name, about: t.about, stage: t.stage, gate: t.gate, urgentOnly: t.urgentOnly, turnkey: t.turnkey });

  app.post('/api/departments/:id/teams', async (req, reply) => {
    const me = await requirePerson(req, db);
    const dept = await departmentOf(db, me.companyId, IdParams.parse(req.params).id);
    if (!dept) throw new ApiError(404, 'not_found', 'This department does not exist.', 'department_unknown');
    await requireDepartmentChanger(db, me, dept.id);
    const body = TeamBody.parse(req.body);
    const [team] = await db.insert(teams).values({ companyId: me.companyId, departmentId: dept.id, name: body.name }).returning();
    ctx.bus.publish(me.companyId, { type: 'org' });
    reply.code(201);
    return { team: view(team!) };
  });

  app.patch('/api/departments/:id/teams/:teamId', async req => {
    const me = await requirePerson(req, db);
    const { id, teamId } = TeamParams.parse(req.params);
    await requireDepartmentChanger(db, me, id);
    const body = TeamPatch.parse(req.body);
    const [team] = await db
      .update(teams)
      .set(body)
      .where(and(eq(teams.id, teamId), eq(teams.departmentId, id), eq(teams.companyId, me.companyId)))
      .returning();
    if (!team) throw new ApiError(404, 'not_found', 'This sub-unit does not exist.', 'unknown_place');
    ctx.bus.publish(me.companyId, { type: 'org' });
    return { team: view(team) };
  });

  app.delete('/api/departments/:id/teams/:teamId', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { id, teamId } = TeamParams.parse(req.params);
    await requireDepartmentChanger(db, me, id);
    const freed = await db.transaction(tx => clearTeam(tx, me, id, teamId));
    await wakeFreed(ctx, me, freed);
    ctx.bus.publish(me.companyId, { type: 'org' });
    return reply.code(204).send();
  });
}

/* Who holds a role is who an employee is: it goes with the full view and to the department's owner, as the employees do. */
async function stateSeen(db: Db, me: Person, dept: Parameters<typeof requiredState>[1]) {
  const held = await requiredState(db, dept);
  const viewer = await viewerOf(db, me);
  const whole = viewer.full || ownsPlace(viewer, { departmentId: dept.id, parentId: dept.parentId });
  return (role: string) => (whole ? held(role) : { ...held(role), holder: null });
}

/* Departments come and go here: the CEO's click on a structure card, or the orchestrator's build_structure. */
export function departmentRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  /* A card is the CEO's decision, with or without the card: the CEO's or the delegate's from their screen, or the
     orchestrator's or a head's for the last person who asked it, in that turn or an earlier one. A change inside a
     department is its owner's too. */
  async function cardDecision(me: Person, subject: DecisionSubject): Promise<Delegation | undefined> {
    const on = delegationOf(me);
    if (subject.source === 'proposal' && subject.departments) for (const id of subject.departments) await requireDepartmentChanger(db, me, id);
    else requireCompanyScope(me);
    requireDecision(subject, me, await accessOf(db, me), me.companyId);
    return on;
  }
  /* Who applied a card: the person, also when the orchestrator applied it for them. */
  const appliedBy = (me: Person, on: Delegation | undefined) => (on ? on.personId : personOf(me));
  const forWhom = (on: Delegation | undefined) => (on ? { onBehalfOfPersonId: on.personId, jobId: on.jobId, sourceSeq: on.sourceSeq } : {});
  /* The acting agent keeps its own decision; a person's card stays with its author, otherwise the orchestrator. */
  const appliedTo = (on: Delegation | undefined, proposalAgentId: string | null, orchestrator: { id: string } | null) => on?.agentId ?? proposalAgentId ?? orchestrator?.id;

  app.post('/api/departments/build', async (req, reply) => {
    const me = await requirePerson(req, db);
    /* Who may ask is checked before what was asked, so a body that does not parse is the CEO's card to refuse. */
    const asked = BuildBody.safeParse(req.body);
    const subject = asked.success ? await structureSubject(db, me.companyId, asked.data) : CARD;
    const on = await cardDecision(me, subject);
    const body = BuildBody.parse(req.body);
    /* Removing a whole department is for good and the CEO's own; an empty product goes by its department's decision. */
    const gone = body.items.flatMap(item => ('department' in item && item.remove ? [item.department] : []));
    const whole = gone.length ? await db.select(idOnly(departments)).from(departments).where(and(inArray(departments.id, gone), eq(departments.companyId, me.companyId), isNull(departments.parentId))) : [];
    if (whole.length && (!me.isOwner || me.via || me.assistant)) {
      throw new ApiError(403, 'forbidden', 'The CEO must approve this permanent deletion.', 'deletion_needs_ceo');
    }

    const result = await lockedFor(ctx, on, () => db.transaction(async tx => {
      await stillDecides(tx, me.companyId, me.id, subject, on, standingPrincipal);
      let brief = body.brief;
      let agentId: string | null = null;
      if (body.proposalId) {
        const [taken] = await tx
          .update(proposals)
          .set({ status: 'applied', appliedBy: appliedBy(me, on), appliedAt: new Date() })
          .where(and(eq(proposals.id, body.proposalId), eq(proposals.companyId, me.companyId), eq(proposals.kind, 'structure'), inArray(proposals.status, ['draft', 'pending'])))
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
      const freed: string[] = [];
      const hired: Hired[] = [];
      const waiting: string[] = [];
      /* A new department asked for with its people gets the default staff, pipeline owners and teams of its template. */
      const hireTemplate = async (inside: Tx, dept: typeof departments.$inferSelect): Promise<Hired[]> => {
        const within = { db: inside, templates: ctx.templates };
        const { lines } = await linesToHire(ctx, inside, dept, await rosterOf(within, me.companyId, dept), false);
        /* Each team of the template becomes a sub-unit with its members. */
        lines.push(...(await templateTeams(ctx, inside, dept, await servingSubscriptions(within, me.companyId, spotIn(dept)))));
        return hireLines(inside, dept, lines);
      };
      const hireLines = async (inside: Tx, dept: typeof departments.$inferSelect, lines: HireLine[]): Promise<Hired[]> => {
        const out: Hired[] = [];
        for (const line of lines) out.push(await hireEmployee(ctx, inside, { companyId: me.companyId, departmentId: dept.id }, line, employeeChangedBy(me)));
        waiting.push(...lines.filter(line => !line.subscription).map(line => line.name));
        return out;
      };
      const addProducts = async (parent: { id: string; roleCode: string }, names: string[]) => {
        const made: (typeof departments.$inferSelect)[] = [];
        for (const name of names) {
          const [row] = await tx.insert(departments).values({ companyId: me.companyId, name, parentId: parent.id, roleCode: parent.roleCode, position: position++ }).returning();
          made.push(row!);
        }
        return made;
      };

      for (const item of body.items) {
        if (isNew(item)) {
          const [dept] = await tx
            .insert(departments)
            .values({ companyId: me.companyId, templateKey: item.template, name: item.name ?? null, roleCode: roleOf(item.template), about: item.note, position: position++, slotCap: slotCapOfNew(item.template) })
            .returning();
          await tx.select(idOnly(companies)).from(companies).where(eq(companies.id, me.companyId)).for('no key update');
          await ensureOpenTurn(tx, me.companyId, dept!.id);
          await seedCatalogPipelines(ctx, tx, dept!, { personId: me.id });
          await addProducts(dept!, item.products ?? []);
          await applyTeams(tx, me, dept!.id, item.teams);
          if (item.staff) hired.push(...(await hireTemplate(tx, dept!)));
          created.push({ id: dept!.id, template: item.template, name: dept!.name, products: item.products ?? [] });
          fresh.push(dept!.id);
          continue;
        }
        const [dept] = await tx.select().from(departments).where(eq(departments.id, item.department));
        if (!dept) continue;
        if (item.remove) {
          const inside = [dept.id, ...(await tx.select(idOnly(departments)).from(departments).where(eq(departments.parentId, dept.id))).map(d => d.id)];
          /* Its pipelines before any of its tasks, as every change that puts a task on a stage takes them. */
          const itsPipelines = (await tx.select(idOnly(pipelines)).from(pipelines).where(inArray(pipelines.departmentId, inside)).orderBy(asc(pipelines.id)).for('update')).map(p => p.id);
          /* Removed employees and staff proposals keep their history without the department; a waiting proposal ends. */
          await tx
            .update(agents)
            .set({ departmentId: null, productId: null, teamId: null })
            .where(and(or(inArray(agents.departmentId, inside), inArray(agents.productId, inside)), isNotNull(agents.removedAt)));
          await tx.update(proposals).set({ status: 'dismissed' }).where(and(inArray(proposals.departmentId, inside), inArray(proposals.status, ['draft', 'pending'])));
          await tx.update(proposals).set({ departmentId: null }).where(inArray(proposals.departmentId, inside));
          /* Finished tasks keep their log without the department. A product's tasks are in the department that holds
             the product, so they are found through the department, not among all the tasks there are. */
          await tx.update(tasks).set({ productId: null }).where(and(inPlaces(me.companyId, dept, inside), inArray(tasks.productId, inside)));
          await tx.update(tasks).set({ departmentId: null }).where(inArray(tasks.departmentId, inside));
          /* Its goals stay as the company's, with their history; its pipelines go, and the tasks on them leave them. */
          await tx.update(goals).set({ departmentId: null }).where(inArray(goals.departmentId, inside));
          if (itsPipelines.length) {
            await tx.update(tasks).set({ pipelineId: null, pipelineStageId: null, trackerRevision: nextRevision() }).where(inArray(tasks.pipelineId, itsPipelines));
            await tx.delete(pipelineStages).where(inArray(pipelineStages.pipelineId, itsPipelines));
            await tx.delete(pipelines).where(inArray(pipelines.id, itsPipelines));
          }
          await tx.delete(teams).where(inArray(teams.departmentId, inside));
          /* Its turns end with it and stay in the history without it: its open one as it got its release ready. */
          await tx.update(turns).set({ status: 'closed', closedAt: new Date() }).where(and(eq(turns.departmentId, dept.id), ne(turns.status, 'closed')));
          await tx.delete(departments).where(eq(departments.parentId, dept.id));
          await tx.delete(departments).where(eq(departments.id, dept.id));
          removed.push({ id: dept.id, template: dept.templateKey, name: dept.name });
          continue;
        }
        if (item.about !== undefined) await tx.update(departments).set({ about: item.about }).where(eq(departments.id, dept.id));
        if (item.products?.length) {
          /* A product added to a department comes with the people its template keeps one of for each product. */
          const serving = await servingSubscriptions({ db: tx }, me.companyId, spotIn(dept));
          const made = await addProducts(dept, item.products);
          hired.push(...(await hireLines(tx, dept, made.flatMap(product => productRoster(ctx, dept, product, serving)))));
          created.push({ id: dept.id, template: dept.templateKey, name: dept.name, products: item.products });
        }
        freed.push(...(await applyTeams(tx, me, dept.id, item.teams)));
      }
      if (brief) await tx.update(companies).set({ brief }).where(eq(companies.id, me.companyId));
      return { created, removed, fresh, freed, agentId, hired, waiting };
    }));
    await wakeFreed(ctx, me, result.freed);
    if (result.hired.length) await tryPlaceOperator(ctx, me.companyId);

    const orchestrator = await orchestratorOf(ctx, me.companyId);
    const agentId = appliedTo(on, result.agentId, orchestrator);
    if (agentId) {
      await appendEvent(ctx, {
        companyId: me.companyId,
        agentId,
        kind: 'applied',
        data: { proposalId: body.proposalId ?? null, created: result.created, removed: result.removed, ...forWhom(on) },
        personId: personOf(me),
      });
    }
    ctx.bus.publish(me.companyId, { type: 'org' });
    /* A card applied or ended with its department: only people who see the whole company see cards. */
    ctx.bus.publish(me.companyId, { type: 'requests', spot: { departmentId: null } });
    for (const id of result.fresh) ctx.bus.publish(me.companyId, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id } });
    /* The orchestrator that built it reads the outcome in its tool's answer. */
    if (agentId && !me.via && (await orchestratorState(ctx, me.companyId)).ready) {
      const changed = subject.source === 'proposal' && subject.departments ? await db.select().from(departments).where(inArray(departments.id, subject.departments)) : [];
      const note = builtNote(await clickOf(db, me, changed), result.created, result.removed, result.hired, result.waiting);
      const message = await notificationMessage(ctx, me.companyId, 'structure', note, { actor: { personId: me.id } });
      await enqueueTurn(ctx, { companyId: me.companyId, agentId, prompt: message.text, createdBy: null, message });
    }
    reply.code(201);
    return { created: result.fresh, removed: result.removed.map(r => r.id), hired: result.hired.map(h => h.id) };
  });

  /* What a repository's save writes besides its token: the address and branch as checked, and the author and test settings
     given; left out, a saved one stays, and a null author takes it away. */
  function repoFields(body: z.infer<typeof RepoBody>) {
    const checked = Repo.pick({ url: true, branch: true, author: true }).safeParse({ url: body.url.trim(), branch: body.branch.trim(), author: body.author });
    if (!checked.success) throw new ApiError(400, 'validation', 'Use an https address, a plain branch name, and an author name on one line with a full email.', 'repo_invalid');
    const given = checked.data.author;
    const author = given === undefined ? {} : { repoAuthorName: given?.name ?? null, repoAuthorEmail: given?.email ?? null };
    const memory = body.testMemoryGb === undefined ? {} : { repoTestMemoryGb: body.testMemoryGb };
    return { repoUrl: checked.data.url, repoBranch: checked.data.branch, ...author, ...memory, ...fullCommandPatch(body.fullTestCommand), ...releaseWorkflowPatch(body.releaseWorkflow) };
  }
  const sealed = (token: string) => ({ repoTokenEnc: encryptSecret(token, ctx.config.secret), repoTokenLast4: token.slice(-4) });

  /* The git repository the department's agents work in. The whole company or the department's owner sets it; the token
     never comes back. */
  app.put('/api/departments/:id/repository', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    await requireDepartmentChanger(db, me, id);
    const body = RepoBody.parse(req.body);
    const fields = repoFields(body);
    const [dept] = await db.select().from(departments).where(and(eq(departments.id, id), eq(departments.companyId, me.companyId)));
    if (!dept) throw new ApiError(404, 'not_found', 'This department does not exist.', 'department_unknown');
    await checkFolderFree(db, dept.parentId ?? dept.id, fields.repoUrl, dept.id);
    /* A new token replaces the saved one; without one the saved token stays, unless the address moves to another host. */
    const host = (url: string | null) => (url ? new URL(url).host : null);
    const token = body.token
      ? { ...sealed(body.token), repoTokenRevision: sql`${departments.repoTokenRevision} + 1` }
      : host(dept.repoUrl) !== host(fields.repoUrl)
        ? { repoTokenEnc: null, repoTokenLast4: null, repoTokenRevision: sql`${departments.repoTokenRevision} + 1` }
        : {};
    const [row] = await db
      .update(departments)
      .set({ ...fields, ...token })
      .where(eq(departments.id, id))
      .returning();
    ctx.bus.publish(me.companyId, { type: 'org' });
    return { repository: repoView(row!) };
  });

  /* Another repository of a department comes as a new product of it, named after the repository unless a name is given: a
     task names the product whose repository it changes. Who may set the department's repository adds one. */
  app.post('/api/departments/:id/repositories', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    await requireDepartmentChanger(db, me, id);
    const body = RepositoryBody.parse(req.body);
    const fields = repoFields(body);
    const name = body.name ?? repoFolder(fields.repoUrl).slice(0, 60);
    const product = await db.transaction(async tx => {
      const [dept] = await tx.select().from(departments).where(and(eq(departments.id, id), eq(departments.companyId, me.companyId)));
      if (!dept) throw new ApiError(404, 'not_found', 'This department does not exist.', 'department_unknown');
      if (dept.parentId) throw new ApiError(400, 'validation', `${deptName(dept)} is a product. Add the repository to the department that holds it.`);
      const products = await tx.select({ id: departments.id, name: departments.name }).from(departments).where(eq(departments.parentId, dept.id));
      const same = products.find(p => p.name?.toLowerCase() === name.toLowerCase());
      if (same) throw new ApiError(409, 'conflict', `${deptName(dept)} has a product named ${same.name} already. Give the repository another name, or connect it to that product by set_repository with the product's id, ${same.id}.`, 'product_taken');
      await checkFolderFree(tx, dept.id, fields.repoUrl, null);
      const [last] = await tx.select({ n: max(departments.position) }).from(departments).where(eq(departments.companyId, me.companyId));
      const [row] = await tx
        .insert(departments)
        .values({ companyId: me.companyId, name, parentId: dept.id, roleCode: dept.roleCode, position: (last?.n ?? -1) + 1, ...fields, ...(body.token ? sealed(body.token) : {}) })
        .returning();
      /* The product comes with the people its department's template keeps one of for each product. */
      const serving = await servingSubscriptions({ db: tx }, me.companyId, spotIn(dept));
      for (const line of productRoster(ctx, dept, row!, serving)) await hireEmployee(ctx, tx, { companyId: me.companyId, departmentId: dept.id }, line, employeeChangedBy(me));
      return row!;
    });
    ctx.bus.publish(me.companyId, { type: 'org' });
    reply.code(201);
    return { product: { id: product.id, name: product.name, repository: repoView(product) } };
  });

  app.delete('/api/departments/:id/repository', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    await requireDepartmentChanger(db, me, id);
    await db
      .update(departments)
      .set({ repoUrl: null, repoBranch: null, repoTokenEnc: null, repoTokenLast4: null, repoTokenRevision: sql`${departments.repoTokenRevision} + 1`, repoAuthorName: null, repoAuthorEmail: null, repoTestMemoryGb: null, repoFullTestCommand: null, repoReleaseWorkflow: null })
      .where(and(eq(departments.id, id), eq(departments.companyId, me.companyId)));
    ctx.bus.publish(me.companyId, { type: 'org' });
    return reply.code(204).send();
  });

  /* Which accepted and handed-in task branches of the department are not in the main line yet, for those who run it. */
  app.get('/api/departments/:id/branches', async req => {
    const me = await requirePerson(req, db);
    const dept = await departmentOf(db, me.companyId, IdParams.parse(req.params).id);
    if (!dept) throw new ApiError(404, 'not_found', 'This department does not exist.', 'department_unknown');
    await requireDepartmentChanger(db, me, dept.id);
    return departmentBranches(ctx, dept.id);
  });

  /* The default roster for the card by hand: one line per default role, a perProduct role once per product, on the first
     subscription that serves the department and runs the role's tier, with the model that tier asks for there. Every staff card
     picks from its roles, products and subscriptions. */
  app.get('/api/departments/:id/roster', async req => {
    const me = await requirePerson(req, db);
    const dept = await departmentOf(db, me.companyId, IdParams.parse(req.params).id);
    if (!dept) throw new ApiError(404, 'not_found', 'This department does not exist.', 'department_unknown');
    await requireDepartmentChanger(db, me, dept.id);
    const products = await db.select().from(departments).where(eq(departments.parentId, dept.id)).orderBy(asc(departments.position));
    const serving = await servingSubscriptions(ctx, me.companyId, spotIn(dept));
    const state = await stateSeen(db, me, dept);
    const roles = (dept.templateKey ? ctx.templates.roster(dept.templateKey) : []).map(role => ({
      id: role.id,
      title: role.title,
      kind: role.kind,
      tier: role.tier,
      perProduct: role.perProduct,
      inDefault: role.inDefault,
      skills: role.skills.filter(s => s.on).map(s => s.id),
      subscription: planFor(serving, role)?.id ?? null,
      ...state(role.id),
    }));
    return { people: await templateRoster(ctx, dept, serving), roles, products: products.map(p => ({ id: p.id, name: deptName(p) })), subscriptions: serving };
  });

  /* The CEO's click on a staff card, a hire by the department's owner, or the orchestrator's hire. */
  app.post('/api/departments/:id/staff', async (req, reply) => {
    const me = await requirePerson(req, db);
    const dept = await departmentOf(db, me.companyId, IdParams.parse(req.params).id);
    if (!dept) throw new ApiError(404, 'not_found', 'This department does not exist.', 'department_unknown');
    const subject: DecisionSubject = { source: 'proposal', departments: [dept.id] };
    const on = await cardDecision(me, subject);
    const body = StaffBody.parse(req.body);
    const invalid = (message: string) => new ApiError(400, 'validation', message, 'staff_invalid');

    const result = await lockedFor(ctx, on, () => db.transaction(async tx => {
      await stillDecides(tx, me.companyId, me.id, subject, on, standingPrincipal);
      let agentId: string | null = null;
      if (body.proposalId) {
        const [taken] = await tx
          .update(proposals)
          .set({ status: 'applied', appliedBy: appliedBy(me, on), appliedAt: new Date() })
          .where(and(eq(proposals.id, body.proposalId), eq(proposals.companyId, me.companyId), eq(proposals.kind, 'staff'), eq(proposals.departmentId, dept.id), inArray(proposals.status, ['draft', 'pending'])))
          .returning({ agentId: proposals.agentId });
        if (!taken) throw new ApiError(409, 'conflict', 'This card was already applied or replaced by a newer one.', 'proposal_closed');
        agentId = taken.agentId;
      }
      const { lines, present } = await linesToHire(ctx, tx, dept, body.people, Boolean(body.proposalId));
      const problem = await checkStaff({ db: tx, templates: ctx.templates }, me.companyId, dept, lines);
      if (problem) throw invalid(problem);
      const granting = grantingSkillOn(ctx.templates, lines);
      if (granting && (me.scopeKind !== 'company' || me.viaHead)) {
        throw new ApiError(403, 'forbidden', `Only people who see the whole company give a new employee ${granting}: it reaches the whole company.`, 'skill_company_only');
      }
      const heads = lines.filter(l => ctx.templates.roles.get(l.role)!.kind === 'head');
      if (heads.length > 1) throw invalid(`${deptName(dept)} can have one head; the card has ${heads.length}.`);
      if (heads.length) {
        const [head] = await tx.select(only(agents, 'name')).from(agents).where(and(eq(agents.departmentId, dept.id), eq(agents.kind, 'head'), isNull(agents.removedAt)));
        if (head) throw invalid(`${deptName(dept)} already has a head, ${head.name}.`);
      }

      const hired: Hired[] = [];
      for (const line of lines) hired.push(await hireEmployee(ctx, tx, { companyId: me.companyId, departmentId: dept.id }, line, employeeChangedBy(me)));
      return { hired, present, agentId };
    }));
    await tryPlaceOperator(ctx, me.companyId);

    const orchestrator = await orchestratorOf(ctx, me.companyId);
    const agentId = appliedTo(on, result.agentId, orchestrator);
    if (agentId) {
      await appendEvent(ctx, {
        companyId: me.companyId,
        agentId,
        kind: 'applied',
        data: { proposalId: body.proposalId ?? null, kind: 'staff', department: dept.id, hired: result.hired.map(({ id, name, role }) => ({ id, name, role })), ...(result.present.length ? { present: result.present } : {}), ...forWhom(on) },
        personId: personOf(me),
      });
    }
    ctx.bus.publish(me.companyId, { type: 'org' });
    ctx.bus.publish(me.companyId, { type: 'requests', spot: { departmentId: null } });
    ctx.bus.publish(me.companyId, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: dept.id } });
    if (agentId && !me.via && (await orchestratorState(ctx, me.companyId)).ready) {
      const message = await notificationMessage(ctx, me.companyId, 'staffing', staffedNote(await clickOf(db, me, [dept]), deptName(dept), result.hired, result.present), { actor: { personId: me.id } });
      await enqueueTurn(ctx, { companyId: me.companyId, agentId, prompt: message.text, createdBy: null, message });
    }
    reply.code(201);
    return { hired: result.hired.map(h => h.id), present: result.present };
  });

  teamRoutes(app, ctx);
  approvalPolicyRoutes(app, ctx);
  repoHostRoutes(app, ctx);
  waitPolicyRoutes(app, ctx);
}
