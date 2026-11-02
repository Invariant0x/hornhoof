import { effortFor, effortsOf, MAX_INSTRUCTIONS, modelsFor, OLD_NODE_INSTRUCTIONS, type Limits } from '@hornhoof/protocol';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { loggable } from '../../errors.js';
import { hashToken, newToken } from '../../crypto/tokens.js';
import { agents, jobs, nodes, people, subscriptions, tasks, turns } from '../../db/schema.js';
import { dispatchJob } from '../jobs/dispatch.js';
import { turnsHeld } from '../updates/drain.js';
import { sayLive } from './live.js';
import { BUILTIN, identityOf, nodeIdentity, sameNode, type NodeIdentity } from '../nodes/hub.js';
import { liveNode, planNodes, type NodeRow } from '../nodes/nodes.js';
import { appendEvent, earlierTalk, publishWorking, type WithEvent } from '../events/store.js';
import { instructionsOf } from '../agents/instructions.js';
import { repoFor, repoLine } from '../departments/repository.js';
import { textHash } from '../templates/load.js';
import { openAfter, startWork } from '../tasks/engine.js';
import { workStarts } from '../org/map-state.js';
import { preface } from './prompt.js';
import { ABOUT_AS_FREE, freedom } from '../testruns/pick.js';

/* Workers compact their conversation at half a million tokens, which keeps their turns quick; heads and the orchestrator
   keep the whole window, since they hold the department's and the company's picture. */
export const WORKER_COMPACT_WINDOW = 500_000;

/* Any turn may run as long as its work takes. This only ends one that hangs, a program frozen or waiting for input
   nobody gives, so the agent's next turns are not stuck behind it; the agent goes on in the same session. */
export const TURN_TIMEOUT_MS = 2 * 3_600_000;

export type AgentState = {
  ready: boolean;
  /* Its plan is at its limit until then: its turns wait in line, and people may still write to it. */
  limitUntil: string | null;
  /* Its plan used the share set for tasks until then: task turns wait, people's own messages still go. */
  budgetUntil: string | null;
  reason: 'no_subscription' | 'waiting_machine' | 'needs_login' | 'node_outdated' | 'machine_offline' | null;
  busy: boolean;
  runningJobId: string | null;
  queued: number;
  /* Its node shows the agent's live terminal. */
  terminal: boolean;
};

/* How long after a plan's limit starts over its waiting turns go out, so the program sees the new limit. */
const LIMIT_GRACE_MS = 5_000;
const LONGEST_TIMER_MS = 2 ** 31 - 1;

/* When the plan's limit starts over, while the plan is at it: the latest reset of a full window still to come. A plan at
   its limit that says no reset holds nothing, so its turns go out and fail as before rather than wait forever. */
export function limitUntil(limits: Limits | null, now = Date.now()): string | null {
  if (limits?.status !== 'rejected') return null;
  const resets = limits.windows.filter(w => (w.utilization === null || w.utilization >= 1) && w.resetsAt && Date.parse(w.resetsAt) > now).map(w => w.resetsAt!);
  return resets.length ? resets.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;
}

/* When a window of the plan that used the share set for task turns starts over: the latest such reset still to come. */
export function budgetUntil(limits: Limits | null, budget: number | null, now = Date.now()): string | null {
  if (budget === null || budget >= 100) return null;
  const resets = (limits?.windows ?? []).filter(w => w.utilization !== null && w.utilization * 100 >= budget && w.resetsAt && Date.parse(w.resetsAt) > now).map(w => w.resetsAt!);
  return resets.length ? resets.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;
}

/* What a program prints at the end of its output when the plan refuses a turn for its usage limit: Kimi's 429 and its
   APIProviderQuotaExhaustedError, Codex's "hit your usage limit", Claude's "5-hour limit reached". */
const REFUSED = /\b429\b[^\n]*\b(?:(?:usage|rate) limit|quota)|\bAPIProviderQuotaExhaustedError\b|(?:reached|hit) your (?:[\w-]+ )?usage limit|usage limit reached|\b\d+-hour limit reached/i;
/* A program that names no time is tried again after this, and held again if the plan still refuses. */
const LIMIT_PROBE_MS = 15 * 60_000;
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };

function againIn(text: string, now: number): string | null {
  const said = /try again in ([^.\n]*)/i.exec(text);
  let ms = 0;
  for (const [, n, unit] of said?.[1]?.matchAll(/(\d+)\s*([dhms])[a-z]*/gi) ?? []) ms += Number(n) * UNIT_MS[unit!.toLowerCase()]!;
  return ms ? new Date(now + ms).toISOString() : null;
}

/* The plan's limits once a turn ended on a refusal for its usage limit, or null when it did not: the window it names is
   full until the time the program gives, the reset the plan said before, or a quarter of an hour. */
