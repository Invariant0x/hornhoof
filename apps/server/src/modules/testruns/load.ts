import { runsInClass, type RepositoryScope, type RuntimeCapability, type NodeLoad } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
import { idOnly } from '../../db/selections.js';
import { nodeHeld } from '../updates/drain.js';
import { availableMemory } from './capacity.js';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { nodes, subscriptions, testRuns } from '../../db/schema.js';
import { liveNode } from '../nodes/nodes.js';
import { nodeIdentity, type NodeHub, type NodeIdentity, type SaidLoad } from '../nodes/hub.js';
import { latestReport } from '../nodes/host-load.js';
import { machineDisk } from '../nodes/machine-disk.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- strip the timestamp from the public load
const plain = ({ at: _, ...load }: SaidLoad): NodeLoad => load;

/* A machine's load from what its nodes said: they share its processors, memory and disk, of which the newest word counts,
   and each runs jobs of its own and measures its own folder. */
export function together(loads: (SaidLoad | null)[]): NodeLoad | null {
  const said = loads.filter((l): l is SaidLoad => l !== null);
  if (!said.length) return null;
  const newest = latestReport(said)!;
  const disk = machineDisk(said);
  return { ...plain(newest), tests: said.reduce((n, l) => n + l.tests, 0), jobs: said.reduce((n, l) => n + l.jobs, 0), ...(disk ? { disk } : {}) };
}

/* A part runs on one node, whose local limits count; jobs and tests still belong to the whole machine. */
export function forRun(own: SaidLoad | null, combined: NodeLoad | null): NodeLoad | null {
  return own && combined ? { ...combined, cpus: own.cpus, load: own.load, memFree: own.memFree, memTotal: own.memTotal } : null;
}

export { machineNodes } from '../nodes/machine-contact.js';

/* A machine as these nodes of it say: online while one of them is, and how busy it is. The machines screen and the pool
   both show it from here, so they never disagree. */
export function machineState(hub: NodeHub, ids: string[], builtin: NodeIdentity | null = null): { online: boolean; load: NodeLoad | null } {
  const all = [...ids.map(nodeIdentity), ...(builtin ? [builtin] : [])];
  return { online: all.some(id => hub.isOnline(id)), load: together(all.map(id => hub.loadOf(id))) };
}

type ProductRun = typeof testRuns.$inferSelect;
type RunPlace = import('./runs.js').Place;
function productCapable(ctx: Ctx, place: RunPlace, run: Pick<ProductRun, 'environmentSnapshot'>): boolean {
  const capabilities = testCapabilities(ctx, place.node);
  if (capabilities.testEnvironmentVersion !== 1 || nodeHeld(ctx, place.node) || !ctx.hub.isReady(place.node) || ctx.hub.noRunsOf(place.node)) return false;
  if (!place.load) return false;
  return !run.environmentSnapshot || runsInClass(run.environmentSnapshot, capabilities.testRuntimes ?? []);
}
async function siblingPlaces(ctx: Ctx, place: RunPlace): Promise<RunPlace[]> {
  if (place.builtin) return [place];
  const siblings = await ctx.db.select(idOnly(nodes)).from(nodes).leftJoin(subscriptions, eq(subscriptions.id, nodes.subscriptionId)).where(and(eq(nodes.machineId, place.machineId!), liveNode, isNull(subscriptions.removedAt))).orderBy(asc(nodes.createdAt), asc(nodes.id));
  return siblings.map(node => ({ ...place, node: nodeIdentity(node.id), nodeId: node.id, load: forRun(ctx.hub.loadOf(nodeIdentity(node.id)), place.load) }));
}
export async function productPlaces(ctx: Ctx, open: RunPlace[], run: ProductRun, need = 0): Promise<RunPlace[]> {
  if (!run.environmentRequest) return open;
  const selected: RunPlace[] = [];
  for (const place of open) {
    const ready = (await siblingPlaces(ctx, place)).filter(candidate => productCapable(ctx, candidate, run));
    const chosen = ready.find(candidate => availableMemory(candidate.load!) >= need) ?? ready[0];
    if (chosen) selected.push(chosen);
  }
  return selected;
}
/* The node of each machine that takes a product's harness: the one product parts go to, so they find it there. */
export async function harnessPlaces(ctx: Ctx, open: RunPlace[]): Promise<RunPlace[]> {
  const selected: RunPlace[] = [];
  for (const place of open) {
    const chosen = (await siblingPlaces(ctx, place)).find(candidate => productCapable(ctx, candidate, { environmentSnapshot: null }));
    if (chosen && testCapabilities(ctx, chosen.node).testHarness === 1) selected.push(chosen);
  }
  return selected;
}

type Capability = { testEnvironmentVersion?: 1; testRuntimes?: RuntimeCapability[]; testHarness?: 1 };
const capabilities = new WeakMap<Ctx, Map<string, Capability>>();
/* Each machine's built-in node under its own machine, so one's word never takes the place of another's. */
const nodeKey = (id: NodeIdentity): string => id.kind === 'builtin' ? `builtin:${id.machine}` : id.nodeId;
export function noteTestCapabilities(ctx: Ctx, id: NodeIdentity, value: Capability): void {
  const known = capabilities.get(ctx) ?? new Map<string, Capability>(); capabilities.set(ctx, known);
  known.set(nodeKey(id), value);
}
export function testCapabilities(ctx: Ctx, id: NodeIdentity): Capability { return capabilities.get(ctx)?.get(nodeKey(id)) ?? {}; }

export const scopeKey = (scope: RepositoryScope): string => `${scope.companyId}:${scope.repositoryOwnerId}:${scope.repoUrlHash}`;
