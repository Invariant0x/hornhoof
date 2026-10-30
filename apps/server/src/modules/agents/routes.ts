import { MAX_INSTRUCTIONS, modelsFor, type ModelOption } from '@hornhoof/protocol';
import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf, agentSpot, canReach } from '../../auth/access.js';
import { requireCompanyScope, type Person } from '../../auth/session.js';
import { agentChanges, agents, departments, jobs, people, subscriptions, tasks, type AGENT_CHANGE_FIELDS } from '../../db/schema.js';
import { ApiError, type ErrorReason } from '../../errors.js';
import { onAgent, pump, pumpWaiting } from '../conversation/queue.js';
import { deptName } from '../departments/templates.js';
import { identityOf } from '../nodes/hub.js';
import { subViews, type SubView } from '../subscriptions/views.js';
import { CLOSED, dropGate } from '../tasks/engine.js';
import { backOn, leaveIfOff, resumeAgent } from '../tasks/wake.js';
import { orchestratorServing, servingSubscriptions, type Serving } from '../tools/staff.js';
import type { Lang } from '../templates/load.js';
import { agentFor, type AgentRow } from './find.js';
import { instructionsOf, renderInstructions, placeOf, type Part } from './instructions.js';

export type AgentCard = {
  id: string;
  kind: AgentRow['kind'];
  name: string;
  role: { id: string; title: Lang; description: Lang } | null;
  department: { id: string; name: string } | null;
  product: { id: string; name: string } | null;
  model: string;
  subscription: SubView | null;
  state: 'working' | 'sleeping' | 'needs_subscription';
  skills: { id: string; title: Lang; description: Lang; on: boolean; locked: boolean; overridden: boolean; templateChanged: boolean }[];
  parts: Part[];
  raw: string;
  runsOn: { subscription: SubView; models: ModelOption[] }[];
  changes: { field: string; personName: string | null; at: string; before: unknown; after: unknown }[];
  /* The whole company or the agent's department may change it; only the whole company removes it. */
  canEdit: boolean;
  /* Off for now: it takes no task turns. */
  on: boolean;
};

const Text = z.string().max(8000);
const PatchBody = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    model: z.string().max(80).optional(),
    subscription: z.uuid().nullable().optional(),
    skills: z.record(z.string().max(80), z.boolean()).optional(),
    base: Text.nullable().optional(),
    skillText: z.record(z.string().max(80), Text.nullable()).optional(),
    on: z.boolean().optional(),
  })
  .strict();

type Field = (typeof AGENT_CHANGE_FIELDS)[number];

const CHANGES_SHOWN = 20;

