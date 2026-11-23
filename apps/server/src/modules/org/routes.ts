import { departmentProgress } from '../tasks/turn-progress.js';
import { defaultEffortOf, effortFor, effortsOf, modelsFor, ORCHESTRATOR_EFFORT, type Limits, type ModelOption, type ProviderId } from '@hornhoof/protocol';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { WHOLE } from '../../auth/access.js';
import { knowsAgentId, seesAgentId, viewerOf, type AgentViewer } from '../../auth/agent-view.js';
import { personColumns, requirePerson } from '../../auth/session.js';
import { agents, companies, departments, people, personAccess, subscriptions, teams, turns } from '../../db/schema.js';
import { employeeOrder } from '../agents/order.js';
import { agentWork } from '../agents/work.js';
import { modelLimitUntil } from '../conversation/limits.js';
import { planHeld, planHoldView } from '../conversation/state.js';
import { programNode } from '../conversation/placement.js';
import { repoView } from '../departments/repository.js';
import { hostsOf } from '../departments/repo-hosts.js';
import { deptName } from '../departments/templates.js';
import { CHANNEL_MS, type Channel, type Endpoint } from '../events/bus.js';
import { workingSeen } from '../events/stream-view.js';
import { machineOf } from '../nodes/nodes.js';
import { departmentOwners } from '../tasks/decision-people.js';
import { pendingFor, visibleDecisions } from '../tasks/decisions.js';
import { seesTask } from '../tasks/visibility.js';
import { shownEchelons } from '../tasks/sight.js';
import { routeSnapshots } from '../tasks/route-records.js';
import { agentFailureStates } from '../tasks/failure-records.js';
import { agentProgramState } from '../tasks/program-state.js';
import { mapLines, type MapLine } from './map-state.js';
import { reworkTimes } from './rework.js';
import { personViews } from '../people/views.js';
import { keyEndFor, onlineIn, subView } from '../subscriptions/views.js';
import { pipelineViews } from '../tracker/pipelines.js';
import { runningCalls } from '../calls/calls.js';

/* Show the level sent to the program, or its own default when Hornhoof knows it. */
function effortShown(sub: { provider: ProviderId; models: ModelOption[] | null }, agent: { model: string; effort: string | null }, roleEffort?: string): string | null {
  const models = modelsFor(sub.provider, sub.models);
  return effortFor(agent.effort, effortsOf(models, agent.model), roleEffort) ?? defaultEffortOf(sub.provider, models, agent.model);
}

type AgentRow = typeof agents.$inferSelect;

function reworkAt(times: ReadonlyMap<string, string>, departmentId: string): string | null {
  return times.get(departmentId) ?? null;
}

/* The lines of work and of results given back, of every place of the company, which everyone sees, and of the agents shown.
   The answer gives a kind's lines, of one department when it is named, without what only the server needs. */
function shownLines(lines: readonly MapLine[], allAgents: readonly AgentRow[]) {
  const shown = lines.filter(l => l.kind === 'department' || allAgents.some(a => a.id === l.downstreamAgentId));
  return (kind: MapLine['kind'], departmentId?: string) =>
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- strip routing keys used only for filtering
    shown.filter(l => l.kind === kind && (!departmentId || l.departmentId === departmentId)).map(({ kind: _, departmentId: __, ...line }) => line);
}

/* The person who takes a department's approvals; null means the CEO. */
const ownerOf = (owners: ReadonlyMap<string, string>, departmentId: string) => owners.get(departmentId) ?? null;

const teamField = (teamId: string | null) => (teamId ? { teamId } : {});

/* Whether a department or one of its products keeps a repository is everyone's, as its work tree says: work without one goes
   in as documents. Where it is stays with the people who set it. */
const keepsRepository = (depts: readonly Pick<typeof departments.$inferSelect, 'id' | 'parentId' | 'repoUrl'>[], id: string) =>
  depts.some(d => (d.id === id || d.parentId === id) && Boolean(d.repoUrl));

/* Until when a plan is at its limit for turns on the model, from what it last read. */
const limitOfPlan = (model: string, plan?: { limits: Limits | null; limitsUpdatedAt: Date | null }) => (plan ? modelLimitUntil(plan, model) : null);

/* A line runs between two agents: it shows when both of its ends are known. */
const linesSeen = (viewer: AgentViewer, lines: readonly MapLine[]) => lines.filter(l => knowsAgentId(viewer, l.upstreamAgentId) && knowsAgentId(viewer, l.downstreamAgentId));