export function refusedLimits(output: string, limits: Limits | null, now = Date.now()): Limits | null {
  const end = output.slice(-1500);
  if (!REFUSED.test(end)) return null;
  const name = /\b(?:weekly|7-day|seven-day)\b/i.test(end) ? 'seven_day' : 'five_hour';
  const known = limits?.windows.find(w => w.name === name)?.resetsAt;
  const resetsAt = againIn(end, now) ?? (known && Date.parse(known) > now ? known : new Date(now + LIMIT_PROBE_MS).toISOString());
  return { ...limits, status: 'rejected', windows: [...(limits?.windows ?? []).filter(w => w.name !== name), { name, utilization: 1, resetsAt }] };
}

/* Wakes the agent's line once its plan's limit starts over. */
const resets = new WeakMap<Ctx, Map<string, { at: string; timer: NodeJS.Timeout }>>();
function pumpAt(ctx: Ctx, agentId: string, at: string): void {
  const timers = resets.get(ctx) ?? new Map<string, { at: string; timer: NodeJS.Timeout }>();
  resets.set(ctx, timers);
  if (timers.get(agentId)?.at === at) return;
  clearTimeout(timers.get(agentId)?.timer);
  /* A timer holds at most about 24 days: a longer wait wakes once then and sets itself again. */
  const wait = Date.parse(at) - Date.now() + LIMIT_GRACE_MS;
  const timer = setTimeout(() => {
    timers.delete(agentId);
    if (wait > LONGEST_TIMER_MS) return pumpAt(ctx, agentId, at);
    void pump(ctx, agentId).catch(() => {});
  }, Math.min(wait, LONGEST_TIMER_MS));
  timer.unref();
  timers.set(agentId, { at, timer });
}

/* What a turn ends with when a person or Hornhoof stopped it on purpose; none of these is a failure. */
export const STOPPED_ON_PURPOSE = ['cancelled', 'removed', 'switched_off'];

/* answersCeo: a note of something the CEO did, which counts as the CEO's order without a message. */
/* withMessage: what is kept together with the message, or not at all. */
type Turn = { companyId: string; agentId: string; prompt: string; createdBy: string | null; message?: { personId: string | null; text: string; from?: 'orchestrator' | 'agent'; name?: string; by?: string }; taskId?: string; answersCeo?: boolean; withMessage?: WithEvent };

/* One thing at a time per agent, so two pumps never send two turns. */
const chains = new WeakMap<Ctx, Map<string, Promise<unknown>>>();

export function onAgent<T>(ctx: Ctx, agentId: string, fn: () => Promise<T>): Promise<T> {
  const mine = chains.get(ctx) ?? new Map<string, Promise<unknown>>();
  chains.set(ctx, mine);
  const run = (mine.get(agentId) ?? Promise.resolve()).then(fn);
  const settled = run.catch(() => undefined);
  mine.set(agentId, settled);
  void settled.then(() => {
    if (mine.get(agentId) === settled) mine.delete(agentId);
  });
  return run;
}

export const conversationOf = (agentId: string) => and(eq(jobs.agentId, agentId), eq(jobs.kind, 'conversation'));
/* Only a node's empty start opens the program while the plan's real turns wait. */
const programStart = and(eq(jobs.prompt, ''), isNull(jobs.taskId), isNull(jobs.createdBy));

export async function liveSubscription(ctx: Ctx, agentId: string) {
  const [row] = await ctx.db.select({ sub: subscriptions }).from(agents).innerJoin(subscriptions, eq(subscriptions.id, agents.subscriptionId)).where(eq(agents.id, agentId));
  return row && !row.sub.removedAt ? row.sub : null;
}

/* A node and the owner of the subscription it runs: the person who may type into the agent's terminal there. */
export type ProgramNode = { node: NodeIdentity; ownerPersonId: string };

/* The node that holds the agent's program now: the one its running turn went out to, since that turn goes on there when
   the agent moves, or else its own while that is a live node of its plan. A company key's agents are on the built-in
   node. */
export async function programNode(ctx: Ctx, agentId: string): Promise<ProgramNode | null> {
  const [running] = await ctx.db
    .select({ kind: subscriptions.kind, ownerPersonId: subscriptions.ownerPersonId, nodeId: jobs.nodeId })
    .from(jobs)
    .innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
    .where(and(conversationOf(agentId), eq(jobs.status, 'running')))
    .limit(1);
  const [own] = running
    ? [running]
    : await ctx.db
        .select({ kind: subscriptions.kind, ownerPersonId: subscriptions.ownerPersonId, nodeId: nodes.id })
        .from(agents)
        .innerJoin(subscriptions, and(eq(subscriptions.id, agents.subscriptionId), isNull(subscriptions.removedAt)))
        .leftJoin(nodes, and(eq(nodes.id, agents.nodeId), eq(nodes.subscriptionId, agents.subscriptionId), liveNode))
        .where(eq(agents.id, agentId));
  const node = own && identityOf(own, own.nodeId);
  return node ? { node, ownerPersonId: own.ownerPersonId } : null;
}

