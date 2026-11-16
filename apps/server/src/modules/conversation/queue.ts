import { countOnly, idOnly, only } from '../../db/selections.js';
import { hideCredentialsIn } from '@hornhoof/protocol/redaction';
import { combineReport, reportDelay } from './report-notices.js';
import type { MachineDrain, Notification } from '@hornhoof/protocol';
import type { MessageParty } from '../events/parties.js';
import { currentLimits, effortsOf, inLane, isProgramOwnPrompt, MAX_INSTRUCTIONS, modelsFor, OLD_NODE_INSTRUCTIONS, UNHEARD_MS, type Limits } from '@hornhoof/protocol';
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { forgetPrivateTurn } from '../tools/private-turns.js';
import { loggable } from '../../errors.js';
import { hashToken, newToken } from '../../crypto/tokens.js';
import { agentEvents, agents, jobs, nodes, subscriptions, tasks, type AgentKind } from '../../db/schema.js';
import { dispatchJob } from '../jobs/dispatch.js';
import type { TurnRefusal } from '../terminals/relay.js';
import { nodeDrain, nodeHeld, nodeHeldFrom, nodeHeldLong, turnsHeld } from '../updates/drain.js';
import { actingCeo, alsoKept, deliverLockedInput, inputKept, turnStarted, typedWentIn, withInputLock } from './decision-context.js';
import { builtinOf, identityOf, nodeIdentity, ownBuiltin, ownMachine, sameNode, type NodeIdentity } from '../nodes/hub.js';
import { liveNode, planNodes, type NodeRow } from '../nodes/nodes.js';
import { holdsBuiltin, holdsMachine, machineInstalls, nextToInstallHolds } from '../network/follow.js';
import { pickBuiltin } from '../nodes/builtin.js';
import { cameBack } from '../nodes/connections.js';
import { shownAway } from '../nodes/machine-away.js';
import { roomFor, turnSent } from '../nodes/program-room.js';
import { jobsOf } from '../nodes/messages.js';
import { appendEvent, earlierTalk, messageForJob, publishWorking, type WithEvent } from '../events/store.js';
import { instructionsOf } from '../agents/instructions.js';
import { repoAt, repoFor, turnPlaces } from '../departments/repository.js';
import { textHash } from '../templates/load.js';
import { openAfter, startWork, type Tx } from '../tasks/engine.js';
import { discardStaleTurn, discardStaleTurns, type TaskWake } from '../tasks/wake-state.js';
import { agentProgramState, type TurnAlarm, type TurnAlarmReason, type TurnProgram } from '../tasks/silent.js';
import { workStarts } from '../org/map-state.js';
import { agentFailureState, notifyFailure, type FailureState } from '../tasks/failures.js';
import { logTurnFact } from '../tasks/turn-log.js';
import { openTurnOf } from '../tasks/turn-department.js';
import { addressed, preface } from './prompt.js';
import { originalPromptOf } from './requested-prompt.js';
import { effortOfTurn } from './turn-effort.js';
import { ABOUT_AS_FREE, freedom } from '../testruns/pick.js';
import { repositoryScope } from '../testruns/describe.js';
import { queuedInput, queuedUsed } from './queued-input.js';
import { repeatedTurn, UNHEARD_NOTE, type RepeatedTurn, type TurnWords } from './turn-words.js';
import { cancelUnsentDelivery, reserveDelivery } from '../program-operator/deliveries.js';
import { liveInputOf, sourceDeliveryForJob, sourceDeliveryMetadataForJob } from '../program-operator/input.js';
import type { OperatorDelivery } from '@hornhoof/protocol/program-operator';
import { operatorRecoveryHolds, resumeOperatorProcess } from '../program-operator/recovery.js';
import { queuedOperatorAssignment } from '../program-operator/recovered-input.js';
import { fallbackMove } from '../subscriptions/fallback.js';
import { claimMail, inboxChanged, inboxModeOf, isMail, keepMail, mailShown, mailSummary, mailWentOut, takesInsteadOfTurn, unreadMail, type InboxStatus } from './inbox.js';

/* Workers compact their conversation at half a million tokens, which keeps their turns quick; heads and the orchestrator
   keep the whole window, since they hold the department's and the company's picture. Their window is named outright too:
   left to its own choice, Claude Code stops a session with a question whether to compact earlier, which nobody answers. */
export const WORKER_COMPACT_WINDOW = 500_000;
export const FULL_COMPACT_WINDOW = 1_000_000;

/* Any turn may run as long as its work takes. This only ends one that hangs, a program frozen or waiting for input
   nobody gives, so the agent's next turns are not stuck behind it; the agent goes on in the same session. */
export const TURN_TIMEOUT_MS = 2 * 3_600_000;

export type PlanHold = { reason: 'limit' | 'budget'; since: string; until: string };

export type AgentState = FailureState & {
  ready: boolean;
  machineDrain: MachineDrain | null;
  /* Its turns would start its program on a machine short of free memory, so they wait and go on by themselves once the
     memory frees up. */
  memoryWait: boolean;
  /* Its plan is at its limit until then: its turns wait in line, and people may still write to it. */
  limitUntil: string | null;
  /* Its plan used the share set for tasks until then: workers' task turns wait, people's own messages still go. */
  budgetUntil: string | null;
  /* The oldest turn its plan holds, and why. */
  held: PlanHold | null;
  reason: 'no_subscription' | 'waiting_machine' | 'needs_login' | 'needs_setup' | 'node_outdated' | 'machine_offline' | null;
  browserError: string | null;
  busy: boolean;
  runningJobId: string | null;
  queued: number;
  /* Its node shows the agent's live terminal. */
  terminal: boolean;
  /* Why the last prompt its program took has no turn, until a new turn begins. */
  turnRefused: TurnRefusal | null;
  program: TurnProgram | null;
  alarm: TurnAlarm | null;
};

/* How long after a plan's limit starts over its waiting turns go out, so the program sees the new limit. */
const LIMIT_GRACE_MS = 5_000;
const LONGEST_TIMER_MS = 2 ** 31 - 1;

/* When the plan's limit starts over, while the plan is at it: the latest reset of a full window still to come. A plan at
   its limit that says no reset holds nothing, so its turns go out and fail as before rather than wait forever. */
export function limitUntil(limits: Limits | null, updatedAt: string | Date | null, now = Date.now()): string | null {
  const current = currentLimits(limits, updatedAt, now);
  if (current?.status !== 'rejected') return null;
  const resets = current.windows.filter(w => (w.utilization === null || w.utilization >= 1) && w.resetsAt).map(w => w.resetsAt!);
  return resets.length ? resets.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;
}

/* When a window of the plan that used the share set for task turns starts over: the latest such reset still to come. */
export function budgetUntil(limits: Limits | null, budget: number | null, updatedAt: string | Date | null, now = Date.now()): string | null {
  if (budget === null || budget >= 100) return null;
  const resets = (currentLimits(limits, updatedAt, now)?.windows ?? []).filter(w => w.utilization !== null && w.utilization * 100 >= budget && w.resetsAt).map(w => w.resetsAt!);
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
export function refusedLimits(output: string, limits: Limits | null, now = Date.now(), usageLimit = false): Limits | null {
  const end = output.slice(-1500);
  if (!usageLimit && !REFUSED.test(end)) return null;
  const name = /\b(?:weekly|7-day|seven-day)\b/i.test(end) ? 'seven_day' : 'five_hour';
  const known = limits?.windows.find(w => w.name === name)?.resetsAt;
  const resetsAt = againIn(end, now) ?? (known && Date.parse(known) > now ? known : new Date(now + LIMIT_PROBE_MS).toISOString());
  return { ...limits, status: 'rejected', windows: [...(limits?.windows ?? []).filter(w => w.name !== name), { name, utilization: 1, resetsAt }] };
}

/* Wakes the agent's line once its plan's limit starts over. */
const resets = new WeakMap<Ctx, Map<string, { at: string; timer: NodeJS.Timeout }>>();
function pumpAt(ctx: Ctx, agentId: string, at: string, grace = LIMIT_GRACE_MS): void {
  const timers = resets.get(ctx) ?? new Map<string, { at: string; timer: NodeJS.Timeout }>();
  resets.set(ctx, timers);
  if (timers.get(agentId)?.at === at) return;
  clearTimeout(timers.get(agentId)?.timer);
  /* A timer holds at most about 24 days: a longer wait wakes once then and sets itself again. */
  const wait = Date.parse(at) - Date.now() + grace;
  const timer = setTimeout(() => {
    timers.delete(agentId);
    if (wait > LONGEST_TIMER_MS) return pumpAt(ctx, agentId, at, grace);
    void pump(ctx, agentId).catch(() => {});
  }, Math.min(wait, LONGEST_TIMER_MS));
  timer.unref();
  timers.set(agentId, { at, timer });
}

/* The program gets a short chance to take its queued words before the next turn goes out. */
type WordWait = { node: NodeIdentity; until: number };
const waitingWords = new WeakMap<Ctx, Map<string, Map<string, WordWait>>>();

function wordsForAgent(ctx: Ctx, agentId: string): Map<string, WordWait> {
  const agents = waitingWords.get(ctx) ?? new Map<string, Map<string, WordWait>>();
  waitingWords.set(ctx, agents);
  const jobs = agents.get(agentId) ?? new Map<string, WordWait>();
  agents.set(agentId, jobs);
  return jobs;
}

/* Called under the agent's line together with the job's end, before another pump can send. */
export function holdForWords(ctx: Ctx, agentId: string, jobId: string, node: NodeIdentity, endedAt: Date): void {
  const jobs = wordsForAgent(ctx, agentId);
  const until = +endedAt + UNHEARD_MS;
  jobs.set(jobId, { node, until });
  pumpAt(ctx, agentId, new Date(until).toISOString(), 0);
}

export function settleWords(ctx: Ctx, agentId: string, jobId: string): void {
  const agents = waitingWords.get(ctx);
  if (!agents) return;
  const jobs = agents.get(agentId);
  if (!jobs) return;
  jobs.delete(jobId);
  if (!jobs.size) agents.delete(agentId);
}

export function clearNodeWords(ctx: Ctx, node: NodeIdentity): void {
  for (const [agentId, jobs] of waitingWords.get(ctx) ?? []) {
    for (const [jobId, wait] of jobs) if (sameNode(wait.node, node)) settleWords(ctx, agentId, jobId);
  }
}

async function waitsForWords(ctx: Ctx, agentId: string): Promise<boolean> {
  const jobs = waitingWords.get(ctx)?.get(agentId);
  if (!jobs) return false;
  const owner = await nodeOfAgent(ctx, agentId);
  for (const [jobId, wait] of jobs) {
    if (!owner || !sameNode(wait.node, owner) || Date.now() >= wait.until) settleWords(ctx, agentId, jobId);
  }
  return jobs.size > 0;
}

export async function wordsSettled(ctx: Ctx, node: NodeIdentity, agentId: string, jobId: string): Promise<void> {
  if (!z.uuid().safeParse(agentId).success || !z.uuid().safeParse(jobId).success) return;
  await onAgent(ctx, agentId, async () => {
    const [job] = await ctx.db.select(idOnly(jobs)).from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.agentId, agentId), inArray(jobs.status, ['done', 'failed']), isNotNull(jobs.finishedAt), jobsOf(node, ctx)));
    if (job) settleWords(ctx, agentId, jobId);
  });
  await pump(ctx, agentId);
}

