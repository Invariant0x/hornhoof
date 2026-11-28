import { onAgent } from './line.js';
import { idOnly } from '../../db/selections.js';
import { and, count, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs, nodes, subscriptions, tasks, type AgentKind } from '../../db/schema.js';
import { nodeHeldFrom, nodeHeldLong } from '../updates/drain.js';
import { builtinOf, identityOf, nodeIdentity, ownBuiltin, sameNode, type NodeIdentity } from '../nodes/hub.js';
import { liveNode, planNodes, type NodeRow } from '../nodes/nodes.js';
import { pickBuiltin } from '../nodes/builtin.js';
import { roomFor } from '../nodes/program-room.js';
import { ABOUT_AS_FREE, freedom } from '../testruns/pick.js';
import { nodesOnHold } from '../program-operator/start-holds.js';
import { heldMachines, installingMachines, nextToInstall, nextToInstallHolds } from '../network/follow.js';
export const conversationOf = (agentId: string) => and(eq(jobs.agentId, agentId), eq(jobs.kind, 'conversation'));

export async function liveSubscription(ctx: { db: Pick<Ctx['db'], 'select'> }, agentId: string) {
  const [row] = await ctx.db.select({ sub: subscriptions }).from(agents).innerJoin(subscriptions, eq(subscriptions.id, agents.subscriptionId)).where(and(eq(agents.id, agentId), isNull(agents.removedAt)));
  return row && !row.sub.removedAt ? row.sub : null;
}

/* A node and the owner of the subscription it runs: the person who may type into the agent's terminal there. */
export type ProgramNode = { node: NodeIdentity; ownerPersonId: string; planId: string };

export const JOB_PLAN = { id: subscriptions.id, kind: subscriptions.kind, ownerPersonId: subscriptions.ownerPersonId, nodeId: jobs.nodeId, builtinMachine: jobs.builtinMachine };

/* A program stays up after its last turn, on the plan that turn ran on, until a turn of another plan takes its place. Company
   keys share the built-in node, so a window there shows that plan's program, even when the agent is on another key by now. A
   personal plan has nodes of its own, with no other plan's program on them. */
export async function stayedProgram(ctx: Ctx, agentId: string, planId: string) {
  const [last] = await ctx.db
    .select(JOB_PLAN)
    .from(jobs)
    .innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
    .where(and(conversationOf(agentId), isNotNull(jobs.startedAt), eq(subscriptions.kind, 'api_key')))
    .orderBy(desc(jobs.startedAt))
    .limit(1);
  return last && last.id !== planId ? last : null;
}

/* The plan that holds the agent's program now, with the node it is on: the one its running turn went out to, since that
   turn goes on there when the agent moves, or else its own and its live node there, unless another plan's program stayed
   up there. */
export async function programPlan(ctx: Ctx, agentId: string) {
  const [running] = await ctx.db
    .select(JOB_PLAN)
    .from(jobs)
    .innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
    .where(and(conversationOf(agentId), eq(jobs.status, 'running')))
    .limit(1);
  if (running) return running;
  const [own] = await ctx.db
    .select({ id: subscriptions.id, kind: subscriptions.kind, ownerPersonId: subscriptions.ownerPersonId, nodeId: nodes.id, builtinMachine: agents.builtinMachine })
    .from(agents)
    .innerJoin(subscriptions, and(eq(subscriptions.id, agents.subscriptionId), isNull(subscriptions.removedAt)))
    .leftJoin(nodes, and(eq(nodes.id, agents.nodeId), eq(nodes.subscriptionId, agents.subscriptionId), liveNode))
    .where(eq(agents.id, agentId));
  return (own?.kind === 'api_key' && (await stayedProgram(ctx, agentId, own.id))) || own;
}

