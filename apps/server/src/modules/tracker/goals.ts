import { and, asc, desc, eq, inArray, max, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Spot } from '../../auth/access.js';
import { agents, companies, departments, goalEvents, goals, people, tasks, type GoalStatus } from '../../db/schema.js';
import { deptName } from '../departments/templates.js';
import { refuse, type Actor, type Tx } from '../tasks/engine.js';
import { logOf, type LogLine } from '../tasks/views.js';
import { nudgeTrackerKeepers } from './nudge.js';
import { placeOwner, requireAnswersFor, spotOf } from './responsible.js';

export type Goal = typeof goals.$inferSelect;
/* What may change on a goal: everything but its place, which a goal keeps from its start. */
export type GoalChange = Partial<Pick<Goal, 'title' | 'why' | 'parentGoalId' | 'responsiblePersonId' | 'targetValue' | 'currentValue' | 'unit' | 'dueAt'>>;
export type NewGoal = GoalChange & Pick<Goal, 'title' | 'departmentId'>;
/* Whoever writes may change goals in this place, or it throws: people by their access, agents by their department. */
export type GoalGuard = (spot: Spot) => Promise<void>;
type Live = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'templates'>>;

export type GoalView = {
  id: string;
  number: number;
  title: string;
  why: string;
  department: { id: string; name: string } | null;
  parentId: string | null;
  responsible: { id: string; name: string };
  target: number | null;
  current: number | null;
  unit: string;
  dueAt: string | null;
  status: GoalStatus;
  /* From 0 to 1: the number target when there is one, else the share of the tasks under it that are done. None: nothing
     to count yet. Cancelled tasks do not count. */
  progress: number | null;
  done: number;
  total: number;
  version: number;
};

const actorColumns = (a: Actor) => ({ personId: a.personId ?? null, agentId: a.agentId ?? null });
const createdBy = (a: Actor) => ({ createdByPersonId: a.personId ?? null, createdByAgentId: a.agentId ?? null });

/* One line of a goal's history, read the way a task's is. */
export async function goalNote(tx: Tx, goal: Pick<Goal, 'id' | 'companyId'>, kind: 'created' | 'edited' | 'status', actor: Actor | null, data: Record<string, unknown> = {}, text = '') {
  await tx.insert(goalEvents).values({ companyId: goal.companyId, goalId: goal.id, kind, ...(actor ? actorColumns(actor) : {}), text, data });
}

const invalid = (message: string) => refuse(400, 'goal_invalid', message);

export async function loadGoal(db: Live['db'] | Tx, companyId: string, id: string): Promise<Goal> {
  const [goal] = await db.select().from(goals).where(and(eq(goals.id, id), eq(goals.companyId, companyId)));
  if (!goal) throw refuse(404, 'goal_unknown', 'There is no such goal.');
  return goal;
}

/* A goal sits under a company goal, or under a goal of its own department or of the department that holds it; never under
   itself or one of its own smaller goals. */
async function checkParent(tx: Tx, goal: { id?: string; companyId: string }, spot: Spot, parentId: string): Promise<void> {
  if (parentId === goal.id) throw invalid('A goal cannot be part of itself.');
  const [parent] = await tx.select().from(goals).where(and(eq(goals.id, parentId), eq(goals.companyId, goal.companyId)));
  if (!parent) throw invalid('There is no such goal to be part of.');
  const places = [null, spot.departmentId, spot.parentId ?? null];
  if (!places.includes(parent.departmentId)) throw invalid('A goal is part of a company goal or of a goal of its own department.');
  if (!goal.id) return;
  const all = await tx.select({ id: goals.id, parentGoalId: goals.parentGoalId }).from(goals).where(eq(goals.companyId, goal.companyId));
  const above = new Map(all.map(g => [g.id, g.parentGoalId]));
  for (let at: string | null | undefined = parentId, steps = 0; at && steps <= all.length; at = above.get(at), steps++) {
    if (at === goal.id) throw invalid('A goal cannot be part of one of its own smaller goals.');
  }
}

const publish = (ctx: Live, companyId: string) => ctx.bus.publish(companyId, { type: 'tracker' });

