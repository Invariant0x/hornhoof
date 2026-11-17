import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { agents, companies, departments, goalEvents, goals, people, taskEvents, tasks } from '../src/db/schema.js';
import { upgradeCompany } from '../src/modules/tracker/upgrade.js';
import { as, invitePerson, ownDatabases, setUpCompany, testApp } from './helpers.js';

/* Some tests make the database refuse a write halfway, which a truncate does not undo. */
ownDatabases();

async function company() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [dev, sales, loose] = await db.insert(departments).values([
    { companyId, templateKey: 'development', roleCode: 'DEV', position: 1 },
    { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 },
    { companyId, name: 'Garden', roleCode: 'GRD', position: 3 },
  ]).returning();
  await invitePerson(app, ceo, { name: 'Oleg', email: 'oleg@acme.com', access: { departments: [dev!.id, sales!.id] } });
  await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales!.id] } });
  const id = async (email: string) => (await db.select({ id: people.id }).from(people).where(eq(people.email, email)))[0]!.id;
  let number = 0;
  const task = async (departmentId: string, values: Partial<typeof tasks.$inferInsert> = {}) =>
    (await db.insert(tasks).values({ companyId, number: ++number, departmentId, title: `Task ${number}`, ...values }).returning())[0]!;
  const patch = (path: string, payload: object) => app.inject({ method: 'PATCH', url: path, payload, ...as(ceo) });
  return { app, db, ctx: app.ctx, companyId, dev: dev!, sales: sales!, loose: loose!, task, patch, ivanId: await id('ivan@acme.com'), olegId: await id('oleg@acme.com'), mariaId: await id('maria@acme.com') };
}

/* From here on the database refuses the change of the table's rows that the condition names, as a server that fails right
   there writes nothing more. What it gives back takes the refusal away again. */
async function failAt(db: Db, change: 'update' | 'insert', table: 'tasks' | 'agents', when = 'true'): Promise<() => Promise<unknown>> {
  await db.execute(sql.raw(`create or replace function hh_fail() returns trigger language plpgsql as $$ begin raise exception 'The upgrade failed here.'; end $$`));
  await db.execute(sql.raw(`create trigger hh_fail before ${change} on ${table} for each row when (${when}) execute function hh_fail()`));
  return () => db.execute(sql.raw(`drop trigger hh_fail on ${table}`));
}

const lines = async (db: Awaited<ReturnType<typeof company>>['db'], taskId: string) =>
  (await db.select({ kind: taskEvents.kind, data: taskEvents.data }).from(taskEvents).where(eq(taskEvents.taskId, taskId)).orderBy(asc(taskEvents.id)));

describe('a responsible person who leaves', () => {
  it('passes open tasks and active goals to each department decision owner, with a line in each history', async () => {
    const { db, companyId, dev, sales, task, patch, ivanId, olegId, mariaId } = await company();
    const inDev = await task(dev.id, { responsiblePersonId: olegId });
    const inSales = await task(sales.id, { responsiblePersonId: olegId });
    const done = await task(dev.id, { responsiblePersonId: olegId, status: 'done', closedAt: new Date() });
    const [goal] = await db.insert(goals).values({ companyId, number: 1, departmentId: sales.id, title: 'Leads', responsiblePersonId: olegId }).returning();
    const [reached] = await db.insert(goals).values({ companyId, number: 2, departmentId: sales.id, title: 'Old leads', responsiblePersonId: olegId, status: 'reached' }).returning();

    expect((await patch(`/api/people/${olegId}`, { status: 'disabled' })).statusCode).toBe(200);

    const now = new Map((await db.select().from(tasks)).map(t => [t.id, t.responsiblePersonId]));
    expect([now.get(inDev.id), now.get(inSales.id), now.get(done.id)]).toEqual([ivanId, mariaId, olegId]);
    const goalsNow = new Map((await db.select().from(goals)).map(g => [g.id, g.responsiblePersonId]));
    expect([goalsNow.get(goal!.id), goalsNow.get(reached!.id)]).toEqual([mariaId, olegId]);
    expect(await lines(db, inDev.id)).toEqual([{ kind: 'edited', data: { fields: ['responsible'], from: olegId, to: ivanId } }]);
    expect(await lines(db, done.id)).toEqual([]);
    expect((await db.select({ kind: goalEvents.kind, data: goalEvents.data }).from(goalEvents)).map(e => [e.kind, e.data])).toEqual([['edited', { fields: ['responsible'], from: olegId, to: mariaId }]]);
  });

  it('passes on only what a person no longer reaches when their access shrinks', async () => {
    const { db, dev, sales, task, patch, ivanId, olegId } = await company();
    const inDev = await task(dev.id, { responsiblePersonId: olegId });
    const inSales = await task(sales.id, { responsiblePersonId: olegId });
    expect((await patch(`/api/people/${olegId}`, { access: { departments: [sales.id], teams: [] } })).statusCode).toBe(200);
    const now = new Map((await db.select().from(tasks)).map(t => [t.id, t.responsiblePersonId]));
    expect([now.get(inDev.id), now.get(inSales.id)]).toEqual([ivanId, olegId]);
  });
});

