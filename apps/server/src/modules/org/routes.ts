import { departmentProgress } from '../tasks/turn-progress.js';
import { defaultEffortOf, effortFor, effortsOf, modelsFor, ORCHESTRATOR_EFFORT, type Limits, type ModelOption, type ProviderId } from '@hornhoof/protocol';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { canReach, type Access, type Spot } from '../../auth/access.js';
import { seesAgentId, viewerOf, type AgentViewer } from '../../auth/agent-view.js';
import { personColumns, requirePerson } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { agents, companies, departments, people, personAccess, subscriptions, teams, turns } from '../../db/schema.js';
import { employeeOrder } from '../agents/order.js';
import { agentWork } from '../agents/work.js';
import { limitUntil, planHeld, planHoldView, programNode } from '../conversation/queue.js';
import { repoView } from '../departments/repository.js';
import { deptName } from '../departments/templates.js';
import { CHANNEL_MS, type Channel, type Endpoint } from '../events/bus.js';
import { workingSeen } from '../events/stream-view.js';
import { machineOf } from '../nodes/nodes.js';
import { departmentOwners, pendingFor, visibleDecisions } from '../tasks/decisions.js';
import { seesTask } from '../tasks/sight.js';
import { agentFailureStates } from '../tasks/failures.js';
import { agentProgramState } from '../tasks/silent.js';
import { mapLines, type MapLine } from './map-state.js';
import { reworkTimes } from './rework.js';
import { personViews } from '../people/views.js';
import { subView } from '../subscriptions/views.js';

/* Show the level sent to the program, or its own default when Hornhoof knows it. */
function effortShown(sub: { provider: ProviderId; models: ModelOption[] | null }, agent: { model: string; effort: string | null }, roleEffort?: string): string | null {
  const models = modelsFor(sub.provider, sub.models);
  return effortFor(agent.effort, effortsOf(models, agent.model), roleEffort) ?? defaultEffortOf(sub.provider, models, agent.model);
}

type AgentRow = typeof agents.$inferSelect;
type DeptRow = typeof departments.$inferSelect;

function reworkAt(times: ReadonlyMap<string, string>, departmentId: string): string | null {
  return times.get(departmentId) ?? null;
}

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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- strip routing keys used only for filtering
    shown.filter(l => l.kind === kind && (!departmentId || l.departmentId === departmentId)).map(({ kind: _, departmentId: __, ...line }) => line);
}

/* The person who takes a department's approvals; null means the CEO. */
const ownerOf = (owners: ReadonlyMap<string, string>, departmentId: string) => owners.get(departmentId) ?? null;

const teamField = (teamId: string | null) => (teamId ? { teamId } : {});

/* Until when a plan is at its limit, from what it last read. */
const limitOfPlan = (plan?: { limits: Limits | null; limitsUpdatedAt: Date | null }) => limitUntil(plan?.limits ?? null, plan?.limitsUpdatedAt ?? null);

/* A line runs between two agents: it shows when both of its ends do. */
const linesSeen = (viewer: AgentViewer, lines: readonly MapLine[]) => lines.filter(l => seesAgentId(viewer, l.upstreamAgentId) && seesAgentId(viewer, l.downstreamAgentId));

/* The ways between two agents on a department's card, both of them seen. */
const waysInside = (viewer: AgentViewer, ways: readonly Channel[], id: string) =>
  ways.flatMap(w =>
    w.from.kind === 'agent' && w.to.kind === 'agent' && w.from.departmentId === id && seesAgentId(viewer, w.from.id) && seesAgentId(viewer, w.to.id) ? [{ from: w.from.id, to: w.to.id, at: w.at, ...(w.held ? { held: w.held } : {}) }] : [],
  );

/* The ways over the map run between places: which of them are alive says what the whole company does. */
const liveWays = (viewer: AgentViewer, ways: readonly Channel[]) => (viewer.full ? ways.filter(w => w.from.kind !== 'agent' && w.to.kind !== 'agent') : []);

/* When a department's work last came back counts the work of all of its agents, so it goes with the full view. */
async function reworksSeen(db: Db, companyId: string, now: Date, viewer: AgentViewer): Promise<ReadonlyMap<string, string>> {
  return viewer.full ? reworkTimes(db, companyId, now, viewer.access) : new Map<string, string>();
}

