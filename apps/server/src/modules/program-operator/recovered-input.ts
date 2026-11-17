import { and, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, jobs, programDeliveries, programOperatorCases } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { wordsForTurn } from '../conversation/turn-words.js';
import { wordsDigest } from './deliveries.js';

/* The ordinary live-word window may have elapsed while the owner passed setup. Durable assignment identity remains. */
export async function queuedOperatorAssignment(ctx: Ctx, agentId: string, jobId: string, text: string) {
  const [bound] = await ctx.db.select({ job: jobs, delivery: programDeliveries, incident: programOperatorCases }).from(programDeliveries)
    .innerJoin(jobs, eq(jobs.id, programDeliveries.jobId)).innerJoin(programOperatorCases, eq(programOperatorCases.deliveryId, programDeliveries.id))
    .where(and(eq(programDeliveries.agentId, agentId), eq(programDeliveries.jobId, jobId), eq(programDeliveries.kind, 'assignment'), eq(programDeliveries.outcome, 'taken'), eq(programDeliveries.digest, wordsDigest(text))));
  if (!bound || bound.job.error === 'cancelled' || bound.job.error === 'stale') return null;
  const source = (await wordsForTurn(ctx, agentId, jobId)).at(-1);
  if (!source) return null;
  const [used] = await ctx.db.select(idOnly(agentEvents)).from(agentEvents).where(and(eq(agentEvents.agentId, agentId), sql`${agentEvents.data}->>'queuedEvent' = ${String(source.seq)}`)).limit(1);
  if (used) return null;
  return { seq: source.seq, job: bound.job, source: { ...source, data: { ...source.data as object, operatorDelivery: { id: bound.delivery.id, ordinal: bound.delivery.ordinal } } } };
}
