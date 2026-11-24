import { effortsOf, modelsFor, type ModelOption, type RoleEffort } from '@hornhoof/protocol';
import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { alias } from 'drizzle-orm/pg-core';
import type { Ctx } from '../../app.js';
import { accessOf, agentSpot, canReach } from '../../auth/access.js';
import { requireDepartmentChanger, runsDepartment } from '../../auth/departments.js';
import { actorOf, employeeChangedBy, type Person } from '../../auth/session.js';
import { agentChanges, agents, departments, jobs, people, subscriptions, tasks, teams, telegramBots, type AGENT_CHANGE_FIELDS, type Interruption, type RestartCause } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { ApiError, type ErrorReason } from '../../errors.js';
import { unreadCount } from '../conversation/inbox.js';
import { liveSubscription, programNode } from '../conversation/placement.js';
import { planHeld, planHoldView } from '../conversation/state.js';
import { pump, pumpWaiting } from '../conversation/queue.js';
import { onAgent } from '../conversation/line.js';
import { deptName } from '../departments/templates.js';
import { machineOf } from '../nodes/nodes.js';
import { checkRemoval, tryPlaceOperator } from '../operations/ensure.js';
import { keyEndFor, onlineIn, subViews, type SubView } from '../subscriptions/views.js';
import { endFallback, fallbackOf } from '../subscriptions/fallback.js';
import { agentFailureState, type FailureState } from '../tasks/failure-records.js';
import { CLOSED } from '../tasks/state.js';
import { leaveWork } from '../tasks/engine.js';
import { agentProgramState } from '../tasks/program-state.js';
import { type TurnAlarm, type TurnProgram } from '../tasks/silent.js';
import { backOn, leaveForTeam, leaveIfOff, resumeAgent, wakeAll } from '../tasks/wake.js';
import { orchestratorServing, servingSubscriptions, type Serving } from '../tools/staff.js';
import { modelOnPlan, tierIn } from './role-model.js';
import type { Lang, Role, RoleSkill, Skill } from '../templates/load.js';
import { companySkill } from '../tools/staff.js';
import { agentFor, type AgentRow } from './find.js';
import { instructionsOf, renderInstructions, placeOf, type Part } from './instructions.js';
import { worldSkillsForTheme } from '../world/packs/index.js';
import { TIMER_MAX, TIMER_MIN, TIMER_ORDER_MAX, timerOf } from './timers.js';
import { currentAgentTask } from './work.js';
import { releaseLeftProgram } from './left-programs.js';
import { telegramOf, type TelegramView } from '../telegram/routes.js';
import { offlineMachine, type OfflineMachine } from '../nodes/offline.js';
import { notStep } from '../tools/steps.js';
import { stopSteps } from '../tools/outside.js';

export type AgentCard = FailureState & {
  id: string;
  kind: AgentRow['kind'];
  name: string;
  role: { id: string; title: Lang; description: Lang; effort?: RoleEffort } | null;
  department: { id: string; name: string } | null;
  product: { id: string; name: string } | null;
  team: { id: string; name: string } | null;
  teams: { id: string; name: string }[];
  turnkey: boolean;
  model: string;
  /* The level a person picked, or null to follow its role. */
  effort: string | null;
  subscription: SubView | null;
  /* Hornhoof put it on its subscription for a while, as its own plan is at its limit: that plan, and until when that limit
     holds as far as it is known, after which it goes back between turns. */
  fallback: { home: SubView; until: string | null } | null;
  /* The machine its program is on; none on the built-in node and before it first ran. */
  machine: { id: string; hostname: string } | null;
  /* The machine its plan was heard from last while none of the plan's machines is online; none while it can run. */
  offline: OfflineMachine | null;
  state: 'working' | 'sleeping' | 'needs_subscription';
  currentTask: { id: string; number: number; title: string } | null;
  program: TurnProgram | null;
  alarm: TurnAlarm | null;
  held: ReturnType<typeof planHoldView>;
  skills: { id: string; title: Lang; description: Lang; on: boolean; locked: boolean; overridden: boolean; templateChanged: boolean }[];
  parts: Part[];
  raw: string;
  runsOn: { subscription: SubView; models: ModelOption[] }[];
  changes: { field: string; personName: string | null; actingAgent: { id: string; name: string } | null; byOrchestrator: boolean; at: string; before: unknown; after: unknown }[];
  /* Its latest turns a node restart cut off: why, when, on which node (none for the built-in one) and task, and whether the
     turn was a retry already. */
  interrupted: { job: string; at: string; cause: RestartCause; node: string | null; task: { id: string; number: number } | null; retry: boolean }[];
  /* The whole company or the agent's department may change it; the whole company or the department's owner removes it. */
  canEdit: boolean;
  canRemove: boolean;
  /* How many of its letters wait unread in its inbox, for the counter on its window. */
  inboxUnread: number;
  /* Off for now: it takes no task turns. */
  on: boolean;
  /* Wakes every so many minutes to do its order, and with forWork only while there is work to look at; lastAt is when the
     last round started or was skipped, or when the timer was set. */
  timer: { minutes: number; order: string; forWork: boolean; lastAt: string | null } | null;
  /* The Telegram bot people of the company write to it through, by its name; only heads and the orchestrator have one. */
  telegram: TelegramView;
};

