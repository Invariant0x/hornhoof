import { and, asc, eq, isNull, notInArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { agents, companies, departments, goals, tasks } from '../../db/schema.js';
import { loggable } from '../../errors.js';
import { hireEmployee, type Hired, type HiredBy } from '../departments/hire.js';
import { tellOrchestrator } from '../operations/ensure.js';
import { CLOSED, taskSpot, type Tx } from '../tasks/state.js';
import { placeableSubscriptions, spotIn } from '../tools/staff.js';
import { nextRevision } from './revision.js';
import { ownersOf } from './responsible.js';

/* Hornhoof's own doing: no person decided it and the orchestrator did not act for one. */
const HORNHOOF: HiredBy = { personId: null, byOrchestrator: false };

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
    await tx.update(tasks).set({ responsiblePersonId: person, trackerRevision: nextRevision() }).where(and(eq(tasks.id, task.id), isNull(tasks.responsiblePersonId)));
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
   once. The tasks, hires and mark are one change under the company's lock: a failure there leaves the company due for
   the next run, and two runs at once do it once. Running it again changes nothing. */
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
  /* Notices are best effort after commit. A failed notice need not stop the others or repeat the upgrade. */
  if (!made.length) return;
  try {
    ctx.bus.publish(companyId, { type: 'org' });
  } catch (err) {
    ctx.log.error({ companyId, error: loggable(err) }, 'Sending the live tracker upgrade notice failed.');
  }
  for (const { departmentId, hired } of made) {
    await tellOrchestrator(ctx, companyId, departmentId, hired).catch((err: unknown) => {
      ctx.log.error({ companyId, departmentId, error: loggable(err) }, 'Sending a tracker upgrade hiring notice failed.');
    });
  }
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
