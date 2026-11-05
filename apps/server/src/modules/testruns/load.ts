import type { NodeLoad } from '@hornhoof/protocol';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { nodes, subscriptions } from '../../db/schema.js';
import { nodeIdentity, type NodeHub, type SaidLoad } from '../nodes/hub.js';
import { liveNode } from '../nodes/nodes.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- strip the timestamp from the public load
const plain = ({ at: _, ...load }: SaidLoad): NodeLoad => load;

/* A machine's load from what its nodes said: they share its processors and memory, of which the newest word counts, and
   each runs jobs of its own. */
export function together(loads: (SaidLoad | null)[]): NodeLoad | null {
  const said = loads.filter((l): l is SaidLoad => l !== null);
  if (!said.length) return null;
  const newest = said.reduce((a, b) => (b.at > a.at ? b : a));
  return { ...plain(newest), tests: said.reduce((n, l) => n + l.tests, 0), jobs: said.reduce((n, l) => n + l.jobs, 0) };
}

/* A part runs on one node, whose local limits count; jobs and tests still belong to the whole machine. */
export function forRun(own: SaidLoad | null, loads: (SaidLoad | null)[]): NodeLoad | null {
  const combined = together(loads);
  return own && combined ? { ...combined, cpus: own.cpus, load: own.load, memFree: own.memFree, memTotal: own.memTotal } : null;
}

/* The nodes that stand for the company's machines: each machine's own and its plans'. A removed plan's node is gone from
   its machine, though it keeps its key until it hears so. Plans that joined with one command came at the same moment, so
   they go by name. */
export async function machineNodes(db: Db, companyId: string) {
  return db
    .select({ id: nodes.id, machineId: nodes.machineId, subscriptionId: nodes.subscriptionId, provider: subscriptions.provider, status: nodes.status, lastSeenAt: nodes.lastSeenAt })
    .from(nodes)
    .leftJoin(subscriptions, eq(subscriptions.id, nodes.subscriptionId))
    .where(and(eq(nodes.companyId, companyId), liveNode, isNull(subscriptions.removedAt)))
    .orderBy(asc(nodes.createdAt), asc(subscriptions.provider), asc(nodes.id));
}

/* A machine as these nodes of it say: online while one of them is, and how busy it is. The machines screen and the pool
   both show it from here, so they never disagree. */
export function machineState(hub: NodeHub, ids: string[]): { online: boolean; load: NodeLoad | null } {
  return { online: ids.some(id => hub.isOnline(nodeIdentity(id))), load: together(ids.map(id => hub.loadOf(nodeIdentity(id)))) };
}