export const AgentPatch = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    model: z.string().max(80).optional(),
    effort: z.string().regex(/^[a-z]{1,16}$/).nullable().optional(),
    subscription: z.uuid().nullable().optional(),
    team: z.uuid().nullable().optional(),
    skills: z.record(z.string().max(80), z.boolean()).optional(),
    base: z.string().nullable().optional(),
    skillText: z.record(z.string().max(80), z.string().nullable()).optional(),
    on: z.boolean().optional(),
    timer: z
      .object({ minutes: z.number().int().min(TIMER_MIN).max(TIMER_MAX), order: z.string().trim().min(1).max(TIMER_ORDER_MAX), forWork: z.boolean().default(false) })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

type Field = (typeof AGENT_CHANGE_FIELDS)[number];

const CHANGES_SHOWN = 20;
const INTERRUPTED_SHOWN = 5;

/* A turn a node restart cut off, as the card lists it: the built-in node goes unnamed. */
type CutRow = { job: string; cut: Interruption | null; retryOf: string | null; taskId: string | null; number: number | null };
const interruptedView = (i: CutRow): AgentCard['interrupted'][number] => ({
  job: i.job,
  at: i.cut!.at,
  cause: i.cut!.cause,
  node: i.cut!.node.id ? i.cut!.node.name : null,
  task: i.taskId ? { id: i.taskId, number: i.number! } : null,
  retry: i.retryOf !== null,
});

async function teamCard(db: Ctx['db'], agent: AgentRow): Promise<Pick<AgentCard, 'team' | 'teams' | 'turnkey'>> {
  if (agent.kind !== 'worker' || !agent.departmentId) return { team: null, teams: [], turnkey: false };
  const deptTeams = await db.select({ id: teams.id, name: teams.name, turnkey: teams.turnkey }).from(teams).where(eq(teams.departmentId, agent.departmentId)).orderBy(asc(teams.createdAt));
  const options = deptTeams.map(({ id, name }) => ({ id, name }));
  return { team: options.find(t => t.id === agent.teamId) ?? null, teams: options, turnkey: deptTeams.some(t => t.id === agent.teamId && t.turnkey) };
}

async function applyTeamPatch(db: Ctx['db'], agent: AgentRow, next: AgentRow, team: string | null | undefined, invalid: (message: string, reason: ErrorReason) => ApiError): Promise<void> {
  if (team === undefined) return;
  if (team !== null) {
    if (agent.kind !== 'worker' || !agent.departmentId) throw invalid('A department head cannot be in a sub-unit.', 'unknown_place');
    const [found] = await db.select(idOnly(teams)).from(teams).where(and(eq(teams.id, team), eq(teams.departmentId, agent.departmentId)));
    if (!found) throw invalid('This sub-unit does not exist in this department.', 'unknown_place');
  }
  next.teamId = team;
}

const SCALAR_FIELDS: [Field, keyof AgentRow][] = [
  ['name', 'name'],
  ['model', 'model'],
  ['effort', 'effort'],
  ['subscription', 'subscriptionId'],
  ['team', 'teamId'],
];

