import { TAIL_BYTES, type NodeMessage } from '@hornhoof/protocol';
import { and, eq, inArray, isNull, notInArray, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { jobs, subscriptions } from '../../db/schema.js';
import { workingCount } from '../events/store.js';
import type { NodeIdentity } from './hub.js';

const OPEN_JOBS = ['queued', 'running'] as const;

/* A node may only touch the jobs of its own subscription; the built-in node those of API keys. */
function jobsOf(id: NodeIdentity, ctx: Ctx): SQL {
  if (id.kind === 'node') return eq(jobs.subscriptionId, id.subscriptionId);
  return inArray(jobs.subscriptionId, ctx.db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.kind, 'api_key')));
}

const lastBytes = (text: string) => {
  const buf = Buffer.from(text);
  return buf.length <= TAIL_BYTES ? text : buf.subarray(buf.length - TAIL_BYTES).toString();
};

/* Open jobs of these subscriptions become failed with the reason, except the ones the node still runs. */
export async function failOpenJobs(ctx: Ctx, scope: SQL, error: string, stillRunning: string[] = []): Promise<void> {
  const conditions = [scope, inArray(jobs.status, OPEN_JOBS)];
  if (stillRunning.length) conditions.push(notInArray(jobs.id, stillRunning));
  await ctx.db.update(jobs).set({ status: 'failed', error, finishedAt: new Date() }).where(and(...conditions));
}

/* How many agents work right now, for the map's counter. */
async function publishWorking(ctx: Ctx, companyId: string): Promise<void> {
  ctx.bus.publish(companyId, { type: 'working', working: await workingCount(ctx.db, companyId) });
}

export async function handleNodeMessage(ctx: Ctx, id: NodeIdentity, msg: NodeMessage): Promise<void> {
  const { db } = ctx;
  const now = new Date();
  switch (msg.type) {
    case 'hello': {
      if (id.kind === 'node') {
        const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, id.subscriptionId));
        if (!sub) return;
        if (sub.removedAt) {
          ctx.hub.send(id, { type: 'remove' });
          return;
        }
        await db
          .update(subscriptions)
          .set({ nodeVersion: msg.version, lastSeenAt: now, status: msg.loggedIn ? 'ready' : 'needs_login' })
          .where(eq(subscriptions.id, sub.id));
      }
      await failOpenJobs(ctx, jobsOf(id, ctx), 'machine_restarted', msg.running);
      return;
    }
    case 'status': {
      if (id.kind !== 'node') return;
      await db
        .update(subscriptions)
        .set({ status: msg.loggedIn ? 'ready' : 'needs_login', limits: msg.limits, lastSeenAt: now })
        .where(and(eq(subscriptions.id, id.subscriptionId), isNull(subscriptions.removedAt)));
      return;
    }
    case 'job.started': {
      const started = await db
        .update(jobs)
        .set({ status: 'running', startedAt: now })
        .where(and(eq(jobs.id, msg.jobId), eq(jobs.status, 'queued'), jobsOf(id, ctx)))
        .returning({ companyId: jobs.companyId });
      for (const { companyId } of started) await publishWorking(ctx, companyId);
      return;
    }
    case 'job.done': {
      const finished = await db
        .update(jobs)
        .set({
          status: msg.ok ? 'done' : 'failed',
          result: msg.result,
          tail: lastBytes(msg.tail),
          error: msg.error,
          sessionId: msg.sessionId,
          finishedAt: now,
        })
        .where(and(eq(jobs.id, msg.jobId), inArray(jobs.status, OPEN_JOBS), jobsOf(id, ctx)))
        .returning({ companyId: jobs.companyId });
      for (const { companyId } of finished) await publishWorking(ctx, companyId);
      return;
    }
    case 'removed': {
      if (id.kind !== 'node') return;
      await db.update(subscriptions).set({ nodeKeyHash: null, machineId: null }).where(eq(subscriptions.id, id.subscriptionId));
      ctx.hub.close(id.subscriptionId, 1000);
      return;
    }
  }
}

/* Jobs keep running on the node while it is away and report after it reconnects, so only the time is kept. */
export async function handleNodeClose(ctx: Ctx, id: NodeIdentity): Promise<void> {
  if (id.kind !== 'node') return;
  await ctx.db.update(subscriptions).set({ lastSeenAt: new Date() }).where(eq(subscriptions.id, id.subscriptionId));
}
