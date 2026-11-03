import { lastBytes, type NodeMessage } from '@hornhoof/protocol';
import { and, eq, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, jobs, machines, nodes, planCredentials, subscriptions, tasks, type Interruption } from '../../db/schema.js';
import { said } from '../conversation/live.js';
import { nodeOfAgent, pumpWaiting, refusedLimits, startProgram } from '../conversation/queue.js';
import { workStarts } from '../org/map-state.js';
import { startWork } from '../tasks/engine.js';
import { recordJobProgram } from '../tasks/silent.js';
import { afterJob, typedTurn } from '../tasks/wake.js';
import { appendTurnEvent, publishWorking } from '../events/store.js';
import { partDone, partStarted, pumpTests, testsHello } from '../testruns/runs.js';
import { sameNode, type NodeIdentity } from './hub.js';
import { deliver, pushCredentials, signedIn, storeEnvelopes } from '../subscriptions/credentials.js';
import { liveNode, settlePlans } from './nodes.js';
import { BUILTIN_NAME, interruptionOf } from './restarts.js';
import { hookRejected } from './hook-rejections.js';

const OPEN_JOBS = ['queued', 'running'] as const;

const completionValue = (value: unknown, stopped: string): SQL => sql`case when ${jobs.error} = 'cancelled' then ${stopped} else ${value} end`;

/* A node may only touch the jobs sent to it; the built-in node those of API keys. */
function jobsOf(id: NodeIdentity, ctx: Ctx): SQL {
  if (id.kind === 'node') return eq(jobs.nodeId, id.nodeId);
  return inArray(jobs.subscriptionId, ctx.db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.kind, 'api_key')));
}

/* Jobs a node has or had: running ones, and test jobs, which go out the moment they are made.
   A queued conversation turn still waits in Hornhoof and goes out later. */
const ON_NODE = or(eq(jobs.status, 'running'), and(eq(jobs.status, 'queued'), eq(jobs.kind, 'test')));

/* Why a node restart cut a turn off, with the number of the task it was on; nothing for a turn that failed otherwise. */
const cutOf = (cut?: Omit<Interruption, 'task'>) =>
  cut ? { interruption: sql`${JSON.stringify(cut)}::jsonb || jsonb_build_object('task', (select ${tasks.number} from ${tasks} where ${tasks.id} = ${jobs.taskId}))` } : {};

/* Jobs of these nodes or subscriptions that a node had become failed with the reason, except the ones the node still runs.
   A failed turn goes into its conversation and the agent's next turn goes out. Turns a node restart cut off keep why,
   with the number of the task each was on. */
export async function failOpenJobs(ctx: Ctx, scope: SQL, error: string, stillRunning: string[] = [], cut?: Omit<Interruption, 'task'>): Promise<string[]> {
  const conditions = [scope, ON_NODE];
  if (stillRunning.length) conditions.push(notInArray(jobs.id, stillRunning));
  const failed = await ctx.db
    .update(jobs)
    .set({ status: 'failed', error: completionValue(error, 'cancelled'), result: completionValue(jobs.result, 'Stopped.'), finishedAt: new Date(), ...cutOf(cut) })
    .where(and(...conditions))
    .returning({ id: jobs.id, companyId: jobs.companyId });
  for (const companyId of new Set(failed.map(j => j.companyId))) await publishWorking(ctx, companyId);
  for (const { id } of failed) await afterJob(ctx, id);
  return failed.map(j => j.id);
}

/* An agent's turn on a task, of the jobs a node runs. */
const onTask = (job: { kind: string; taskId: string | null }) => job.kind === 'conversation' && job.taskId !== null;

/* A job the node says it started, one that went out from here rather than from the queue: running from now on. A turn on
   a task begins the new cycle of the map's lines its work keeps on in the same write, as when the queue takes a turn, and
   then its task is at work. */
