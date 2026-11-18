import { failOpenJobs, completionValue } from './job-failures.js';
import { jobsOf } from './jobs.js';
import { lastBytes, ToolPrivacy, type Limits, type NodeMessage } from '@hornhoof/protocol';
import { hideCredentials } from '@hornhoof/protocol/redaction';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, jobs, machines, nodes, planCredentials, subscriptions, turnTokens, type NodeStatus } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { tokenRow } from '../subscriptions/tokens.js';
import { said } from '../conversation/live.js';
import { keepLeftInput } from '../conversation/left-input.js';
import { unheard } from '../conversation/unheard.js';
import { clearNodeWords, holdForWords, pump, pumpWaiting, startProgram, wordsSettled } from '../conversation/queue.js';
import { limitUntil, refusedLimits } from '../conversation/limits.js';
import { nodeOfAgent } from '../conversation/placement.js';
import { onAgent } from '../conversation/line.js';
import { workStarts } from '../org/map-state.js';
import { startWork } from '../tasks/progress.js';
import { programRestarted } from '../tasks/program-restarts.js';
import { recordJobProgram } from '../tasks/silent.js';
import { turnsHeld } from '../tasks/orphan-turns.js';
import { turnSign } from '../tasks/turn-signs.js';
import { afterJob, typedTurn } from '../tasks/wake.js';
import { staleOutput } from '../tasks/wake-state.js';
import { appendTurnEvent, cleanTurnEvent, publishWorking, sensitiveTurn } from '../events/store.js';
import { acceptDescription, noteTestCapabilities, resetDescriptionDelivery } from '../testruns/describe.js';
import { harnessGreeted, harnessSynced } from '../testruns/harness.js';
import { partDone, partStarted, pumpTests, testsHello } from '../testruns/runs.js';
import { ownMachine, sameNode, type NodeIdentity, type NodeTransport } from './hub.js';
import { deliver, pushCredentials, signedIn, storeEnvelopes } from '../subscriptions/credentials.js';
import { hasCurrentKey, liveNode, settlePlans } from './nodes.js';
import { builtinInterruption, interruptionOf } from './restarts.js';
import { type Hello } from './restart-evidence.js';
import { hookRejected } from './hook-rejections.js';
import { checkQueueLoad, nodeCheckQueueAway, nodeCheckQueueHello, routeCheckMessage } from './check-slots.js';
import { applyParked, mergePending, park, type ParkedKind } from './parked.js';
import { programsLive } from './program-room.js';
import { privateTurn } from '../tools/private-turns.js';
import { holdNotStarted, noteWorkFolder } from '../program-operator/not-started.js';
import { adoptOperatorOwnerTurn } from '../program-operator/recovery.js';
import { releaseProgramsOfLeftPlans } from '../agents/left-programs.js';
import { tryPlaceWaiting } from '../subscriptions/waiting.js';
import { fallBackFrom, heldUntil } from '../subscriptions/fallback.js';
import { closeCheck, openCheck } from '../tools/outside.js';
import { phoneNodeGone } from '../phones/rpc.js';
const OPEN_JOBS = ['queued', 'running'] as const;
const LOAD_SEEN_MS = 60_000;
const loadSeenAt = new WeakMap<Ctx, Map<string, number>>();

/* Whether this server wrote the node's lastSeenAt less than a minute before; if not, it notes that it writes it now. */
function seenLately(ctx: Ctx, nodeId: string, at: number): boolean {
  const byNode = loadSeenAt.get(ctx) ?? new Map<string, number>();
  loadSeenAt.set(ctx, byNode);
  const since = at - (byNode.get(nodeId) ?? -Infinity);
  if (since >= 0 && since < LOAD_SEEN_MS) return true;
  byNode.set(nodeId, at);
  return false;
}

/* A node that only reports its load is still heard from: its lastSeenAt keeps up, at most once a minute. */
async function touchNodeSeen(ctx: Ctx, id: NodeIdentity, now: Date): Promise<void> {
  if (id.kind !== 'node' || seenLately(ctx, id.nodeId, now.getTime())) return;
  await ctx.db.update(nodes).set({ lastSeenAt: now }).where(and(eq(nodes.id, id.nodeId), liveNode));
}

