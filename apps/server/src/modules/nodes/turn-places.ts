import { and, asc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { jobs, machines, nodes, tasks } from '../../db/schema.js';
import { countOnly, idOnly } from '../../db/selections.js';
import { loggable } from '../../errors.js';
import { keyOf, type NodeIdentity } from './hub.js';

/* A machine's limit of agents' turns at once. Past it a new turn does not start: it stays in its agent's line, and the
   machine keeps the agents whose turns wait for a place on it. A place frees when a turn there ends, breaks or is stopped,
   and when the limit goes up; the waiting turns are then tried again, first come first served, an urgent task's ahead of
   the rest. A limit that goes down stops nothing that runs. */

type Reader = Pick<Db, 'select'>;
type Limited = { id: string; limit: number; networkId: string | null };
/* Where an agent's oldest waiting turn stands in a machine's line. */
type Rank = { agentId: string; urgent: boolean; since: number };

/* The agents whose turns wait for a place on each machine, each with the mark of the last time it was refused one. */
const lines = new WeakMap<Ctx, Map<string, Map<string, number>>>();
let marks = 0;

function linesOf(ctx: Ctx): Map<string, Map<string, number>> {
  const all = lines.get(ctx) ?? new Map<string, Map<string, number>>();
  lines.set(ctx, all);
  return all;
}

function lineOf(ctx: Ctx, machineId: string): Map<string, number> {
  const all = linesOf(ctx);
  const line = all.get(machineId) ?? new Map<string, number>();
  all.set(machineId, line);
  return line;
}

/* The machines with a limit of turns that these nodes are on, by the node's key: a plan's node by its machine, a built-in
   one by the network id of the machine it runs on. */
async function limitsOf(db: Reader, places: readonly NodeIdentity[]): Promise<Map<string, Limited>> {
  const nodeIds = places.flatMap(p => (p.kind === 'node' ? [p.nodeId] : []));
  const builtins = places.flatMap(p => (p.kind === 'builtin' ? [p.machine] : []));
  const found = new Map<string, Limited>();
  if (nodeIds.length) {
    const rows = await db.select({ node: nodes.id, id: machines.id, limit: machines.turnLimit, networkId: machines.networkId }).from(nodes).innerJoin(machines, eq(machines.id, nodes.machineId))
      .where(and(inArray(nodes.id, nodeIds), isNotNull(machines.turnLimit), isNull(machines.revokedAt)));
    for (const row of rows) found.set(row.node, { id: row.id, limit: row.limit!, networkId: row.networkId });
  }
  if (builtins.length) {
    const rows = await db.select({ id: machines.id, limit: machines.turnLimit, networkId: machines.networkId }).from(machines)
      .where(and(inArray(machines.networkId, builtins), isNotNull(machines.turnLimit), isNull(machines.revokedAt)));
    for (const row of rows) found.set(keyOf({ kind: 'builtin', machine: row.networkId! }), { id: row.id, limit: row.limit!, networkId: row.networkId });
  }
  return found;
}

/* The agents' turns that run on the machine now, over all its nodes and its built-in one. */
async function runningOn(db: Reader, machine: Pick<Limited, 'id' | 'networkId'>): Promise<number> {
  const onNodes = db.select(idOnly(nodes)).from(nodes).where(eq(nodes.machineId, machine.id));
  const there = machine.networkId ? or(inArray(jobs.nodeId, onNodes), eq(jobs.builtinMachine, machine.networkId)) : inArray(jobs.nodeId, onNodes);
  const [row] = await db.select(countOnly()).from(jobs).where(and(eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'), there));
  return Number(row?.n ?? 0);
}

/* Each agent's oldest waiting turn: since when it waits, and whether it is for an urgent task. An agent with no turn
   waiting has none. */
async function ranksOf(db: Reader, agentIds: readonly string[]): Promise<Map<string, Rank>> {
  if (!agentIds.length) return new Map();
  const rows = await db.select({ agentId: jobs.agentId, at: jobs.createdAt, urgent: tasks.urgent }).from(jobs).leftJoin(tasks, eq(tasks.id, jobs.taskId))
    .where(and(eq(jobs.kind, 'conversation'), eq(jobs.status, 'queued'), inArray(jobs.agentId, [...agentIds]))).orderBy(asc(jobs.createdAt), asc(jobs.id));
  const ranks = new Map<string, Rank>();
  for (const row of rows) if (row.agentId && !ranks.has(row.agentId)) ranks.set(row.agentId, { agentId: row.agentId, urgent: row.urgent ?? false, since: row.at.getTime() });
  return ranks;
}

/* Whether a goes before b: an urgent task's turn before the rest, then the one that waits longer. */
const before = (a: Rank, b: Rank): boolean => (a.urgent !== b.urgent ? a.urgent : a.since !== b.since ? a.since < b.since : a.agentId < b.agentId);
const byRank = (a: Rank, b: Rank): number => (before(a, b) ? -1 : before(b, a) ? 1 : 0);

/* The agents in this order: those waiting for a place first come first served, an urgent task's ahead. */
export async function inLineOrder(db: Reader, agentIds: readonly string[]): Promise<string[]> {
  const ranks = await ranksOf(db, agentIds);
  const ranked = [...ranks.values()].sort(byRank).map(r => r.agentId);
  return [...ranked, ...agentIds.filter(id => !ranks.has(id))];
}

/* Which of these nodes have a place for the agent's turn now: a node of a machine with no limit always; one of a machine
   with a limit while fewer turns run there than it takes, the turns that wait there ahead of this one counted in. */
export async function placesFor(ctx: Ctx, agentId: string, places: readonly NodeIdentity[]): Promise<(node: NodeIdentity) => boolean> {
  const limits = await limitsOf(ctx.db, places);
  if (!limits.size) return () => true;
  const open = new Map<string, boolean>();
  for (const machine of new Map([...limits.values()].map(m => [m.id, m])).values()) {
    const waiting = [...(linesOf(ctx).get(machine.id)?.keys() ?? [])].filter(id => id !== agentId);
    const ranks = await ranksOf(ctx.db, [...waiting, agentId]);
    const mine = ranks.get(agentId);
    const ahead = waiting.filter(id => ranks.has(id) && (!mine || before(ranks.get(id)!, mine))).length;
    open.set(machine.id, (await runningOn(ctx.db, machine)) + ahead < machine.limit);
  }
  return node => {
    const machine = limits.get(keyOf(node));
    return !machine || open.get(machine.id) !== false;
  };
}

/* The agent's turn found no place on the machines of these nodes: it waits on each of them, for whichever frees first. */
export async function waitForPlace(ctx: Ctx, agentId: string, places: readonly NodeIdentity[]): Promise<void> {
  if (!places.length) return;
  const full = new Set([...(await limitsOf(ctx.db, places)).values()].map(m => m.id));
  if (!full.size) return;
  /* An agent with no turn waiting waits for nothing. */
  const [turn] = await ctx.db.select(idOnly(jobs)).from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'queued'))).limit(1);
  if (!turn) return;
  for (const machine of full) lineOf(ctx, machine).set(agentId, ++marks);
}

