import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { ownDatabases } from './helpers.js';

ownDatabases();

/* Departments kept a work mode from 0069 until 0126 took it away with planned turns: what 0069 did to the rows they had
   still holds for an upgrade from before it. */
it('backfills existing template defaults without losing department data and repeats safely', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hh-department-mode-upgrade-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  await cp(MIGRATIONS, directory, { recursive: true });
  const file = join(directory, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(file, 'utf8')) as { entries: { tag: string }[] };
  const modeIndex = journal.entries.findIndex(entry => entry.tag === '0069_department_work_mode');
  expect(modeIndex).toBeGreaterThanOrEqual(0);
  const targetEntries = journal.entries.slice(0, modeIndex + 1);
  journal.entries = targetEntries.slice(0, -1);
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
  journal.entries = targetEntries;
  await writeFile(file, JSON.stringify(journal));
  await migrate(db, { migrationsFolder: directory });
  expect((await client.query('SELECT name,work_mode FROM departments ORDER BY name')).rows).toEqual([
    { name: 'Retained custom', work_mode: 'turns' },
    { name: 'Retained development', work_mode: 'turns' },
    { name: 'Retained operations', work_mode: 'continuous' },
  ]);
  expect((await client.query("SELECT to_jsonb(d) - 'work_mode' AS row FROM departments d ORDER BY name")).rows).toEqual(before.rows);
  const history = await client.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id');
  await migrate(db, { migrationsFolder: directory });
  expect((await client.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows).toEqual(history.rows);
});
