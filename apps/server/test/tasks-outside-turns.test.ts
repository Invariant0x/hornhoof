import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { tasks, turns } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { echelonsTurn } from './helpers.js';
import { call, company, text, work } from './turns-company.js';

const rows = async (db: Awaited<ReturnType<typeof company>>['db']) =>
  db.select({ number: tasks.number, title: tasks.title, turnId: tasks.turnId, status: tasks.status, assignee: tasks.assigneeAgentId, departmentId: tasks.departmentId }).from(tasks).orderBy(asc(tasks.number));

describe('tasks flow outside every turn until their results are accepted', () => {
  it('keeps given work out of the open turn, for agents and for people, until a result of it is accepted', async () => {
    const { db, companyId, orchestrator, dev, hana, tools, get, ceoToken } = await company();
    const open = await echelonsTurn(db, companyId);
    const boss = await tools(orchestrator);
    const added = await call(boss, 'add_tasks', { tasks: [work(dev.id, 'Fix the login')] });
    expect(text(added)).toBe('Given: #1 to Hana.');
    expect(await rows(db)).toEqual([{ number: 1, title: 'Fix the login', turnId: null, status: 'open', assignee: hana.id, departmentId: dev.id }]);
    const listed = JSON.parse(text(await call(boss, 'turns', {}))) as { number: number; tasks: { number: number }[] }[];
    expect(listed.find(t => t.number === open.number)!.tasks).toEqual([]);
    expect((await get(ceoToken, '/api/turns')).json().turns.find((t: { number: number }) => t.number === open.number).tasks.total).toBe(0);
    const lines = (await get(ceoToken, `/api/tasks?status=all&department=${dev.id}`)).json().tasks as { number: number; turn: number | null }[];
    expect(lines.map(l => [l.number, l.turn])).toEqual([[1, null]]);
  });

  it('never closes the open turn as its work is done: only the tag of its release does, and work of a department without a repository joins no release', async () => {
    const { db, companyId, orchestrator, dev, hana, tools } = await company();
    const open = await echelonsTurn(db, companyId);
    await call(await tools(orchestrator), 'add_tasks', { tasks: [work(dev.id, 'Checkout')] });
    const done = await call(await tools(hana), 'report', { task: 1, done: true, summary: 'Shipped.' });
    expect(done.isError, text(done)).toBeFalsy();
    expect((await db.select(only(turns, 'status')).from(turns).where(eq(turns.id, open.id)))[0]).toEqual({ status: 'open' });
    expect((await rows(db)).map(r => [r.number, r.status, r.turnId])).toEqual([[1, 'done', null]]);
  });

  it('asks the orchestrator to name the department of each piece of work without a turn', async () => {
    const { db, orchestrator, tools } = await company();
    const nowhere = await call(await tools(orchestrator), 'add_tasks', { tasks: [{ title: 'Receipt', brief: 'In a line.', body: 'Send one.' }] });
    expect(nowhere.isError).toBe(true);
    expect(text(nowhere)).toMatch(/names no department/);
    expect(await rows(db)).toEqual([]);
  });

  it('lets a head give work without a turn to its own department only', async () => {
    const { db, dev, sales, hana, tools } = await company();
    const head = await tools(hana);
    const own = await call(head, 'add_tasks', { tasks: [{ title: 'Fix the login', brief: 'In a line.', body: 'Fix it.' }] });
    expect(own.isError).toBeFalsy();
    const other = await call(head, 'add_tasks', { tasks: [work(sales.id, 'Price list')] });
    expect(other.isError).toBe(true);
    expect(text(other)).toMatch(/own department/);
    expect(await rows(db)).toMatchObject([{ number: 1, title: 'Fix the login', turnId: null, departmentId: dev.id, assignee: hana.id }]);
  });
});