/* What a turn ends with when a person or Hornhoof stopped it on purpose; none of these is a failure. */
export const STOPPED_ON_PURPOSE = ['cancelled', 'removed', 'switched_off'];

/* answersCeo: a note of something the CEO did, which counts as the CEO's order without a message. */
/* withMessage: what is kept together with the message, or not at all. */
/* retryOf: the turn a node restart cut off, which this one runs once more. continueOf: the turn that ended without
   recording its work, whose session this one goes on with. */
type Turn = { companyId: string; agentId: string; prompt: string; createdBy: string | null; message?: { personId: string | null; text: string; from?: 'orchestrator' | 'agent'; name?: string; by?: string; byTurn?: string; task?: { id: string; number: number }; taskWake?: TaskWake; request?: string; timer?: true; failureCase?: string; silentJob?: string; silentReason?: TurnAlarmReason; notification?: Notification; actor?: MessageParty; computerAccess?: { machineId: string; inboxId?: string }; action?: string; report?: string; reportContext?: string; senders?: MessageParty[]; pictures?: { id: string; name: string }[]; channel?: 'telegram' | 'assistant'; telegram?: { bot: string; chat: number; update: number }; assistant?: { id: string; name: string; message: string } }; repeated?: TurnWords; taskId?: string; answersCeo?: boolean; withMessage?: WithEvent; retryOf?: string; continueOf?: string; notBefore?: Date | null; fresh?: string };

export type TurnMessage = NonNullable<Turn['message']>;

/* One thing at a time per agent, so two pumps never send two turns. */
const chains = new WeakMap<Ctx, Map<string, Promise<unknown>>>();

export function onAgent<T>(ctx: Ctx, agentId: string, fn: () => Promise<T>): Promise<T> {
  const mine = chains.get(ctx) ?? new Map<string, Promise<unknown>>();
  chains.set(ctx, mine);
  return inLane(mine, agentId, fn);
}

export const conversationOf = (agentId: string) => and(eq(jobs.agentId, agentId), eq(jobs.kind, 'conversation'));
/* Only a node's empty start opens the program while the plan's real turns wait. */
const programStart = and(eq(jobs.prompt, ''), isNull(jobs.taskId), isNull(jobs.createdBy));

export async function liveSubscription(ctx: Ctx, agentId: string) {
  const [row] = await ctx.db.select({ sub: subscriptions }).from(agents).innerJoin(subscriptions, eq(subscriptions.id, agents.subscriptionId)).where(eq(agents.id, agentId));
  return row && !row.sub.removedAt ? row.sub : null;
}

/* A node and the owner of the subscription it runs: the person who may type into the agent's terminal there. */
export type ProgramNode = { node: NodeIdentity; ownerPersonId: string; planId: string };

const JOB_PLAN = { id: subscriptions.id, kind: subscriptions.kind, ownerPersonId: subscriptions.ownerPersonId, nodeId: jobs.nodeId, builtinMachine: jobs.builtinMachine };

/* A program stays up after its last turn, on the plan that turn ran on, until a turn of another plan takes its place. Company
   keys share the built-in node, so a window there shows that plan's program, even when the agent is on another key by now. A
   personal plan has nodes of its own, with no other plan's program on them. */
async function stayedProgram(ctx: Ctx, agentId: string, planId: string) {
  const [last] = await ctx.db
    .select(JOB_PLAN)
    .from(jobs)
    .innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
    .where(and(conversationOf(agentId), isNotNull(jobs.startedAt), eq(subscriptions.kind, 'api_key')))
    .orderBy(desc(jobs.startedAt))
    .limit(1);
  return last && last.id !== planId ? last : null;
}

/* The plan that holds the agent's program now, with the node it is on: the one its running turn went out to, since that
   turn goes on there when the agent moves, or else its own and its live node there, unless another plan's program stayed
   up there. */
export async function programPlan(ctx: Ctx, agentId: string) {
  const [running] = await ctx.db
    .select(JOB_PLAN)
    .from(jobs)
    .innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
    .where(and(conversationOf(agentId), eq(jobs.status, 'running')))
    .limit(1);
  if (running) return running;
  const [own] = await ctx.db
    .select({ id: subscriptions.id, kind: subscriptions.kind, ownerPersonId: subscriptions.ownerPersonId, nodeId: nodes.id, builtinMachine: agents.builtinMachine })
    .from(agents)
    .innerJoin(subscriptions, and(eq(subscriptions.id, agents.subscriptionId), isNull(subscriptions.removedAt)))
    .leftJoin(nodes, and(eq(nodes.id, agents.nodeId), eq(nodes.subscriptionId, agents.subscriptionId), liveNode))
    .where(eq(agents.id, agentId));
  return (own?.kind === 'api_key' && (await stayedProgram(ctx, agentId, own.id))) || own;
}

/* The node that holds the agent's program now. A company key's agents are on the built-in node. */
export async function programNode(ctx: Ctx, agentId: string): Promise<ProgramNode | null> {
  const own = await programPlan(ctx, agentId);
  const node = own && identityOf(own, own.nodeId, own.builtinMachine, ownBuiltin(ctx.config));
  return node ? { node, ownerPersonId: own.ownerPersonId, planId: own.id } : null;
}

export const nodeOfAgent = async (ctx: Ctx, agentId: string) => (await programNode(ctx, agentId))?.node ?? null;

/* The node someone who opens the agent's window watches. One that runs no turn starts its program where its next turn
   would go, and keeps that node; while no machine of its plan can take it, the window waits for the first to come back. */
export async function windowNode(ctx: Ctx, agentId: string): Promise<ProgramNode | null> {
  return (await onAgent(ctx, agentId, () => placedProgram(ctx, agentId))) ?? programNode(ctx, agentId);
}

/* Where an agent on a personal plan that runs no turn opens now. Anyone else's stays where it is. */
async function placedProgram(ctx: Ctx, agentId: string): Promise<ProgramNode | null> {
  const [running] = await ctx.db.select(idOnly(jobs)).from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'running'))).limit(1);
  const sub = running ? null : await liveSubscription(ctx, agentId);
  if (sub?.kind !== 'personal') return null;
  const at = (node: NodeIdentity) => ({ node, ownerPersonId: sub.ownerPersonId, planId: sub.id });
  const place = await nextTurnNode(ctx, agentId, sub);
  if (place) return at(place);
  const [first] = await planNodes(ctx.db, [sub.id]);
  return (await programNode(ctx, agentId)) ?? (first ? at(nodeIdentity(first.id)) : null);
}

/* The machine of its plan the agent's next turn would go to, which it keeps from now on. */
async function nextTurnNode(ctx: Ctx, agentId: string, sub: Parameters<typeof placement>[2]): Promise<NodeIdentity | null> {
  const [agent] = await ctx.db.select({ id: agents.id, kind: agents.kind, nodeId: agents.nodeId, builtinMachine: agents.builtinMachine, roleKey: agents.roleKey }).from(agents).where(eq(agents.id, agentId));
  const place = agent ? await placement(ctx, agent, sub) : null;
  if (place?.moves) await ctx.db.update(agents).set({ nodeId: place.nodeId, builtinMachine: place.builtinMachine }).where(eq(agents.id, agentId));
  return place?.node ?? null;
}

/* Whether the agent's next turn would go to another node than this one now, as the queue itself would place it: an
     agent that has work in progress on its own node waits for that one, and so goes nowhere else. Nothing is moved. */
export async function goesElsewhere(ctx: Ctx, agentId: string, from: NodeIdentity): Promise<boolean> {
  const sub = await liveSubscription(ctx, agentId);
  if (!sub) return false;
  const [agent] = await ctx.db.select({ id: agents.id, kind: agents.kind, nodeId: agents.nodeId, builtinMachine: agents.builtinMachine, roleKey: agents.roleKey }).from(agents).where(eq(agents.id, agentId));
  const place = agent ? await placement(ctx, agent, sub, CONVERSATION_NODE, lookRoom(ctx, agent)) : null;
  return place !== null && !sameNode(place.node, from);
}

/* The turn that goes on from this one's words, whichever way it came: a retry after a restart or a continuation. */
export async function turnGoingOn(ctx: Ctx, jobId: string): Promise<{ id: string; error: string | null } | null> {
  const [next] = await ctx.db.select({ id: jobs.id, error: jobs.error }).from(jobs).where(or(eq(jobs.retryOf, jobId), eq(jobs.continueOf, jobId))).limit(1);
  return next ?? null;
}

/* A turn its words went into as it ran. */
async function runsNow(ctx: Ctx, jobId: string): Promise<boolean> {
  const [job] = await ctx.db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, jobId));
  return job?.status === 'running';
}

/* Thrown before anything is stored, so the caller may undo what it did for the turn. */
export class NoSubscription extends Error {
  constructor() {
    super('The agent has no subscription.');
  }
}

