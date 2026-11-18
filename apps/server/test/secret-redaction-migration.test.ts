import { drizzle } from 'drizzle-orm/pglite';
import { expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { fingerprintOf } from '../src/modules/tasks/hide-secret.js';
import { AFTER_MIGRATIONS } from '../src/db/net.js';
import { freshPglite, ownDatabases } from './helpers-db.js';
import { migrate, migrationsUpTo } from './migrations-fixture.js';

ownDatabases();

it('upgrades an existing database without discarding prose, and a suppression row changes no row by itself', async () => {
  const client = await freshPglite();
  onTestFinished(() => client.close());
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: await migrationsUpTo('0136_outbound_contact_log') });
  const company = await client.query<{ id: string }>("insert into companies (name) values ('Acme') returning id");
  const companyId = company.rows[0]!.id;
  await client.query("insert into tasks (company_id, number, title, body) values ($1, 1, 'Kept', 'Old text')", [companyId]);
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await client.exec(AFTER_MIGRATIONS);
  expect((await client.query('select title, body from tasks')).rows).toEqual([{ title: 'Kept', body: 'Old text' }]);
  expect((await client.query('select * from secret_redactions')).rows).toEqual([]);
  const person = await client.query<{ id: string }>("insert into people (company_id, name, email, status, scope_kind) values ($1, 'Ivan', 'ivan@acme.test', 'active', 'company') returning id", [companyId]);
  const { fingerprint, characters, window_hash } = fingerprintOf('Old text');
  await client.query('insert into secret_redactions (company_id, person_id, fingerprint, characters, window_hash) values ($1, $2, $3, $4, $5)', [companyId, person.rows[0]!.id, fingerprint, characters, window_hash]);
  /* The server hides a value in its own process; the database has no trigger that would scan every row on its own. */
  expect((await client.query('select title, body from tasks')).rows).toEqual([{ title: 'Kept', body: 'Old text' }]);
  await client.query("update tasks set body = 'Old text again'");
  expect((await client.query('select body from tasks')).rows).toEqual([{ body: 'Old text again' }]);
});
