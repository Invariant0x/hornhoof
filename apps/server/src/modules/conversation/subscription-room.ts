import { and, count, eq, isNull, ne } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { jobs, nodes, subscriptions } from '../../db/schema.js';
import { ownMachine, type NodeIdentity } from '../nodes/hub.js';
import { roomFor } from '../nodes/program-room.js';
import { lookRoom, placement, type PlacedAgent, type Placement } from './placement.js';

type Reader = Pick<Db, 'select'>;
type Plan = Pick<typeof subscriptions.$inferSelect, 'id' | 'kind' | 'label' | 'turnLimit'>;
type MachineRoom = (node: NodeIdentity, machineId: string) => boolean;
export type SubscriptionWait = { label: string; running: number; limit: number };

async function runningByMachine(db: Reader, subscriptionId: string, own: string, replacing?: string) {
  const rows = await db.select({ personal: nodes.machineId, builtin: jobs.builtinMachine, running: count() })
    .from(jobs).leftJoin(nodes, eq(jobs.nodeId, nodes.id))
    .where(and(eq(jobs.subscriptionId, subscriptionId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'), replacing ? ne(jobs.id, replacing) : undefined))
    .groupBy(nodes.machineId, jobs.builtinMachine);
  const personal = new Map<string, number>();
  const builtin = new Map<string, number>();
  for (const row of rows) {
    const counts = row.personal ? personal : builtin;
    const machine = row.personal ?? row.builtin ?? own;
    counts.set(machine, (counts.get(machine) ?? 0) + row.running);
  }
  return (node: NodeIdentity, machineId: string) => (node.kind === 'node' ? personal : builtin).get(machineId) ?? 0;
}

function belowLimit(running: Awaited<ReturnType<typeof runningByMachine>>, limit: number): MachineRoom {
  return (node, machineId) => running(node, machineId) < limit;
}

/* Choose a machine with room while preserving its other placement constraints. The claim checks it again under lock. */
export async function turnPlacement(ctx: Ctx, agent: PlacedAgent, plan: Plan): Promise<Placement | null> {
  const running = await runningByMachine(ctx.db, plan.id, ownMachine(ctx.config));
  return placement(ctx, agent, plan, node => roomFor(ctx, node, agent.id), belowLimit(running, plan.turnLimit));
}

export async function subscriptionWait(ctx: Ctx, agent: PlacedAgent, plan: Plan, place: Placement): Promise<SubscriptionWait | null> {
  const running = await runningByMachine(ctx.db, plan.id, ownMachine(ctx.config));
  const n = running(place.node, place.machineId);
  if (n < plan.turnLimit || await placement(ctx, agent, plan, lookRoom(ctx, agent), belowLimit(running, plan.turnLimit))) return null;
  return { label: plan.label, running: n, limit: plan.turnLimit };
}

/* The subscription row serializes concurrent claims and changes to the ceiling. A caller holds it until its job is running. */
export async function holdsTurnForRoom(db: Reader, subscriptionId: string, node: NodeIdentity, own: string, replacing?: string): Promise<boolean> {
  const [plan] = await db.select({ limit: subscriptions.turnLimit }).from(subscriptions)
    .where(and(eq(subscriptions.id, subscriptionId), isNull(subscriptions.removedAt))).for('no key update');
  if (!plan) return true;
  const [machine] = node.kind === 'node' ? await db.select({ id: nodes.machineId }).from(nodes).where(eq(nodes.id, node.nodeId)) : [];
  const machineId = node.kind === 'builtin' ? node.machine : machine?.id;
  if (!machineId) return true;
  const running = await runningByMachine(db, subscriptionId, own, replacing);
  return running(node, machineId) >= plan.limit;
}