function diffAgent(agent: AgentRow, next: AgentRow): { field: Field; before: unknown; after: unknown }[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const timer = (a: AgentRow) => (a.timerMinutes ? { minutes: a.timerMinutes, order: a.timerOrder, forWork: a.timerForWork } : null);
  const changed: { field: Field; before: unknown; after: unknown }[] = SCALAR_FIELDS.filter(([, key]) => next[key] !== agent[key]).map(([field, key]) => ({ field, before: agent[key], after: next[key] }));
  if (!same(next.skills, agent.skills)) changed.push({ field: 'skills', before: agent.skills, after: next.skills });
  if (!same(next.overrides, agent.overrides)) changed.push({ field: 'prompt', before: agent.overrides, after: next.overrides });
  if (next.switchedOffAt !== agent.switchedOffAt) changed.push({ field: 'switch', before: !agent.switchedOffAt, after: !next.switchedOffAt });
  if (!same(timer(next), timer(agent))) changed.push({ field: 'timer', before: timer(agent), after: timer(next) });
  return changed;
}

async function afterTeamMove(ctx: Ctx, me: Person, before: AgentRow, after: AgentRow): Promise<void> {
  if (before.teamId === after.teamId) return;
  if (after.teamId) await leaveForTeam(ctx, actorOf(me), after);
  else await backOn(ctx, actorOf(me), after.id);
}

const invalid = (message: string, reason: ErrorReason) => new ApiError(400, 'validation', message, reason);

/* The subscriptions the agent may move to: for an employee those that serve its department, for the orchestrator those
   that serve the whole company. */
const servingFor = async (ctx: Ctx, agent: AgentRow): Promise<Serving[]> =>
  agent.kind === 'orchestrator' ? orchestratorServing(ctx, agent.companyId) : servingSubscriptions(ctx, agent.companyId, await agentSpot(ctx.db, agent));

/* People of the employee's department change its card, the whole company changes every card; a team alone only sees it. */
async function mayEdit(ctx: Ctx, me: Person, agent: AgentRow): Promise<boolean> {
  const { db } = ctx;
  if (me.scopeKind === 'company') return true;
  if (agent.kind === 'orchestrator') return false;
  return canReach({ ...(await accessOf(db, me)), teams: new Set() }, await agentSpot(db, agent));
}

/* An assistant's own agent changes on the assistant's card in People, and goes with the assistant. */
const assistantCard = () => new ApiError(409, 'conflict', "An assistant's own agent changes on the assistant's card in People, and goes with the assistant.", 'assistant_agent_card');

async function requireEditor(ctx: Ctx, me: Person, agent: AgentRow): Promise<void> {
  if (agent.kind === 'assistant') throw assistantCard();
  if (!(await mayEdit(ctx, me, agent))) throw new ApiError(403, 'forbidden', "Only people with access to this employee's department or the whole company can change it.", 'not_your_department');
}

/* Changes to one agent go one at a time, each from the agent as the change before it left it. */
async function changing<T>(ctx: Ctx, found: AgentRow, fn: (agent: AgentRow) => Promise<T>): Promise<T> {
  const { db } = ctx;
  return onAgent(ctx, found.id, async () => {
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, found.id), isNull(agents.removedAt)));
    if (!agent) throw new ApiError(404, 'not_found', 'This employee does not exist.', 'agent_unknown');
    return fn(agent);
  });
}

async function cardPlaces(db: Ctx['db'], agent: AgentRow) {
  const ids = [agent.departmentId, agent.productId].filter((id): id is string => Boolean(id));
  const depts = ids.length ? await db.select().from(departments).where(inArray(departments.id, ids)) : [];
  return (id: string | null) => {
    const d = depts.find(x => x.id === id);
    return d ? { id: d.id, name: deptName(d) } : null;
  };
}

function offeredSkills(agent: AgentRow, role: Role | undefined): RoleSkill[] {
  return [...(role?.skills ?? []), ...agent.skills.filter(id => !role?.skills.some(s => s.id === id)).map(id => ({ id, on: true, locked: false }))];
}

function cardSkill(ctx: Ctx, agent: AgentRow, s: RoleSkill): AgentCard['skills'] {
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
}

async function cardServing(ctx: Ctx, agent: AgentRow, views: Map<string, SubView>): Promise<AgentCard['runsOn']> {
  return (await servingFor(ctx, agent)).flatMap(s => {
    const view = views.get(s.id);
    return view ? [{ subscription: view, models: s.models }] : [];
  });
}

