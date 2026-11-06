import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { companies } from '../src/db/schema.js';
import { createTestDb, databasesOpened, ownDatabases } from './helpers-db.js';

ownDatabases();

describe('a file that asks for databases of its own', { shuffle: false }, () => {
  let opened = 0;
  let closedLater: { closed: boolean };

  it('can change more than rows in a test', async () => {
    const db = await createTestDb();
    opened = databasesOpened();
    closedLater = db.$client;
    await db.execute(sql`create function refuse_company() returns trigger language plpgsql as $$ begin raise exception 'no company'; end $$`);
    await db.execute(sql`create trigger refuse_company before insert on companies for each row execute function refuse_company()`);
    await expect(db.insert(companies).values({ name: 'Acme' })).rejects.toThrow();
  });

  it('opens a new one for each test and closes the last', async () => {
    const db = await createTestDb();
    expect(databasesOpened()).toBe(opened + 1);
    expect(closedLater.closed).toBe(true);
    await expect(db.insert(companies).values({ name: 'Acme' }).returning()).resolves.toHaveLength(1);
  });
});
