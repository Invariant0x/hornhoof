import type { Limits, QuotaRefusal, UsageObservation } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import type { Ctx, Db } from '../../app.js';
import { subscriptions } from '../../db/schema.js';
import { observeQuota, refuseQuota, type UsageConnection } from './quota.js';
import { projectBudgetRefusal, projectBudgetUsage } from './budget-usage.js';

export async function storeUsage(ctx: Ctx, subscriptionId: string, observation: UsageObservation | undefined, connection: UsageConnection | undefined): Promise<void> {
  if (!observation || !connection) return;
  await ctx.db.transaction(tx => mergeUsage(tx, subscriptionId, observation, connection));
}

type Store = Pick<Db, 'select' | 'update'>;

function limitsAfter(previous: Limits | null, observation: UsageObservation, accepted: boolean): Limits | null {
  if (!accepted || observation.outcome !== 'success' || !observation.complete) return previous;
  return { status: observation.status, windows: observation.windows, complete: true };
}

export async function mergeUsage(tx: Store, subscriptionId: string, observation: UsageObservation | undefined, connection: UsageConnection | undefined): Promise<void> {
  if (!observation || !connection) return;
  const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId)).for('update');
  if (!sub || sub.removedAt) return;
  const now = new Date();
  const next = observeQuota(sub.quotaState, observation, connection, now.getTime());
  const accepted = next !== sub.quotaState;
  const quotaState = { ...(next ?? { latest: null, blocked: null, recovered: null }), usage: projectBudgetUsage(sub.quotaState?.usage, observation, accepted, now.toISOString()) };
  const limits = limitsAfter(sub.limits, observation, accepted);
  await tx.update(subscriptions).set({ quotaState, limits }).where(eq(subscriptions.id, sub.id));
}

export async function mergeRefusal(tx: Store, subscriptionId: string, refusal: QuotaRefusal | null): Promise<void> {
  if (!refusal) return;
  const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId)).for('update');
  if (!sub || sub.removedAt) return;
  const next = refuseQuota(sub.quotaState, refusal);
  if (next === sub.quotaState) return;
  const quotaState = { ...next, usage: projectBudgetRefusal(sub.quotaState?.usage, refusal, new Date().toISOString()) };
  await tx.update(subscriptions).set({ quotaState }).where(eq(subscriptions.id, sub.id));
}