export const nodeOfAgent = async (ctx: Ctx, agentId: string) => (await programNode(ctx, agentId))?.node ?? null;

/* The node someone who opens the agent's window watches. One that runs no turn starts its program where its next turn
   would go, and keeps that node; while no machine of its plan can take it, the window waits for the first to come back. */
export async function windowNode(ctx: Ctx, agentId: string): Promise<ProgramNode | null> {
  const placed = await onAgent(ctx, agentId, async () => {
    const [running] = await ctx.db.select({ id: jobs.id }).from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'running'))).limit(1);
    const sub = running ? null : await liveSubscription(ctx, agentId);
    if (sub?.kind !== 'personal') return null;
    const [agent] = await ctx.db.select({ id: agents.id, nodeId: agents.nodeId }).from(agents).where(eq(agents.id, agentId));
    const place = agent ? await placement(ctx, agent, sub) : null;
    if (place?.moves) await ctx.db.update(agents).set({ nodeId: place.nodeId }).where(eq(agents.id, agentId));
    if (place) return { node: place.node, ownerPersonId: sub.ownerPersonId };
    const [first] = await planNodes(ctx.db, [sub.id]);
    return (await programNode(ctx, agentId)) ?? (first ? { node: nodeIdentity(first.id), ownerPersonId: sub.ownerPersonId } : null);
  });
  return placed ?? programNode(ctx, agentId);
}

/* Thrown before anything is stored, so the caller may undo what it did for the turn. */
export class NoSubscription extends Error {
  constructor() {
    super('The agent has no subscription.');
  }
}

/* Whether the person is the company's owner, the CEO, whose words alone open the tools for people, access, money and
   the company's reach. */
async function isCeo(ctx: Ctx, personId: string | null | undefined): Promise<boolean> {
  if (!personId) return false;
  const [owner] = await ctx.db.select({ id: people.id }).from(people).where(and(eq(people.id, personId), eq(people.isOwner, true)));
  return Boolean(owner);
}

/* Stores the turn and, when it carries a person's message, the message under the same job. */
export async function insertTurn(ctx: Ctx, t: Turn): Promise<string> {
  const sub = await liveSubscription(ctx, t.agentId);
  if (!sub) throw new NoSubscription();
  const [job] = await ctx.db
    .insert(jobs)
    .values({
      companyId: t.companyId,
      subscriptionId: sub.id,
      agentId: t.agentId,
      kind: 'conversation',
      prompt: t.prompt,
      timeoutMs: TURN_TIMEOUT_MS,
      createdBy: t.createdBy,
      taskId: t.taskId ?? null,
      answersCeo: t.answersCeo === true || (await isCeo(ctx, t.message?.personId)),
    })
    .returning({ id: jobs.id });
  await showMessage(ctx, t, job!.id);
  return job!.id;
}

/* An employee's message carries its name for the window and its id in by. */
async function showMessage(ctx: Ctx, t: Turn, jobId: string): Promise<void> {
  if (!t.message) return;
  const { personId, ...data } = t.message;
  await appendEvent(ctx, { companyId: t.companyId, agentId: t.agentId, jobId, kind: 'message', data, personId }, t.withMessage);
}

/* Stores the turn, then sends it if he is free. A message for an agent at work goes into the turn it runs instead, and a
   turn that took the CEO's message answers the CEO from then on. */
export async function enqueueTurn(ctx: Ctx, t: Turn): Promise<string> {
  const into = t.message && !t.taskId ? await sayLive(ctx, t.agentId, t.prompt) : null;
  if (into) {
    if (await isCeo(ctx, t.message?.personId)) await ctx.db.update(jobs).set({ answersCeo: true }).where(eq(jobs.id, into));
    await showMessage(ctx, t, into);
    return into;
  }
  const jobId = await insertTurn(ctx, t);
  await pump(ctx, t.agentId);
  return jobId;
}

/* A person typed into the agent's terminal while no turn ran, or while the program started. The turn is theirs and runs
   from now on the node that shows the session, which goes on with the instructions it was started with: their hash stays,
   so the next turn resumes it. Nobody typed it when no person pressed Enter in Hornhoof's terminal just now: then the
   agent's own program asks, which gets no turn and no tool token, so an agent never opens work for itself. */