/* Whether the person is the CEO or the CEO delegate now, whose words count as the CEO's. */
const actsForCeo = async (ctx: Ctx, personId: string | null | undefined): Promise<boolean> => Boolean(personId && (await actingCeo(ctx.db, personId)));

/* Keeps what no person wrote in the employee's inbox, with the turn it went into or waits for, and tells its screens. */
export async function keepLetter(ctx: Ctx, t: Turn, jobId: string, status: InboxStatus): Promise<string | null> {
  if (!isMail(t)) return null;
  const id = await keepMail(ctx.db, t, jobId, status);
  await inboxChanged(ctx, t.agentId);
  return id;
}

/* The turns a switched-off employee still takes: no task's and not the one for its inbox. */
const peopleTurns = and(isNull(jobs.taskId), eq(jobs.inboxWake, false));

/* Stores the turn and, when it carries a person's message, the message under the same job. */
export async function insertTurn(ctx: Ctx, t: Turn): Promise<string> {
  t = hideCredentialsIn(t);
  const combined = t.message?.report ? await combineReport(ctx, t) : null;
  const id = combined ?? (await insertFreshTurn(ctx, t));
  await keepLetter(ctx, t, id, 'unread');
  return id;
}

/* What the turn that takes the inbox asks before it goes out, when its prompt is written from the inbox. */
export const INBOX_PROMPT = 'Hornhoof: your inbox.';
export const NOTHING_UNREAD = 'Nothing in the inbox was unread when this turn was due.';

/* The one waiting turn of the agent that takes its inbox, made for the first letter that has none to wait for. */
async function inboxTurn(ctx: Ctx, t: Pick<Turn, 'companyId' | 'agentId'>): Promise<string> {
  const [open] = await ctx.db.select(idOnly(jobs)).from(jobs).where(and(conversationOf(t.agentId), eq(jobs.status, 'queued'), eq(jobs.inboxWake, true))).limit(1);
  if (open) return open.id;
  const sub = await liveSubscription(ctx, t.agentId);
  if (!sub) throw new NoSubscription();
  const [job] = await ctx.db.insert(jobs).values({ companyId: t.companyId, subscriptionId: sub.id, agentId: t.agentId, kind: 'conversation', prompt: INBOX_PROMPT, inboxWake: true, timeoutMs: TURN_TIMEOUT_MS, createdBy: null }).returning({ id: jobs.id });
  return job!.id;
}

/* A letter in inbox mode waits in the inbox for the one turn that takes it, and shows in the window with that turn; it goes
   into no running turn. */
async function intoInbox(ctx: Ctx, t: Turn & { message: TurnMessage }): Promise<string> {
  const wake = await inboxTurn(ctx, t);
  const inboxId = await keepLetter(ctx, t, wake, 'unread');
  const shown = t.message.computerAccess && inboxId ? { ...t, message: { ...t.message, computerAccess: { ...t.message.computerAccess, inboxId } } } : t;
  await showMessage(ctx, shown, wake, async () => undefined);
  return wake;
}

/* Letters wait unread with no turn for them, as after a turn that took the inbox did not reach its program: one goes now.
   A switched-off employee reads them once it is on again. */
async function inboxTurnDue(ctx: Ctx, agent: { id: string; companyId: string; switchedOffAt: Date | null }): Promise<boolean> {
  if (agent.switchedOffAt) return false;
  if ((await inboxModeOf(ctx.db, agent.id)).effective !== 'inbox' || !(await unreadMail(ctx.db, agent.id)).length) return false;
  const [open] = await ctx.db.select(idOnly(jobs)).from(jobs).where(and(conversationOf(agent.id), eq(jobs.status, 'queued'), eq(jobs.inboxWake, true))).limit(1);
  if (open) return false;
  await inboxTurn(ctx, { companyId: agent.companyId, agentId: agent.id });
  return true;
}

async function insertFreshTurn(ctx: Ctx, t: Turn): Promise<string> {
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
      retryOf: t.retryOf ?? null,
      continueOf: t.continueOf ?? null,
      notBefore: t.notBefore ?? reportDelay(t.message),
      answersCeo: t.answersCeo === true || (await actsForCeo(ctx, t.message?.personId)),
      /* Until its message is kept, a turn sent at once answers nobody. */
      decisionInputPending: !!t.repeated || shownOf(t) !== null,
    })
    .returning({ id: jobs.id });
  await showMessage(ctx, t, job!.id, tx => inputKept(tx, job!.id));
  return job!.id;
}

/* The message a turn shows in the window: a person's or an agent's, or Hornhoof's own words. */
function shownOf(t: Turn): NonNullable<Turn['message']> | null {
  if (t.repeated) return null;
  const message = t.message ?? { personId: null, text: t.prompt };
  return message.text.trim() ? message : null;
}

/* What stays with a shown message: the delivery it went by, and, for one that went into a running turn, what the program
   got when more than the window shows, for repeating it word for word. */
function keptWithMessage(t: Turn, message: NonNullable<Turn['message']>, live: boolean) {
  const delivery = liveInputOf(message, t.agentId)?.delivery;
  return { ...(delivery ? { operatorDelivery: delivery } : {}), ...(live && t.prompt !== message.text ? { livePrompt: t.prompt } : {}) };
}

/* An employee's message carries its name for the window and its id in by. kept: also kept with it. live: it went into a
   running turn. */
async function showMessage(ctx: Ctx, t: Turn, jobId: string, kept: WithEvent, live = false): Promise<void> {
  if (t.repeated) {
    await appendEvent(ctx, { companyId: t.companyId, agentId: t.agentId, jobId, kind: 'typed', ...t.repeated }, kept);
    return;
  }
  const message = shownOf(t);
  if (!message) return;
  const { personId, ...data } = message;
  /* The program's whole conversation waits with a turn of its own for whether that turn starts a new session; words that went
     into a running turn go on in its session. */
  const fresh = t.fresh && !live ? { _fresh: t.fresh } : {};
  await appendEvent(ctx, { companyId: t.companyId, agentId: t.agentId, jobId, kind: 'message', data: { ...data, ...keptWithMessage(t, message, live), ...fresh }, personId }, alsoKept(t.withMessage, kept));
}

/* Stores the turn, then sends it if he is free. A message for an agent at work goes into the turn it runs instead, and a
   turn that took a message of the CEO or the CEO delegate answers the CEO from then on. */
export async function enqueueTurn(ctx: Ctx, t: Turn): Promise<string> {
  t = hideCredentialsIn(t);
  const jobId = await withInputLock(ctx, t.agentId, () => insertOrDeliverTurn(ctx, t));
  await pump(ctx, t.agentId);
  return jobId;
}

/* Words go into the turn that runs when its node says they went in, and otherwise wait in the agent's line for its next
   turn, including when their topic is a task. The caller owns the input lock. */
export async function insertOrDeliverTurn(ctx: Ctx, t: Turn): Promise<string> {
  if (isMail(t) && takesInsteadOfTurn(t) && (await inboxModeOf(ctx.db, t.agentId)).effective === 'inbox') return intoInbox(ctx, t);
  const combined = await combineReport(ctx, t, { send: deliverLockedInput });
  if (combined) {
    if (isMail(t)) await keepLetter(ctx, t, combined, (await runsNow(ctx, combined)) ? 'read' : 'unread');
    return combined;
  }
  const message = t.repeated ? undefined : t.message;
  const into = message
    ? await deliverLockedInput(ctx, t.agentId, t.prompt, { source: { personId: message.personId, data: message } }, async (jobId, kept) => {
        if (await actsForCeo(ctx, message.personId)) await ctx.db.update(jobs).set({ answersCeo: true }).where(eq(jobs.id, jobId));
        await showMessage(ctx, t, jobId, kept, true);
      })
    : null;
  if (into) {
    await keepLetter(ctx, t, into, 'read');
    return into;
  }
  return insertTurn(ctx, t);
}

async function queuedOperatorWords(ctx: Ctx, agentId: string, jobId: string, text: string) {
  const [own] = await ctx.db.select(idOnly(agents)).from(agents).where(and(eq(agents.id, agentId), ne(agents.kind, 'assistant')));
  return own ? queuedOperatorAssignment(ctx, agentId, jobId, text) : null;
}

/* What a program may open without a person's keys: known live words it queued, or the assignment its delivery kept. */
const queuedWords = async (ctx: Ctx, agentId: string, jobId: string, text: string) =>
  (await queuedInput(ctx, agentId, jobId, text)) ?? queuedOperatorWords(ctx, agentId, jobId, text);

type QueuedTurn = NonNullable<Awaited<ReturnType<typeof queuedWords>>>;
type OpenedQueued = QueuedTurn & { repeated: RepeatedTurn };
type AgentTarget = { agent: typeof agents.$inferSelect; sub: NonNullable<Awaited<ReturnType<typeof liveSubscription>>> };

export async function agentOnNode(ctx: Ctx, node: NodeIdentity, agentId: string): Promise<AgentTarget | null> {
  const [agent] = await ctx.db.select().from(agents).where(and(eq(agents.id, agentId), isNull(agents.removedAt)));
  const sub = agent ? await liveSubscription(ctx, agent.id) : null;
  const at = sub ? await nodeOfAgent(ctx, agentId) : null;
  return agent && sub && at && sameNode(at, node) ? { agent, sub } : null;
}

/* Whose turn it is: of the person who typed, of the person whose words the program took after the turn they answered, or,
   for the words of anyone else, of the one the turn they came into was. */
async function turnOwner(ctx: Ctx, personId: string | null, repeated: RepeatedTurn | null): Promise<{ createdBy: string | null; answersCeo: boolean }> {
  if (repeated && !repeated.repeated.personId) return { createdBy: repeated.createdBy, answersCeo: repeated.answersCeo };
  const owner = repeated ? repeated.repeated.personId : personId;
  return { createdBy: owner, answersCeo: await actsForCeo(ctx, owner) };
}

