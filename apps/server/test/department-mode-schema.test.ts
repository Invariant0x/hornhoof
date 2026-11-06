import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { expect, it, onTestFinished } from 'vitest';
import { agentRole, grantsFor, readerGrantsFor, readerRole } from '../src/db/agent-sql.js';
import { MIGRATIONS } from '../src/db/client.js';
import { createTestDb } from './helpers.js';

it('stores a work mode on the fresh department schema', async () => {
  const db = await createTestDb();
  expect((await db.$client.query('SELECT work_mode FROM departments')).rows).toEqual([]);
});

it('keeps work mode readable but denies generic SQL writes for both roles', async () => {
  const db = await createTestDb();
  const client = db.$client;
  /* Exercise grant policy against a newly introduced column independently of the
     migration. Before the policy change this column inherits generic writes. */
  await client.exec("ALTER TABLE departments ADD COLUMN IF NOT EXISTS work_mode text DEFAULT 'turns'");
  const names = { write: agentRole('postgres'), read: readerRole('postgres') };
  await client.exec(`${grantsFor(names.write)};\n${readerGrantsFor(names.read)}`);
  const run = (name: string, sql: string) => client.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE "${name}"`);
    return tx.exec(sql);
  });
  for (const name of Object.values(names)) {
    expect((await run(name, 'SELECT id,work_mode FROM departments'))[0]!.rows).toEqual([]);
    await expect(run(name, "UPDATE departments SET work_mode = 'continuous' WHERE false")).rejects.toThrow(/permission denied/);
    await expect(run(name, 'INSERT INTO departments(company_id,role_code,work_mode) SELECT company_id,role_code,work_mode FROM departments WHERE false')).rejects.toThrow(/permission denied/);
  }
});

it('backfills existing template defaults without losing department data and repeats safely', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hh-department-mode-upgrade-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  await cp(MIGRATIONS, directory, { recursive: true });
  const file = join(directory, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(file, 'utf8')) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter(entry => !entry.tag.endsWith('_department_work_mode'));
  await writeFile(file, JSON.stringify(journal));
  const client = new PGlite();
  onTestFinished(() => client.close());
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: directory });
  await client.exec(`
    INSERT INTO companies (id,name) VALUES ('00000000-0000-4000-8000-000000000001','Retained company');
    INSERT INTO departments (company_id,template_key,role_code,name) VALUES
      ('00000000-0000-4000-8000-000000000001','operations','OPS','Retained operations'),
      ('00000000-0000-4000-8000-000000000001','development','DEV','Retained development'),
      ('00000000-0000-4000-8000-000000000001',null,'CUSTOM','Retained custom');
  `);
  const before = await client.query('SELECT to_jsonb(d) AS row FROM departments d ORDER BY name');
  await migrate(db, { migrationsFolder: MIGRATIONS });
  expect((await client.query('SELECT name,work_mode FROM departments ORDER BY name')).rows).toEqual([
    { name: 'Retained custom', work_mode: 'turns' },
    { name: 'Retained development', work_mode: 'turns' },
    { name: 'Retained operations', work_mode: 'continuous' },
  ]);
  expect((await client.query("SELECT to_jsonb(d) - 'work_mode' AS row FROM departments d ORDER BY name")).rows).toEqual(before.rows);
  const history = await client.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id');
  await migrate(db, { migrationsFolder: MIGRATIONS });
  expect((await client.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows).toEqual(history.rows);
});
