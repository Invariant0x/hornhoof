import { inArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { goals, people } from '../../db/schema.js';
import type { Task } from '../tasks/state.js';
import { timeFacts, type TimeFacts, type TimedTask, type WaitNames } from '../tasks/time-facts.js';
import type { TaskWait } from '../tasks/wait-state.js';

export type GoalRef = { id: string; number: number; title: string };
export type TrackerLookups = {
  goal(t: Pick<Task, 'id'>): GoalRef | null;
  person(id: string | null): { id: string; name: string } | null;
  time(t: Pick<Task, 'id'>): TimeFacts;
};

/* The goal each task serves: its own, or that of the task at the top of its work. */
async function goalsServed(db: Ctx['db'], rows: Pick<Task, 'id'>[]): Promise<Map<string, string>> {
  const ids = sql.join(rows.map(t => sql`${t.id}::uuid`), sql`, `);
  const found = (await db.execute(sql`
    WITH RECURSIVE up(id, parent_id, goal_id) AS (
      SELECT id, parent_id, goal_id FROM tasks WHERE id IN (${ids})
      UNION ALL
      SELECT up.id, p.parent_id, p.goal_id FROM up JOIN tasks p ON p.id = up.parent_id
    )
    SELECT id, goal_id FROM up WHERE parent_id IS NULL AND goal_id IS NOT NULL`)) as unknown as { rows: { id: string; goal_id: string }[] };
  return new Map(found.rows.map(r => [r.id, r.goal_id]));
}

/* The goal one task serves: its own, or that of the task at the top of the work it is part of. */
export const goalServed = async (db: Ctx['db'], task: Pick<Task, 'id'>): Promise<string | null> => (await goalsServed(db, [task])).get(task.id) ?? null;

/* What the tracker shows of the tasks, read in one go for all of them. */
export async function trackerLookups(db: Ctx['db'], rows: (TimedTask & Pick<Task, 'responsiblePersonId'>)[], waits: (t: Pick<Task, 'id'>) => TaskWait[], names: WaitNames): Promise<TrackerLookups> {
  const served = rows.length ? await goalsServed(db, rows) : new Map<string, string>();
  const goalIds = [...new Set(served.values())];
  const goalRows = goalIds.length ? await db.select({ id: goals.id, number: goals.number, title: goals.title }).from(goals).where(inArray(goals.id, goalIds)) : [];
  const personIds = [...new Set(rows.flatMap(t => (t.responsiblePersonId ? [t.responsiblePersonId] : [])))];
  const personRows = personIds.length ? await db.select({ id: people.id, name: people.name }).from(people).where(inArray(people.id, personIds)) : [];
  const facts = await timeFacts(db, rows, waits, names);
  return {
    goal: t => goalRows.find(g => g.id === served.get(t.id)) ?? null,
    person: id => personRows.find(p => p.id === id) ?? null,
    time: t => facts.get(t.id)!,
  };
}