async function insertRunningTurn(
  ctx: Ctx,
  node: NodeIdentity,
  target: AgentTarget,
  text: string,
  personId: string | null,
  repeated: RepeatedTurn | null,
): Promise<{ jobId: string; token: string } | null> {
  const [last] = await ctx.db
    .select({ hash: jobs.instructionsHash })
    .from(jobs)
    .where(and(conversationOf(target.agent.id), eq(jobs.subscriptionId, target.sub.id), isNotNull(jobs.instructionsHash)))
    .orderBy(desc(jobs.startedAt))
    .limit(1);
  const token = newToken();
  const nodeId = node.kind === 'node' ? node.nodeId : null;
  const owner = await turnOwner(ctx, personId, repeated);
  /* No turn begins on a machine that installs its build now: asked and written in one transaction, so the word to
     install and this turn never cross. */
  const job = await ctx.db.transaction(async tx => {
    if (await holdsMachine(tx, nodeId)) return null;
    const [row] = await tx
      .insert(jobs)
      .values({
        companyId: target.agent.companyId,
        subscriptionId: target.sub.id,
        nodeId,
        agentId: target.agent.id,
        kind: 'conversation',
        status: 'running',
        startedAt: new Date(),
        prompt: text,
        timeoutMs: TURN_TIMEOUT_MS,
        ...owner,
        toolTokenHash: hashToken(token),
        instructionsHash: last ? last.hash : null,
      })
      .returning({ id: jobs.id });
    return row!;
  });
  return job && { jobId: job.id, token };
}

async function appendOpenedWords(
  ctx: Ctx,
  companyId: string,
  agentId: string,
  jobId: string,
  text: string,
  personId: string | null,
  queued: OpenedQueued | null,
): Promise<void> {
  if (queued) {
    const { repeated } = queued.repeated;
    await appendEvent(ctx, { companyId, agentId, jobId, kind: 'typed', personId: repeated.personId, data: { ...(repeated.data as object), queuedEvent: queued.seq } });
    await logTurnFact(ctx, queued.job, UNHEARD_NOTE);
    return;
  }
  if (text.trim()) await appendEvent(ctx, { companyId, agentId, jobId, kind: 'message', data: { text }, personId });
}

async function storeTypedTurn(
  ctx: Ctx,
  node: NodeIdentity,
  agentId: string,
  text: string,
  personId: string | null,
  queuedFrom: string | undefined,
  queued: QueuedTurn | null,
): Promise<{ jobId: string; token: string } | null> {
  const target = await agentOnNode(ctx, node, agentId);
  if (!target || (queued && (await queuedUsed(ctx, agentId, queued.seq)))) return null;
  const openedQueued: OpenedQueued | null = queued ? { ...queued, repeated: await repeatedTurn(ctx, queued.job, queued.source) } : null;
  /* A machine that installs its build takes no turn, and nothing of what stands there is changed for one. */
  if (node.kind === 'node' && (await machineInstalls(ctx.db, node.nodeId))) return null;
  /* A turn that only started the program is over once the person types: their turn takes its place. */
  const started = await ctx.db
    .update(jobs)
    .set({ status: 'done', result: '', finishedAt: new Date() })
    .where(and(conversationOf(agentId), eq(jobs.status, 'running'), eq(jobs.prompt, ''), isNull(jobs.taskId))).returning({ id: jobs.id });
  forgetStartupValues(ctx, started);
  const [running] = await ctx.db.select(idOnly(jobs)).from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'running'))).limit(1);
  /* A program's queued turn can start before the old job's end has reached Hornhoof. It holds the line meanwhile. */
  if (running && running.id !== queuedFrom) return null;
  const opened = await insertRunningTurn(ctx, node, target, text, personId, openedQueued ? openedQueued.repeated : null);
  if (!opened) return null;
  await appendOpenedWords(ctx, target.agent.companyId, agentId, opened.jobId, text, personId, openedQueued);
  await publishWorking(ctx, target.agent.companyId);
  return opened;
}

/* A person typed into the agent's terminal while no turn ran, or while the program started: their keys came just before.
   Or they pressed Enter in a turn and its node saw the program queue what they typed for after it. The turn is theirs and
   runs from now on the node that shows the session, which goes on with the instructions it was started with: their hash
   stays, so the next turn resumes it. Without a person's keys, only known live words the program queued may open a turn. */
export async function openTypedTurn(ctx: Ctx, node: NodeIdentity, agentId: string, text: string, personId: string | null, queuedFrom?: string): Promise<{ jobId: string; token: string; typedBy: string | null } | null> {
  if ((!personId && !queuedFrom) || !z.uuid().safeParse(agentId).success) return null;
  const queued = await knownQueued(ctx, agentId, text, queuedFrom);
  const pressed = pressedEnter(ctx, node, agentId, personId, queued, queuedFrom);
  const typedBy = pressed ?? personId;
  if (!queued && !typedBy) return null;
  const run = () => onAgent(ctx, agentId, () => storeTypedTurn(ctx, node, agentId, text, typedBy, queuedFrom, queued));
  return afterTypedTurn(ctx, agentId, await (queued ? withInputLock(ctx, agentId, run) : run()), pressed, typedBy);
}

/* The person whose Enter in the turn that the node names sent the words, when no keys came just before them. */
const pressedEnter = (ctx: Ctx, node: NodeIdentity, agentId: string, personId: string | null, queued: QueuedTurn | null, queuedFrom?: string): string | null =>
  queuedFrom && !queued && !personId ? ctx.terminals.takePressed(node, agentId, queuedFrom) : null;

const knownQueued = async (ctx: Ctx, agentId: string, text: string, queuedFrom?: string): Promise<QueuedTurn | null> =>
  queuedFrom ? queuedWords(ctx, agentId, queuedFrom, text) : null;

/* What the window says of the last refusal ends with a turn. With none, what a person's Enter queued is in the turn that runs. */
async function afterTypedTurn(ctx: Ctx, agentId: string, opened: { jobId: string; token: string } | null, pressed: string | null, typedBy: string | null) {
  if (opened) ctx.terminals.turnBegan(agentId);
  else if (pressed) await typedWentIn(ctx, agentId, pressed);
  return opened && { ...opened, typedBy };
}

/* Hornhoof opened no turn for what the program took, whose answer has no tools: the window of the agent says why. Nothing
   of the kind for a node the agent is not on, which may speak for no one of its company, or for the program's own news. */
export async function turnRefused(ctx: Ctx, node: NodeIdentity, agentId: string, text: string, queuedFrom?: string): Promise<void> {
  if (isProgramOwnPrompt(text) || !z.uuid().safeParse(agentId).success) return;
  const target = await agentOnNode(ctx, node, agentId);
  if (!target) return;
  const [running] = await ctx.db.select(idOnly(jobs)).from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'running'))).limit(1);
  const installing = node.kind === 'node' && (await machineInstalls(ctx.db, node.nodeId));
  const reason: TurnRefusal = installing ? 'machine_updating' : running && running.id !== queuedFrom ? 'busy' : 'unknown_words';
  ctx.terminals.refuse(agentId, reason);
  await appendEvent(ctx, { companyId: target.agent.companyId, agentId, kind: 'turn_refused', data: { reason } });
}

const resumesOperator = (ctx: Ctx, agent: { id: string; kind: string }, node: NodeIdentity): Promise<boolean> | false =>
  agent.kind !== 'assistant' && node.kind === 'node' && resumeOperatorProcess(ctx, agent.id, node.nodeId);

/* Someone who may type opened the window of an agent whose program does not run: a turn that types nothing starts it on
   the node, so they talk to it at once. A turn that waits or runs starts it anyway. */
export async function startProgram(ctx: Ctx, node: NodeIdentity, agentId: string): Promise<void> {
  if (!z.uuid().safeParse(agentId).success) return;
  const started = await onAgent(ctx, agentId, async () => {
    const { db } = ctx;
    const on = await agentOnNode(ctx, node, agentId);
    if (!on) return false;
    const { agent, sub } = on;
    if (await resumesOperator(ctx, agent, node)) return true;
    /* Task turns and the inbox's turn of an agent that is switched off wait for it to be on and start nothing. */
    const waiting = and(eq(jobs.status, 'queued'), limitUntil(sub.limits, sub.limitsUpdatedAt) ? programStart : agent.switchedOffAt ? peopleTurns : undefined);
    const [open] = await db.select(idOnly(jobs)).from(jobs).where(and(conversationOf(agentId), or(eq(jobs.status, 'running'), waiting))).limit(1);
    if (open) return false;
    await insertTurn(ctx, { companyId: agent.companyId, agentId, prompt: '', createdBy: null });
    return true;
  });
  /* Outside the agent's line, which the pump waits on. */
  if (started) await pump(ctx, agentId);
}

function keepsSessionAcrossTurns(kind: string): boolean {
  return kind === 'orchestrator' || kind === 'head' || kind === 'assistant';
}

type Agent = { id: string; companyId: string; departmentId: string | null; kind: string; name: string };
/* Where a turn runs: the plan and its node, or for an API key the machine of the built-in node. own: the machine this
   server runs on, which a turn of an API key from before machines' built-in nodes were told apart ran on. */
type On = { subscriptionId: string; nodeId: string | null; builtinMachine: string | null; own: string };
type Session = { sessionId: string | null; catchUp: string | null };
/* The original prompt goes along when the continuation cannot resume the session that holds it. */
type Continuation = { sessionId: string | null; originalPrompt: string | null };

/* Whether a session of that turn goes on here: on the same plan and node, an API key's on the same machine's built-in
   node, with the same instructions. */
const sameRun = (turn: { subscriptionId: string | null; nodeId: string | null; builtinMachine: string | null; instructionsHash: string | null }, on: On, instructionsHash: string): boolean =>
  turn.subscriptionId === on.subscriptionId && turn.nodeId === on.nodeId && (on.builtinMachine === null || (turn.builtinMachine ?? on.own) === on.builtinMachine) && turn.instructionsHash === instructionsHash;

/* The turn this one goes on from: its session, when it can go on there, on the same plan and node with the same
   instructions; otherwise what that turn was asked. */
