import { and, eq, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import type { OperatorEvidence } from '@hornhoof/protocol/program-operator';
import type { Ctx } from '../../app.js';
import { agents, jobs, programDeliveries, programOperatorCases } from '../../db/schema.js';
import { insertTurn, NoSubscription, STOPPED_ON_PURPOSE } from '../conversation/queue.js';
import { repeatedTurn } from '../conversation/turn-words.js';
import type { MessageParty } from '../events/parties.js';
import { logTurnFact } from '../tasks/turn-log.js';
import { operatorTransaction } from './transactions.js';

type Case = typeof programOperatorCases.$inferSelect;
/* How a hold ended. A closed case proves a recovery only with its continuation: the outcome says which it was. */
export type HoldEnd = { outcome: string; text: string; actor?: MessageParty };
const BY_OWNER: HoldEnd = { outcome: 'owner_recovered', text: 'The owner passed the screen; the original words continue once.' };
const AT_PROMPT: HoldEnd = { outcome: 'went_on', text: 'The program stood ready with an empty input; the original words continue once.' };
const PROGRAM_GONE: HoldEnd = { outcome: 'program_gone', text: 'The program that waited for the words is gone; the original words continue once.' };
const RECORDED: HoldEnd = { outcome: 'recorded', text: 'The program already recorded the original words.' };
const LATE_RECEIPT: HoldEnd = { outcome: 'recorded', text: 'The program recorded the original words; no duplicate was sent.' };
const STOPPED: HoldEnd = { outcome: 'stopped', text: 'The turn was stopped, so its words do not go on.' };
const FINISHED: HoldEnd = { outcome: 'finished', text: 'The turn finished after all; its words do not go again.' };
const OWNER_TURN: HoldEnd = { outcome: 'owner_turn', text: 'The existing owner turn continues recovery. No second assignment was injected; the original assignment remains in the journal.' };
const BY_ITSELF = ['went_on', 'program_gone'];
const stoppedOnPurpose = (job: typeof jobs.$inferSelect) => STOPPED_ON_PURPOSE.includes(job.error ?? '');

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
  if (!row?.recoveryHold) return;
  if (frame.owner !== false) return continueRecovery(ctx, row, BY_OWNER);
  if (!await wentOnBefore(ctx, row)) await continueRecovery(ctx, row, AT_PROMPT);
}

/* Words go on by themselves once. When that did not help, a person or Operations looks: the hold stays. */
async function wentOnBefore(ctx: Ctx, row: Case): Promise<boolean> {
  const [made] = await ctx.db.select({ id: programOperatorCases.id }).from(programOperatorCases).where(and(eq(programOperatorCases.continuationJobId, row.jobId), sql`${programOperatorCases.resolution}->>'outcome' in (${sql.join(BY_ITSELF.map(outcome => sql`${outcome}`), sql`, `)})`)).limit(1);
  return Boolean(made);
}

/* What ends a hold with nobody looking: a stop, a turn that finished after all, or a program that is gone, whose words no
   question or tool of it can stand in the way of. The caller holds the agent row. */
export async function settleOperatorHold(ctx: Ctx, row: Case): Promise<void> {
  const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, row.jobId));
  if (!job) return;
  if (stoppedOnPurpose(job)) return finishRecovery(ctx, row, null, STOPPED);
  if (job.status === 'done') return finishRecovery(ctx, row, null, FINISHED);
  const [delivery] = row.deliveryId ? await ctx.db.select().from(programDeliveries).where(eq(programDeliveries.id, row.deliveryId)) : [];
  if (delivery && (delivery.outcome === 'cancelled' || delivery.outcome === 'not_taken') && !await wentOnBefore(ctx, row)) await continueRecovery(ctx, row, PROGRAM_GONE);
}

/* The node says the program of these words ended. */
export async function settleDeliveryHolds(ctx: Ctx, deliveryId: string): Promise<void> {
  const rows = await ctx.db.select().from(programOperatorCases).where(and(eq(programOperatorCases.deliveryId, deliveryId), eq(programOperatorCases.recoveryHold, true)));
  for (const row of rows) await settleOperatorHold(ctx, row);
}