export function orgRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, hub, templates, bus } = ctx;
  app.get('/api/org', async req => {
    const me = await requirePerson(req, db);
    const [company] = await db.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.id, me.companyId));
    const viewer = await viewerOf(db, me);
    const companyAgents = await db.select().from(agents).where(and(eq(agents.companyId, me.companyId), isNull(agents.removedAt)));
    /* Everything below shows only the agents this person sees, with their work. */
    const allAgents = companyAgents.filter(a => seesAgentId(viewer, a.id));
    const subs = new Map((await db.select({ id: subscriptions.id, provider: subscriptions.provider, models: subscriptions.models, limits: subscriptions.limits, limitsUpdatedAt: subscriptions.limitsUpdatedAt, budget: subscriptions.budget }).from(subscriptions).where(eq(subscriptions.companyId, me.companyId))).map(s => [s.id, s]));
    const orchestrator = allAgents.find(a => a.kind === 'orchestrator');
    const active = await db.select(personColumns).from(people).where(and(eq(people.companyId, me.companyId), ne(people.status, 'disabled'))).orderBy(asc(people.createdAt));
    const depts = await db.select().from(departments).where(eq(departments.companyId, me.companyId)).orderBy(asc(departments.position), asc(departments.createdAt));
    /* What each department works on now: its newest open task without an executor (the head's), else its newest open one.
       Only of the tasks this person sees; the rest see that it exists, not what it does. */
    const reach = viewer.access;
    const { openTasks, running, busy, doing } = await agentWork(db, me.companyId);
    const currentOf = (id: string) => {
      const mine = openTasks.filter(t => t.departmentId === id && seesTask(viewer, t));
      const t = mine.find(x => !x.executorAgentId) ?? mine[0];
      return t ? { id: t.id, number: t.number, title: t.title } : null;
    };
    /* Only people who see the whole company set repositories, so only they read where they are. */
    const repositoryOf = (d: (typeof depts)[number]) => (reach.whole ? repoView(d) : null);
    const [open] = await db.select({ id: turns.id, companyId: turns.companyId, number: turns.number, title: turns.title, goal: turns.goal }).from(turns).where(and(eq(turns.companyId, me.companyId), eq(turns.status, 'open')));
    /* The map shows the turn's short name. */
    const turn = open && { id: open.id, number: open.number, goal: open.title || open.goal };
    const allTeams = await db.select().from(teams).where(eq(teams.companyId, me.companyId)).orderBy(asc(teams.stage), asc(teams.createdAt));
    const topDepts = depts.filter(d => !d.parentId);
    /* A listed person counts each place as its top-level department: a product as the department holding it, a team as its department. */
    const topOf = (deptId: string | undefined) => {
      const d = depts.find(x => x.id === deptId);
      return d?.parentId ?? d?.id;
    };
    const access = await db.select().from(personAccess).where(eq(personAccess.companyId, me.companyId));
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
    const owners = await departmentOwners(ctx, me.companyId);
    const views = new Map((await personViews(db, active)).map(v => [v.id, { ...v, pendingDecisions: pendingFor(decisions, me, v.id) }]));
    const inDepartment = (deptId: string) => active.filter(p => p.scopeKind !== 'company' && homes.get(p.id)!.length === 1 && homes.get(p.id)![0] === deptId).map(p => views.get(p.id)!);
    /* What each agent's card shows, once: the map's lines go by the same tasks. */
    const cards = new Map(companyAgents.map(a => [a.id, doing(a)]));
    /* A department's agents include those in its products. */
    const agentIdsOf = (deptId: string) => {
      const ids = new Set([deptId, ...depts.filter(p => p.parentId === deptId).map(p => p.id)]);
      return allAgents.filter(a => a.departmentId && ids.has(a.departmentId)).map(a => a.id);
    };
    const agentsOf = (deptId: string) => {
      const mine = agentIdsOf(deptId);
      return { total: mine.length, working: mine.filter(id => busy.has(id)).length };
    };
    const failures = await agentFailureStates(ctx, me.companyId, allAgents.map(a => a.id));
    const holds = new Map(await Promise.all(allAgents.map(async a => [a.id, planHoldView(await planHeld(ctx, a, subs.get(a.subscriptionId!)))] as const)));
    const employeesOf = (dept: (typeof depts)[number]) =>
      allAgents
        .filter(a => a.departmentId === dept.id && a.kind !== 'orchestrator')
        .sort(employeeOrder(templates, dept.templateKey))
        .map(a => {
          const sub = a.subscriptionId ? subs.get(a.subscriptionId) : undefined;
          const role = a.roleKey ? templates.roles.get(a.roleKey) : undefined;
          const now = cards.get(a.id)!;
          const run = running.find(j => j.agentId === a.id);
          return {
            id: a.id,
            name: a.name,
            roleId: a.roleKey,
            ...teamField(a.teamId),
            title: role?.title ?? null,
            kind: a.kind,
            model: a.model,
            modelName: (a.model && sub && modelsFor(sub.provider, sub.models).find(m => m.id === a.model)?.name) || null,
            provider: sub?.provider ?? null,
            effort: sub ? effortShown(sub, a, role?.effort) : null,
            state: busy.has(a.id) ? 'working' : a.subscriptionId ? 'sleeping' : 'needs_subscription',
            ...agentProgramState(ctx, run, canReach(reach, spotAmong(a, depts))),
            ...(canReach(reach, spotAmong(a, depts)) ? failures.get(a.id)! : { retry: null, failure: null, obsolete: null }),
            held: holds.get(a.id)!,
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
          return role ? [{ id, title: role.title, description: role.description, kind: role.kind, gate: role.gate, schema: role.schema }] : [];
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
    const map = await mapLines(db, me.companyId, cards);
    const reworks = await reworksSeen(db, me.companyId, map.serverNow, viewer);
    const linesOf = reachedLines(linesSeen(viewer, map.lines), reach, allAgents, depts);
    const inside = (id: string) => waysInside(viewer, ways, id);

    return {
      company,
      serverNow: map.serverNow.toISOString(),
      live: liveWays(viewer, ways),
      workLines: linesOf('department'),
      orchestrator: orchestrator && {
        id: orchestrator.id,
        name: orchestrator.name,
        model: orchestrator.model,
        effort: (orchestrator.subscriptionId && subs.has(orchestrator.subscriptionId) && effortShown(subs.get(orchestrator.subscriptionId)!, orchestrator, ORCHESTRATOR_EFFORT)) || null,
        context: orchestrator.contextUsed,
        ...agentProgramState(ctx, running.find(j => j.agentId === orchestrator.id), reach.whole),
        ...(reach.whole ? failures.get(orchestrator.id)! : { retry: null, failure: null, obsolete: null }),
        /* His plan is at its limit until then: he waits for the reset on it, and the CEO decides whether he moves. */
        limitUntil: limitOfPlan(orchestrator.subscriptionId ? subs.get(orchestrator.subscriptionId) : undefined),
        held: holds.get(orchestrator.id)!,
        subscription: orchestrator.subscriptionId ? await subView(db, node => hub.isOnline(node), orchestrator.subscriptionId, me) : null,
        machine: await machineOf(db, (await programNode(ctx, orchestrator.id))?.node ?? null),
      },
      agents: { total: allAgents.length, working: await workingSeen(db, me.companyId, viewer) },
      turn: turn ?? null,
      people: nextToCeo.map(p =>
        p.scopeKind === 'company'
          ? { ...views.get(p.id)!, deputy: false }
          : { ...views.get(p.id)!, deputy: true, departments: homes.get(p.id)! },
      ),
      /* Products are departments inside a department; the map shows only the top level and lists the products on it. */
      departments: await Promise.all(topDepts.map(async d => ({
          id: d.id,
          name: d.name,
          templateKey: d.templateKey,
          workMode: d.workMode,
          turnProgress: await departmentProgress(db, open, viewer, d, { departments: depts, teams: allTeams }),
          roleCode: d.roleCode,
          about: d.about,
          ownerPersonId: ownerOf(owners, d.id),
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
          reworkAt: reworkAt(reworks, d.id),
        }))),
    };
  });
}
