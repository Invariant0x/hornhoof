import { OperatorNodeMessage, type OperatorEvidence } from '@hornhoof/protocol/program-operator';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { agentEvents, agents, jobs, nodes, programDeliveries, programInstances, subscriptions } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { loggable } from '../../errors.js';
import { hasCurrentKey } from '../nodes/nodes.js';
import type { NodeIdentity } from '../nodes/hub.js';
import { syncOperatorCases, updateOperatorCases } from './cases.js';
import { pictureSecrets, renderPicture } from './pictures.js';
import { operatorTransaction } from './transactions.js';
import { acceptOperatorRecovery, reconcileRecoveryReceipts, settleDeliveryHolds } from './recovery.js';
import { recordOperatorFallback } from './requeue.js';
import { pump, settleWords } from '../conversation/queue.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type DeliveryFact = Extract<OperatorEvidence, { type: 'program.delivery' }>;
type SettledWords = { jobId: string };

/* The receipt ACK follows the transaction, including immutable evidence and its resulting delivery state. */
export async function acceptOperatorEvidence(ctx: Ctx, node: NodeIdentity, input: OperatorEvidence, now = new Date()): Promise<boolean> {
  const parsed = OperatorNodeMessage.safeParse(input);
  if (!parsed.success || !('evidenceId' in parsed.data) || node.kind !== 'node' || !await authenticatedSource(ctx, node)) return false;
  const frame = parsed.data;
  if (!frame.jobId) return false;
  const { fact, png } = await drawnCheck(ctx, node.nodeId, frame);
  const { accepted, settled } = await commitEvidence(ctx, node.nodeId, fact, png, now);
  if (accepted) await acknowledgeEvidence(ctx, node, fact, settled, now);
  return accepted;
}

/* A screen in a signal becomes the picture of its case, drawn outside the transaction. Its cells stop here, as
   they hold what the picture masks. A screen that cannot be drawn costs the picture, never the signal. */
async function drawnCheck(ctx: Ctx, nodeId: string, frame: OperatorEvidence): Promise<{ fact: OperatorEvidence; png: Buffer | null }> {
  if (frame.type !== 'program.operator_needed' || !frame.check?.screen) return { fact: frame, png: null };
  const fact = { ...frame, check: { ...frame.check, screen: null } };
  const [job] = await ctx.db.select(only(jobs, 'companyId')).from(jobs).where(and(eq(jobs.id, frame.jobId!), eq(jobs.agentId, frame.agentKey), eq(jobs.nodeId, nodeId)));
  if (!job) return { fact, png: null };
  try {
    return { fact, png: renderPicture(frame.check.screen, await pictureSecrets(ctx, job.companyId)).rendered.png };
  } catch (error) {
    ctx.log.error({ error: loggable(error) }, 'Drawing the screen a node saw failed.');
    return { fact, png: null };
  }
}

async function commitEvidence(ctx: Ctx, nodeId: string, frame: OperatorEvidence, png: Buffer | null, now: Date) {
  const settled: SettledWords[] = [];
  const accepted = await operatorTransaction(ctx, async (tx, inside) => {
    const recorded = await recordEvidence(tx, inside, nodeId, frame, png, now);
    if (!recorded) return false;
    const fallback = await recordOperatorFallback(tx, inside, frame, now);
    if (fallback) settled.push(fallback);
    return true;
  });
  return { accepted, settled };
}

async function acknowledgeEvidence(ctx: Ctx, node: NodeIdentity, frame: OperatorEvidence, settled: readonly SettledWords[], now: Date): Promise<void> {
  for (const fallback of settled) settleWords(ctx, frame.agentKey, fallback.jobId);
  ctx.hub.send(node, { type: 'program.evidence_ack', evidenceId: frame.evidenceId });
  await syncOperatorCases(ctx, frame.agentKey, now);
  if (settled.length) void pump(ctx, frame.agentKey).catch(error => ctx.log.error({ error }, 'Restoring finalized live words failed.'));
}

async function authenticatedSource(ctx: Ctx, node: Extract<NodeIdentity, { kind: 'node' }>): Promise<boolean> {
  return ctx.hub.hasProgramOperator(node) && await hasCurrentKey(ctx, node);
}

const programOfWordsEnded = (frame: OperatorEvidence): frame is DeliveryFact => frame.type === 'program.delivery' && frame.kind === 'assignment' && (frame.phase === 'cancelled' || frame.phase === 'not_taken');

