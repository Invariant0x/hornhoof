import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { migrationsBefore, migrationsThrough } from './migrations-before.js';
import { freshPglite } from './helpers-db.js';

const ACME = '00000000-0000-4000-8000-000000000a01';
const BARE = '00000000-0000-4000-8000-000000000a02';
const PLAIN = '00000000-0000-4000-8000-000000000a03';
const DEV = '00000000-0000-4000-8000-000000000b01';
const SHOP = '00000000-0000-4000-8000-000000000b02';
const MARKETING = '00000000-0000-4000-8000-000000000b03';
const DESIGN = '00000000-0000-4000-8000-000000000b04';
const SALES = '00000000-0000-4000-8000-000000000b05';
const SUPPORT = '00000000-0000-4000-8000-000000000b06';
const GONE = '00000000-0000-4000-8000-000000000b07';
const BUSY = '00000000-0000-4000-8000-000000000a04';
const OPS = '00000000-0000-4000-8000-000000000b08';
const BUILD = '00000000-0000-4000-8000-000000000b09';
const T = (n: number) => `00000000-0000-4000-8000-000000000c${String(n).padStart(2, '0')}`;
const K = (n: number) => `00000000-0000-4000-8000-000000000d${String(n).padStart(2, '0')}`;

/* A database migrated up to just before this migration, with what the given statements put in it, then through it. Each
   install holds one company. */
async function migrated(rows: string): Promise<PGlite> {
  const client = await freshPglite();
  onTestFinished(() => client.close());
  await migrate(drizzle(client), { migrationsFolder: await migrationsBefore('department_turns') });
  await client.exec(rows);
  await migrate(drizzle(client), { migrationsFolder: await migrationsThrough('department_turns') });
  return client;
}

/* Acme ran one turn for the whole company: a closed one, the open one and a planned one, each with work of several
   departments. */
const acme = () => migrated(`
  INSERT INTO companies(id, name, turn_numbers_used) VALUES ('${ACME}', 'Acme', 7);
  INSERT INTO departments(id, company_id, template_key, role_code, position, parent_id) VALUES
    ('${DEV}', '${ACME}', 'development', 'DEV', 1, null),
    ('${SHOP}', '${ACME}', null, 'DEV', 4, '${DEV}'),
    ('${MARKETING}', '${ACME}', 'marketing', 'MKT', 2, null),
    ('${DESIGN}', '${ACME}', 'design', 'DSN', 3, null);
  INSERT INTO turns(id, company_id, number, title, goal, status, mode, messages, opened_at, closed_at) VALUES
    ('${T(1)}', '${ACME}', 1, 'Launch', 'Launch it.', 'closed', 'echelons', '[]', now(), now()),
    ('${T(2)}', '${ACME}', 2, 'Payments', 'Take card payments.', 'open', 'echelons', '[]', now(), null),
    ('${T(3)}', '${ACME}', 3, 'Spring', 'Spring release.', 'planned', 'turnkey', '[{"id":"m1","by":"Ivan","text":"Spring","at":"2026-11-01T00:00:00.000Z"}]', null, null),
    ('${T(4)}', '${ACME}', 4, 'Nothing', 'Nothing in it.', 'closed', 'echelons', '[]', now(), now());
  INSERT INTO tasks(id, company_id, number, title, turn_id, parent_id, department_id, status, closed_at) VALUES
    ('${K(1)}', '${ACME}', 1, 'Launch post', '${T(1)}', null, '${MARKETING}', 'done', now()),
    ('${K(2)}', '${ACME}', 2, 'Launch build', '${T(1)}', null, '${DEV}', 'done', now()),
    ('${K(3)}', '${ACME}', 3, 'Card screen', '${T(2)}', null, '${DESIGN}', 'done', now()),
    ('${K(4)}', '${ACME}', 4, 'Checkout', '${T(2)}', null, '${DEV}', 'working', null),
    ('${K(5)}', '${ACME}', 5, 'Checkout API', '${T(2)}', '${K(4)}', '${DEV}', 'open', null),
    ('${K(6)}', '${ACME}', 6, 'Shop cart', '${T(2)}', null, '${SHOP}', 'open', null),
    ('${K(7)}', '${ACME}', 7, 'Payments post', '${T(2)}', null, '${MARKETING}', 'working', null),
    ('${K(8)}', '${ACME}', 8, 'Post picture', '${T(2)}', '${K(7)}', '${DESIGN}', 'open', null),
    ('${K(9)}', '${ACME}', 9, 'Orchestrator note', '${T(2)}', null, null, 'open', null),
    ('${K(10)}', '${ACME}', 10, 'Spring build', '${T(3)}', null, '${DEV}', 'planned', null),
    ('${K(11)}', '${ACME}', 11, 'Spring post', '${T(3)}', null, '${MARKETING}', 'planned', null),
    ('${K(12)}', '${ACME}', 12, 'Spring look', '${T(3)}', null, '${DESIGN}', 'planned', null),
    ('${K(13)}', '${ACME}', 13, 'Spring mail', '${T(3)}', null, '${MARKETING}', 'planned', null),
    ('${K(14)}', '${ACME}', 14, 'Old spring idea', '${T(3)}', null, '${DESIGN}', 'cancelled', now()),
    ('${K(16)}', '${ACME}', 16, 'Outside', null, null, '${DEV}', 'open', null);
`);