export async function openTypedTurn(ctx: Ctx, node: NodeIdentity, agentId: string, text: string, personId: string | null): Promise<{ jobId: string; token: string } | null> {
  if (!personId || !z.uuid().safeParse(agentId).success) return null;
  const opened = await onAgent(ctx, agentId, async () => {
    const { db } = ctx;
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, agentId), isNull(agents.removedAt)));
    const sub = agent ? await liveSubscription(ctx, agent.id) : null;
    const at = sub ? await nodeOfAgent(ctx, agentId) : null;
    if (!agent || !sub || !at || !sameNode(at, node)) return null;
    /* A turn that only started the program is over once the person types: their turn takes its place. */
    await db
      .update(jobs)
      .set({ status: 'done', result: '', finishedAt: new Date() })
      .where(and(conversationOf(agentId), eq(jobs.status, 'running'), eq(jobs.prompt, ''), isNull(jobs.taskId)));
    const [running] = await db.select({ id: jobs.id }).from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'running'))).limit(1);
    if (running) return null;
    const [last] = await db
      .select({ hash: jobs.instructionsHash })
      .from(jobs)
      .where(and(conversationOf(agentId), eq(jobs.subscriptionId, sub.id), isNotNull(jobs.instructionsHash)))
      .orderBy(desc(jobs.startedAt))
      .limit(1);
    const token = newToken();
    const [job] = await db
      .insert(jobs)
      .values({
        companyId: agent.companyId,
        subscriptionId: sub.id,
        nodeId: node.kind === 'node' ? node.nodeId : null,
        agentId,
        kind: 'conversation',
        status: 'running',
        startedAt: new Date(),
        prompt: text,
        timeoutMs: TURN_TIMEOUT_MS,
        createdBy: personId,
        answersCeo: await isCeo(ctx, personId),
        toolTokenHash: hashToken(token),
        instructionsHash: last?.hash ?? null,
      })
      .returning({ id: jobs.id });
    if (text.trim()) await appendEvent(ctx, { companyId: agent.companyId, agentId, jobId: job!.id, kind: 'message', data: { text }, personId });
    await publishWorking(ctx, agent.companyId);
    return { jobId: job!.id, token };
  });
  return opened;
}

/* Someone who may type opened the window of an agent whose program does not run: a turn that types nothing starts it on
   the node, so they talk to it at once. A turn that waits or runs starts it anyway. */
export async function startProgram(ctx: Ctx, node: NodeIdentity, agentId: string): Promise<void> {
  if (!z.uuid().safeParse(agentId).success) return;
  const started = await onAgent(ctx, agentId, async () => {
    const { db } = ctx;
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, agentId), isNull(agents.removedAt)));
    const sub = agent ? await liveSubscription(ctx, agent.id) : null;
    const at = sub ? await nodeOfAgent(ctx, agentId) : null;
    if (!agent || !sub || !at || !sameNode(at, node)) return false;
    /* Task turns of an agent that is switched off wait for it to be on and start nothing. */
    const waiting = and(eq(jobs.status, 'queued'), limitUntil(sub.limits) ? programStart : agent.switchedOffAt ? isNull(jobs.taskId) : undefined);
    const [open] = await db.select({ id: jobs.id }).from(jobs).where(and(conversationOf(agentId), or(eq(jobs.status, 'running'), waiting))).limit(1);
    if (open) return false;
    await insertTurn(ctx, { companyId: agent.companyId, agentId, prompt: '', createdBy: null });
    return true;
  });
  /* Outside the agent's line, which the pump waits on. */
  if (started) await pump(ctx, agentId);
}

/* A new session catches up from the conversation. The last finished turn's session goes on only on the same subscription
   and node with the same instructions: another machine does not have it, and changed instructions would not reach a
   session that already has the old ones. A turn that ran out of time or was stopped in its session finished too, the
   session whole; one that broke, or was called off before it ran, leaves the session before it. Each turn of the company
   starts every agent in a clean session, which only the orchestrator, who talks with people across turns, catches up. */
async function sessionFor(ctx: Ctx, agent: { id: string; companyId: string; kind: string; name: string }, on: { subscriptionId: string; nodeId: string | null }, instructionsHash: string): Promise<{ sessionId: string | null; catchUp: string | null }> {
  const [last] = await ctx.db
    .select({ subscriptionId: jobs.subscriptionId, nodeId: jobs.nodeId, sessionId: jobs.sessionId, instructionsHash: jobs.instructionsHash, startedAt: jobs.startedAt })
    .from(jobs)
    .where(and(conversationOf(agent.id), or(eq(jobs.status, 'done'), and(eq(jobs.status, 'failed'), inArray(jobs.error, ['timeout', 'cancelled']), isNotNull(jobs.sessionId)))))
    .orderBy(desc(jobs.finishedAt))
    .limit(1);
  const [turn] = await ctx.db
    .select({ openedAt: sql<Date>`coalesce(${turns.openedAt}, ${turns.createdAt})` })
    .from(turns)
    .where(and(eq(turns.companyId, agent.companyId), eq(turns.status, 'open')));
  const newTurn = Boolean(last?.startedAt && turn && new Date(last.startedAt) < new Date(turn.openedAt));
  if (last?.sessionId && !newTurn && last.subscriptionId === on.subscriptionId && last.nodeId === on.nodeId && last.instructionsHash === instructionsHash) return { sessionId: last.sessionId, catchUp: null };
  if (newTurn && agent.kind !== 'orchestrator') return { sessionId: null, catchUp: null };
  const talk = await earlierTalk(ctx.db, agent.id);
  return { sessionId: null, catchUp: talk.length ? preface(talk, agent.kind === 'orchestrator' ? 'Orchestrator' : agent.name) : null };
}

