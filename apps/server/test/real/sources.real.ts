import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { APP_NAME, migrateDb, openDb, type Db } from '../../src/db/client.js';
import { isLeaseRefused } from '../../src/db/net.js';
import { companies } from '../../src/db/schema.js';
import { listed, withSource } from '../../src/db/sources.js';
import { ENDLESS_LEASE } from '../prepare-environment.js';
import { poolOf, realDatabase, type RealDatabase } from './pg.js';

let real: RealDatabase;
let company: string;

beforeAll(async () => {
  real = await realDatabase();
  await migrateDb(real.url);
  await real.admin.query(ENDLESS_LEASE);
  company = (await real.admin.query<{ id: string }>(`INSERT INTO companies (name) VALUES ('Acme') RETURNING id`)).rows[0]!.id;
});

afterAll(async () => {
  await real.drop();
});

function appDb(): Db {
  const db = openDb(real.url, APP_NAME, { fenced: true });
  onTestFinished(() => poolOf(db).end());
  return db;
}

const rename = (db: Pick<Db, 'update'>, name: string) => db.update(companies).set({ name }).where(eq(companies.id, company));
const nameNow = async (): Promise<string> => (await real.admin.query<{ name: string }>('SELECT name FROM companies')).rows[0]!.name;
const xactsOf = async (table: string): Promise<string[]> => (await real.admin.query<{ xact: string }>('SELECT xact FROM net.journal WHERE tbl = $1 ORDER BY at', [table])).rows.map(row => row.xact);

describe('the source of a change on real Postgres', () => {
  it('records the source in the commit the fence checks', async () => {
    const db = appDb();
    await withSource('web:real', () => db.transaction(tx => rename(tx, 'Renamed')));
    expect(await listed(db, 'web:real')).toMatchObject({ steps: 1, first: 'web:real:0' });
    expect(await xactsOf('applied')).toEqual([(await xactsOf('companies')).at(-1)]);

    /* The lease ends while the transaction is open: its commit is refused, and the step goes with the change. */
    const refused = withSource('web:late', () =>
      db.transaction(async tx => {
        await rename(tx, 'Too late');
        await real.admin.query(`UPDATE net_local.lease SET until = '-infinity'`);
      }),
    );
    expect(await refused.then(() => false, isLeaseRefused)).toBe(true);
    await real.admin.query(`UPDATE net_local.lease SET until = 'infinity'`);
    expect(await listed(db, 'web:late')).toBeNull();
    expect(await nameNow()).toBe('Renamed');
  });

  it('tells a transaction that wrote from one that only read, and counts a row it locked as written', async () => {
    const db = appDb();
    await withSource('web:reads', async () => {
      await db.transaction(tx => tx.select().from(companies));
      await db.transaction(tx => tx.select().from(companies), { accessMode: 'read only' });
      await db.select().from(companies);
      await db.update(companies).set({ name: 'Nobody' }).where(eq(companies.id, '00000000-0000-4000-8000-000000000000'));
    });
    expect(await listed(db, 'web:reads')).toBeNull();

    await withSource('web:locks', () => db.transaction(tx => tx.execute(sql`SELECT 1 FROM companies FOR UPDATE`)));
    expect(await listed(db, 'web:locks')).toMatchObject({ steps: 1 });
  });
});