/* A turn of the agent went out: it waits on no machine any more. */
export function placeTaken(ctx: Ctx, agentId: string): void {
  for (const line of linesOf(ctx).values()) line.delete(agentId);
}

/* Whether the agent's turn waits for a place on a machine now. */
export function waitsForPlace(ctx: Ctx, agentId: string): boolean {
  return [...linesOf(ctx).values()].some(line => line.has(agentId));
}

/* The same for the agents of a company that have a turn waiting, for the map. */
export async function placeWaiters(ctx: Ctx, companyId: string): Promise<Set<string>> {
  const waiting = [...new Set([...linesOf(ctx).values()].flatMap(line => [...line.keys()]))];
  if (!waiting.length) return new Set();
  const rows = await ctx.db.selectDistinct({ agentId: jobs.agentId }).from(jobs).where(and(eq(jobs.companyId, companyId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'queued'), inArray(jobs.agentId, waiting)));
  return new Set(rows.flatMap(r => (r.agentId ? [r.agentId] : [])));
}

/* Whether the machine of the node a turn is taken for has no place left: read with the machine's row held for update until
   the turn is written, so two turns taken at once never both get its last place. A machine with no limit is not held. */
export async function placeGone(tx: Reader, place: { nodeId?: string | null; builtinMachine?: string | null }): Promise<boolean> {
  const node: NodeIdentity | null = place.nodeId ? { kind: 'node', nodeId: place.nodeId } : place.builtinMachine ? { kind: 'builtin', machine: place.builtinMachine } : null;
  const machine = node && (await limitsOf(tx, [node])).get(keyOf(node));
  if (!machine) return false;
  const [row] = await tx.select({ limit: machines.turnLimit }).from(machines).where(eq(machines.id, machine.id)).for('update');
  return row?.limit !== null && row?.limit !== undefined && (await runningOn(tx, machine)) >= row.limit;
}

/* The machine a turn ran on, whatever its limit: its node's machine, or the one of its built-in node. */
export async function machineOfTurn(db: Reader, turn: { nodeId: string | null; builtinMachine: string | null }): Promise<string | null> {
  if (turn.nodeId) return (await db.select({ id: nodes.machineId }).from(nodes).where(eq(nodes.id, turn.nodeId)))[0]?.id ?? null;
  if (!turn.builtinMachine) return null;
  return (await db.select(idOnly(machines)).from(machines).where(eq(machines.networkId, turn.builtinMachine)))[0]?.id ?? null;
}

/* The machines being gone through now, and those a place freed on meanwhile, which are gone through once more. */
const going = new WeakMap<Ctx, { now: Set<string>; again: Set<string> }>();

/* A place freed on the machine, or its limit changed: each turn that waits there is tried again in its order. One that
   finds no place waits again; one that went out, or waits for something else now, or has no turn left, leaves the line. */
export async function placeFreed(ctx: Ctx, machineId: string | null): Promise<void> {
  if (!machineId || !linesOf(ctx).get(machineId)?.size) return;
  const state = going.get(ctx) ?? { now: new Set<string>(), again: new Set<string>() };
  going.set(ctx, state);
  if (state.now.has(machineId)) {
    state.again.add(machineId);
    return;
  }
  state.now.add(machineId);
  try {
    /* The queue reads this module, so it is loaded here only when called. */
    const { pump } = await import('../conversation/queue.js');
    do {
      state.again.delete(machineId);
      const line = lineOf(ctx, machineId);
      for (const agentId of await inLineOrder(ctx.db, [...line.keys()])) {
        const mark = line.get(agentId);
        if (mark === undefined) continue;
        await pump(ctx, agentId).catch((err: unknown) => ctx.log.error({ error: loggable(err) }, 'A turn that waited for a place on its machine could not be sent.'));
        if (line.get(agentId) === mark) line.delete(agentId);
      }
    } while (state.again.has(machineId));
  } finally {
    state.now.delete(machineId);
  }
}

/* How many agents' turns wait for a place on the machine, for its card. */
export function waitingOn(ctx: Ctx, machineId: string): number {
  return linesOf(ctx).get(machineId)?.size ?? 0;
}
