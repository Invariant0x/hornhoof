import type { WaitSourceKind } from '@hornhoof/protocol/waits';
import { and, desc, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { AgentViewer } from '../../auth/agent-view.js';
import { canReach } from '../../auth/access.js';
import { tasks, taskWaits, waitNotices } from '../../db/schema.js';
import { ownNote, taskSpot } from './engine.js';
import { pageAfter, type WaitPlace } from './wait-views.js';

/* The cards kept for a person about waits past their dates: only their own, of what they reach, until they say they saw them.
   Seeing one decides nothing: no question it speaks of is answered, and no approval is given or changed. */

export type WaitCardKind = 'late' | 'final_review' | 'goal_risk' | 'turn_summary';
/* words: what Hornhoof wrote for them, which holds no words of the work itself. */
export type WaitCard = { id: string; about: WaitCardKind; taskId: string | null; number: number | null; kind: WaitSourceKind | null; level: number | null; words: string; at: string };
export type CardPage = { cards: WaitCard[]; next: string | null };

const aboutOf = (card: typeof waitNotices.$inferSelect): WaitCardKind => {
  if (card.guard.turn) return 'turn_summary';
  if (card.guard.goal) return 'goal_risk';
  return card.guard.wait?.ordinal !== undefined ? 'final_review' : 'late';
};

export async function waitCards(ctx: Pick<Ctx, 'db'>, viewer: AgentViewer, page: { limit: number; before: WaitPlace | null }): Promise<CardPage> {
  const rows = await ctx.db.select({ card: waitNotices, kind: taskWaits.kind, waitTask: taskWaits.taskId }).from(waitNotices)
    .leftJoin(taskWaits, eq(taskWaits.id, waitNotices.waitId))
    .where(and(
      eq(waitNotices.personId, viewer.personId), isNotNull(waitNotices.deliveredAt), isNull(waitNotices.acknowledgedAt),
      page.before ? or(lt(waitNotices.createdAt, page.before.at), and(eq(waitNotices.createdAt, page.before.at), lt(waitNotices.id, page.before.id))) : undefined,
    )).orderBy(desc(waitNotices.createdAt), desc(waitNotices.id)).limit(page.limit + 1);
  const shown = rows.slice(0, page.limit);
  const taskIdOf = (row: (typeof shown)[number]) => row.waitTask ?? row.card.guard.turn?.taskId ?? null;
  const ids = shown.flatMap(row => taskIdOf(row) ?? []);
  const places = ids.length ? await ctx.db.select().from(tasks).where(inArray(tasks.id, ids)) : [];
  const cards = shown.flatMap(row => {
    const task = places.find(t => t.id === taskIdOf(row));
    if (!task || !canReach(viewer.access, taskSpot(task))) return [];
    return [{ id: row.card.id, about: aboutOf(row.card), taskId: task.id, number: task.number, kind: row.kind, level: row.card.level, words: row.card.message.text, at: row.card.createdAt.toISOString() }];
  });
  return { cards, next: rows.length > page.limit ? pageAfter(shown.at(-1)!.card) : null };
}

/* The person says they saw their own card; false for one that is not theirs. Saying it again changes nothing. */
export async function acknowledgeCard(ctx: Pick<Ctx, 'db'>, personId: string, id: string, now = new Date()): Promise<boolean> {
  return ctx.db.transaction(async tx => {
    const [card] = await tx.select().from(waitNotices).where(and(eq(waitNotices.id, id), eq(waitNotices.personId, personId), isNotNull(waitNotices.deliveredAt))).for('update');
    if (!card) return false;
    if (card.acknowledgedAt) return true;
    const [wait] = card.waitId ? await tx.select({ taskId: taskWaits.taskId }).from(taskWaits).where(eq(taskWaits.id, card.waitId)) : [];
    await tx.update(waitNotices).set({ acknowledgedAt: now, acknowledgedByPersonId: personId }).where(eq(waitNotices.id, id));
    const taskId = wait?.taskId ?? card.guard.turn?.taskId;
    if (taskId) await ownNote(tx, { id: taskId, companyId: card.companyId }, { kind: 'wait_card', text: 'A person said they saw their card about this task.', data: { notice: id, personId, acknowledged: true } });
    return true;
  });
}
