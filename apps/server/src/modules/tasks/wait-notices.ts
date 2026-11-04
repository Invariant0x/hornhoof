import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { agents, tasks, waitNotices } from '../../db/schema.js';
import { loggable } from '../../errors.js';
import { enqueueTurn, liveSubscription } from '../conversation/queue.js';
import { notificationMessage } from '../events/notifications.js';
import type { Task } from './engine.js';
import { quietDepartment } from './wait-observations.js';

type Writer = Pick<Db, 'insert'>;
export type NewWaitNotice = typeof waitNotices.$inferInsert;
type Notice = typeof waitNotices.$inferSelect;
const pending = and(isNull(waitNotices.deliveredAt), isNull(waitNotices.cancelledAt));
const LEASE_MS = 2 * 60_000;

export async function recordWaitNotice(db: Writer, notice: NewWaitNotice): Promise<void> {
  await db.insert(waitNotices).values(notice).onConflictDoNothing({ target: [waitNotices.companyId, waitNotices.dedupKey] });
}

export async function requestedWaitNotice(ctx: Ctx, task: Task, waiter: string): Promise<NewWaitNotice | null> {
  const wait = task.externalWait;
  if (wait?.on?.kind !== 'employee') return null;
  const [employee] = await ctx.db.select().from(agents).where(eq(agents.id, waiter));
  const text = `As of ${wait.since}, ${employee!.name} waits for you on #${task.number}: ${wait.reason}, until ${wait.until}. Check the task's current state and give the employee what they need.`;
  return {
    companyId: task.companyId, agentId: wait.on.employee, dedupKey: `request:${task.id}:${task.version}`,
    message: await notificationMessage(ctx, task.companyId, 'wait_requested', text, { actor: { agentId: waiter }, tasks: [{ id: task.id, number: task.number }] }),
    guard: { tasks: [{ id: task.id, version: task.version }] },
  };
}

async function stillCurrent(ctx: Ctx, notice: Notice, now: Date): Promise<boolean> {
  const expected = notice.guard.tasks;
  const rows = await ctx.db.select().from(tasks).where(and(eq(tasks.companyId, notice.companyId), inArray(tasks.id, expected.map(t => t.id))));
  if (!expected.every(t => rows.some(row => row.id === t.id && row.version === t.version))) return false;
  const quiet = notice.guard.quiet;
  if (quiet) return (await quietDepartment(ctx, quiet.turnId, quiet.departmentId, now))?.key === quiet.key;
  return rows.every(row => row.externalWait && new Date(row.externalWait.until) > now);
}

async function claimNotice(ctx: Ctx, id: string, now: Date): Promise<Notice | undefined> {
  const [claimed] = await ctx.db.update(waitNotices).set({ leaseId: randomUUID(), leaseUntil: new Date(now.getTime() + LEASE_MS) }).where(and(
    eq(waitNotices.id, id), pending, or(isNull(waitNotices.leaseUntil), lte(waitNotices.leaseUntil, now)),
  )).returning();
  return claimed;
}

async function deliverNotice(ctx: Ctx, notice: Notice, now: Date): Promise<void> {
  if (!(await stillCurrent(ctx, notice, now))) {
    await ctx.db.update(waitNotices).set({ cancelledAt: now }).where(and(eq(waitNotices.id, notice.id), eq(waitNotices.leaseId, notice.leaseId!)));
    return;
  }
  const [recipient] = await ctx.db.select().from(agents).where(and(eq(agents.id, notice.agentId), eq(agents.companyId, notice.companyId), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  if (!recipient || !(await liveSubscription(ctx, recipient.id))) return;
  const message = { ...notice.message, waitNotice: notice.id };
  await enqueueTurn(ctx, {
    companyId: notice.companyId, agentId: recipient.id, createdBy: null, prompt: message.text, message,
    withMessage: async tx => {
      const [kept] = await tx.update(waitNotices).set({ deliveredAt: now }).where(and(eq(waitNotices.id, notice.id), eq(waitNotices.leaseId, notice.leaseId!), pending)).returning({ id: waitNotices.id });
      if (!kept) throw new Error('The wait notice claim changed before its message was kept.');
    },
  });
}

/* A claim survives interrupted sends. Message acceptance and outbox completion commit together. */
export async function deliverWaitNotices(ctx: Ctx, now = new Date()): Promise<void> {
  const due = await ctx.db.select({ id: waitNotices.id }).from(waitNotices).where(and(pending, or(isNull(waitNotices.leaseUntil), lte(waitNotices.leaseUntil, now)))).orderBy(asc(waitNotices.createdAt));
  for (const row of due) {
    const notice = await claimNotice(ctx, row.id, now);
    if (!notice) continue;
    try { await deliverNotice(ctx, notice, now); }
    catch (error) { ctx.log.error({ error: loggable(error), waitNotice: notice.id }, 'Delivering a wait notice failed.'); }
  }
}
