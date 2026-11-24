import type { NodeMessage, ProgramState } from '@hornhoof/protocol';
import type { ProgramView } from '@hornhoof/protocol/program-operator';
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs, subscriptions } from '../../db/schema.js';
import { TURN_TIMEOUT_MS } from '../conversation/constants.js';
import { enqueueTurn } from '../conversation/queue.js';
import { publishWorking } from '../events/store.js';
import { jobCheckLastEnd, jobCheckQueued } from '../nodes/check-slots.js';
import { identityOf, keyOf, ownBuiltin, type NodeIdentity } from '../nodes/hub.js';
import { failOpenJobs } from '../nodes/job-failures.js';
import { jobsOf } from '../nodes/jobs.js';
import { livePrograms } from '../nodes/program-room.js';
import { requestProgramView } from '../program-operator/rpc.js';
import { agentProgramState, programGoneSince, signInTurn } from './program-state.js';
import { alreadyAlerted, screenReader } from './silent.js';
import { logTurnFact } from './turn-log.js';
import { lastTurnSigns } from './turn-signs.js';
import { afterJob } from './wake.js';
import { saying } from '../../locales/index.js';

type Job = typeof jobs.$inferSelect;

/* A turn is asked about once it has run this long: by then its node has it, as the turn went out or its words were typed. */
export const ASK_AFTER_MS = 2 * 60_000;
/* A node reports a program that runs a turn at least once a minute. A report this fresh that the program works keeps its
   turn, whatever the node says; idle at its prompt or gone is no work. */
export const PULSE_MS = 2 * 60_000;
const WORKING: ReadonlySet<ProgramState> = new Set(['thinking', 'tool', 'asking', 'retrying']);

const NOT_HELD = 'Hornhoof ended this turn as interrupted: its machine said it no longer runs this turn, and its program gave no sign of work for 2 minutes. The next waiting turn goes out.';
const GONE_HELD = 'Hornhoof ended this turn as interrupted: its machine still listed this turn, but its program was gone, the machine named no program of this employee after that, and the turn gave no sign of work for 2 minutes. The next waiting turn goes out.';
const NO_PROGRAM_END = 'Hornhoof ended this turn as interrupted: two independent checks of its machine found no program running for this employee, and the turn gave no sign of work for 2 minutes. The next waiting turn goes out.';
const SILENT_TIMEOUT_END = 'Hornhoof ended this turn as interrupted: it gave no sign of life for the whole turn timeout while still marked running. The next waiting turn goes out.';
const NO_MACHINE = 'Hornhoof ended this turn as interrupted: it went out to no machine of its plan, so no machine can run it or end it. The next waiting turn goes out.';

/* Its program reported work a moment ago: it thinks, runs a tool, asks or retries. Or the turn itself showed work a moment
   ago, as a program with no screen does: its node streamed an event of it, or it called a Hornhoof tool. */
function working(ctx: Ctx, job: Job, now: number, worked: number | undefined): boolean {
  const program = agentProgramState(ctx, job).program;
  return Boolean(program && WORKING.has(program.state) && now - program.reportedAt < PULSE_MS) || (worked !== undefined && now - worked < PULSE_MS);
}

/* The node that holds the turn said its program is gone, and named the programs that run on it after that without this
   employee's: no program is left to run the turn. A restart asked for after the program went is left to bring it back. */
function programLeft(ctx: Ctx, node: NodeIdentity, job: Job): boolean {
  const goneAt = programGoneSince(ctx, job.id);
  const live = livePrograms(ctx, node);
  if (goneAt === null || !live || live.at <= goneAt || !job.agentId) return false;
  return !live.agents.has(job.agentId) && !(job.restartedAt && job.restartedAt.getTime() >= goneAt);
}

/* The turn ends as one its machine lost, as when a node connects again without it: what was going on in it goes on in the
   agent's next turn, its task's turn runs again, and the next waiting turn goes out. A node that still holds the turn is
   told to let it go before the next turn goes out to it, and only a turn of that node ends. */
async function endLost(ctx: Ctx, job: Job, why: string, holder?: NodeIdentity): Promise<void> {
  if (holder) ctx.hub.send(holder, { type: 'job.cancel', jobId: job.id });
  const ended = await failOpenJobs(ctx, and(eq(jobs.id, job.id), eq(jobs.status, 'running'), holder ? jobsOf(holder, ctx) : undefined)!, 'machine_restarted');
  if (ended.length) await logTurnFact(ctx, job, why, { lostTurn: true });
}