/* Bare has no department, and one open turn of the orchestrator's own work. */
const bare = () => migrated(`
  INSERT INTO companies(id, name) VALUES ('${BARE}', 'Bare');
  INSERT INTO turns(id, company_id, number, title, goal, status, mode, messages, opened_at) VALUES ('${T(5)}', '${BARE}', 1, 'Talk', 'The orchestrator talks.', 'open', 'echelons', '[]', now());
  INSERT INTO tasks(id, company_id, number, title, turn_id, status) VALUES ('${K(15)}', '${BARE}', 1, 'Say hello', '${T(5)}', 'open');
`);

/* Plain has no Development, and a turn with no task. */
const plain = () => migrated(`
  INSERT INTO companies(id, name) VALUES ('${PLAIN}', 'Plain');
  INSERT INTO departments(id, company_id, template_key, role_code, position) VALUES ('${SALES}', '${PLAIN}', 'sales', 'SAL', 2), ('${SUPPORT}', '${PLAIN}', 'support', 'SUP', 1);
  INSERT INTO turns(id, company_id, number, title, goal, status, mode, messages, opened_at, closed_at) VALUES ('${T(6)}', '${PLAIN}', 1, 'Quiet', 'No tasks.', 'closed', 'echelons', '[]', now(), now());
`);

/* Busy ran one open turn where Operations, which works all the time, holds the first unfinished task. */
const busy = () => migrated(`
  INSERT INTO companies(id, name) VALUES ('${BUSY}', 'Busy');
  INSERT INTO departments(id, company_id, template_key, role_code, position, work_mode) VALUES
    ('${OPS}', '${BUSY}', 'operations', 'OPS', 0, 'continuous'), ('${BUILD}', '${BUSY}', 'development', 'DEV', 1, 'turns');
  INSERT INTO turns(id, company_id, number, title, goal, status, mode, messages, opened_at) VALUES ('${T(7)}', '${BUSY}', 1, 'Release', 'Ship it.', 'open', 'echelons', '[]', now());
  INSERT INTO tasks(id, company_id, number, title, turn_id, parent_id, department_id, status) VALUES
    ('${K(17)}', '${BUSY}', 1, 'Restart a machine', '${T(7)}', null, '${OPS}', 'working'),
    ('${K(18)}', '${BUSY}', 2, 'Build the release', '${T(7)}', null, '${BUILD}', 'working');
`);

const turnsOf = async (client: PGlite) =>
  (await client.query<{ number: number; department_id: string | null; status: string; title: string; goal: string; mode: string; messages: unknown }>(
    'SELECT number, department_id, status, title, goal, mode, messages FROM turns ORDER BY number',
  )).rows;
const turnOfTasks = async (client: PGlite) =>
  Object.fromEntries((await client.query<{ number: number; turn: number | null }>(
    'SELECT k.number, t.number AS turn FROM tasks k LEFT JOIN turns t ON t.id = k.turn_id ORDER BY k.number',
  )).rows.map(r => [r.number, r.turn]));

