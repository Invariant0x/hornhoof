import type { WaitSourceKind } from '@hornhoof/protocol/waits';
import { and, desc, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { AgentViewer } from '../../auth/agent-view.js';
import { canReach } from '../../auth/access.js';
import { tasks, taskWaits, turns, waitNotices } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { ownNote, taskSpot } from './engine.js';
import { pageAfter, type WaitPlace } from './wait-views.js';

/* The cards kept for a person about waits past their dates: only their own, of what they reach, until they say they saw them.
   Seeing one decides nothing: no question it speaks of is answered, and no approval is given or changed. */

type WaitCardKind = 'late' | 'final_review' | 'goal_risk' | 'turn_summary' | 'release_tag';
/* words: what Hornhoof wrote for them, which holds no words of the work itself. turn: the turn a summary or a tag is of, with
   the version it came out as; tag: the version a tag that released nothing names, and why. A screen says them in the
   person's language. */
export type WaitCard = {
  id: string; about: WaitCardKind; taskId: string | null; number: number | null; kind: WaitSourceKind | null; level: number | null; words: string; at: string;
  turn: { number: number; version: string | null } | null; tag: { version: string; why: 'unrecorded' | 'stale' } | null;
};
type CardPage = { cards: WaitCard[]; next: string | null };

const aboutOf = (card: typeof waitNotices.$inferSelect): WaitCardKind => {
  if (card.guard.tag) return 'release_tag';
  if (card.guard.turn) return 'turn_summary';
  if (card.guard.goal) return 'goal_risk';
  return card.guard.wait?.ordinal !== undefined ? 'final_review' : 'late';
};

const olderThan = (place: WaitPlace | null) => (place
  ? or(lt(waitNotices.createdAt, place.at), and(eq(waitNotices.createdAt, place.at), lt(waitNotices.id, place.id)))
  : undefined);

type CardRow = { card: typeof waitNotices.$inferSelect; kind: WaitSourceKind | null; waitTask: string | null };
const taskIdOf = (row: CardRow): string | null => row.waitTask ?? row.card.guard.turn?.taskId ?? null;

type TurnOf = Pick<typeof turns.$inferSelect, 'id' | 'number' | 'version'>;
const cardOf = (row: CardRow, task: typeof tasks.$inferSelect, turn: TurnOf | undefined): WaitCard => ({
  id: row.card.id, about: aboutOf(row.card), taskId: task.id, number: task.number, kind: row.kind, level: row.card.level, words: row.card.message.text, at: row.card.createdAt.toISOString(),
  turn: turn ? { number: turn.number, version: turn.version } : null,
  tag: row.card.guard.tag ? { version: row.card.guard.tag.version, why: row.card.guard.tag.why } : null,
});

export async function waitCards(ctx: Pick<Ctx, 'db'>, viewer: AgentViewer, page: { limit: number; before: WaitPlace | null }): Promise<CardPage> {
  const rows: CardRow[] = await ctx.db.select({ card: waitNotices, kind: taskWaits.kind, waitTask: taskWaits.taskId }).from(waitNotices)
    .leftJoin(taskWaits, eq(taskWaits.id, waitNotices.waitId))
    .where(and(eq(waitNotices.personId, viewer.personId), isNotNull(waitNotices.deliveredAt), isNull(waitNotices.acknowledgedAt), olderThan(page.before)))
    .orderBy(desc(waitNotices.createdAt), desc(waitNotices.id)).limit(page.limit + 1);
  const shown = rows.slice(0, page.limit);
  const ids = shown.flatMap(row => taskIdOf(row) ?? []);
  const places = ids.length ? await ctx.db.select().from(tasks).where(inArray(tasks.id, ids)) : [];
  const turnIds = shown.flatMap(row => row.card.guard.turn?.id ?? []);
  const of = turnIds.length ? await ctx.db.select({ id: turns.id, number: turns.number, version: turns.version }).from(turns).where(inArray(turns.id, turnIds)) : [];
  const cards = shown.flatMap(row => {
    const task = places.find(t => t.id === taskIdOf(row));
    return task && canReach(viewer.access, taskSpot(task)) ? [cardOf(row, task, of.find(turn => turn.id === row.card.guard.turn?.id))] : [];
  });
  return { cards, next: rows.length > page.limit ? pageAfter(shown.at(-1)!.card) : null };
}

/* The person says they saw their own card; false for one that is not theirs. Saying it again changes nothing. */
export async function acknowledgeCard(ctx: Pick<Ctx, 'db'>, personId: string, id: string, now = new Date()): Promise<boolean> {
  return ctx.db.transaction(async tx => {
    const [card] = await tx.select().from(waitNotices).where(and(eq(waitNotices.id, id), eq(waitNotices.personId, personId), isNotNull(waitNotices.deliveredAt))).for('update');
    if (!card) return false;
    if (card.acknowledgedAt) return true;
    const [wait] = card.waitId ? await tx.select(only(taskWaits, 'taskId')).from(taskWaits).where(eq(taskWaits.id, card.waitId)) : [];
    await tx.update(waitNotices).set({ acknowledgedAt: now, acknowledgedByPersonId: personId }).where(eq(waitNotices.id, id));
    const taskId = wait?.taskId ?? card.guard.turn?.taskId;
    if (taskId) await ownNote(tx, { id: taskId, companyId: card.companyId }, { kind: 'wait_card', text: 'A person said they saw their card about this task.', data: { notice: id, personId, acknowledged: true } });
    return true;
  });
}