/* Turns need a node from 0.3.0 on: older ones drop his instructions and tool token, cannot stop a turn and send nothing live.
   Turns with a repository need 0.5.0, which clones it. The built-in node always matches the server. */
const CONVERSATION_NODE = [0, 3, 0];
const REPOSITORY_NODE = [0, 5, 0];
function outdated(version: string | null, need = CONVERSATION_NODE): boolean {
  const have = (version ?? '0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < need.length; i++) if ((have[i] ?? 0) !== need[i]) return (have[i] ?? 0) < need[i]!;
  return false;
}

/* moves: the agent has not been on this node until now, or leaves the machine it was on for the built-in node. */
type Placement = { node: NodeIdentity; nodeId: string | null; moves: boolean };

/* Where the agent's next turn goes. A company key's to the built-in node. A plan's to the node its program is on while
   that one is signed in, connected and new enough, so its folder, session and terminal go on there; otherwise to the
   freest of the plan's nodes that is, unless the agent has work in progress on its own and waits for it. None while no
   node can take it. */
async function placement(ctx: Ctx, agent: { id: string; nodeId: string | null }, sub: { id: string; kind: 'personal' | 'api_key' }, need = CONVERSATION_NODE): Promise<Placement | null> {
  if (sub.kind === 'api_key') return ctx.hub.isReady(BUILTIN) ? { node: BUILTIN, nodeId: null, moves: agent.nodeId !== null } : null;
  const all = await planNodes(ctx.db, [sub.id]);
  const able = all.filter(n => n.status === 'ready' && !outdated(n.version, need) && ctx.hub.isReady(nodeIdentity(n.id)));
  const stays = all.some(n => n.id === agent.nodeId) && (await holdsWork(ctx, agent.id));
  const pick = able.find(n => n.id === agent.nodeId) ?? (stays ? null : await freest(ctx, able));
  return pick ? { node: nodeIdentity(pick.id), nodeId: pick.id, moves: pick.id !== agent.nodeId } : null;
}

/* Whether the agent holds a task it works on, or stopped on to ask: its folder may hold work it has not pushed, so it
   waits for its own machine, and a laptop that sleeps a while does not scatter the team. */
async function holdsWork(ctx: Ctx, agentId: string): Promise<boolean> {
  const [held] = await ctx.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.assigneeAgentId, agentId), inArray(tasks.status, ['working', 'blocked']))).limit(1);
  return Boolean(held);
}

/* The node on the machine its nodes say is freest, and of machines about as free the one that holds the fewest agents,
   the older of two alike. */
async function freest(ctx: Ctx, able: NodeRow[]): Promise<NodeRow | null> {
  if (able.length <= 1) return able[0] ?? null;
  const held = await ctx.db
    .select({ machineId: nodes.machineId, n: count() })
    .from(agents)
    .innerJoin(nodes, eq(nodes.id, agents.nodeId))
    .where(and(isNull(agents.removedAt), inArray(nodes.machineId, able.map(n => n.machineId))))
    .groupBy(nodes.machineId);
  const on = (n: NodeRow) => Number(held.find(h => h.machineId === n.machineId)?.n ?? 0);
  const free = (n: NodeRow) => {
    const load = ctx.hub.loadOf(nodeIdentity(n.id));
    return load ? freedom(load) : null;
  };
  const better = (a: NodeRow, b: NodeRow) => {
    const [x, y] = [free(a), free(b)];
    if (x !== null && y !== null && Math.abs(x - y) >= ABOUT_AS_FREE) return x > y;
    return on(a) < on(b);
  };
  return able.reduce((best, n) => (better(n, best) ? n : best));
}

const ALONG = 'Several of your tasks moved while you were busy. Go through each of them in this turn:';
/* What a task's turn that went out inside another one ended with: its own result is the other turn's. */
export const GONE_ALONG = 'Went out with the turn before it.';

/* The other task turns waiting for the agent, oldest first. */
function alongWith(ctx: Ctx, agentId: string, jobId: string) {
  return ctx.db
    .select({ id: jobs.id, prompt: jobs.prompt, taskId: jobs.taskId })
    .from(jobs)
    .where(and(conversationOf(agentId), eq(jobs.status, 'queued'), isNotNull(jobs.taskId), ne(jobs.id, jobId)))
    .orderBy(asc(jobs.createdAt));
}

