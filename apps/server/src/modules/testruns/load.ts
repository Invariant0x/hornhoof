import { requiredTestRuntimes, supportsTestProfile, type RepositoryScope, type RuntimeCapability, type NodeLoad } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
import { nodeHeld } from '../updates/drain.js';
import { availableMemory, computerKey } from './capacity.js';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { nodes, subscriptions, testRuns } from '../../db/schema.js';
import { nodeIdentity, type NodeHub, type NodeIdentity, type SaidLoad } from '../nodes/hub.js';
import { expireStaleNodes, liveNode } from '../nodes/nodes.js';

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
  await expireStaleNodes(db);
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

type ProductRun = typeof testRuns.$inferSelect;
type RunPlace = import('./runs.js').Place;
const cacheOwners = new WeakMap<Ctx, Map<string, string>>();
const identityKey = (node: NodeIdentity): string => node.kind === 'builtin' ? 'builtin' : node.nodeId;
function productAffinityKey(ctx: Ctx, place: RunPlace, run: ProductRun): string {
  const snapshot = run.environmentSnapshot!, actual = testCapabilities(ctx, place.node).testRuntimes ?? [];
  const runtime = requiredTestRuntimes(snapshot.description.manifest, snapshot.profile).map(requested => ({ id: requested.id, fingerprint: actual.find(item => item.id === requested.id)!.fingerprint })).sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify([computerKey(place), scopeKey(snapshot.description.repositoryScope), runtime]);
}
function productCapable(ctx: Ctx, place: RunPlace, run: ProductRun, need: number): boolean {
  const capabilities = testCapabilities(ctx, place.node);
  if (capabilities.testEnvironmentVersion !== 1 || nodeHeld(ctx, place.node) || !ctx.hub.isReady(place.node) || ctx.hub.noRunsOf(place.node)) return false;
  if (!place.load || availableMemory(place.load) < need) return false;
  return !run.environmentSnapshot || supportsTestProfile(run.environmentSnapshot, capabilities.testRuntimes ?? []);
}
async function siblingPlaces(ctx: Ctx, place: RunPlace): Promise<RunPlace[]> {
  if (place.builtin) return [place];
  const siblings = await ctx.db.select({ id: nodes.id }).from(nodes).leftJoin(subscriptions, eq(subscriptions.id, nodes.subscriptionId)).where(and(eq(nodes.machineId, place.machineId!), liveNode, isNull(subscriptions.removedAt))).orderBy(asc(nodes.createdAt), asc(nodes.id));
  const loads = siblings.map(node => ctx.hub.loadOf(nodeIdentity(node.id)));
  return siblings.map(node => ({ ...place, node: nodeIdentity(node.id), nodeId: node.id, load: forRun(ctx.hub.loadOf(nodeIdentity(node.id)), loads) }));
}
export async function productPlaces(ctx: Ctx, open: RunPlace[], run: ProductRun, need = 0): Promise<RunPlace[]> {
  if (!run.environmentRequest) return open;
  const selected: RunPlace[] = [], owners = cacheOwners.get(ctx);
  for (const place of open) {
    const candidates = (await siblingPlaces(ctx, place)).filter(candidate => productCapable(ctx, candidate, run, need));
    const owner = run.environmentSnapshot && candidates.find(candidate => owners?.get(productAffinityKey(ctx, candidate, run)) === identityKey(candidate.node));
    const chosen = owner || candidates[0];
    if (chosen) selected.push(chosen);
  }
  return selected;
}
export function noteProductOwner(ctx: Ctx, place: RunPlace, run: ProductRun): void {
  if (!run.environmentSnapshot) return;
  const owners = cacheOwners.get(ctx) ?? new Map<string, string>(); cacheOwners.set(ctx, owners);
  owners.set(productAffinityKey(ctx, place, run), identityKey(place.node));
}

type Capability = { testEnvironmentVersion?: 1; testRuntimes?: RuntimeCapability[] };
const capabilities = new WeakMap<Ctx, Map<string, Capability>>();
const nodeKey = (id: NodeIdentity): string => id.kind === 'builtin' ? 'builtin' : id.nodeId;
export function noteTestCapabilities(ctx: Ctx, id: NodeIdentity, value: Capability): void {
  const known = capabilities.get(ctx) ?? new Map<string, Capability>(); capabilities.set(ctx, known);
  known.set(nodeKey(id), value);
}
export function testCapabilities(ctx: Ctx, id: NodeIdentity): Capability { return capabilities.get(ctx)?.get(nodeKey(id)) ?? {}; }

export const scopeKey = (scope: RepositoryScope): string => `${scope.companyId}:${scope.repositoryOwnerId}:${scope.repoUrlHash}`;
