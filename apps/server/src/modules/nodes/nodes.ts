import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { hashToken } from '../../crypto/tokens.js';
import type { Db } from '../../db/client.js';
import { machines, nodes, subscriptions } from '../../db/schema.js';
import type { NodeIdentity } from './hub.js';

/* A node that still has its key: its machine is connected and Hornhoof has not taken the node back. */
export const liveNode = isNotNull(nodes.keyHash);

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

export type NodeRow = { id: string; machineId: string; subscriptionId: string | null; status: 'needs_login' | 'ready'; version: string | null; lastSeenAt: Date | null; hostname: string };

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

/* The company's machine the server and its built-in node run on: the one whose key hashes to what install.sh gave the
   server. The pool counts that computer once. None for a server installed before, or on a computer that never joined. */
export async function builtinMachine(db: Db, hostId: string | null, companyId: string): Promise<{ id: string; hostname: string } | null> {
  if (!hostId) return null;
  const rows = await db
    .select({ id: machines.id, hostname: machines.hostname, key: machines.machineKey })
    .from(machines)
    .where(and(eq(machines.companyId, companyId), isNull(machines.revokedAt)))
    .orderBy(asc(machines.createdAt));
  const same = rows.find(m => hashToken(`hornhoof-host:${m.key}`) === hostId);
  return same ? { id: same.id, hostname: same.hostname } : null;
}

/* The machine a node is on; none for the built-in node. */
export async function machineOf(db: Db, node: NodeIdentity | null): Promise<{ id: string; hostname: string } | null> {
  if (node?.kind !== 'node') return null;
  const [row] = await db.select({ id: machines.id, hostname: machines.hostname }).from(nodes).innerJoin(machines, eq(machines.id, nodes.machineId)).where(eq(nodes.id, node.nodeId));
  return row ?? null;
}

/* A plan's state from its nodes: waiting for a machine while none is left, ready while one is signed in, needing a
   sign-in otherwise. Works inside a transaction too. */
export async function settlePlans(db: Db, subscriptionIds: (string | null)[]): Promise<void> {
  const ids = [...new Set(subscriptionIds.filter((id): id is string => id !== null))];
  if (!ids.length) return;
  const of = (status?: 'ready') =>
    sql`exists (select 1 from ${nodes} where ${nodes.subscriptionId} = ${subscriptions.id} and ${nodes.keyHash} is not null${status ? sql` and ${nodes.status} = ${status}` : sql``})`;
  await db
    .update(subscriptions)
    .set({ status: sql<'ready' | 'needs_login' | 'waiting_machine'>`case when ${of('ready')} then 'ready' when ${of()} then 'needs_login' else 'waiting_machine' end` })
    .where(and(inArray(subscriptions.id, ids), eq(subscriptions.kind, 'personal')));
}
