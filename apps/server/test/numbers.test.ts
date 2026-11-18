import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { companies, departments, tasks, turns } from '../src/db/schema.js';
import { ensureOpenTurn } from '../src/modules/tasks/turn-department.js';
import { call, company, work } from './turns-company.js';

const built = (c: Awaited<ReturnType<typeof company>>) =>
  c.app.inject({ method: 'POST', url: '/api/departments/build', payload: { items: [{ template: 'support', checked: true, note: 'Answers customers.' }] }, headers: { cookie: `hh_session=${c.ceoToken}` } });
/* A department that keeps a repository opens its turn, the next release, with the next turn number of the company; one built
   without a repository opens none. */
const opensTurn = async (c: Awaited<ReturnType<typeof company>>) => {
  expect((await built(c)).statusCode).toBeLessThan(300);
  expect(await c.db.select().from(turns)).toEqual([]);
  await c.db.update(departments).set({ repoUrl: 'https://github.com/acme/shop.git' }).where(eq(departments.id, c.dev.id));
  await c.db.transaction(tx => ensureOpenTurn(tx, c.companyId, c.dev.id));
};

/* Task and turn numbers go on after the ones a company gave before its rows were removed, so a branch task-N or a version
   0.N.0 never names two pieces of work. */
describe('numbers of tasks and turns', () => {
  it('go on after the numbers a company already gave, though their rows are gone', async () => {
    const c = await company();
    await c.db.update(companies).set({ taskNumbersUsed: 764, turnNumbersUsed: 18 });
    const boss = await c.tools(c.orchestrator);
    const given = await call(boss, 'add_tasks', { tasks: [work(c.dev.id, 'Map progress'), work(c.dev.id, 'Department mode')] });
    expect(given.isError).toBeFalsy();
    expect((await c.db.select({ n: tasks.number }).from(tasks).orderBy(asc(tasks.number))).map(t => t.n)).toEqual([765, 766]);
    await opensTurn(c);
    expect((await c.db.select({ n: turns.number }).from(turns)).map(t => t.n)).toEqual([19]);
  });

  it('take the next number after the rows when the company gave none beyond them', async () => {
    const c = await company();
    const boss = await c.tools(c.orchestrator);
    await call(boss, 'add_tasks', { tasks: [work(c.dev.id, 'Map progress')] });
    await opensTurn(c);
    expect((await c.db.select({ n: turns.number }).from(turns)).map(t => t.n)).toEqual([1]);
    expect((await c.db.select({ n: tasks.number }).from(tasks)).map(t => t.n)).toEqual([1]);
  });
});
