import type { NodeMessage } from '@hornhoof/protocol';
import { and, eq, inArray, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { jobs, subscriptions } from '../../db/schema.js';
import { afterJob } from '../conversation/queue.js';
import { publishWorking } from '../events/store.js';
import { currentRefusal, type UsageConnection } from '../subscriptions/quota.js';
import { mergeRefusal, mergeUsage } from '../subscriptions/quota-store.js';
import type { NodeIdentity } from './hub.js';

type Completion = Extract<NodeMessage, { type: 'job.done' }>;

/* Result and admission evidence commit together; duplicate completions cannot repeat task liveness. */
export async function finishNodeJob(ctx: Ctx, id: NodeIdentity, msg: Completion, scope: SQL, tail: string, connection?: UsageConnection): Promise<void> {
  const completed = await ctx.db.transaction(async tx => {
    const [owned] = await tx.select({ job: jobs, provider: subscriptions.provider }).from(jobs)
      .innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
      .where(and(eq(jobs.id, msg.jobId), inArray(jobs.status, ['queued', 'running']), scope)).for('update');
    if (!owned) return null;
    const now = new Date();
    const quotaRefusal = currentRefusal(msg.quotaRefusal, owned.job, msg, owned.provider, now.getTime());
    await tx.update(jobs).set({ status: msg.ok ? 'done' : 'failed', result: msg.result, tail, error: msg.error, sessionId: msg.sessionId, finishedAt: now, quotaRefusal }).where(eq(jobs.id, msg.jobId));
    await mergeUsage(tx, owned.job.subscriptionId, msg.usageObservation, connection);
    await mergeRefusal(tx, owned.job.subscriptionId, quotaRefusal);
    return owned.job;
  });
  if (!completed) return;
  await publishWorking(ctx, completed.companyId);
  if (msg.error === 'not_logged_in' && id.kind === 'node') await ctx.db.update(subscriptions).set({ status: 'needs_login' }).where(eq(subscriptions.id, id.subscriptionId));
  await afterJob(ctx, msg.jobId);
}
