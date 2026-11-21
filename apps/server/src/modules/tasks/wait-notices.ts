import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { accessOf, canReach } from '../../auth/access.js';
import { agents, people, requests, taskEvents, tasks, taskWaits, waitNotices, type TaskEventKind } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { loggable } from '../../errors.js';
import { insertOrDeliverTurn, pump } from '../conversation/queue.js';
import { liveSubscription } from '../conversation/placement.js';
import { withInputLock } from '../conversation/decision-context.js';
import { notificationMessage } from '../events/notifications.js';
import { pausedCompanyIds } from '../org/pause-state.js';
import { ownNote } from './events.js';
import { taskSpot, type Task, type Tx } from './state.js';
import type { WaitNoticeGuard } from './wait-notice-types.js';
import { quietRecipient, waitOrchestrator } from './wait-recipients.js';
import { quietDepartment } from './wait-observations.js';

type Writer = Pick<Db, 'insert'>;
type NewWaitNotice = typeof waitNotices.$inferInsert;
type Notice = typeof waitNotices.$inferSelect;
const pending = and(isNull(waitNotices.deliveredAt), isNull(waitNotices.cancelledAt));
const LEASE_MS = 2 * 60_000;
/* What moves the work of a task on. Words on it, a wait said again or ended and a reminder do not. */
const WORK_MOVES: TaskEventKind[] = ['created', 'assigned', 'started', 'submitted', 'verdict', 'report', 'blocked', 'answered', 'cancelled', 'done'];

export async function recordWaitNotice(db: Writer, notice: NewWaitNotice): Promise<void> {
  await db.insert(waitNotices).values(notice).onConflictDoNothing({ target: [waitNotices.companyId, waitNotices.dedupKey] });
}

/* Requests on one task for one employee are one episode until the work moves. */
async function waitEpisode(db: Pick<Db, 'select'>, taskId: string): Promise<number> {
  const [last] = await db.select(idOnly(taskEvents)).from(taskEvents).where(and(eq(taskEvents.taskId, taskId), inArray(taskEvents.kind, WORK_MOVES)))
    .orderBy(desc(taskEvents.id)).limit(1);
  return last?.id ?? 0;
}

/* One notice for each holder and employee in an episode. Clearing the check or recording it again stays in that episode. */
export async function requestedWaitNotice(ctx: Ctx, task: Task, waiter: string): Promise<NewWaitNotice | null> {
  const wait = task.externalWait;
  if (wait?.on?.kind !== 'employee' || wait.on.employee === waiter) return null;
  const [employee] = await ctx.db.select().from(agents).where(eq(agents.id, waiter));
  const episode = await waitEpisode(ctx.db, task.id);
  const text = wait.work
    ? `As of ${wait.since}, ${employee!.name} is tracking work that depends on you on #${task.number}: ${wait.reason}. Next check at ${wait.until}. Check the task and report your progress to ${employee!.name}.`
    : `As of ${wait.since}, ${employee!.name} waits for you on #${task.number}: ${wait.reason}, until ${wait.until}. Check the task's current state and give the employee what they need.`;
  return {
    companyId: task.companyId, agentId: wait.on.employee, dedupKey: `request:${task.id}:${waiter}:${wait.on.employee}:${episode}`,
    message: await notificationMessage(ctx, task.companyId, wait.work ? 'work_requested' : 'wait_requested', text, { actor: { agentId: waiter }, tasks: [{ id: task.id, number: task.number }] }),
    guard: { tasks: [], waitOn: { taskId: task.id, employee: wait.on.employee, episode } },
  };
}

/* The notice of the episode says the wait as it is now until it went out. One that was dropped unsent comes back free of its
   old claim, as nobody heard it; one being sent keeps its claim. */
export async function recordRequestedNotice(db: Writer, notice: NewWaitNotice): Promise<void> {
  const dropped = sql`${waitNotices.cancelledAt} is not null`;
  await db.insert(waitNotices).values(notice).onConflictDoUpdate({
    target: [waitNotices.companyId, waitNotices.dedupKey], setWhere: isNull(waitNotices.deliveredAt),
    set: {
      message: notice.message, guard: notice.guard, cancelledAt: null,
      leaseId: sql`case when ${dropped} then null else ${waitNotices.leaseId} end`, leaseUntil: sql`case when ${dropped} then null else ${waitNotices.leaseUntil} end`,
    },
  });
}

