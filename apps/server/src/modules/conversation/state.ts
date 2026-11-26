import { orchestratorOf } from './turn-records.js';
import { budgetUntil, modelLimitUntil } from './limits.js';
import { placement, outdated, holdsWork, liveSubscription, programNode, conversationOf, lookRoom, type Placement } from './placement.js';
import { countOnly, idOnly } from '../../db/selections.js';
import type { MachineDrain } from '@hornhoof/protocol';
import { limitsForModel, type Limits } from '@hornhoof/protocol';
import { and, asc, eq, isNotNull, ne, or } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs } from '../../db/schema.js';
import type { TurnRefusal } from '../terminals/relay.js';
import { nodeDrain, nodeHeld } from '../updates/drain.js';
import { nodeIdentity, ownBuiltin, type NodeIdentity } from '../nodes/hub.js';
import { planNodes, type NodeRow } from '../nodes/nodes.js';
import { agentProgramState } from '../tasks/program-state.js';
import { type TurnAlarm, type TurnProgram } from '../tasks/silent.js';
import { subscriptionWait, type SubscriptionWait } from './subscription-room.js';
import { agentFailureState, type FailureState } from '../tasks/failure-records.js';
export type PlanHold = { reason: 'limit' | 'budget'; since: string; until: string };

export type AgentState = FailureState & {
  ready: boolean;
  machineDrain: MachineDrain | null;
  /* Its turns would start its program on a machine whose kernel killed a process for want of memory since its node's
     report before, so they wait and go on by themselves with a report that finds no new kill. */
  memoryWait: boolean;
  subscriptionWait: SubscriptionWait | null;
  /* Its plan is at its limit until then: its turns wait in line, and people may still write to it. */
  limitUntil: string | null;
  /* Its plan used the share set for tasks until then: workers' task turns wait, people's own messages still go. */
  budgetUntil: string | null;
  /* The oldest turn its plan holds, and why. */
  held: PlanHold | null;
  reason: 'no_subscription' | 'waiting_machine' | 'needs_login' | 'needs_setup' | 'node_outdated' | 'machine_offline' | null;
  browserError: string | null;
  busy: boolean;
  runningJobId: string | null;
  queued: number;
  /* Its node shows the agent's live terminal. */
  terminal: boolean;
  /* Why the last prompt its program took has no turn, until a new turn begins. */
  turnRefused: TurnRefusal | null;
  program: TurnProgram | null;
  alarm: TurnAlarm | null;
};

/* model: the one it runs on, whose group of the plan's limits holds its turns; '' for its program's default. */
export type PlanAgent = { id: string; kind: string; model: string };
export type Plan = { limits: Limits | null; limitsUpdatedAt: Date | null; budget: number | null };
export type HeldPlanTurn = PlanHold & { job: typeof jobs.$inferSelect };

export const workerBudgetUntil = (agent: { kind: string; model: string }, sub: Plan): string | null => agent.kind === 'worker' ? budgetUntil(limitsForModel(sub.limits, agent.model), sub.budget, sub.limitsUpdatedAt) : null;

/* The oldest turn the plan really holds. Heads and the orchestrator keep coordinating work above the task share. */
export async function planHeld(ctx: Ctx, agent: PlanAgent, sub: Plan | null | undefined): Promise<HeldPlanTurn | null> {
  if (!sub) return null;
  const until = modelLimitUntil(sub, agent.model);
  const spent = workerBudgetUntil(agent, sub);
  const reason = until ? 'limit' : spent ? 'budget' : null;
  if (!reason) return null;
  const held = reason === 'limit' ? or(isNotNull(jobs.taskId), isNotNull(jobs.createdBy), ne(jobs.prompt, '')) : isNotNull(jobs.taskId);
  const [job] = await ctx.db.select().from(jobs).where(and(conversationOf(agent.id), eq(jobs.status, 'queued'), held)).orderBy(asc(jobs.createdAt)).limit(1);
  return job ? { reason, since: job.createdAt.toISOString(), until: until ?? spent!, job } : null;
}

export const planHoldView = (held: HeldPlanTurn | null): PlanHold | null => held && { reason: held.reason, since: held.since, until: held.until };

export async function orchestratorState(ctx: Ctx, companyId: string): Promise<AgentState> {
  const agent = await orchestratorOf(ctx, companyId);
  if (!agent) return { ready: false, machineDrain: null, memoryWait: false, subscriptionWait: null, limitUntil: null, budgetUntil: null, held: null, reason: 'no_subscription', browserError: null, busy: false, runningJobId: null, queued: 0, terminal: false, turnRefused: null, program: null, alarm: null, retry: null, failure: null, obsolete: null };
  return agentState(ctx, agent.id);
}

/* A node that waits or restarts for an update is not away: it comes back by itself, and its turns wait in line for it. */
export const notAway = (ctx: Ctx, node: NodeIdentity): boolean => ctx.hub.isReady(node) || nodeHeld(ctx, node);

/* Why the agent's turns cannot go out now, or null when they can: a plan's go out while one of its machines can take them,
   and otherwise wait for what its own machine waits for, or one of the plan's that is online, or its first. One with work
   in progress waits for its own machine alone. */
