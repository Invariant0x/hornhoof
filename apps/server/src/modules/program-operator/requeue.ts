import { OperatorDelivery, type OperatorDelivery as Delivery, type OperatorEvidence, type ProgramNodeMessage } from '@hornhoof/protocol/program-operator';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { agentEvents, agents, jobs, programDeliveries } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { withInputLock } from '../conversation/decision-context.js';
import { insertTurn, pump, settleWords } from '../conversation/queue.js';
import { onAgent } from '../conversation/line.js';
import { deliveredWords, repeatedTurn, UNHEARD_NOTE, wordsForTurn } from '../conversation/turn-words.js';
import { nodeIdentity, type NodeIdentity } from '../nodes/hub.js';
import { logTurnFact } from '../tasks/turn-log.js';
import { wordsDigest } from './deliveries.js';
import { operatorTransaction } from './transactions.js';

type Unheard = Extract<ProgramNodeMessage, { type: 'agent.unheard' }>;

/* A delivery's hidden fallback marker belongs to its recipient and survives server restart, unlike an in-memory retry. */
export async function requeueOperatorWords(ctx: Ctx, node: NodeIdentity, message: Unheard, now: Date): Promise<boolean> {
  if (!message.operatorDelivery) return false;
  const parsed = OperatorDelivery.safeParse(message.operatorDelivery);
  if (!parsed.success || node.kind !== 'node' || !message.jobId) return true;
  const metadata = parsed.data;
  const settled = await withInputLock(ctx, message.agentKey, () => onAgent(ctx, message.agentKey, () => operatorTransaction(ctx,
    (tx, inside) => recordFallback(tx, inside, node.nodeId, message, metadata, now))));
  if (settled) settleWords(ctx, message.agentKey, settled.jobId);
  await pump(ctx, message.agentKey);
  return true;
}


type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type StoredDelivery = typeof programDeliveries.$inferSelect;
type StoredAgent = typeof agents.$inferSelect;

/* A finalized delivery is the durable fallback intent; the optional legacy unheard packet is not required. */
export async function recordOperatorFallback(tx: Tx, inside: Ctx, frame: OperatorEvidence, now: Date) {
  if (frame.type !== 'program.delivery' || frame.kind !== 'live' || (frame.phase !== 'not_taken' && frame.phase !== 'taken')) return;
  const [delivery] = await tx.select().from(programDeliveries).where(eq(programDeliveries.id, frame.deliveryId));
  if (!delivery) return;
  const message = await fallbackMessage(inside, delivery);
  if (!message) return;
  return recordFallback(tx, inside, delivery.nodeId, message, { id: delivery.id, ordinal: delivery.ordinal }, now);
}

/* A source event can commit after its delivery fact. Restore those intents after restart without a second send. */
export async function reconcileOperatorFallbacks(ctx: Ctx, now = new Date()): Promise<void> {
  const rows = await ctx.db.select().from(programDeliveries).where(and(eq(programDeliveries.kind, 'live'), eq(programDeliveries.outcome, 'not_taken'),
    sql`not exists (select 1 from agent_events e where e.agent_id = ${programDeliveries.agentId} and e.kind = 'typed' and e.data->>'operatorFallback' = ${programDeliveries.id}::text)`,
    sql`exists (select 1 from agent_events e where e.agent_id = ${programDeliveries.agentId} and e.job_id = ${programDeliveries.jobId} and e.data->'operatorDelivery'->>'id' = ${programDeliveries.id}::text)`)).limit(100);
  for (const delivery of rows) {
    const message = await fallbackMessage(ctx, delivery);
    if (message) await requeueOperatorWords(ctx, nodeIdentity(delivery.nodeId), message, now);
  }
}

async function fallbackMessage(ctx: Ctx, delivery: StoredDelivery): Promise<Unheard | null> {
  const events = await ctx.db.select(only(agentEvents, 'data')).from(agentEvents).where(and(eq(agentEvents.companyId, delivery.companyId), eq(agentEvents.agentId, delivery.agentId), eq(agentEvents.jobId, delivery.jobId), sql`${agentEvents.data}->'operatorDelivery'->>'id' = ${delivery.id}`));
  for (const event of events) {
    const text = deliveredWords(event.data);
    if (text !== null && wordsDigest(text) === delivery.digest) return { type: 'agent.unheard', agentKey: delivery.agentId, jobId: delivery.jobId, text, operatorDelivery: { id: delivery.id, ordinal: delivery.ordinal } };
  }
  return null;
}

async function recordFallback(tx: Tx, inside: Ctx, nodeId: string, message: Unheard, metadata: Delivery, now: Date) {
  const [agent] = await tx.select().from(agents).where(and(eq(agents.id, message.agentKey), isNull(agents.removedAt))).for('no key update');
  const [delivery] = await tx.select().from(programDeliveries).where(eq(programDeliveries.id, metadata.id));
  if (!agent || !delivery || !validFallbackDelivery(delivery, agent, nodeId, message, metadata)) return;
  const [previous] = await tx.select(only(agentEvents, 'jobId')).from(agentEvents).where(and(eq(agentEvents.agentId, agent.id), eq(agentEvents.kind, 'typed'), sql`${agentEvents.data}->>'operatorFallback' = ${metadata.id}`)).limit(1);
  if (delivery.outcome === 'taken') {
    if (previous?.jobId) await tx.update(jobs).set({ status: 'failed', error: 'cancelled', result: 'The program already took these words.', finishedAt: now }).where(and(eq(jobs.id, previous.jobId), eq(jobs.status, 'queued')));
    return;
  }
  const [original] = await tx.select().from(jobs).where(and(eq(jobs.id, delivery.jobId), eq(jobs.agentId, agent.id))).for('update');
  if (!original) return;
  if (previous) return { jobId: original.id };
  return enqueueFallback(inside, agent, original, message.text, metadata, now);
}

function validFallbackDelivery(delivery: StoredDelivery, agent: StoredAgent, nodeId: string, message: Unheard, metadata: Delivery): boolean {
  return delivery.companyId === agent.companyId && delivery.agentId === agent.id && delivery.jobId === message.jobId && delivery.nodeId === nodeId
    && delivery.ordinal === metadata.ordinal && delivery.kind === 'live' && delivery.digest === wordsDigest(message.text);
}

async function enqueueFallback(inside: Ctx, agent: StoredAgent, original: typeof jobs.$inferSelect, text: string, metadata: Delivery, now: Date) {
  const source = (await wordsForTurn(inside, agent.id, original.id, text))[0] ?? null;
  const repeated = await repeatedTurn(inside, original, source);
  const data = repeated.repeated.data;
  repeated.repeated.data = { ...(data && typeof data === 'object' ? data : {}), operatorDelivery: metadata, operatorFallback: metadata.id };
  await insertTurn(inside, { companyId: agent.companyId, agentId: agent.id, prompt: text, ...repeated });
  await logTurnFact(inside, original, UNHEARD_NOTE, { unheardAt: now.toISOString(), operatorDelivery: metadata });
  return { jobId: original.id };
}