function cardSubscription(agent: AgentRow, views: Map<string, SubView>): SubView | null {
  return agent.subscriptionId ? (views.get(agent.subscriptionId) ?? null) : null;
}

async function cardFallback(ctx: Ctx, agent: AgentRow, views: Map<string, SubView>): Promise<AgentCard['fallback']> {
  const on = await fallbackOf(ctx, agent);
  const home = on && views.get(on.home);
  return home ? { home, until: on.until } : null;
}

async function cardMachine(ctx: Ctx, agent: AgentRow): Promise<AgentCard['machine']> {
  return machineOf(ctx.db, (await programNode(ctx, agent.id))?.node ?? null);
}

function cardState(agent: AgentRow, running: boolean): AgentCard['state'] {
  return running ? 'working' : agent.subscriptionId ? 'sleeping' : 'needs_subscription';
}

/* The employee card: who it is, where it runs, its skills and the instructions it runs with, and its latest changes. */
async function card(ctx: Ctx, agent: AgentRow, me: Person): Promise<AgentCard> {
  const { db, hub } = ctx;
  const online = onlineIn(hub, ctx.config);
  const role = agent.roleKey ? ctx.templates.roles.get(agent.roleKey) : undefined;
  const named = await cardPlaces(db, agent);
  const views = new Map((await subViews(db, online, undefined, me)).map(v => [v.id, keyEndFor(me, v)]));
  const [running] = await db.select(idOnly(jobs)).from(jobs).where(and(eq(jobs.agentId, agent.id), eq(jobs.status, 'running'), notStep)).limit(1);
  /* A head's department notebook has its own window and its own access. */
  const place = await placeOf(db, agent);
  const worldSkills = worldSkillsForTheme(ctx.worldPacks, place.theme);
  const { parts, raw } = agent.kind === 'orchestrator' ? await instructionsOf(ctx, agent) : renderInstructions(ctx.templates, agent, place, worldSkills);
  const offered = offeredSkills(agent, role);
  const worldCardSkills: AgentCard['skills'] = worldSkills.map(s => ({
    id: s.id,
    title: s.title,
    description: s.description,
    on: true,
    locked: true,
    overridden: false,
    templateChanged: false,
  }));
  const actingAgent = alias(agents, 'acting_agent');
  const changes = await db
    .select({ field: agentChanges.field, personName: people.name, actingAgent: { id: actingAgent.id, name: actingAgent.name }, byOrchestrator: agentChanges.byOrchestrator, at: agentChanges.createdAt, before: agentChanges.before, after: agentChanges.after })
    .from(agentChanges)
    .leftJoin(people, eq(people.id, agentChanges.personId))
    .leftJoin(actingAgent, eq(actingAgent.id, agentChanges.actingAgentId))
    .where(eq(agentChanges.agentId, agent.id))
    .orderBy(desc(agentChanges.createdAt))
    .limit(CHANGES_SHOWN);
  const interrupted = await db
    .select({ job: jobs.id, cut: jobs.interruption, retryOf: jobs.retryOf, taskId: tasks.id, number: tasks.number })
    .from(jobs)
    .leftJoin(tasks, eq(tasks.id, jobs.taskId))
    .where(and(eq(jobs.agentId, agent.id), isNotNull(jobs.interruption)))
    .orderBy(desc(jobs.finishedAt), desc(jobs.createdAt))
    .limit(INTERRUPTED_SHOWN);
  return {
    id: agent.id,
    kind: agent.kind,
    name: agent.name,
    role: role ? { id: role.id, title: role.title, description: role.description, effort: role.effort } : null,
    department: named(agent.departmentId),
    product: named(agent.productId),
    ...(await teamCard(db, agent)),
    model: agent.model,
    effort: agent.effort,
    subscription: cardSubscription(agent, views),
    fallback: await cardFallback(ctx, agent, views),
    machine: await cardMachine(ctx, agent),
    offline: await offlineMachine(ctx, agent.subscriptionId),
    state: cardState(agent, Boolean(running)),
    currentTask: await currentAgentTask(db, agent, me),
    ...agentProgramState(ctx, running),
    ...await agentFailureState(ctx, agent.id),
    held: planHoldView(await planHeld(ctx, agent, await liveSubscription(ctx, agent.id))),
    skills: [...offered.flatMap(s => cardSkill(ctx, agent, s)), ...worldCardSkills],
    parts,
    raw,
    runsOn: await cardServing(ctx, agent, views),
    changes: changes.map(c => ({ ...c, at: c.at.toISOString() })),
    interrupted: interrupted.map(interruptedView),
    canEdit: await mayEdit(ctx, me, agent),
    canRemove: me.scopeKind === 'company' || (await runsDepartment(db, me, agent.departmentId)),
    inboxUnread: await unreadCount(db, agent.id),
    on: !agent.switchedOffAt,
    timer: timerOf(agent),
    telegram: await telegramOf(db, agent.id),
  };
}

