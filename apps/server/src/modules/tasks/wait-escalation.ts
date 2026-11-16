import type { WaitOwnerBinding, WaitSourceKind } from '@hornhoof/protocol/waits';
import { and, asc, eq, isNull, like, lte, not, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, people, tasks, taskWaits, waitNotices } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { loggable } from '../../errors.js';
import { notificationMessage } from '../events/notifications.js';
import { ownNote, type Task, type Tx } from './engine.js';
import { recordWaitNotice } from './wait-notices.js';
import { departmentHead, waitRoute, type WaitRoute } from './wait-policy.js';
import { claimFinalReview, waitOwner, type TaskWait } from './wait-state.js';

/* The sweep that raises a wait past its date one level at a time: its owner, then its head, then whom its department named.
   Dates never move, a late sweep takes one level and no more, and the next level's date is already there to be seen. It says
   a wait is late, never that what it waited for did or did not happen. */

const SWEEP_SIZE = 200;
const LEVELS = { owner: 1, head: 2, department: 3 } as const;

/* An external operation has one signal of its own, which is not this. */
const ours = not(like(taskWaits.sourceKey, 'operation:%'));
const dueBy = (column: typeof taskWaits.nextActionAt | typeof taskWaits.nextReviewAt, now: Date, more = sql`true`) =>
  and(eq(taskWaits.state, 'active'), lte(column, now), ours, more);

const SOURCE_WORDS: Record<WaitSourceKind, string> = {
  after: 'a task it comes after', review: 'a review', person: "a person's answer", run: 'a run', external: 'an external event',
};

type Found = { task: Task; wait: TaskWait };

/* The task first and then its wait, in the order everything else takes them, and as they are now. */
async function lockedWait(tx: Tx, id: string): Promise<Found | null> {
  const [seen] = await tx.select({ taskId: taskWaits.taskId }).from(taskWaits).where(eq(taskWaits.id, id));
  if (!seen) return null;
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, seen.taskId)).for('update');
  const [wait] = await tx.select().from(taskWaits).where(eq(taskWaits.id, id)).for('update');
  return task && wait ? { task, wait } : null;
}

/* A person who owns a wait and is the CEO has the question itself waiting on their card: being late asks nothing more of them. */
async function ownerToTell(tx: Tx, wait: TaskWait): Promise<WaitOwnerBinding | null> {
  const owner = waitOwner(wait);
  if (!owner || 'agentId' in owner) return owner;
  const [person] = await tx.select({ isOwner: people.isOwner }).from(people).where(eq(people.id, owner.personId));
  return person?.isOwner ? null : owner;
}

async function liveAgent(tx: Tx, id: string | undefined): Promise<string | null> {
  if (!id) return null;
  const [agent] = await tx.select(idOnly(agents)).from(agents).where(and(eq(agents.id, id), isNull(agents.removedAt)));
  return agent?.id ?? null;
}

/* The head as it is now, else the one its plan names. */
async function headToTell(tx: Tx, task: Task, wait: TaskWait): Promise<string | null> {
  const now = task.departmentId ? await departmentHead(tx, task.departmentId) : null;
  return now ?? liveAgent(tx, wait.plan?.finalReview.headAgentId);
}

/* Who hears at this level, if anyone. The CEO decides where a department named nobody, and hears nothing for it. */
async function recipientAt(tx: Tx, found: Found, level: number, route: WaitRoute): Promise<WaitOwnerBinding | null> {
  if (level === LEVELS.owner) return ownerToTell(tx, found.wait);
  if (level === LEVELS.head) {
    const agentId = await headToTell(tx, found.task, found.wait);
    return agentId ? { agentId } : null;
  }
  return route.fallbackToCeo || !route.finalDecisionPersonId ? null : { personId: route.finalDecisionPersonId };
}

/* The holder who answers for its own wait has its own dates to wake it: nobody tells them they wait for themselves. */
const holderItself = (found: Found, who: WaitOwnerBinding): boolean =>
  'agentId' in who && who.agentId === found.task.assigneeAgentId && who.agentId === found.wait.ownerAgentId;
const heardAlready = (wait: TaskWait, who: WaitOwnerBinding): boolean => ('agentId' in who ? wait.attentionAgentId === who.agentId : wait.attentionPersonId === who.personId);
const attentionOf = (who: WaitOwnerBinding) => ('agentId' in who ? { attentionAgentId: who.agentId, attentionPersonId: null } : { attentionAgentId: null, attentionPersonId: who.personId });

const ROLE_WORDS: Record<number, string> = {
  [LEVELS.owner]: 'You answer for it. Move what it waits for, or say who promised which new dates.',
  [LEVELS.head]: 'Its owner has passed their date and you are its head. See what its owner needs, or give it to someone who can finish it.',
  [LEVELS.department]: 'Its owner and its head have passed their dates and it is yours to decide.',
};

function lateWords(wait: TaskWait, task: Task, level: number, now: Date): string {
  const passed = [wait.ownerDueAt, wait.headDueAt, wait.decisionDueAt][level - 1]!;
  return `As of ${now.toISOString()}, the wait on #${task.number} for ${SOURCE_WORDS[wait.kind]} is past its date of ${passed.toISOString()}. ${ROLE_WORDS[level]}`;
}

const nextOf = (wait: TaskWait, level: number): Date => (level === LEVELS.owner ? wait.headDueAt! : wait.decisionDueAt!);

type NoticeFor = { who: WaitOwnerBinding; purpose: string; level: number; words: string; guard: { level?: number; ordinal?: number } };