async function jobStarted(ctx: Ctx, id: NodeIdentity, jobId: string, now: Date): Promise<void> {
  const started = await ctx.db.transaction(async tx => {
    const [row] = await tx
      .update(jobs)
      .set({ status: 'running', startedAt: now })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, 'queued'), jobsOf(id, ctx)))
      .returning({ id: jobs.id, companyId: jobs.companyId, agentId: jobs.agentId, kind: jobs.kind, taskId: jobs.taskId });
    return row ? { row, lines: onTask(row) ? await workStarts(tx, { id: row.id, companyId: row.companyId, agentId: row.agentId, taskIds: [row.taskId] }) : null } : null;
  });
  if (!started) return;
  if (started.lines) ctx.bus.publish(started.lines.companyId, { type: 'org' });
  await publishWorking(ctx, started.row.companyId);
  if (onTask(started.row)) await startWork(ctx, jobId);
}

/* How the turn's program ended, as the node saw it; a node from before says nothing of it. */
const exitOf = (exit?: { code: number | null; signal: string | null }) => ({ exitCode: exit?.code ?? null, exitSignal: exit?.signal ?? null });

type Hello = Extract<NodeMessage, { type: 'hello' }>;

/* What a node's hello changes in its row: what it runs, whether it is signed in, and what it says of itself when it says it. */
const helloRow = (msg: Hello, now: Date) => ({
  version: msg.version,
  lastSeenAt: now,
  status: msg.loggedIn ? ('ready' as const) : ('needs_login' as const),
  ...(msg.publicKey ? { publicKey: msg.publicKey } : {}),
  ...(msg.account !== undefined ? { account: msg.account } : {}),
  ...(msg.boot ? { boot: msg.boot } : {}),
});

/* Why the built-in node's turns are gone. A personal node's comes from its row, once the hello is known to be its own. */
const builtinCut = (ctx: Ctx, id: NodeIdentity, msg: Hello, now: Date) =>
  id.kind === 'builtin' ? interruptionOf(ctx, { id: null, name: BUILTIN_NAME, said: null }, msg, now) : undefined;

const nodeCut = (ctx: Ctx, nodeId: string, row: { node: typeof nodes.$inferSelect; host: string | null }, msg: Hello, now: Date) =>
  interruptionOf(ctx, { id: nodeId, name: row.host || 'a machine with no name', said: { version: row.node.version, boot: row.node.boot } }, msg, now);

