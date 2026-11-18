import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, departments, tasks, turns } from '../src/db/schema.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { ensureOpenTurn } from '../src/modules/tasks/turn-department.js';
import { echelonsTurn } from './helpers.js';
import { call, company, text, work } from './turns-company.js';

describe('turns of each department', () => {
  it('closes the open turn of a department that is removed, and keeps it in the history without it', async () => {
    const { app, db, companyId, sales, ceoToken } = await company();
    await db.update(agents).set({ removedAt: new Date() }).where(eq(agents.departmentId, sales.id));
    await db.insert(turns).values({ companyId, departmentId: sales.id, number: 1, goal: 'Launch.', status: 'open', openedAt: new Date() });
    const removed = await app.inject({ method: 'POST', url: '/api/departments/build', payload: { items: [{ department: sales.id, note: '', remove: true }] }, headers: { cookie: `hh_session=${ceoToken}` } });
    expect(removed.statusCode).toBe(201);
    const kept = await db.select({ n: turns.number, s: turns.status, d: turns.departmentId, opened: turns.openedAt, closed: turns.closedAt }).from(turns).orderBy(asc(turns.number));
    expect(kept.map(t => [t.n, t.s, t.d, t.opened !== null, t.closed !== null])).toEqual([[1, 'closed', null, true, true]]);
  });

  it('puts a new task into no turn, in a department with an open turn or without one, at the top or under another task', async () => {
    const { db, ctx, companyId, ceo, dev, sales, hana, sara } = await company();
    const open = await echelonsTurn(db, companyId);
    expect(open.departmentId).toBe(dev.id);
    const [shop] = await db.insert(departments).values({ companyId, name: 'Shop', parentId: dev.id, roleCode: 'DEV' }).returning();
    const made = async (departmentId: string, assigneeAgentId: string, parentId?: string) =>
      (await createTask(ctx, { personId: ceo.id }, { title: 'Work', brief: '', body: '', departmentId, assigneeAgentId, parentId })).task;
    const root = await made(dev.id, hana.id);
    expect([root.turnId, (await made(shop!.id, hana.id)).turnId, (await made(sales.id, sara.id)).turnId, (await made(dev.id, hana.id, root.id)).turnId]).toEqual([null, null, null, null]);
  });
});

describe("each department's turn for people", () => {
  it('shows on each department its own open turn with the results accepted into it, and none where it has no turn', async () => {
    const { app, db, ctx, companyId, ceo, dev, sales, design, hana, sara, ceoToken, get } = await company();
    const [devTurn, salesTurn] = await db.insert(turns).values([
      { companyId, departmentId: dev.id, number: 1, goal: 'The next release.', status: 'open', openedAt: new Date() },
      { companyId, departmentId: sales.id, number: 2, goal: 'The next release.', status: 'open', openedAt: new Date() },
    ]).returning();
    const made = async (title: string, departmentId: string, assigneeAgentId: string) => (await createTask(ctx, { personId: ceo.id }, { title, brief: '', body: '', departmentId, assigneeAgentId })).task;
    const accepted = async (task: { id: string }, turnId: string) => db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: null, turnId }).where(eq(tasks.id, task.id));
    await accepted(await made('Checkout', dev.id, hana.id), devTurn!.id);
    await accepted(await made('Announcement', sales.id, sara.id), salesTurn!.id);
    await made('Mailing', sales.id, sara.id);
    const org = (await get(ceoToken, '/api/org')).json() as { departments: { id: string; turnProgress: unknown }[] };
    const progress = new Map(org.departments.map(d => [d.id, d.turnProgress]));
    expect(progress.get(dev.id)).toEqual({ turnNumber: 1, done: 1, total: 1 });
    expect(progress.get(sales.id)).toEqual({ turnNumber: 2, done: 1, total: 1 });
    expect(progress.get(design.id)).toBeNull();
    expect((await get(ceoToken, `/api/turns/current?department=${sales.id}`)).json().turn).toMatchObject({ number: 2, departmentId: sales.id, version: null, tasks: { total: 1, done: 1 } });
    expect((await get(ceoToken, `/api/turns/current?department=${design.id}`)).json().turn).toBeNull();
    expect((await get(ceoToken, `/api/departments/${sales.id}/tree`)).json().tree.turn).toMatchObject({ number: 2, branch: 'turn-2' });
    expect((await get(ceoToken, `/api/departments/${dev.id}/tree`)).json().tree.turn).toMatchObject({ number: 1, branch: 'turn-1' });
    const all = (await get(ceoToken, '/api/turns')).json().turns as { number: number; departmentId: string; canChangeMode?: boolean }[];
    expect(all.map(t => [t.number, t.departmentId, t.canChangeMode])).toEqual([[1, dev.id, undefined], [2, sales.id, undefined]]);
    /* Nobody picks how a turn runs: every turn is the next release of its department. */
    expect((await app.inject({ method: 'PATCH', url: '/api/turns/2', payload: { mode: 'echelons' }, headers: { cookie: `hh_session=${ceoToken}` } })).statusCode).toBe(404);
  });
});

