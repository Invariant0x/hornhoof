import { and, eq, gt, inArray, isNotNull, isNull, notInArray, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { agents, jobs, tasks } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { loggable } from '../../errors.js';
import { agentState } from '../conversation/state.js';
import { insertTurn, pump, pumpWaiting } from '../conversation/queue.js';
import { liveSubscription } from '../conversation/placement.js';
import { onAgent } from '../conversation/line.js';
import { STOPPED_ON_PURPOSE } from '../conversation/constants.js';
import { dropOldConnections, serverStarted } from '../nodes/connections.js';
import { tellOfMachinesAway } from '../nodes/machine-away.js';
import { dropOldFiles } from '../tasks/attachments.js';
import { reconcile, waitsOnPurpose } from '../tasks/reconcile.js';
import { retryCallBatches } from '../calls/calls.js';
import { wakeLeftBehind } from '../tasks/wake.js';
import { checkWaitHealth } from '../tasks/wait-monitor.js';
import { checkExternalWaits } from '../tasks/external-wait.js';
import { moveLeases } from '../subscriptions/lease.js';
import { harnessRound } from '../testruns/harness.js';
import { checkTestTimes } from '../testruns/runs.js';
import type { AgentRow } from './find.js';
import { checkOperatorHealth } from '../program-operator/health.js';
import { releaseRound } from '../tasks/releases.js';
import { closeIdleTurns } from '../tasks/turn-ends.js';

export { TIMER_MAX, TIMER_MIN, TIMER_ORDER_MAX } from '../templates/load.js';
/* Hornhoof looks for due rounds this often. */
const TICK_MS = 60_000;

export const timerOf = (a: AgentRow) =>
  a.timerMinutes && a.timerOrder ? { minutes: a.timerMinutes, order: a.timerOrder, forWork: a.timerForWork, lastAt: a.timerAt?.toISOString() ?? null } : null;

/* Its own interval since the last round has passed, or a change it keeps track of asked for a round sooner. */
const due = (a: AgentRow, now: Date) => !a.timerAt || now.getTime() - a.timerAt.getTime() >= a.timerMinutes! * 60_000 || (a.timerNudgedAt !== null && now >= a.timerNudgedAt);
/* Still timed, on and in the company. */
const timed = and(isNotNull(agents.timerMinutes), isNotNull(agents.subscriptionId), isNull(agents.removedAt), isNull(agents.switchedOffAt));

/* What a timer for work looks at: a task open in the company that waits for nobody and nothing it named, or a turn that
   failed since the last round. A task that waits on purpose goes on by itself when what it waits for comes. */
async function workFor(ctx: Ctx, a: AgentRow): Promise<boolean> {
  const open = await ctx.db.select().from(tasks).where(and(eq(tasks.companyId, a.companyId), notInArray(tasks.status, ['done', 'cancelled'])));
  for (const task of open) if (!task.externalWait && !(await waitsOnPurpose(ctx, task))) return true;
  const [failed] = await ctx.db
    .select(idOnly(jobs))
    .from(jobs)
    .where(
      and(
        eq(jobs.companyId, a.companyId),
        eq(jobs.status, 'failed'),
        or(isNull(jobs.error), notInArray(jobs.error, STOPPED_ON_PURPOSE)),
        a.timerAt ? gt(jobs.finishedAt, a.timerAt) : undefined,
      ),
    )
    .limit(1);
  return Boolean(failed);
}

const every = (minutes: number) => (minutes % 60 === 0 ? `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}` : `${minutes} minutes`);

/* What a round tells the employee: why it woke, and its order. */
export const roundPrompt = (a: Pick<AgentRow, 'timerMinutes' | 'timerOrder'>) =>
  `Hornhoof woke you on your timer, which runs every ${every(a.timerMinutes ?? 0)}, outside any task. Do your round:\n\n${a.timerOrder ?? ''}`;

async function queueDueRound(ctx: Ctx, id: string, now: Date): Promise<string | false> {
  const { db } = ctx;
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, id), timed));
  if (!agent || !due(agent, now) || !(await liveSubscription(ctx, id)) || !(await agentState(ctx, id)).ready) return false;
  const [open] = await db
    .select(idOnly(jobs))
    .from(jobs)
    .where(and(eq(jobs.agentId, id), inArray(jobs.status, ['queued', 'running'])))
    .limit(1);
  if (open) return false;
  if (agent.timerForWork && !(await workFor(ctx, agent))) {
    await db.update(agents).set({ timerAt: now, timerNudgedAt: null }).where(eq(agents.id, id));
    return false;
  }
  const prompt = roundPrompt(agent);
  const jobId = await insertTurn(ctx, { companyId: agent.companyId, agentId: id, prompt, createdBy: null, message: { personId: null, text: prompt, timer: true, notification: { source: 'timer', tasks: [], detail: { en: agent.name, ru: agent.name } } } });
  await db.update(agents).set({ timerAt: now, timerNudgedAt: null }).where(eq(agents.id, id));
  return jobId;
}

/* Starts a round for each employee whose timer is due at `now`: one that is on, ready to run and has no turn waiting or
   running, looked at again once its line is free. A busy one is tried again on the next tick; a timer for work with
   nothing to look at skips its round. Returns how many rounds it started. */