export async function waitsFor(ctx: Ctx, agent: { id: string; nodeId: string | null }, sub: { id: string; kind: 'personal' | 'api_key' }): Promise<AgentState['reason']> {
  if (sub.kind === 'api_key') return ctx.hub.builtins().length > 0 || notAway(ctx, ownBuiltin(ctx.config)) ? null : 'machine_offline';
  const all = await planNodes(ctx.db, [sub.id]);
  if (!all.length) return 'waiting_machine';
  const why = (n: NodeRow): AgentState['reason'] => (n.status !== 'ready' ? n.status : outdated(n.version) ? 'node_outdated' : notAway(ctx, nodeIdentity(n.id)) ? null : 'machine_offline');
  const own = all.find(n => n.id === agent.nodeId);
  if (own && why(own) !== null && (await holdsWork(ctx, agent.id))) return why(own);
  if (all.some(n => why(n) === null)) return null;
  return why(own ?? all.find(n => ctx.hub.isOnline(nodeIdentity(n.id))) ?? all[0]!);
}

/* The same for a plan the agent is not on yet, which a fallback asks of the plan it would go to. */
export const planWaitsFor = waitsFor;

/* The update its next turn waits for: of its own machine or, with that one away, of the one its plan has left. */
export async function drainInTheWay(ctx: Ctx, agent: { nodeId: string | null } | undefined, sub: { id: string; kind: 'personal' | 'api_key' } | null, shown: NodeIdentity | null): Promise<MachineDrain | null> {
  if (!agent || !sub) return null;
  if (sub.kind === 'api_key') return nodeDrain(ctx, ownBuiltin(ctx.config));
  const plan = (await planNodes(ctx.db, [sub.id])).map(n => nodeIdentity(n.id));
  const own = agent.nodeId ? [nodeIdentity(agent.nodeId)] : [];
  return [...(shown ? [shown] : []), ...own, ...plan].map(node => nodeDrain(ctx, node)).find(Boolean) ?? null;
}

/* What its plan holds back now. */
export const planHolds = (sub: Awaited<ReturnType<typeof liveSubscription>>, agent: { kind: string; model: string }) => ({
  limitUntil: sub ? modelLimitUntil(sub, agent.model) : null,
  budgetUntil: sub ? workerBudgetUntil(agent, sub) : null,
});

export async function planState(ctx: Ctx, agent: PlanAgent | undefined, sub: Awaited<ReturnType<typeof liveSubscription>>): Promise<Pick<AgentState, 'limitUntil' | 'budgetUntil' | 'held'>> {
  return {
    ...planHolds(sub, agent ?? { kind: 'worker', model: '' }),
    held: agent ? planHoldView(await planHeld(ctx, agent, sub)) : null,
  };
}

/* The terminal the window opens is of the machine the program is on, or for one not on a machine yet, of the machine its
   next turn would go to, where the window starts it. */
export const shownNode = async (ctx: Ctx, agentId: string, place: Placement | null): Promise<NodeIdentity | null> => (await programNode(ctx, agentId))?.node ?? place?.node ?? null;

/* Whether the agent can answer now and, if not, why; what it is doing and how many turns wait. */
export async function agentState(ctx: Ctx, agentId: string): Promise<AgentState> {
  const [running] = await ctx.db.select(idOnly(jobs)).from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'running'))).limit(1);
  const [waiting] = await ctx.db.select(countOnly()).from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'queued')));
  const sub = await liveSubscription(ctx, agentId);
  const [agent] = sub ? await ctx.db.select({ id: agents.id, kind: agents.kind, model: agents.model, productId: agents.productId, departmentId: agents.departmentId, nodeId: agents.nodeId, builtinMachine: agents.builtinMachine, roleKey: agents.roleKey }).from(agents).where(eq(agents.id, agentId)) : [];
  const reason: AgentState['reason'] = !sub || !agent ? 'no_subscription' : await waitsFor(ctx, agent, sub);
  const place = sub && agent ? await placement(ctx, agent, sub, lookRoom(ctx, agent)) : null;
  const shown = await shownNode(ctx, agentId, place);
  const terminal = Boolean(shown && ctx.hub.hasTerminals(shown));
  const browserError = shown ? ctx.hub.browserErrorOf(shown) : null;
  return {
    ready: reason === null,
    machineDrain: place || reason !== null ? null : await drainInTheWay(ctx, agent, sub, shown),
    memoryWait: !running && !place && reason === null && Boolean(sub && agent && (await placement(ctx, agent, sub, () => true))),
    subscriptionWait: !running && Number(waiting?.n ?? 0) > 0 && sub && agent && place ? await subscriptionWait(ctx, agent, sub, place) : null,
    ...await planState(ctx, agent, sub),
    reason,
    browserError,
    busy: Boolean(running),
    runningJobId: running?.id ?? null,
    queued: Number(waiting?.n ?? 0),
    terminal,
    turnRefused: ctx.terminals.refusal(agentId),
    ...agentProgramState(ctx, running),
    ...await agentFailureState(ctx, agentId),
  };
}
