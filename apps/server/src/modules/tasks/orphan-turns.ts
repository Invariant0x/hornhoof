import type { NodeMessage, ProgramState } from '@hornhoof/protocol';
import type { ProgramView } from '@hornhoof/protocol/program-operator';
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs, subscriptions } from '../../db/schema.js';
import { enqueueTurn } from '../conversation/queue.js';
import { publishWorking } from '../events/store.js';
import { identityOf, keyOf, ownBuiltin, type NodeIdentity } from '../nodes/hub.js';
import { failOpenJobs } from '../nodes/job-failures.js';
import { jobsOf } from '../nodes/jobs.js';
import { livePrograms } from '../nodes/program-room.js';
import { requestProgramView } from '../program-operator/rpc.js';
import { agentProgramState, alreadyAlerted, programGoneSince, screenReader } from './silent.js';
import { logTurnFact } from './turn-log.js';
import { lastTurnSigns } from './turn-signs.js';
import { afterJob } from './wake.js';

type Job = typeof jobs.$inferSelect;

/* A turn is asked about once it has run this long: by then its node has it, as the turn went out or its words were typed. */
export const ASK_AFTER_MS = 2 * 60_000;
/* A node reports a program that runs a turn at least once a minute. A report this fresh that the program works keeps its
   turn, whatever the node says; idle at its prompt or gone is no work. */
export const PULSE_MS = 2 * 60_000;
const WORKING: ReadonlySet<ProgramState> = new Set(['thinking', 'tool', 'asking', 'retrying']);

const NOT_HELD = 'Hornhoof ended this turn as interrupted: its machine said it no longer runs this turn, and its program gave no sign of work for 2 minutes. The next waiting turn goes out.';
const GONE_HELD = 'Hornhoof ended this turn as interrupted: its machine still listed this turn, but its program was gone, the machine named no program of this employee after that, and the turn gave no sign of work for 2 minutes. The next waiting turn goes out.';
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

/* What the node answered: a turn it was asked about that shows no work is over when the node no longer runs it, or when it
   still lists it but no program of the employee is left on it. A node speaks only of its own turns, and only of the ones
   asked about once they ran long enough to have reached it. */
export async function turnsHeld(ctx: Ctx, id: NodeIdentity, msg: Extract<NodeMessage, { type: 'jobs.held' }>, now = new Date()): Promise<void> {
  if (!msg.asked.length) return;
  const held = new Set(msg.held);
  /* A turn the node still runs whose program it never said is gone is its own to go on with. */
  const doubtful = msg.asked.filter(jobId => !held.has(jobId) || programGoneSince(ctx, jobId) !== null);
  if (!doubtful.length) return;
  const asked = await ctx.db.select().from(jobs).where(and(inArray(jobs.id, doubtful), eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'), jobsOf(id, ctx), lte(jobs.startedAt, new Date(now.getTime() - ASK_AFTER_MS))));
  const signs = await lastTurnSigns(ctx, asked.map(job => job.id));
  for (const job of asked) {
    if (working(ctx, job, now.getTime(), signs.get(job.id))) continue;
    if (!held.has(job.id)) await endLost(ctx, job, NOT_HELD);
    else if (programLeft(ctx, id, job)) await endLost(ctx, job, GONE_HELD, id);
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
const idleViews = new WeakMap<Ctx, Map<string, IdleView>>();

function emptyView(view: ProgramView): boolean {
  return view.state === 'idle' && view.input === 'empty' && !view.tool && !view.question && !view.undelivered;
}

function continuousView(old: IdleView | undefined, current: IdleView): boolean {
  return old !== undefined && old.instance === current.instance && old.proof === current.proof && old.signAt === current.signAt && current.at >= old.at && current.at - old.at <= PULSE_MS;
}

function completionProof(view: ProgramView): string {
  return view.completion ? `completion:${view.completion}` : `screen:${view.cells}`;
}

/* Query the running job's exact node, not the newest queued job's placement. A failed look, a new instance, work or a draft
   breaks the observation. Fresh looks are required throughout: a disconnected node cannot accrue idle time. */
async function idleOnScreen(ctx: Ctx, job: Job, node: NodeIdentity, now: number): Promise<boolean> {
  const known = idleViews.get(ctx) ?? new Map<string, IdleView>();
  idleViews.set(ctx, known);
  const view = await requestProgramView(ctx, { agentId: job.agentId!, node });
  if (!view || view.result !== 'ok' || view.jobId !== job.id || !view.instance || !view.snapshot || !emptyView(view)) {
    known.delete(job.id);
    return false;
  }
  const old = known.get(job.id);
  const signAt = agentProgramState(ctx, job).program?.signAt ?? 0;
  const proof = completionProof(view);
  const current = { instance: view.instance, proof, signAt, since: now, at: now };
  if (continuousView(old, current)) current.since = old!.since;
  known.set(job.id, current);
  return now - current.since >= IDLE_END_MS;
}

async function recoverScreenTurn(ctx: Ctx, job: Job, node: NodeIdentity, now: Date): Promise<void> {
  if (now.getTime() - (job.startedAt ?? job.createdAt).getTime() < ASK_AFTER_MS) return;
  if (await idleOnScreen(ctx, job, node, now.getTime())) await closeIdleTurn(ctx, job, node, now, SCREEN_CLOSED);
}

function forgetIdleViews(ctx: Ctx, turns: { job: Job }[]): void {
  const active = new Set(turns.map(t => t.job.id));
  const known = idleViews.get(ctx);
  if (known) for (const id of known.keys()) if (!active.has(id)) known.delete(id);
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
    message: { personId: null, text, silentJob: caseId, silentReason: 'program_stalled', notification: { source: 'program_alarm', tasks: [], detail: { en: `${agent.name}: queue stands still`, ru: `${agent.name}: очередь стоит` } } },
  });
  await logTurnFact(ctx, job, `${to.name} was told the queue stands still behind this turn.`, { stalledQueue: caseId, to: to.id });
}

/* A turn its node still runs whose program stands idle at its prompt while the agent's messages wait behind it is over: its
   end was lost. Hornhoof closes it and the messages go into the same session. One more such turn soon after wakes Operations
   instead, not a person. */
export async function moveStalledQueues(ctx: Ctx, now: Date): Promise<void> {
  const turns = await runningTurns(ctx);
  forgetIdleViews(ctx, turns);
  const busy = new Set(turns.flatMap(t => (t.job.agentId ? [t.job.agentId] : [])));
  for (const { job, plan } of turns) {
    const idle = idleFor(ctx, job, now.getTime());
    const node = identityOf({ kind: plan }, job.nodeId, job.builtinMachine, ownBuiltin(ctx.config));
    if (!job.agentId || !node) continue;
    if (idle === null) {
      await recoverScreenTurn(ctx, job, node, now);
      continue;
    }
    if (idle < IDLE_END_MS) continue;
    const waiting = await waitingBehind(ctx, job.agentId, now.getTime() - IDLE_END_MS);
    if (!waiting) {
      await recoverScreenTurn(ctx, job, node, now);
      continue;
    }
    idleViews.get(ctx)?.delete(job.id);
    const last = closesOf(ctx).get(job.agentId);
    if (last === undefined || now.getTime() - last > RECLOSE_MS) await closeIdleTurn(ctx, job, node, now);
    else await tellOperations(ctx, job, waiting, busy, now);
  }
}