export async function createGoal(ctx: Live, companyId: string, actor: Actor, guard: GoalGuard, input: NewGoal): Promise<Goal> {
  const spot = await spotOf(ctx.db, companyId, input.departmentId);
  await guard(spot);
  if (input.responsiblePersonId) await requireAnswersFor(ctx, companyId, input.responsiblePersonId, spot);
  const responsiblePersonId = input.responsiblePersonId ?? (await placeOwner(ctx, companyId, spot));
  const goal = await ctx.db.transaction(async tx => {
    await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for('update');
    if (input.parentGoalId) await checkParent(tx, { companyId }, spot, input.parentGoalId);
    const [last] = await tx.select({ n: max(goals.number) }).from(goals).where(eq(goals.companyId, companyId));
    const [row] = await tx.insert(goals).values({ ...input, companyId, number: (last?.n ?? 0) + 1, responsiblePersonId, ...createdBy(actor) }).returning();
    await goalNote(tx, row!, 'created', actor);
    return row!;
  });
  publish(ctx, companyId);
  await nudgeTrackerKeepers(ctx, goal, actor.agentId);
  return goal;
}

/* A change made only when the goal is still as its writer saw it, by its version. */
async function changeGoal(ctx: Live, companyId: string, id: string, version: number, write: (tx: Tx, goal: Goal) => Promise<Partial<Goal> | null>): Promise<Goal> {
  const goal = await ctx.db.transaction(async tx => {
    const [current] = await tx.select().from(goals).where(and(eq(goals.id, id), eq(goals.companyId, companyId))).for('update');
    if (!current) throw refuse(404, 'goal_unknown', 'There is no such goal.');
    if (current.version !== version) throw refuse(409, 'goal_changed', 'Someone changed this goal meanwhile. Look at it again.');
    const set = await write(tx, current);
    if (!set) return current;
    const [row] = await tx.update(goals).set({ ...set, version: sql`${goals.version} + 1`, updatedAt: new Date() }).where(eq(goals.id, id)).returning();
    return row!;
  });
  publish(ctx, companyId);
  return goal;
}

const CHANGEABLE = ['title', 'why', 'parentGoalId', 'responsiblePersonId', 'targetValue', 'currentValue', 'unit', 'dueAt'] as const;
const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

export async function editGoal(ctx: Live, companyId: string, actor: Actor, guard: GoalGuard, id: string, change: GoalChange, version: number): Promise<Goal> {
  const before = await loadGoal(ctx.db, companyId, id);
  const spot = await spotOf(ctx.db, companyId, before.departmentId);
  await guard(spot);
  if (change.responsiblePersonId && change.responsiblePersonId !== before.responsiblePersonId) await requireAnswersFor(ctx, companyId, change.responsiblePersonId, spot);
  return changeGoal(ctx, companyId, id, version, async (tx, goal) => {
    const fields = CHANGEABLE.filter(f => change[f] !== undefined && !same(change[f], goal[f]));
    if (!fields.length) return null;
    if (fields.includes('parentGoalId') && change.parentGoalId) await checkParent(tx, goal, spot, change.parentGoalId);
    await goalNote(tx, goal, 'edited', actor, { fields: fields.map(f => FIELD_NAMES[f]) });
    return Object.fromEntries(fields.map(f => [f, change[f]]));
  });
}

/* The names the history and the screens use for what changed. */
const FIELD_NAMES: Record<(typeof CHANGEABLE)[number], string> = {
  title: 'title', why: 'why', parentGoalId: 'parent', responsiblePersonId: 'responsible', targetValue: 'target', currentValue: 'current', unit: 'unit', dueAt: 'due',
};

export async function setGoalStatus(ctx: Live, companyId: string, actor: Actor, guard: GoalGuard, id: string, status: GoalStatus, version: number): Promise<Goal> {
  const before = await loadGoal(ctx.db, companyId, id);
  await guard(await spotOf(ctx.db, companyId, before.departmentId));
  const goal = await changeGoal(ctx, companyId, id, version, async (tx, goal) => {
    if (goal.status === status) return null;
    await goalNote(tx, goal, 'status', actor, { fromStatus: goal.status, toStatus: status });
    return { status };
  });
  if (before.status !== status) await nudgeTrackerKeepers(ctx, goal, actor.agentId);
  return goal;
}

