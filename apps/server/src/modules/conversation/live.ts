import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { jobs, subscriptions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { identityOf, sameNode, type NodeIdentity } from '../nodes/hub.js';
import { incomingEnvelope } from '../events/parties.js';
import { addressed } from './prompt.js';
import { cancelUnattemptedLive, cancelUnsentDelivery, reserveDelivery, wordsDigest } from '../program-operator/deliveries.js';
import { liveInputOf, rememberLiveInput } from '../program-operator/input.js';

/* How long Hornhoof waits for the node to say the words went in before it gives them the agent's next turn. */
const SAY_WAIT_MS = 15_000;
/* Leave time for both network trips and the node's Enter check. */
const SAY_MARGIN_MS = 5_000;

type Waiting = { node: NodeIdentity; done: (ok: boolean) => void };
type MessageSource = { personId?: string | null; data?: unknown };
const waiting = new WeakMap<Ctx, Map<string, Waiting>>();

const nothingBefore = async (): Promise<void> => {};

export const messageNotDelivered = (): ApiError => new ApiError(409, 'conflict', 'The message did not reach the employee. Check its window and try again.', 'agent_not_ready');

function liveEnvelope(ctx: Ctx, companyId: string, agentId: string, source?: MessageSource) {
  return incomingEnvelope(ctx, companyId, agentId, source?.personId, source?.data);
}

/* Words for an agent whose turn runs in a live terminal go into that turn at once, typed as a person types; with taskId,
   only into a turn on that task. The running turn's job, or null when none runs or the words could not go in. before
   runs once the turn is found, before the words go. */
export async function sayLive(
  ctx: Ctx,
  agentId: string,
  text: string,
  taskId?: string,
  source?: MessageSource,
  before: (jobId: string) => Promise<void> = nothingBefore,
  required = false,
): Promise<string | null> {
  const [running] = await ctx.db
    .select({ id: jobs.id, companyId: jobs.companyId, taskId: jobs.taskId, nodeId: jobs.nodeId, sub: subscriptions })
    .from(jobs)
    .innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
    .where(and(eq(jobs.agentId, agentId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'), isNull(jobs.error)))
    .limit(1);
  const node = running && identityOf(running.sub, running.nodeId);
  if (!running || !node || (taskId && running.taskId !== taskId)) return null;
  /* A node without live terminals never takes words into a turn: they wait for the next one. */
  if (!ctx.hub.hasTerminals(node)) return null;
  const message = await liveEnvelope(ctx, running.companyId, agentId, source);
  await before(running.id);
  if (await waitForWords(ctx, node, agentId, addressed(text, message), running, source)) return running.id;
  return missedLive(required);
}

function missedLive(required: boolean): null {
  if (required) throw messageNotDelivered();
  return null;
}

async function waitForWords(ctx: Ctx, node: NodeIdentity, agentId: string, text: string, running: { id: string; companyId: string }, source?: MessageSource): Promise<boolean> {
  const ref = randomUUID();
  const digest = wordsDigest(text);
  const previous = liveInputOf(source?.data, agentId);
  const operatorDelivery = node.kind === 'node' && ctx.hub.hasProgramOperator(node)
    ? previous?.jobId === running.id && previous.digest === digest ? previous.delivery : await reserveDelivery(ctx.db, { companyId: running.companyId, agentId, jobId: running.id, nodeId: node.nodeId, kind: 'live', words: text, reference: `live:${ref}` }) : undefined;
  if (operatorDelivery) rememberLiveInput(source?.data, agentId, { delivery: operatorDelivery, jobId: running.id, digest });
  const deadline = Date.now() + SAY_WAIT_MS;
  const map = waiting.get(ctx) ?? new Map<string, Waiting>();
  waiting.set(ctx, map);
  let sent = false;
  let refused = false;
  const went = await new Promise<boolean>(done => {
    const timer = setTimeout(() => done(false), SAY_WAIT_MS);
    const end = (went: boolean) => {
      clearTimeout(timer);
      done(went && Date.now() < deadline);
    };
    map.set(ref, { node, done: went => { refused = !went; end(went); } });
    try {
      sent = ctx.hub.send(node, { type: 'agent.say', agentKey: agentId, text, ref, within: SAY_WAIT_MS - SAY_MARGIN_MS, ...(operatorDelivery ? { operatorDelivery } : {}) });
      if (!sent) end(false);
    } catch {
      end(false);
    }
  }).finally(() => map.delete(ref));
  if (!sent && operatorDelivery) await cancelUnsentDelivery(ctx.db, operatorDelivery);
  else if (refused && operatorDelivery) await cancelUnattemptedLive(ctx.db, operatorDelivery);
  return went;
}

/* The node's word on words Hornhoof sent it to type. */
export function said(ctx: Ctx, node: NodeIdentity, ref: string, ok: boolean): void {
  const w = waiting.get(ctx)?.get(ref);
  if (w && sameNode(w.node, node)) w.done(ok);
}