const runningTurns = (ctx: Ctx, before?: Date) =>
  ctx.db.select({ job: jobs, plan: subscriptions.kind }).from(jobs).innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
    .where(and(eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'), before ? lte(jobs.startedAt, before) : undefined));

/* Each connected node is asked which of the turns it was given it still runs; a turn no machine can run ends at once. A node
   that is away is not asked: it answers with its hello when it is back, and one away too long loses its turns anyway. */
export async function askOfRunningTurns(ctx: Ctx, now: Date): Promise<void> {
  const asks = new Map<string, { node: NodeIdentity; jobIds: string[] }>();
  for (const { job, plan } of await runningTurns(ctx, new Date(now.getTime() - ASK_AFTER_MS))) {
    const node = identityOf({ kind: plan }, job.nodeId, job.builtinMachine, ownBuiltin(ctx.config));
    if (!node) await endLost(ctx, job, NO_MACHINE);
    else if (ctx.hub.isReady(node)) {
      const ask = asks.get(keyOf(node)) ?? { node, jobIds: [] };
      ask.jobIds.push(job.id);
      asks.set(keyOf(node), ask);
    }
  }
  for (const { node, jobIds } of asks.values()) for (let i = 0; i < jobIds.length; i += 100) ctx.hub.send(node, { type: 'jobs.check', jobIds: jobIds.slice(i, i + 100) });
}

function turnStartedAt(job: Job): number {
  return (job.startedAt ?? job.createdAt).getTime();
}

function turnFloorAt(job: Job, graceMs: number): number {
  return Math.max(turnStartedAt(job) + graceMs, job.restartedAt ? job.restartedAt.getTime() : 0);
}

function freshPulse(at: number | null | undefined, nowMs: number): boolean {
  return at != null && nowMs - at < PULSE_MS;
}

function programTurnSign(ctx: Ctx, job: Job): number | null {
  const program = agentProgramState(ctx, job).program;
  return program ? signInTurn(program, job) : null;
}

function omittedFromLive(ctx: Ctx, node: NodeIdentity, job: Job): boolean {
  const live = livePrograms(ctx, node);
  if (!live || !job.agentId) return false;
  return live.at >= turnFloorAt(job, ASK_AFTER_MS) && !live.agents.has(job.agentId);
}

function absentWithoutSign(ctx: Ctx, node: NodeIdentity, job: Job, worked: number | undefined, nowMs: number): boolean {
  return omittedFromLive(ctx, node, job) && !freshPulse(worked, nowMs) && !freshPulse(programTurnSign(ctx, job), nowMs);
}

function doubtfulTurns(ctx: Ctx, id: NodeIdentity, asked: string[], held: ReadonlySet<string>): string[] {
  if (livePrograms(ctx, id)) return asked;
  return asked.filter(jobId => !held.has(jobId) || programGoneSince(ctx, jobId) !== null);
}

function heldTurnLost(ctx: Ctx, id: NodeIdentity, job: Job, worked: number | undefined, nowMs: number): boolean {
  if (programGoneSince(ctx, job.id) !== null) return !working(ctx, job, nowMs, worked) && programLeft(ctx, id, job);
  return absentWithoutSign(ctx, id, job, worked, nowMs);
}

/* What the node answered: a turn it was asked about that shows no work is over when the node no longer runs it, or when it
   still lists it but no program of the employee is left on it. A node speaks only of its own turns, and only of the ones
   asked about once they ran long enough to have reached it. */
export async function turnsHeld(ctx: Ctx, id: NodeIdentity, msg: Extract<NodeMessage, { type: 'jobs.held' }>, now = new Date()): Promise<void> {
  if (!msg.asked.length) return;
  const held = new Set(msg.held);
  /* A turn the node still runs whose program it never said is gone and never omitted from its live list goes on. */
  const doubtful = doubtfulTurns(ctx, id, msg.asked, held);
  if (!doubtful.length) return;
  const asked = await ctx.db.select().from(jobs).where(and(inArray(jobs.id, doubtful), eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'), jobsOf(id, ctx), lte(jobs.startedAt, new Date(now.getTime() - ASK_AFTER_MS))));
  const signs = await lastTurnSigns(ctx, asked.map(job => job.id));
  const nowMs = now.getTime();
  for (const job of asked) {
    const worked = signs.get(job.id);
    if (!held.has(job.id)) {
      if (!working(ctx, job, nowMs, worked)) await endLost(ctx, job, NOT_HELD);
    } else if (heldTurnLost(ctx, id, job, worked, nowMs)) {
      await endLost(ctx, job, GONE_HELD, id);
    }
  }
}

/* How long a program may stand idle at its prompt in a turn its node still runs while the agent's next messages wait: the
   end of that turn was lost, and Hornhoof closes it. */
export const IDLE_END_MS = 2 * 60_000;
/* An agent whose turn Hornhoof closed so this long ago or less gets no second close: Operations hear of the queue instead. */
export const RECLOSE_MS = 30 * 60_000;

const IDLE_CLOSED = 'Hornhoof closed this turn as done: its program stood idle at its prompt for 2 minutes, with no answer coming, no tool and no question, while the next messages waited, so the end of the turn was lost. They go into the same session.';
const SCREEN_CLOSED = 'Hornhoof closed this turn as done: two independent views of the same program showed its completed response and empty prompt at least 2 minutes apart, with no tool, question or undelivered words. The end of the turn was lost. Its next messages go into the same session.';

const closedAt = new WeakMap<Ctx, Map<string, number>>();
const closesOf = (ctx: Ctx) => {
  const map = closedAt.get(ctx) ?? new Map<string, number>();
  closedAt.set(ctx, map);
  return map;
};
type IdleView = { instance: string; proof: string; signAt: number; since: number; at: number };
type NoProgramView = { since: number; at: number };
const idleViews = new WeakMap<Ctx, Map<string, IdleView>>();
const noProgramViews = new WeakMap<Ctx, Map<string, NoProgramView>>();

const viewMapOf = <T>(store: WeakMap<Ctx, Map<string, T>>, ctx: Ctx): Map<string, T> => {
  const map = store.get(ctx) ?? new Map<string, T>();
  store.set(ctx, map);
  return map;
};

function clearScreenViews(ctx: Ctx, jobId: string): void {
  idleViews.get(ctx)?.delete(jobId);
  noProgramViews.get(ctx)?.delete(jobId);
}

function emptyView(view: ProgramView): boolean {
  return view.state === 'idle' && view.input === 'empty' && !view.tool && !view.question && !view.undelivered;
}

function readableView(view: ProgramView): boolean {
  return view.result === 'ok' && Boolean(view.instance) && Boolean(view.snapshot);
}

function cleanPrompt(view: ProgramView): boolean {
  return view.input === 'empty' && !view.question && !view.undelivered;
}

function viewShowsIdle(job: Job, view: ProgramView): boolean {
  if (!readableView(view) || !cleanPrompt(view)) return false;
  return view.jobId === job.id ? emptyView(view) : view.jobId === null;
}

function continuousView(old: IdleView | undefined, current: IdleView): boolean {
  return old !== undefined && old.instance === current.instance && old.proof === current.proof && old.signAt === current.signAt && current.at >= old.at && current.at - old.at <= PULSE_MS;
}

function completionProof(view: ProgramView): string {
  return view.completion ? `completion:${view.completion}` : `screen:${view.cells}`;
}

function idleOnView(ctx: Ctx, job: Job, view: ProgramView, now: number): boolean {
  const known = viewMapOf(idleViews, ctx);
  const old = known.get(job.id);
  const signAt = agentProgramState(ctx, job).program?.signAt ?? 0;
  const current = { instance: view.instance!, proof: completionProof(view), signAt, since: now, at: now };
  if (continuousView(old, current)) current.since = old!.since;
  known.set(job.id, current);
  return now - current.since >= IDLE_END_MS;
}

function noProgramBlocked(ctx: Ctx, job: Job, node: NodeIdentity, worked: number | undefined, now: number): boolean {
  if (ctx.hub.awaySince(node) !== null || freshPulse(worked, now)) return true;
  return Boolean(job.restartedAt && now - job.restartedAt.getTime() < PULSE_MS);
}

function keepNoProgramSince(old: NoProgramView | undefined, restartedAt: number, now: number): number {
  if (!old || now < old.at || now - old.at > PULSE_MS) return now;
  return restartedAt <= old.since ? old.since : now;
}

function noProgramOnView(ctx: Ctx, job: Job, node: NodeIdentity, worked: number | undefined, now: number): boolean {
  const known = viewMapOf(noProgramViews, ctx);
  if (noProgramBlocked(ctx, job, node, worked, now)) {
    known.delete(job.id);
    return false;
  }
  const restartedAt = job.restartedAt ? job.restartedAt.getTime() : 0;
  const since = keepNoProgramSince(known.get(job.id), restartedAt, now);
  known.set(job.id, { since, at: now });
  return now - since >= IDLE_END_MS;
}

async function applyRefusedView(ctx: Ctx, job: Job, node: NodeIdentity, view: ProgramView | null, nowMs: number, worked?: number): Promise<void> {
  if (view?.result !== 'refused' || view.reason !== 'no_program') {
    noProgramViews.get(ctx)?.delete(job.id);
    return;
  }
  if (noProgramOnView(ctx, job, node, worked, nowMs)) await endLost(ctx, job, NO_PROGRAM_END, node);
}

async function observeScreenView(ctx: Ctx, job: Job, node: NodeIdentity, view: ProgramView | null, now: Date, worked?: number): Promise<void> {
  if (!view || !viewShowsIdle(job, view)) {
    idleViews.get(ctx)?.delete(job.id);
    await applyRefusedView(ctx, job, node, view, now.getTime(), worked);
    return;
  }
  noProgramViews.get(ctx)?.delete(job.id);
  if (idleOnView(ctx, job, view, now.getTime())) await closeIdleTurn(ctx, job, node, now, SCREEN_CLOSED);
}

/* Query the running job's exact node, not the newest queued job's placement. A failed look, a new instance, work or a draft
   breaks the observation. Fresh looks are required throughout: a disconnected node cannot accrue idle time. */
async function recoverScreenTurn(ctx: Ctx, job: Job, node: NodeIdentity, now: Date, worked?: number): Promise<void> {
  if (now.getTime() - turnStartedAt(job) < ASK_AFTER_MS) return;
  const view = await requestProgramView(ctx, { agentId: job.agentId!, node });
  await observeScreenView(ctx, job, node, view, now, worked);
}

function pruneViewStore<T>(store: Map<string, T> | undefined, active: ReadonlySet<string>): void {
  if (!store) return;
  for (const id of store.keys()) if (!active.has(id)) store.delete(id);
}

function forgetIdleViews(ctx: Ctx, turns: { job: Job }[]): void {
  const active = new Set(turns.map(t => t.job.id));
  pruneViewStore(idleViews.get(ctx), active);
  pruneViewStore(noProgramViews.get(ctx), active);
}

function turnLastSign(ctx: Ctx, job: Job, worked: number | undefined, nowMs: number): number {
  const sign = programTurnSign(ctx, job) ?? 0;
  const checkEnd = jobCheckLastEnd(ctx, job.id, nowMs) ?? 0;
  return Math.max(turnFloorAt(job, 0), sign, worked ?? 0, checkEnd);
}

function timedOutWithoutSign(ctx: Ctx, job: Job, node: NodeIdentity, worked: number | undefined, nowMs: number): boolean {
  if (ctx.hub.awaySince(node) !== null || jobCheckQueued(ctx, job.id, nowMs)) return false;
  if (agentProgramState(ctx, job).program?.state === 'asking') return false;
  const limit = job.timeoutMs > 0 ? job.timeoutMs : TURN_TIMEOUT_MS;
  return nowMs - turnLastSign(ctx, job, worked, nowMs) >= limit;
}

/* The oldest of the agent's messages that has waited behind its running turn since before the given time. */
async function waitingBehind(ctx: Ctx, agentId: string, before: number): Promise<Job | null> {
  const [waiting] = await ctx.db.select().from(jobs)
    .where(and(eq(jobs.agentId, agentId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'queued'), lte(jobs.createdAt, new Date(before))))
    .orderBy(asc(jobs.createdAt)).limit(1);
  return waiting ?? null;
}

/* Its program, as its node reported a moment ago, has stood idle at its prompt this long: no answer coming, no tool, no
   question. None when it works, is gone or was not heard of lately. */
function idleFor(ctx: Ctx, job: Job, now: number): number | null {
  const program = agentProgramState(ctx, job).program;
  return program?.state === 'idle' && now - program.reportedAt < PULSE_MS ? now - program.since : null;
}

/* The turn is over as done, and the node lets it go in the same session before the next turn comes to it, which it takes in
   that session once this one has let go: nothing starts the program again. */
async function closeIdleTurn(ctx: Ctx, job: Job, node: NodeIdentity, now: Date, why = IDLE_CLOSED): Promise<void> {
  const [closed] = await ctx.db.update(jobs).set({ status: 'done', result: '', finishedAt: now }).where(and(eq(jobs.id, job.id), eq(jobs.status, 'running'))).returning({ id: jobs.id });
  if (!closed) return;
  closesOf(ctx).set(job.agentId!, now.getTime());
  ctx.hub.send(node, { type: 'job.cancel', jobId: job.id });
  await logTurnFact(ctx, job, why, { idleClosed: true });
  await publishWorking(ctx, job.companyId);
  await afterJob(ctx, job.id);
}

const minutes = (ms: number) => Math.floor(ms / 60_000);

function stalledText(name: string, agentId: string, job: Job, waiting: Job, now: number): string {
  return `Hornhoof: the queue of ${name} stands still. Its program stands idle at its prompt in turn ${job.id}, which its machine still runs, ` +
    `though Hornhoof closed a turn of it so stuck before, and its next messages have waited since ${waiting.createdAt.toISOString()} (${minutes(now - waiting.createdAt.getTime())} minutes): they do not reach the program. ` +
    `Read program_screen for employee ${agentId} and bring the program back yourself: stop that turn with stop_employee, or restart its program, so the queue goes on. ` +
    'Ask no person to do it. When nothing you may do helps, tell your head what the screen shows.';
}

/* Operations hear once of a turn whose program stands idle while the agent's messages wait behind it again. */
async function tellOperations(ctx: Ctx, job: Job, waiting: Job, busy: ReadonlySet<string>, now: Date): Promise<void> {
  const caseId = `${job.id}:queue`;
  if (await alreadyAlerted(ctx, caseId)) return;
  const [agent] = await ctx.db.select().from(agents).where(eq(agents.id, job.agentId!));
  const to = agent && await screenReader(ctx, job.companyId, agent.id, busy);
  if (!agent || !to) return;
  const text = stalledText(agent.name, agent.id, job, waiting, now.getTime());
  await enqueueTurn(ctx, {
    companyId: job.companyId,
    agentId: to.id,
    prompt: text,
    createdBy: null,
    message: { personId: null, text, silentJob: caseId, silentReason: 'program_stalled', notification: { source: 'program_alarm', tasks: [], detail: saying(words => words.notices.queueStill(agent.name)) } },
  });
  await logTurnFact(ctx, job, `${to.name} was told the queue stands still behind this turn.`, { stalledQueue: caseId, to: to.id });
}

async function closeOrAlertIdle(ctx: Ctx, job: Job, node: NodeIdentity, waiting: Job, busy: ReadonlySet<string>, now: Date): Promise<void> {
  clearScreenViews(ctx, job.id);
  const last = closesOf(ctx).get(job.agentId!);
  if (last === undefined || now.getTime() - last > RECLOSE_MS) await closeIdleTurn(ctx, job, node, now);
  else await tellOperations(ctx, job, waiting, busy, now);
}

async function advanceTurnQueue(ctx: Ctx, job: Job, node: NodeIdentity, worked: number | undefined, busy: ReadonlySet<string>, now: Date): Promise<void> {
  const nowMs = now.getTime();
  if (timedOutWithoutSign(ctx, job, node, worked, nowMs)) {
    clearScreenViews(ctx, job.id);
    await endLost(ctx, job, SILENT_TIMEOUT_END, node);
    return;
  }
  const idle = idleFor(ctx, job, nowMs);
  if (idle === null) return recoverScreenTurn(ctx, job, node, now, worked);
  if (idle < IDLE_END_MS) return;
  const waiting = await waitingBehind(ctx, job.agentId!, nowMs - IDLE_END_MS);
  if (!waiting) return recoverScreenTurn(ctx, job, node, now, worked);
  await closeOrAlertIdle(ctx, job, node, waiting, busy, now);
}

/* A turn its node still runs whose program stands idle at its prompt while the agent's messages wait behind it is over: its
   end was lost. Hornhoof closes it and the messages go into the same session. One more such turn soon after wakes Operations
   instead, not a person. */
export async function moveStalledQueues(ctx: Ctx, now: Date): Promise<void> {
  const turns = await runningTurns(ctx);
  forgetIdleViews(ctx, turns);
  const signs = await lastTurnSigns(ctx, turns.map(t => t.job.id));
  const busy = new Set(turns.flatMap(t => (t.job.agentId ? [t.job.agentId] : [])));
  for (const { job, plan } of turns) {
    const node = identityOf({ kind: plan }, job.nodeId, job.builtinMachine, ownBuiltin(ctx.config));
    if (job.agentId && node) await advanceTurnQueue(ctx, job, node, signs.get(job.id), busy, now);
  }
}