/* Every goal of the company with its progress, by number. A task counts for the goal it serves and for every goal above
   that one; work under a task serves its top task's goal. */
export async function goalViews(ctx: Pick<Ctx, 'db'>, companyId: string): Promise<GoalView[]> {
  const rows = await ctx.db.select().from(goals).where(eq(goals.companyId, companyId)).orderBy(asc(goals.number));
  if (!rows.length) return [];
  const work = await ctx.db.select({ id: tasks.id, parentId: tasks.parentId, goalId: tasks.goalId, status: tasks.status }).from(tasks).where(eq(tasks.companyId, companyId));
  const counts = countUnder(rows, work);
  const placeIds = [...new Set(rows.flatMap(g => (g.departmentId ? [g.departmentId] : [])))];
  const places = new Map((placeIds.length ? await ctx.db.select().from(departments).where(inArray(departments.id, placeIds)) : []).map(d => [d.id, { id: d.id, name: deptName(d) }]));
  const personIds = [...new Set(rows.map(g => g.responsiblePersonId))];
  const names = new Map((await ctx.db.select({ id: people.id, name: people.name }).from(people).where(inArray(people.id, personIds))).map(p => [p.id, p.name]));
  return rows.map(g => {
    const { done, total } = counts.get(g.id) ?? { done: 0, total: 0 };
    return {
      id: g.id,
      number: g.number,
      title: g.title,
      why: g.why,
      department: g.departmentId ? (places.get(g.departmentId) ?? null) : null,
      parentId: g.parentGoalId,
      responsible: { id: g.responsiblePersonId, name: names.get(g.responsiblePersonId) ?? '' },
      target: g.targetValue,
      current: g.currentValue,
      unit: g.unit,
      dueAt: g.dueAt?.toISOString() ?? null,
      status: g.status,
      progress: g.targetValue ? (g.currentValue ?? 0) / g.targetValue : total ? done / total : null,
      done,
      total,
      version: g.version,
    };
  });
}

type Counted = Pick<typeof tasks.$inferSelect, 'id' | 'parentId' | 'goalId' | 'status'>;

function countUnder(all: Pick<Goal, 'id' | 'parentGoalId'>[], work: Counted[]): Map<string, { done: number; total: number }> {
  const above = new Map(all.map(g => [g.id, g.parentGoalId]));
  const byId = new Map(work.map(t => [t.id, t]));
  const goalOf = (t: Counted): string | null => {
    let at: Counted | undefined = t;
    for (let steps = 0; at && steps <= work.length; steps++) {
      if (!at.parentId) return at.goalId;
      at = byId.get(at.parentId);
    }
    return null;
  };
  const counts = new Map<string, { done: number; total: number }>();
  for (const t of work) {
    if (t.status === 'cancelled') continue;
    const seen = new Set<string>();
    for (let g = goalOf(t); g && !seen.has(g); g = above.get(g) ?? null) {
      seen.add(g);
      const c = counts.get(g) ?? { done: 0, total: 0 };
      counts.set(g, { done: c.done + (t.status === 'done' ? 1 : 0), total: c.total + 1 });
    }
  }
  return counts;
}

const LOG_SHOWN = 200;

/* A goal's history, as a task's history reads. */
export async function goalLog(ctx: Pick<Ctx, 'db'>, goal: Pick<Goal, 'id'>): Promise<LogLine[]> {
  const rows = await ctx.db
    .select({ kind: goalEvents.kind, text: goalEvents.text, data: goalEvents.data, personId: goalEvents.personId, personName: people.name, agentId: goalEvents.agentId, at: goalEvents.createdAt })
    .from(goalEvents)
    .leftJoin(people, eq(people.id, goalEvents.personId))
    .where(eq(goalEvents.goalId, goal.id))
    .orderBy(desc(goalEvents.id))
    .limit(LOG_SHOWN);
  const agentIds = [...new Set(rows.flatMap(r => (r.agentId ? [r.agentId] : [])))];
  const named = new Map((agentIds.length ? await ctx.db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds)) : []).map(a => [a.id, a.name]));
  return logOf(ctx.db, rows, id => named.get(id));
}

