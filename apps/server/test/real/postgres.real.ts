import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_NAME, migrateDb, openDb } from '../../src/db/client.js';
import { companies } from '../../src/db/schema.js';
import { poolOf, realDatabase, type RealDatabase } from './pg.js';

const migrationsInThisBuild = (): number =>
  (JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as { entries: unknown[] }).entries.length;

describe('Postgres for the real tests', () => {
  let real: RealDatabase;
  beforeAll(async () => {
    real = await realDatabase();
  });
  afterAll(() => real.drop());

  const setting = async (name: string): Promise<string | undefined> => (await real.admin.query<Record<string, string>>(`SHOW ${name}`)).rows[0]![name];

  it("runs Postgres 17.11 with the settings of the company's db", async () => {
    expect(await setting('server_version')).toMatch(/^17\.11/);
    expect(await setting('wal_level')).toBe('logical');
    expect(await setting('max_prepared_transactions')).toBe('0');
  });

  it('brings a fresh database up to this build', async () => {
    expect(await migrateDb(real.url)).toBe(migrationsInThisBuild());
    const db = openDb(real.url, APP_NAME);
    try {
      expect(await db.select().from(companies)).toEqual([]);
      const { rows } = await real.admin.query('SELECT application_name FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1', [APP_NAME]);
      expect(rows).toEqual([{ application_name: 'hornhoof-app' }]);
    } finally {
      await poolOf(db).end();
    }
  });
});
