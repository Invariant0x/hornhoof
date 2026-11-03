import { defaultEffortOf, effortFor, effortsOf, modelsFor, type ModelOption, type ProviderId } from '@hornhoof/protocol';
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, notInArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { accessOf, canReach, type Access, type Spot } from '../../auth/access.js';
import { personColumns, requirePerson } from '../../auth/session.js';
import { agents, companies, departments, jobs, people, personAccess, requests, subscriptions, tasks, teams, turns } from '../../db/schema.js';
import { employeeOrder } from '../agents/order.js';
import { limitUntil, programNode } from '../conversation/queue.js';
import { repoView } from '../departments/repository.js';
import { deptName } from '../departments/templates.js';
import { CHANNEL_MS, type Endpoint } from '../events/bus.js';
import { workingCount } from '../events/store.js';
import { machineOf } from '../nodes/nodes.js';
import { pendingFor, visibleDecisions } from '../tasks/decisions.js';
import { mapLines, type MapLine } from './map-state.js';
import { reworkTimes } from './rework.js';
import { personViews } from '../people/views.js';
import { subView } from '../subscriptions/views.js';

/* The level an agent thinks at, as far as Hornhoof knows: the one it was set to or Kimi's and Codex's most, else its
   model's default. */
function effortShown(sub: { provider: ProviderId; models: ModelOption[] | null }, agent: { model: string; effort: string | null }): string | null {
  const models = modelsFor(sub.provider, sub.models);
  return effortFor(sub.provider, agent.effort, effortsOf(models, agent.model)) ?? defaultEffortOf(sub.provider, models, agent.model);
}

type AgentRow = typeof agents.$inferSelect;
type DeptRow = typeof departments.$inferSelect;

/* Where an employee works, as agentSpot says, from the departments already read: its product inside its department when it
   has one. */
const spotAmong = (agent: AgentRow, depts: readonly DeptRow[]): Spot =>
  agent.productId
    ? { departmentId: agent.productId, parentId: agent.departmentId, teamId: agent.teamId }
    : { departmentId: agent.departmentId, parentId: depts.find(d => d.id === agent.departmentId)?.parentId ?? null, teamId: agent.teamId };

/* The lines of work and of results given back, only of the places the person reaches: a department's line to people who
   reach the department, an employee's to people who reach where it works. The answer gives a kind's lines, of one
   department when it is named, without what only the server needs. */
function reachedLines(lines: readonly MapLine[], reach: Access, allAgents: readonly AgentRow[], depts: readonly DeptRow[]) {
  const seen = (l: MapLine) => {
    if (l.kind === 'department') return canReach(reach, { departmentId: l.departmentId });
    const agent = allAgents.find(a => a.id === l.downstreamAgentId);
    return !!agent && canReach(reach, spotAmong(agent, depts));
  };
  const shown = lines.filter(seen);
  return (kind: MapLine['kind'], departmentId?: string) =>
    shown.filter(l => l.kind === kind && (!departmentId || l.departmentId === departmentId)).map(({ kind: _, departmentId: __, ...line }) => line);
}

