import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { expect, it, onTestFinished } from 'vitest';
import { freshPglite, ownDatabases } from './helpers-db.js';
import { migrationsBefore, migrationsThrough } from './migrations-before.js';

ownDatabases();

it('adds phones on a fresh database and upgrades existing company data without changing it', async () => {
  const client = await freshPglite();
  onTestFinished(() => client.close());
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: await migrationsBefore('company_phones') });
  await client.exec("INSERT INTO companies(id, name) VALUES ('11111111-1111-4111-8111-111111111111', 'Existing company'); INSERT INTO tasks(company_id, number, title) VALUES ('11111111-1111-4111-8111-111111111111', 1, 'Existing task');");
  const through = await migrationsThrough('company_phones');
  await migrate(db, { migrationsFolder: through });
  expect((await client.query('SELECT name FROM companies')).rows).toEqual([{ name: 'Existing company' }]);
  expect((await client.query('SELECT title FROM tasks')).rows).toEqual([{ title: 'Existing task' }]);
  expect((await client.query('SELECT count(*)::int AS n FROM company_phones')).rows).toEqual([{ n: 0 }]);
  expect((await client.query("SELECT column_default FROM information_schema.columns WHERE table_name = 'phone_sessions' AND column_name = 'queue_order'")).rows[0]).toHaveProperty('column_default');
  await migrate(db, { migrationsFolder: through });
  expect((await client.query('SELECT title FROM tasks')).rows).toEqual([{ title: 'Existing task' }]);

  const fresh = await freshPglite();
  onTestFinished(() => fresh.close());
  await migrate(drizzle(fresh), { migrationsFolder: through });
  expect((await fresh.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('company_phones', 'phone_sessions', 'phone_frames') ORDER BY table_name")).rows).toEqual([{ table_name: 'company_phones' }, { table_name: 'phone_frames' }, { table_name: 'phone_sessions' }]);
});
