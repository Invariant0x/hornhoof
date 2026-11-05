import { and, eq, inArray, isNotNull, type SQL } from 'drizzle-orm';
import type { OperatorEvidence } from '@hornhoof/protocol/program-operator';
import type { Ctx } from '../../app.js';
import { agents, jobs, programDeliveries, programOperatorCases } from '../../db/schema.js';
import { insertTurn } from '../conversation/queue.js';
import { repeatedTurn } from '../conversation/turn-words.js';
import { logTurnFact } from '../tasks/turn-log.js';
import { operatorTransaction } from './transactions.js';

type Case = typeof programOperatorCases.$inferSelect;

export async function operatorRecoveryHolds(ctx: Ctx, agentId: string): Promise<boolean> {
  return recoveryHolds(ctx, eq(programOperatorCases.agentId, agentId));
}

export async function operatorHandledFailure(ctx: Ctx, jobId: string): Promise<boolean> {
  return recoveryHolds(ctx, eq(programOperatorCases.jobId, jobId));
}

async function recoveryHolds(ctx: Ctx, scope: SQL): Promise<boolean> {
  const [held] = await ctx.db.select({ id: programOperatorCases.id }).from(programOperatorCases).where(and(scope, eq(programOperatorCases.recoveryHold, true))).limit(1);
  return Boolean(held);
}

/* The caller holds the agent row. The old job stays failed; one new owner continuation takes its pending words. */
export async function acceptOperatorRecovery(ctx: Ctx, frame: OperatorEvidence): Promise<void> {
  if (frame.type !== 'program.recovery_ready') return;
  const [row] = await ctx.db.select().from(programOperatorCases).where(and(eq(programOperatorCases.id, frame.case), eq(programOperatorCases.agentId, frame.agentKey), eq(programOperatorCases.jobId, frame.jobId!), eq(programOperatorCases.instance, frame.instance))).for('update');
  if (row?.recoveryHold) await continueRecovery(ctx, row);
}

/* agent.start is emitted only by an owner opening a view whose physical program is gone. */
export async function resumeOperatorProcess(ctx: Ctx, agentId: string, nodeId: string): Promise<boolean> {
  return operatorTransaction(ctx, async (tx, inside) => {
    await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for('update');
    const rows = await tx.select().from(programOperatorCases).where(and(eq(programOperatorCases.agentId, agentId), eq(programOperatorCases.nodeId, nodeId), eq(programOperatorCases.recoveryHold, true))).for('update');
    if (!rows.length) return false;
    for (const row of rows) await continueRecovery(inside, row);
    const [continued] = await tx.select({ id: programOperatorCases.continuationJobId }).from(programOperatorCases).where(and(inArray(programOperatorCases.id, rows.map(row => row.id)), eq(programOperatorCases.recoveryHold, false), isNotNull(programOperatorCases.continuationJobId)));
    return Boolean(continued?.id);
  });
}

async function continueRecovery(ctx: Ctx, row: Case): Promise<void> {
  const [original] = await ctx.db.select().from(jobs).where(eq(jobs.id, row.jobId));
  const [delivery] = row.deliveryId ? await ctx.db.select().from(programDeliveries).where(eq(programDeliveries.id, row.deliveryId)) : [];
  if (!original || !recoverableJob(original) || !delivery) return;
  if (delivery.receiptAt) return finishRecovery(ctx, row, null, 'The program already recorded the original words.');
  const [running] = await ctx.db.select().from(jobs).where(and(eq(jobs.agentId, row.agentId), eq(jobs.status, 'running'))).limit(1);
  if (running) return;
  const continuationJobId = await recoveryContinuation(ctx, row, original, delivery);
  await finishRecovery(ctx, row, continuationJobId, 'The owner passed the screen; the original words continue once.');
}

function recoverableJob(job: typeof jobs.$inferSelect): boolean {
  return job.status === 'failed' && job.error !== 'cancelled';
}

async function recoveryContinuation(ctx: Ctx, row: Case, original: typeof jobs.$inferSelect, delivery: typeof programDeliveries.$inferSelect): Promise<string> {
  const [previous] = await ctx.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.continueOf, original.id)).limit(1);
  let continuationJobId = previous?.id ?? null;
  if (!continuationJobId) {
    const repeated = await repeatedTurn(ctx, original);
    repeated.repeated.data = { ...(repeated.repeated.data as object), operatorDelivery: { id: delivery.id, ordinal: delivery.ordinal }, operatorRecovery: row.id };
    continuationJobId = await insertTurn(ctx, { companyId: row.companyId, agentId: row.agentId, prompt: original.requestedPrompt ?? original.prompt, taskId: original.taskId ?? undefined, continueOf: original.id, notBefore: new Date(), ...repeated });
  }
  return continuationJobId;
}

async function finishRecovery(ctx: Ctx, row: Case, continuationJobId: string | null, text: string): Promise<void> {
  await ctx.db.update(programOperatorCases).set({ status: 'resolved', recoveryHold: false, continuationJobId, revision: row.revision + 1, resolution: { outcome: 'owner_recovered', text, image: row.pictureId } }).where(eq(programOperatorCases.id, row.id));
  const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, row.jobId));
  await logTurnFact(ctx, job!, text, { notification: { source: 'program_operator', tasks: [] }, operatorRecovery: row.id, continuation: continuationJobId });
}

/* A late receipt always wins over an unsent child, including after readiness already resolved its case. */
export async function reconcileRecoveryReceipts(ctx: Ctx, agentId: string): Promise<void> {
  const rows = await ctx.db.select({ incident: programOperatorCases, delivery: programDeliveries }).from(programOperatorCases).innerJoin(programDeliveries, eq(programDeliveries.id, programOperatorCases.deliveryId)).where(eq(programOperatorCases.agentId, agentId));
  for (const { incident, delivery } of rows) {
    if (!delivery.receiptAt) continue;
    if (incident.continuationJobId) await ctx.db.update(jobs).set({ status: 'failed', error: 'cancelled', result: 'The program already recorded these words.', finishedAt: new Date() }).where(and(eq(jobs.id, incident.continuationJobId), eq(jobs.status, 'queued')));
    if (incident.recoveryHold) await finishRecovery(ctx, incident, incident.continuationJobId, 'The program recorded the original words; no duplicate was sent.');
  }
}

export async function adoptOperatorOwnerTurn(ctx: Ctx, agentId: string, jobId: string, nodeId: string): Promise<void> {
  await operatorTransaction(ctx, async (tx, inside) => {
    await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for('update');
    const [typed] = await tx.select().from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.agentId, agentId), eq(jobs.nodeId, nodeId), eq(jobs.status, 'running')));
    if (!typed) return;
    const rows = await tx.select().from(programOperatorCases).where(and(eq(programOperatorCases.agentId, agentId), eq(programOperatorCases.nodeId, nodeId)));
    for (const row of rows) {
      const [child] = row.continuationJobId ? await tx.select().from(jobs).where(eq(jobs.id, row.continuationJobId)) : [];
      if (!row.recoveryHold && child?.status !== 'queued') continue;
      if (child) await tx.update(jobs).set({ status: 'failed', error: 'cancelled', result: 'The owner already started a turn.', finishedAt: new Date() }).where(and(eq(jobs.id, child.id), eq(jobs.status, 'queued')));
      await tx.update(jobs).set({ continueOf: row.jobId }).where(eq(jobs.id, typed.id));
      await finishRecovery(inside, row, typed.id, 'The existing owner turn continues recovery. No second assignment was injected; the original assignment remains in the journal.');
    }
  });
}