/* The employee card: who it is, where it runs, its skills and the instructions it runs with, and its latest changes. */
export function agentRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, hub } = ctx;
  const online = (s: { id: string; kind: 'personal' | 'api_key' }) => hub.isOnline(identityOf(s));
  const invalid = (message: string, reason: ErrorReason) => new ApiError(400, 'validation', message, reason);

  /* The subscriptions the agent may move to: for an employee those that serve its department, for the orchestrator those
     that serve the whole company. */
  const servingFor = async (agent: AgentRow): Promise<Serving[]> =>
    agent.kind === 'orchestrator' ? orchestratorServing(ctx, agent.companyId) : servingSubscriptions(ctx, agent.companyId, await agentSpot(db, agent));

  /* People of the employee's department change its card, the whole company changes every card; a team alone only sees it. */
  async function mayEdit(me: Person, agent: AgentRow): Promise<boolean> {
    if (me.scopeKind === 'company') return true;
    if (agent.kind === 'orchestrator') return false;
    return canReach({ ...(await accessOf(db, me)), teams: new Set() }, await agentSpot(db, agent));
  }

  async function requireEditor(me: Person, agent: AgentRow): Promise<void> {
    if (!(await mayEdit(me, agent))) throw new ApiError(403, 'forbidden', "Only people with access to this employee's department or the whole company can change it.", 'not_your_department');
  }

  /* Changes to one agent go one at a time, each from the agent as the change before it left it. */
  async function changing<T>(found: AgentRow, fn: (agent: AgentRow) => Promise<T>): Promise<T> {
    return onAgent(ctx, found.id, async () => {
      const [agent] = await db.select().from(agents).where(and(eq(agents.id, found.id), isNull(agents.removedAt)));
      if (!agent) throw new ApiError(404, 'not_found', 'This employee does not exist.', 'agent_unknown');
      return fn(agent);
    });
  }

  async function card(agent: AgentRow, me: Person): Promise<AgentCard> {
    const role = agent.roleKey ? ctx.templates.roles.get(agent.roleKey) : undefined;
    const ids = [agent.departmentId, agent.productId].filter((id): id is string => Boolean(id));
    const depts = ids.length ? await db.select().from(departments).where(inArray(departments.id, ids)) : [];
    const named = (id: string | null) => {
      const d = depts.find(x => x.id === id);
      return d ? { id: d.id, name: deptName(d) } : null;
    };
    const views = new Map((await subViews(db, online)).map(v => [v.id, v]));
    const [running] = await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.agentId, agent.id), eq(jobs.status, 'running'))).limit(1);
    const { parts, text } = await instructionsOf(ctx, agent);
    const offered = [...(role?.skills ?? []), ...agent.skills.filter(id => !role?.skills.some(s => s.id === id)).map(id => ({ id, on: true, locked: false }))];
    const changes = await db
      .select({ field: agentChanges.field, personName: people.name, at: agentChanges.createdAt, before: agentChanges.before, after: agentChanges.after })
      .from(agentChanges)
      .leftJoin(people, eq(people.id, agentChanges.personId))
      .where(eq(agentChanges.agentId, agent.id))
      .orderBy(desc(agentChanges.createdAt))
      .limit(CHANGES_SHOWN);
    return {
      id: agent.id,
      kind: agent.kind,
      name: agent.name,
      role: role ? { id: role.id, title: role.title, description: role.description } : null,
      department: named(agent.departmentId),
      product: named(agent.productId),
      model: agent.model,
      subscription: agent.subscriptionId ? (views.get(agent.subscriptionId) ?? null) : null,
      state: running ? 'working' : agent.subscriptionId ? 'sleeping' : 'needs_subscription',
      skills: offered.flatMap(s => {
        const skill = ctx.templates.skills.get(s.id);
        if (!skill) return [];
        const hired = agent.templateHashes[s.id];
        return [
          {
            id: s.id,
            title: skill.title,
            description: skill.description,
            on: agent.skills.includes(s.id),
            locked: s.locked,
            overridden: agent.overrides.skills?.[s.id] !== undefined,
            templateChanged: hired !== undefined && hired !== skill.hash,
          },
        ];
      }),
      parts,
      raw: text,
      runsOn: (await servingFor(agent)).flatMap(s => {
        const view = views.get(s.id);
        return view ? [{ subscription: view, models: s.models }] : [];
      }),
      changes: changes.map(c => ({ ...c, at: c.at.toISOString() })),
      canEdit: await mayEdit(me, agent),
      on: !agent.switchedOffAt,
    };
  }

  app.get('/api/agents/:id', async req => {
    const { me, agent } = await agentFor(ctx, req);
    return card(agent, me);
  });

  app.patch('/api/agents/:id', async req => {
    const { me, agent: found } = await agentFor(ctx, req);
    await requireEditor(me, found);
    const body = PatchBody.parse(req.body);
    const { agent, next, changed } = await changing(found, agent => patched(me, agent, body));
    if (changed) {
      ctx.bus.publish(agent.companyId, { type: 'org' });
      /* Turns that waited for a subscription can go now, with the tasks it missed while it had none. */
      if (next.subscriptionId !== agent.subscriptionId) {
        if (next.subscriptionId && !agent.subscriptionId) await resumeAgent(ctx, agent.id);
        await (agent.kind === 'orchestrator' ? pumpWaiting(ctx) : pump(ctx, agent.id));
      }
      /* Back on: gates that waited for its role start again and the task turns it missed go out. Off: its work goes back
         once no turn of it runs. */
      if (agent.switchedOffAt && !next.switchedOffAt) await backOn(ctx, { personId: me.id }, agent.id);
      if (!agent.switchedOffAt && next.switchedOffAt) await leaveIfOff(ctx, agent.id);
    }
    return card(next, me);
  });

  /* Applies a card change to the agent as it is now and records each changed field. */
  async function patched(me: Person, agent: AgentRow, body: z.infer<typeof PatchBody>): Promise<{ agent: AgentRow; next: AgentRow; changed: boolean }> {
    const orchestrator = agent.kind === 'orchestrator';
    if (orchestrator && (body.name !== undefined || body.skills || body.base !== undefined || body.skillText || body.on !== undefined)) {
      throw invalid("The orchestrator's card changes only his model and the subscription he runs on.", 'orchestrator_card');
    }
    const next: AgentRow = { ...agent, skills: [...agent.skills], overrides: { ...agent.overrides, skills: { ...agent.overrides.skills } }, templateHashes: { ...agent.templateHashes } };
    if (body.name !== undefined) next.name = body.name;
    if (body.on !== undefined && body.on === !!agent.switchedOffAt) next.switchedOffAt = body.on ? null : new Date();

    if (body.subscription !== undefined) {
      if (body.subscription === null) {
        if (orchestrator) throw invalid('The orchestrator needs a subscription.', 'subscription_cannot_serve');
        next.subscriptionId = null;
      } else if (body.subscription !== agent.subscriptionId) {
        if (!(await servingFor(agent)).some(s => s.id === body.subscription)) {
          throw invalid('This subscription cannot serve where this employee works.', 'subscription_cannot_serve');
        }
        next.subscriptionId = body.subscription;
      }
    }
    const [before] = agent.subscriptionId ? await db.select().from(subscriptions).where(eq(subscriptions.id, agent.subscriptionId)) : [];
    const [after] = next.subscriptionId ? await db.select().from(subscriptions).where(eq(subscriptions.id, next.subscriptionId)) : [];
    /* Another provider's programs do not know this model, so the employee starts on the new one's Default. */
    if (next.subscriptionId !== agent.subscriptionId && before?.provider !== after?.provider) next.model = '';
    if (body.model !== undefined && body.model !== '') {
      if (!after) throw invalid('Pick a subscription before a model.', 'model_unknown');
      const models = modelsFor(after.provider, after.models);
      if (!models.some(m => m.id === body.model)) throw invalid(`${after.label} cannot run ${body.model}.`, 'model_unknown');
    }
    if (body.model !== undefined) next.model = body.model;

    const role = agent.roleKey ? ctx.templates.roles.get(agent.roleKey) : undefined;
    for (const [id, on] of Object.entries(body.skills ?? {})) {
      const skill = ctx.templates.skills.get(id);
      if (!skill) throw invalid(`There is no skill ${id}.`, 'skill_unknown');
      if (!on && role?.skills.some(s => s.id === id && s.locked)) throw invalid(`${id} is locked on for this role.`, 'skill_locked');
      if (on && !next.skills.includes(id)) {
        next.skills.push(id);
        next.templateHashes[id] ??= skill.hash;
      }
      if (!on) next.skills = next.skills.filter(s => s !== id);
    }
    if (body.base !== undefined) {
      if (body.base === null) delete next.overrides.base;
      else next.overrides.base = body.base;
    }
    for (const [id, text] of Object.entries(body.skillText ?? {})) {
      if (!ctx.templates.skills.has(id)) throw invalid(`There is no skill ${id}.`, 'skill_unknown');
      if (text === null) delete next.overrides.skills![id];
      else next.overrides.skills![id] = text;
    }
    if (!Object.keys(next.overrides.skills!).length) delete next.overrides.skills;
    if (!orchestrator && renderInstructions(ctx.templates, next, await placeOf(db, next)).text.length > MAX_INSTRUCTIONS) {
      throw invalid(`The instructions would be longer than ${MAX_INSTRUCTIONS} characters. Shorten the text or turn a skill off.`, 'instructions_too_long');
    }

    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    /* One row per changed field, with who changed it. */
    const changed: { field: Field; before: unknown; after: unknown }[] = [];
    if (next.name !== agent.name) changed.push({ field: 'name', before: agent.name, after: next.name });
    if (next.model !== agent.model) changed.push({ field: 'model', before: agent.model, after: next.model });
    if (next.subscriptionId !== agent.subscriptionId) changed.push({ field: 'subscription', before: agent.subscriptionId, after: next.subscriptionId });
    if (!same(next.skills, agent.skills)) changed.push({ field: 'skills', before: agent.skills, after: next.skills });
    if (!same(next.overrides, agent.overrides)) changed.push({ field: 'prompt', before: agent.overrides, after: next.overrides });
    if (next.switchedOffAt !== agent.switchedOffAt) changed.push({ field: 'switch', before: !agent.switchedOffAt, after: !next.switchedOffAt });
    if (changed.length) {
      await db.transaction(async tx => {
        await tx
          .update(agents)
          .set({ name: next.name, model: next.model, subscriptionId: next.subscriptionId, skills: next.skills, overrides: next.overrides, templateHashes: next.templateHashes, switchedOffAt: next.switchedOffAt })
          .where(eq(agents.id, agent.id));
        await tx.insert(agentChanges).values(changed.map(c => ({ companyId: agent.companyId, agentId: agent.id, personId: me.id, ...c })));
      });
    }
    return { agent, next, changed: changed.length > 0 };
  }

  /* Back to the role as the templates have it now: its skills and texts. The model and subscription stay. */
  app.post('/api/agents/:id/reset', async req => {
    const { me, agent: found } = await agentFor(ctx, req);
    await requireEditor(me, found);
    const reset = await changing(found, async agent => {
      const role = agent.roleKey ? ctx.templates.roles.get(agent.roleKey) : undefined;
      if (!role) throw invalid('This agent has no role template to go back to.', 'no_role');
      const skills = role.skills.filter(s => s.on).map(s => s.id);
      const templateHashes = Object.fromEntries([[role.id, role.hash], ...skills.map(id => [id, ctx.templates.skills.get(id)!.hash])]);
      await db.transaction(async tx => {
        await tx.update(agents).set({ skills, overrides: {}, templateHashes }).where(eq(agents.id, agent.id));
        await tx.insert(agentChanges).values({ companyId: agent.companyId, agentId: agent.id, personId: me.id, field: 'reset', before: { skills: agent.skills, overrides: agent.overrides }, after: { skills } });
      });
      return { ...agent, skills, overrides: {}, templateHashes };
    });
    return card(reset, me);
  });

  /* An employee leaves the company: its history stays, its waiting turns end. Never while it works, never the orchestrator. */
  app.delete('/api/agents/:id', async (req, reply) => {
    const { me, agent: found } = await agentFor(ctx, req);
    requireCompanyScope(me);
    if (found.kind === 'orchestrator') throw new ApiError(403, 'forbidden', 'The orchestrator stays with the company.', 'orchestrator_locked');
    await changing(found, async agent => {
      const [running] = await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.agentId, agent.id), eq(jobs.status, 'running'))).limit(1);
      if (running) throw new ApiError(409, 'conflict', 'This employee is working. Stop it first.', 'agent_working');
      /* A task it holds or does would wait for it for good. */
      const held = await db
        .select({ number: tasks.number })
        .from(tasks)
        .where(and(or(eq(tasks.assigneeAgentId, agent.id), eq(tasks.executorAgentId, agent.id), sql`${tasks.panel} @> ${JSON.stringify([agent.id])}::jsonb`), notInArray(tasks.status, [...CLOSED])))
        .orderBy(asc(tasks.number));
      if (held.length) {
        const list = held.map(t => `#${t.number}`).join(', ');
        throw new ApiError(409, 'conflict', `${agent.name} works on ${list}. Wait until they are done or cancel them, then remove ${agent.name}.`, 'agent_has_tasks');
      }
      await db.transaction(async tx => {
        await tx.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, agent.id));
        await tx
          .update(jobs)
          .set({ status: 'failed', error: 'removed', finishedAt: new Date() })
          .where(and(eq(jobs.agentId, agent.id), eq(jobs.status, 'queued')));
        await tx.insert(agentChanges).values({ companyId: agent.companyId, agentId: agent.id, personId: me.id, field: 'removed', before: null, after: null });
      });
      const gated = await db.select().from(tasks).where(and(eq(tasks.companyId, agent.companyId), notInArray(tasks.status, [...CLOSED])));
      for (const task of gated.filter(t => t.gates.includes(agent.id))) await dropGate(ctx, { personId: me.id }, task, agent.id);
    });
    ctx.bus.publish(found.companyId, { type: 'org' });
    return reply.code(204).send();
  });
}