export async function timerTick(ctx: Ctx, now = new Date(), report: (err: unknown) => void = () => {}): Promise<number> {
  const { db } = ctx;
  let started = 0;
  for (const { id } of await db.select(idOnly(agents)).from(agents).where(timed)) {
    try {
      const queued = await onAgent(ctx, id, () => queueDueRound(ctx, id, now));
      if (!queued) continue;
      started++;
      /* Outside the agent's line, which the pump waits on. */
      await pump(ctx, id);
      if (now.getTime() > Date.now()) await db.update(jobs).set({ startedAt: now }).where(and(eq(jobs.id, queued), eq(jobs.status, 'running')));
    } catch (err) {
      /* One employee's trouble does not keep the others from their rounds. */
      report(err);
    }
  }
  return started;
}

/* A turn whose send was lost, in a crash or a missed signal, waits for nothing: one sweep at a time sends it. */
const sending = new WeakSet<Ctx>();
async function sendWaiting(ctx: Ctx): Promise<void> {
  if (sending.has(ctx)) return;
  sending.add(ctx);
  try {
    await pumpWaiting(ctx);
  } finally {
    sending.delete(ctx);
  }
}

/* What Hornhoof does every minute: due rounds, turns that task moves kept and nobody queued, turns left waiting though
   their agent is free, department turns their release tags close and turns that hold nothing for a release, files of turns closed a month ago, the old history of node connections, test run times, and Codex plans
   to move. */
export async function minuteRound(ctx: Ctx, now: Date, failed: (what: string) => (err: unknown) => void): Promise<void> {
  await checkExternalWaits(ctx, now).catch(failed('ending external task waits failed'));
  await checkWaitHealth(ctx, now).catch(failed('checking task waits failed'));
  await checkOperatorHealth(ctx, now).catch(failed('checking program operator cases failed'));
  await Promise.all([
    timerTick(ctx, now, failed('timer round failed')).catch(failed('timer tick failed')),
    wakeLeftBehind(ctx).catch(failed('queueing left-behind turns failed')),
    retryCallBatches(ctx).catch(failed('recovering one-shot call batches failed')),
    reconcile(ctx, now).catch(failed('recovering stalled task turns failed')),
    releaseRound(ctx).catch(failed('closing turns by the tags of their releases failed')),
    closeIdleTurns(ctx).catch(failed('closing turns that hold nothing for a release failed')),
    sendWaiting(ctx).catch(failed('sending waiting turns failed')),
    dropOldFiles(ctx, now).catch(failed('removing the files of old turns failed')),
    dropOldConnections(ctx.db, now).catch(failed('removing the old history of node connections failed')),
    checkTestTimes(ctx).catch(failed('checking test run times failed')),
    harnessRound(ctx, now).catch(failed('getting test harnesses to the machines failed')),
    moveLeases(ctx, now).catch(failed('moving Codex plans to another machine failed')),
    tellOfMachinesAway(ctx, now).catch(failed('telling of machines away failed')),
  ]);
}

/* What is looked at as the app starts leading, without waiting for the first minute round. */
async function entrySweeps(ctx: Ctx, failed: (what: string) => (err: unknown) => void): Promise<void> {
  await serverStarted(ctx.db).catch(failed('ending the node connections of the last run failed'));
  await checkExternalWaits(ctx).catch(failed('ending external task waits failed'));
  await checkWaitHealth(ctx).catch(failed('checking task waits failed'));
  await checkOperatorHealth(ctx).catch(failed('restoring program operator cases failed'));
  await Promise.all([
    wakeLeftBehind(ctx).catch(failed('queueing left-behind turns failed')),
    retryCallBatches(ctx).catch(failed('recovering one-shot call batches failed')),
    dropOldFiles(ctx, new Date()).catch(failed('removing the files of old turns failed')),
  ]);
}

/* How many ticks in a row may find the same sweep still running before it is taken for one that will never end. */
const PATIENCE_TICKS = 5;

/* A leading app's sweeps, one at a time: those of the way in, then a round on each tick. A tick that finds a sweep still
   running is dropped, since the next one does what it would have. A sweep that five ticks in a row find running waits for
   something that does not answer: stalled hears of it, and the rounds go on without it, so one step that hangs does not
   stop every round after it. Entering waits for no sweep; leaving stops the ticks and waits for what runs, so nothing of
   this writes once the app has left lead. */
export function leadSweeps(entry: () => Promise<void>, round: () => Promise<void>, everyMs = TICK_MS, stalled: (ticks: number) => void = () => {}): { enter: () => void; leave: () => Promise<void> } {
  let timer: NodeJS.Timeout | null = null;
  let running: { ended: Promise<void>; ticks: number } | null = null;
  const start = (sweep: () => Promise<void>) => {
    const mine = { ticks: 0, ended: sweep().finally(() => { if (running === mine) running = null; }) };
    running = mine;
  };
  const tick = () => {
    if (running && ++running.ticks < PATIENCE_TICKS) return;
    if (running) stalled(running.ticks);
    start(round);
  };
  return {
    enter() {
      start(entry);
      timer = setInterval(tick, everyMs);
      timer.unref();
    },
    async leave() {
      if (timer) clearInterval(timer);
      timer = null;
      await running?.ended;
    },
  };
}

export function startTimers(app: FastifyInstance, ctx: Ctx): void {
  const failed = (what: string) => (err: unknown) => app.log.error({ error: loggable(err) }, what);
  const stalled = (ticks: number) => app.log.error(`A round of Hornhoof's minute checks has not ended after ${ticks} more were due: a step of it waits for something that does not answer. The rounds go on without it.`);
  const { enter, leave } = leadSweeps(() => entrySweeps(ctx, failed), () => minuteRound(ctx, new Date(), failed), TICK_MS, stalled);
  ctx.mode.whenLead(enter, leave);
}