type FinishedJob = { agentId: string | null; kind: typeof jobs.$inferSelect.kind };

function holdForWaitingWords(ctx: Ctx, id: NodeIdentity, msg: Extract<NodeMessage, { type: 'job.done' }>, finished: FinishedJob[], now: Date): void {
  if (!msg.wordsWaiting) return;
  for (const job of finished) {
    if (job.agentId && job.kind === 'conversation') holdForWords(ctx, job.agentId, msg.jobId, id, now);
  }
}

async function jobEnded(ctx: Ctx, id: NodeIdentity, msg: Extract<NodeMessage, { type: 'job.done' }>, now: Date) {
  const [job] = await ctx.db.select(only(jobs, 'agentId')).from(jobs).where(and(eq(jobs.id, msg.jobId), jobsOf(id, ctx)));
  const finish = async () => {
    if (msg.error === 'cancelled') {
      const stale = await ctx.db.update(jobs).set({ tail: staleOutput(msg.tail) })
        .where(and(eq(jobs.id, msg.jobId), eq(jobs.status, 'failed'), eq(jobs.error, 'stale'), jobsOf(id, ctx))).returning({ companyId: jobs.companyId });
      for (const { companyId } of stale) await publishWorking(ctx, companyId);
      if (stale.length) return [];
    }
    const finished = await ctx.db
      .update(jobs)
      .set({
        status: completionValue(msg.ok ? 'done' : 'failed', 'failed'),
        result: completionValue(msg.result, 'Stopped.'),
        tail: lastBytes(msg.tail),
        error: completionValue(msg.failure?.kind === 'auth' ? 'not_logged_in' : msg.error, 'cancelled'),
        failure: completionValue(sql`${JSON.stringify(msg.failure ?? null)}::jsonb`, null),
        ...exitOf(msg.exit),
        sessionId: msg.sessionId,
        finishedAt: now,
      })
      .where(and(eq(jobs.id, msg.jobId), inArray(jobs.status, OPEN_JOBS), jobsOf(id, ctx)))
      .returning({ companyId: jobs.companyId, agentId: jobs.agentId, kind: jobs.kind, subscriptionId: jobs.subscriptionId });
    holdForWaitingWords(ctx, id, msg, finished, now);
    await keepTokens(ctx, msg, finished, now);
    return finished;
  };
  return job?.agentId ? onAgent(ctx, job.agentId, finish) : finish();
}

/* What the turn used, as its program told its node: once, when the turn ends, and no data when it told none. */
async function keepTokens(ctx: Ctx, msg: Extract<NodeMessage, { type: 'job.done' }>, finished: { companyId: string; agentId: string | null; subscriptionId: string }[], now: Date): Promise<void> {
  const [job] = finished;
  if (!job) return;
  await ctx.db.insert(turnTokens).values({ jobId: msg.jobId, companyId: job.companyId, agentId: job.agentId, subscriptionId: job.subscriptionId, ...tokenRow(msg.tokens), at: now }).onConflictDoNothing();
}

