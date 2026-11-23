import { eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { machines, nodes } from '../../db/schema.js';
import { nodeIdentity, type NodeIdentity } from './hub.js';
import { limitRoom, sessionLimit } from './program-room.js';

/* The limit of programs of the node's machine, read as the node says hello: a phone's own, or none. The agents whose new
   programs waited on it, when that leaves room. */
export async function loadSessionLimit(ctx: Ctx, node: NodeIdentity): Promise<string[]> {
  if (node.kind !== 'node') return [];
  const [machine] = await ctx.db.select({ kind: machines.kind, sessions: machines.sessions }).from(nodes).innerJoin(machines, eq(machines.id, nodes.machineId)).where(eq(nodes.id, node.nodeId));
  return machine ? limitRoom(ctx, node, sessionLimit(machine)) : [];
}

/* The machine's owner set its limit: every node of it holds it from now on. The agents whose new programs waited on one of
   them, when that leaves room. */
export async function machineSessionsSet(ctx: Ctx, machine: { id: string; kind: string; sessions: number | null }): Promise<string[]> {
  const here = await ctx.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.machineId, machine.id));
  return here.flatMap(n => limitRoom(ctx, nodeIdentity(n.id), sessionLimit(machine)));
}