/* The node that holds the agent's program now. A company key's agents are on the built-in node. */
export async function programNode(ctx: Ctx, agentId: string): Promise<ProgramNode | null> {
  const own = await programPlan(ctx, agentId);
  const node = own && identityOf(own, own.nodeId, own.builtinMachine, ownBuiltin(ctx.config));
  return node ? { node, ownerPersonId: own.ownerPersonId, planId: own.id } : null;
}

export const nodeOfAgent = async (ctx: Ctx, agentId: string) => (await programNode(ctx, agentId))?.node ?? null;

/* The node someone who opens the agent's window watches. One that runs no turn starts its program where its next turn
   would go, and keeps that node; while no machine of its plan can take it, the window waits for the first to come back. */
export async function windowNode(ctx: Ctx, agentId: string): Promise<ProgramNode | null> {
  return (await onAgent(ctx, agentId, () => placedProgram(ctx, agentId))) ?? programNode(ctx, agentId);
}

/* Where an agent on a personal plan that runs no turn opens now. Anyone else's stays where it is. */
export async function placedProgram(ctx: Ctx, agentId: string): Promise<ProgramNode | null> {
  const [running] = await ctx.db.select(idOnly(jobs)).from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'running'))).limit(1);
  const sub = running ? null : await liveSubscription(ctx, agentId);
  if (sub?.kind !== 'personal') return null;
  const at = (node: NodeIdentity) => ({ node, ownerPersonId: sub.ownerPersonId, planId: sub.id });
  const place = await nextTurnNode(ctx, agentId, sub);
  if (place) return at(place);
  const [first] = await planNodes(ctx.db, [sub.id]);
  return (await programNode(ctx, agentId)) ?? (first ? at(nodeIdentity(first.id)) : null);
}

/* The machine of its plan the agent's next turn would go to, which it keeps from now on. */
export async function nextTurnNode(ctx: Ctx, agentId: string, sub: Parameters<typeof placement>[2]): Promise<NodeIdentity | null> {
  const [agent] = await ctx.db.select({ id: agents.id, kind: agents.kind, nodeId: agents.nodeId, builtinMachine: agents.builtinMachine, roleKey: agents.roleKey }).from(agents).where(eq(agents.id, agentId));
  const place = agent ? await placement(ctx, agent, sub) : null;
  if (place?.moves) await ctx.db.update(agents).set({ nodeId: place.nodeId, builtinMachine: place.builtinMachine }).where(eq(agents.id, agentId));
  return place?.node ?? null;
}

/* Whether the agent's next turn would go to another node than this one now, as the queue itself would place it: an
     agent that has work in progress on its own node waits for that one, and so goes nowhere else. Nothing is moved. */
export async function goesElsewhere(ctx: Ctx, agentId: string, from: NodeIdentity): Promise<boolean> {
  const sub = await liveSubscription(ctx, agentId);
  if (!sub) return false;
  const [agent] = await ctx.db.select({ id: agents.id, kind: agents.kind, nodeId: agents.nodeId, builtinMachine: agents.builtinMachine, roleKey: agents.roleKey }).from(agents).where(eq(agents.id, agentId));
  const place = agent ? await placement(ctx, agent, sub, lookRoom(ctx, agent)) : null;
  return place !== null && !sameNode(place.node, from);
}
export type AgentTarget = { agent: typeof agents.$inferSelect; sub: NonNullable<Awaited<ReturnType<typeof liveSubscription>>>; programPlanId: string };

