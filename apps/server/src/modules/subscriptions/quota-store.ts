import type { QuotaRefusal, UsageObservation } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import type { Ctx, Db } from '../../app.js';
import { subscriptions } from '../../db/schema.js';
import { observeQuota, refuseQuota, type UsageConnection } from './quota.js';

export async function storeUsage(ctx: Ctx, subscriptionId: string, observation: UsageObservation | undefined, connection: UsageConnection | undefined): Promise<void> {
  if (!observation || !connection) return;
  await ctx.db.transaction(tx => mergeUsage(tx, subscriptionId, observation, connection));
}

type Store = Pick<Db, 'select' | 'update'>;

export async function mergeUsage(tx: Store, subscriptionId: string, observation: UsageObservation | undefined, connection: UsageConnection | undefined): Promise<void> {
  if (!observation || !connection) return;
  const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId)).for('update');
  if (!sub || sub.removedAt) return;
  const quotaState = observeQuota(sub.quotaState, observation, connection, Date.now());
  if (quotaState === sub.quotaState) return;
  const limits = observation.outcome === 'success' && observation.complete ? { status: observation.status, windows: observation.windows, complete: true } : sub.limits;
  await tx.update(subscriptions).set({ quotaState, limits }).where(eq(subscriptions.id, sub.id));
}

export async function mergeRefusal(tx: Store, subscriptionId: string, refusal: QuotaRefusal | null): Promise<void> {
  if (!refusal) return;
  const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId)).for('update');
  if (!sub || sub.removedAt) return;
  await tx.update(subscriptions).set({ quotaState: refuseQuota(sub.quotaState, refusal) }).where(eq(subscriptions.id, sub.id));
}
