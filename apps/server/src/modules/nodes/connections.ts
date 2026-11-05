import { NodeReconnect, type NodeMessage } from '@hornhoof/protocol';
import { desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { machines, nodeConnections, nodes } from '../../db/schema.js';
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
/* The built-in node has no machine of its own, so its connections go only to the log. */
const BUILTIN_NAMES = { machine: 'built-in', node: 'builtin' };

type Writes = Pick<Ctx, 'db' | 'log'>;

/* An address in any words: its scheme and path, then a sign-in and a query, which can hold a secret whatever they are called,
   up to what ends the address in a sentence. */
const ADDRESS = /([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/?#]*@)?([^\s?#]*)(?:[?#]\S*?)?(?=[.,;:!)\]'"]*(?:\s|$))/gi;

/* What a socket or a node says goes to the log and to people's screens: one line, within its limit, with addresses bare.
   Addresses go first: a limit could cut a sign-in in two and a control character could hide one. Each socket and node gives
   a short text, 123 bytes of a close reason and 300 characters from a node, so the search stays cheap. */
const oneLine = (text: string | null, limit: number) => (text === null ? null : text.replace(ADDRESS, '$1$2').replace(/\p{Cc}/gu, ' ').slice(0, limit));

async function nodeOn(db: Db, nodeId: string) {
  const [node] = await db
    .select({ companyId: nodes.companyId, machineId: nodes.machineId, hostname: machines.hostname })
    .from(nodes)
    .innerJoin(machines, eq(machines.id, nodes.machineId))
    .where(eq(nodes.id, nodeId));
  return node ?? null;
}

export async function nodeConnected(ctx: Writes, id: NodeIdentity, link: string, at: Date): Promise<void> {
  if (id.kind !== 'node') return void ctx.log.info({ ...BUILTIN_NAMES, offlineMs: null }, CONNECTED);
  const node = await nodeOn(ctx.db, id.nodeId);
  if (!node) return;
  const [before] = await ctx.db.select({ at: nodeConnections.disconnectedAt }).from(nodeConnections).where(eq(nodeConnections.nodeId, id.nodeId)).orderBy(desc(nodeConnections.connectedAt)).limit(1);
  await ctx.db.insert(nodeConnections).values({ id: link, companyId: node.companyId, machineId: node.machineId, nodeId: id.nodeId, connectedAt: at });
  ctx.log.info({ machine: node.hostname, node: id.nodeId, offlineMs: before?.at ? at.getTime() - before.at.getTime() : null }, CONNECTED);
}

export async function nodeDisconnected(ctx: Writes, id: NodeIdentity, end: LinkEnd): Promise<void> {
  const reason = oneLine(end.reason, REASON_CHARS);
  const error = oneLine(end.error, ERROR_CHARS);
  const line = { cause: end.cause, code: end.code, reason, error };
  if (id.kind !== 'node') return void ctx.log.info({ ...BUILTIN_NAMES, ...line }, DISCONNECTED);
  const node = await nodeOn(ctx.db, id.nodeId);
  if (!node) return;
  /* A server stopping has ended it already. */
  await ctx.db.update(nodeConnections).set({ disconnectedAt: end.at, cause: end.cause, closeCode: end.code, closeReason: reason, error }).where(sql`${nodeConnections.id} = ${end.link} and ${nodeConnections.disconnectedAt} is null`);
  ctx.log.info({ machine: node.hostname, node: id.nodeId, ...line }, DISCONNECTED);
}

/* What a node says of a drop goes with the connection before its new one, whichever way the server saw that end. */
export async function nodeReported(ctx: Ctx, id: NodeIdentity, msg: Extract<NodeMessage, { type: 'node.reconnect' }>): Promise<void> {
  if (id.kind !== 'node' || !(await hasCurrentKey(ctx, id))) return;
  const [, before] = await ctx.db.select({ id: nodeConnections.id }).from(nodeConnections).where(eq(nodeConnections.nodeId, id.nodeId)).orderBy(desc(nodeConnections.connectedAt)).limit(2);
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