const recipientColumns = (who: WaitOwnerBinding) => ('agentId' in who ? { agentId: who.agentId, personId: null } : { agentId: null, personId: who.personId });

async function keepNotice(ctx: Ctx, tx: Tx, task: Task, wait: Pick<TaskWait, 'id' | 'generation' | 'routeRevision'>, notice: NoticeFor): Promise<void> {
  await recordWaitNotice(tx, {
    companyId: task.companyId, ...recipientColumns(notice.who), dedupKey: `wait:${wait.id}:${wait.generation}:${notice.level}:${notice.purpose}:${wait.routeRevision}`,
    waitId: wait.id, generation: wait.generation, level: notice.level, purpose: notice.purpose, routeRevision: wait.routeRevision,
    guard: { tasks: [], wait: { id: wait.id, generation: wait.generation, routeRevision: wait.routeRevision, ...notice.guard } },
    message: await notificationMessage(ctx, task.companyId, 'wait_overdue', notice.words, { tasks: [{ id: task.id, number: task.number }] }),
  });
}

/* What is still waiting to go out for this kind of notice on the wait is over: the newer one says all of it. */
const dropPending = (tx: Tx, waitId: string, purpose: string, now: Date) =>
  tx.update(waitNotices).set({ cancelledAt: now }).where(and(eq(waitNotices.waitId, waitId), like(waitNotices.purpose, purpose), isNull(waitNotices.deliveredAt), isNull(waitNotices.cancelledAt)));

const routeChanged = (wait: TaskWait, route: WaitRoute): boolean => wait.finalDecisionPersonId !== route.finalDecisionPersonId || wait.fallbackToCeo !== route.fallbackToCeo;

/* One level up, with its log line and its notice in one write, or none of it. */
async function raise(ctx: Ctx, tx: Tx, found: Found, now: Date): Promise<void> {
  const { task, wait } = found;
  const level = wait.level + 1;
  const route = await waitRoute(tx, task);
  const routeRevision = wait.routeRevision + (routeChanged(wait, route) ? 1 : 0);
  const who = await recipientAt(tx, found, level, route);
  const collapsed = who !== null && level > LEVELS.owner && heardAlready(wait, who);
  await tx.update(taskWaits).set({ level, nextActionAt: nextOf(wait, level), ...route, routeRevision, ...(who ? attentionOf(who) : {}), updatedAt: now }).where(eq(taskWaits.id, wait.id));
  await dropPending(tx, wait.id, 'escalation', now);
  await ownNote(tx, task, { kind: 'wait_due', text: `A wait on this task passed its date and went up to level ${level}.`, data: { wait: { id: wait.id, kind: wait.kind, generation: wait.generation, level, routeRevision }, ...(collapsed ? { collapsed } : {}) } });
  if (who && !collapsed && !holderItself(found, who)) await keepNotice(ctx, tx, task, { id: wait.id, generation: wait.generation, routeRevision }, { who, purpose: 'escalation', level, words: lateWords(wait, task, level, now), guard: { level } });
}

async function stepWait(ctx: Ctx, id: string, now: Date): Promise<void> {
  await ctx.db.transaction(async tx => {
    const found = await lockedWait(tx, id);
    if (found && found.wait.state === 'active' && found.wait.level < LEVELS.department && found.wait.nextActionAt! <= now) await raise(ctx, tx, found, now);
  });
}

/* The head looks at it again on the sequence its plan declares. What was missed is counted by the claim and not sent. */
async function reviewWait(ctx: Ctx, id: string, now: Date): Promise<void> {
  await ctx.db.transaction(async tx => {
    const found = await lockedWait(tx, id);
    if (!found) return;
    const step = await claimFinalReview(tx, { waitId: id, expectedGeneration: found.wait.generation, at: now });
    if (!step) return;
    await dropPending(tx, id, 'final_review:%', now);
    const agentId = await headToTell(tx, found.task, step.wait);
    if (!agentId) return;
    const words = `As of ${now.toISOString()}, the wait on #${found.task.number} for ${SOURCE_WORDS[step.wait.kind]} is still open: this is your review number ${step.ordinal} of it. See that someone is on it, or say who decides.`;
    await keepNotice(ctx, tx, found.task, step.wait, { who: { agentId }, purpose: `final_review:${step.ordinal}`, level: step.wait.level, words, guard: { ordinal: step.ordinal } });
  });
}

async function eachDue(ctx: Ctx, ids: { id: string }[], step: (id: string) => Promise<void>): Promise<void> {
  for (const { id } of ids) {
    try { await step(id); }
    catch (error) { ctx.log.error({ error: loggable(error), wait: id }, 'Raising a wait past its date failed.'); }
  }
}

/* Called with the rest of the wait checks, once a minute. A wait that fails is taken again in the next round, whole. */
export async function sweepWaits(ctx: Ctx, now = new Date()): Promise<void> {
  const late = await ctx.db.select(idOnly(taskWaits)).from(taskWaits).where(dueBy(taskWaits.nextActionAt, now, sql`${taskWaits.level} < ${LEVELS.department}`)).orderBy(asc(taskWaits.nextActionAt)).limit(SWEEP_SIZE);
  await eachDue(ctx, late, id => stepWait(ctx, id, now));
  const reviews = await ctx.db.select(idOnly(taskWaits)).from(taskWaits).where(dueBy(taskWaits.nextReviewAt, now)).orderBy(asc(taskWaits.nextReviewAt)).limit(SWEEP_SIZE);
  await eachDue(ctx, reviews, id => reviewWait(ctx, id, now));
}
