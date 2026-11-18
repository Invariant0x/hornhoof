import { sendNext } from './dispatch.js';
import { workerBudgetUntil, planHeld, type PlanAgent, type Plan, type HeldPlanTurn } from './state.js';
import { type Turn, type TurnMessage, type Along, type Queued, type Sending } from './turn-types.js';
import { runsNow, NoSubscription } from './turn-records.js';
import { limitUntil, resets } from './limits.js';
import { holdsWork, agentOnNode, liveSubscription, nodeOfAgent, conversationOf, type AgentTarget } from './placement.js';
import { onAgent } from './line.js';
import { TURN_TIMEOUT_MS, INBOX_PROMPT, GONE_ALONG } from './constants.js';
import { hideCredentialsIn } from '@hornhoof/protocol/redaction';
import { idOnly, only } from '../../db/selections.js';
import { combineReport, reportDelay } from './report-notices.js';
import { isProgramOwnPrompt, UNHEARD_MS } from '@hornhoof/protocol';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { forgetPrivateTurn } from '../tools/private-turns.js';
import { loggable } from '../../errors.js';
import { hashToken, newToken } from '../../crypto/tokens.js';
import { agents, jobs, tasks } from '../../db/schema.js';
import type { TurnRefusal } from '../terminals/relay.js';
import { actingCeo, alsoKept, deliverLockedInput, inputKept, turnStarted, typedWentIn, withInputLock } from './decision-context.js';
import { nodeIdentity, ownBuiltin, sameNode, type NodeIdentity } from '../nodes/hub.js';
import { planNodes } from '../nodes/nodes.js';
import { holdsBuiltin, holdsMachine, machineInstalls } from '../network/follow.js';
import { shownAway } from '../nodes/machine-away.js';
import { jobsOf } from '../nodes/jobs.js';
import { appendEvent, publishWorking, type WithEvent } from '../events/store.js';
import { openAfter, type Tx } from '../tasks/state.js';
import { startWork } from '../tasks/progress.js';
import { discardStaleTurn, discardStaleTurns } from '../tasks/wake-state.js';
import { workStarts } from '../org/map-state.js';
import { logTurnFact } from '../tasks/turn-log.js';
import { queuedInput, queuedUsed } from './queued-input.js';
import { repeatedTurn, UNHEARD_NOTE, type RepeatedTurn } from './turn-words.js';
import { liveInputOf } from '../program-operator/input.js';
import { queuedOperatorAssignment } from '../program-operator/recovered-input.js';
import { inboxChanged, inboxModeOf, isMail, keepMail, takesInsteadOfTurn, unreadMail, type InboxStatus } from './inbox.js';
/* How long after a plan's limit starts over its waiting turns go out, so the program sees the new limit. */
const LIMIT_GRACE_MS = 5_000;
const LONGEST_TIMER_MS = 2 ** 31 - 1;
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
/* Only a node's empty start opens the program while the plan's real turns wait. */
const programStart = and(eq(jobs.prompt, ''), isNull(jobs.taskId), isNull(jobs.createdBy));

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