/* Turns that waited for a subscription can go now, with the tasks it missed while it had none. */
export async function afterPlanMove(ctx: Ctx, agent: AgentRow, next: AgentRow): Promise<void> {
  /* A person put it where it works now: it no longer goes back to the plan Hornhoof moved it from. */
  await endFallback(ctx, agent.id);
  if (agent.subscriptionId) await releaseLeftProgram(ctx, agent.id, agent.subscriptionId);
  if (next.subscriptionId && !agent.subscriptionId) await resumeAgent(ctx, agent.id);
  await (agent.kind === 'orchestrator' ? pumpWaiting(ctx) : pump(ctx, agent.id));
  await tryPlaceOperator(ctx, agent.companyId);
}

/* Back on: a checker that can take the waiting stage of a route takes it again and the task turns it missed go out. Off: its work goes back
   once no turn of it runs. */
async function afterSwitch(ctx: Ctx, me: Person, agent: AgentRow, next: AgentRow): Promise<void> {
  if (agent.switchedOffAt && !next.switchedOffAt) await backOn(ctx, actorOf(me), agent.id);
  if (!agent.switchedOffAt && next.switchedOffAt) await leaveIfOff(ctx, agent.id);
}

type PatchBody = z.infer<typeof AgentPatch>;
type PlanRow = typeof subscriptions.$inferSelect;

function requirePatchKind(orchestrator: boolean, body: PatchBody): void {
  if (orchestrator && [body.name, body.skills, body.skillText, body.on, body.timer, body.team].some(v => v !== undefined)) {
    throw invalid("The orchestrator's card changes only the assignment, model, effort and subscription.", 'orchestrator_card');
  }
}

function patchSwitch(agent: AgentRow, next: AgentRow, body: PatchBody): void {
  if (body.on !== undefined && body.on === !!agent.switchedOffAt) next.switchedOffAt = body.on ? null : new Date();
}

function patchTimerValues(next: AgentRow, body: PatchBody): void {
  next.timerMinutes = body.timer?.minutes ?? null;
  next.timerOrder = body.timer?.order ?? null;
  next.timerForWork = body.timer?.forWork ?? false;
}

/* A timer set or moved to another interval counts its first round from now. */
function patchTimer(agent: AgentRow, next: AgentRow, body: PatchBody): void {
  if (body.timer !== undefined) {
    patchTimerValues(next, body);
    if (next.timerMinutes !== agent.timerMinutes) Object.assign(next, { timerAt: body.timer ? new Date() : null, timerNudgedAt: null });
  }
}

async function patchSubscription(ctx: Ctx, agent: AgentRow, next: AgentRow, body: PatchBody, orchestrator: boolean): Promise<void> {
  if (body.subscription !== undefined) {
    if (body.subscription === null) {
      if (orchestrator) throw invalid('The orchestrator needs a subscription.', 'subscription_cannot_serve');
      next.subscriptionId = null;
    } else if (body.subscription !== agent.subscriptionId) {
      if (!(await servingFor(ctx, agent)).some(s => s.id === body.subscription)) {
        throw invalid('This subscription cannot serve where this employee works.', 'subscription_cannot_serve');
      }
      next.subscriptionId = body.subscription;
    }
  }
}

function providerChanged(agent: AgentRow, next: AgentRow, before: PlanRow | undefined, after: PlanRow | undefined): boolean {
  return next.subscriptionId !== agent.subscriptionId && before?.provider !== after?.provider;
}

