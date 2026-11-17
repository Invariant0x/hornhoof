import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { canReach, type Spot } from '../../auth/access.js';
import { decisionOwner } from '../../auth/decision-owner.js';
import { agents, companies, departments, goals, people, tasks } from '../../db/schema.js';
import { loggable } from '../../errors.js';
import { hireEmployee, type Hired, type HiredBy } from '../departments/hire.js';
import { tellOrchestrator } from '../operations/ensure.js';
import { candidates } from '../tasks/decisions.js';
import { CLOSED, ownNote, published, taskSpot, type Tx } from '../tasks/engine.js';
import { placeableSubscriptions, spotIn } from '../tools/staff.js';
import { goalNote } from './goals.js';
import { placeSubject } from './responsible.js';

/* Hornhoof's own doing: no person decided it and the orchestrator did not act for one. */
const HORNHOOF: HiredBy = { personId: null, byOrchestrator: false };

type Owners = { reaches(personId: string, spot: Spot): boolean; owner(spot: Spot): string; name(personId: string): string };

/* Who reaches what in the company now, and who takes each place's decisions, read once. */
async function ownersOf(ctx: Pick<Ctx, 'db'>, companyId: string): Promise<Owners> {
  const everyone = await candidates(ctx, companyId);
  const names = new Map((await ctx.db.select({ id: people.id, name: people.name }).from(people).where(eq(people.companyId, companyId))).map(p => [p.id, p.name]));
  return {
    reaches: (personId, spot) => everyone.some(p => p.id === personId && p.status === 'active' && canReach(p.access, spot)),
    owner: spot => decisionOwner(placeSubject(spot), everyone),
    name: personId => names.get(personId) ?? '',
  };
}

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
      /* No move of its work: its version and time of the last change stay, as for any edit of what the tracker keeps. */
      const [moved] = await tx.update(tasks).set({ responsiblePersonId: to })
        .where(and(eq(tasks.id, task.id), eq(tasks.responsiblePersonId, personId))).returning();
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
        .where(and(eq(goals.id, goal.id), eq(goals.responsiblePersonId, personId))).returning();
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

/* Open tasks get a responsible person by the rule new tasks follow, work under a task first that task's. Closed ones stay
   without one: nobody answers for them any more. */
async function fillOpenTasks(tx: Tx, companyId: string): Promise<void> {
  const o = await ownersOf({ db: tx }, companyId);
  const open = await tx.select().from(tasks).where(and(eq(tasks.companyId, companyId), notInArray(tasks.status, [...CLOSED]))).orderBy(asc(tasks.number));
  const goalPeople = new Map((await tx.select({ id: goals.id, personId: goals.responsiblePersonId }).from(goals).where(eq(goals.companyId, companyId))).map(g => [g.id, g.personId]));
  const known = new Map<string, string>(open.flatMap(t => (t.responsiblePersonId ? [[t.id, t.responsiblePersonId] as const] : [])));
  for (const task of open) {
    if (task.responsiblePersonId) continue;
    const person = (task.parentId ? known.get(task.parentId) : null) ?? (task.goalId ? goalPeople.get(task.goalId) : null) ?? o.owner(taskSpot(task));
    await tx.update(tasks).set({ responsiblePersonId: person }).where(and(eq(tasks.id, task.id), isNull(tasks.responsiblePersonId)));
    known.set(task.id, person);
  }
}

/* One product manager into each top-level department of a template that has one and holds none. */
async function hireManagers(ctx: Ctx, tx: Tx, companyId: string): Promise<{ departmentId: string; hired: Hired[] }[]> {
  const made: { departmentId: string; hired: Hired[] }[] = [];
  for (const dept of await tx.select().from(departments).where(and(eq(departments.companyId, companyId), isNull(departments.parentId))).orderBy(asc(departments.position))) {
    const role = dept.templateKey ? ctx.templates.roster(dept.templateKey).find(r => r.id.endsWith('-PM')) : undefined;
    if (!role) continue;
    const [held] = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.departmentId, dept.id), eq(agents.roleKey, role.id), isNull(agents.removedAt))).limit(1);
    if (held) continue;
    const [plan] = await placeableSubscriptions({ db: tx }, companyId, spotIn(dept));
    const skills = role.skills.filter(s => s.on).map(s => s.id);
    made.push({ departmentId: dept.id, hired: [await hireEmployee(ctx, tx, { companyId, departmentId: dept.id }, { role: role.id, name: role.title.en, model: '', subscription: plan?.id ?? null, skills }, HORNHOOF)] });
  }
  return made;
}

/* A company from before the tracker: its open tasks get their responsible people and each department its product manager,
   once. All of it is one change under the company's lock, the mark with it: a failure anywhere leaves the company as it
   was, to be upgraded whole on the next run, and two runs at once do it once. Running it again changes nothing. */
export async function upgradeCompany(ctx: Ctx, companyId: string): Promise<void> {
  const [company] = await ctx.db.select({ due: companies.trackerDue }).from(companies).where(eq(companies.id, companyId));
  if (!company?.due) return;
  const made = await ctx.db.transaction(async tx => {
    const [held] = await tx.select({ due: companies.trackerDue }).from(companies).where(eq(companies.id, companyId)).for('update');
    if (!held?.due) return [];
    await fillOpenTasks(tx, companyId);
    const hired = await hireManagers(ctx, tx, companyId);
    await tx.update(companies).set({ trackerDue: false }).where(eq(companies.id, companyId));
    return hired;
  });
  /* People and the orchestrator hear of it once it is in. */
  if (!made.length) return;
  ctx.bus.publish(companyId, { type: 'org' });
  for (const { departmentId, hired } of made) await tellOrchestrator(ctx, companyId, departmentId, hired);
}

/* The upgrade hires, so it runs only while the app leads, as it starts leading. */
export function startTrackerUpgrade(app: FastifyInstance, ctx: Ctx): void {
  ctx.mode.whenLead(
    async () => {
      for (const { id } of await ctx.db.select({ id: companies.id }).from(companies).where(eq(companies.trackerDue, true))) {
        await upgradeCompany(ctx, id).catch((err: unknown) => app.log.error({ error: loggable(err) }, 'Upgrading the company to the task tracker failed.'));
      }
    },
    () => {},
  );
}
