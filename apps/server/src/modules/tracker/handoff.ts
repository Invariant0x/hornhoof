import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { departments, goals, tasks } from '../../db/schema.js';
import { CLOSED, ownNote, published, taskSpot } from '../tasks/engine.js';
import { nextRevision } from './edit.js';
import { goalNote } from './goals.js';
import { ownersOf, type Owners } from './responsible.js';

const passedOn = (o: Owners, from: string, to: string) => ({
  text: `${o.name(from)} no longer reaches this place, so ${o.name(to)} answers for it now.`,
  data: { fields: ['responsible'], from, to },
});

async function passTasks(ctx: Pick<Ctx, 'db' | 'bus'>, o: Owners, companyId: string, personId: string): Promise<void> {
  const held = await ctx.db.select().from(tasks).where(and(eq(tasks.companyId, companyId), eq(tasks.responsiblePersonId, personId), notInArray(tasks.status, [...CLOSED])));
  for (const task of held) {
    const spot = taskSpot(task);
    if (o.reaches(personId, spot)) continue;
    const to = o.owner(spot);
    if (to === personId) continue;
    const row = await ctx.db.transaction(async tx => {
      /* No move of its work: its version and time of the last change stay, as for any edit of what the tracker keeps, and
         its revision grows, so a card read before it does not name the person back. */
      const [moved] = await tx.update(tasks).set({ responsiblePersonId: to, trackerRevision: nextRevision() })
        .where(and(eq(tasks.id, task.id), eq(tasks.responsiblePersonId, personId), notInArray(tasks.status, [...CLOSED]))).returning();
      if (moved) await ownNote(tx, moved, { kind: 'edited', ...passedOn(o, personId, to) });
      return moved;
    });
    if (row) published(ctx, row);
  }
}

async function passGoals(ctx: Pick<Ctx, 'db' | 'bus'>, o: Owners, companyId: string, personId: string): Promise<void> {
  const held = await ctx.db.select().from(goals).where(and(eq(goals.companyId, companyId), eq(goals.responsiblePersonId, personId), eq(goals.status, 'active')));
  const placeIds = [...new Set(held.flatMap(g => (g.departmentId ? [g.departmentId] : [])))];
  const above = new Map((placeIds.length ? await ctx.db.select({ id: departments.id, parentId: departments.parentId }).from(departments).where(inArray(departments.id, placeIds)) : []).map(d => [d.id, d.parentId]));
  let moved = false;
  for (const goal of held) {
    const spot = { departmentId: goal.departmentId, parentId: goal.departmentId ? (above.get(goal.departmentId) ?? null) : null };
    if (o.reaches(personId, spot)) continue;
    const to = o.owner(spot);
    if (to === personId) continue;
    await ctx.db.transaction(async tx => {
      const [row] = await tx.update(goals).set({ responsiblePersonId: to, version: sql`${goals.version} + 1`, updatedAt: new Date() })
        .where(and(eq(goals.id, goal.id), eq(goals.responsiblePersonId, personId), eq(goals.status, 'active'))).returning();
      if (!row) return;
      const { text, data } = passedOn(o, personId, to);
      await goalNote(tx, row, 'edited', null, data, text);
      moved = true;
    });
  }
  if (moved) ctx.bus.publish(companyId, { type: 'tracker' });
}

/* A person was disabled or lost access: their open tasks and active goals in a place they no longer reach pass to whoever
   takes that place's decisions, each with a line in its history. Closed ones keep the person who answered for them. */
export async function passResponsibility(ctx: Pick<Ctx, 'db' | 'bus'>, companyId: string, personId: string): Promise<void> {
  const o = await ownersOf(ctx, companyId);
  await passTasks(ctx, o, companyId, personId);
  await passGoals(ctx, o, companyId, personId);
}
