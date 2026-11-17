import { NodeReconnect, type NodeMessage } from '@hornhoof/protocol';
import { and, desc, eq, gt, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { machines, nodeConnections, nodes, type jobs } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { type LinkEnd, type NodeIdentity } from './hub.js';
import { hasCurrentKey } from './nodes.js';

/* Two weeks show what repeats by the day of the week. Five nodes that drop five times a day write 350 rows in that time, so
   two thousand hold all of it several times over, and a day and more of a node that drops every minute. */
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const KEEP_PER_MACHINE = 2000;
const REASON_CHARS = 200;
const ERROR_CHARS = 300;

const CONNECTED = 'A node connected.';
const DISCONNECTED = 'A node lost its connection.';
/* The built-in node of a server with no machine id, or of a machine no company has, has no machine to go with: its
   connections go only to the log. */
const BUILTIN_NAMES = { machine: 'built-in', node: 'builtin' };

type Writes = Pick<Ctx, 'db' | 'log'>;

/* An address in any words: its scheme and path, then a sign-in and a query, which can hold a secret whatever they are called,
   up to what ends the address in a sentence. */
const ADDRESS = /([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/?#]*@)?([^\s?#]*)(?:[?#]\S*?)?(?=[.,;:!)\]'"]*(?:\s|$))/gi;

/* What a socket or a node says goes to the log and to people's screens: one line, within its limit, with addresses bare.
   Addresses go first: a limit could cut a sign-in in two and a control character could hide one. Each socket and node gives
   a short text, 123 bytes of a close reason and 300 characters from a node, so the search stays cheap. */
const oneLine = (text: string | null, limit: number) => (text === null ? null : text.replace(ADDRESS, '$1$2').replace(/\p{Cc}/gu, ' ').slice(0, limit));

/* Where a node's connections go: a node's on its machine; a built-in node's on the machine whose network id it runs under,
   with no node of its own (#1060). None for a node that is gone, or a built-in node with no machine of a company. */
type Place = { companyId: string; machineId: string; nodeId: string | null; hostname: string };

async function placeOf(db: Db, id: NodeIdentity): Promise<Place | null> {
  if (id.kind === 'node') {
    const [node] = await db
      .select({ companyId: nodes.companyId, machineId: nodes.machineId, hostname: machines.hostname })
      .from(nodes)
      .innerJoin(machines, eq(machines.id, nodes.machineId))
      .where(eq(nodes.id, id.nodeId));
    return node ? { ...node, nodeId: id.nodeId } : null;
  }
  const [machine] = await db
    .select({ companyId: machines.companyId, machineId: machines.id, hostname: machines.hostname })
    .from(machines)
    .where(and(eq(machines.networkId, id.machine), isNull(machines.revokedAt)));
  return machine ? { ...machine, nodeId: null } : null;
}

const connectionsOf = (place: Place) => (place.nodeId ? eq(nodeConnections.nodeId, place.nodeId) : and(eq(nodeConnections.machineId, place.machineId), isNull(nodeConnections.nodeId)));
const namesOf = (place: Place) => ({ machine: place.hostname, node: place.nodeId ?? BUILTIN_NAMES.node });

export async function nodeConnected(ctx: Writes, id: NodeIdentity, link: string, at: Date): Promise<void> {
  const place = await placeOf(ctx.db, id);
  if (!place) return void (id.kind === 'builtin' && ctx.log.info({ ...BUILTIN_NAMES, offlineMs: null }, CONNECTED));
  const [before] = await ctx.db.select({ at: nodeConnections.disconnectedAt }).from(nodeConnections).where(connectionsOf(place)).orderBy(desc(nodeConnections.connectedAt)).limit(1);
  await ctx.db.insert(nodeConnections).values({ id: link, companyId: place.companyId, machineId: place.machineId, nodeId: place.nodeId, connectedAt: at });
  ctx.log.info({ ...namesOf(place), offlineMs: before?.at ? at.getTime() - before.at.getTime() : null }, CONNECTED);
}

export async function nodeDisconnected(ctx: Writes, id: NodeIdentity, end: LinkEnd): Promise<void> {
  const reason = oneLine(end.reason, REASON_CHARS);
  const error = oneLine(end.error, ERROR_CHARS);
  const line = { cause: end.cause, code: end.code, reason, error };
  const place = await placeOf(ctx.db, id);
  if (!place) return void (id.kind === 'builtin' && ctx.log.info({ ...BUILTIN_NAMES, ...line }, DISCONNECTED));
  /* A server stopping has ended it already. */
  await ctx.db.update(nodeConnections).set({ disconnectedAt: end.at, cause: end.cause, closeCode: end.code, closeReason: reason, error }).where(sql`${nodeConnections.id} = ${end.link} and ${nodeConnections.disconnectedAt} is null`);
  ctx.log.info({ ...namesOf(place), ...line }, DISCONNECTED);
}

/* Whether the node connected again while a turn waited in line for it, between the time the turn was queued and the time it
   went out: the node had been away, or went away and came back, meanwhile. Not while it stayed connected, as the built-in
   node, which keeps no history, always is. */
export async function cameBack(db: Db, nodeId: string | null, queuedAt: Date, sentAt = new Date()): Promise<boolean> {
  if (!nodeId) return false;
  const [back] = await db
    .select(idOnly(nodeConnections))
    .from(nodeConnections)
    .where(and(eq(nodeConnections.nodeId, nodeId), gt(nodeConnections.connectedAt, queuedAt), lte(nodeConnections.connectedAt, sentAt)))
    .limit(1);
  return back !== undefined;
}

/* Whether a turn that went out had waited in line until its node came back. */
export async function waitedForReturn(db: Db, turn: Pick<typeof jobs.$inferSelect, 'nodeId' | 'createdAt' | 'startedAt'>): Promise<boolean> {
  return turn.startedAt !== null && (await cameBack(db, turn.nodeId, turn.createdAt, turn.startedAt));
}

/* What a node says of a drop goes with the connection before its new one, whichever way the server saw that end. */
export async function nodeReported(ctx: Ctx, id: NodeIdentity, msg: Extract<NodeMessage, { type: 'node.reconnect' }>): Promise<void> {
  if (!(await hasCurrentKey(ctx, id))) return;
  const place = await placeOf(ctx.db, id);
  if (!place) return;
  const [, before] = await ctx.db.select(idOnly(nodeConnections)).from(nodeConnections).where(connectionsOf(place)).orderBy(desc(nodeConnections.connectedAt)).limit(2);
  if (!before) return;
  const report = NodeReconnect.parse(msg);
  await ctx.db
    .update(nodeConnections)
    .set({ report: { ...report, closeReason: oneLine(report.closeReason, REASON_CHARS), error: oneLine(report.error, ERROR_CHARS) } })
    .where(eq(nodeConnections.id, before.id));
}

/* While the database still answers: the sockets close after this, and a process that stops does not wait for them. */
export async function serverStopping(ctx: Pick<Ctx, 'db' | 'hub'>): Promise<void> {
  ctx.hub.stopping();
  await ctx.db.update(nodeConnections).set({ disconnectedAt: new Date(), cause: 'server_stopped', closeCode: 1001 }).where(isNull(nodeConnections.disconnectedAt));
}

/* One server serves these nodes, so no connection outlives it. One still open says it died: it was last sure of the node
   when it last heard of it. */
export async function serverStarted(db: Db): Promise<void> {
  const heard = sql`(select ${nodes.lastSeenAt} from ${nodes} where ${nodes.id} = ${nodeConnections.nodeId})`;
  await db
    .update(nodeConnections)
    .set({ disconnectedAt: sql`greatest(${nodeConnections.connectedAt}, ${heard})`, cause: 'server_stopped' })
    .where(isNull(nodeConnections.disconnectedAt));
}

/* A connection that still stands stays whatever its age: it says the node is connected since then. */
export async function dropOldConnections(db: Db, now: Date): Promise<number> {
  const aged = await db.delete(nodeConnections).where(lt(nodeConnections.disconnectedAt, new Date(now.getTime() - KEEP_MS))).returning({ id: nodeConnections.id });
  const beyond = sql`(select id from (select id, row_number() over (partition by machine_id order by connected_at desc) as place from node_connections where disconnected_at is not null) ranked where place > ${KEEP_PER_MACHINE})`;
  const over = await db.delete(nodeConnections).where(inArray(nodeConnections.id, beyond)).returning({ id: nodeConnections.id });
  return aged.length + over.length;
}