async function continuedFrom(ctx: Ctx, jobId: string, on: On, instructionsHash: string): Promise<Continuation> {
  const [from] = await ctx.db.select({ subscriptionId: jobs.subscriptionId, nodeId: jobs.nodeId, builtinMachine: jobs.builtinMachine, sessionId: jobs.sessionId, instructionsHash: jobs.instructionsHash, prompt: jobs.prompt, requestedPrompt: jobs.requestedPrompt, continueOf: jobs.continueOf, retryOf: jobs.retryOf }).from(jobs).where(eq(jobs.id, jobId));
  if (!from) return { sessionId: null, originalPrompt: null };
  return { sessionId: sameRun(from, on, instructionsHash) ? from.sessionId : null, originalPrompt: await originalPromptOf(ctx, from) };
}

/* continueOf: a turn that goes on from one that ended without its work recorded goes on in that turn's session, or, when
   it cannot, takes what that turn was asked along into the session it gets. */
type SessionJob = Pick<typeof jobs.$inferSelect, 'id' | 'continueOf' | 'retryOf' | 'createdAt' | 'taskId'>;

async function sessionFor(ctx: Ctx, agent: Agent, on: On, instructionsHash: string, job: SessionJob): Promise<Session & Continuation> {
  /* A turn run once more after its node restarted carries its words itself, and goes on in the session the cut turn had. */
  const going = job.continueOf ?? job.retryOf;
  const from = going ? await continuedFrom(ctx, going, on, instructionsHash) : { sessionId: null, originalPrompt: null };
  if (from.sessionId) return { sessionId: from.sessionId, catchUp: null, originalPrompt: null };
  return { ...(await lastSession(ctx, agent, on, instructionsHash, job)), originalPrompt: job.continueOf ? from.originalPrompt : null };
}

async function queuedSession(ctx: Ctx, agent: Agent, on: On, instructionsHash: string, job: SessionJob, along: readonly Along[]) {
  const session = await sessionFor(ctx, agent, on, instructionsHash, job);
  const prompts = await Promise.all(along.map(j => promptAlong(ctx, j, on, instructionsHash)));
  return { ...session, prompts };
}

/* What a turn asks: a continuation that lost its session says again what the turn that ended was asked. */
const withOriginal = (asked: string, original: string | null) => (original && !asked.includes(original) ? `${asked}\n\nThe turn that ended was asked:\n\n${original}` : asked);

type SavedSession = Pick<typeof jobs.$inferSelect, 'subscriptionId' | 'nodeId' | 'builtinMachine' | 'sessionId' | 'instructionsHash' | 'startedAt' | 'finishedAt'>;

function companySessionStarts(agent: Agent, last: SavedSession | undefined, turn: { openedAt: Date } | undefined, job: SessionJob, startedAt: Date | null): boolean {
  if (!last || !turn || !startedAt) return false;
  if (followsRunningJob(last, job)) return false;
  return new Date(startedAt) < new Date(turn.openedAt) && !keepsSessionAcrossTurns(agent.kind);
}

function followsRunningJob(last: SavedSession, job: SessionJob): boolean {
  return job.taskId === null && last.finishedAt !== null && job.createdAt < last.finishedAt;
}

async function sessionStarted(ctx: Ctx, agentId: string, last: SavedSession | undefined): Promise<Date | null> {
  if (!last?.sessionId) return last?.startedAt ?? null;
  const [first] = await ctx.db.select({ at: sql<Date | null>`min(${jobs.startedAt})` }).from(jobs)
    .where(and(conversationOf(agentId), eq(jobs.sessionId, last.sessionId)));
  return first?.at ?? last.startedAt;
}

function matchingSession(last: SavedSession | undefined, on: On, instructionsHash: string): string | null {
  return last && sameRun(last, on, instructionsHash) ? last.sessionId : null;
}

/* A new session catches up from the conversation. The last finished turn's session goes on only on the same subscription
   and node with the same instructions: another machine does not have it, and changed instructions would not reach a
   session that already has the old ones. A turn that ran out of time or was stopped in its session finished too, the
   session whole; one that broke, or was called off before it ran, leaves the session before it. Members start each turn of
   their department in a clean session with no catch-up, after the words already waiting during their work. The orchestrator and
   department heads keep their session across turns and compact it when it fills. */
async function lastSession(ctx: Ctx, agent: Agent, on: On, instructionsHash: string, job: SessionJob): Promise<Session> {
  const repeated = await unheardSession(ctx, agent.id, job.id, on, instructionsHash);
  if (repeated) return { sessionId: repeated, catchUp: null };
  const [last] = await ctx.db
    .select({ subscriptionId: jobs.subscriptionId, nodeId: jobs.nodeId, builtinMachine: jobs.builtinMachine, sessionId: jobs.sessionId, instructionsHash: jobs.instructionsHash, startedAt: jobs.startedAt, finishedAt: jobs.finishedAt })
    .from(jobs)
    .where(and(conversationOf(agent.id), or(eq(jobs.status, 'done'), and(eq(jobs.status, 'failed'), inArray(jobs.error, ['timeout', 'cancelled']), isNotNull(jobs.sessionId)))))
    .orderBy(desc(jobs.finishedAt))
    .limit(1);
  if (await startsClean(ctx, agent, last, job)) return { sessionId: null, catchUp: null };
  const sessionId = matchingSession(last, on, instructionsHash);
  if (sessionId) return { sessionId, catchUp: null };
  return { sessionId: null, catchUp: await catchUpFor(ctx, agent) };
}

/* Whether the agent is a member whose last session started before the turn its department runs now. */
async function startsClean(ctx: Ctx, agent: Agent, last: SavedSession | undefined, job: SessionJob): Promise<boolean> {
  const turn = await openTurnOf(ctx.db, agent.companyId, agent.departmentId);
  return companySessionStarts(agent, last, turn ? { openedAt: turn.openedAt ?? turn.createdAt } : undefined, job, await sessionStarted(ctx, agent.id, last));
}

async function catchUpFor(ctx: Ctx, agent: Agent): Promise<string | null> {
  const talk = await earlierTalk(ctx.db, agent.id);
  return talk.length ? preface(talk, agent.kind === 'orchestrator' ? 'Orchestrator' : agent.name) : null;
}

/* The whole conversation an assistant's program sent with the message of this turn, for a new session. */
async function freshConversation(ctx: Ctx, jobId: string): Promise<string | null> {
  const [row] = await ctx.db.select({ fresh: sql<string | null>`${agentEvents.data}->>'_fresh'` }).from(agentEvents)
    .where(and(eq(agentEvents.jobId, jobId), eq(agentEvents.kind, 'message'), sql`${agentEvents.data} ? '_fresh'`)).orderBy(desc(agentEvents.seq)).limit(1);
  return row?.fresh ?? null;
}

/* Once the turn is out, its session holds what it read: the conversation is not kept with the message. */
async function forgetFresh(ctx: Ctx, jobId: string): Promise<void> {
  await ctx.db.update(agentEvents).set({ data: sql`${agentEvents.data} - '_fresh'` })
    .where(and(eq(agentEvents.jobId, jobId), eq(agentEvents.kind, 'message'), sql`${agentEvents.data} ? '_fresh'`));
}

