import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, assistants, companies, departments, people, subscriptions, tasks } from '../src/db/schema.js';
import { createTask } from '../src/modules/tasks/engine.js';
import type { StreamMessage } from '../src/modules/events/bus.js';
import { as, echelonsTurn, invitePerson, setUpCompany, testApp } from './helpers.js';

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

  it("counts for a reader only the tasks they see: never the work of another person's assistant", async () => {
    const { db, ctx, companyId, ceo, oleg, dev, ivanId, send, get } = await company();
    const [avaPerson] = await db.insert(people).values({ companyId, name: 'Ava', status: 'active', isAgent: true, assistantOf: ivanId, scopeKind: 'company' }).returning();
    const [ava] = await db.insert(agents).values({ companyId, kind: 'assistant', name: 'Ava', model: '' }).returning();
    await db.insert(assistants).values({ personId: avaPerson!.id, companyId, program: 'avaclone', agentId: ava!.id });
    const grow = (await send('POST', ceo, '/api/goals', { title: 'Grow' })).json().goal;
    const shop = (await send('POST', oleg, '/api/goals', { title: 'Shop', department: dev.id, parent: grow.id })).json().goal;
    const ads = (await send('POST', oleg, '/api/goals', { title: 'Ads', department: dev.id })).json().goal;
    const [sub] = await db.select().from(subscriptions);
    const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) => (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
    const head = await hire('Hana', 'head', 'DEV-HEAD');
    const bruno = await hire('Bruno', 'worker', 'DEV-BE');
    await echelonsTurn(db, companyId);
    const task = async (status: 'open' | 'done', goalId: string | null, hidden: boolean, parentId: string | null = null) => {
      const { task: made } = await createTask(ctx, { agentId: head.id }, { title: 'Work', brief: '', body: '', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true, resultKind: 'code' });
      await db.update(tasks).set({ status, goalId, parentId, closedAt: status === 'open' ? null : new Date(), ...(hidden ? { assigneeAgentId: ava!.id, executorAgentId: ava!.id } : {}) }).where(eq(tasks.id, made.id));
      return made;
    };
    const first = await task('open', shop.id, false);
    await task('done', shop.id, false);
    /* Ivan's assistant's work: open and done, on the goal, above it, under visible work, and alone on a goal. */
    await task('open', shop.id, true);
    await task('done', grow.id, true);
    await task('done', null, true, first.id);
    await task('open', ads.id, true);

    const counted = async (token: string) => ((await get(token, '/api/goals')).json().goals as { title: string; progress: number | null; done: number; total: number }[]).map(g => [g.title, g.done, g.total, g.progress]);
    const listed = await get(oleg, '/api/tasks?status=all');
    expect(listed.statusCode, listed.body).toBe(200);
    expect((listed.json().tasks as { number: number }[]).map(t => t.number)).toEqual([2, 1]);
    expect(await counted(oleg)).toEqual([['Grow', 1, 2, 0.5], ['Shop', 1, 2, 0.5], ['Ads', 0, 0, null]]);
    expect((await get(oleg, `/api/goals/${ads.id}`)).json().goal).toMatchObject({ done: 0, total: 0, progress: null });
    /* Its owner sees it all. */
    expect(await counted(ceo)).toEqual([['Grow', 3, 5, 0.6], ['Shop', 2, 4, 0.5], ['Ads', 0, 1, 0]]);
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
    const { oleg, maria, dev, sales, mariaId, send } = await company();
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
