import type { NodeMessage } from '@hornhoof/protocol';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, jobs } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { nodeOfAgent } from '../conversation/queue.js';
import { appendEvent } from '../events/store.js';
import { sameNode, type NodeIdentity } from './hub.js';

type Rejection = Extract<NodeMessage, { type: 'agent.hook_rejected' }>;
const EVERY_MS = 60_000;
const recent = new WeakMap<Ctx, Map<string, number>>();

async function ownedAgent(ctx: Ctx, id: NodeIdentity, key: string) {
  if (!z.uuid().safeParse(key).success) return null;
  const node = await nodeOfAgent(ctx, key);
  if (!node || !sameNode(node, id)) return null;
  const [agent] = await ctx.db.select({ id: agents.id, companyId: agents.companyId, name: agents.name }).from(agents).where(and(eq(agents.id, key), isNull(agents.removedAt)));
  return agent ?? null;
}

function repeated(ctx: Ctx, msg: Rejection, now: number): boolean {
  const seen = recent.get(ctx) ?? new Map<string, number>();
  recent.set(ctx, seen);
  const key = JSON.stringify([msg.agentKey, msg.event, msg.reason]);
  if (now - (seen.get(key) ?? -Infinity) < EVERY_MS) return true;
  for (const [key, at] of seen) if (now - at >= EVERY_MS) seen.delete(key);
  seen.set(key, now);
  return false;
}

/* A warning from this agent's node is readable on its current turn; between turns it is a server log line instead.
   It never counts as an assistant answer and never changes the turn's result. */
export async function hookRejected(ctx: Ctx, id: NodeIdentity, msg: Rejection, scope: SQL): Promise<void> {
  const agent = await ownedAgent(ctx, id, msg.agentKey);
  if (!agent || repeated(ctx, msg, Date.now())) return;
  const [job] = await ctx.db.select(idOnly(jobs)).from(jobs).where(and(eq(jobs.agentId, agent.id), eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'), scope)).limit(1);
  if (job) {
    await appendEvent(ctx, { companyId: agent.companyId, agentId: agent.id, jobId: job.id, kind: 'hook_rejected', data: { event: msg.event, reason: msg.reason } });
  } else {
    ctx.log.warn({ agentId: agent.id, agent: agent.name, hook: msg.event, reason: msg.reason }, 'Agent hook rejected.');
  }
}