/* agent.start is emitted only by an owner opening a view whose physical program is gone. */
export async function resumeOperatorProcess(ctx: Ctx, agentId: string, nodeId: string): Promise<boolean> {
  return operatorTransaction(ctx, async (tx, inside) => {
    await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for('update');
    const rows = await tx.select().from(programOperatorCases).where(and(eq(programOperatorCases.agentId, agentId), eq(programOperatorCases.nodeId, nodeId), eq(programOperatorCases.recoveryHold, true))).for('update');
    if (!rows.length) return false;
    for (const row of rows) await continueRecovery(inside, row, BY_OWNER);
    const [continued] = await tx.select({ id: programOperatorCases.continuationJobId }).from(programOperatorCases).where(and(inArray(programOperatorCases.id, rows.map(row => row.id)), eq(programOperatorCases.recoveryHold, false), isNotNull(programOperatorCases.continuationJobId)));
    return Boolean(continued?.id);
  });
}

export async function continueRecovery(ctx: Ctx, row: Case, end: HoldEnd): Promise<void> {
  const [original] = await ctx.db.select().from(jobs).where(eq(jobs.id, row.jobId));
  const [delivery] = row.deliveryId ? await ctx.db.select().from(programDeliveries).where(eq(programDeliveries.id, row.deliveryId)) : [];
  if (!original || !recoverableJob(original) || !delivery) return;
  if (delivery.receiptAt) return finishRecovery(ctx, row, null, RECORDED);
  const [running] = await ctx.db.select().from(jobs).where(and(eq(jobs.agentId, row.agentId), eq(jobs.status, 'running'))).limit(1);
  if (running) return;
  const continuationJobId = await recoveryContinuation(ctx, row, original, delivery);
  if (continuationJobId) await finishRecovery(ctx, row, continuationJobId, end);
}

function recoverableJob(job: typeof jobs.$inferSelect): boolean {
  return job.status === 'failed' && !stoppedOnPurpose(job);
}

/* The turn that takes these words on, or none while the agent has no plan to run one: the hold stays and the watch calls
   Operations. A retry a node restart queued is that turn already, as the same words must not run twice. */
async function recoveryContinuation(ctx: Ctx, row: Case, original: typeof jobs.$inferSelect, delivery: typeof programDeliveries.$inferSelect): Promise<string | null> {
  const [previous] = await ctx.db.select({ id: jobs.id }).from(jobs).where(or(eq(jobs.continueOf, original.id), eq(jobs.retryOf, original.id))).limit(1);
  if (previous) return previous.id;
  const repeated = await repeatedTurn(ctx, original);
  repeated.repeated.data = { ...(repeated.repeated.data as object), operatorDelivery: { id: delivery.id, ordinal: delivery.ordinal }, operatorRecovery: row.id };
  try {
    return await insertTurn(ctx, { companyId: row.companyId, agentId: row.agentId, prompt: original.requestedPrompt ?? original.prompt, taskId: original.taskId ?? undefined, continueOf: original.id, notBefore: new Date(), ...repeated });
  } catch (err) {
    if (err instanceof NoSubscription) return null;
    throw err;
  }
}

async function finishRecovery(ctx: Ctx, row: Case, continuationJobId: string | null, { outcome, text, actor }: HoldEnd): Promise<void> {
  await ctx.db.update(programOperatorCases).set({ status: 'resolved', recoveryHold: false, continuationJobId, revision: row.revision + 1, resolution: { outcome, text, image: row.pictureId, ...(actor ? { actor } : {}) } }).where(eq(programOperatorCases.id, row.id));
  const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, row.jobId));
  await logTurnFact(ctx, job!, text, { notification: { source: 'program_operator', tasks: [] }, operatorRecovery: row.id, continuation: continuationJobId });
}

/* A late receipt always wins over an unsent child, including after readiness already resolved its case. The retry of a cut
   turn stays: that the program recorded the words does not mean it did them before the node went. */
export async function reconcileRecoveryReceipts(ctx: Ctx, agentId: string): Promise<void> {
  const rows = await ctx.db.select({ incident: programOperatorCases, delivery: programDeliveries }).from(programOperatorCases).innerJoin(programDeliveries, eq(programDeliveries.id, programOperatorCases.deliveryId)).where(eq(programOperatorCases.agentId, agentId));
  for (const { incident, delivery } of rows) {
    if (!delivery.receiptAt) continue;
    if (incident.continuationJobId) await ctx.db.update(jobs).set({ status: 'failed', error: 'cancelled', result: 'The program already recorded these words.', finishedAt: new Date() }).where(and(eq(jobs.id, incident.continuationJobId), eq(jobs.status, 'queued'), isNotNull(jobs.continueOf)));
    if (incident.recoveryHold) await finishRecovery(ctx, incident, incident.continuationJobId, LATE_RECEIPT);
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
      await finishRecovery(inside, row, typed.id, OWNER_TURN);
    }
  });
}
