import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { nodes, subscriptions } from '../../db/schema.js';
import { REPORT_FRESH_MS } from '../copies/qualify.js';
import { liveNode } from './nodes.js';
import { builtinOf, nodeIdentity, type NodeIdentity } from './hub.js';

/* The nodes that stand for the company's machines: each machine's own and its plans'. A removed plan's node is gone from
   its machine, though it keeps its key until it hears so. Plans that joined with one command came at the same moment, so
   they go by name. */
export async function machineNodes(db: Db, scope: string | string[]) {
  return db
    .select({ id: nodes.id, machineId: nodes.machineId, subscriptionId: nodes.subscriptionId, provider: subscriptions.provider, status: nodes.status, lastSeenAt: nodes.lastSeenAt })
    .from(nodes)
    .leftJoin(subscriptions, eq(subscriptions.id, nodes.subscriptionId))
    .where(and(typeof scope === 'string' ? eq(nodes.companyId, scope) : inArray(nodes.machineId, scope), liveNode, isNull(subscriptions.removedAt)))
    .orderBy(asc(nodes.createdAt), asc(subscriptions.provider), asc(nodes.id));
}

type Host = { networkId: string | null; reportAt: Date | null };
type JoinedNode = { id: string; lastSeenAt: Date | null };

export function machineContact(host: Host, peers: JoinedNode[], connected: boolean, now = Date.now()) {
  const report = host.networkId ? host.reportAt : null;
  const seen = peers.reduce((latest, n) => n.lastSeenAt && (!latest || latest < n.lastSeenAt) ? n.lastSeenAt : latest, report);
  return { online: connected || (report !== null && now - report.getTime() <= REPORT_FRESH_MS), lastSeenAt: seen };
}

/* Look up only the hosts these plans name. A sibling socket is evidence of contact with the computer. */
export async function planHostContacts(db: Db, hosts: (Host & { machineId: string; key: string })[], isOnline: (id: NodeIdentity) => boolean, localHostConnected?: (host: Host & { key: string }) => boolean) {
  const unique = new Map(hosts.map(h => [h.machineId, h]));
  const result = new Map<string, ReturnType<typeof machineContact>>();
  if (!unique.size) return result;
  const siblings = await machineNodes(db, [...unique.keys()]);
  for (const [id, h] of unique) {
    const peers = siblings.filter(n => n.machineId === id);
    const connected = peers.some(n => isOnline(nodeIdentity(n.id))) || (h.networkId !== null && isOnline(builtinOf(h.networkId)));
    result.set(id, machineContact(h, peers, connected || Boolean(localHostConnected?.(h))));
  }
  return result;
}
