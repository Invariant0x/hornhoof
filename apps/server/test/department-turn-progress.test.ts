import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { PglitePreparedQuery } from 'drizzle-orm/pglite';
import { expect, it, onTestFinished, vi } from 'vitest';
import { agents, companies, departments, people, tasks, teams, turns, TASK_STATUSES } from '../src/db/schema.js';
import { createRoute } from '../src/modules/tasks/echelons-store.js';
import { developmentStages } from './templates-once.js';
import { turnCounts } from '../src/modules/tasks/turn-progress.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';

async function fixture() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const [co] = await db.select().from(companies);
  const [person] = await db.select().from(people);
  const [executor] = await db.select().from(agents);
  const companyId = co!.id;
  const [dev, sales, ops] = await db.insert(departments).values([
    { companyId, roleCode: 'DEV', templateKey: 'development' },
    { companyId, roleCode: 'SAL', templateKey: 'sales' },
    { companyId, roleCode: 'OPS', templateKey: 'operations' },
  ]).returning();
  const [turn, salesTurn] = await db.insert(turns).values([
    { companyId, departmentId: dev!.id, number: 8, goal: 'The turn of Development', status: 'open', openedAt: new Date() },
    { companyId, departmentId: sales!.id, number: 9, goal: 'The turn of Sales', status: 'open', openedAt: new Date() },
  ]).returning();
  const turnOf = new Map([[dev!.id, turn!.id], [sales!.id, salesTurn!.id]]);
  let number = 100;
  const add = async (departmentId: string, patch: Partial<typeof tasks.$inferInsert> = {}) => {
    const task = (await db.insert(tasks).values({ companyId, number: ++number, turnId: turnOf.get(departmentId) ?? null, departmentId, title: 'Count this task', createdByPersonId: person!.id, executorAgentId: patch.status === 'review' ? executor!.id : null, closedAt: patch.status === 'done' || patch.status === 'cancelled' ? new Date() : null, ...patch }).returning())[0]!;
    await db.transaction(tx => createRoute(tx, task, {}, developmentStages()));
    return task;
  };
  const org = async (token = ceo) => {
    const response = await app.inject({ url: '/api/org', ...as(token) });
    expect(response.statusCode).toBe(200);
    return response.json() as { departments: { id: string; turnProgress: { turnNumber: number; done: number; total: number } | null }[] };
  };
  const current = async (token = ceo, department?: string) => (await app.inject({ url: `/api/turns/current${department ? `?department=${department}` : ''}`, ...as(token) })).json().turn;
  return { app, db, ceo, companyId, person: person!, dev: dev!, sales: sales!, ops: ops!, turn: turn!, add, org, current };
}

it("counts the exact turnView task set of each department's own turn, including roots, subtasks and products", async () => {
  const c = await fixture();
  const parent = await c.add(c.dev.id, { status: 'done' });
  for (const status of TASK_STATUSES) await c.add(c.dev.id, { status, parentId: parent.id });
  const [product] = await c.db.insert(departments).values({ companyId: c.companyId, roleCode: 'DEV', parentId: c.dev.id, name: 'Product' }).returning();
  await c.add(c.dev.id, { productId: product!.id, status: 'done' });
  await c.add(c.sales.id, { status: 'done' });
  await c.add(c.ops.id, { status: 'done' });
  await c.add(c.dev.id, { turnId: null, status: 'done' });
  const [old] = await c.db.insert(turns).values({ companyId: c.companyId, number: 7, goal: 'Old', status: 'closed' }).returning();
  await c.add(c.dev.id, { turnId: old!.id, status: 'done' });
  const map = new Map((await c.org()).departments.map(d => [d.id, d]));
  expect(map.get(c.dev.id)!.turnProgress).toEqual({ turnNumber: 8, total: 9, done: 3 });
  expect(map.get(c.dev.id)).not.toHaveProperty('workMode');
  expect(map.get(c.sales.id)!.turnProgress).toEqual({ turnNumber: 9, total: 1, done: 1 });
  expect(map.get(c.ops.id)!.turnProgress).toBeNull();
  expect((await c.current()).tasks).toEqual({ total: 9, done: 3 });
  expect(await c.current(c.ceo, c.sales.id)).toMatchObject({ number: 9, tasks: { total: 1, done: 1 } });
  expect(await c.current(c.ceo, c.ops.id)).toBeNull();
});

it('returns exact zero counts and 100 percent rather than inventing progress', async () => {
  const c = await fixture();
  expect((await c.org()).departments.find(d => d.id === c.dev.id)!.turnProgress).toEqual({ turnNumber: 8, total: 0, done: 0 });
  await c.add(c.dev.id, { status: 'done' });
  expect((await c.org()).departments.find(d => d.id === c.dev.id)!.turnProgress).toEqual({ turnNumber: 8, total: 1, done: 1 });
});