/* The one waiting turn of the agent that takes its inbox, made for the first letter that has none to wait for. */
async function inboxTurn(ctx: Ctx, t: Pick<Turn, 'companyId' | 'agentId'>): Promise<string> {
  return ctx.db.transaction(async tx => {
    /* Removal holds the same employee row, so no inbox turn can appear after its waiting turns were ended. */
    const [agent] = await tx.select(idOnly(agents)).from(agents).where(and(eq(agents.id, t.agentId), eq(agents.companyId, t.companyId), isNull(agents.removedAt))).for('no key update');
    if (!agent) throw new NoSubscription();
    const [open] = await tx.select(idOnly(jobs)).from(jobs).where(and(conversationOf(t.agentId), eq(jobs.status, 'queued'), eq(jobs.inboxWake, true))).limit(1);
    if (open) return open.id;
    const sub = await liveSubscription({ db: tx }, t.agentId);
    if (!sub) throw new NoSubscription();
    const [job] = await tx.insert(jobs).values({ companyId: t.companyId, subscriptionId: sub.id, agentId: t.agentId, kind: 'conversation', prompt: INBOX_PROMPT, inboxWake: true, timeoutMs: TURN_TIMEOUT_MS, createdBy: null }).returning({ id: jobs.id });
    return job!.id;
  });
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
  agent.kind !== 'assistant' && node.kind === 'node' && ctx.conversationEffects.resumeProgram(ctx, agent.id, node.nodeId);

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

const ALONG = 'Several things waited for you in line and go out together in this turn. Go through each of them:';

/* The agent's other waiting turns that are due, of those which, oldest first. */
function alongWith(ctx: Ctx, agentId: string, jobId: string, which: SQL | undefined) {
  return ctx.db
    .select({ id: jobs.id, prompt: jobs.prompt, taskId: jobs.taskId, continueOf: jobs.continueOf, inboxWake: jobs.inboxWake })
    .from(jobs)
    .where(and(conversationOf(agentId), eq(jobs.status, 'queued'), or(isNull(jobs.notBefore), lte(jobs.notBefore, new Date(Date.now()))), ne(jobs.id, jobId), which))
    .orderBy(asc(jobs.createdAt));
}

/* A turn that only brings the agent words: what an employee or Hornhoof wrote, or the turn that takes its inbox. Not a
   person's own turn or one that answers the CEO, whose answer goes to them, nor one that goes on from another turn or says
   again words its program did not hear, which go on in a session of their own. */
const onlyWords = and(isNull(jobs.createdBy), eq(jobs.answersCeo, false), isNull(jobs.continueOf), isNull(jobs.retryOf), ne(jobs.prompt, ''), sql`not exists (select 1 from agent_events e where e.job_id = ${jobs.id} and e.kind = 'typed')`);

/* What goes out inside a turn. A turn that only brings words takes every other one that does, on no task or on its own
   task: the agent reads them all at once, instead of one turn each while newer ones go first. A head also reads
   everything that moved on its tasks while it was busy. An assistant's program builds its own message, and a switched-off
   agent's inbox waits until it is on. */
async function goingAlong(ctx: Ctx, agent: { id: string; kind: string; switchedOffAt: Date | null }, job: Pick<typeof jobs.$inferSelect, 'id' | 'taskId'>): Promise<Along[]> {
  const tasks = job.taskId && agent.kind === 'head' ? isNotNull(jobs.taskId) : undefined;
  const [words] = agent.kind === 'assistant' ? [] : await ctx.db.select(idOnly(jobs)).from(jobs).where(and(eq(jobs.id, job.id), onlyWords));
  const others = words
    ? and(onlyWords, job.taskId ? or(isNull(jobs.taskId), eq(jobs.taskId, job.taskId)) : isNull(jobs.taskId), agent.switchedOffAt ? peopleTurns : undefined)
    : undefined;
  return tasks || others ? alongWith(ctx, agent.id, job.id, or(tasks, others)) : [];
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
  await ctx.conversationEffects.notifyHold(ctx, held.job, heldNotice(agent, held), `plan-hold:${agent.id}:${holdMinute(held.until)}`);
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

/* Sends the agent's oldest waiting turn when none runs and his subscription is online and signed in. */
export function pump(ctx: Ctx, agentId: string): Promise<void> {
  return onAgent(ctx, agentId, () => sendNext(ctx, agentId, dispatchQueue));
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

function forgetStartupValues(ctx: Ctx, started: readonly { id: string }[]): void {
  for (const job of started) forgetPrivateTurn(ctx.db, job.id);
}
export { WORKER_COMPACT_WINDOW, FULL_COMPACT_WINDOW, TURN_TIMEOUT_MS, STOPPED_ON_PURPOSE, INBOX_PROMPT, NOTHING_UNREAD, GONE_ALONG } from './constants.js';
export { onAgent } from './line.js';
export { takesTurns, agentOnNode, liveSubscription, nodeOfAgent, programNode, programPlan, conversationOf, goesElsewhere, windowNode } from './placement.js';
export type { ProgramNode } from './placement.js';
export { limitUntil, budgetUntil, refusedLimits } from './limits.js';
export { turnGoingOn, NoSubscription, orchestratorOf } from './turn-records.js';
export type { TurnMessage } from './turn-types.js';
export { agentState, planHoldView, planHeld, planWaitsFor, orchestratorState } from './state.js';
export type { PlanHold, AgentState, HeldPlanTurn } from './state.js';





/* Dispatch consumes the queue owner's ordering and claim operations through this port. */
export type DispatchQueue = {
  waitsForWords: typeof waitsForWords;
  waitsForRetry: typeof waitsForRetry;
  dueTurn: typeof dueTurn;
  inboxTurnDue: typeof inboxTurnDue;
  heldBack: typeof heldBack;
  goingAlong: typeof goingAlong;
  ALONG: typeof ALONG;
  take: typeof take;
  HELD: typeof HELD;
  wentOutWithWords: typeof wentOutWithWords;
  wentOut: typeof wentOut;
};

const dispatchQueue: DispatchQueue = { waitsForWords, waitsForRetry, dueTurn, inboxTurnDue, heldBack, goingAlong, ALONG, take, HELD, wentOutWithWords, wentOut };