async function recordEvidence(tx: Tx, inside: Ctx, nodeId: string, frame: OperatorEvidence, png: Buffer | null, now: Date): Promise<boolean> {
  if (!frame.jobId) return false;
  const [job] = await tx.select({ companyId: jobs.companyId, agentId: agents.id }).from(jobs)
    .innerJoin(agents, eq(agents.id, jobs.agentId)).innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId)).innerJoin(nodes, eq(nodes.id, jobs.nodeId))
    .where(and(eq(jobs.id, frame.jobId), eq(jobs.agentId, frame.agentKey), eq(nodes.id, nodeId), eq(nodes.companyId, agents.companyId), eq(jobs.companyId, agents.companyId), eq(subscriptions.kind, 'personal'), isNotNull(nodes.keyHash), isNull(agents.removedAt))).for('no key update', { of: agents });
  if (!job || !await validDelivery(tx, frame, job.companyId, nodeId)) return false;
  const [old] = await tx.select(only(agentEvents, 'data')).from(agentEvents).where(and(eq(agentEvents.companyId, job.companyId), sql`${agentEvents.data}->>'operatorEvidenceId' = ${frame.evidenceId}`));
  if (old) return sameFact(old.data, frame);
  if (!await bindInstance(tx, job.companyId, nodeId, frame)) return false;
  const [stored] = await tx.insert(agentEvents).values({ companyId: job.companyId, agentId: frame.agentKey, jobId: frame.jobId, kind: 'message', createdAt: now,
    data: { text: 'Program evidence recorded.', turnFact: true, notification: { source: 'program_operator', tasks: [] }, operatorEvidenceId: frame.evidenceId, operatorEvidence: frame },
  }).onConflictDoNothing().returning({ id: agentEvents.id });
  if (!stored) return false;
  if (frame.type === 'program.delivery') await applyDeliveryFact(tx, frame, now);
  await acceptOperatorRecovery(inside, frame);
  await reconcileRecoveryReceipts(inside, frame.agentKey);
  if (programOfWordsEnded(frame)) await settleDeliveryHolds(inside, frame.deliveryId);
  await updateOperatorCases(inside, frame, now, png);
  return true;
}

function sameFact(data: unknown, frame: OperatorEvidence): boolean {
  if (!data || typeof data !== 'object' || !('operatorEvidence' in data)) return false;
  const stored = OperatorNodeMessage.safeParse(data.operatorEvidence);
  return stored.success && JSON.stringify(stored.data) === JSON.stringify(frame);
}

async function validDelivery(tx: Tx, frame: OperatorEvidence, companyId: string, nodeId: string): Promise<boolean> {
  if (frame.type !== 'program.delivery') return true;
  const [delivery] = await tx.select().from(programDeliveries).where(eq(programDeliveries.id, frame.deliveryId));
  return Boolean(delivery && matchesDeliveryTarget(delivery, frame, companyId, nodeId) && matchesDeliveryReceipt(delivery, frame));
}

type StoredDelivery = typeof programDeliveries.$inferSelect;

function matchesDeliveryTarget(delivery: StoredDelivery, frame: DeliveryFact, companyId: string, nodeId: string): boolean {
  return delivery.companyId === companyId && delivery.agentId === frame.agentKey && delivery.jobId === frame.jobId && delivery.nodeId === nodeId;
}

function matchesDeliveryReceipt(delivery: StoredDelivery, frame: DeliveryFact): boolean {
  return delivery.ordinal === frame.deliveryOrdinal && delivery.kind === frame.kind && delivery.digest === frame.wordsDigest && (!delivery.instance || delivery.instance === frame.instance);
}

async function bindInstance(tx: Tx, companyId: string, nodeId: string, frame: OperatorEvidence): Promise<boolean> {
  const [old] = await tx.select().from(programInstances).where(eq(programInstances.id, frame.instance));
  if (old && (old.companyId !== companyId || old.agentId !== frame.agentKey || old.nodeId !== nodeId)) return false;
  await tx.insert(programInstances).values({ id: frame.instance, companyId, agentId: frame.agentKey, nodeId }).onConflictDoNothing();
  const update = instanceState(frame);
  if (Object.keys(update).length) await tx.update(programInstances).set(update).where(eq(programInstances.id, frame.instance));
  return true;
}

function instanceState(frame: OperatorEvidence): Partial<Pick<typeof programInstances.$inferInsert, 'launched' | 'active' | 'exited'>> {
  switch (frame.type) {
    case 'program.launch': return { launched: true };
    case 'program.delivery': return frame.phase === 'activity' ? { active: true } : {};
    case 'program.operator_needed': return frame.reason === 'startup_exit' && frame.exit ? { exited: true } : {};
    case 'program.question':
    case 'program.recovery_ready': return {};
  }
}

async function applyDeliveryFact(tx: Tx, frame: DeliveryFact, now: Date): Promise<void> {
  const [delivery] = await tx.select().from(programDeliveries).where(eq(programDeliveries.id, frame.deliveryId));
  const facts = await tx.selectDistinct({ phase: sql<string>`${agentEvents.data}->'operatorEvidence'->>'phase'` }).from(agentEvents)
    .where(and(eq(agentEvents.agentId, frame.agentKey), sql`${agentEvents.data}->'operatorEvidence'->>'deliveryId' = ${frame.deliveryId}`, sql`${agentEvents.data}->'operatorEvidence'->>'phase' is not null`));
  const outcome = deliveryOutcome(new Set(facts.map(fact => fact.phase)));
  await tx.update(programDeliveries).set({ instance: frame.instance, outcome,
    ...deliveryClocks(delivery!, frame.phase, now),
    finishedAt: outcome !== 'pending' ? delivery!.finishedAt ?? now : null,
  }).where(eq(programDeliveries.id, frame.deliveryId));
}

function deliveryClocks(delivery: StoredDelivery, phase: DeliveryFact['phase'], now: Date): Partial<StoredDelivery> {
  if (phase === 'attempt') return { attemptedAt: delivery.attemptedAt ?? now };
  if (phase === 'queued' || phase === 'taken') return { receiptAt: delivery.receiptAt ?? now };
  if (phase === 'activity') return { firstActivityAt: delivery.firstActivityAt ?? now };
  return {};
}

function deliveryOutcome(phases: ReadonlySet<string>): 'pending' | 'taken' | 'cancelled' | 'not_taken' {
  if (phases.has('taken')) return 'taken';
  if (phases.has('cancelled')) return 'cancelled';
  return phases.has('not_taken') ? 'not_taken' : 'pending';
}