/* Unheard words follow the original conversation without using its crash continuation. */
async function unheardSession(ctx: Ctx, agentId: string, jobId: string, on: On, instructionsHash: string): Promise<string | null> {
  const [event] = await ctx.db.select({ from: sql<string | null>`${agentEvents.data}->>'unheardFrom'` }).from(agentEvents)
    .where(and(eq(agentEvents.jobId, jobId), eq(agentEvents.kind, 'typed'))).limit(1);
  const from = z.uuid().safeParse(event?.from);
  if (!from.success) return null;
  const [original] = await ctx.db.select().from(jobs).where(and(eq(jobs.id, from.data), eq(jobs.agentId, agentId)));
  return matchingSession(original, on, instructionsHash);
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

export const takesTurns = (ctx: Ctx, n: NodeRow, need: number[] = CONVERSATION_NODE): boolean => n.status === 'ready' && !outdated(n.version, need) && ctx.hub.isReady(nodeIdentity(n.id));

/* moves: the agent has not been on this node until now, or leaves the machine it was on for the built-in node. */
/* builtinMachine: the machine of the built-in node, for an API key's turn. moves: the agent's program is not there yet. */
type Placement = { node: NodeIdentity; nodeId: string | null; builtinMachine: string | null; moves: boolean };

type PlacedAgent = { id: string; kind: AgentKind; nodeId: string | null; builtinMachine: string | null; roleKey: string | null };

/* The ones the company waits for while a node waits for an update: a limit holds their turns, see nodeHeldFrom. An
   assistant's own agent works for its owner alone, so it waits as a worker does. */
const isLeader = (agent: Pick<PlacedAgent, 'kind'>): boolean => agent.kind === 'orchestrator' || agent.kind === 'head';

/* Whether a node has room for the agent's turn, only asked: the agent is not put among the turns that wait for room. */
const lookRoom = (ctx: Ctx, agent: PlacedAgent) => (node: NodeIdentity) => roomFor(ctx, node, agent.id, isLeader(agent), true);

/* Where the agent's next turn goes. A company key's to a built-in node: the one its program is on while that is ready,
   else the server's own, else another machine's, which is a move as a plan's agent on another node is; it waits while
   the one picked waits for an update or has no room. A plan's to the node its program is on while
   that one is signed in, connected and new enough, so its folder, session and terminal go on there; otherwise to the
   freest of the plan's nodes that is, unless the agent has work in progress on its own and waits for it. None while no
   node can take it. A turn that would start a new program goes only to a machine with free memory for it, and an
   employee's turn goes to none that works past what it carries; roomy: whether a node has room, which the agent's state
   also asks as if every node had. */
async function placement(ctx: Ctx, agent: PlacedAgent, sub: { id: string; kind: 'personal' | 'api_key' }, need = CONVERSATION_NODE, roomy = (node: NodeIdentity) => roomFor(ctx, node, agent.id, isLeader(agent))): Promise<Placement | null> {
  if (sub.kind === 'api_key') {
    const machine = await pickBuiltin(ctx, ctx.db, agent.builtinMachine);
    if (!machine) return null;
    const node = builtinOf(machine);
    return !nodeHeldFrom(ctx, node, agent.roleKey, isLeader(agent)) && roomy(node) ? { node, nodeId: null, builtinMachine: machine, moves: agent.nodeId !== null || agent.builtinMachine !== machine } : null;
  }
  const all = await planNodes(ctx.db, [sub.id]);
  const able = all.filter(n => !nodeHeldFrom(ctx, nodeIdentity(n.id), agent.roleKey) && takesTurns(ctx, n, need) && roomy(nodeIdentity(n.id)));
  const pick = able.find(n => n.id === agent.nodeId) ?? (await waitsForOwnNode(ctx, agent, all) ? null : (await freest(ctx, able)) ?? (await heldNodeFor(ctx, agent, all, need, roomy)));
  return pick ? { node: nodeIdentity(pick.id), nodeId: pick.id, builtinMachine: null, moves: pick.id !== agent.nodeId } : null;
}

/* Whether the agent has work in progress on a node of its plan and waits for that one: not the orchestrator or a head whom
   an update kept off it past their limit, who go to another machine of the plan when one can take them. */
async function waitsForOwnNode(ctx: Ctx, agent: PlacedAgent, all: NodeRow[]): Promise<boolean> {
  if (!all.some(n => n.id === agent.nodeId)) return false;
  if (isLeader(agent) && nodeHeldLong(ctx, nodeIdentity(agent.nodeId!))) return false;
  return holdsWork(ctx, agent.id);
}

/* With no other machine, the node an update keeps the orchestrator's or a head's turn off past their limit: its own, if it
   is one of those. */
async function heldNodeFor(ctx: Ctx, agent: PlacedAgent, all: NodeRow[], need: number[], roomy: (node: NodeIdentity) => boolean): Promise<NodeRow | null> {
  if (!isLeader(agent)) return null;
  const open = all.filter(n => !nodeHeldFrom(ctx, nodeIdentity(n.id), agent.roleKey, true) && takesTurns(ctx, n, need) && roomy(nodeIdentity(n.id)));
  return open.find(n => n.id === agent.nodeId) ?? freest(ctx, open);
}

/* Whether the agent holds a task it works on, or stopped on to ask: its folder may hold work it has not pushed, so it
   waits for its own machine, and a laptop that sleeps a while does not scatter the team. */
async function holdsWork(ctx: Ctx, agentId: string): Promise<boolean> {
  const [held] = await ctx.db.select(idOnly(tasks)).from(tasks).where(and(eq(tasks.assigneeAgentId, agentId), inArray(tasks.status, ['working', 'blocked']))).limit(1);
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
const BACKLOG = 'These wake-ups on your task waited in line until your machine was connected again. Go through them together in this turn:';
/* What a task's turn that went out inside another one ended with: its own result is the other turn's. */
export const GONE_ALONG = 'Went out with the turn before it.';

/* The other task turns waiting for the agent that are due, oldest first; only narrows them down further. */
function alongWith(ctx: Ctx, agentId: string, jobId: string, only?: SQL) {
  return ctx.db
    .select({ id: jobs.id, prompt: jobs.prompt, taskId: jobs.taskId, continueOf: jobs.continueOf })
    .from(jobs)
    .where(and(conversationOf(agentId), eq(jobs.status, 'queued'), or(isNull(jobs.notBefore), lte(jobs.notBefore, new Date(Date.now()))), isNotNull(jobs.taskId), ne(jobs.id, jobId), only))
    .orderBy(asc(jobs.createdAt));
}

/* What goes out inside a task's turn. A head reads everything that moved on its tasks while it was busy in one turn, instead
   of one turn per task. Anyone else takes in one turn what waits on the same task when this turn waited until the node it
   goes to came back: what a machine that was away kept would otherwise go out turn after turn, each out of date. */
async function goingAlong(ctx: Ctx, agent: { id: string; kind: string }, job: Pick<typeof jobs.$inferSelect, 'id' | 'taskId' | 'createdAt'>, nodeId: string | null): Promise<Along[]> {
  if (!job.taskId) return [];
  if (agent.kind === 'head') return alongWith(ctx, agent.id, job.id);
  return (await cameBack(ctx.db, nodeId, job.createdAt)) ? alongWith(ctx, agent.id, job.id, eq(jobs.taskId, job.taskId)) : [];
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
  return (await discardStaleTurn(ctx.db, job)) || (await waitsForTasks(ctx, job));
}

async function waitsForTasks(ctx: Ctx, job: { id: string; agentId: string | null; taskId: string | null }): Promise<boolean> {
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
type Along = Pick<typeof jobs.$inferSelect, 'id' | 'prompt' | 'taskId' | 'continueOf'>;
type Queued = Pick<typeof jobs.$inferSelect, 'id' | 'companyId' | 'agentId' | 'taskId' | 'prompt'>;
/* What a turn goes out with: where it runs and what it says. */
type Sending = Pick<typeof jobs.$inferInsert, 'subscriptionId' | 'nodeId' | 'builtinMachine' | 'prompt' | 'sessionId' | 'toolTokenHash' | 'instructionsHash'>;

/* A continuation carried inside another task's turn takes its original work along too. */
async function promptAlong(ctx: Ctx, job: Along, on: On, instructionsHash: string): Promise<string> {
  const from = job.continueOf ? await continuedFrom(ctx, job.continueOf, on, instructionsHash) : null;
  return withOriginal(job.prompt, from?.originalPrompt ?? null);
}

/* Takes the waiting turn to send it, running from now on. In the same write each line of the map its work keeps on, with
   the tasks that go out along with it, begins a new cycle: a server that stops once the turn went out never brings the
   line's old return back, and a turn whose cycle cannot be kept is not taken. The lines when one began a cycle. */
async function take(ctx: Ctx, job: Queued, along: readonly Along[], sending: Sending): Promise<{ lines: { companyId: string } | null } | typeof HELD | null> {
  return ctx.db.transaction(tx => takeCurrent(tx, ctx.config, job, along, sending));
}

/* The turn's machine installs its build now: the turn is not taken and waits, and goes out when the machine is done. */
const HELD = 'held';

async function takeCurrent(tx: Tx, own: { machineId: string | null }, job: Queued, along: readonly Along[], sending: Sending): Promise<{ lines: { companyId: string } | null } | typeof HELD | null> {
  if (await discardStaleTurns(tx, [job, ...along.map(j => ({ ...j, agentId: job.agentId }))])) return null;
  if ((await holdsMachine(tx, sending.nodeId)) || (await holdsBuiltin(tx, own, sending.builtinMachine))) return HELD;
  const [row] = await tx
    .update(jobs)
    .set({ ...sending, requestedPrompt: job.prompt, status: 'running', startedAt: new Date() })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, 'queued')))
    .returning({ id: jobs.id });
  return row ? { lines: await workStarts(tx, { id: job.id, companyId: job.companyId, agentId: job.agentId, taskIds: [job.taskId, ...along.map(a => a.taskId)] }) } : null;
}

/* A turn with words of its own is taken: an Enter that waited to open a turn of its own is settled with it. Not waited for,
   as what holds the agent's input lock may wait for its line. */
function wentOutWithWords(ctx: Ctx, agentId: string, job: Queued & { prompt: string }): void {
  if (!job.prompt && !job.taskId) return;
  ctx.terminals.turnBegan(agentId);
  void turnStarted(ctx, agentId, job.id).catch(err => ctx.log.error({ error: loggable(err) }, 'An Enter that waited could not be settled.'));
}

/* The turn went out: its task and those that went along with it are at work, and the map reads its lines again once the
   turn carries them all. */
async function wentOut(ctx: Ctx, job: Queued, along: readonly Along[], lines: { companyId: string } | null): Promise<void> {
  if (job.taskId) await startWork(ctx, job.id);
  for (const j of along) await goneAlong(ctx, j.id);
  if (lines) ctx.bus.publish(lines.companyId, { type: 'org' });
}

/* A delayed retry holds the whole line, including personal messages while task turns are held back. */
async function waitsForRetry(ctx: Ctx, agentId: string): Promise<boolean> {
  const [retry] = await ctx.db.select({ at: jobs.notBefore }).from(jobs)
    .where(and(conversationOf(agentId), eq(jobs.status, 'queued'), isNotNull(jobs.notBefore), sql`not exists (select 1 from agent_events e where e.job_id = ${jobs.id} and e.data->>'report' is not null)`)).orderBy(asc(jobs.createdAt)).limit(1);
  if (!retry?.at || +retry.at <= Date.now()) return false;
  pumpAt(ctx, agentId, retry.at.toISOString(), 0);
  return true;
}

type PlanAgent = { id: string; kind: string };
type Plan = { limits: Limits | null; limitsUpdatedAt: Date | null; budget: number | null };
export type HeldPlanTurn = PlanHold & { job: typeof jobs.$inferSelect };

const workerBudgetUntil = (agent: { kind: string }, sub: Plan): string | null => agent.kind === 'worker' ? budgetUntil(sub.limits, sub.budget, sub.limitsUpdatedAt) : null;

/* The oldest turn the plan really holds. Heads and the orchestrator keep coordinating work above the task share. */
export async function planHeld(ctx: Ctx, agent: PlanAgent, sub: Plan | null | undefined): Promise<HeldPlanTurn | null> {
  if (!sub) return null;
  const until = limitUntil(sub.limits, sub.limitsUpdatedAt);
  const spent = workerBudgetUntil(agent, sub);
  const reason = until ? 'limit' : spent ? 'budget' : null;
  if (!reason) return null;
  const held = reason === 'limit' ? or(isNotNull(jobs.taskId), isNotNull(jobs.createdBy), ne(jobs.prompt, '')) : isNotNull(jobs.taskId);
  const [job] = await ctx.db.select().from(jobs).where(and(conversationOf(agent.id), eq(jobs.status, 'queued'), held)).orderBy(asc(jobs.createdAt)).limit(1);
  return job ? { reason, since: job.createdAt.toISOString(), until: until ?? spent!, job } : null;
}

export const planHoldView = (held: HeldPlanTurn | null): PlanHold | null => held && { reason: held.reason, since: held.since, until: held.until };

const HELD_NOTICE_MS = 10 * 60_000;

