import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, departments, jobs, machines, nodes, tasks, testParts } from '../../db/schema.js';
import { enqueueTurn } from '../conversation/queue.js';
import type { NodeIdentity } from '../nodes/hub.js';
import { liveNode } from '../nodes/nodes.js';

export async function drainWork(ctx: Ctx, target: NodeIdentity | NodeIdentity[], companyId?: string) {
  const targets = Array.isArray(target) ? target : [target];
  const ids = targets.flatMap(n => n.kind === 'node' ? [n.nodeId] : []);
  const builtin = targets.some(n => n.kind === 'builtin');
  const here = or(builtin ? isNull(jobs.nodeId) : undefined, ids.length ? inArray(jobs.nodeId, ids) : undefined, companyId ? eq(jobs.companyId, companyId) : undefined) ?? sql`false`;
  const turns = await ctx.db.select({ id: jobs.id, kind: jobs.kind, companyId: jobs.companyId, task: tasks.number })
    .from(jobs).leftJoin(tasks, eq(tasks.id, jobs.taskId)).where(and(eq(jobs.status, 'running'), here));
  const parts = await ctx.db.select({ id: testParts.id, companyId: testParts.companyId }).from(testParts)
    .where(and(eq(testParts.status, 'running'), or(builtin ? eq(testParts.builtin, true) : undefined, ids.length ? inArray(testParts.nodeId, ids) : undefined) ?? sql`false`));
  return { turns, parts, turnsLeft: turns.filter(t => t.kind === 'conversation').length, partsLeft: parts.length };
}

export async function drainPostponed(ctx: Ctx, targets: NodeIdentity[], retryAt: string, work: Awaited<ReturnType<typeof drainWork>>): Promise<void> {
  const ids = targets.flatMap(n => n.kind === 'node' ? [n.nodeId] : []);
  const rows = ids.length ? await ctx.db.select({ hostname: machines.hostname }).from(nodes).innerJoin(machines, eq(machines.id, nodes.machineId)).where(inArray(nodes.id, ids)) : [];
  const name = [...new Set([...(targets.some(n => n.kind === 'builtin') ? ['the built-in node'] : []), ...rows.map(r => r.hostname)])].join(', ');
  const affected = new Set([...work.turns, ...work.parts].map(t => t.companyId));
  for (const companyId of affected) {
    const ops = ctx.db.select({ id: departments.id }).from(departments).where(and(eq(departments.companyId, companyId), eq(departments.templateKey, 'operations')));
    const [head] = await ctx.db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.kind, 'head'), inArray(agents.departmentId, ops), isNull(agents.removedAt)));
    if (!head) continue;
    const turns = work.turns.filter(t => t.companyId === companyId).map(t => `${t.id}${t.task ? ` (#${t.task})` : ''}`).join(', ') || 'none';
    const parts = work.parts.filter(t => t.companyId === companyId).map(t => t.id).join(', ') || 'none';
    const text = `Hornhoof postponed the planned update of ${name}: its waiting deadline expired. No running work was stopped. Turns: ${turns}. Run parts: ${parts}. It will try again at ${retryAt}.`;
    await enqueueTurn(ctx, { companyId, agentId: head.id, prompt: text, createdBy: null, message: { personId: null, text, notification: { source: 'machine', tasks: [], detail: { en: name, ru: name } } } });
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
