import { createHash } from 'node:crypto';
import type { OperatorDelivery } from '@hornhoof/protocol/program-operator';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, jobs, nodes, programDeliveries } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';

type Reservation = { companyId: string; agentId: string; jobId: string; nodeId: string; kind: 'assignment' | 'live'; words: string; reference: string; sourceDeliveryId?: string };
export const wordsDigest = (words: string): string => createHash('sha256').update(words).digest('hex');

export class DeliveryTargetMismatch extends Error {
  constructor() {
    super('The program delivery target does not match its job and node.');
    this.name = 'DeliveryTargetMismatch';
  }
}

/* The agent row is the counter lock across jobs and physical program replacements. Reservation starts no clock. */
export async function reserveDelivery(db: Db, input: Reservation): Promise<OperatorDelivery> {
  const digest = wordsDigest(input.words);
  return db.transaction(async tx => {
    const [agent] = await tx.select(idOnly(agents)).from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId), isNull(agents.removedAt))).for('no key update');
    const [job] = agent ? await tx.select(idOnly(jobs)).from(jobs).innerJoin(nodes, eq(nodes.id, jobs.nodeId))
      .where(and(eq(jobs.id, input.jobId), eq(jobs.agentId, agent.id), eq(jobs.companyId, input.companyId), eq(nodes.id, input.nodeId), eq(nodes.companyId, input.companyId))) : [];
    if (!job) throw new DeliveryTargetMismatch();
    const [old] = await tx.select().from(programDeliveries).where(and(eq(programDeliveries.agentId, input.agentId), eq(programDeliveries.reference, input.reference)));
    if (old) {
      if (old.digest !== digest || old.kind !== input.kind || old.jobId !== input.jobId || old.nodeId !== input.nodeId) throw new Error('A delivery identity cannot be reused for different words or a different target.');
      return { id: old.id, ordinal: old.ordinal };
    }
    const [last] = await tx.select({ ordinal: sql<number>`coalesce(max(${programDeliveries.ordinal}), 0)`.mapWith(Number) }).from(programDeliveries).where(eq(programDeliveries.agentId, input.agentId));
    const [created] = await tx.insert(programDeliveries).values({ companyId: input.companyId, agentId: input.agentId, jobId: input.jobId, nodeId: input.nodeId, kind: input.kind, digest, reference: input.reference, sourceDeliveryId: input.sourceDeliveryId ?? null, ordinal: last!.ordinal + 1 }).returning({ id: programDeliveries.id, ordinal: programDeliveries.ordinal });
    return created!;
  });
}

/* A socket that rejected a send made no program attempt. A later dispatch may compose new words under a fresh ID. */
export async function cancelUnsentDelivery(db: Db, delivery: OperatorDelivery): Promise<void> {
  await db.update(programDeliveries).set({ outcome: 'cancelled', finishedAt: new Date(), reference: sql`${programDeliveries.reference} || ':unsent:' || ${delivery.id}` })
    .where(and(eq(programDeliveries.id, delivery.id), isNull(programDeliveries.instance), isNull(programDeliveries.attemptedAt)));
}

export async function cancelUnattemptedLive(db: Db, delivery: OperatorDelivery): Promise<void> {
  await db.update(programDeliveries).set({ outcome: 'cancelled', finishedAt: new Date() })
    .where(and(eq(programDeliveries.id, delivery.id), eq(programDeliveries.kind, 'live'), isNull(programDeliveries.instance), isNull(programDeliveries.attemptedAt)));
}
