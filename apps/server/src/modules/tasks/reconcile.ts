import { and, eq, gt, gte, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs, pendingWakes, requests, subscriptions, tasks, testRuns } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { agentState, goesElsewhere, liveSubscription } from '../conversation/queue.js';
import { identityOf, ownBuiltin } from '../nodes/hub.js';
import { failOpenJobs } from '../nodes/messages.js';
import { mergePending } from '../nodes/parked.js';
import { settleAwayNotes, turnAway, turnBack } from './away.js';
import { expireStaleNodes } from '../nodes/nodes.js';
import { CLOSED, giver, lastMove, openAfter, type Task, type Wake } from './engine.js';
import { checkSignInFailures, sendWaitingFailureAlarms } from './failures.js';
import { askOfRunningTurns, moveStalledQueues } from './orphan-turns.js';
import { checkSilentTurns } from './silent.js';
import { wakeAll } from './wake.js';

const MACHINE_AWAY_MS = 5 * 60_000;
const LOST_WAKE_MS = 2 * 60_000;

/* A turn on a machine that stayed away too long ends just as one the machine reported failed, and goes on by the
   failed-turn path: a turn of no task, a turn on a task of someone who does not hold it, and one the queue would run
   on another machine now. The turn of the task's holder that can go on nowhere else is not failed: the work on its
   machine is kept, whoever gave the task out hears of it once, and the turn goes on when the machine is back. While the database of a machine the server was taken from waits to be
   merged, no turn ends for a machine that is away: that machine's turns and their rows are on their way here. */
async function failAwayTurns(ctx: Ctx, now: Date): Promise<void> {
  if (await mergePending(ctx.db)) return;
  const running = await ctx.db
    .select({ job: jobs, sub: subscriptions })
    .from(jobs)
    .innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
    .where(and(eq(jobs.kind, 'conversation'), eq(jobs.status, 'running')));
  for (const { job, sub } of running) {
    const node = identityOf(sub, job.nodeId, job.builtinMachine, ownBuiltin(ctx.config));
    if (!node) continue;
    const away = ctx.hub.awaySince(node);
    if (away === null) {
      /* Told only once the node said hello again: its hello may still end a turn its machine no longer runs. */
      if (job.taskId && ctx.hub.isReady(node)) await turnBack(ctx, job, node, now);
      continue;
    }
    if (away + MACHINE_AWAY_MS >= now.getTime()) continue;
    /* Kept: the turn of whoever holds the task, when the queue would not run its next turn on another machine now.
       Any other turn ends here and goes on by the failed-turn path, as ever. */
    if (job.taskId && job.agentId && (await turnAway(ctx, job, node, away, () => goesElsewhere(ctx, job.agentId!, node)))) continue;
    await failOpenJobs(ctx, eq(jobs.id, job.id), 'machine_offline');
  }
  await settleAwayNotes(ctx);
}

type Move = Awaited<ReturnType<typeof lastMove>>;

/* Only the current owner acts on an executable candidate. */
async function wakesDue(task: Task, move: Move): Promise<Wake[]> {
  if (task.status === 'blocked') return giver(task, 'blocked', task.assigneeAgentId ?? undefined, move?.text);
  return task.assigneeAgentId ? [{ agentId: task.assigneeAgentId, taskId: task.id, why: task.status === 'review' ? 'review' : 'assigned' }] : [];
}

/* Tasks waiting for other work or an answer already have a way to continue. */
export async function waitsOnPurpose(ctx: Ctx, task: Task): Promise<boolean> {
  if ((await openAfter(ctx.db, task)).length) return true;
  const [subtask] = await ctx.db.select(idOnly(tasks)).from(tasks).where(and(eq(tasks.parentId, task.id), notInArray(tasks.status, [...CLOSED]))).limit(1);
  if (subtask) return true;
  const [asked] = await ctx.db.select(idOnly(requests)).from(requests).where(and(eq(requests.taskId, task.id), eq(requests.status, 'open'))).limit(1);
  if (asked) return true;
  const [testing] = await ctx.db.select(idOnly(testRuns)).from(testRuns).where(and(eq(testRuns.taskId, task.id), eq(testRuns.status, 'running'))).limit(1);
  return Boolean(testing);
}

/* Only an available holder without a turn covering the move needs a wake. */
async function canWake(ctx: Ctx, w: Wake, movedAt: Date, before: Date): Promise<boolean> {
  const [agent] = await ctx.db.select(idOnly(agents)).from(agents).where(and(eq(agents.id, w.agentId), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  if (!agent || !(await liveSubscription(ctx, agent.id))) return false;
  const state = await agentState(ctx, agent.id);
  if (!state.ready || state.busy || state.queued) return false;
  const [pending] = await ctx.db.select(idOnly(pendingWakes)).from(pendingWakes).where(eq(pendingWakes.agentId, agent.id)).limit(1);
  if (pending) return false;
  const [covered] = await ctx.db.select(idOnly(jobs)).from(jobs).leftJoin(tasks, eq(tasks.id, jobs.taskId)).where(and(eq(jobs.agentId, agent.id), or(
    inArray(jobs.status, ['queued', 'running']),
    and(or(eq(tasks.id, w.taskId), eq(tasks.parentId, w.taskId)), or(gt(jobs.createdAt, movedAt), and(lte(jobs.startedAt, movedAt), gte(jobs.finishedAt, movedAt)))),
    sql`coalesce(${jobs.finishedAt}, ${jobs.createdAt}) >= ${before}`,
  ))).limit(1);
  return !covered;
}

/* Old moves need a wake only when the holder has not handled them or chosen to wait. */
async function wakeMissing(ctx: Ctx, now: Date): Promise<void> {
  const before = new Date(now.getTime() - LOST_WAKE_MS);
  const open = await ctx.db.select().from(tasks).where(inArray(tasks.status, ['open', 'working', 'review', 'blocked']));
  for (const task of open) {
    const move = await lastMove(ctx.db, task.id);
    const movedAt = move?.createdAt ?? task.createdAt;
    if (movedAt >= before || (await waitsOnPurpose(ctx, task))) continue;
    for (const w of await wakesDue(task, move)) {
      if (move?.agentId === w.agentId) continue;
      if (await canWake(ctx, w, movedAt, before)) await wakeAll(ctx, [w]);
    }
  }
}

const reconciling = new WeakSet<Ctx>();

/* Recover turns lost when a machine went away, no longer runs them or a task move did not wake its holder, and tell Operations
   of a program its queue waits behind. */
export async function reconcile(ctx: Ctx, now = new Date()): Promise<void> {
  if (reconciling.has(ctx)) return;
  reconciling.add(ctx);
  try {
    await expireStaleNodes(ctx.db, now);
    await failAwayTurns(ctx, now);
    await askOfRunningTurns(ctx, now);
    await moveStalledQueues(ctx, now);
    await wakeMissing(ctx, now);
    await checkSilentTurns(ctx, now);
    await checkSignInFailures(ctx, now);
    await sendWaitingFailureAlarms(ctx);
  } finally {
    reconciling.delete(ctx);
  }
}
