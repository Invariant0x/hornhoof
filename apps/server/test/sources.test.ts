import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { isLeaseRefused } from '../src/db/net.js';
import { companies, departments } from '../src/db/schema.js';
import { listed, outsideSources, recordNow, recordSources, sources, stepOf, touch, withSource, WRITE_TEXT } from '../src/db/sources.js';
import { createTestDb, ownDatabases, setLease } from './helpers.js';

/* One test ends the lease, which a truncate does not undo. */
ownDatabases();

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const aCompany = async (db: TestDb): Promise<string> => (await db.insert(companies).values({ name: 'Acme' }).returning())[0]!.id;
/* A company is one to a database, so a test that needs more rows makes departments. */
const aDepartment = (db: Pick<TestDb, 'insert'>, companyId: string, name: string) => db.insert(departments).values({ companyId, name, roleCode: name.toUpperCase() }).returning();
const rename = (db: Pick<TestDb, 'update'>, id: string, name: string) => db.update(companies).set({ name }).where(eq(companies.id, id));

const appliedRows = async (db: TestDb): Promise<{ source: string; base: string | null }[]> =>
  (await db.execute<{ source: string; base: string | null }>(sql`select source, base from applied order by at, source`)).rows;

/* The transaction of each journal row of a table, oldest first. */
const xactsOf = async (db: TestDb, table: string): Promise<string[]> =>
  (await db.execute<{ xact: string }>(sql`select xact from net.journal where tbl = ${table} order by at`)).rows.map(row => row.xact);

