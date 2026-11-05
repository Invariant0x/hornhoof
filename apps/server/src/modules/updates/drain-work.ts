import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, departments, jobs, machines, nodes, tasks, testParts } from '../../db/schema.js';
import { enqueueTurn } from '../conversation/queue.js';
import type { NodeIdentity } from '../nodes/hub.js';
import { liveNode } from '../nodes/nodes.js';

export async function drainWork(ctx: Ctx, node: NodeIdentity) {
  const here = node.kind === 'builtin' ? isNull(jobs.nodeId) : eq(jobs.nodeId, node.nodeId);
  const turns = await ctx.db.select({ id: jobs.id, kind: jobs.kind, companyId: jobs.companyId, task: tasks.number })
    .from(jobs).leftJoin(tasks, eq(tasks.id, jobs.taskId)).where(and(eq(jobs.status, 'running'), here));
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

/* All identities on the server's physical host, across companies. The installer also sweeps its personal nodes. */
export async function serverNodes(ctx: Ctx): Promise<NodeIdentity[]> {
  if (!ctx.config.hostId) return [{ kind: 'builtin' }];
  const { hashToken } = await import('../../crypto/tokens.js');
  const hosts = await ctx.db.select({ id: machines.id, key: machines.machineKey }).from(machines).where(isNull(machines.revokedAt));
  const ids = hosts.filter(m => hashToken(`hornhoof-host:${m.key}`) === ctx.config.hostId).map(m => m.id);
  const own = ids.length ? await ctx.db.select({ id: nodes.id }).from(nodes).where(and(inArray(nodes.machineId, ids), liveNode)) : [];
  return [{ kind: 'builtin' }, ...own.map(n => ({ kind: 'node' as const, nodeId: n.id }))];
}