export function orgRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, hub, templates, bus } = ctx;
  app.get('/api/org', async req => {
    const me = await requirePerson(req, db);
    const [company] = await db.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.id, me.companyId));
    const allAgents = await db.select().from(agents).where(isNull(agents.removedAt));
    const subs = new Map((await db.select({ id: subscriptions.id, provider: subscriptions.provider, models: subscriptions.models, limits: subscriptions.limits }).from(subscriptions)).map(s => [s.id, s]));
    const orchestrator = allAgents.find(a => a.kind === 'orchestrator');
    const active = await db.select(personColumns).from(people).where(ne(people.status, 'disabled')).orderBy(asc(people.createdAt));
    const depts = await db.select().from(departments).orderBy(asc(departments.position), asc(departments.createdAt));
    /* What each department works on now: its newest open task without an executor (the head's), else its newest open one.
       Only for people who reach the department; the rest see that it exists, not what it does. */
    const reach = await accessOf(db, me);
    const openTasks = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, me.companyId), notInArray(tasks.status, ['done', 'cancelled', 'planned'])))
      .orderBy(desc(tasks.number));
    const currentOf = (id: string) => {
      if (!canReach(reach, { departmentId: id })) return null;
      const mine = openTasks.filter(t => t.departmentId === id);
      const t = mine.find(x => !x.executorAgentId) ?? mine[0];
      return t ? { id: t.id, number: t.number, title: t.title } : null;
    };
    /* Only people who see the whole company set repositories, so only they read where they are. */
    const repositoryOf = (d: (typeof depts)[number]) => (reach.whole ? repoView(d) : null);
    const [open] = await db.select({ id: turns.id, number: turns.number, title: turns.title, goal: turns.goal }).from(turns).where(and(eq(turns.companyId, me.companyId), eq(turns.status, 'open')));
    /* The map shows the turn's short name. */
    const turn = open && { id: open.id, number: open.number, goal: open.title || open.goal };
    const allTeams = await db.select().from(teams).orderBy(asc(teams.stage), asc(teams.createdAt));
    const topDepts = depts.filter(d => !d.parentId);
    /* A listed person counts each place as its top-level department: a product as the department holding it, a team as its department. */
    const topOf = (deptId: string | undefined) => {
      const d = depts.find(x => x.id === deptId);
      return d?.parentId ?? d?.id;
    };
    const access = await db.select().from(personAccess);
    const homes = new Map(
      active.map(p => {
        const reached = new Set(access.filter(a => a.personId === p.id).map(a => topOf(a.departmentId ?? allTeams.find(t => t.id === a.teamId)?.departmentId)));
        return [p.id, topDepts.filter(d => reached.has(d.id)).map(d => d.id)];
      }),
    );
    /* People who see the whole company or more than one department go in org.people; the rest in their department. */
    const nextToCeo = active.filter(p => p.scopeKind === 'company' || homes.get(p.id)!.length > 1);
    /* Each card counts the decisions waiting for its person that the viewer sees, as the decisions screen lists them. */
    const decisions = await visibleDecisions(ctx, me);
    const views = new Map((await personViews(db, active)).map(v => [v.id, { ...v, pendingDecisions: pendingFor(decisions, me, v.id) }]));
    const inDepartment = (deptId: string) => active.filter(p => p.scopeKind !== 'company' && homes.get(p.id)!.length === 1 && homes.get(p.id)![0] === deptId).map(p => views.get(p.id)!);
    const running = await db
      .select({ agentId: jobs.agentId, taskId: jobs.taskId, startedAt: jobs.startedAt, createdAt: jobs.createdAt })
      .from(jobs)
      .where(and(eq(jobs.companyId, me.companyId), eq(jobs.status, 'running'), isNotNull(jobs.agentId)));
    const busy = new Set(running.map(j => j.agentId));
    const asked = await db
      .select({ agentId: requests.agentId, taskId: requests.taskId })
      .from(requests)
      .where(and(eq(requests.companyId, me.companyId), eq(requests.status, 'open')));
    const byId = new Map(openTasks.map(t => [t.id, t]));
    /* A task that waits for the tasks it comes after is nobody's to act on yet. */
    const afterIds = [...new Set(openTasks.flatMap(t => t.after))];
    const notDone = new Set(afterIds.length ? (await db.select({ id: tasks.id }).from(tasks).where(and(inArray(tasks.id, afterIds), ne(tasks.status, 'done')))).map(t => t.id) : []);
    const waitsAfter = (t: (typeof openTasks)[number]) => t.after.some(id => notDone.has(id));
    const parents = new Set(openTasks.map(t => t.parentId));
    /* The task an agent acts on next: at a gate it still checks (or holds, when nobody on can), also while another reviewer
       there waits for a person, or with it as executor (or holder, for a head's task) before any gate. */
    const atGate = (t: (typeof openTasks)[number]) => t.status === 'review' || t.status === 'waiting';
    const holds = (t: (typeof openTasks)[number], id: string) =>
      t.stage > 0 ? atGate(t) && (t.panel.length ? t.panel.includes(id) : t.assigneeAgentId === id) : (t.executorAgentId ?? t.assigneeAgentId) === id;
    /* What an employee does now. Working: a turn runs. Waiting: it asked people, or it is blocked. Queued: it holds a task
       and its turn has not started. Handed: what it holds is with gates or with the tasks it gave out. */
    const doing = (a: (typeof allAgents)[number]) => {
      const run = running.find(j => j.agentId === a.id);
      const held = openTasks.filter(t => holds(t, a.id) && !waitsAfter(t));
      /* At a gate only the reviewer who asked waits; the others there can still give their verdict. */
      const waits = [...asked.filter(r => r.agentId === a.id).map(r => byId.get(r.taskId)), ...held.filter(t => t.status === 'blocked' || (t.status === 'waiting' && t.stage === 0))].filter(t => t !== undefined);
      const next = held.filter(t => !parents.has(t.id) && !waits.includes(t));
      const gave = [...openTasks.filter(t => t.stage > 0 && t.executorAgentId === a.id), ...held.filter(t => parents.has(t.id))];
      const pick = (status: 'off' | 'working' | 'waiting' | 'queued' | 'handed' | 'idle', t: (typeof openTasks)[number] | null | undefined) => ({ status, task: t ?? null });
      if (!a.subscriptionId) return pick('off', null);
      if (busy.has(a.id)) return pick('working', (run?.taskId && byId.get(run.taskId)) || next[0] || held[0]);
      if (waits.length) return pick('waiting', waits[0]);
      if (next.length) return pick('queued', next[0]);
      if (gave.length) return pick('handed', gave[0]);
      return pick('idle', null);
    };
    /* A department's agents include those in its products. */
    const agentIdsOf = (deptId: string) => {
      const ids = new Set([deptId, ...depts.filter(p => p.parentId === deptId).map(p => p.id)]);
      return allAgents.filter(a => a.departmentId && ids.has(a.departmentId)).map(a => a.id);
    };
    const agentsOf = (deptId: string) => {
      const mine = agentIdsOf(deptId);
      return { total: mine.length, working: mine.filter(id => busy.has(id)).length };
    };
    const employeesOf = (dept: (typeof depts)[number]) =>
      allAgents
        .filter(a => a.departmentId === dept.id && a.kind !== 'orchestrator')
        .sort(employeeOrder(templates, dept.templateKey))
        .map(a => {
          const sub = a.subscriptionId ? subs.get(a.subscriptionId) : undefined;
          const now = doing(a);
          return {
            id: a.id,
            name: a.name,
            roleId: a.roleKey,
            title: (a.roleKey && templates.roles.get(a.roleKey)?.title) || null,
            kind: a.kind,
            model: a.model,
            modelName: (a.model && sub && modelsFor(sub.provider, sub.models).find(m => m.id === a.model)?.name) || null,
            provider: sub?.provider ?? null,
            effort: sub ? effortShown(sub, a) : null,
            state: busy.has(a.id) ? 'working' : a.subscriptionId ? 'sleeping' : 'needs_subscription',
            context: a.contextUsed,
            status: now.status,
            on: !a.switchedOffAt,
            /* How often it wakes on its timer, in minutes. */
            timer: a.timerMinutes,
            /* Like the department's current task, only for people who reach it. */
            task: now.task && canReach(reach, { departmentId: dept.id }) ? { id: now.task.id, number: now.task.number, title: now.task.title, stage: now.task.stage, gateCount: now.task.gates.length, bounces: now.task.bounces } : null,
          };
        });
    /* The roles a department's employees hold, with the gate each one keeps, for the department's schema. */
    const rolesOf = (dept: (typeof depts)[number]) => {
      const held = new Set(allAgents.filter(a => a.departmentId === dept.id && a.roleKey).map(a => a.roleKey!));
      const roster = dept.templateKey ? templates.roster(dept.templateKey).map(r => r.id) : [];
      const at = (id: string) => (roster.includes(id) ? roster.indexOf(id) : roster.length);
      return [...held]
        .sort((a, b) => at(a) - at(b))
        .flatMap(id => {
          const role = templates.roles.get(id);
          return role ? [{ id, title: role.title, description: role.description, kind: role.kind, gate: role.gate }] : [];
        });
    };

    /* The agents at the end of a way: one agent, a department's with its products', or the orchestrator. */
    const at = (e: Endpoint): string[] =>
      e.kind === 'agent' ? [e.id] : e.kind === 'orchestrator' ? (orchestrator ? [orchestrator.id] : []) : e.kind === 'department' ? agentIdsOf(e.id) : [];
    /* Whether one of them still runs a turn it started before the way went quiet: the work the way brought goes on. A turn
       started later, on a timer say, does not keep it. */
    const goesOn = (w: { to: Endpoint; at: string }) => {
      const ids = at(w.to);
      return running.some(j => j.agentId !== null && ids.includes(j.agentId) && (j.startedAt ?? j.createdAt).getTime() <= Date.parse(w.at) + CHANNEL_MS);
    };
    /* The ways messages went in the last minutes, and those held while their work goes on: between places on the map, and
       between agents on a department's card. */
    const ways = bus.channels(me.companyId, Date.now(), goesOn);
    const map = await mapLines(db, me.companyId);
    const reworks = await reworkTimes(db, me.companyId, map.serverNow, reach);
    const linesOf = reachedLines(map.lines, reach, allAgents, depts);
    const inside = (id: string) =>
      ways.flatMap(w =>
        w.from.kind === 'agent' && w.to.kind === 'agent' && w.from.departmentId === id ? [{ from: w.from.id, to: w.to.id, at: w.at, ...(w.held ? { held: w.held } : {}) }] : [],
      );

    return {
      company,
      serverNow: map.serverNow.toISOString(),
      live: ways.filter(w => w.from.kind !== 'agent' && w.to.kind !== 'agent'),
      workLines: linesOf('department'),
      orchestrator: orchestrator && {
        id: orchestrator.id,
        name: orchestrator.name,
        model: orchestrator.model,
        effort: (orchestrator.subscriptionId && subs.has(orchestrator.subscriptionId) && effortShown(subs.get(orchestrator.subscriptionId)!, orchestrator)) || null,
        context: orchestrator.contextUsed,
        /* His plan is at its limit until then: he waits for the reset on it, and the CEO decides whether he moves. */
        limitUntil: limitUntil((orchestrator.subscriptionId && subs.get(orchestrator.subscriptionId)?.limits) || null),
        subscription: orchestrator.subscriptionId ? await subView(db, node => hub.isOnline(node), orchestrator.subscriptionId, me) : null,
        machine: await machineOf(db, (await programNode(ctx, orchestrator.id))?.node ?? null),
      },
      agents: { total: allAgents.length, working: await workingCount(db, me.companyId) },
      turn: turn ?? null,
      people: nextToCeo.map(p =>
        p.scopeKind === 'company'
          ? { ...views.get(p.id)!, deputy: false }
          : { ...views.get(p.id)!, deputy: true, departments: homes.get(p.id)! },
      ),
      /* Products are departments inside a department; the map shows only the top level and lists the products on it. */
      departments: topDepts.map(d => ({
          id: d.id,
          name: d.name,
          templateKey: d.templateKey,
          roleCode: d.roleCode,
          about: d.about,
          agents: agentsOf(d.id),
          people: inDepartment(d.id),
          employees: employeesOf(d),
          roles: rolesOf(d),
          products: depts.filter(p => p.parentId === d.id).map(p => ({ id: p.id, name: deptName(p), repository: repositoryOf(p) })),
          current: currentOf(d.id),
          repository: repositoryOf(d),
          teams: allTeams
            .filter(t => t.departmentId === d.id)
            .map(t => ({ id: t.id, name: t.name, about: t.about, stage: t.stage, gate: t.gate })),
          live: inside(d.id),
          workLines: linesOf('member', d.id),
          reworkAt: reworks.get(d.id) ?? null,
        })),
    };
  });
}
