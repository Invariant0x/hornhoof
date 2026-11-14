import { asc } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { tasks, turns } from '../src/db/schema.js';
import { call, company, text, work } from './turns-company.js';

const rows = async (db: Awaited<ReturnType<typeof company>>['db']) =>
  db.select({ number: tasks.number, title: tasks.title, turnId: tasks.turnId, status: tasks.status, assignee: tasks.assigneeAgentId, departmentId: tasks.departmentId }).from(tasks).orderBy(asc(tasks.number));

describe('tasks outside every turn', () => {
  it("gives work without a turn to its department's head at once, and keeps it out of the running turn", async () => {
    const { db, orchestrator, dev, hana, tools, queued, get, ceoToken } = await company();
    const boss = await tools(orchestrator);
    await call(boss, 'plan_turn', { department: dev.id, mode: 'echelons', title: 'Payments', goal: 'People can pay by card.', tasks: [work(dev.id, 'Checkout')] });
    const added = await call(boss, 'add_tasks', { tasks: [work(dev.id, 'Fix the login')] });
    expect(added.isError).toBeFalsy();
    expect(text(added)).toBe('Given outside turns: #2 to Hana.');
    const [turn] = await db.select().from(turns);
    expect(await rows(db)).toEqual([
      { number: 1, title: 'Checkout', turnId: turn!.id, status: 'open', assignee: hana.id, departmentId: dev.id },
      { number: 2, title: 'Fix the login', turnId: null, status: 'open', assignee: hana.id, departmentId: dev.id },
    ]);
    expect((await queued(hana.id)).map(j => j.prompt).join('\n')).toContain('Fix the login');
    /* The turn holds only its own goal, for agents and for people. */
    const listed = JSON.parse(text(await call(boss, 'turns', {}))) as { number: number; tasks: { number: number }[] }[];
    expect(listed.map(t => [t.number, t.tasks.map(x => x.number)])).toEqual([[1, [1]]]);
    expect((await get(ceoToken, '/api/turns')).json().turns.map((t: { number: number; tasks: { total: number } }) => [t.number, t.tasks.total])).toEqual([[1, 1]]);
    const lines = (await get(ceoToken, `/api/tasks?status=all&department=${dev.id}`)).json().tasks as { number: number; turn: number | null }[];
    expect(lines.map(l => [l.number, l.turn])).toEqual([[2, null], [1, 1]]);
  });

  it('closes the running turn when its goals are done, whatever work outside turns still runs', async () => {
    const { db, orchestrator, dev, hana, tools } = await company();
    const boss = await tools(orchestrator);
    await call(boss, 'plan_turn', { department: dev.id, mode: 'echelons', title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    await call(boss, 'add_tasks', { tasks: [work(dev.id, 'Fix the login')] });
    await call(await tools(hana), 'report', { task: 1, done: true, summary: 'Shipped.' });
    expect((await db.select({ status: turns.status }).from(turns)).map(t => t.status)).toEqual(['closed']);
    expect((await rows(db)).map(r => [r.number, r.status])).toEqual([[1, 'done'], [2, 'open']]);
  });

  it('gives work without a turn while the department waits for its planned turn, and starts no turn for it', async () => {
    const { db, orchestrator, sales, sara, tools } = await company();
    const boss = await tools(orchestrator);
    await call(boss, 'plan_turn', { department: sales.id, mode: 'echelons', title: 'Launch', goal: 'Tell people.', tasks: [work(sales.id, 'Announcement')] });
    await call(boss, 'plan_turn', { department: sales.id, mode: 'echelons', title: 'Offers', goal: 'Special prices.', tasks: [work(sales.id, 'Price list')] });
    const added = await call(boss, 'add_tasks', { tasks: [work(sales.id, 'Call the bank')] });
    expect(added.isError).toBeFalsy();
    expect((await db.select({ number: turns.number, status: turns.status }).from(turns).orderBy(asc(turns.number))).map(t => [t.number, t.status])).toEqual([[1, 'open'], [2, 'planned']]);
    expect((await rows(db)).map(r => [r.number, r.status, r.turnId === null, r.assignee])).toEqual([
      [1, 'open', false, sara.id],
      [2, 'planned', false, null],
      [3, 'open', true, sara.id],
    ]);
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
