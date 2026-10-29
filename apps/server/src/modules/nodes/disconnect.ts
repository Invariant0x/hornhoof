import { and, inArray, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { jobs, machines, subscriptions } from '../../db/schema.js';
import { failOpenJobs } from './messages.js';

/* Stops these machines' nodes: open jobs fail, sockets close, and the subscriptions wait for a machine again. */
export async function disconnectMachines(ctx: Ctx, machineIds: string[]): Promise<void> {
  if (machineIds.length === 0) return;
  const served = and(inArray(subscriptions.machineId, machineIds), isNull(subscriptions.removedAt));
  const ids = (await ctx.db.select({ id: subscriptions.id }).from(subscriptions).where(served)).map(s => s.id);
  if (ids.length) await failOpenJobs(ctx, inArray(jobs.subscriptionId, ids), 'machine_disconnected');
  await ctx.db.transaction(async tx => {
    await tx.update(machines).set({ revokedAt: new Date() }).where(inArray(machines.id, machineIds));
    await tx.update(subscriptions).set({ machineId: null, nodeKeyHash: null, status: 'waiting_machine' }).where(served);
  });
  /* After the update, so a status message still in flight cannot mark the subscription ready again. */
  for (const id of ids) ctx.hub.close(id, 4001);
}