function patchModel(agent: AgentRow, next: AgentRow, body: PatchBody, plans: { before: PlanRow | undefined; after: PlanRow | undefined }, tier: Role['tier'] | undefined): void {
  const { before, after } = plans;
  /* Another provider's programs do not know this model, so the employee starts on the one its role asks for on the new
     plan, by name, and on that program's Default when it has no role or the plan runs no model Hornhoof knows. */
  if (providerChanged(agent, next, before, after)) next.model = tier && after && body.model === undefined ? modelOnPlan(tier, after) : '';
  if (body.model !== undefined && body.model !== '') {
    if (!after) throw invalid('Pick a subscription before a model.', 'model_unknown');
    const models = modelsFor(after.provider, after.models);
    if (!models.some(m => m.id === body.model)) throw invalid(`${after.label} cannot run ${body.model}.`, 'model_unknown');
  }
  if (body.model !== undefined) next.model = body.model;
}

function validateEffort(next: AgentRow, body: PatchBody, after: PlanRow | undefined, efforts: string[]): void {
  if (body.effort) {
    if (!after) throw invalid('Pick a subscription before an effort.', 'effort_unknown');
    if (!efforts.includes(body.effort)) throw invalid(`${after.label} cannot run ${next.model || 'its default model'} at ${body.effort}.`, 'effort_unknown');
  }
}

function patchEffort(agent: AgentRow, next: AgentRow, body: PatchBody, before: PlanRow | undefined, after: PlanRow | undefined): void {
  /* Another provider names its levels its own way, and a level the new model does not take goes back to the default. */
  const efforts = after ? effortsOf(modelsFor(after.provider, after.models), next.model) : [];
  if (providerChanged(agent, next, before, after)) next.effort = null;
  validateEffort(next, body, after, efforts);
  if (body.effort !== undefined) next.effort = body.effort;
  else if (next.effort && !efforts.includes(next.effort)) next.effort = null;
}

const lockedOff = (role: Role | undefined, id: string, on: boolean) => !on && role?.skills.some(s => s.id === id && s.locked);
const companyOnlySkill = (me: Person, next: AgentRow, skill: Skill, id: string, on: boolean) => on && companySkill(skill) && !next.skills.includes(id) && (me.scopeKind !== 'company' || me.viaHead === true);

function patchSkill(ctx: Ctx, me: Person, next: AgentRow, role: Role | undefined, id: string, on: boolean): void {
  const skill = ctx.templates.skills.get(id);
  if (!skill) throw invalid(`There is no skill ${id}.`, 'skill_unknown');
  if (lockedOff(role, id, on)) throw invalid(`${id} is locked on for this role.`, 'skill_locked');
  /* A skill that grants tools shows the whole company through this employee, so only people who see it turn one on. */
  if (companyOnlySkill(me, next, skill, id, on)) {
    throw new ApiError(403, 'forbidden', `Only people who see the whole company can turn on ${id}.`, 'skill_company_only');
  }
  if (on && !next.skills.includes(id)) {
    next.skills.push(id);
    next.templateHashes[id] ??= skill.hash;
  }
  if (!on) next.skills = next.skills.filter(s => s !== id);
}

function patchOverrides(ctx: Ctx, next: AgentRow, body: PatchBody): void {
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
}

async function savePatch(db: Ctx['db'], me: Person, agent: AgentRow, next: AgentRow, changed: ReturnType<typeof diffAgent>): Promise<AgentRow> {
  if (changed.length) {
    return db.transaction(async tx => {
      const fields = new Set(changed.map(c => c.field));
      const resetTimer = next.timerMinutes !== agent.timerMinutes;
      const [saved] = await tx.update(agents).set({
        name: fields.has('name') ? next.name : undefined,
        model: fields.has('model') ? next.model : undefined,
        effort: fields.has('effort') ? next.effort : undefined,
        subscriptionId: fields.has('subscription') ? next.subscriptionId : undefined,
        teamId: fields.has('team') ? next.teamId : undefined,
        skills: fields.has('skills') ? next.skills : undefined,
        overrides: fields.has('prompt') ? next.overrides : undefined,
        templateHashes: fields.has('skills') ? next.templateHashes : undefined,
        switchedOffAt: fields.has('switch') ? next.switchedOffAt : undefined,
        timerMinutes: resetTimer ? next.timerMinutes : undefined,
        timerOrder: fields.has('timer') ? next.timerOrder : undefined,
        timerAt: resetTimer ? next.timerAt : undefined,
        timerNudgedAt: resetTimer ? next.timerNudgedAt : undefined,
        timerForWork: fields.has('timer') ? next.timerForWork : undefined,
      }).where(eq(agents.id, agent.id)).returning();
      await tx.insert(agentChanges).values(changed.map(c => ({ companyId: agent.companyId, agentId: agent.id, ...employeeChangedBy(me), ...c })));
      return saved!;
    });
  }
  return next;
}

