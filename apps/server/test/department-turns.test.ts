import { asc, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, departments, people, tasks, turns } from '../src/db/schema.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { reconcile } from '../src/modules/tasks/reconcile.js';
import { invitePerson } from './helpers.js';
import { call, company, text, work } from './turns-company.js';

const statuses = async (db: Awaited<ReturnType<typeof company>>['db']) =>
  (await db.select({ n: turns.number, s: turns.status, d: turns.departmentId }).from(turns).orderBy(asc(turns.number))).map(t => [t.n, t.s, t.d]);

describe('turns of each department', () => {
  it('runs a turn of each department at once, numbered across the company', async () => {
    const { db, orchestrator, dev, sales, hana, sara, tools, queued } = await company();
    const boss = await tools(orchestrator);
    const payments = await call(boss, 'plan_turn', { department: dev.id, mode: 'echelons', title: 'Payments', goal: 'People can pay by card.', tasks: [work(dev.id, 'Checkout')] });
    expect(text(payments)).toContain('Turn 1');
    const launch = await call(boss, 'plan_turn', { department: sales.id, mode: 'echelons', title: 'Launch', goal: 'Tell people.', tasks: [{ title: 'Announcement', brief: 'In a line.', body: 'What to say.' }] });
    expect(launch.isError).toBeFalsy();
    expect(text(launch)).toContain('Turn 2');
    expect(text(launch)).toContain('started');
    expect(await statuses(db)).toEqual([
      [1, 'open', dev.id],
      [2, 'open', sales.id],
    ]);
    expect((await queued(hana.id)).map(j => j.prompt).join()).toContain('Checkout');
    expect((await queued(sara.id)).map(j => j.prompt).join()).toContain('Announcement');
  });

  it("starts a department's planned turn when its own open turn closes, whatever other departments do", async () => {
    const { db, orchestrator, dev, sales, hana, sara, tools } = await company();
    const boss = await tools(orchestrator);
    await call(boss, 'plan_turn', { mode: 'echelons', title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    await call(boss, 'plan_turn', { mode: 'echelons', title: 'Launch', goal: 'Tell people.', tasks: [work(sales.id, 'Announcement')] });
    await call(boss, 'plan_turn', { mode: 'echelons', title: 'Refunds', goal: 'Money goes back.', tasks: [work(dev.id, 'Refund button')] });
    expect(await statuses(db)).toEqual([
      [1, 'open', dev.id],
      [2, 'open', sales.id],
      [3, 'planned', dev.id],
    ]);
    await call(await tools(sara), 'report', { task: 2, done: true, summary: 'Announced.' });
    expect(await statuses(db)).toEqual([
      [1, 'open', dev.id],
      [2, 'closed', sales.id],
      [3, 'planned', dev.id],
    ]);
    await call(await tools(hana), 'report', { task: 1, done: true, summary: 'Shipped.' });
    expect(await statuses(db)).toEqual([
      [1, 'closed', dev.id],
      [2, 'closed', sales.id],
      [3, 'open', dev.id],
    ]);
  });

  it("starts at the next check a department's planned turn left waiting while its department runs none", async () => {
    const { db, ctx, orchestrator, sales, sara, tools, queued } = await company();
    const boss = await tools(orchestrator);
    await call(boss, 'plan_turn', { mode: 'echelons', title: 'Launch', goal: 'Tell people.', tasks: [work(sales.id, 'Announcement')] });
    await call(boss, 'plan_turn', { mode: 'echelons', title: 'Offers', goal: 'Special prices.', tasks: [work(sales.id, 'Price list')] });
    /* As a company comes out of the update that gave each department its turns: the turn it waited for closed long ago. */
    await db.update(turns).set({ status: 'closed', closedAt: new Date() }).where(eq(turns.number, 1));
    await reconcile(ctx);
    expect(await statuses(db)).toEqual([
      [1, 'closed', sales.id],
      [2, 'open', sales.id],
    ]);
    expect((await queued(sara.id)).map(j => j.prompt).join()).toContain('Price list');
  });

  it("starts every other department's waiting turn when starting one of them fails", async () => {
    const { db, ctx, orchestrator, sales, dev, tools } = await company();
    const boss = await tools(orchestrator);
    await call(boss, 'plan_turn', { mode: 'echelons', title: 'Launch', goal: 'Tell people.', tasks: [work(sales.id, 'Announcement')] });
    await call(boss, 'plan_turn', { mode: 'echelons', title: 'Offers', goal: 'Special prices.', tasks: [work(sales.id, 'Price list')] });
    await call(boss, 'plan_turn', { mode: 'echelons', title: 'Login', goal: 'People sign in.', tasks: [work(dev.id, 'Login page')] });
    await call(boss, 'plan_turn', { mode: 'echelons', title: 'Sign-up', goal: 'People sign up.', tasks: [work(dev.id, 'Sign-up page')] });
    await db.update(turns).set({ status: 'closed', closedAt: new Date() }).where(inArray(turns.number, [1, 3]));
    /* The first turn that starts cannot be told about: that company's trouble stops no other department or company. */
    const publish = ctx.bus.publish.bind(ctx.bus);
    let failed = false;
    ctx.bus.publish = ((...args: Parameters<typeof publish>) => {
      if (!failed) { failed = true; throw new Error('The bus is down.'); }
      return publish(...args);
    }) as typeof ctx.bus.publish;
    await expect(reconcile(ctx)).resolves.toBeUndefined();
    expect((await statuses(db)).filter(([, status]) => status === 'open').map(([number]) => number).sort()).toEqual([2, 4]);
  });

  it('closes the turns of a department that is removed, and keeps them in the history without it', async () => {
    const { app, db, companyId, sales, ceoToken } = await company();
    await db.update(agents).set({ removedAt: new Date() }).where(eq(agents.departmentId, sales.id));
    await db.insert(turns).values([
      { companyId, departmentId: sales.id, number: 1, goal: 'Launch.', status: 'open', openedAt: new Date() },
      { companyId, departmentId: sales.id, number: 2, goal: 'Offers.', status: 'planned' },
    ]);
    const removed = await app.inject({ method: 'POST', url: '/api/departments/build', payload: { items: [{ department: sales.id, note: '', remove: true }] }, headers: { cookie: `hh_session=${ceoToken}` } });
    expect(removed.statusCode).toBe(201);
    const kept = await db.select({ n: turns.number, s: turns.status, d: turns.departmentId, opened: turns.openedAt, closed: turns.closedAt }).from(turns).orderBy(asc(turns.number));
    expect(kept.map(t => [t.n, t.s, t.d, t.opened !== null, t.closed !== null])).toEqual([[1, 'closed', null, true, true], [2, 'closed', null, false, true]]);
  });

  it('lays a turn out for one department only', async () => {
    const { db, orchestrator, dev, sales, tools } = await company();
    const boss = await tools(orchestrator);
    const mixed = await call(boss, 'plan_turn', { mode: 'echelons', title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout'), work(sales.id, 'Pricing')] });
    expect(mixed.isError).toBe(true);
    expect(text(mixed)).toMatch(/one department/i);
    const named = await call(boss, 'plan_turn', { department: sales.id, mode: 'echelons', title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    expect(named.isError).toBe(true);
    expect(await db.select().from(turns)).toEqual([]);
    await call(boss, 'plan_turn', { mode: 'echelons', title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    const other = await call(boss, 'add_tasks', { turn: 1, tasks: [work(sales.id, 'Pricing')] });
    expect(other.isError).toBe(true);
    expect(text(other)).toMatch(/plan_turn/);
    const own = await call(boss, 'add_tasks', { turn: 1, tasks: [{ title: 'Receipt', brief: 'In a line.', body: 'Send one.' }] });
    expect(own.isError).toBeFalsy();
    expect((await db.select().from(tasks).where(eq(tasks.title, 'Receipt')))[0]).toMatchObject({ departmentId: dev.id });
  });

  it('puts a new root task into the open turn of its own department, and into none while it has none or works all the time', async () => {
    const { db, ctx, ceo, orchestrator, dev, sales, hana, sara, tools } = await company();
    await call(await tools(orchestrator), 'plan_turn', { mode: 'echelons', title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    const [devTurn] = await db.select().from(turns);
    const [shop] = await db.insert(departments).values({ companyId: dev.companyId, name: 'Shop', parentId: dev.id, roleCode: 'DEV' }).returning();
    const made = async (departmentId: string, assigneeAgentId: string, parentId?: string) =>
      (await createTask(ctx, { personId: ceo.id }, { title: 'Work', brief: '', body: '', departmentId, assigneeAgentId, parentId })).task;
    expect((await made(dev.id, hana.id)).turnId).toBe(devTurn!.id);
    expect((await made(shop!.id, hana.id)).turnId).toBe(devTurn!.id);
    const deal = await made(sales.id, sara.id);
    expect(deal.turnId).toBeNull();
    /* Work under a task stays in the turn of the task it is part of. */
    expect((await made(dev.id, hana.id, deal.id)).turnId).toBeNull();
    await db.update(departments).set({ workMode: 'continuous' }).where(eq(departments.id, dev.id));
    expect((await made(dev.id, hana.id)).turnId).toBeNull();
  });

  it('merges turns of one department only', async () => {
    const { db, orchestrator, dev, sales, tools } = await company();
    const boss = await tools(orchestrator);
    await call(boss, 'plan_turn', { mode: 'echelons', title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    await call(boss, 'plan_turn', { mode: 'echelons', title: 'Launch', goal: 'Tell people.', tasks: [work(sales.id, 'Announcement')] });
    await call(boss, 'plan_turn', { mode: 'echelons', title: 'Offers', goal: 'Special prices.', tasks: [work(sales.id, 'Price list')] });
    const across = await call(boss, 'merge_turn', { source: 3, target: 1 });
    expect(across.isError).toBe(true);
    expect(text(across)).toMatch(/department/);
    expect((await call(boss, 'merge_turn', { source: 3, target: 2 })).isError).toBeFalsy();
    expect((await db.select().from(tasks).where(eq(tasks.title, 'Price list')))[0]!.turnId).toBe((await db.select().from(turns).where(eq(turns.number, 2)))[0]!.id);
  });

  it('tells the head of the department that its turn is over, and the orchestrator too', async () => {
    const { orchestrator, sales, sara, tools, queued } = await company();
    const boss = await tools(orchestrator);
    await call(boss, 'plan_turn', { mode: 'echelons', title: 'Launch', goal: 'Tell people.', tasks: [work(sales.id, 'Announcement')] });
    const cancelled = await call(boss, 'cancel_task', { task: 1, why: 'Not now.' });
    expect(text(cancelled)).toContain('Turn 1 "Launch"');
    expect((await queued(sara.id)).map(j => j.prompt).join('\n')).toContain('the last open task of Turn 1 "Launch"');
    const reported = await call(boss, 'plan_turn', { mode: 'echelons', title: 'Offers', goal: 'Special prices.', tasks: [work(sales.id, 'Price list')] });
    expect(reported.isError).toBeFalsy();
    const done = await call(await tools(sara), 'report', { task: 2, done: true, summary: 'Prices are out.' });
    expect(text(done)).toContain('the last open task of Turn 2 "Offers"');
    expect((await queued(orchestrator.id)).map(j => j.prompt).join('\n')).toContain('Turn 2 "Offers"');
  });
});

describe("each department's turn for people", () => {
  it('shows on each department its own open turn, and the running turn of a department', async () => {
    const { orchestrator, dev, sales, design, tools, ceoToken, get } = await company();
    const boss = await tools(orchestrator);
    await call(boss, 'plan_turn', { mode: 'echelons', title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    await call(boss, 'plan_turn', { mode: 'echelons', title: 'Launch', goal: 'Tell people.', tasks: [work(sales.id, 'Announcement'), work(sales.id, 'Mailing')] });
    const org = (await get(ceoToken, '/api/org')).json() as { departments: { id: string; turnProgress: unknown }[] };
    const progress = new Map(org.departments.map(d => [d.id, d.turnProgress]));
    expect(progress.get(dev.id)).toEqual({ turnNumber: 1, done: 0, total: 1 });
    expect(progress.get(sales.id)).toEqual({ turnNumber: 2, done: 0, total: 2 });
    expect(progress.get(design.id)).toBeNull();
    expect((await get(ceoToken, `/api/turns/current?department=${sales.id}`)).json().turn).toMatchObject({ number: 2, departmentId: sales.id, tasks: { total: 2, done: 0 } });
    expect((await get(ceoToken, `/api/turns/current?department=${design.id}`)).json().turn).toBeNull();
    expect((await get(ceoToken, `/api/departments/${sales.id}/tree`)).json().tree.turn).toMatchObject({ number: 2, branch: 'turn-2' });
    expect((await get(ceoToken, `/api/departments/${dev.id}/tree`)).json().tree.turn).toMatchObject({ number: 1, branch: 'turn-1' });
    const all = (await get(ceoToken, '/api/turns')).json().turns as { number: number; departmentId: string }[];
    expect(all.map(t => [t.number, t.departmentId])).toEqual([[1, dev.id], [2, sales.id]]);
  });

  it("lets the owner of a department pick how its planned turn runs, and not how another department's runs", async () => {
    const { app, db, orchestrator, dev, sales, tools, ceoToken, get } = await company();
    const boss = await tools(orchestrator);
    await call(boss, 'plan_turn', { mode: 'echelons', title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    await call(boss, 'plan_turn', { mode: 'echelons', title: 'Refunds', goal: 'Money goes back.', tasks: [work(dev.id, 'Refund button')] });
    await call(boss, 'plan_turn', { mode: 'echelons', title: 'Launch', goal: 'Tell people.', tasks: [work(sales.id, 'Announcement')] });
    await call(boss, 'plan_turn', { mode: 'echelons', title: 'Offers', goal: 'Special prices.', tasks: [work(sales.id, 'Price list')] });
    const sam = await invitePerson(app, ceoToken, { name: 'Sam', email: 'sam@acme.test', access: { departments: [sales.id] } });
    const [samRow] = await db.select().from(people).where(eq(people.email, 'sam@acme.test'));
    await db.update(departments).set({ ownerPersonId: samRow!.id }).where(eq(departments.id, sales.id));
    const patch = (token: string, number: number) => app.inject({ method: 'PATCH', url: `/api/turns/${number}`, payload: { mode: 'echelons' }, headers: { cookie: `hh_session=${token}` } });
    expect((await patch(sam, 4)).statusCode).toBe(200);
    expect((await patch(sam, 2)).statusCode).toBe(403);
    expect((await patch(ceoToken, 2)).statusCode).toBe(200);
    const seen = (await get(sam, '/api/turns')).json().turns as { number: number; canChangeMode: boolean }[];
    expect(seen.map(t => [t.number, t.canChangeMode])).toEqual([[1, false], [2, false], [3, true], [4, true]]);
  });
});

describe("a head's turns", () => {
  it('lays out, adds to, renames and merges the turns of its own department, and no other', async () => {
    const { db, orchestrator, dev, sales, hana, bruno, tools } = await company();
    const head = await tools(hana);
    const names = (await head.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['turns', 'plan_turn', 'add_tasks', 'edit_turn', 'merge_turn']));
    const own = await call(head, 'plan_turn', { mode: 'echelons', title: 'Payments', goal: 'Card payments.', tasks: [{ title: 'Checkout', brief: 'In a line.', body: 'Build it.' }] });
    expect(own.isError).toBeFalsy();
    expect((await db.select().from(turns))[0]).toMatchObject({ number: 1, departmentId: dev.id, status: 'open', createdByAgentId: hana.id });
    expect((await db.select().from(tasks))[0]).toMatchObject({ departmentId: dev.id, assigneeAgentId: hana.id });
    expect((await call(head, 'plan_turn', { mode: 'echelons', title: 'Prices', goal: 'Prices.', tasks: [work(sales.id, 'Price list')] })).isError).toBe(true);
    expect((await call(head, 'plan_turn', { department: sales.id, mode: 'echelons', title: 'Prices', goal: 'Prices.', tasks: [{ title: 'Price list', brief: 'In a line.', body: 'List.' }] })).isError).toBe(true);
    await call(await tools(orchestrator), 'plan_turn', { mode: 'echelons', title: 'Launch', goal: 'Tell people.', tasks: [work(sales.id, 'Announcement')] });
    expect((await call(head, 'add_tasks', { turn: 2, tasks: [{ title: 'More', brief: 'In a line.', body: 'More.' }] })).isError).toBe(true);
    expect((await call(head, 'edit_turn', { turn: 2, title: 'Mine now' })).isError).toBe(true);
    expect((await call(head, 'edit_turn', { turn: 1, title: 'Card payments' })).isError).toBeFalsy();
    await call(head, 'plan_turn', { mode: 'echelons', title: 'Refunds', goal: 'Money goes back.', tasks: [{ title: 'Refund button', brief: 'In a line.', body: 'Build it.' }] });
    expect((await call(head, 'merge_turn', { source: 3, target: 2 })).isError).toBe(true);
    expect((await call(head, 'merge_turn', { source: 3, target: 1 })).isError).toBeFalsy();
    /* Its last closed turn, the merged one, and its running one; none of Sales. */
    const listed = JSON.parse(text(await call(head, 'turns', {}))) as { number: number; status: string; department: { id: string } }[];
    expect(listed.map(t => [t.number, t.status, t.department.id])).toEqual([[3, 'closed', dev.id], [1, 'open', dev.id]]);
    /* An employee who heads nothing lays out no turn. */
    expect((await (await tools(bruno)).listTools()).tools.map(t => t.name)).not.toContain('plan_turn');
  });
});
