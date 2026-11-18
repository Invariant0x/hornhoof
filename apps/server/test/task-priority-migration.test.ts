import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { expect, it, onTestFinished } from 'vitest';
import { migrationsBefore, migrationsThrough } from './migrations-before.js';

it('keeps existing tasks and their scheduling flag when adding nullable priority', async () => {
  const client = new PGlite();
  onTestFinished(() => client.close());
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: await migrationsBefore('task_priority') });
  await client.exec("INSERT INTO companies (name) VALUES ('Acme')");
  await client.exec("INSERT INTO tasks (company_id, number, title, urgent) SELECT id, 1, 'Checkout', true FROM companies");
  await expect(client.query('SELECT priority FROM tasks')).rejects.toThrow(/column "priority" does not exist/);

  const migrationsFolder = await migrationsThrough('task_priority');
  await migrate(db, { migrationsFolder });
  await migrate(db, { migrationsFolder });
  expect((await client.query('SELECT title, urgent, priority FROM tasks')).rows).toEqual([{ title: 'Checkout', urgent: true, priority: null }]);
  await expect(client.exec("UPDATE tasks SET priority = 'first'")).rejects.toThrow(/tasks_priority_known/);
  await client.exec("UPDATE tasks SET priority = 'high'");
  expect((await client.query('SELECT priority FROM tasks')).rows).toEqual([{ priority: 'high' }]);
}, 60_000);
