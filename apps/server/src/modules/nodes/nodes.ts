import { and, asc, eq, inArray, isNotNull, isNull, lte, notLike, or, sql } from 'drizzle-orm';
import { hashToken } from '../../crypto/tokens.js';
import type { Db } from '../../db/client.js';
import { machines, nodes, subscriptions, SUBSCRIPTION_STATUSES, type NodeStatus } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { nodeIdentity, type NodeHub, type NodeIdentity } from './hub.js';

/* A node that still has its key: its machine is connected and Hornhoof has not taken the node back. */
export const liveNode = isNotNull(nodes.keyHash);

/* A socket authenticated with a node key may act only while its node row still holds that exact key hash. */
export async function hasCurrentKey(ctx: { db: Db; hub: NodeHub }, id: NodeIdentity): Promise<boolean> {
  if (id.kind !== 'node' || !id.keyHash) return true;
  const [row] = await ctx.db.select(only(nodes, 'keyHash')).from(nodes).where(eq(nodes.id, id.nodeId));
  if (row?.keyHash === id.keyHash) return true;
  ctx.hub.close(id.nodeId, 4001, id.keyHash);
  return false;
}

export const NODE_STALE_MS = 24 * 60 * 60 * 1000;

/* Clears the sign-in of nodes that have not been heard from for more than 24 hours, ready or waiting for their program's
   first setup, and settles their plans. A write, so only the leader's minute round calls it: the screens show what it
   last found, a minute late at worst. */
export async function expireStaleNodes(db: Db, now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - NODE_STALE_MS);
  const stale = await db
    .update(nodes)
    .set({ status: 'needs_login' })
    .where(and(inArray(nodes.status, ['ready', 'needs_setup']), lte(nodes.lastSeenAt, cutoff)))
    .returning({ subscriptionId: nodes.subscriptionId });
  await settlePlans(db, stale.map(n => n.subscriptionId));
}

/* The node builds of a machine's ready nodes that are not the one the server's nodes should be, each once; none while
   all are, or while the server does not know its own and so tells none apart. A node that says no build is from before
   nodes said one, so it is not of the server's build either. */
export function otherBuild(hub: NodeHub, ids: string[], server: string | null): { server: string; nodes: (string | null)[] } | null {
  if (!server) return null;
  const said = ids.map(nodeIdentity).filter(id => hub.isReady(id)).map(id => hub.buildOf(id));
  const other = [...new Set(said.filter(build => build !== server))];
  return other.length ? { server, nodes: other } : null;
}

/* Never selects key_hash, so it cannot leak into a response. */
const columns = {
  id: nodes.id,
  machineId: nodes.machineId,
  subscriptionId: nodes.subscriptionId,
  status: nodes.status,
  version: nodes.version,
  lastSeenAt: nodes.lastSeenAt,
  hostname: machines.hostname,
};

export type NodeRow = { id: string; machineId: string; subscriptionId: string | null; status: NodeStatus; version: string | null; lastSeenAt: Date | null; hostname: string };

/* The live nodes of these plans, oldest first, with the names of their machines. */
export async function planNodes(db: Db, subscriptionIds: string[]): Promise<NodeRow[]> {
  if (!subscriptionIds.length) return [];
  return db
    .select(columns)
    .from(nodes)
    .innerJoin(machines, eq(machines.id, nodes.machineId))
    .where(and(inArray(nodes.subscriptionId, subscriptionIds), liveNode))
    .orderBy(asc(nodes.createdAt), asc(nodes.id));
}

/* How the key of the row of the machine the server itself runs on begins. */
export const SERVER_KEY = 'server:';

/* A machine people see and act on: a computer someone joined, and a machine the company was installed on while the
   server runs elsewhere. The row of the machine this app itself runs on, when it is the row its install made, which
   its key says, is none of those. An install with no machine id tells none of them apart and shows none. */
export const shownMachine = (config: { machineId: string | null }) =>
  config.machineId ? or(notLike(machines.machineKey, `${SERVER_KEY}%`), sql<boolean>`${machines.networkId} IS DISTINCT FROM ${config.machineId}`) : notLike(machines.machineKey, `${SERVER_KEY}%`);

/* Whether a row is one a company's install made for its own machine, and no computer someone joined. */
export const isServerInstall = (machineKey: string): boolean => machineKey.startsWith(SERVER_KEY);

export function isBuiltinHost(
  m: { key: string; networkId: string | null },
  hostId: string | null,
  networkId: string | null,
): boolean {
  if (isServerInstall(m.key)) return false;
  if (networkId !== null && m.networkId === networkId) return true;
  return [hostId, networkId].includes(hashToken(`hornhoof-host:${m.key}`));
}

/* The company's machine the server and its built-in node run on: the joined row that holds the server's network id, or
   whose key hashes to what install.sh gave the server as its host or keeper id. The pool counts that computer once. */
export async function builtinMachine(db: Db, hostId: string | null, companyId: string, networkId: string | null = null): Promise<{ id: string; hostname: string } | null> {
  if (!hostId && !networkId) return null;
  const rows = await db
    .select({ id: machines.id, hostname: machines.hostname, key: machines.machineKey, networkId: machines.networkId })
    .from(machines)
    .where(and(eq(machines.companyId, companyId), isNull(machines.revokedAt)))
    .orderBy(asc(machines.createdAt));
  const same = rows.find(m => isBuiltinHost(m, hostId, networkId));
  return same ? { id: same.id, hostname: same.hostname } : null;
}

/* The machine a node is on; none for the built-in node. */
export async function machineOf(db: Db, node: NodeIdentity | null): Promise<{ id: string; hostname: string } | null> {
  if (node?.kind !== 'node') return null;
  const [row] = await db.select({ id: machines.id, hostname: machines.hostname }).from(nodes).innerJoin(machines, eq(machines.id, nodes.machineId)).where(eq(nodes.id, node.nodeId));
  return row ?? null;
}

/* A plan's state from its nodes: waiting for a machine while none is left, ready while one is signed in and set up,
   waiting for its program's first setup while one is signed in, needing a sign-in otherwise. Works inside a transaction
   too. */
export async function settlePlans(db: Db, subscriptionIds: (string | null)[]): Promise<void> {
  const ids = [...new Set(subscriptionIds.filter((id): id is string => id !== null))];
  if (!ids.length) return;
  const of = (status?: 'ready' | 'needs_setup') =>
    sql`exists (select 1 from ${nodes} where ${nodes.subscriptionId} = ${subscriptions.id} and ${nodes.keyHash} is not null${status ? sql` and ${nodes.status} = ${status}` : sql``})`;
  await db
    .update(subscriptions)
    .set({ status: sql<(typeof SUBSCRIPTION_STATUSES)[number]>`case when ${of('ready')} then 'ready' when ${of('needs_setup')} then 'needs_setup' when ${of()} then 'needs_login' else 'waiting_machine' end` })
    .where(and(inArray(subscriptions.id, ids), eq(subscriptions.kind, 'personal')));
}
