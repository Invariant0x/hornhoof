import { asc } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { companies, tasks, turns } from '../src/db/schema.js';
import { call, company, work } from './turns-company.js';

/* Task and turn numbers go on after the ones a company gave before its rows were removed, so a branch task-N or a version
   0.N.0 never names two pieces of work. */
describe('numbers of tasks and turns', () => {
  it('go on after the numbers a company already gave, though their rows are gone', async () => {
    const c = await company();
    await c.db.update(companies).set({ taskNumbersUsed: 764, turnNumbersUsed: 18 });
    const boss = await c.tools(c.orchestrator);
    const planned = await call(boss, 'plan_turn', { title: 'Map', goal: 'Turn progress on the map.', mode: 'echelons', tasks: [work(c.dev.id, 'Map progress'), work(c.dev.id, 'Department mode')] });
    expect(planned.isError).toBeFalsy();
    expect((await c.db.select({ n: turns.number }).from(turns)).map(t => t.n)).toEqual([19]);
    expect((await c.db.select({ n: tasks.number }).from(tasks).orderBy(asc(tasks.number))).map(t => t.n)).toEqual([765, 766]);
  });

  it('take the next number after the rows when the company gave none beyond them', async () => {
    const c = await company();
    const boss = await c.tools(c.orchestrator);
    await call(boss, 'plan_turn', { title: 'Map', goal: 'Turn progress on the map.', mode: 'echelons', tasks: [work(c.dev.id, 'Map progress')] });
    expect((await c.db.select({ n: turns.number }).from(turns)).map(t => t.n)).toEqual([1]);
    expect((await c.db.select({ n: tasks.number }).from(tasks)).map(t => t.n)).toEqual([1]);
  });
});