it('returns no progress with no open turn even if a released turn has tasks', async () => {
  const c = await fixture();
  await c.add(c.dev.id, { status: 'done' });
  await c.db.update(turns).set({ status: 'closed', closedAt: new Date(), version: 'v1.0.0' }).where(eq(turns.companyId, c.companyId));
  expect((await c.org()).departments.every(d => d.turnProgress === null)).toBe(true);
  expect(await c.current()).toBeNull();
});

it('counts the same tasks as turnView for everyone, of every department, reached or not', async () => {
  const c = await fixture();
  const dana = await invitePerson(c.app, c.ceo, { name: 'Dana', email: 'dana@example.test', access: { departments: [c.dev.id] } });
  const [person] = await c.db.select().from(people).where(eq(people.email, 'dana@example.test'));
  await c.add(c.dev.id, { status: 'done', createdByPersonId: person!.id });
  await c.add(c.dev.id, { status: 'working' });
  await c.add(c.sales.id, { status: 'done' });
  const map = new Map((await c.org(dana)).departments.map(d => [d.id, d]));
  expect(map.get(c.dev.id)!.turnProgress).toEqual({ turnNumber: 8, total: 2, done: 1 });
  expect(map.get(c.sales.id)!.turnProgress).toEqual({ turnNumber: 9, total: 1, done: 1 });
  expect((await c.current(dana)).tasks).toEqual({ total: 2, done: 1 });
  expect((await c.org()).departments.find(d => d.id === c.dev.id)!.turnProgress).toEqual({ turnNumber: 8, total: 2, done: 1 });
});

it('excludes another company even when its task references the same turn and department', async () => {
  const c = await fixture();
  await c.add(c.dev.id, { status: 'done' });
  const [other] = await c.db.insert(companies).values({ name: 'Other company', singleton: false }).returning();
  await c.add(c.dev.id, { companyId: other!.id, status: 'done' });
  const [foreign] = await c.db.insert(departments).values({ companyId: other!.id, roleCode: 'OTHER' }).returning();
  const org = await c.org();
  expect(org.departments.some(d => d.id === foreign!.id)).toBe(false);
  expect(org.departments.find(d => d.id === c.dev.id)!.turnProgress).toEqual({ turnNumber: 8, total: 1, done: 1 });
  expect((await c.current()).tasks).toEqual({ total: 1, done: 1 });
});

it('propagates a failed count instead of returning an invented zero', async () => {
  const c = await fixture();
  const failure = new Error('Count database unavailable');
  /* The count fails where the database answers it. A spy on db.select would type its mock from every select overload,
     which cost the type check of this file about 30 MB. */
  const execute = vi.spyOn(PglitePreparedQuery.prototype, 'execute').mockRejectedValue(failure);
  onTestFinished(() => execute.mockRestore());
  const viewer = { full: true, personId: randomUUID(), access: { whole: true, departments: new Set<string>(), teams: new Set<string>() }, plans: new Set<string>(), agents: new Set<string>(), own: new Set<string>(), apart: new Set<string>() };
  await expect(turnCounts(c.db, c.turn, viewer)).rejects.toBe(failure);
});


it('shows the whole progress to product-only and team-only access, and lets nobody pick how a department works', async () => {
  const c = await fixture();
  const [product] = await c.db.insert(departments).values({ companyId: c.companyId, roleCode: 'DEV', parentId: c.dev.id, name: 'Product' }).returning();
  const productToken = await invitePerson(c.app, c.ceo, { name: 'Product reader', email: 'product@example.test', access: { departments: [product!.id] } });
  const [person] = await c.db.select().from(people).where(eq(people.email, 'product@example.test'));
  await c.add(c.dev.id, { status: 'done', productId: product!.id, createdByPersonId: person!.id });
  await c.add(c.dev.id, { status: 'done' });
  expect((await c.org(productToken)).departments.find(d => d.id === c.dev.id)!.turnProgress).toEqual({ turnNumber: 8, total: 2, done: 2 });
  expect((await c.current(productToken)).tasks).toEqual({ total: 2, done: 2 });
  const [team] = await c.db.insert(teams).values({ companyId: c.companyId, departmentId: c.dev.id, name: 'One team' }).returning();
  const teamToken = await invitePerson(c.app, c.ceo, { name: 'Team reader', email: 'team@example.test', access: { teams: [team!.id] } });
  expect((await c.org(teamToken)).departments.find(d => d.id === c.dev.id)!.turnProgress).toEqual({ turnNumber: 8, total: 2, done: 2 });
  expect((await c.current(teamToken)).tasks).toEqual({ total: 2, done: 2 });
  /* Every department works in one flow now: the route that switched it between turns and continuous work is gone. */
  for (const token of [c.ceo, productToken, teamToken]) {
    expect((await c.app.inject({ method: 'PUT', url: `/api/departments/${c.dev.id}/work-mode`, payload: { workMode: 'continuous' }, ...as(token) })).statusCode).toBe(404);
  }
});
