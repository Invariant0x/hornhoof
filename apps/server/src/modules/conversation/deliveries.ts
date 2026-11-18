import { type Queued } from './turn-types.js';
import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { loggable } from '../../errors.js';
import { jobs } from '../../db/schema.js';
import { type NodeIdentity } from '../nodes/hub.js';
import { DeliveryTargetMismatch, reserveDelivery } from '../program-operator/deliveries.js';
import { sourceDeliveryForJob, sourceDeliveryMetadataForJob } from '../program-operator/input.js';
import type { OperatorDelivery } from '@hornhoof/protocol/program-operator';
import { operatorRecoveryHolds } from '../program-operator/recovery-state.js';
export const heldByOperator = (ctx: Ctx, agent: { id: string; kind: string }): Promise<boolean> | false =>
  agent.kind !== 'assistant' && operatorRecoveryHolds(ctx, agent.id);

export async function turnOperatorDeliveries(
  ctx: Ctx,
  agent: { id: string; kind: string },
  job: { id: string; companyId: string },
  node: NodeIdentity,
  prompt: string,
): Promise<{ operatorDelivery?: OperatorDelivery; operatorSourceDelivery?: OperatorDelivery }> {
  if (agent.kind === 'assistant') return {};
  const operatorDelivery =
    prompt && node.kind === 'node' && ctx.hub.hasProgramOperator(node)
      ? await reserveDelivery(ctx.db, {
          companyId: job.companyId,
          agentId: agent.id,
          jobId: job.id,
          nodeId: node.nodeId,
          kind: 'assignment',
          words: prompt,
          reference: `job:${job.id}`,
          sourceDeliveryId: await sourceDeliveryForJob(ctx.db, agent.id, job.id),
        })
      : undefined;
  return { operatorDelivery, operatorSourceDelivery: await sourceDeliveryMetadataForJob(ctx.db, agent.id, job.id) };
}

export async function failedTurnDelivery(ctx: Ctx, job: Queued, err: unknown): Promise<void> {
  if (err instanceof DeliveryTargetMismatch) {
    const [ended] = await ctx.db.update(jobs).set({ status: 'obsolete', error: 'delivery_target_missing', result: err.message, toolTokenHash: null, finishedAt: new Date() })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, 'running'))).returning({ id: jobs.id });
    if (ended) ctx.log.info({ jobId: job.id, agentId: job.agentId }, 'A turn ended because its program delivery target no longer exists.');
    return;
  }
  ctx.log.error({ error: loggable(err) }, 'A turn could not go out and waits for the next try.');
}