function heldNotice(agent: { name: string }, held: HeldPlanTurn): string {
  const why = held.reason === 'limit' ? "its plan's usage limit" : 'the share set for tasks';
  return `Hornhoof: ${agent.name}'s turn ${held.job.id} has waited for ${why} since ${held.since}. It waits until ${held.until}. Check the plan and give the work to another employee if one can take it.`;
}

/* A provider gives the same reset with other milliseconds each time it is asked: the hold is the same one to the minute. */
const holdMinute = (until: string) => {
  const at = Date.parse(until);
  return Number.isNaN(at) ? until : new Date(Math.round(at / 60_000) * 60_000).toISOString();
};

async function tellOperationsOfHold(ctx: Ctx, agent: PlanAgent & { name: string }, sub: Plan): Promise<void> {
  const held = await planHeld(ctx, agent, sub);
  if (!held || Date.now() - Date.parse(held.since) <= HELD_NOTICE_MS) return;
  await notifyFailure(ctx, held.job, heldNotice(agent, held), `plan-hold:${agent.id}:${holdMinute(held.until)}`);
}

/* Switched off, it still answers people who write to it; its task turns and the turn that takes its inbox wait until it is
   on. Past the share set for tasks only task turns wait. */
function turnsThatMayGo(agent: PlanAgent & { switchedOffAt: Date | null }, until: string | null, spent: string | null) {
  return and(conversationOf(agent.id), eq(jobs.status, 'queued'), until ? programStart : undefined, agent.switchedOffAt ? peopleTurns : spent ? isNull(jobs.taskId) : undefined);
}

/* The turn that may go out now, if any, with the line woken for what comes next: the plan's limit or share starting over,
   or a turn that may go by then and waits for its time. A turn that is due and may not go sets no wake, which would only
   send the line round again at once. */
async function dueTurn(ctx: Ctx, agent: PlanAgent & { name: string; switchedOffAt: Date | null }, sub: Plan) {
  /* Real turns wait for the limit; an empty start can still open the saved program. Past the share set for tasks only
     workers' task turns wait. */
  const until = limitUntil(sub.limits, sub.limitsUpdatedAt);
  const spent = workerBudgetUntil(agent, sub);
  const reset = until ?? spent;
  if (reset) pumpAt(ctx, agent.id, reset);
  await tellOperationsOfHold(ctx, agent, sub);
  const mayGo = turnsThatMayGo(agent, until, spent);
  const now = new Date(Date.now());
  const [job] = await ctx.db.select().from(jobs).where(and(mayGo, or(isNull(jobs.notBefore), lte(jobs.notBefore, now)))).orderBy(desc(sql`${jobs.notBefore} is not null`), asc(jobs.inboxWake), asc(jobs.createdAt)).limit(1);
  if (job) return job;
  const [later] = await ctx.db.select({ at: jobs.notBefore }).from(jobs).where(and(mayGo, gt(jobs.notBefore, now))).orderBy(asc(jobs.notBefore)).limit(1);
  /* The earlier wake stands; the one at the reset is set again when the earlier one comes. */
  if (later?.at && (!reset || +later.at < Date.parse(reset))) pumpAt(ctx, agent.id, later.at.toISOString(), 0);
  return null;
}

const heldByOperator = (ctx: Ctx, agent: { id: string; kind: string }): Promise<boolean> | false =>
  agent.kind !== 'assistant' && operatorRecoveryHolds(ctx, agent.id);

async function turnOperatorDeliveries(
  ctx: Ctx,
  agent: { id: string; kind: string },
  job: { id: string; companyId: string },
  node: NodeIdentity,
  prompt: string,
): Promise<{ operatorDelivery?: OperatorDelivery; operatorSourceDelivery?: OperatorDelivery }> {
  if (agent.kind === 'assistant') return {};
  const operatorDelivery =
    prompt && node.kind === 'node' && ctx.hub.hasProgramOperator(node)
      ? await reserveDelivery(ctx.db, {
          companyId: job.companyId,
          agentId: agent.id,
          jobId: job.id,
          nodeId: node.nodeId,
          kind: 'assignment',
          words: prompt,
          reference: `job:${job.id}`,
          sourceDeliveryId: await sourceDeliveryForJob(ctx.db, agent.id, job.id),
        })
      : undefined;
  return { operatorDelivery, operatorSourceDelivery: await sourceDeliveryMetadataForJob(ctx.db, agent.id, job.id) };
}

async function sendNext(ctx: Ctx, agentId: string): Promise<void> {
  const { db } = ctx;
  const [running] = await db.select(idOnly(jobs)).from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'running'))).limit(1);
  if (running || await waitsForWords(ctx, agentId)) return;
  /* Between turns: onto a fallback plan while its own holds its turns back, and home again once it does not. What follows
     reads the plan it is on after that. */
  await fallbackMove(ctx, agentId);
  const sub = await liveSubscription(ctx, agentId);
  if (!sub || sub.status !== 'ready') return;
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent || !(await placement(ctx, agent, sub))) return;
  if (await heldByOperator(ctx, agent)) return;
  /* An update waits for the turns that run: new ones start after it, the orchestrator's go on. */
  if (agent.kind !== 'orchestrator' && turnsHeld(ctx, agent.companyId)) return;
  if (await waitsForRetry(ctx, agentId)) return;
  const due = await dueTurn(ctx, agent, sub);
  if (!due) return (await inboxTurnDue(ctx, agent)) ? sendNext(ctx, agentId) : undefined;
  if (await heldBack(ctx, due)) return sendNext(ctx, agentId);
  /* The turn that takes the inbox asks what is unread in it when it goes, or goes nowhere when nothing is. */
  const mail = due.inboxWake ? await unreadMail(db, agentId) : [];
  if (due.inboxWake && !mail.length) {
    await db.update(jobs).set({ status: 'done', result: NOTHING_UNREAD, finishedAt: new Date() }).where(and(eq(jobs.id, due.id), eq(jobs.status, 'queued')));
    return sendNext(ctx, agentId);
  }
  const job = due.inboxWake ? { ...due, prompt: mailSummary(mail) } : due;
  const at = await repoAt(ctx, await turnPlaces(db, agent, job.taskId));
  const repo = at?.repo ?? null;
  const place = await placement(ctx, agent, sub, repo ? REPOSITORY_NODE : CONVERSATION_NODE);
  if (!place) return;
  /* A machine that installs its build takes no turn now; the turn waits and goes out by itself when the machine is done.
     Asked here, before the turn's words are put together, and once more when the turn is taken. Nor does the machine
     next to install, so the turns that run there end and it has its turn: the orchestrator's and the heads' wait up to
     their limit. */
  if (await machineInstalls(db, place.nodeId)) return;
  if (await nextToInstallHolds(ctx, place.nodeId, isLeader(agent))) return;
  const along: Along[] = [];
  for (const j of await goingAlong(ctx, agent, job, place.nodeId)) if (!(await heldBack(ctx, { ...j, agentId }))) along.push(j);

  /* A node from before skill files gets every skill in the instructions. */
  const files = ctx.hub.takesSkillFiles(place.node);
  const instructions = await instructionsOf(ctx, agent, files);
  const refused = unsendable(agent.name, instructions.text.length, files);
  if (refused) return unsent(ctx, job, refused);
  /* The program's flag only for a model this subscription can run; anything else runs on its Default. */
  const models = modelsFor(sub.provider, sub.models);
  const model = agent.model && models.some(m => m.id === agent.model) ? agent.model : null;
  /* How hard it thinks goes on in the same session; the program starts again at the new level. */
  const effort = effortOfTurn(ctx, agent, effortsOf(models, model));
  /* The hash covers the model too, so a new model starts a fresh session like new instructions do. */
  const runHash = model ? textHash(`${instructions.hash}:${model}`) : instructions.hash;
  const on = { subscriptionId: sub.id, nodeId: place.nodeId, builtinMachine: place.builtinMachine, own: ownMachine(ctx.config) };
  const { sessionId, catchUp, originalPrompt, prompts } = await queuedSession(ctx, agent, on, runHash, job, along);
  const asked = along.length ? [agent.kind === 'head' ? ALONG : BACKLOG, job.prompt, ...prompts].join('\n\n---\n\n') : job.prompt;
  const said = withOriginal(asked, originalPrompt);
  /* A turn that types nothing only starts the program, for a person to talk to it: what was said before goes with its
     instructions instead. Where the agent works it reads with its briefing tool, so no message carries it. */
  const composed = catchUp ? `${catchUp}\n\n${said}` : said;
  /* An assistant's own agent reads its program's message as the program built it: its rules say who it is from. A new
     session reads the program's whole conversation, when the program sent it, in place of the new words and the catch-up.
     A session that goes on may have begun anew on its machine, which only the node sees: the conversation goes beside the
     words, for the node to type in their place then. */
  const fresh = agent.kind === 'assistant' && job.prompt ? await freshConversation(ctx, job.id) : null;
  const prompt = !job.prompt ? '' : job.inboxWake ? composed : agent.kind === 'assistant' ? (sessionId === null ? fresh : null) ?? composed : addressed(composed, await messageForJob(ctx, { id: job.id, companyId: job.companyId, agentId, retryOf: job.retryOf, continueOf: job.continueOf }));
  const token = newToken();
  /* Running from the moment it is sent: the token works for its tools at once, and the next turn waits. */
  /* The machine of the built-in node it goes to is written with it, so that node alone may answer for it. */
  const taken = await take(ctx, job, along, { subscriptionId: sub.id, nodeId: place.nodeId, builtinMachine: place.builtinMachine, prompt, sessionId, toolTokenHash: hashToken(token), instructionsHash: runHash });
  if (taken === HELD) return;
  if (!taken) return sendNext(ctx, agentId);
  await claimMail(db, agentId, mail, job);
  wentOutWithWords(ctx, agentId, job);
  /* The agent stays on this machine from now on. */
  if (place.moves) await db.update(agents).set({ nodeId: place.nodeId, builtinMachine: place.builtinMachine }).where(eq(agents.id, agentId));
  let sent = false;
  let deliveries: { operatorDelivery?: OperatorDelivery; operatorSourceDelivery?: OperatorDelivery } = {};
  try {
    deliveries = await turnOperatorDeliveries(ctx, agent, job, place.node, prompt);
    await publishWorking(ctx, job.companyId);
    sent = await dispatchJob(ctx, {
      id: job.id,
      subscriptionId: sub.id,
      nodeId: place.nodeId,
      builtinMachine: place.builtinMachine,
      role: agent.roleKey,
      leader: isLeader(agent),
      prompt,
      freshPrompt: sessionId === null ? null : fresh,
      sessionId,
      model,
      effort,
      compactWindow: agent.kind === 'worker' ? WORKER_COMPACT_WINDOW : FULL_COMPACT_WINDOW,
      timeoutMs: job.timeoutMs,
      instructions: instructions.text,
      toolToken: token,
      ...deliveries,
      context: job.prompt ? null : catchUp,
      /* Each agent keeps one folder on the node, with its repository's clone inside, which gets the dependencies the
         company's machines built for its commit. */
      workspace: { key: agent.id, repo, ...(at ? { repositoryScope: repositoryScope(at.department.companyId, at.department.id, at.repo.url) } : {}) },
      ...(files ? { skills: instructions.skills } : {}),
    });
  } catch (err) {
    /* A turn that broke on its way out was not sent: it waits for the next try instead of running forever. */
    ctx.log.error({ error: loggable(err) }, 'A turn could not go out and waits for the next try.');
  }
  if (sent) {
    turnSent(ctx, place.node, agentId);
    const read = await mailWentOut(db, agentId, [job.id, ...along.map(j => j.id)]);
    if (job.inboxWake) await mailShown(db, agentId, mail.map(m => m.id), job.id);
    if (read || mail.length) await inboxChanged(ctx, agentId);
    if (agent.kind === 'assistant') await forgetFresh(ctx, job.id);
    return wentOut(ctx, job, along, taken.lines);
  }
  if (deliveries.operatorDelivery) await cancelUnsentDelivery(db, deliveries.operatorDelivery);
  await db.update(jobs).set({ status: 'queued', startedAt: null, nodeId: null, prompt: job.prompt, sessionId: job.sessionId, toolTokenHash: null, instructionsHash: null }).where(and(eq(jobs.id, job.id), eq(jobs.status, 'running')));
  await publishWorking(ctx, job.companyId);
}