/* A waiting turn that went out inside another: over, with its task taken up as its own turn would have. */
async function goneAlong(ctx: Ctx, jobId: string): Promise<void> {
  const at = new Date();
  const [gone] = await ctx.db
    .update(jobs)
    .set({ status: 'done', result: GONE_ALONG, startedAt: at, finishedAt: at })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'queued')))
    .returning({ id: jobs.id });
  if (gone) await startWork(ctx, jobId);
}

/* A task turn of the task's holder left waiting from before the task came to wait for the tasks it comes after: it would
   set to work on it anyway, so it ends unsent. The holder is woken again once the task can start. */
async function heldBack(ctx: Ctx, job: { id: string; agentId: string | null; taskId: string | null }): Promise<boolean> {
  if (!job.taskId) return false;
  const [task] = await ctx.db.select({ after: tasks.after, assigneeAgentId: tasks.assigneeAgentId }).from(tasks).where(eq(tasks.id, job.taskId));
  if (!task || task.assigneeAgentId !== job.agentId || !(await openAfter(ctx.db, task)).length) return false;
  await ctx.db.update(jobs).set({ status: 'failed', error: 'waiting', finishedAt: new Date() }).where(and(eq(jobs.id, job.id), eq(jobs.status, 'queued')));
  return true;
}

/* Why a turn ended unsent: its instructions are longer than any node takes, or than its node from before skill files
   takes. */
export const TOO_LONG = 'instructions_too_long';
export const NODE_TOO_OLD = 'node_too_old';
export const UNSENT: readonly string[] = [TOO_LONG, NODE_TOO_OLD];

/* Instructions longer than its node takes: the node would drop the turn unseen. */
function unsendable(name: string, length: number, files: boolean): { error: string; result: string } | null {
  if (files) {
    return length > MAX_INSTRUCTIONS
      ? { error: TOO_LONG, result: `${name}'s instructions are ${length} characters, more than the ${MAX_INSTRUCTIONS} a turn carries, so this turn did not go out. Shorten its role or a skill on its card.` }
      : null;
  }
  return length > OLD_NODE_INSTRUCTIONS
    ? { error: NODE_TOO_OLD, result: `This machine's node is too old for these instructions; update it. ${name}'s instructions are ${length} characters, more than the ${OLD_NODE_INSTRUCTIONS} it takes.` }
    : null;
}

/* A turn its node would drop ends at once instead, saying why on the agent's card and its task. It ends after this send
   is over, as its end sends the agent's next turn. */
async function unsent(ctx: Ctx, job: { id: string; companyId: string }, why: { error: string; result: string }): Promise<void> {
  const at = new Date();
  const [ended] = await ctx.db
    .update(jobs)
    .set({ status: 'failed', ...why, startedAt: at, finishedAt: at })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, 'queued')))
    .returning({ id: jobs.id });
  if (!ended) return;
  await publishWorking(ctx, job.companyId);
  /* tasks/wake imports this module, so its afterJob comes in here. */
  void import('../tasks/wake.js')
    .then(({ afterJob }) => afterJob(ctx, job.id))
    .catch(err => ctx.log.error({ error: loggable(err) }, 'A turn that did not go out could not end.'));
}

/* A turn that waited for the agent and goes out inside its turn. */
type Along = { id: string; prompt: string; taskId: string | null };
type Queued = Pick<typeof jobs.$inferSelect, 'id' | 'companyId' | 'agentId' | 'taskId'>;
/* What a turn goes out with: where it runs and what it says. */
type Sending = Pick<typeof jobs.$inferInsert, 'subscriptionId' | 'nodeId' | 'prompt' | 'toolTokenHash' | 'instructionsHash'>;

/* Takes the waiting turn to send it, running from now on. In the same write each line of the map its work keeps on, with
   the tasks that go out along with it, begins a new cycle: a server that stops once the turn went out never brings the
   line's old return back, and a turn whose cycle cannot be kept is not taken. The lines when one began a cycle. */
async function take(ctx: Ctx, job: Queued, along: readonly Along[], sending: Sending): Promise<{ lines: { companyId: string } | null } | null> {
  return ctx.db.transaction(async tx => {
    const [row] = await tx
      .update(jobs)
      .set({ ...sending, status: 'running', startedAt: new Date() })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, 'queued')))
      .returning({ id: jobs.id });
    return row ? { lines: await workStarts(tx, { id: job.id, companyId: job.companyId, agentId: job.agentId, taskIds: [job.taskId, ...along.map(a => a.taskId)] }) } : null;
  });
}

/* The turn went out: its task and those that went along with it are at work, and the map reads its lines again once the
   turn carries them all. */
async function wentOut(ctx: Ctx, job: Queued, along: readonly Along[], lines: { companyId: string } | null): Promise<void> {
  if (job.taskId) await startWork(ctx, job.id);
  for (const j of along) await goneAlong(ctx, j.id);
  if (lines) ctx.bus.publish(lines.companyId, { type: 'org' });
}