/* Applies a card change to the agent as it is now and records each changed field. */
async function patched(ctx: Ctx, me: Person, agent: AgentRow, body: z.infer<typeof AgentPatch>): Promise<{ agent: AgentRow; next: AgentRow; changed: boolean }> {
  const { db } = ctx;
  const orchestrator = agent.kind === 'orchestrator';
  requirePatchKind(orchestrator, body);
  const next: AgentRow = { ...agent, skills: [...agent.skills], overrides: { ...agent.overrides, skills: { ...agent.overrides.skills } }, templateHashes: { ...agent.templateHashes } };
  if (body.name !== undefined) next.name = body.name;
  await applyTeamPatch(db, agent, next, body.team, invalid);
  patchSwitch(agent, next, body);
  patchTimer(agent, next, body);

  await patchSubscription(ctx, agent, next, body, orchestrator);
  const [before] = agent.subscriptionId ? await db.select().from(subscriptions).where(eq(subscriptions.id, agent.subscriptionId)) : [];
  const [after] = next.subscriptionId ? await db.select().from(subscriptions).where(eq(subscriptions.id, next.subscriptionId)) : [];
  const role = agent.roleKey ? ctx.templates.roles.get(agent.roleKey) : undefined;
  const [team] = next.teamId ? await db.select(only(teams, 'turnkey')).from(teams).where(eq(teams.id, next.teamId)) : [];
  patchModel(agent, next, body, { before, after }, role && tierIn(role, team));
  patchEffort(agent, next, body, before, after);

  for (const [id, on] of Object.entries(body.skills ?? {})) patchSkill(ctx, me, next, role, id, on);
  patchOverrides(ctx, next, body);

  /* One row per changed field, with who changed it. */
  const changed = diffAgent(agent, next);
  const saved = await savePatch(db, me, agent, next, changed);
  return { agent, next: saved, changed: changed.length > 0 };
}

type AgentRequest = Awaited<ReturnType<typeof agentFor>>;

async function getAgent(ctx: Ctx, { me, agent }: AgentRequest): Promise<AgentCard> {
  return card(ctx, agent, me);
}

async function patchAgent(ctx: Ctx, req: FastifyRequest, { me, agent: found }: AgentRequest): Promise<AgentCard> {
  await requireEditor(ctx, me, found);
  const body = AgentPatch.parse(req.body);
  const { agent, next, changed } = await changing(ctx, found, agent => patched(ctx, me, agent, body));
  if (changed) {
    ctx.bus.publish(agent.companyId, { type: 'org' });
    /* Who sees it goes by its plan and its place, and those who watch its terminal hear at once. */
    if (next.subscriptionId !== agent.subscriptionId || next.teamId !== agent.teamId) ctx.bus.accessChanged(agent.companyId);
    if (next.subscriptionId !== agent.subscriptionId) await afterPlanMove(ctx, agent, next);
    await afterSwitch(ctx, me, agent, next);
    await afterTeamMove(ctx, me, agent, next);
  }
  return card(ctx, next, me);
}

