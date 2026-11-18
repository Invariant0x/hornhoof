import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { freshPglite, ownDatabases } from './helpers-db.js';
import { migrate, migrationsUpTo } from './migrations-fixture.js';

ownDatabases();

it('removes pending and expired opening requests when upgrading connected machines', async () => {
  const client = await freshPglite();
  onTestFinished(() => client.close());
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: await migrationsUpTo('0152_drop_outbound') });
  const company = (await client.query<{ id: string }>("insert into companies (name) values ('Standing access') returning id")).rows[0]!.id;
  const person = (await client.query<{ id: string }>("insert into people (company_id, name, email, status, scope_kind, is_owner) values ($1, 'Owner', 'owner@standing.example', 'active', 'company', true) returning id", [company])).rows[0]!.id;
  const machine = async (key: string) => (await client.query<{ id: string }>("insert into machines (company_id, person_id, machine_key, hostname, network_id) values ($1, $2, $3, $3, $4) returning id", [company, person, key, key.repeat(64)])).rows[0]!.id;
  const pending = await machine('a');
  const expired = await machine('b');
  await db.execute(sql`insert into machine_access (machine_id, company_id, asked_reason, asked_at, until) values
    (${pending}, ${company}, 'Pending sample', '2020-01-01', null), (${expired}, ${company}, null, null, '2020-01-01')`);
  await db.execute(sql`insert into computer_runs (machine_id, company_id, command, timeout_s) values (${pending}, ${company}, 'stale sample', 30)`);
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  expect((await client.query('select * from machine_access')).rows).toEqual([]);
  expect((await client.query('select state, exit from computer_runs')).rows).toEqual([{ state: 'done', exit: 126 }]);
  expect((await client.query('select id from machines order by id')).rows.map(row => (row as { id: string }).id)).toEqual([pending, expired].sort());
});

it('keeps existing machine access restricted to the orchestrator and accepts only the two scopes after upgrade', async () => {
  const client = await freshPglite();
  onTestFinished(() => client.close());
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: await migrationsUpTo('0136_outbound_contact_log') });
  const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Scope migration') returning id`)).rows[0]!.id;
  const person = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind, is_owner) values (${company}, 'Owner', 'owner@scope.example', 'active', 'company', true) returning id`)).rows[0]!.id;
  const machine = (await db.execute<{ id: string }>(sql`insert into machines (company_id, person_id, machine_key, hostname) values (${company}, ${person}, 'scope-migration', 'scope') returning id`)).rows[0]!.id;
  await db.execute(sql`insert into machine_access (machine_id, company_id, until, opened_by, opened_at) values (${machine}, ${company}, '2030-01-01T01:00:00Z', ${person}, '2030-01-01T00:00:00Z')`);
  const before = (await db.execute(sql`select to_jsonb(a) as row from machine_access a`)).rows;
  await migrate(db, { migrationsFolder: await migrationsUpTo('0142_machine_access_scope') });
  expect((await db.execute(sql`select to_jsonb(a) - 'scope' as row from machine_access a`)).rows).toEqual(before);
  expect((await db.execute(sql`select scope from machine_access`)).rows).toEqual([{ scope: 'orchestrator' }]);
  await db.execute(sql`update machine_access set scope = 'all_agents'`);
  await expect(db.execute(sql`update machine_access set scope = 'unknown'`)).rejects.toThrow();
  await expect(db.execute(sql`update machine_access set scope = null`)).rejects.toThrow();
});
