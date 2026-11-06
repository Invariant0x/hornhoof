import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { companies } from '../src/db/schema.js';
import { createTestDb, databasesOpened, ownDatabases, shapeOf } from './helpers-db.js';

ownDatabases();

describe('a file that asks for databases of its own', { shuffle: false }, () => {
  let opened = 0;
  let closedLater: { closed: boolean };

  it('opens one for a test, here one that changes only rows', async () => {
    const db = await createTestDb();
    opened = databasesOpened();
    closedLater = db.$client;
    await db.insert(companies).values({ name: 'Acme' });
  });

  it('opens a new one for the next test all the same, and closes the last', async () => {
    const db = await createTestDb();
    expect(databasesOpened()).toBe(opened + 1);
    expect(closedLater.closed).toBe(true);
    expect(await db.select().from(companies)).toEqual([]);
  });

  it('can change more than rows in a test', async () => {
    const db = await createTestDb();
    await db.execute(sql`create function refuse_company() returns trigger language plpgsql as $$ begin raise exception 'no company'; end $$`);
    await db.execute(sql`create trigger refuse_company before insert on companies for each row execute function refuse_company()`);
    await expect(db.insert(companies).values({ name: 'Acme' })).rejects.toThrow();
  });
});

/* One statement for each thing a truncate leaves as it is. Each must show on its own, or a shared database would carry it
   into the next test. */
const LEFT_BY_A_TRUNCATE = [
  'create function probe() returns trigger language plpgsql as $$ begin return new; end $$',
  'create or replace function probe() returns trigger language plpgsql as $$ begin return old; end $$',
  'revoke all on function probe() from public',
  'create trigger probe before insert on companies for each row execute function probe()',
  'alter table companies disable trigger probe',
  'create role probe_role',
  'alter role probe_role login',
  'alter role probe_role set statement_timeout = 1',
  'create role probe_member',
  'grant probe_role to probe_member',
  'grant select on companies to probe_role',
  'grant select (name) on departments to probe_role',
  'alter table companies add column probe text',
  "alter table companies alter column probe set default 'x'",
  'alter table companies alter column probe set not null',
  "alter table companies add constraint probe_check check (probe <> 'y')",
  'create index probe_index on companies (probe)',
  'drop index probe_index; create index probe_index on companies (name)',
  'create domain probe_domain as integer',
  "create type probe_kind as enum ('one')",
  "alter type probe_kind add value 'two'",
  'create policy probe_policy on companies using (true)',
  'alter table companies enable row level security',
  'alter default privileges grant select on tables to probe_role',
  'grant usage on schema public to probe_member',
  'alter database postgres set statement_timeout = 1',
  "insert into companies (name) values ('Acme'); analyze companies",
];

describe('what is compared after emptying a database', () => {
  it('shows each thing a truncate leaves as it is', async () => {
    const { $client: client } = await createTestDb();
    let shape = await shapeOf(client);
    for (const statement of LEFT_BY_A_TRUNCATE) {
      await client.exec(statement);
      const next = await shapeOf(client);
      expect(next, statement).not.toBe(shape);
      shape = next;
    }
  });

  it('shows nothing of rows, or of emptying them', async () => {
    const db = await createTestDb();
    const shape = await shapeOf(db.$client);
    await db.insert(companies).values({ name: 'Acme' });
    expect(await shapeOf(db.$client)).toBe(shape);
    await db.$client.exec('truncate companies restart identity cascade');
    await db.$client.exec('discard all');
    expect(await shapeOf(db.$client)).toBe(shape);
  });
});