/* Each case runs every migration twice over, which a loaded runner takes longer than the usual limit for. */
describe('the migration that gives each turn its department', { timeout: 60_000 }, () => {
  it("gives every turn the top department of its first task, and a live one that of its first unfinished task", async () => {
    expect((await turnsOf(await acme())).map(t => [t.number, t.department_id, t.status])).toEqual([
      [1, MARKETING, 'closed'],
      [2, DEV, 'open'],
      [3, DEV, 'planned'],
      [4, DEV, 'closed'],
      [8, MARKETING, 'planned'],
      [9, DESIGN, 'planned'],
    ]);
    /* With no Development, the first department in the company's order. */
    expect((await turnsOf(await plain())).map(t => [t.number, t.department_id])).toEqual([[1, SUPPORT]]);
  });

  it('gives a live turn to a department that runs turns rather than to one that works all the time', async () => {
    const client = await busy();
    expect((await turnsOf(client)).map(t => [t.number, t.department_id, t.status])).toEqual([[1, BUILD, 'open']]);
    expect(await turnOfTasks(client)).toEqual({ 1: null, 2: 1 });
  });

  it('leaves in the open turn only the work of its department, which the rest goes on with outside turns', async () => {
    const client = await acme();
    /* Development and its product's work stays; Design's finished task, Marketing's tree with Design's part in it and
       the orchestrator's own task leave. History in the closed turn stays as it was. */
    expect(await turnOfTasks(client)).toMatchObject({ 1: 1, 2: 1, 3: null, 4: 2, 5: 2, 6: 2, 7: null, 8: null, 9: null, 16: null });
    expect((await client.query(`SELECT status FROM tasks WHERE id IN ('${K(4)}', '${K(7)}', '${K(8)}') ORDER BY number`)).rows).toEqual([{ status: 'working' }, { status: 'working' }, { status: 'open' }]);
  });

  it('splits a planned turn into a planned turn for each department, with the next free numbers and its words', async () => {
    const client = await acme();
    expect(await turnOfTasks(client)).toMatchObject({ 10: 3, 11: 8, 12: 9, 13: 8, 14: 9 });
    const [, , spring, , marketing, design] = await turnsOf(client);
    for (const split of [marketing, design]) expect(split).toMatchObject({ status: 'planned', title: spring!.title, goal: spring!.goal, mode: 'turnkey', messages: spring!.messages });
    expect((await client.query("SELECT count(*)::int AS n FROM tasks WHERE status = 'planned' AND turn_id IS NULL")).rows).toEqual([{ n: 0 }]);
  });

  it('closes a live turn of a company without departments, its work going on outside turns', async () => {
    const client = await bare();
    expect((await turnsOf(client)).map(t => [t.number, t.department_id, t.status])).toEqual([[1, null, 'closed']]);
    expect((await client.query(`SELECT turn_id FROM tasks WHERE id = '${K(15)}'`)).rows).toEqual([{ turn_id: null }]);
  });

  it('keeps one open turn for each department, a department for every live turn, and the closed history of a removed one', async () => {
    const client = await acme();
    await client.exec(`INSERT INTO turns(company_id, department_id, number, goal, status) VALUES ('${ACME}', '${MARKETING}', 10, 'Marketing goes', 'open')`);
    await expect(client.exec(`INSERT INTO turns(company_id, department_id, number, goal, status) VALUES ('${ACME}', '${MARKETING}', 11, 'Twice', 'open')`)).rejects.toThrow();
    await expect(client.exec(`INSERT INTO turns(company_id, number, goal, status) VALUES ('${ACME}', 12, 'Nobody', 'planned')`)).rejects.toThrow();
    await client.exec(`INSERT INTO turns(company_id, number, goal, status) VALUES ('${ACME}', 13, 'Old history', 'closed')`);
    /* A removed department's closed turns stay as history without it. */
    await client.exec(`
      INSERT INTO departments(id, company_id, template_key, role_code, position) VALUES ('${GONE}', '${ACME}', 'sales', 'SAL', 5);
      INSERT INTO turns(company_id, department_id, number, goal, status) VALUES ('${ACME}', '${GONE}', 14, 'Gone', 'closed');
      DELETE FROM departments WHERE id = '${GONE}';
    `);
    expect((await turnsOf(client)).filter(t => t.number >= 13).map(t => [t.number, t.department_id])).toEqual([[13, null], [14, null]]);
  });

  it('finds what waits for a task by what it comes after, whatever turn it is in', async () => {
    const client = await acme();
    const indexes = await client.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE tablename = 'tasks' AND indexname = 'tasks_after'");
    expect(indexes.rows).toEqual([{ indexdef: 'CREATE INDEX tasks_after ON public.tasks USING gin (after)' }]);
  });
});