export async function agentOnNode(ctx: Ctx, node: NodeIdentity, agentId: string): Promise<AgentTarget | null> {
  const [agent] = await ctx.db.select().from(agents).where(and(eq(agents.id, agentId), isNull(agents.removedAt)));
  const sub = agent ? await liveSubscription(ctx, agent.id) : null;
  const at = sub ? await programNode(ctx, agentId) : null;
  return agent && sub && at && sameNode(at.node, node) ? { agent, sub, programPlanId: at.planId } : null;
}
export function outdated(version: string | null): boolean {
  const have = (version ?? '0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < NODE_FLOOR.length; i++) if ((have[i] ?? 0) !== NODE_FLOOR[i]) return (have[i] ?? 0) < NODE_FLOOR[i]!;
  return false;
}

export const takesTurns = (ctx: Ctx, n: NodeRow): boolean => n.status === 'ready' && !outdated(n.version) && ctx.hub.isReady(nodeIdentity(n.id));

/* moves: the agent has not been on this node until now, or leaves the machine it was on for the built-in node. */
/* builtinMachine: the machine of the built-in node, for an API key's turn. moves: the agent's program is not there yet. */
export type Placement = { node: NodeIdentity; machineId: string; nodeId: string | null; builtinMachine: string | null; moves: boolean };

export type PlacedAgent = { id: string; kind: AgentKind; nodeId: string | null; builtinMachine: string | null; roleKey: string | null };

/* The ones the company waits for while a node waits for an update: a limit holds their turns, see nodeHeldFrom. An
   assistant's own agent works for its owner alone, so it waits as a worker does. */
export const isLeader = (agent: Pick<PlacedAgent, 'kind'>): boolean => agent.kind === 'orchestrator' || agent.kind === 'head';

/* Whether a node has room for the agent's turn, only asked: the agent is not put among the turns that wait for room. */
export const lookRoom = (ctx: Ctx, agent: PlacedAgent) => (node: NodeIdentity) => roomFor(ctx, node, agent.id, true);

/* Where the agent's next turn goes. A company key's to a built-in node: the one its program is on while that is ready,
   else the server's own, else another machine's, which is a move as a plan's agent on another node is; it waits while
   the one picked waits for an update or has no room. A plan's to the node its program is on while
   that one is signed in, connected and new enough, so its folder, session and terminal go on there; otherwise to the
   freest of the plan's nodes that is, unless the agent has work in progress on its own and waits for it. None while no
   node can take it. A turn that would start a new program goes to no machine whose kernel killed a process for want of
   memory since its node's report before; roomy: whether a node has room, which the agent's state also asks as if every
   node had. */
export async function placement(ctx: Ctx, agent: PlacedAgent, sub: { id: string; kind: 'personal' | 'api_key' }, roomy = (node: NodeIdentity) => roomFor(ctx, node, agent.id), accepts?: (node: NodeIdentity, machineId: string) => boolean): Promise<Placement | null> {
  if (sub.kind === 'api_key') {
    const machine = await pickBuiltin(ctx, ctx.db, agent.builtinMachine, accepts ? id => accepts(builtinOf(id), id) : undefined);
    if (!machine) return null;
    const node = builtinOf(machine);
    return !nodeHeldFrom(ctx, node, agent.roleKey, isLeader(agent)) && roomy(node) ? { node, machineId: machine, nodeId: null, builtinMachine: machine, moves: agent.nodeId !== null || agent.builtinMachine !== machine } : null;
  }
  const all = await planNodes(ctx.db, [sub.id]);
  /* A node that cannot write its work folder takes no turn until Operations or the node itself lifts its hold. */
  const onHold = await nodesOnHold(ctx, all.map(n => n.id));
  const candidates = all.filter(n => !onHold.has(n.id) && (!accepts || accepts(nodeIdentity(n.id), n.machineId)));
  const installing = accepts && candidates.length ? await heldForTurn(ctx, agent, candidates) : null;
  const open = installing ? candidates.filter(n => !installing.has(n.machineId)) : candidates;
  const able = open.filter(n => !nodeHeldFrom(ctx, nodeIdentity(n.id), agent.roleKey) && takesTurns(ctx, n) && roomy(nodeIdentity(n.id)));
  const pick = able.find(n => n.id === agent.nodeId) ?? (await waitsForOwnNode(ctx, agent, all) ? null : (await freest(ctx, able)) ?? (await heldNodeFor(ctx, agent, open, roomy)));
  return pick ? { node: nodeIdentity(pick.id), machineId: pick.machineId, nodeId: pick.id, builtinMachine: null, moves: pick.id !== agent.nodeId } : null;
}

/* A next-to-install machine can still take a leader's work under the existing hold rules. */
async function heldForTurn(ctx: Ctx, agent: PlacedAgent, candidates: NodeRow[]): Promise<Set<string>> {
  if (!isLeader(agent)) return heldMachines(ctx);
  const installing = await installingMachines(ctx.db, ctx.config);
  const next = await nextToInstall(ctx);
  const node = candidates.find(candidate => candidate.machineId === next?.id);
  if (node && await nextToInstallHolds(ctx, node.id, true)) installing.add(node.machineId);
  return installing;
}

/* Whether the agent has work in progress on a node of its plan and waits for that one: not the orchestrator or a head whom
   an update kept off it past their limit, who go to another machine of the plan when one can take them. */
export async function waitsForOwnNode(ctx: Ctx, agent: PlacedAgent, all: NodeRow[]): Promise<boolean> {
  if (!all.some(n => n.id === agent.nodeId)) return false;
  if (isLeader(agent) && nodeHeldLong(ctx, nodeIdentity(agent.nodeId!))) return false;
  return holdsWork(ctx, agent.id);
}

/* With no other machine, the node an update keeps the orchestrator's or a head's turn off past their limit: its own, if it
   is one of those. */
export async function heldNodeFor(ctx: Ctx, agent: PlacedAgent, all: NodeRow[], roomy: (node: NodeIdentity) => boolean): Promise<NodeRow | null> {
  if (!isLeader(agent)) return null;
  const open = all.filter(n => !nodeHeldFrom(ctx, nodeIdentity(n.id), agent.roleKey, true) && takesTurns(ctx, n) && roomy(nodeIdentity(n.id)));
  return open.find(n => n.id === agent.nodeId) ?? freest(ctx, open);
}

/* Whether the agent holds a task it works on, or stopped on to ask: its folder may hold work it has not pushed, so it
   waits for its own machine, and a laptop that sleeps a while does not scatter the team. */
export async function holdsWork(ctx: Ctx, agentId: string): Promise<boolean> {
  const [held] = await ctx.db.select(idOnly(tasks)).from(tasks).where(and(eq(tasks.assigneeAgentId, agentId), inArray(tasks.status, ['working', 'blocked']))).limit(1);
  return Boolean(held);
}

/* The node on the machine its nodes say is freest, and of machines about as free the one that holds the fewest agents,
   the older of two alike. */
export async function freest(ctx: Ctx, able: NodeRow[]): Promise<NodeRow | null> {
  if (able.length <= 1) return able[0] ?? null;
  const held = await ctx.db
    .select({ machineId: nodes.machineId, n: count() })
    .from(agents)
    .innerJoin(nodes, eq(nodes.id, agents.nodeId))
    .where(and(isNull(agents.removedAt), inArray(nodes.machineId, able.map(n => n.machineId))))
    .groupBy(nodes.machineId);
  const on = (n: NodeRow) => Number(held.find(h => h.machineId === n.machineId)?.n ?? 0);
  const free = (n: NodeRow) => {
    const load = ctx.hub.loadOf(nodeIdentity(n.id));
    return load ? freedom(load) : null;
  };
  const better = (a: NodeRow, b: NodeRow) => {
    const [x, y] = [free(a), free(b)];
    if (x !== null && y !== null && Math.abs(x - y) >= ABOUT_AS_FREE) return x > y;
    return on(a) < on(b);
  };
  return able.reduce((best, n) => (better(n, best) ? n : best));
}



/* Turns need a node from 0.5.0 on, which clones a repository and writes an agent's skills as files; an older one waits for
   its update. Nodes go to the server's version by themselves from 0.8.4 on. The built-in node always matches the server. */
const NODE_FLOOR = [0, 5, 0];