export async function handleNodeMessage(ctx: Ctx, id: NodeIdentity, msg: NodeMessage, now = new Date()): Promise<void> {
  const { db } = ctx;
  switch (msg.type) {
    case 'hello': {
      let cut = builtinCut(ctx, id, msg, now);
      if (id.kind === 'node') {
        const [row] = await db
          .select({ node: nodes, removedAt: subscriptions.removedAt, host: machines.hostname })
          .from(nodes)
          .leftJoin(subscriptions, eq(subscriptions.id, nodes.subscriptionId))
          .leftJoin(machines, eq(machines.id, nodes.machineId))
          .where(eq(nodes.id, id.nodeId));
        if (!row) return;
        if (row.removedAt) {
          ctx.hub.send(id, { type: 'remove' });
          return;
        }
        /* A machine disconnected in Hornhoof has no key any more; what its socket still says changes nothing. */
        if (!row.node.keyHash) return;
        /* A node set up again has a new key: what was sealed to its old one is of no use, and gets sealed to the new one. */
        if (msg.publicKey && row.node.publicKey && msg.publicKey !== row.node.publicKey) await db.delete(planCredentials).where(eq(planCredentials.nodeId, id.nodeId));
        cut = nodeCut(ctx, id.nodeId, row, msg, now);
        await db.update(nodes).set(helloRow(msg, now)).where(and(eq(nodes.id, id.nodeId), liveNode));
        const plan = row.node.subscriptionId;
        if (plan && msg.models) await db.update(subscriptions).set({ models: msg.models }).where(eq(subscriptions.id, plan));
        await settlePlans(db, [plan]);
      }
      await failOpenJobs(ctx, jobsOf(id, ctx), 'machine_restarted', msg.running, cut);
      ctx.hub.greet(id, msg.terminals === true, msg.skillFiles === true, msg.work === true, msg.noRuns ?? null);
      if (msg.load) ctx.hub.report(id, msg.load);
      await testsHello(ctx, id, msg.tests);
      /* Hornhoof ended these while the node was away, with a stop or a removed subscription; the node stops them now. */
      if (msg.running.length) {
        const open = await db.select({ id: jobs.id }).from(jobs).where(and(inArray(jobs.id, msg.running), inArray(jobs.status, OPEN_JOBS), jobsOf(id, ctx)));
        const keep = new Set(open.map(j => j.id));
        for (const jobId of msg.running) if (!keep.has(jobId)) ctx.hub.send(id, { type: 'job.cancel', jobId });
      }
      /* The plan's sign-in sealed to this node, or a word to a node that holds it to seal it for this one. */
      if (id.kind === 'node') await pushCredentials(ctx, id.nodeId, msg.loggedIn);
      await pumpWaiting(ctx);
      return;
    }
    case 'status': {
      if (id.kind !== 'node') return;
      const [node] = await db
        .update(nodes)
        .set({ status: msg.loggedIn ? 'ready' : 'needs_login', lastSeenAt: now, ...(msg.account !== undefined ? { account: msg.account } : {}) })
        .where(and(eq(nodes.id, id.nodeId), liveNode))
        .returning({ plan: nodes.subscriptionId });
      if (!node?.plan) return;
      /* A node that started again knows no limits until its program says them; the last ones stay until then. The plan's
         limits are the same on each of its machines, so the last word counts. */
      if (msg.limits || msg.models) {
        await db
          .update(subscriptions)
          .set({ ...(msg.limits ? { limits: msg.limits } : {}), ...(msg.models ? { models: msg.models } : {}) })
          .where(and(eq(subscriptions.id, node.plan), isNull(subscriptions.removedAt)));
      }
      await settlePlans(db, [node.plan]);
      /* A signed-in subscription may have turns waiting for it. */
      if (msg.loggedIn) await pumpWaiting(ctx);
      return;
    }
    /* A node of a plan sealed the sign-in it holds for the plan's other nodes. */
    case 'cred.sealed': {
      if (id.kind !== 'node') return;
      const [node] = await db.select({ plan: nodes.subscriptionId, companyId: nodes.companyId }).from(nodes).where(and(eq(nodes.id, id.nodeId), liveNode));
      if (!node?.plan) return;
      const kept = await storeEnvelopes(db, { id: node.plan, companyId: node.companyId }, msg.kind, msg.version, msg.envelopes, id.nodeId);
      deliver(ctx, msg.kind, msg.version, kept, id.nodeId);
      return;
    }
    case 'login.done':
      if (id.kind === 'node') await signedIn(ctx, id.nodeId, msg.ok, msg.error);
      return;
    case 'load': {
      const { type: _, ...load } = msg;
      ctx.hub.report(id, load);
      /* A machine that freed up takes a part that waits. */
      await pumpTests(ctx);
      return;
    }
    case 'tests.started':
      await partStarted(ctx, id, msg.partId);
      return;
    case 'tests.done':
      await partDone(ctx, id, msg);
      return;
    case 'job.event': {
      await appendTurnEvent(ctx, msg.jobId, msg.event, jobsOf(id, ctx));
      return;
    }
    case 'job.started':
      await jobStarted(ctx, id, msg.jobId, now);
      return;
    case 'job.program':
      await recordJobProgram(ctx, msg, now, jobsOf(id, ctx));
      return;
    case 'job.done': {
      const finished = await db
        .update(jobs)
        .set({
          status: completionValue(msg.ok ? 'done' : 'failed', 'failed'),
          result: completionValue(msg.result, 'Stopped.'),
          tail: lastBytes(msg.tail),
          error: completionValue(msg.error, 'cancelled'),
          ...exitOf(msg.exit),
          sessionId: msg.sessionId,
          finishedAt: now,
        })
        .where(and(eq(jobs.id, msg.jobId), inArray(jobs.status, OPEN_JOBS), jobsOf(id, ctx)))
        .returning({ companyId: jobs.companyId });
      for (const { companyId } of finished) await publishWorking(ctx, companyId);
      /* The login ran out on this machine: it waits for one before the next turn could go out and fail too. */
      if (finished.length && msg.error === 'not_logged_in' && id.kind === 'node') {
        const [node] = await db.update(nodes).set({ status: 'needs_login' }).where(eq(nodes.id, id.nodeId)).returning({ plan: nodes.subscriptionId });
        await settlePlans(db, [node?.plan ?? null]);
      }
      /* A program that stopped at the plan's usage limit holds the plan's turns, as a plan that says so itself does, and the
         map says until when. */
      if (finished.length && msg.error === 'agent_failed' && id.kind === 'node') {
        const [sub] = await db.select({ id: subscriptions.id, limits: subscriptions.limits }).from(nodes).innerJoin(subscriptions, eq(subscriptions.id, nodes.subscriptionId)).where(eq(nodes.id, id.nodeId));
        const held = sub && refusedLimits(`${msg.result}\n${msg.tail}`, sub.limits ?? null, now.getTime());
        if (held) {
          await db.update(subscriptions).set({ limits: held }).where(eq(subscriptions.id, sub.id));
          for (const { companyId } of finished) ctx.bus.publish(companyId, { type: 'org' });
        }
      }
      if (finished.length) await afterJob(ctx, msg.jobId);
      /* The node keeps the end until it hears this, and sends it again after a reconnect; a second one changes nothing. */
      ctx.hub.send(id, { type: 'job.ack', jobId: msg.jobId });
      return;
    }
    case 'turn.open': {
      const opened = await typedTurn(ctx, id, msg.agentKey, msg.text, ctx.terminals.takeTyped(id, msg.agentKey));
      ctx.hub.send(id, { type: 'turn.opened', agentKey: msg.agentKey, jobId: opened?.jobId ?? null, toolToken: opened?.token ?? null, ...(msg.ref ? { ref: msg.ref } : {}) });
      return;
    }
    case 'agent.start':
      await startProgram(ctx, id, msg.agentKey);
      return;
    case 'agent.said':
      said(ctx, id, msg.ref, msg.ok);
      return;
    case 'agent.hook_rejected':
      await hookRejected(ctx, id, msg, jobsOf(id, ctx));
      return;
    /* Only the node the agent's program is on tells how full its context is. */
    case 'agent.context': {
      if (!z.uuid().safeParse(msg.agentKey).success) return;
      const node = await nodeOfAgent(ctx, msg.agentKey);
      if (!node || !sameNode(node, id)) return;
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
      const [node] = await db.update(nodes).set({ keyHash: null }).where(eq(nodes.id, id.nodeId)).returning({ plan: nodes.subscriptionId });
      await settlePlans(db, [node?.plan ?? null]);
      ctx.hub.close(id.nodeId, 1000);
      return;
    }
  }
}

/* Jobs keep running on the node while it is away and report after it reconnects, so only the time is kept. */
export async function handleNodeClose(ctx: Ctx, id: NodeIdentity): Promise<void> {
  /* A newer connection of the same node keeps the views. */
  if (!ctx.hub.isOnline(id)) ctx.terminals.nodeGone(id);
  if (id.kind !== 'node') return;
  await ctx.db.update(nodes).set({ lastSeenAt: new Date() }).where(eq(nodes.id, id.nodeId));
}