/* The ways between two agents on a department's card, both of them known. */
const waysInside = (viewer: AgentViewer, ways: readonly Channel[], id: string) =>
  ways.flatMap(w =>
    w.from.kind === 'agent' && w.to.kind === 'agent' && w.from.departmentId === id && knowsAgentId(viewer, w.from.id) && knowsAgentId(viewer, w.to.id) ? [{ from: w.from.id, to: w.to.id, at: w.at, ...(w.held ? { held: w.held } : {}) }] : [],
  );

/* The ways over the map run between places: which of them are alive says what the whole company does, for everyone of it. */
const liveWays = (ways: readonly Channel[]) => ways.filter(w => w.from.kind !== 'agent' && w.to.kind !== 'agent');

export function orgRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, hub, templates, bus } = ctx;
  app.get('/api/org', async req => {
    const me = await requirePerson(req, db);
    const [company] = await db
      .select({ id: companies.id, name: companies.name, theme: companies.theme })
      .from(companies)
      .where(eq(companies.id, me.companyId));
    const viewer = await viewerOf(db, me);
    const companyAgents = await db.select().from(agents).where(and(eq(agents.companyId, me.companyId), isNull(agents.removedAt)));
    /* Everything below shows every agent of the company with its state and work, but another person's assistant's own; which
       of them the person opens says opens. */
    const allAgents = companyAgents.filter(a => knowsAgentId(viewer, a.id));
    /* The company's employees: a person's own assistant is no one's but theirs. */
    const employees = allAgents.filter(a => a.kind !== 'assistant');
    const employeeIds = new Set(employees.map(a => a.id));
    const subs = new Map((await db.select({ id: subscriptions.id, provider: subscriptions.provider, apiProtocol: subscriptions.apiProtocol, models: subscriptions.models, limits: subscriptions.limits, limitsUpdatedAt: subscriptions.limitsUpdatedAt, budget: subscriptions.budget }).from(subscriptions).where(eq(subscriptions.companyId, me.companyId))).map(s => [s.id, s]));
    const orchestrator = allAgents.find(a => a.kind === 'orchestrator');
    const active = await db.select(personColumns).from(people).where(and(eq(people.companyId, me.companyId), ne(people.status, 'disabled'))).orderBy(asc(people.createdAt));
    const depts = await db.select().from(departments).where(eq(departments.companyId, me.companyId)).orderBy(asc(departments.position), asc(departments.createdAt));
    const companyPipelines = await pipelineViews(ctx, me.companyId);
    /* What each department works on now: its newest open task without an executor (the head's), else its newest open one. */
    const reach = viewer.access;
    const { openTasks, running, busy, doing } = await agentWork(db, me.companyId);
    const snapshots = await routeSnapshots(db, openTasks.filter(t => seesTask(viewer, t)));
    const currentOf = (id: string) => {
      const mine = openTasks.filter(t => t.departmentId === id && seesTask(viewer, t));
      const t = mine.find(x => !x.executorAgentId) ?? mine[0];
      return t ? { id: t.id, number: t.number, title: t.title } : null;
    };
    /* Only people who see the whole company and a department's owner set its repositories, so only they read where they are. */
    const repositoryOf = (d: (typeof depts)[number]) => (reach.whole || reach.owns?.has(d.parentId ?? d.id) ? repoView(d) : null);
    /* And the key of the git host Hornhoof creates its repositories with, never the key itself. */
    const hosts = await hostsOf(db, me.companyId);
    const repoHostOf = (d: (typeof depts)[number]) => (reach.whole || reach.owns?.has(d.id) ? hosts(d.id) : null);
    /* Each top-level department runs its own turn; a department's card shows its own. */
    const open = await db.select({ id: turns.id, companyId: turns.companyId, departmentId: turns.departmentId, number: turns.number, title: turns.title, goal: turns.goal }).from(turns).where(and(eq(turns.companyId, me.companyId), eq(turns.status, 'open'))).orderBy(asc(turns.number));
    const openOf = (deptId: string) => open.find(o => o.departmentId === deptId);
    /* The earliest open turn by its short name, for readers older than the departments' own turns. */
    const turn = open[0] && { id: open[0].id, number: open[0].number, goal: open[0].title || open[0].goal };
    const allTeams = await db.select().from(teams).where(eq(teams.companyId, me.companyId)).orderBy(asc(teams.stage), asc(teams.createdAt));
    const turnkeyTeams = new Set(allTeams.filter(t => t.turnkey).map(t => t.id));
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
            turnkey: a.teamId !== null && turnkeyTeams.has(a.teamId),
            title: role?.title ?? null,
            kind: a.kind,
            model: a.model,
            modelName: (a.model && sub && modelsFor(sub.provider, sub.models).find(m => m.id === a.model)?.name) || null,
            provider: sub?.provider ?? null,
            ...(sub?.apiProtocol ? { apiProtocol: sub.apiProtocol } : {}),
            effort: sub ? effortShown(sub, a, role?.effort) : null,
            state: busy.has(a.id) ? 'working' : a.subscriptionId ? 'sleeping' : 'needs_subscription',
            ...agentProgramState(ctx, run),
            ...failures.get(a.id)!,
            held: holds.get(a.id)!,
            context: a.contextUsed,
            status: now.status,
            on: !a.switchedOffAt,
            /* How often it wakes on its timer, in minutes. */
            timer: a.timerMinutes,
            /* Whether this person opens its window and card. */
            opens: seesAgentId(viewer, a.id),
            /* Like the department's current task. */
            task: now.task && seesTask(viewer, now.task) ? { id: now.task.id, number: now.task.number, title: now.task.title, echelons: shownEchelons(viewer, snapshots.get(now.task.id)!, now.task.departmentId) } : null,
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
    /* When a department's work last came back counts the work of all of its agents, which everyone sees. */
    const reworks = await reworkTimes(db, me.companyId, map.serverNow, WHOLE);
    const linesOf = shownLines(linesSeen(viewer, map.lines), allAgents);
    const inside = (id: string) => waysInside(viewer, ways, id);
    /* One-shot calls that wait or run now light their places on the department's routes. */
    const calls = await runningCalls(ctx, me.companyId);
    const callsOf = (deptId: string) => {
      const ids = new Set([deptId, ...depts.filter(p => p.parentId === deptId).map(p => p.id)]);
      return calls.filter(c => c.departmentId && ids.has(c.departmentId));
    };
    const pipelinesOf = (id: string) => companyPipelines
      .filter(p => !p.archived && topOf(p.department.id) === id)
      .map(p => ({ ...p, stages: p.stages.map(({ handoffTo, ...stage }) => {
        const handoffs = topDepts.filter(target => target.id !== id && target.templateKey && handoffTo?.includes(target.templateKey))
          .map(({ id, name, templateKey }) => ({ id, name, templateKey }));
        const ownerTitle = stage.ownerRole ? templates.roles.get(stage.ownerRole)?.title : undefined;
        const owner = stage.owner && employeeIds.has(stage.owner.id) ? stage.owner : null;
        return { ...stage, owner, ownerTitle, handoffs };
      }) }));

    return {
      company,
      serverNow: map.serverNow.toISOString(),
      live: liveWays(ways),
      workLines: linesOf('department'),
      orchestrator: orchestrator && {
        id: orchestrator.id,
        name: orchestrator.name,
        model: orchestrator.model,
        effort: (orchestrator.subscriptionId && subs.has(orchestrator.subscriptionId) && effortShown(subs.get(orchestrator.subscriptionId)!, orchestrator, ORCHESTRATOR_EFFORT)) || null,
        context: orchestrator.contextUsed,
        /* His state shows on the map's circle to everyone; his window, plan and machine to those who open him. */
        opens: seesAgentId(viewer, orchestrator.id),
        ...agentProgramState(ctx, running.find(j => j.agentId === orchestrator.id)),
        ...failures.get(orchestrator.id)!,
        /* His plan is at its limit until then: he waits for the reset on it, and the CEO decides whether he moves. */
        limitUntil: limitOfPlan(orchestrator.model, orchestrator.subscriptionId ? subs.get(orchestrator.subscriptionId) : undefined),
        held: holds.get(orchestrator.id)!,
        /* Whether he has a plan to work on, which everyone may know; which plan it is goes only to those who open him. */
        planned: Boolean(orchestrator.subscriptionId && subs.has(orchestrator.subscriptionId)),
        subscription: orchestrator.subscriptionId && seesAgentId(viewer, orchestrator.id) ? await subView(db, onlineIn(hub, ctx.config), orchestrator.subscriptionId, me).then(v => v && keyEndFor(me, v)) : null,
        machine: seesAgentId(viewer, orchestrator.id) ? await machineOf(db, (await programNode(ctx, orchestrator.id))?.node ?? null) : null,
      },
      agents: { total: employees.length, working: await workingSeen(db, me.companyId) },
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
          turnProgress: await departmentProgress(db, openOf(d.id), viewer),
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
          keepsRepository: keepsRepository(depts, d.id),
          repoHost: repoHostOf(d),
          teams: allTeams
            .filter(t => t.departmentId === d.id)
            .map(t => ({ id: t.id, name: t.name, about: t.about, stage: t.stage, gate: t.gate, urgentOnly: t.urgentOnly, turnkey: t.turnkey })),
          live: inside(d.id),
          workLines: linesOf('member', d.id),
          reworkAt: reworkAt(reworks, d.id),
          pipelines: pipelinesOf(d.id),
          calls: callsOf(d.id),
        }))),
    };
  });
}