describe('the source of a change', () => {
  it("records a transaction's source before its commit, in that commit", async () => {
    const db = await createTestDb();
    const id = await aCompany(db);
    await withSource('web:a', () => db.transaction(tx => rename(tx, id, 'Renamed')));
    expect(await appliedRows(db)).toEqual([{ source: 'web:a:0', base: 'web:a' }]);
    expect(await xactsOf(db, 'applied')).toEqual([(await xactsOf(db, 'companies')).at(-1)]);
  });

  it('numbers the steps of a source that commits more than once', async () => {
    const db = await createTestDb();
    const id = await aCompany(db);
    await withSource('web:b', async () => {
      await db.transaction(tx => rename(tx, id, 'One'));
      await db.transaction(tx => rename(tx, id, 'Two'));
      await rename(db, id, 'Three');
    });
    expect((await appliedRows(db)).map(row => row.source)).toEqual(['web:b:0', 'web:b:1', 'web:b:2']);
    expect(await listed(db, 'web:b')).toMatchObject({ steps: 3, first: 'web:b:0' });
  });

  it('records nothing for what changed no row', async () => {
    const db = await createTestDb();
    const id = await aCompany(db);
    await withSource('web:r', async () => {
      await db.transaction(tx => tx.select().from(companies));
      await db.transaction(tx => tx.select().from(companies), { accessMode: 'read only' });
      await db.select().from(companies);
      await rename(db, '00000000-0000-4000-8000-000000000000', 'Nobody');
    });
    expect(await appliedRows(db)).toEqual([]);
    expect((await db.select().from(companies))[0]!.id).toBe(id);
  });

  it('runs a write outside a transaction in one of its own, with the answer it would have given', async () => {
    const db = await createTestDb();
    const id = await aCompany(db);
    const [plain] = await aDepartment(db, id, 'Plain');
    expect(await appliedRows(db)).toEqual([]);
    const [recorded] = await withSource('web:w', () => aDepartment(db, id, 'Recorded'));
    expect(Object.keys(recorded!)).toEqual(Object.keys(plain!));
    expect(recorded!.name).toBe('Recorded');
    expect(await appliedRows(db)).toEqual([{ source: 'web:w:0', base: 'web:w' }]);
    expect(await xactsOf(db, 'applied')).toEqual([(await xactsOf(db, 'departments')).at(-1)]);
  });

  it('records nothing once the source has closed, and nothing a call sets outside it', async () => {
    const db = await createTestDb();
    const id = await aCompany(db);
    let open!: () => void;
    const gate = new Promise<void>(done => (open = done));
    let late!: Promise<unknown>;
    await withSource('web:t', async () => {
      late = gate.then(() => rename(db, id, 'Late'));
      await outsideSources(() => rename(db, id, 'Outside'));
    });
    open();
    await late;
    expect((await db.select().from(companies))[0]!.name).toBe('Late');
    expect(await appliedRows(db)).toEqual([]);
  });

  it('rolls the source back with the change', async () => {
    const db = await createTestDb();
    const failed = withSource('web:f', () =>
      db.transaction(async tx => {
        await tx.insert(companies).values({ name: 'Gone' });
        throw new Error('no');
      }),
    );
    await expect(failed).rejects.toThrow('no');
    expect(await appliedRows(db)).toEqual([]);
    expect(await db.select().from(companies)).toEqual([]);
  });

  it('lists a source whose first commit failed by the step that committed', async () => {
    const db = await createTestDb();
    const id = await aCompany(db);
    await withSource('web:c', async () => {
      await outsideSources(() => setLease(db, { until: '-infinity' }));
      const refused = await db.transaction(tx => rename(tx, id, 'Refused')).then(() => false, isLeaseRefused);
      expect(refused).toBe(true);
      await outsideSources(() => setLease(db, { until: 'infinity' }));
      await db.transaction(tx => rename(tx, id, 'Kept'));
    });
    expect(await listed(db, 'web:c')).toMatchObject({ steps: 1, first: 'web:c:1' });
  });

  it('gives two transactions at once two steps', async () => {
    const db = await createTestDb();
    const id = await aCompany(db);
    await withSource('web:e', () => Promise.all([db.transaction(tx => aDepartment(tx, id, 'A')), db.transaction(tx => aDepartment(tx, id, 'B'))]));
    expect((await appliedRows(db)).map(row => row.source).sort()).toEqual(['web:e:0', 'web:e:1']);
  });

  it('records an action outside the database as a step of its own', async () => {
    const db = await createTestDb();
    await withSource('web:n', async () => {
      await recordNow(db);
      expect(sources.getStore()).toMatchObject({ base: 'web:n', next: 1, open: true });
    });
    expect(await appliedRows(db)).toEqual([{ source: 'web:n:0', base: 'web:n' }]);
    expect(await xactsOf(db, 'companies')).toEqual([]);
  });

  it('lists a source and touches it', async () => {
    const db = await createTestDb();
    const id = await aCompany(db);
    expect(await listed(db, 'web:l')).toBeNull();
    await withSource('web:l', () => rename(db, id, 'Listed'));
    const first = await listed(db, 'web:l');
    expect(first).toMatchObject({ steps: 1, first: stepOf('web:l', 0) });
    expect(first!.at).toBeInstanceOf(Date);
    await withSource('web:other', () => touch(db, 'web:l'));
    const ops = (await db.execute<{ op: string }>(sql`select op from net.journal where tbl = 'applied' order by at`)).rows.map(row => row.op);
    expect(ops).toEqual(['insert', 'update']);
    expect(await listed(db, 'web:other')).toBeNull();
  });

  it('wraps a db once', async () => {
    const db = recordSources(recordSources(await createTestDb()));
    const id = await aCompany(db);
    await withSource('web:o', () => db.transaction(tx => rename(tx, id, 'Once')));
    expect(await appliedRows(db)).toHaveLength(1);
  });

  it('starts a source at the step it is given', async () => {
    const db = await createTestDb();
    const id = await aCompany(db);
    await withSource('node:x:s:7', () => rename(db, id, 'Again'), 3);
    expect((await appliedRows(db)).map(row => row.source)).toEqual(['node:x:s:7:3']);
  });

  it('tells a statement that changes rows from one that reads', () => {
    for (const text of ['insert into t values (1)', 'UPDATE t SET a = 1', ' delete from t', 'with gone as (delete from t returning id) select * from gone', 'WITH x AS (SELECT 1) UPDATE t SET a = 1'])
      expect(WRITE_TEXT.test(text), text).toBe(true);
    for (const text of ['select * from inserts', 'with x as (select 1) select * from x', 'begin', 'commit', "select 'update'"]) expect(WRITE_TEXT.test(text), text).toBe(false);
  });
});
