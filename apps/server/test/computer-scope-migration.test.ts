import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { freshPglite, ownDatabases } from './helpers-db.js';
import { migrate, migrationsUpTo } from './migrations-fixture.js';

ownDatabases();

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
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  expect((await db.execute(sql`select to_jsonb(a) - 'scope' as row from machine_access a`)).rows).toEqual(before);
  expect((await db.execute(sql`select scope from machine_access`)).rows).toEqual([{ scope: 'orchestrator' }]);
  await db.execute(sql`update machine_access set scope = 'all_agents'`);
  await expect(db.execute(sql`update machine_access set scope = 'unknown'`)).rejects.toThrow();
  await expect(db.execute(sql`update machine_access set scope = null`)).rejects.toThrow();
});