async function sendNext(ctx: Ctx, agentId: string): Promise<void> {
  const { db } = ctx;
  const [running] = await db.select({ id: jobs.id }).from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'running'))).limit(1);
  if (running) return;
  const sub = await liveSubscription(ctx, agentId);
  if (!sub || sub.status !== 'ready') return;
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent || !(await placement(ctx, agent, sub))) return;
  /* An update waits for the turns that run: new ones start after it, the orchestrator's go on. */
  if (agent.kind !== 'orchestrator' && turnsHeld(ctx, agent.companyId)) return;
  /* Real turns wait for the limit; an empty start can still open the saved program. Past the share set for tasks only
     task turns wait. */
  const until = limitUntil(sub.limits);
  const spent = budgetUntil(sub.limits, sub.budget);
  if (until ?? spent) pumpAt(ctx, agentId, (until ?? spent)!);
  /* Switched off, it still answers people who write to it; its task turns wait until it is on. */
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(conversationOf(agentId), eq(jobs.status, 'queued'), until ? programStart : undefined, agent.switchedOffAt || spent ? isNull(jobs.taskId) : undefined))
    .orderBy(asc(jobs.createdAt))
    .limit(1);
  if (!job) return;
  if (await heldBack(ctx, job)) return sendNext(ctx, agentId);
  const repo = await repoFor(ctx, agent);
  const place = await placement(ctx, agent, sub, repo ? REPOSITORY_NODE : CONVERSATION_NODE);
  if (!place) return;
  /* A head reads everything that moved on its tasks while it was busy in one turn, instead of one turn per task. */
  const along: Along[] = [];
  for (const j of agent.kind === 'head' && job.taskId ? await alongWith(ctx, agentId, job.id) : []) if (!(await heldBack(ctx, { ...j, agentId }))) along.push(j);
  const asked = along.length ? [ALONG, job.prompt, ...along.map(j => j.prompt)].join('\n\n---\n\n') : job.prompt;

  /* A node from before skill files gets every skill in the instructions. */
  const files = ctx.hub.takesSkillFiles(place.node);
  const instructions = await instructionsOf(ctx, agent, files);
  const refused = unsendable(agent.name, instructions.text.length, files);
  if (refused) return unsent(ctx, job, refused);
  /* The program's flag only for a model this subscription can run; anything else runs on its Default. */
  const models = modelsFor(sub.provider, sub.models);
  const model = agent.model && models.some(m => m.id === agent.model) ? agent.model : null;
  /* How hard it thinks goes on in the same session; the program starts again at the new level. */
  const effort = effortFor(sub.provider, agent.effort, effortsOf(models, model));
  /* The hash covers the model too, so a new model starts a fresh session like new instructions do. */
  const runHash = model ? textHash(`${instructions.hash}:${model}`) : instructions.hash;
  const { sessionId, catchUp } = await sessionFor(ctx, agent, { subscriptionId: sub.id, nodeId: place.nodeId }, runHash);
  const said = repo ? `${asked}\n\n${repoLine(repo)}` : asked;
  /* A turn that types nothing only starts the program, for a person to talk to it: what was said before and where the
     repository is go with its instructions instead. */
  const prompt = !job.prompt ? '' : catchUp ? `${catchUp}\n\n${said}` : said;
  const token = newToken();
  /* Running from the moment it is sent: the token works for its tools at once, and the next turn waits. */
  const taken = await take(ctx, job, along, { subscriptionId: sub.id, nodeId: place.nodeId, prompt, toolTokenHash: hashToken(token), instructionsHash: runHash });
  if (!taken) return;
  /* The agent stays on this machine from now on. */
  if (place.moves) await db.update(agents).set({ nodeId: place.nodeId }).where(eq(agents.id, agentId));
  let sent = false;
  try {
    await publishWorking(ctx, job.companyId);
    sent = await dispatchJob(ctx, {
      id: job.id,
      subscriptionId: sub.id,
      nodeId: place.nodeId,
      prompt,
      sessionId,
      model,
      effort,
      compactWindow: agent.kind === 'worker' ? WORKER_COMPACT_WINDOW : null,
      timeoutMs: job.timeoutMs,
      instructions: instructions.text,
      toolToken: token,
      context: job.prompt ? null : catchUp,
      guidance: job.prompt || !repo ? null : repoLine(repo),
      /* Each agent keeps one folder on the node, with its repository's clone inside. */
      workspace: { key: agent.id, repo },
      ...(files ? { skills: instructions.skills } : {}),
    });
  } catch (err) {
    /* A turn that broke on its way out was not sent: it waits for the next try instead of running forever. */
    ctx.log.error({ error: loggable(err) }, 'A turn could not go out and waits for the next try.');
  }
  if (sent) return wentOut(ctx, job, along, taken.lines);
  await db.update(jobs).set({ status: 'queued', startedAt: null, nodeId: null, prompt: job.prompt, toolTokenHash: null, instructionsHash: null }).where(and(eq(jobs.id, job.id), eq(jobs.status, 'running')));
  await publishWorking(ctx, job.companyId);
}

