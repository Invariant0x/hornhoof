import type { ConnectionEnd } from '@hornhoof/protocol';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Person } from '../../auth/session.js';
import { agents, companies, machines, nodeConnections, nodes, people } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';

/* A machine with agents on it that has been off the line this long is a person's to switch on. All of this is read from the
   machine's own history and asks no agent, as they may all be on that machine. So there is nothing to create or to close, and
   no round or restart of the server can make a second card. */
const AWAY_MS = 5 * 60_000;
const BACK_SHOWN_MS = 24 * 60 * 60_000;

type Connection = { connectedAt: Date; disconnectedAt: Date | null; cause: ConnectionEnd | null };
type Spell = { since: Date; back: Date | null };
type Important = { name: string; kind: 'orchestrator' | 'head' };

export type MachineAway = Spell & { id: string; hostname: string; owner: { id: string; name: string } | null; agents: number; important: Important[] };

/* The time the server itself was off is not the machine's: a connection it ended counts from when it came back. Of an earlier
   such gap it cannot tell how much was whose, so it leaves that out. */
function spellOf(end: Connection, back: Date | null, startedAt: Date): Spell[] {
  const since = end.disconnectedAt!;
  if (end.cause !== 'server_stopped') return [{ since, back }];
  return back ? [] : [{ since: since > startedAt ? since : startedAt, back }];
}

function extendsConnection(last: Connection | null, row: Connection): boolean {
  return !last || Boolean(last.disconnectedAt && (!row.disconnectedAt || row.disconnectedAt > last.disconnectedAt));
}

/* The times no node of the machine was connected, oldest first. */
function spellsOf(connections: Connection[], startedAt: Date): Spell[] {
  const spells: Spell[] = [];
  let last: Connection | null = null;
  for (const row of connections.toSorted((a, b) => a.connectedAt.getTime() - b.connectedAt.getTime())) {
    if (last?.disconnectedAt && row.connectedAt > last.disconnectedAt) spells.push(...spellOf(last, row.connectedAt, startedAt));
    if (extendsConnection(last, row)) last = row;
  }
  return last?.disconnectedAt ? [...spells, ...spellOf(last, null, startedAt)] : spells;
}

/* The last time away that counts: under way, or over within the last day. */
function spellToShow(connections: Connection[], heard: Date | null, startedAt: Date, now: Date): Spell | null {
  const spells = connections.length ? spellsOf(connections, startedAt) : heard ? [{ since: heard, back: null }] : [];
  const last = spells.filter(s => (s.back ?? now).getTime() - s.since.getTime() >= AWAY_MS).at(-1);
  if (!last) return null;
  return !last.back || now.getTime() - last.back.getTime() < BACK_SHOWN_MS ? last : null;
}

const newest = (dates: (Date | null)[]): Date | null => dates.reduce<Date | null>((best, d) => (d && (!best || d > best) ? d : best), null);

/* Whether the machine is off the line as its card shows it: away now, for as long as a card takes. Until then it may be
   only getting back on the line, as its connection closes before a new one opens. */
export async function shownAway(ctx: Pick<Ctx, 'db' | 'startedAt' | 'clock'>, machineId: string): Promise<boolean> {
  const [connections, heard] = await Promise.all([
    ctx.db.select().from(nodeConnections).where(eq(nodeConnections.machineId, machineId)),
    ctx.db.select(only(nodes, 'lastSeenAt')).from(nodes).where(eq(nodes.machineId, machineId)),
  ]);
  return spellToShow(connections, newest(heard.map(h => h.lastSeenAt)), ctx.startedAt, new Date(ctx.clock()))?.back === null;
}

const importantOf = (crew: { name: string; kind: string }[]): Important[] =>
  (['orchestrator', 'head'] as const).flatMap(kind => crew.filter(a => a.kind === kind).map(a => ({ name: a.name, kind })));

/* The company's machines with agents on them that are away or came back lately. An assistant's own agent is its owner's
   and does the company's work nowhere, so it counts on no card. */
export async function machinesAway(ctx: Pick<Ctx, 'db' | 'startedAt'>, companyId: string, now: Date): Promise<MachineAway[]> {
  const crew = await ctx.db
    .select({ machineId: machines.id, hostname: machines.hostname, ownerId: machines.personId, name: agents.name, kind: agents.kind })
    .from(agents)
    .innerJoin(nodes, eq(nodes.id, agents.nodeId))
    .innerJoin(machines, eq(machines.id, nodes.machineId))
    .where(and(eq(agents.companyId, companyId), ne(agents.kind, 'assistant'), isNull(agents.switchedOffAt), isNull(machines.revokedAt)));
  const ids = [...new Set(crew.map(a => a.machineId))];
  if (!ids.length) return [];
  const [connections, heard, owners] = await Promise.all([
    ctx.db.select().from(nodeConnections).where(inArray(nodeConnections.machineId, ids)),
    ctx.db.select({ machineId: nodes.machineId, lastSeenAt: nodes.lastSeenAt }).from(nodes).where(inArray(nodes.machineId, ids)),
    ctx.db.select({ id: people.id, name: people.name }).from(people).where(and(eq(people.companyId, companyId), eq(people.status, 'active'))),
  ]);
  const cards = ids.flatMap(id => {
    const own = crew.filter(a => a.machineId === id);
    const spell = spellToShow(connections.filter(c => c.machineId === id), newest(heard.filter(h => h.machineId === id).map(h => h.lastSeenAt)), ctx.startedAt, now);
    if (!spell) return [];
    const { hostname, ownerId } = own[0]!;
    return [{ id, hostname, owner: owners.find(p => p.id === ownerId) ?? null, ...spell, agents: own.length, important: importantOf(own) }];
  });
  return cards.toSorted((a, b) => a.since.getTime() - b.since.getTime());
}

/* Its owner and the CEO, each on a screen of their own: an agent in a turn hears nothing of it. */
export const isAddressedTo = (me: Person, card: Pick<MachineAway, 'owner'>): boolean => !me.via && (me.isOwner || me.id === card.owner?.id);

const told = new WeakMap<object, Map<string, string>>();

/* Screens ask again when a card comes or closes. The word holds nothing, so it goes to everyone. */
export async function tellOfMachinesAway(ctx: Pick<Ctx, 'db' | 'bus' | 'startedAt'>, now: Date): Promise<void> {
  const last = told.get(ctx) ?? new Map<string, string>();
  told.set(ctx, last);
  for (const { id } of await ctx.db.select(idOnly(companies)).from(companies)) {
    const state = (await machinesAway(ctx, id, now)).map(card => `${card.id} ${card.since.toISOString()} ${card.back?.toISOString() ?? ''}`).join();
    if ((last.get(id) ?? '') === state) continue;
    last.set(id, state);
    ctx.bus.publish(id, { type: 'requests', machines: true });
  }
}
