import { lastBytes, type NodeMessage } from '@hornhoof/protocol';
import { and, eq, inArray, isNull, notInArray, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, jobs, subscriptions } from '../../db/schema.js';
import { said } from '../conversation/live.js';
import { afterJob, liveSubscription, openTypedTurn, pumpWaiting, refusedLimits, startProgram } from '../conversation/queue.js';
import { appendEvent, publishWorking } from '../events/store.js';
import { identityOf, sameNode, type NodeIdentity } from './hub.js';

const OPEN_JOBS = ['queued', 'running'] as const;

/* A node may only touch the jobs of its own subscription; the built-in node those of API keys. */
function jobsOf(id: NodeIdentity, ctx: Ctx): SQL {
  if (id.kind === 'node') return eq(jobs.subscriptionId, id.subscriptionId);
  return inArray(jobs.subscriptionId, ctx.db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.kind, 'api_key')));
}

/* Jobs a node has or had: running ones, and test jobs, which go out the moment they are made.
   A queued conversation turn still waits in Hornhoof and goes out later. */
const ON_NODE = or(eq(jobs.status, 'running'), and(eq(jobs.status, 'queued'), eq(jobs.kind, 'test')));

/* Jobs of these subscriptions that a node had become failed with the reason, except the ones the node still runs.
   A failed turn goes into its conversation and the agent's next turn goes out. */
export async function failOpenJobs(ctx: Ctx, scope: SQL, error: string, stillRunning: string[] = []): Promise<string[]> {
  const conditions = [scope, ON_NODE];
  if (stillRunning.length) conditions.push(notInArray(jobs.id, stillRunning));
  const failed = await ctx.db
    .update(jobs)
    .set({ status: 'failed', error, finishedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: jobs.id, companyId: jobs.companyId });
  for (const companyId of new Set(failed.map(j => j.companyId))) await publishWorking(ctx, companyId);
  for (const { id } of failed) await afterJob(ctx, id);
  return failed.map(j => j.id);
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
          .set({ nodeVersion: msg.version, lastSeenAt: now, status: msg.loggedIn ? 'ready' : 'needs_login', ...(msg.models ? { models: msg.models } : {}) })
          .where(eq(subscriptions.id, sub.id));
      }
      await failOpenJobs(ctx, jobsOf(id, ctx), 'machine_restarted', msg.running);
      ctx.hub.greet(id, msg.terminals === true);
      /* Hornhoof ended these while the node was away, with a stop or a removed subscription; the node stops them now. */
      if (msg.running.length) {
        const open = await db.select({ id: jobs.id }).from(jobs).where(and(inArray(jobs.id, msg.running), inArray(jobs.status, OPEN_JOBS), jobsOf(id, ctx)));
        const keep = new Set(open.map(j => j.id));
        for (const jobId of msg.running) if (!keep.has(jobId)) ctx.hub.send(id, { type: 'job.cancel', jobId });
      }
      await pumpWaiting(ctx);
      return;
    }
    case 'status': {
      if (id.kind !== 'node') return;
      /* A node that started again knows no limits until its program says them; the last ones stay until then. */
      await db
        .update(subscriptions)
        .set({ status: msg.loggedIn ? 'ready' : 'needs_login', lastSeenAt: now, ...(msg.limits ? { limits: msg.limits } : {}), ...(msg.models ? { models: msg.models } : {}) })
        .where(and(eq(subscriptions.id, id.subscriptionId), isNull(subscriptions.removedAt)));
      /* A signed-in subscription may have turns waiting for it. */
      if (msg.loggedIn) await pumpWaiting(ctx);
      return;
    }
    case 'job.event': {
      const [job] = await db
        .select({ companyId: jobs.companyId, agentId: jobs.agentId })
        .from(jobs)
        .where(and(eq(jobs.id, msg.jobId), eq(jobs.status, 'running'), eq(jobs.kind, 'conversation'), jobsOf(id, ctx)));
      if (!job?.agentId) return;
      await appendEvent(ctx, { companyId: job.companyId, agentId: job.agentId, jobId: msg.jobId, kind: msg.event.kind, data: msg.event });
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
      /* The login ran out: the subscription waits for one before the next turn could go out and fail too. */
      if (finished.length && msg.error === 'not_logged_in' && id.kind === 'node') {
        await db.update(subscriptions).set({ status: 'needs_login' }).where(eq(subscriptions.id, id.subscriptionId));
      }
      /* A program that stopped at the plan's usage limit holds the plan's turns, as a plan that says so itself does. */
      if (finished.length && msg.error === 'agent_failed' && id.kind === 'node') {
        const [sub] = await db.select({ limits: subscriptions.limits }).from(subscriptions).where(eq(subscriptions.id, id.subscriptionId));
        const held = refusedLimits(`${msg.result}\n${msg.tail}`, sub?.limits ?? null, now.getTime());
        if (held) await db.update(subscriptions).set({ limits: held }).where(eq(subscriptions.id, id.subscriptionId));
      }
      if (finished.length) await afterJob(ctx, msg.jobId);
      /* The node keeps the end until it hears this, and sends it again after a reconnect; a second one changes nothing. */
      ctx.hub.send(id, { type: 'job.ack', jobId: msg.jobId });
      return;
    }
    case 'turn.open': {
      const opened = await openTypedTurn(ctx, id, msg.agentKey, msg.text, ctx.terminals.typist(msg.agentKey));
      ctx.hub.send(id, { type: 'turn.opened', agentKey: msg.agentKey, jobId: opened?.jobId ?? null, toolToken: opened?.token ?? null, ...(msg.ref ? { ref: msg.ref } : {}) });
      return;
    }
    case 'agent.start':
      await startProgram(ctx, id, msg.agentKey);
      return;
    case 'agent.said':
      said(ctx, id, msg.ref, msg.ok);
      return;
    /* Only the node that runs the agent's subscription tells how full its context is. */
    case 'agent.context': {
      if (!z.uuid().safeParse(msg.agentKey).success) return;
      const sub = await liveSubscription(ctx, msg.agentKey);
      if (!sub || !sameNode(identityOf(sub), id)) return;
      const [agent] = await db
        .update(agents)
        .set({ contextUsed: msg.used })
        .where(and(eq(agents.id, msg.agentKey), isNull(agents.removedAt)))
        .returning({ companyId: agents.companyId });
      if (agent) ctx.bus.publish(agent.companyId, { type: 'context', agentId: msg.agentKey, used: msg.used });
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
  /* A newer connection of the same node keeps the views. */
  if (!ctx.hub.isOnline(id)) ctx.terminals.nodeGone(id);
  if (id.kind !== 'node') return;
  await ctx.db.update(subscriptions).set({ lastSeenAt: new Date() }).where(eq(subscriptions.id, id.subscriptionId));
}