/* Sends the agent's oldest waiting turn when none runs and his subscription is online and signed in. */
export function pump(ctx: Ctx, agentId: string): Promise<void> {
  return onAgent(ctx, agentId, () => sendNext(ctx, agentId));
}

/* Every agent with turns waiting, after a machine came back or a subscription changed. */
export async function pumpWaiting(ctx: Ctx): Promise<void> {
  const waiting = await ctx.db.selectDistinct({ agentId: jobs.agentId }).from(jobs).where(and(eq(jobs.kind, 'conversation'), eq(jobs.status, 'queued')));
  for (const { agentId } of waiting) if (agentId) await pump(ctx, agentId);
}

/* The turn that a task's turn marked gone along went out inside: the agent's own turn that started last before it. */
export async function carrierOf(ctx: Ctx, gone: { agentId: string; startedAt: Date }) {
  const [carrier] = await ctx.db
    .select({ status: jobs.status, error: jobs.error, at: jobs.finishedAt })
    .from(jobs)
    .where(and(conversationOf(gone.agentId), lte(jobs.startedAt, gone.startedAt), or(isNull(jobs.result), ne(jobs.result, GONE_ALONG))))
    .orderBy(desc(jobs.startedAt))
    .limit(1);
  return carrier ?? null;
}

export async function orchestratorOf(ctx: Ctx, companyId: string) {
  const [agent] = await ctx.db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.kind, 'orchestrator')));
  return agent ?? null;
}

export async function orchestratorState(ctx: Ctx, companyId: string): Promise<AgentState> {
  const agent = await orchestratorOf(ctx, companyId);
  if (!agent) return { ready: false, limitUntil: null, budgetUntil: null, reason: 'no_subscription', busy: false, runningJobId: null, queued: 0, terminal: false };
  return agentState(ctx, agent.id);
}

/* Why the agent's turns cannot go out now, or null when they can: a plan's go out while one of its machines can take them,
   and otherwise wait for what its own machine waits for, or one of the plan's that is online, or its first. One with work
   in progress waits for its own machine alone. */
async function waitsFor(ctx: Ctx, agent: { id: string; productId: string | null; departmentId: string | null; nodeId: string | null }, sub: { id: string; kind: 'personal' | 'api_key' }): Promise<AgentState['reason']> {
  if (sub.kind === 'api_key') return ctx.hub.isReady(BUILTIN) ? null : 'machine_offline';
  const all = await planNodes(ctx.db, [sub.id]);
  if (!all.length) return 'waiting_machine';
  const need = all.some(n => outdated(n.version, REPOSITORY_NODE)) && (await repoFor(ctx, agent)) ? REPOSITORY_NODE : CONVERSATION_NODE;
  const why = (n: NodeRow): AgentState['reason'] =>
    n.status === 'needs_login' ? 'needs_login' : outdated(n.version, need) ? 'node_outdated' : !ctx.hub.isReady(nodeIdentity(n.id)) ? 'machine_offline' : null;
  const own = all.find(n => n.id === agent.nodeId);
  if (own && why(own) !== null && (await holdsWork(ctx, agent.id))) return why(own);
  if (all.some(n => why(n) === null)) return null;
  return why(own ?? all.find(n => ctx.hub.isOnline(nodeIdentity(n.id))) ?? all[0]!);
}

/* Whether the agent can answer now and, if not, why; what it is doing and how many turns wait. */
export async function agentState(ctx: Ctx, agentId: string): Promise<AgentState> {
  const [running] = await ctx.db.select({ id: jobs.id }).from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'running'))).limit(1);
  const [waiting] = await ctx.db.select({ n: count() }).from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'queued')));
  const sub = await liveSubscription(ctx, agentId);
  const [agent] = sub ? await ctx.db.select({ id: agents.id, productId: agents.productId, departmentId: agents.departmentId, nodeId: agents.nodeId }).from(agents).where(eq(agents.id, agentId)) : [];
  const reason: AgentState['reason'] = !sub || !agent ? 'no_subscription' : await waitsFor(ctx, agent, sub);
  /* The terminal the window opens is of the machine the program is on, or for one not on a machine yet, of the machine
     its next turn would go to, where the window starts it. */
  const shown = (await programNode(ctx, agentId))?.node ?? (sub && agent ? ((await placement(ctx, agent, sub))?.node ?? null) : null);
  const terminal = Boolean(shown && ctx.hub.hasTerminals(shown));
  return { ready: reason === null, limitUntil: sub ? limitUntil(sub.limits) : null, budgetUntil: sub ? budgetUntil(sub.limits, sub.budget) : null, reason, busy: Boolean(running), runningJobId: running?.id ?? null, queued: Number(waiting?.n ?? 0), terminal };
}
