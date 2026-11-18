import type { Ctx } from '../../app.js';
import { keyOf, type NodeHub, type NodeIdentity } from './hub.js';

/* How long a program sent to start counts as there while its node does not name it yet: one that does not show its prompt
   within two minutes fails its turn. */
const STARTING_MS = 2 * 60_000;

/* live: the agents whose programs run on the node as it said last, null while it says nothing of them; liveAt: when it
   said so. starting: the agents a turn went out to start a program for, and when. waiting: the agents whose new programs
   wait on it. */
type Room = { live: Set<string> | null; liveAt: number; starting: Map<string, number>; waiting: Set<string> };

const rooms = new WeakMap<NodeHub, Map<string, Room>>();

function roomOf(ctx: Ctx, node: NodeIdentity): Room {
  const all = rooms.get(ctx.hub) ?? new Map<string, Room>();
  rooms.set(ctx.hub, all);
  let room = all.get(keyOf(node));
  if (!room) {
    room = { live: null, liveAt: 0, starting: new Map(), waiting: new Set() };
    all.set(keyOf(node), room);
  }
  return room;
}

/* The programs that start on the node and that it does not name yet. */
function starting(room: Room, now = Date.now()): string[] {
  for (const [agentId, at] of room.starting) if (now - at >= STARTING_MS || room.live?.has(agentId)) room.starting.delete(agentId);
  return [...room.starting.keys()];
}

/* Whether the node's last report says its machine's kernel killed a process for want of memory since the one before. No
   figure of Hornhoof's own decides it: a node from before, or on a machine that does not count such kills, never says so. */
const memoryShort = (ctx: Ctx, node: NodeIdentity): boolean => ctx.hub.loadOf(node)?.memoryShort === true;

/* What a node said of the programs that run on it. The agents whose new programs waited on it, every one at once, once the
   report finds no new kill; each one's own room decides then, as it is asked again. */
export function programsLive(ctx: Ctx, node: NodeIdentity, live: string[] | undefined): string[] {
  const room = roomOf(ctx, node);
  room.live = live ? new Set(live) : null;
  room.liveAt = Date.now();
  if (!room.waiting.size || memoryShort(ctx, node)) return [];
  const waited = [...room.waiting];
  room.waiting.clear();
  return waited;
}

/* The agents whose programs run on the node as it said last, and when it said so; null while it says nothing of them. */
export function livePrograms(ctx: Ctx, node: NodeIdentity): { agents: ReadonlySet<string>; at: number } | null {
  const room = rooms.get(ctx.hub)?.get(keyOf(node));
  return room?.live ? { agents: room.live, at: room.liveAt } : null;
}

/* Whether a turn of this agent may go to the node now. After a report that the machine's kernel killed a process for want
   of memory, a turn that would start a new program there waits, and goes on by itself with the first report that finds
   no new kill. One whose program runs or starts there goes all the same, so nothing that runs loses anything, the
   orchestrator's and the heads' as everyone's. A node that does not name its programs starts one for each turn, so each of
   its turns waits then. look: only asked, as an agent's window asks where its next turn would go, so the agent is not put
   among the ones that wait. */
export function roomFor(ctx: Ctx, node: NodeIdentity, agentId: string, look = false): boolean {
  if (!memoryShort(ctx, node)) return true;
  const room = roomOf(ctx, node);
  if (room.live?.has(agentId) || starting(room).includes(agentId)) return true;
  if (!look) room.waiting.add(agentId);
  return false;
}

/* A turn of this agent went out to the node: a program it starts there counts as there until the node names it, and the
   agent waits on no machine any more. */
export function turnSent(ctx: Ctx, node: NodeIdentity, agentId: string): void {
  for (const other of rooms.get(ctx.hub)?.values() ?? []) other.waiting.delete(agentId);
  const room = rooms.get(ctx.hub)?.get(keyOf(node));
  if (room?.live && !room.live.has(agentId)) room.starting.set(agentId, Date.now());
}
