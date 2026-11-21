import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { freshPglite, openTestDb } from './helpers-db.js';
import { migrationsBefore } from './migrations-before.js';

it('adds nullable company pause columns without altering existing companies and stays repeatable', async () => {
  const before = await migrationsBefore('company_pause');
  const client = await freshPglite();
  onTestFinished(() => client.close());
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: before });
  await db.execute(sql`insert into companies (name, singleton) values ('Acme', true)`);
  const existing = (await db.execute(sql`select id, name, inbox_mode, brief, singleton from companies`)).rows;

  await migrate(db, { migrationsFolder: MIGRATIONS });
  await migrate(db, { migrationsFolder: MIGRATIONS });

  expect((await db.execute(sql`select id, name, inbox_mode, brief, singleton from companies`)).rows).toEqual(existing);
  expect((await db.execute(sql`select paused, resumed_at from companies`)).rows).toEqual([{ paused: null, resumed_at: null }]);
});

it('creates company pause columns on a fresh database and persists pause metadata', async () => {
  const { client } = await openTestDb();
  onTestFinished(() => client.close());
  const db = drizzle(client);
  const at = '2026-11-21T10:00:00.000Z';
  const paused = JSON.stringify({ by: '00000000-0000-4000-8000-000000000001', byName: 'Alex', at });
  await db.execute(sql`insert into companies (name, singleton, paused, resumed_at) values ('Acme', true, ${paused}::jsonb, ${at}::timestamptz)`);
  const rows = (await db.execute<{ paused: unknown; resumed_at: Date | string | null }>(sql`select paused, resumed_at from companies`)).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.paused).toEqual({ by: '00000000-0000-4000-8000-000000000001', byName: 'Alex', at });
  expect(new Date(rows[0]!.resumed_at!).toISOString()).toBe(at);
});
