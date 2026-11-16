import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { companies, departments, people, tasks } from '../src/db/schema.js';
import type { StreamMessage } from '../src/modules/events/bus.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';

async function company() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [dev, sales] = await db.insert(departments).values([
    { companyId, templateKey: 'development', roleCode: 'DEV', position: 1 },
    { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 },
  ]).returning();
  const oleg = await invitePerson(app, ceo, { name: 'Oleg', email: 'oleg@acme.com', access: { departments: [dev!.id] } });
  const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales!.id] } });
  const id = async (email: string) => (await db.select({ id: people.id }).from(people).where(eq(people.email, email)))[0]!.id;
  const send = (method: 'POST' | 'PATCH' | 'PUT', token: string, url: string, payload: object) => app.inject({ method, url, payload, ...as(token) });
  const get = (token: string, url: string) => app.inject({ url, ...as(token) });
  const heard: StreamMessage[] = [];
  app.ctx.bus.subscribe(companyId, m => heard.push(m));
  return { app, db, ctx: app.ctx, companyId, ceo, oleg, maria, dev: dev!, sales: sales!, ivanId: await id('ivan@acme.com'), olegId: await id('oleg@acme.com'), mariaId: await id('maria@acme.com'), send, get, heard };
}

describe('goals', () => {
  it('nests goals at any depth, with progress from a number target or from the tasks under them', async () => {
    const { db, companyId, ceo, oleg, dev, olegId, ivanId, send, get } = await company();
    const top = (await send('POST', ceo, '/api/goals', { title: '500 B2C subscribers', why: 'Revenue before the round.', target: 500, current: 212, unit: 'subscribers' })).json().goal;
    expect(top).toMatchObject({ number: 1, department: null, parentId: null, responsible: { id: ivanId, name: 'Ivan' }, status: 'active', progress: 0.424 });
    const launch = await send('POST', oleg, '/api/goals', { title: 'Launch the shop', department: dev.id, parent: top.id });
    expect(launch.statusCode).toBe(201);
    const shop = launch.json().goal;
    expect(shop).toMatchObject({ number: 2, department: { id: dev.id }, parentId: top.id, progress: null, done: 0, total: 0 });
    const checkout = (await send('POST', oleg, '/api/goals', { title: 'Checkout works', department: dev.id, parent: shop.id, responsible: olegId })).json().goal;
    expect(checkout.responsible).toEqual({ id: olegId, name: 'Oleg' });

    const task = (number: number, status: 'open' | 'done' | 'cancelled', goalId: string | null, parentId: string | null = null) =>
      ({ companyId, number, title: `Task ${number}`, departmentId: dev.id, status, goalId, parentId, closedAt: status === 'open' ? null : new Date() });
    const [first] = await db.insert(tasks).values(task(1, 'done', shop.id)).returning();
    await db.insert(tasks).values([task(2, 'open', checkout.id), task(3, 'done', checkout.id), task(4, 'cancelled', checkout.id), task(5, 'done', null, first!.id)]);

    const goals = (await get(oleg, '/api/goals')).json().goals as { number: number; progress: number | null; done: number; total: number }[];
    expect(goals.map(g => [g.number, g.progress, g.done, g.total])).toEqual([[1, 0.424, 3, 4], [2, 0.75, 3, 4], [3, 0.5, 1, 2]]);
  });

  it('refuses a goal under its own smaller goal, and a company goal under a department goal', async () => {
    const { ceo, oleg, dev, send, get } = await company();
    const top = (await send('POST', ceo, '/api/goals', { title: 'Grow' })).json().goal;
    const mid = (await send('POST', oleg, '/api/goals', { title: 'Shop', department: dev.id, parent: top.id })).json().goal;
    const low = (await send('POST', oleg, '/api/goals', { title: 'Checkout', department: dev.id, parent: mid.id })).json().goal;

    const loop = await send('PATCH', oleg, `/api/goals/${mid.id}`, { parent: low.id, version: mid.version });
    expect([loop.statusCode, loop.json().error.reason]).toEqual([400, 'goal_invalid']);
    const self = await send('PATCH', oleg, `/api/goals/${mid.id}`, { parent: mid.id, version: mid.version });
    expect([self.statusCode, self.json().error.reason]).toEqual([400, 'goal_invalid']);
    const under = await send('PATCH', ceo, `/api/goals/${top.id}`, { parent: low.id, version: top.version });
    expect([under.statusCode, under.json().error.reason]).toEqual([400, 'goal_invalid']);
    expect(((await get(oleg, '/api/goals')).json().goals as { number: number; parentId: string | null }[]).map(g => g.parentId)).toEqual([null, top.id, mid.id]);
  });

  it('lets the CEO set company goals and whoever reaches a department set its goals, each change once', async () => {
    const { ceo, oleg, maria, dev, sales, mariaId, send } = await company();
    expect((await send('POST', oleg, '/api/goals', { title: 'Grow' })).json().error.reason).toBe('company_scope_only');
    const other = await send('POST', maria, '/api/goals', { title: 'Shop', department: dev.id });
    expect([other.statusCode, other.json().error.reason]).toEqual([403, 'not_your_department']);
    const shop = (await send('POST', oleg, '/api/goals', { title: 'Shop', department: dev.id })).json().goal;
    const stranger = await send('PATCH', oleg, `/api/goals/${shop.id}`, { responsible: mariaId, version: shop.version });
    expect([stranger.statusCode, stranger.json().error.reason]).toEqual([400, 'responsible_invalid']);

    const renamed = await send('PATCH', oleg, `/api/goals/${shop.id}`, { title: 'Open the shop', due: '2026-12-01T00:00:00.000Z', version: shop.version });
    expect(renamed.json().goal).toMatchObject({ title: 'Open the shop', dueAt: '2026-12-01T00:00:00.000Z', version: shop.version + 1 });
    const stale = await send('PATCH', oleg, `/api/goals/${shop.id}`, { title: 'Again', version: shop.version });
    expect([stale.statusCode, stale.json().error.reason]).toEqual([409, 'goal_changed']);
    expect((await send('PUT', maria, `/api/goals/${shop.id}/status`, { status: 'reached', version: shop.version + 1 })).statusCode).toBe(403);
    expect((await send('POST', maria, '/api/goals', { title: 'Leads', department: sales.id })).statusCode).toBe(201);
  });

  it('tells each person where they may set work, goals and pipelines, as the routes decide it', async () => {
    const { db, companyId, ceo, oleg, dev, send, get, app } = await company();
    const [shop] = await db.insert(departments).values({ companyId, parentId: dev.id, name: 'Shop', roleCode: 'DEV', position: 1 }).returning();
    const pavel = await invitePerson(app, ceo, { name: 'Pavel', email: 'pavel@acme.com', access: { departments: [shop!.id] } });
    expect((await send('POST', ceo, '/api/goals', { title: 'Grow' })).statusCode).toBe(201);
    expect((await send('POST', ceo, '/api/goals', { title: 'Shop', department: dev.id })).statusCode).toBe(201);
    expect((await send('POST', ceo, '/api/goals', { title: 'Cart', department: shop!.id })).statusCode).toBe(201);
    expect((await send('POST', ceo, '/api/pipelines', { name: 'Releases', department: dev.id, stages: [{ key: 'a', parent: null, name: 'Build', ownerRole: 'DEV-BE' }] })).statusCode).toBe(201);
    const places = async (token: string) => {
      const read = (await get(token, '/api/task-departments')).json();
      return [read.mayPlanCompany, ...read.departments.map((d: { name: string | null; mine: boolean; mayPlan: boolean }) => [d.mine, d.mayPlan])];
    };
    const goalRights = async (token: string) => (await get(token, '/api/goals')).json().goals.map((g: { title: string; mayEdit: boolean }) => [g.title, g.mayEdit]);
    const pipelineRights = async (token: string) => (await get(token, '/api/pipelines')).json().pipelines.map((p: { mayEdit: boolean }) => p.mayEdit);
    expect(await places(ceo)).toEqual([true, [true, true], [true, true]]);
    expect(await places(oleg)).toEqual([false, [true, true], [false, false]]);
    /* A person of one product has its department among theirs, but sets work only in the product. */
    expect(await places(pavel)).toEqual([false, [true, false], [false, false]]);
    expect(await goalRights(oleg)).toEqual([['Grow', false], ['Shop', true], ['Cart', true]]);
    expect(await goalRights(pavel)).toEqual([['Grow', false], ['Shop', false], ['Cart', true]]);
    expect([await pipelineRights(ceo), await pipelineRights(oleg), await pipelineRights(pavel)]).toEqual([[true], [true], [false]]);
    const one = (await get(pavel, `/api/goals/${(await get(pavel, '/api/goals')).json().goals[2].id}`)).json().goal;
    expect(one.mayEdit).toBe(true);
  });

  it('keeps every change in the goal history and tells open screens', async () => {
    const { ceo, oleg, dev, send, get, heard } = await company();
    const shop = (await send('POST', oleg, '/api/goals', { title: 'Shop', department: dev.id })).json().goal;
    const edited = (await send('PATCH', oleg, `/api/goals/${shop.id}`, { why: 'People buy without calling us.', version: shop.version })).json().goal;
    await send('PUT', ceo, `/api/goals/${shop.id}/status`, { status: 'reached', version: edited.version });

    const { goal, log } = (await get(oleg, `/api/goals/${shop.id}`)).json();
    expect(goal).toMatchObject({ status: 'reached', why: 'People buy without calling us.' });
    expect(log.map((l: { kind: string; data: unknown; by: { name: string } }) => [l.kind, l.data, l.by.name])).toEqual([
      ['created', {}, 'Oleg'],
      ['edited', { fields: ['why'] }, 'Oleg'],
      ['status', { fromStatus: 'active', toStatus: 'reached' }, 'Ivan'],
    ]);
    expect(heard.filter(m => m.type === 'tracker')).toHaveLength(3);
  });
});
