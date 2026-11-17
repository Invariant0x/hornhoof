import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs, machines, nodes, subscriptions, tasks, testParts } from '../../db/schema.js';
import { ownBuiltin, ownMachine, type NodeIdentity } from '../nodes/hub.js';
import { liveNode } from '../nodes/nodes.js';
import { notStep } from '../tools/steps.js';

/* The work that runs on a node now. Each machine that holds the data has a built-in node of its own, so a built-in
   node's work is what names its machine; work that names none is of the built-in node of the machine this server
   runs on, as all of it was before machines had theirs. */
export async function drainWork(ctx: Ctx, node: NodeIdentity) {
  const own = node.kind === 'builtin' && node.machine === ownMachine(ctx.config);
  const onBuiltin = (machine: typeof jobs.builtinMachine | typeof testParts.builtinMachine, id: string) => (own ? or(eq(machine, id), isNull(machine)) : eq(machine, id));
  const here = node.kind === 'builtin' ? and(isNull(jobs.nodeId), onBuiltin(jobs.builtinMachine, node.machine)) : eq(jobs.nodeId, node.nodeId);
  const turns = await ctx.db.select({ id: jobs.id, kind: jobs.kind, companyId: jobs.companyId, task: tasks.number, agent: agents.name })
    .from(jobs).leftJoin(tasks, eq(tasks.id, jobs.taskId)).leftJoin(agents, eq(agents.id, jobs.agentId)).where(and(eq(jobs.status, 'running'), here, notStep));
  const parts = await ctx.db.select({ id: testParts.id, companyId: testParts.companyId }).from(testParts)
    .where(and(eq(testParts.status, 'running'), node.kind === 'builtin' ? and(eq(testParts.builtin, true), onBuiltin(testParts.builtinMachine, node.machine)) : eq(testParts.nodeId, node.nodeId)))
    .orderBy(testParts.part);
  return { turns, parts, turnsLeft: turns.filter(t => t.kind === 'conversation').length, partsLeft: parts.length };
}

type Work = Awaited<ReturnType<typeof drainWork>>;

/* A node on the server's computer by the name the updater knows it by: builtin, or its plan, which labels its container. */
export type ServerNode = { name: string; node: NodeIdentity };

/* All identities on the server's physical host, across companies. The installer also sweeps its personal nodes. */
export async function namedServerNodes(ctx: Ctx): Promise<ServerNode[]> {
  const builtin: ServerNode = { name: 'builtin', node: ownBuiltin(ctx.config) };
  if (!ctx.config.hostId) return [builtin];
  const { hashToken } = await import('../../crypto/tokens.js');
  const hosts = await ctx.db.select({ id: machines.id, key: machines.machineKey }).from(machines).where(isNull(machines.revokedAt));
  const ids = hosts.filter(m => hashToken(`hornhoof-host:${m.key}`) === ctx.config.hostId).map(m => m.id);
  const own = ids.length ? await ctx.db.select({ id: nodes.id, plan: nodes.subscriptionId }).from(nodes).where(and(inArray(nodes.machineId, ids), liveNode)) : [];
  return [builtin, ...own.map(n => ({ name: n.plan ?? n.id, node: { kind: 'node' as const, nodeId: n.id } }))];
}

export const serverNodes = async (ctx: Ctx): Promise<NodeIdentity[]> => (await namedServerNodes(ctx)).map(n => n.node);

/* The turns a node waits for, by agent and task, of this company only. */
export const namedWork = (work: Work, companyId: string) =>
  work.turns.flatMap(t => (t.companyId === companyId && t.kind === 'conversation' && t.agent ? [{ agent: t.agent, task: t.task }] : []));

export type Place = { provider: string | null; hostname: string };

/* The plan and the machine of those of these nodes that are this company's. */
export async function nodePlaces(ctx: Ctx, companyId: string, ids: string[]): Promise<Map<string, Place>> {
  if (!ids.length) return new Map();
  const rows = await ctx.db.select({ id: nodes.id, provider: subscriptions.provider, hostname: machines.hostname })
    .from(nodes).innerJoin(machines, eq(machines.id, nodes.machineId)).leftJoin(subscriptions, eq(subscriptions.id, nodes.subscriptionId))
    .where(and(eq(nodes.companyId, companyId), inArray(nodes.id, ids)));
  return new Map(rows.map(r => [r.id, { provider: r.provider, hostname: r.hostname }]));
}