describe('which turns come out as releases', () => {
  it('says of each turn whether its department releases it: one that keeps a repository does, one without has nothing to release', async () => {
    const { db, companyId, dev, sales, ceoToken, get } = await company();
    await db.update(departments).set({ repoUrl: 'https://github.com/acme/shop.git' }).where(eq(departments.id, dev.id));
    await db.update(departments).set({ repoUrl: null }).where(eq(departments.id, sales.id));
    await db.insert(turns).values([
      { companyId, departmentId: dev.id, number: 1, goal: 'The next release.', status: 'open', openedAt: new Date() },
      { companyId, departmentId: sales.id, number: 2, goal: 'The next release.', status: 'open', openedAt: new Date() },
    ]);
    const all = (await get(ceoToken, '/api/turns')).json().turns as { number: number; releases: boolean }[];
    expect(all.map(t => [t.number, t.releases])).toEqual([[1, true], [2, false]]);
    expect((await get(ceoToken, `/api/turns/current?department=${sales.id}`)).json().turn).toMatchObject({ number: 2, releases: false });
  });
});

describe("a head's turns", () => {
  it('gives tasks of its own department, renames its own open turn and lists its own turns, and no other', async () => {
    const { db, companyId, dev, sales, hana, bruno, tools } = await company();
    await echelonsTurn(db, companyId);
    const head = await tools(hana);
    const own = await call(head, 'add_tasks', { tasks: [{ title: 'Checkout', brief: 'In a line.', body: 'Build it.' }] });
    expect(own.isError, text(own)).toBeFalsy();
    expect((await db.select().from(tasks))[0]).toMatchObject({ departmentId: dev.id, assigneeAgentId: hana.id, turnId: null });
    expect((await call(head, 'add_tasks', { tasks: [work(sales.id, 'Price list')] })).isError).toBe(true);
    const [devTurn, salesTurn] = await db.select().from(turns).orderBy(asc(turns.number));
    expect([devTurn!.departmentId, salesTurn!.departmentId]).toEqual([dev.id, sales.id]);
    expect((await call(head, 'edit_turn', { turn: salesTurn!.number, title: 'Mine now' })).isError).toBe(true);
    expect((await call(head, 'edit_turn', { turn: devTurn!.number, title: 'Card payments' })).isError).toBeFalsy();
    await db.update(turns).set({ status: 'closed', closedAt: new Date(), version: 'v1.0.0' }).where(eq(turns.id, devTurn!.id));
    const [next] = await db.insert(turns).values({ companyId, departmentId: dev.id, number: 4, goal: 'The next release.', status: 'open', openedAt: new Date(), baseVersion: 'v1.0.0' }).returning();
    /* Its released turn and its open one; none of Sales. */
    const listed = JSON.parse(text(await call(head, 'turns', {}))) as { number: number; status: string; version: string | null; department: { id: string } }[];
    expect(listed.map(t => [t.number, t.status, t.version, t.department.id])).toEqual([[devTurn!.number, 'closed', 'v1.0.0', dev.id], [next!.number, 'open', null, dev.id]]);
    /* An employee who heads nothing gives no tasks to a department. */
    expect((await (await tools(bruno)).listTools()).tools.map(t => t.name)).not.toContain('add_tasks');
  });
});

describe('turns only of departments that release', () => {
  it('opens no turn for a department made without a repository, and opens one for a department that keeps one', async () => {
    const { app, db, companyId, dev, ceoToken } = await company();
    const built = await app.inject({ method: 'POST', url: '/api/departments/build', payload: { items: [{ template: 'marketing' }] }, headers: { cookie: `hh_session=${ceoToken}` } });
    expect(built.statusCode, built.body).toBe(201);
    const [marketing] = await db.select().from(departments).where(eq(departments.templateKey, 'marketing'));
    expect(await db.select().from(turns).where(eq(turns.departmentId, marketing!.id))).toEqual([]);
    expect(await db.transaction(tx => ensureOpenTurn(tx, companyId, dev.id))).toBeNull();
    await db.update(departments).set({ repoUrl: 'https://github.com/acme/shop.git' }).where(eq(departments.id, dev.id));
    expect(await db.transaction(tx => ensureOpenTurn(tx, companyId, dev.id))).toMatchObject({ departmentId: dev.id, status: 'open', version: null });
  });

  it('lists in the turns tool every result accepted into a turn whose parent is in no turn, as #1323 is in turn 28, and a subtask under its parent in the same turn once', async () => {
    const { db, ctx, companyId, ceo, dev, hana, bruno, orchestrator, tools } = await company();
    const [turn] = await db.insert(turns).values({ companyId, departmentId: dev.id, number: 28, goal: 'The next release.', status: 'open', openedAt: new Date() }).returning();
    const made = async (title: string, assigneeAgentId: string, parentId?: string) => (await createTask(ctx, { personId: ceo.id }, { title, brief: '', body: '', departmentId: dev.id, assigneeAgentId, parentId })).task;
    const accepted = (id: string) => db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: null, turnId: turn!.id }).where(eq(tasks.id, id));
    const coordination = await made('Coordinate', hana.id);
    const member = await made('Change the repository', bruno.id, coordination.id);
    await accepted(member.id);
    const whole = await made('Checkout', hana.id);
    const part = await made('Checkout totals', bruno.id, whole.id);
    await accepted(whole.id);
    await accepted(part.id);
    const listed = JSON.parse(text(await call(await tools(orchestrator), 'turns', {}))) as { number: number; tasks: { number: number }[] }[];
    expect(listed.find(t => t.number === 28)!.tasks.map(t => t.number)).toEqual([member.number, whole.number]);
  });
});