describe('the one-time upgrade of a company from before the tracker', () => {
  it('fills open tasks by the rule, hires one product manager per department and does it only once', async () => {
    const { ctx, db, companyId, dev, sales, loose, task, olegId, ivanId } = await company();
    await db.update(companies).set({ trackerDue: true });
    /* Sales is listed by two people, so the CEO takes its decisions; Development only by Oleg. */
    const top = await task(sales.id);
    const under = await task(dev.id, { parentId: top.id });
    const inDev = await task(dev.id);
    const closed = await task(dev.id, { status: 'cancelled', closedAt: new Date() });
    const [sub] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    await db.insert(agents).values({ companyId, kind: 'worker', name: 'Pia', roleKey: 'SAL-PM', departmentId: sales.id, model: '', subscriptionId: sub!.subscriptionId });

    await upgradeCompany(ctx, companyId);
    await upgradeCompany(ctx, companyId);

    const now = new Map((await db.select().from(tasks)).map(t => [t.id, t.responsiblePersonId]));
    expect([now.get(top.id), now.get(under.id), now.get(inDev.id), now.get(closed.id)]).toEqual([ivanId, ivanId, olegId, null]);
    const managers = await db.select({ role: agents.roleKey, departmentId: agents.departmentId }).from(agents).where(and(isNull(agents.removedAt), eq(agents.kind, 'worker')));
    expect(managers.filter(a => a.role?.endsWith('-PM')).map(a => [a.role, a.departmentId]).sort()).toEqual([['DEV-PM', dev.id], ['SAL-PM', sales.id]]);
    expect(managers.some(a => a.departmentId === loose.id)).toBe(false);
    expect((await db.select({ due: companies.trackerDue }).from(companies))[0]!.due).toBe(false);
  });

  /* Three open tasks of a company from before the tracker. Sales is listed by two people, so the CEO takes its decisions;
     Development only by Oleg. */
  async function due() {
    const made = await company();
    await made.db.update(companies).set({ trackerDue: true });
    const top = await made.task(made.sales.id);
    const under = await made.task(made.dev.id, { parentId: top.id });
    const inDev = await made.task(made.dev.id);
    const state = async () => ({
      responsible: (await made.db.select().from(tasks).orderBy(asc(tasks.number))).map(t => t.responsiblePersonId),
      managers: (await made.db.select({ role: agents.roleKey }).from(agents).where(eq(agents.kind, 'worker'))).map(a => a.role).sort(),
      due: (await made.db.select({ due: companies.trackerDue }).from(companies))[0]!.due,
    });
    return { ...made, top, under, inDev, state };
  }

  it('leaves every task and the mark as they were when filling the tasks fails halfway, and a later run does it all', async () => {
    const { ctx, db, companyId, inDev, state, olegId, ivanId } = await due();
    /* The last of the three open tasks: the two before it are filled by then. */
    const back = await failAt(db, 'update', 'tasks', `new.id = '${inDev.id}'`);
    await expect(upgradeCompany(ctx, companyId)).rejects.toMatchObject({ cause: { message: 'The upgrade failed here.' } });
    expect(await state()).toEqual({ responsible: [null, null, null], managers: [], due: true });

    await back();
    await upgradeCompany(ctx, companyId);
    expect(await state()).toEqual({ responsible: [ivanId, ivanId, olegId], managers: ['DEV-PM', 'SAL-PM'], due: false });
  });

  it('takes back the responsible people it named when hiring the product managers fails, and a later run does it all', async () => {
    const { ctx, db, companyId, state, olegId, ivanId } = await due();
    const back = await failAt(db, 'insert', 'agents');
    await expect(upgradeCompany(ctx, companyId)).rejects.toMatchObject({ cause: { message: 'The upgrade failed here.' } });
    expect(await state()).toEqual({ responsible: [null, null, null], managers: [], due: true });

    await back();
    await upgradeCompany(ctx, companyId);
    expect(await state()).toEqual({ responsible: [ivanId, ivanId, olegId], managers: ['DEV-PM', 'SAL-PM'], due: false });
  });
});