/* An event of a running turn's work, kept in its conversation; a sign that the turn goes on, whatever its program reports. */
async function turnEvent(ctx: Ctx, id: NodeIdentity, msg: Extract<NodeMessage, { type: 'job.event' }>, now: Date): Promise<void> {
  if (await appendTurnEvent(ctx, msg.jobId, msg.event, jobsOf(id, ctx))) turnSign(ctx, msg.jobId, now.getTime());
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

/* What a node says of its plan's program: signed out, signed in but waiting for a first setup only the plan's owner may
   pass, or ready. */
const statusOf = (msg: { loggedIn: boolean; setupNeeded?: boolean }): NodeStatus => (!msg.loggedIn ? 'needs_login' : msg.setupNeeded ? 'needs_setup' : 'ready');

/* What a failed turn says its node waits for before the next turn could fail the same way: a sign-in, or the first setup. */
const waitOf = (msg: Extract<NodeMessage, { type: 'job.done' }>): NodeStatus | null =>
  msg.error === 'not_logged_in' || msg.failure?.kind === 'auth' ? 'needs_login' : msg.failure?.kind === 'setup' ? 'needs_setup' : null;

/* What a node's hello changes in its row: what it runs, whether it is signed in, and what it says of itself when it says it. */
const helloRow = (msg: Hello, now: Date) => ({
  version: msg.version,
  lastSeenAt: now,
  status: statusOf(msg),
  ...(msg.publicKey ? { publicKey: msg.publicKey } : {}),
  ...(msg.account !== undefined ? { account: msg.account } : {}),
  ...(msg.boot ? { boot: msg.boot } : {}),
});

/* Why the built-in node's turns are gone. A personal node's comes from its row, once the hello is known to be its own. */
const builtinCut = (ctx: Ctx, id: NodeIdentity, msg: Hello, now: Date) =>
  id.kind === 'builtin' ? builtinInterruption(ctx, id.machine, msg, now) : undefined;

const nodeCut = (ctx: Ctx, nodeId: string, row: { node: typeof nodes.$inferSelect; host: string | null }, msg: Hello, now: Date) =>
  interruptionOf(ctx, { id: nodeId, name: row.host || 'a machine with no name', machine: { id: row.node.machineId, name: row.host }, said: { version: row.node.version, boot: row.node.boot } }, msg, now);

/* The last reading of each plan's limits. */
const lastReadings = new WeakMap<Ctx, Map<string, string>>();

/* What a reading changes of a plan. A plan may refuse a turn while its numbers say it has room. A reading that moved nothing
   since then says nothing of that refusal, so the hold it left stays until its time, as fresh as the reading. */
async function afterReading(ctx: Ctx, planId: string, reading: Limits, now: Date): Promise<{ limits?: Limits; limitsUpdatedAt: Date }> {
  const seen = lastReadings.get(ctx) ?? new Map<string, string>();
  lastReadings.set(ctx, seen);
  const said = JSON.stringify(reading);
  const unmoved = seen.get(planId) === said;
  seen.set(planId, said);
  if (unmoved) {
    const [plan] = await ctx.db.select({ limits: subscriptions.limits, at: subscriptions.limitsUpdatedAt }).from(subscriptions).where(eq(subscriptions.id, planId));
    if (limitUntil(plan?.limits ?? null, plan?.at ?? null, now.getTime())) return { limitsUpdatedAt: now };
  }
  return { limits: reading, limitsUpdatedAt: now };
}

async function savePlanMetadata(ctx: Ctx, planId: string, msg: Extract<NodeMessage, { type: 'status' }>, now: Date): Promise<void> {
  if (!msg.limits && !msg.models) return;
  const held = msg.limits ? await planHeldNow(ctx, planId) : true;
  await ctx.db
    .update(subscriptions)
    .set({ ...(msg.limits ? await afterReading(ctx, planId, msg.limits, now) : {}), ...(msg.models ? { models: msg.models } : {}) })
    .where(and(eq(subscriptions.id, planId), isNull(subscriptions.removedAt)));
  if (!held) await fallBackIfHeld(ctx, planId);
}

/* Whether the plan holds a worker's turns back now: at its limit, or past the share set for tasks. */
async function planHeldNow(ctx: Ctx, planId: string): Promise<boolean> {
  const [plan] = await ctx.db.select({ limits: subscriptions.limits, limitsUpdatedAt: subscriptions.limitsUpdatedAt, budget: subscriptions.budget }).from(subscriptions).where(eq(subscriptions.id, planId));
  return Boolean(plan && heldUntil(plan, 'worker'));
}

/* A plan that has just come to its limit or its share for tasks sends everyone on it to a fallback at once. */
async function fallBackIfHeld(ctx: Ctx, planId: string | null): Promise<void> {
  if (planId && (await planHeldNow(ctx, planId))) await fallBackFrom(ctx, planId);
}

const planState = async (ctx: Ctx, id: string) =>
  (await ctx.db.select({ status: subscriptions.status, companyId: subscriptions.companyId }).from(subscriptions).where(and(eq(subscriptions.id, id), isNull(subscriptions.removedAt))))[0];

/* A plan's state from its nodes. One that begins to work takes whoever waits for a plan, as a new plan does. */
async function settleAndPlace(ctx: Ctx, plan: string | null): Promise<void> {
  if (!plan) return;
  const before = await planState(ctx, plan);
  await settlePlans(ctx.db, [plan]);
  const after = await planState(ctx, plan);
  if (after?.status === 'ready' && before?.status !== 'ready') await tryPlaceWaiting(ctx, after.companyId, [plan]);
}

async function updatePlanStatus(ctx: Ctx, nodeId: string, msg: Extract<NodeMessage, { type: 'status' }>, now: Date): Promise<boolean> {
  const status = statusOf(msg);
  const [node] = await ctx.db
    .update(nodes)
    .set({ status, lastSeenAt: now, ...(msg.account !== undefined ? { account: msg.account } : {}) })
    .where(and(eq(nodes.id, nodeId), liveNode))
    .returning({ plan: nodes.subscriptionId });
  if (!node?.plan) return false;
  await savePlanMetadata(ctx, node.plan, msg, now);
  await settleAndPlace(ctx, node.plan);
  return status === 'ready';
}

async function handleNodeStatus(ctx: Ctx, id: NodeIdentity, msg: Extract<NodeMessage, { type: 'status' }>, now: Date): Promise<void> {
  const unblocked = ctx.hub.noteStatus(id, msg.noRuns, msg.browserError);
  if (id.kind === 'node') await noteWorkFolder(ctx, id.nodeId, msg.workError);
  const ready = id.kind === 'node' ? await updatePlanStatus(ctx, id.nodeId, msg, now) : false;
  if (ready) await pumpWaiting(ctx);
  if (testStatusReady(unblocked, msg)) await pumpTests(ctx);
}

async function wordMessage(ctx: Ctx, id: NodeIdentity, msg: NodeMessage, now: Date): Promise<void> {
  if (msg.type === 'agent.said') said(ctx, id, msg.ref, msg.ok);
  if (msg.type === 'agent.unheard') await unheard(ctx, id, msg, now);
  if (msg.type === 'agent.words_settled') await wordsSettled(ctx, id, msg.agentKey, msg.jobId);
  if (msg.type === 'agent.input_left') await keepLeftInput(ctx, id, msg);
}

/* What a node says of one job that may be kept until the job's row is there, and as which kind it is kept. A word that
   the agent did not hear names a job too, but needs only the agent and its node, so it is never kept. */
const PARKED_AS: Partial<Record<NodeMessage['type'], ParkedKind>> = { 'job.started': 'started', 'job.event': 'event', 'job.done': 'done', 'agent.restarted': 'event' };

/* While the database of a machine the server was taken from waits to be merged, what a node says of a job this
   Hornhoof has no row of is kept, and the node is answered as if it was handled: the job runs on, and its row comes
   with the merge. True when the message was kept. */
async function parkUnknown(ctx: Ctx, id: NodeIdentity, msg: NodeMessage): Promise<boolean> {
  const kind = PARKED_AS[msg.type];
  const jobId = msg.type === 'job.started' || msg.type === 'job.event' || msg.type === 'job.done' || msg.type === 'agent.restarted' ? msg.jobId : null;
  if (!kind || !jobId || !z.uuid().safeParse(jobId).success || !(await mergePending(ctx.db))) return false;
  const [known] = await ctx.db.select(idOnly(jobs)).from(jobs).where(eq(jobs.id, jobId));
  if (known) return false;
  /* The node masks the values it knows before sending. We can still mask recognizable credentials while awaiting the row. */
  const body = msg.type === 'job.done' ? maskCompletion(msg, hideCredentials) : msg;
  await park(ctx.db, { jobId, node: id, kind, body });
  if (msg.type === 'job.done') ctx.hub.send(id, { type: 'job.ack', jobId });
  return true;
}

/* What was kept of jobs whose rows are there now is applied as if the node said it now. */
export const applyParkedMessages = (ctx: Ctx): Promise<number> => applyParked(ctx, (scoped, id, msg) => handleNodeMessage(scoped, id, msg));

/* A turn waits in the queue with no node until it is sent out. One the machine that led sent out after its last
   change reached this copy still waits here, and the node that says it runs it is where it went: it is that node's
   from now. Only a turn of the node's own plan, or of an API key for a machine's built-in node, is taken so; a turn
   that names another node stays that one's. */
async function placeWaiting(ctx: Ctx, id: NodeIdentity, ids: string[]): Promise<void> {
  const { db } = ctx;
  const waits = and(inArray(jobs.id, ids), eq(jobs.status, 'queued'), isNull(jobs.nodeId), isNull(jobs.builtinMachine));
  if (id.kind === 'node') {
    const ofPlan = eq(jobs.subscriptionId, sql`(select ${nodes.subscriptionId} from ${nodes} where ${nodes.id} = ${id.nodeId})`);
    await db.update(jobs).set({ nodeId: id.nodeId }).where(and(waits, ofPlan));
    return;
  }
  /* The server's own built-in node runs the turns that name no machine: those need no place. */
  if (id.machine === ownMachine(ctx.config)) return;
  const ofKeys = inArray(jobs.subscriptionId, db.select(idOnly(subscriptions)).from(subscriptions).where(eq(subscriptions.kind, 'api_key')));
  await db.update(jobs).set({ builtinMachine: id.machine }).where(and(waits, ofKeys));
}

/* The jobs a node says it runs, once its own open jobs were settled. Hornhoof ended some while the node was away, with
   a stop or a removed subscription: the node stops those now. While a merge is pending, a job this Hornhoof has no row
   of is left running and that the node lists it is kept; and one that waits here in the queue runs on that node from
   now, so it is never sent out again. */
async function settleListed(ctx: Ctx, id: NodeIdentity, running: string[], now: Date): Promise<void> {
  if (!running.length) return;
  const { db } = ctx;
  const pending = await mergePending(db);
  const ids = pending ? running.filter(jobId => z.uuid().safeParse(jobId).success) : [];
  if (ids.length) await placeWaiting(ctx, id, ids);
  const open = await db.select({ id: jobs.id, status: jobs.status }).from(jobs).where(and(inArray(jobs.id, running), inArray(jobs.status, OPEN_JOBS), jobsOf(id, ctx)));
  const keep = new Set(open.map(j => j.id));
  const known = new Set(ids.length ? (await db.select(idOnly(jobs)).from(jobs).where(inArray(jobs.id, ids))).map(j => j.id) : []);
  for (const jobId of running) {
    if (keep.has(jobId)) continue;
    if (pending && ids.includes(jobId) && !known.has(jobId)) await park(db, { jobId, node: id, kind: 'listed', body: {} });
    else ctx.hub.send(id, { type: 'job.cancel', jobId });
  }
  if (pending) for (const job of open) if (job.status === 'queued') await jobStarted(ctx, id, job.id, now);
}

function maskCompletion(msg: Extract<NodeMessage, { type: 'job.done' }>, mask: (text: string) => string): NodeMessage {
  return { ...msg, result: mask(msg.result), tail: mask(msg.tail), ...(msg.failure ? { failure: { ...msg.failure, text: mask(msg.failure.text) } } : {}) };
}

async function privateIncoming(ctx: Pick<Ctx, 'db'>, msg: NodeMessage): Promise<NodeMessage> {
  if (msg.type !== 'job.event' && msg.type !== 'job.done') return msg;
  const values = privateTurn(ctx.db, msg.jobId)?.values;
  if (msg.type === 'job.event') {
    /* Only MCP marks an issued value. A node can ask for masking, never invent issuance. */
    const incoming = msg.event.kind === 'tool' ? { kind: 'tool' as const, name: msg.event.name, input: msg.event.input, ...(msg.event.sensitive ? { sensitive: true as const } : {}) } : msg.event;
    const event = new ToolPrivacy().event(incoming);
    return { ...msg, event: cleanTurnEvent(values?.hide(event) ?? event) };
  }
  if (values) return maskCompletion(msg, text => values.text(text));
  if (await sensitiveTurn(ctx.db, msg.jobId)) return maskCompletion(msg, hideCredentials);
  return msg;
}

export async function handleNodeMessage(ctx: Ctx, id: NodeIdentity, msg: NodeMessage, now = new Date(), transport?: NodeTransport): Promise<void> {
  if (!(await hasCurrentKey(ctx, id))) return;
  msg = await privateIncoming(ctx, msg);
  if (await parkUnknown(ctx, id, msg)) return;
  await routeCheckMessage(ctx, id, msg, jobsOf(id, ctx), transport);
  await wordMessage(ctx, id, msg, now);
  if (await testNodeMessage(ctx, id, msg)) return;
  const { db } = ctx;
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- Terminal and live word messages have their own handlers.
  switch (msg.type) {

    case 'hello': {
      clearNodeWords(ctx, id);
      resetDescriptionDelivery(ctx);
      let cut = await builtinCut(ctx, id, msg, now);
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
        await noteWorkFolder(ctx, id.nodeId, msg.workError);
        const plan = row.node.subscriptionId;
        if (plan && msg.models) await db.update(subscriptions).set({ models: msg.models }).where(eq(subscriptions.id, plan));
        await settleAndPlace(ctx, plan);
      }
      if (transport && !ctx.hub.isCurrentLink(id, transport.linkId)) return;
      nodeCheckQueueHello(ctx, id, msg);
      await failOpenJobs(ctx, jobsOf(id, ctx), 'machine_restarted', msg.running, cut);
      if (transport && !ctx.hub.isCurrentLink(id, transport.linkId)) return;
      ctx.hub.greet(id, msg.terminals === true, msg.work === true, msg.noRuns || null, msg.build, msg.browserError || null);
      if (msg.load) { ctx.hub.report(id, msg.load); await checkQueueLoad(ctx, id, transport); }
      /* Every waiting turn is sent below, with what the node says of the programs that run on it. */
      programsLive(ctx, id, msg.live);
      await testsHello(ctx, id, msg.tests);
      await releaseProgramsOfLeftPlans(ctx, id, jobsOf(id, ctx));
      await settleListed(ctx, id, msg.running, now);
      /* The plan's sign-in sealed to this node, or a word to a node that holds it to seal it for this one. */
      if (id.kind === 'node') await pushCredentials(ctx, id.nodeId, msg.loggedIn);
      await pumpWaiting(ctx);
      return;
    }
    case 'status':
      await handleNodeStatus(ctx, id, msg, now);
      return;
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
      if (id.kind === 'node') await signedIn(ctx, id.nodeId, msg.ok, msg.error, { code: msg.code ?? null, line: msg.line ?? null });
      return;
    case 'load': {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- strip the message type tag from the node load
      const { type: _, live, ...load } = msg;
      ctx.hub.report(id, load);
      await touchNodeSeen(ctx, id, now);
      await checkQueueLoad(ctx, id, transport);
      /* A machine that freed up takes a part that waits, and one whose kernel killed nothing more for want of memory starts
         the programs that waited. */
      await pumpTests(ctx);
      for (const agentId of programsLive(ctx, id, live)) await pump(ctx, agentId);
      return;
    }

    case 'job.event': {
      await turnEvent(ctx, id, msg, now);
      return;
    }
    case 'job.started':
      await jobStarted(ctx, id, msg.jobId, now);
      return;
    case 'jobs.held':
      await turnsHeld(ctx, id, msg, now);
      return;
    case 'job.program':
      await recordJobProgram(ctx, msg, now, jobsOf(id, ctx));
      return;
    case 'job.done': {
      const finished = await jobEnded(ctx, id, msg, now);
      for (const { companyId } of finished) await publishWorking(ctx, companyId);
      /* The login ran out on this machine, or its program asks for its first setup: the machine waits for that before the
         next turn could go out and fail too. */
      const waits = waitOf(msg);
      if (finished.length && waits && id.kind === 'node') {
        const [node] = await db.update(nodes).set({ status: waits }).where(eq(nodes.id, id.nodeId)).returning({ plan: nodes.subscriptionId });
        await settlePlans(db, [node?.plan ?? null]);
      }
      /* A program that stopped at the plan's usage limit holds the plan's turns, as a plan that says so itself does, and the
         map says until when. */
      let refused: string | null = null;
      if (finished.length && (msg.failure?.kind === 'usage_limit' || (!msg.failure && msg.error === 'agent_failed' && id.kind === 'node'))) {
        const [sub] = await db.select({ id: subscriptions.id, limits: subscriptions.limits }).from(jobs).innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId)).where(eq(jobs.id, msg.jobId));
        const held = sub && refusedLimits(`${msg.result}\n${msg.tail}`, sub.limits ?? null, now.getTime(), msg.failure?.kind === 'usage_limit');
        if (held) {
          await db.update(subscriptions).set({ limits: held, limitsUpdatedAt: now }).where(eq(subscriptions.id, sub.id));
          for (const { companyId } of finished) ctx.bus.publish(companyId, { type: 'org' });
          refused = sub.id;
        }
      }
      /* A turn that ended before its program started holds the turns that would end the same way, until Operations looks. */
      if (finished.length && msg.unstarted && id.kind === 'node') await holdNotStarted(ctx, id.nodeId, msg.jobId, msg.tail, now);
      if (finished.length) await afterJob(ctx, msg.jobId);
      /* Everyone on the plan goes on to a fallback, not only the one whose turn it refused. */
      await fallBackIfHeld(ctx, refused);
      /* The node keeps the end until it hears this, and sends it again after a reconnect; a second one changes nothing. */
      ctx.hub.send(id, { type: 'job.ack', jobId: msg.jobId });
      return;
    }
    case 'turn.open': {
      const opened = await typedTurn(ctx, id, msg.agentKey, msg.text, ctx.terminals.takeTyped(id, msg.agentKey), msg.queuedFrom);
      if (opened && id.kind === 'node') await adoptOperatorOwnerTurn(ctx, msg.agentKey, opened.jobId, id.nodeId);
      ctx.hub.send(id, { type: 'turn.opened', agentKey: msg.agentKey, jobId: opened?.jobId ?? null, toolToken: opened?.token ?? null, ...(msg.ref ? { ref: msg.ref } : {}) });
      return;
    }
    case 'agent.start':
      await startProgram(ctx, id, msg.agentKey);
      return;
    case 'tools.call':
      await ctx.toolsOutside?.(id, msg);
      return;
    case 'tools.check':
      await openCheck(ctx, id, msg);
      return;
    case 'tools.checked':
      await closeCheck(ctx, id, msg);
      return;
    case 'agent.restarted':
      await programRestarted(ctx, id, msg);
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
      const [node] = await db.update(nodes).set({ keyHash: null, status: 'needs_login' }).where(eq(nodes.id, id.nodeId)).returning({ plan: nodes.subscriptionId });
      await settlePlans(db, [node?.plan ?? null]);
      ctx.hub.close(id.nodeId, 1000);
      return;
    }
  }
}

