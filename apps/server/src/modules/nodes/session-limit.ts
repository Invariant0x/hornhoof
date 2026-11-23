import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { jobs, machines, nodes } from '../../db/schema.js';
import { nodeIdentity, type NodeIdentity } from './hub.js';
import { closable, closing, closingNeeded, limitRoom, sessionLimit } from './program-room.js';

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

/* A phone at its limit with turns waiting for its room: of the programs on it whose agents have no turn running or waiting,
   the ones idle longest are closed, as many as the waiting turns need. The node closes each once it is idle, after the
   last turn it ran there, so a word that comes late closes nothing of a later turn. Nothing that runs is stopped. */
export async function makeRoom(ctx: Ctx, node: NodeIdentity): Promise<void> {
  const need = node.kind === 'node' ? closingNeeded(ctx, node) : 0;
  const there = need ? closable(ctx, node) : [];
  if (!there.length) return;
  const busy = new Set((await ctx.db.selectDistinct({ agentId: jobs.agentId }).from(jobs)
    .where(and(inArray(jobs.agentId, there), eq(jobs.kind, 'conversation'), inArray(jobs.status, ['queued', 'running'])))).map(row => row.agentId));
  const idle = there.filter(agentId => !busy.has(agentId));
  if (!idle.length || node.kind !== 'node') return;
  const last = await ctx.db.selectDistinctOn([jobs.agentId], { id: jobs.id, agentId: jobs.agentId, finishedAt: jobs.finishedAt }).from(jobs)
    .where(and(inArray(jobs.agentId, idle), eq(jobs.nodeId, node.nodeId), eq(jobs.kind, 'conversation'), isNotNull(jobs.startedAt)))
    .orderBy(jobs.agentId, desc(jobs.createdAt));
  const oldest = last.sort((a, b) => (a.finishedAt?.getTime() ?? 0) - (b.finishedAt?.getTime() ?? 0)).slice(0, need);
  for (const { id, agentId } of oldest) {
    if (!agentId) continue;
    closing(ctx, node, agentId);
    ctx.hub.send(node, { type: 'agent.release', agentKey: agentId, jobId: id });
  }
}
