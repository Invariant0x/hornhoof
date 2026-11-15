import type { NodeLoad } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
import { availableMemory } from '../testruns/capacity.js';
import { keyOf, type NodeHub, type NodeIdentity } from './hub.js';

/* An agent program with the tools it runs takes up to about a gigabyte, its helpers inside it, and a Vitest worker of its
   tests about as much. */
const PROGRAM_BYTES = 2 ** 30;
const WORKER_BYTES = 2 ** 30;
/* What a machine must have free for a new program to start there: the program's own gigabyte and one Vitest worker's, the
   fewest its tests run with. Below that the new program's first test run takes the memory the programs already there work
   in, and the system kills one of them, as it did on a machine of 12.5 GB with four programs and six of their helpers
   testing. A program that runs there is never stopped for this. */
export const START_FREE_BYTES = PROGRAM_BYTES + WORKER_BYTES;
/* How long a program sent to start counts against its machine's memory while its node does not name it yet: one that does
   not show its prompt within two minutes fails its turn. */
const STARTING_MS = 2 * 60_000;

/* live: the agents whose programs run on the node as it said last, null while it says nothing of them; liveAt: when it
   said so. starting: the agents a turn went out to start a program for, and when. waiting: the agents whose turns wait for
   room on it. */
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

/* The memory the machine has for one more program, once the programs that start there have theirs. */
const roomLeft = (room: Room, load: NodeLoad) => availableMemory(load) - starting(room).length * PROGRAM_BYTES >= START_FREE_BYTES;

/* What a node said of the programs that run on it. The agents whose turns waited for room on it, once there is room. */
export function programsLive(ctx: Ctx, node: NodeIdentity, live: string[] | undefined): string[] {
  const room = roomOf(ctx, node);
  room.live = live ? new Set(live) : null;
  room.liveAt = Date.now();
  const load = ctx.hub.loadOf(node);
  if (!room.waiting.size || (room.live && load && !roomLeft(room, load))) return [];
  const waited = [...room.waiting];
  room.waiting.clear();
  return waited;
}

/* The agents whose programs run on the node as it said last, and when it said so; null while it says nothing of them. */
export function livePrograms(ctx: Ctx, node: NodeIdentity): { agents: ReadonlySet<string>; at: number } | null {
  const room = rooms.get(ctx.hub)?.get(keyOf(node));
  return room?.live ? { agents: room.live, at: room.liveAt } : null;
}

/* Whether a turn of this agent may go to the node now. One whose program runs or starts there goes, whatever the memory;
   one that would start a new program waits while the machine is short of memory for it. A node that does not say which
   programs run on it takes every turn, as before. */
export function roomFor(ctx: Ctx, node: NodeIdentity, agentId: string): boolean {
  const room = rooms.get(ctx.hub)?.get(keyOf(node));
  const load = ctx.hub.loadOf(node);
  if (!room?.live || !load || room.live.has(agentId) || starting(room).includes(agentId) || roomLeft(room, load)) return true;
  room.waiting.add(agentId);
  return false;
}

/* A turn of this agent went out to the node: a program it starts there counts against the memory until the node names it. */
export function turnSent(ctx: Ctx, node: NodeIdentity, agentId: string): void {
  const room = rooms.get(ctx.hub)?.get(keyOf(node));
  if (room?.live && !room.live.has(agentId)) room.starting.set(agentId, Date.now());
}
