import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, it, onTestFinished, vi } from 'vitest';
import { agents, companies, departments, people, tasks, turns, TASK_STATUSES } from '../src/db/schema.js';
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
    { companyId, roleCode: 'OPS', templateKey: 'operations', workMode: 'continuous' },
  ]).returning();
  const [turn] = await db.insert(turns).values({ companyId, number: 8, goal: 'One common turn' }).returning();
  let number = 100;
  const add = async (departmentId: string, patch: Partial<typeof tasks.$inferInsert> = {}) =>
    (await db.insert(tasks).values({ companyId, number: ++number, turnId: turn!.id, departmentId, title: 'Count this task', createdByPersonId: person!.id, executorAgentId: patch.status === 'review' ? executor!.id : null, closedAt: patch.status === 'done' || patch.status === 'cancelled' ? new Date() : null, ...patch }).returning())[0]!;
  const org = async (token = ceo) => {
    const response = await app.inject({ url: '/api/org', ...as(token) });
    expect(response.statusCode).toBe(200);
    return response.json() as { departments: { id: string; workMode: string; turnProgress: { turnNumber: number; done: number; total: number } | null }[] };
  };
  const current = async (token = ceo) => (await app.inject({ url: '/api/turns/current', ...as(token) })).json().turn;
  return { app, db, ceo, companyId, person: person!, dev: dev!, sales: sales!, ops: ops!, turn: turn!, add, org, current };
}

it('counts the exact turnView task set per department, including roots, subtasks and products', async () => {
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
  expect(map.get(c.dev.id)).toMatchObject({ workMode: 'turns', turnProgress: { turnNumber: 8, total: 10, done: 3 } });
  expect(map.get(c.sales.id)!.turnProgress).toEqual({ turnNumber: 8, total: 1, done: 1 });
  expect(map.get(c.ops.id)).toMatchObject({ workMode: 'continuous', turnProgress: null });
  expect((await c.current()).tasks).toEqual({ total: 12, done: 5 });
});

it('returns exact zero counts and 100 percent rather than inventing progress', async () => {
  const c = await fixture();
  expect((await c.org()).departments.find(d => d.id === c.dev.id)!.turnProgress).toEqual({ turnNumber: 8, total: 0, done: 0 });
  await c.add(c.dev.id, { status: 'done' });
  expect((await c.org()).departments.find(d => d.id === c.dev.id)!.turnProgress).toEqual({ turnNumber: 8, total: 1, done: 1 });
});

it('returns no progress with no open turn even if a planned turn has tasks', async () => {
  const c = await fixture();
  await c.add(c.dev.id, { status: 'done' });
  await c.db.update(turns).set({ status: 'planned' }).where(eq(turns.id, c.turn.id));
  expect((await c.org()).departments.every(d => d.turnProgress === null)).toBe(true);
  expect(await c.current()).toBeNull();
});

it('changes an existing department between turns and continuous without changing its tasks', async () => {
  const c = await fixture();
  await c.add(c.dev.id, { status: 'done' });
  await c.db.update(departments).set({ workMode: 'continuous' }).where(eq(departments.id, c.dev.id));
  expect((await c.org()).departments.find(d => d.id === c.dev.id)!.turnProgress).toBeNull();
  await c.db.update(departments).set({ workMode: 'turns' }).where(eq(departments.id, c.dev.id));
  expect((await c.org()).departments.find(d => d.id === c.dev.id)!.turnProgress).toEqual({ turnNumber: 8, total: 1, done: 1 });
});

it('filters hidden work identically to turnView and gives no progress for an unreached department', async () => {
  const c = await fixture();
  const dana = await invitePerson(c.app, c.ceo, { name: 'Dana', email: 'dana@example.test', access: { departments: [c.dev.id] } });
  const [person] = await c.db.select().from(people).where(eq(people.email, 'dana@example.test'));
  await c.add(c.dev.id, { status: 'done', createdByPersonId: person!.id });
  await c.add(c.dev.id, { status: 'working' });
  await c.add(c.sales.id, { status: 'done' });
  const map = new Map((await c.org(dana)).departments.map(d => [d.id, d]));
  expect(map.get(c.dev.id)!.turnProgress).toEqual({ turnNumber: 8, total: 1, done: 1 });
  expect(map.get(c.sales.id)!.turnProgress).toBeNull();
  expect((await c.current(dana)).tasks).toEqual({ total: 1, done: 1 });
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
  const denied = await c.app.inject({ method: 'PUT', url: `/api/departments/${foreign!.id}/work-mode`, payload: { workMode: 'continuous' }, ...as(c.ceo) });
  expect(denied.statusCode).toBe(404);
});

it('propagates a failed count instead of returning an invented zero', async () => {
  const c = await fixture();
  const failure = new Error('Count database unavailable');
  const select = vi.spyOn(c.db, 'select').mockImplementation(() => { throw failure; });
  onTestFinished(() => select.mockRestore());
  const viewer = { full: true, personId: randomUUID(), access: { whole: true, departments: new Set<string>(), teams: new Set<string>() }, plans: new Set<string>(), agents: new Set<string>() };
  await expect(turnCounts(c.db, c.turn, viewer, c.dev.id)).rejects.toBe(failure);
});