/* Sends the agent's oldest waiting turn when none runs and his subscription is online and signed in. */
export function pump(ctx: Ctx, agentId: string): Promise<void> {
  return onAgent(ctx, agentId, () => sendNext(ctx, agentId));
}

/* Every agent with turns waiting, after a machine came back or a subscription changed. */
export async function pumpWaiting(ctx: Ctx): Promise<void> {
  const waiting = await ctx.db.selectDistinct(only(jobs, 'agentId')).from(jobs).where(and(eq(jobs.kind, 'conversation'), eq(jobs.status, 'queued')));
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
  if (!agent) return { ready: false, machineDrain: null, memoryWait: false, limitUntil: null, budgetUntil: null, held: null, reason: 'no_subscription', browserError: null, busy: false, runningJobId: null, queued: 0, terminal: false, turnRefused: null, program: null, alarm: null, retry: null, failure: null, obsolete: null };
  return agentState(ctx, agent.id);
}

/* A node that waits or restarts for an update is not away: it comes back by itself, and its turns wait in line for it. */
const notAway = (ctx: Ctx, node: NodeIdentity): boolean => ctx.hub.isReady(node) || nodeHeld(ctx, node);

/* A node is getting back on the line until it says hello: while its socket is open, or closed while its machine is not
   off for as long as a card of it takes. The machine of a built-in node has no card, so one whose socket is closed is away. */
async function comingBack(ctx: Ctx, node: NodeIdentity, machineId?: string): Promise<boolean> {
  if (ctx.hub.isReady(node)) return false;
  return ctx.hub.isOnline(node) || (machineId !== undefined && !(await shownAway(ctx, machineId)));
}

/* Whether the machine an agent's turns wait for is only getting back on the line: they wait in line for it, and go out
   once it says hello. One with work in progress waits for its own machine alone, as its turns do. */
export async function reconnecting(ctx: Ctx, agentId: string): Promise<boolean> {
  const sub = await liveSubscription(ctx, agentId);
  if (!sub) return false;
  if (sub.kind === 'api_key') return comingBack(ctx, ownBuiltin(ctx.config));
  const [agent] = await ctx.db.select(only(agents, 'nodeId')).from(agents).where(eq(agents.id, agentId));
  const all = (await planNodes(ctx.db, [sub.id])).filter(n => n.status === 'ready');
  const own = all.find(n => n.id === agent?.nodeId);
  const waited = own && (await holdsWork(ctx, agentId)) ? [own] : all;
  return (await Promise.all(waited.map(n => comingBack(ctx, nodeIdentity(n.id), n.machineId)))).some(Boolean);
}

/* Why the agent's turns cannot go out now, or null when they can: a plan's go out while one of its machines can take them,
   and otherwise wait for what its own machine waits for, or one of the plan's that is online, or its first. One with work
   in progress waits for its own machine alone. */
async function waitsFor(ctx: Ctx, agent: { id: string; productId: string | null; departmentId: string | null; nodeId: string | null }, sub: { id: string; kind: 'personal' | 'api_key' }): Promise<AgentState['reason']> {
  if (sub.kind === 'api_key') return ctx.hub.builtins().length > 0 || notAway(ctx, ownBuiltin(ctx.config)) ? null : 'machine_offline';
  const all = await planNodes(ctx.db, [sub.id]);
  if (!all.length) return 'waiting_machine';
  const need = all.some(n => outdated(n.version, REPOSITORY_NODE)) && (await repoFor(ctx, agent)) ? REPOSITORY_NODE : CONVERSATION_NODE;
  const why = (n: NodeRow): AgentState['reason'] => (n.status !== 'ready' ? n.status : outdated(n.version, need) ? 'node_outdated' : notAway(ctx, nodeIdentity(n.id)) ? null : 'machine_offline');
  const own = all.find(n => n.id === agent.nodeId);
  if (own && why(own) !== null && (await holdsWork(ctx, agent.id))) return why(own);
  if (all.some(n => why(n) === null)) return null;
  return why(own ?? all.find(n => ctx.hub.isOnline(nodeIdentity(n.id))) ?? all[0]!);
}

/* The same for a plan the agent is not on yet, which a fallback asks of the plan it would go to. */
export const planWaitsFor = waitsFor;

/* The update its next turn waits for: of its own machine or, with that one away, of the one its plan has left. */
async function drainInTheWay(ctx: Ctx, agent: { nodeId: string | null } | undefined, sub: { id: string; kind: 'personal' | 'api_key' } | null, shown: NodeIdentity | null): Promise<MachineDrain | null> {
  if (!agent || !sub) return null;
  if (sub.kind === 'api_key') return nodeDrain(ctx, ownBuiltin(ctx.config));
  const plan = (await planNodes(ctx.db, [sub.id])).map(n => nodeIdentity(n.id));
  const own = agent.nodeId ? [nodeIdentity(agent.nodeId)] : [];
  return [...(shown ? [shown] : []), ...own, ...plan].map(node => nodeDrain(ctx, node)).find(Boolean) ?? null;
}

/* What its plan holds back now. */
const planHolds = (sub: Awaited<ReturnType<typeof liveSubscription>>, kind: string) => ({
  limitUntil: sub ? limitUntil(sub.limits, sub.limitsUpdatedAt) : null,
  budgetUntil: sub ? workerBudgetUntil({ kind }, sub) : null,
});

async function planState(ctx: Ctx, agent: PlanAgent | undefined, sub: Awaited<ReturnType<typeof liveSubscription>>): Promise<Pick<AgentState, 'limitUntil' | 'budgetUntil' | 'held'>> {
  return {
    ...planHolds(sub, agent?.kind ?? 'worker'),
    held: agent ? planHoldView(await planHeld(ctx, agent, sub)) : null,
  };
}

/* The terminal the window opens is of the machine the program is on, or for one not on a machine yet, of the machine its
   next turn would go to, where the window starts it. */
const shownNode = async (ctx: Ctx, agentId: string, place: Placement | null): Promise<NodeIdentity | null> => (await programNode(ctx, agentId))?.node ?? place?.node ?? null;

/* Whether the agent can answer now and, if not, why; what it is doing and how many turns wait. */
export async function agentState(ctx: Ctx, agentId: string): Promise<AgentState> {
  const [running] = await ctx.db.select(idOnly(jobs)).from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'running'))).limit(1);
  const [waiting] = await ctx.db.select(countOnly()).from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'queued')));
  const sub = await liveSubscription(ctx, agentId);
  const [agent] = sub ? await ctx.db.select({ id: agents.id, kind: agents.kind, productId: agents.productId, departmentId: agents.departmentId, nodeId: agents.nodeId, builtinMachine: agents.builtinMachine, roleKey: agents.roleKey }).from(agents).where(eq(agents.id, agentId)) : [];
  const reason: AgentState['reason'] = !sub || !agent ? 'no_subscription' : await waitsFor(ctx, agent, sub);
  const place = sub && agent ? await placement(ctx, agent, sub, CONVERSATION_NODE, lookRoom(ctx, agent)) : null;
  const shown = await shownNode(ctx, agentId, place);
  const terminal = Boolean(shown && ctx.hub.hasTerminals(shown));
  const browserError = shown ? ctx.hub.browserErrorOf(shown) : null;
  return {
    ready: reason === null,
    machineDrain: place || reason !== null ? null : await drainInTheWay(ctx, agent, sub, shown),
    memoryWait: !running && !place && reason === null && Boolean(sub && agent && (await placement(ctx, agent, sub, CONVERSATION_NODE, () => true))),
    ...await planState(ctx, agent, sub),
    reason,
    browserError,
    busy: Boolean(running),
    runningJobId: running?.id ?? null,
    queued: Number(waiting?.n ?? 0),
    terminal,
    turnRefused: ctx.terminals.refusal(agentId),
    ...agentProgramState(ctx, running),
    ...await agentFailureState(ctx, agentId),
  };
}

function forgetStartupValues(ctx: Ctx, started: readonly { id: string }[]): void {
  for (const job of started) forgetPrivateTurn(ctx.db, job.id);
}