/* A request holds while the task still depends on that employee in that episode. */
async function waitOnStands(db: Pick<Db, 'select'>, companyId: string, guard: NonNullable<WaitNoticeGuard['waitOn']>, now: Date): Promise<boolean> {
  const [task] = await db.select(only(tasks, 'externalWait')).from(tasks).where(and(eq(tasks.id, guard.taskId), eq(tasks.companyId, companyId)));
  const wait = task?.externalWait;
  if (wait?.on?.kind !== 'employee' || wait.on.employee !== guard.employee || new Date(wait.until) <= now) return false;
  return (await waitEpisode(db, guard.taskId)) === guard.episode;
}

/* A notice about a wait holds while that wait stands as it was written for. A task moving on does not spoil it, and a date
   passing is why it was written. */
async function waitStands(db: Pick<Db, 'select'>, guard: NonNullable<WaitNoticeGuard['wait']>): Promise<boolean> {
  const [wait] = await db.select().from(taskWaits).where(eq(taskWaits.id, guard.id));
  if (!wait || wait.state !== 'active' || wait.generation !== guard.generation || wait.routeRevision !== guard.routeRevision) return false;
  return guard.level !== undefined ? wait.level === guard.level : wait.reviewOrdinal === guard.ordinal;
}

async function stillCurrent(ctx: Ctx, notice: Notice, now: Date): Promise<boolean> {
  if (notice.guard.wait) return waitStands(ctx.db, notice.guard.wait);
  if (notice.guard.waitOn) return waitOnStands(ctx.db, notice.companyId, notice.guard.waitOn, now);
  if (notice.guard.goal) return goalStands(ctx.db, notice.guard.goal);
  const expected = notice.guard.tasks;
  const rows = await ctx.db.select().from(tasks).where(and(eq(tasks.companyId, notice.companyId), inArray(tasks.id, expected.map(t => t.id))));
  if (!expected.every(t => rows.some(row => row.id === t.id && row.version === t.version))) return false;
  const quiet = notice.guard.quiet;
  if (quiet) return (await quietDepartment(ctx, quiet.turnId, quiet.departmentId, now))?.key === quiet.key;
  return rows.every(row => row.externalWait && new Date(row.externalWait.until) > now);
}

async function claimNotice(ctx: Ctx, id: string, agentId: string, now: Date): Promise<Notice | undefined> {
  const [claimed] = await ctx.db.update(waitNotices).set({ agentId, leaseId: randomUUID(), leaseUntil: new Date(now.getTime() + LEASE_MS) }).where(and(
    eq(waitNotices.id, id), pending, or(isNull(waitNotices.leaseUntil), lte(waitNotices.leaseUntil, now)),
  )).returning();
  return claimed;
}

