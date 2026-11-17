import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { backlogItems, people } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import type { Tx } from '../tasks/engine.js';

export type BacklogItem = typeof backlogItems.$inferSelect;
export type BacklogItemView = { id: string; departmentId: string; title: string; text: string; by: { id: string; name: string }; at: string };

const changed = () => new ApiError(409, 'conflict', 'The list changed meanwhile: some of these items are no longer in it. Read it again.', 'backlog_changed');

/* People of the department and the orchestrator hear that its list changed. */
export const backlogChanged = (ctx: Pick<Ctx, 'bus'>, companyId: string, departmentId: string) =>
  ctx.bus.publish(companyId, { type: 'backlog', spot: { departmentId, parentId: null } });

/* The items of a department, or of every department, first to go first, each with who put it there. */
export async function listBacklog(db: Pick<Db, 'select'>, companyId: string, departmentId?: string): Promise<BacklogItemView[]> {
  const rows = await db
    .select({ item: backlogItems, by: { id: people.id, name: people.name } })
    .from(backlogItems)
    .innerJoin(people, eq(people.id, backlogItems.createdByPersonId))
    .where(and(eq(backlogItems.companyId, companyId), departmentId ? eq(backlogItems.departmentId, departmentId) : undefined))
    .orderBy(asc(backlogItems.position), asc(backlogItems.createdAt));
  return rows.map(({ item, by }) => ({ id: item.id, departmentId: item.departmentId, title: item.title, text: item.text, by, at: item.createdAt.toISOString() }));
}

/* A new item goes to the end of its department's list. */
export async function addBacklogItem(db: Db, companyId: string, departmentId: string, personId: string, input: { title: string; text: string }): Promise<BacklogItem> {
  const last = sql<number>`(select coalesce(max(${backlogItems.position}), -1) + 1 from ${backlogItems} where ${backlogItems.departmentId} = ${departmentId})`;
  const [row] = await db.insert(backlogItems).values({ companyId, departmentId, title: input.title, text: input.text, position: last, createdByPersonId: personId }).returning();
  return row!;
}

/* The whole list in a new order. An order that leaves out an item or names one that is gone is refused, so two people
   moving items at once cannot lose one. */
export async function reorderBacklog(db: Db, companyId: string, departmentId: string, ids: readonly string[]): Promise<void> {
  await db.transaction(async tx => {
    const there = await tx.select(idOnly(backlogItems)).from(backlogItems).where(and(eq(backlogItems.companyId, companyId), eq(backlogItems.departmentId, departmentId))).for('update');
    const known = new Set(there.map(r => r.id));
    if (new Set(ids).size !== ids.length || ids.length !== known.size || ids.some(id => !known.has(id))) throw changed();
    for (const [position, id] of ids.entries()) await tx.update(backlogItems).set({ position }).where(eq(backlogItems.id, id));
  });
}

export async function removeBacklogItem(db: Db, companyId: string, departmentId: string, id: string): Promise<void> {
  const [gone] = await db
    .delete(backlogItems)
    .where(and(eq(backlogItems.id, id), eq(backlogItems.companyId, companyId), eq(backlogItems.departmentId, departmentId)))
    .returning({ id: backlogItems.id });
  if (!gone) throw new ApiError(404, 'not_found', 'This item is not in the list.', 'backlog_unknown');
}

const inOrder = (rows: BacklogItem[], ids: readonly string[]): BacklogItem[] => {
  if (new Set(ids).size !== ids.length || rows.length !== ids.length) throw changed();
  return ids.map(id => rows.find(r => r.id === id)!);
};
const named = (companyId: string, ids: readonly string[], departmentId?: string) =>
  and(eq(backlogItems.companyId, companyId), inArray(backlogItems.id, [...ids]), departmentId ? eq(backlogItems.departmentId, departmentId) : undefined);

/* The items named, in the order named, all of them still in the list (of this department, when one is given). */
export async function readBacklog(db: Pick<Db, 'select'>, companyId: string, ids: readonly string[], departmentId?: string): Promise<BacklogItem[]> {
  return inOrder(ids.length ? await db.select().from(backlogItems).where(named(companyId, ids, departmentId)) : [], ids);
}

/* Takes the items named out of the list as they go into a turn, inside its transaction: any one gone meanwhile refuses all. */
export async function takeBacklog(tx: Tx, companyId: string, ids: readonly string[], departmentId?: string): Promise<BacklogItem[]> {
  return inOrder(ids.length ? await tx.delete(backlogItems).where(named(companyId, ids, departmentId)).returning() : [], ids);
}