/* Jobs keep running on the node while it is away and report after it reconnects, so only the time is kept. */
export async function handleNodeClose(ctx: Ctx, id: NodeIdentity): Promise<void> {
  /* A newer connection of the same node keeps the views. */
  if (!ctx.hub.isOnline(id)) { ctx.terminals.nodeGone(id); nodeCheckQueueAway(ctx, id); }
  phoneNodeGone(ctx, id);
  if (id.kind !== 'node') return;
  await ctx.db.update(nodes).set({ lastSeenAt: new Date() }).where(eq(nodes.id, id.nodeId));
}

const testStatusReady = (unblocked: boolean, msg: Extract<NodeMessage, { type: 'status' }>): boolean => unblocked || msg.testEnvironmentVersion === 1;
async function testNodeMessage(ctx: Ctx, id: NodeIdentity, msg: NodeMessage): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- Other node frames remain with their owning handler.
  switch (msg.type) {
    case 'hello': noteTestCapabilities(ctx, id, msg); harnessGreeted(ctx, id); return false;
    case 'status': noteTestCapabilities(ctx, id, msg); return false;
    case 'tests.harness.done': await harnessSynced(ctx, id, msg); return true;
    case 'tests.described': await acceptDescription(ctx, id, msg); await pumpTests(ctx); return true;
    case 'tests.started': await partStarted(ctx, id, msg.partId); return true;
    case 'tests.done': await partDone(ctx, id, msg); return true;
    default: return false;
  }
}
export { jobsOf } from './jobs.js';
export { failOpenJobs } from './job-failures.js';
