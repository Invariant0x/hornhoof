import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, departments, jobs, machines, nodes, subscriptions, tasks, testParts } from '../../db/schema.js';
import { enqueueTurn } from '../conversation/queue.js';
import type { NodeIdentity } from '../nodes/hub.js';
import { liveNode } from '../nodes/nodes.js';

export async function drainWork(ctx: Ctx, node: NodeIdentity) {
  const here = node.kind === 'builtin' ? isNull(jobs.nodeId) : eq(jobs.nodeId, node.nodeId);
  const turns = await ctx.db.select({ id: jobs.id, kind: jobs.kind, companyId: jobs.companyId, task: tasks.number, agent: agents.name })
    .from(jobs).leftJoin(tasks, eq(tasks.id, jobs.taskId)).leftJoin(agents, eq(agents.id, jobs.agentId)).where(and(eq(jobs.status, 'running'), here));
  const parts = await ctx.db.select({ id: testParts.id, companyId: testParts.companyId }).from(testParts)
    .where(and(eq(testParts.status, 'running'), node.kind === 'builtin' ? eq(testParts.builtin, true) : eq(testParts.nodeId, node.nodeId)));
  return { turns, parts, turnsLeft: turns.filter(t => t.kind === 'conversation').length, partsLeft: parts.length };
}

type Work = Awaited<ReturnType<typeof drainWork>>;

async function machineName(ctx: Ctx, node: NodeIdentity): Promise<string> {
  if (node.kind === 'builtin') return 'the built-in node';
  const [machine] = await ctx.db.select({ hostname: machines.hostname }).from(nodes).innerJoin(machines, eq(machines.id, nodes.machineId)).where(eq(nodes.id, node.nodeId));
  return machine?.hostname || 'a machine';
}

async function headOfOperations(ctx: Ctx, companyId: string): Promise<string | null> {
  const ops = ctx.db.select({ id: departments.id }).from(departments).where(and(eq(departments.companyId, companyId), eq(departments.templateKey, 'operations')));
  const [head] = await ctx.db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.kind, 'head'), inArray(agents.departmentId, ops), isNull(agents.removedAt)));
  return head?.id ?? null;
}

function postponedText(name: string, retryAt: string, work: Work, companyId: string): string {
  const turns = work.turns.filter(t => t.companyId === companyId).map(t => `${t.id}${t.task ? ` (#${t.task})` : ''}`).join(', ') || 'none';
  const parts = work.parts.filter(t => t.companyId === companyId).map(t => t.id).join(', ') || 'none';
  return `Hornhoof postponed the planned update of ${name}: its waiting deadline expired. No running work was stopped. Turns: ${turns}. Run parts: ${parts}. It will try again at ${retryAt}.`;
}

/* Each company with work on the node hears of its own work, and only of that. */
export async function drainPostponed(ctx: Ctx, node: NodeIdentity, retryAt: string, work: Work): Promise<void> {
  const name = await machineName(ctx, node);
  for (const companyId of new Set([...work.turns, ...work.parts].map(t => t.companyId))) {
    const head = await headOfOperations(ctx, companyId);
    if (!head) continue;
    const text = postponedText(name, retryAt, work, companyId);
    await enqueueTurn(ctx, { companyId, agentId: head, prompt: text, createdBy: null, message: { personId: null, text, notification: { source: 'machine', tasks: [], detail: { en: name, ru: name } } } });
  }
}

/* A node on the server's computer by the name the updater knows it by: builtin, or its plan, which labels its container. */
export type ServerNode = { name: string; node: NodeIdentity };

/* All identities on the server's physical host, across companies. The installer also sweeps its personal nodes. */
export async function namedServerNodes(ctx: Ctx): Promise<ServerNode[]> {
  const builtin: ServerNode = { name: 'builtin', node: { kind: 'builtin' } };
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

/* The plan and the machine of those of these nodes that are this company's. */
export async function nodePlaces(ctx: Ctx, companyId: string, ids: string[]) {
  if (!ids.length) return new Map<string, { provider: string | null; hostname: string }>();
  const rows = await ctx.db.select({ id: nodes.id, provider: subscriptions.provider, hostname: machines.hostname })
    .from(nodes).innerJoin(machines, eq(machines.id, nodes.machineId)).leftJoin(subscriptions, eq(subscriptions.id, nodes.subscriptionId))
    .where(and(eq(nodes.companyId, companyId), inArray(nodes.id, ids)));
  return new Map(rows.map(r => [r.id, { provider: r.provider, hostname: r.hostname }]));
}
