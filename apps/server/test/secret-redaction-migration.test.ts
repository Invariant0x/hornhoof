import { drizzle } from 'drizzle-orm/pglite';
import { expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { AFTER_MIGRATIONS } from '../src/db/net.js';
import { freshPglite, ownDatabases } from './helpers-db.js';
import { migrate, migrationsUpTo } from './migrations-fixture.js';

ownDatabases();

it('upgrades an existing database without discarding prose and applies suppression after repeat migration', async () => {
  const client = await freshPglite();
  onTestFinished(() => client.close());
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: await migrationsUpTo('0128_department_autonomous_release') });
  const company = await client.query<{ id: string }>("insert into companies (name) values ('Acme') returning id");
  const companyId = company.rows[0]!.id;
  await client.query("insert into tasks (company_id, number, title, body) values ($1, 1, 'Kept', 'Old text')", [companyId]);
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await client.exec(AFTER_MIGRATIONS);
  expect((await client.query('select title, body from tasks')).rows).toEqual([{ title: 'Kept', body: 'Old text' }]);
  expect((await client.query('select * from secret_redactions')).rows).toEqual([]);
  const person = await client.query<{ id: string }>("insert into people (company_id, name, email, status, scope_kind) values ($1, 'Ivan', 'ivan@acme.test', 'active', 'company') returning id", [companyId]);
  await client.query("insert into secret_redactions (company_id, person_id, fingerprint, characters) values ($1, $2, encode(sha256(convert_to('Old text', 'UTF8')), 'hex'), 8)", [companyId, person.rows[0]!.id]);
  expect((await client.query('select title, body from tasks')).rows).toEqual([{ title: 'Kept', body: '[hidden]' }]);
});