/* Reset template abilities and effort. Personal assignment, model and subscription stay. */
async function resetAgent(ctx: Ctx, { me, agent: found }: AgentRequest): Promise<AgentCard> {
  const { db } = ctx;
  await requireEditor(ctx, me, found);
  const reset = await changing(ctx, found, async agent => {
    const role = agent.roleKey ? ctx.templates.roles.get(agent.roleKey) : undefined;
    if (!role) throw invalid('This agent has no role template to go back to.', 'no_role');
    const skills = role.skills.filter(s => s.on).map(s => s.id);
    const overrides = agent.overrides.base === undefined ? {} : { base: agent.overrides.base };
    const templateHashes = Object.fromEntries([[role.id, role.hash], ...skills.map(id => [id, ctx.templates.skills.get(id)!.hash])]);
    await db.transaction(async tx => {
      await tx.update(agents).set({ skills, overrides, templateHashes, effort: null }).where(eq(agents.id, agent.id));
      await tx.insert(agentChanges).values({ companyId: agent.companyId, agentId: agent.id, ...employeeChangedBy(me), field: 'reset', before: { skills: agent.skills, overrides: agent.overrides, effort: agent.effort }, after: { skills, overrides, effort: null } });
    });
    return { ...agent, skills, overrides, templateHashes, effort: null };
  });
  ctx.bus.publish(reset.companyId, { type: 'org' });
  return card(ctx, reset, me);
}

/* An employee leaves the company: its history stays, its waiting turns end. Never while it works, never the orchestrator.
   The whole company removes any, a department's owner those of their department. */
async function removeAgent(ctx: Ctx, { me, agent: found }: AgentRequest, reply: FastifyReply) {
  const { db } = ctx;
  if (found.kind === 'assistant') throw assistantCard();
  await requireDepartmentChanger(db, me, found.departmentId);
  if (found.kind === 'orchestrator') throw new ApiError(403, 'forbidden', 'The orchestrator stays with the company.', 'orchestrator_locked');
  await changing(ctx, found, async agent => {
    const [running] = await db.select(idOnly(jobs)).from(jobs).where(and(eq(jobs.agentId, agent.id), eq(jobs.status, 'running'), notStep)).limit(1);
    if (running) throw new ApiError(409, 'conflict', 'This employee is working. Stop it first.', 'agent_working');
    /* A task it holds or does would wait for it for good. */
    const held = await db
      .select(only(tasks, 'number'))
      .from(tasks)
      .where(and(eq(tasks.assigneeAgentId, agent.id), notInArray(tasks.status, [...CLOSED])))
      .orderBy(asc(tasks.number));
    if (held.length) {
      const list = held.map(t => `#${t.number}`).join(', ');
      throw new ApiError(409, 'conflict', `${agent.name} works on ${list}. Wait until they are done or cancel them, then remove ${agent.name}.`, 'agent_has_tasks');
    }
    const ended = await db.transaction(async tx => {
      await checkRemoval(ctx, tx, agent);
      await tx.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, agent.id));
      /* Its bot goes with it, and with the bot what it still owed to chats. */
      await tx.delete(telegramBots).where(eq(telegramBots.agentId, agent.id));
      const ended = await tx
        .update(jobs)
        .set({ status: sql`case when ${jobs.status} = 'queued' then 'obsolete' else 'failed' end`, error: 'removed', finishedAt: new Date() })
        .where(and(eq(jobs.agentId, agent.id), or(eq(jobs.status, 'queued'), and(eq(jobs.status, 'running'), eq(jobs.kind, 'tools')))))
        .returning({ id: jobs.id, kind: jobs.kind, subscriptionId: jobs.subscriptionId, nodeId: jobs.nodeId, builtinMachine: jobs.builtinMachine });
      await tx.insert(agentChanges).values({ companyId: agent.companyId, agentId: agent.id, ...employeeChangedBy(me), field: 'removed', before: null, after: null });
      return ended;
    });
    await stopSteps(ctx, ended.filter(job => job.kind === 'tools'));
    const left = await leaveWork(ctx, actorOf(me), agent);
    await wakeAll(ctx, left.wakes);
  });
  await ctx.telegram.refresh([found.id]);
  ctx.bus.publish(found.companyId, { type: 'org' });
  return reply.code(204).send();
}

export function agentRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/agents/:id', async req => getAgent(ctx, await agentFor(ctx, req)));
  app.patch('/api/agents/:id', async req => patchAgent(ctx, req, await agentFor(ctx, req)));
  app.post('/api/agents/:id/reset', async req => resetAgent(ctx, await agentFor(ctx, req)));
  app.delete('/api/agents/:id', async (req, reply) => removeAgent(ctx, await agentFor(ctx, req), reply));
}