async function deliverNotice(ctx: Ctx, notice: Notice, now: Date): Promise<boolean> {
  if (!(await stillCurrent(ctx, notice, now))) {
    await ctx.db.update(waitNotices).set({ cancelledAt: now }).where(and(eq(waitNotices.id, notice.id), eq(waitNotices.leaseId, notice.leaseId!)));
    return false;
  }
  const [recipient] = await ctx.db.select().from(agents).where(and(eq(agents.id, notice.agentId!), eq(agents.companyId, notice.companyId), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  if (!recipient || !(await liveSubscription(ctx, recipient.id))) return false;
  const message = { ...notice.message, waitNotice: notice.id };
  await insertOrDeliverTurn(ctx, {
    companyId: notice.companyId, agentId: recipient.id, createdBy: null, prompt: message.text, message,
    withMessage: async tx => {
      const [kept] = await tx.update(waitNotices).set({ deliveredAt: now }).where(and(eq(waitNotices.id, notice.id), eq(waitNotices.leaseId, notice.leaseId!), pending)).returning({ id: waitNotices.id });
      if (!kept) throw new Error('The wait notice claim changed before its message was kept.');
    },
  });
  return true;
}

async function noticeRecipient(ctx: Ctx, notice: Notice): Promise<string | null> {
  if (notice.guard.quiet) return quietRecipient(ctx, notice.companyId, notice.guard.quiet.departmentId);
  if (notice.message.notification.source === 'wait_cycle') return waitOrchestrator(ctx, notice.companyId);
  return notice.agentId;
}

/* A goal alert holds while that episode stands at that revision: an answer to its question does not touch it. */
async function goalStands(db: Pick<Db, 'select'>, guard: NonNullable<WaitNoticeGuard['goal']>): Promise<boolean> {
  const [request] = await db.select({ episode: requests.goalEpisodeId, revision: requests.goalRevision, state: requests.goalState }).from(requests).where(eq(requests.id, guard.requestId));
  return request?.state === 'open' && request.episode === guard.episodeId && request.revision === guard.revision;
}

/* What must still be true of a card. A turn's summary says what was recorded when it closed, which stays true. */
async function cardStands(db: Pick<Db, 'select'>, guard: WaitNoticeGuard): Promise<boolean> {
  if (guard.turn) return true;
  if (guard.goal) return goalStands(db, guard.goal);
  return guard.wait ? waitStands(db, guard.wait) : false;
}

async function cardTask(db: Pick<Db, 'select'>, card: Notice): Promise<Task | null> {
  const [wait] = card.waitId ? await db.select(only(taskWaits, 'taskId')).from(taskWaits).where(eq(taskWaits.id, card.waitId)) : [];
  const taskId = wait?.taskId ?? card.guard.turn?.taskId;
  const [task] = taskId ? await db.select().from(tasks).where(eq(tasks.id, taskId)) : [];
  return task ?? null;
}

/* A person's card: the notice kept for them, its log line and that it went out are one write. What people see moves after it. */
async function deliverCard(ctx: Ctx, notice: Notice, now: Date): Promise<void> {
  const kept = await ctx.db.transaction(async tx => {
    const [card] = await tx.select().from(waitNotices).where(and(eq(waitNotices.id, notice.id), pending)).for('update');
    if (!card) return null;
    const task = await cardTask(tx, card);
    if (!task || !(await cardStands(tx, card.guard)) || !(await mayHear(tx, card.personId!, task))) {
      await tx.update(waitNotices).set({ cancelledAt: now }).where(eq(waitNotices.id, card.id));
      return null;
    }
    await tx.update(waitNotices).set({ deliveredAt: now }).where(eq(waitNotices.id, card.id));
    await ownNote(tx, task, { kind: 'wait_card', text: 'A person was given a card about this task.', data: { notice: card.id, personId: card.personId, level: card.level } });
    return task;
  });
  if (kept) ctx.bus.publish(kept.companyId, { type: 'requests', spot: taskSpot(kept) });
}

/* Whoever a card is for must still be here and reach the task, as of now. */
async function mayHear(tx: Tx, personId: string, task: Task): Promise<boolean> {
  const [person] = await tx.select({ id: people.id, status: people.status, scopeKind: people.scopeKind }).from(people).where(and(eq(people.id, personId), eq(people.companyId, task.companyId)));
  return person?.status === 'active' && canReach(await accessOf(tx, person), taskSpot(task));
}

async function sendNotice(ctx: Ctx, pendingNotice: Notice, now: Date): Promise<void> {
  if (pendingNotice.personId) return deliverCard(ctx, pendingNotice, now);
  const agentId = await noticeRecipient(ctx, pendingNotice);
  if (!agentId) return;
  const accepted = await withInputLock(ctx, agentId, async () => {
    const at = new Date(Math.max(now.getTime(), Date.now()));
    const claimed = await claimNotice(ctx, pendingNotice.id, agentId, at);
    return claimed ? deliverNotice(ctx, claimed, at) : false;
  });
  if (accepted) await pump(ctx, agentId);
}

/* A claim survives interrupted sends. Message acceptance and outbox completion commit together. */
export async function deliverWaitNotices(ctx: Ctx, now = new Date()): Promise<void> {
  const paused = await pausedCompanyIds(ctx.db);
  const due = await ctx.db.select().from(waitNotices).where(and(pending, or(isNull(waitNotices.leaseUntil), lte(waitNotices.leaseUntil, now)))).orderBy(asc(waitNotices.createdAt));
  await Promise.all(due.filter(row => !paused.has(row.companyId)).map(async row => {
    try { await sendNotice(ctx, row, now); }
    catch (error) { ctx.log.error({ error: loggable(error), waitNotice: row.id }, 'Delivering a wait notice failed.'); }
  }));
}
