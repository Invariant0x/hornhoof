import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { jobs, subscriptions } from '../../db/schema.js';
import { identityOf, sameNode, type NodeIdentity } from '../nodes/hub.js';

/* How long Hornhoof waits for the node to say the words went in before it gives them the agent's next turn. */
const SAY_WAIT_MS = 15_000;

type Waiting = { node: NodeIdentity; done: (ok: boolean) => void };
const waiting = new WeakMap<Ctx, Map<string, Waiting>>();

/* Words for an agent whose turn runs in a live terminal go into that turn at once, typed as a person types; with taskId,
   only into a turn on that task. The running turn's job, or null when none runs or the words could not go in. */
export async function sayLive(ctx: Ctx, agentId: string, text: string, taskId?: string): Promise<string | null> {
  const [running] = await ctx.db
    .select({ id: jobs.id, taskId: jobs.taskId, nodeId: jobs.nodeId, sub: subscriptions })
    .from(jobs)
    .innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
    .where(and(eq(jobs.agentId, agentId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'running')))
    .limit(1);
  const node = running && identityOf(running.sub, running.nodeId);
  if (!running || !node || (taskId && running.taskId !== taskId)) return null;
  if (!ctx.hub.hasTerminals(node)) return null;
  const ref = randomUUID();
  const map = waiting.get(ctx) ?? new Map<string, Waiting>();
  waiting.set(ctx, map);
  const ok = await new Promise<boolean>(done => {
    const timer = setTimeout(() => done(false), SAY_WAIT_MS);
    const end = (went: boolean) => {
      clearTimeout(timer);
      done(went);
    };
    map.set(ref, { node, done: end });
    if (!ctx.hub.send(node, { type: 'agent.say', agentKey: agentId, text, ref })) end(false);
  }).finally(() => map.delete(ref));
  return ok ? running.id : null;
}

/* The node's word on words Hornhoof sent it to type. */
export function said(ctx: Ctx, node: NodeIdentity, ref: string, ok: boolean): void {
  const w = waiting.get(ctx)?.get(ref);
  if (w && sameNode(w.node, node)) w.done(ok);
}
