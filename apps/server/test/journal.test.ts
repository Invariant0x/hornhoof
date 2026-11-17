import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { FENCED, isLeaseRefused, JOURNAL_NEEDS_PUTTING_BACK, type LeaseKind, type LeaseSync } from '../src/db/net.js';
import { agents, attachments, companies, departments, jobs, people, subscriptions } from '../src/db/schema.js';
import { as, createTestDb, ownDatabases, setLease, setUpCompany, testApp } from './helpers.js';

/* These tests change the lease, the journal's triggers and the tables themselves, which a truncate does not undo. */
ownDatabases();

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
type JournalRow = {
  xact: string;
  term_number: number;
  term_machine: string;
  term_split: boolean;
  machine: string;
  tbl: string;
  op: string;
  key: Record<string, unknown>;
  cols: string[];
  old: Record<string, unknown> | null;
};

const journalOf = async (db: TestDb, table: string): Promise<JournalRow[]> =>
  (await db.execute<JournalRow>(sql`select *, term_number::int as term_number from net.journal where tbl = ${table} order by at`)).rows;

const columnsOf = async (db: TestDb, table: string): Promise<string[]> =>
  (await db.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table}`)).rows.map(row => row.column_name);

const aCompany = async (db: TestDb): Promise<string> => (await db.insert(companies).values({ name: 'Acme' }).returning())[0]!.id;

const aDepartment = (name: string, companyId: string) => ({ companyId, name, roleCode: name.toUpperCase() });

async function anAgent(db: TestDb): Promise<typeof agents.$inferSelect> {
  const [agent] = await db.insert(agents).values({ companyId: await aCompany(db), kind: 'worker', name: 'Bruno', model: '' }).returning();
  return agent!;
}

/* What a commit answered: nothing when it went through, else whether the lease refused it. */
const refusal = (commit: Promise<unknown>): Promise<boolean | 'committed'> => commit.then(() => 'committed' as const, isLeaseRefused);

const journalFunctionThere = async (db: TestDb, table: string): Promise<boolean> =>
  (await db.execute<{ there: boolean }>(sql`select to_regprocedure(${`net.journal_${table}()`}) is not null as there`)).rows[0]!.there;

const tablesWithJournalOff = async (db: TestDb): Promise<string[]> =>
  (await db.execute<{ table_name: string }>(sql`select table_name from net.journals_off()`)).rows.map(row => row.table_name);

/* A table of its own, with the journal on, for what a migration does to it. */
async function aJournaledTable(db: TestDb, name: string, definition: string): Promise<void> {
  await db.$client.exec(`CREATE TABLE public.${name} (${definition}); SELECT net.attach_journal();`);
}

const takeJournalOff = (db: TestDb) => db.$client.exec('SELECT net.detach_journal()');
const putJournalOn = (db: TestDb) => db.$client.exec('SELECT net.attach_journal()');
/* What the migration's session does: it does not say it is fenced. */
const asMigration = (db: TestDb, text: string) => db.$client.exec(`SET ${FENCED} = off; ${text}; SET ${FENCED} = on;`);

describe('the journal', () => {
  it("writes one journal row per changed row, with its transaction's uuid", async () => {
    const db = await createTestDb();
    const companyId = await aCompany(db);
    const together = await db.transaction(tx => tx.insert(departments).values([aDepartment('Sales', companyId), aDepartment('Dev', companyId)]).returning());
    const [alone] = await db.insert(departments).values(aDepartment('Ops', companyId)).returning();

    const rows = await journalOf(db, 'departments');
    const xactOf = (id: string): string => rows.find(row => row.key.id === id)!.xact;

    expect(rows).toHaveLength(3);
    expect(xactOf(together[0]!.id)).toBe(xactOf(together[1]!.id));
    expect(xactOf(alone!.id)).not.toBe(xactOf(together[0]!.id));
    for (const row of rows) expect(row).toMatchObject({ term_number: 1, term_machine: 'test', term_split: false, machine: 'test', tbl: 'departments', op: 'insert' });
  });

  it("takes a transaction's uuid from nothing a session can set", async () => {
    const db = await createTestDb();
    const companyId = await aCompany(db);
    const expected = await db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL net.xact = '00000000-0000-4000-8000-0000000000aa'`);
      await tx.insert(departments).values(aDepartment('Sales', companyId));
      return (await tx.execute<{ xact: string }>(sql`select md5(cluster || ':' || pg_current_xact_id()::text)::uuid as xact from net_local.state`)).rows[0]!.xact;
    });
    expect((await journalOf(db, 'departments'))[0]!.xact).toBe(expected);
  });

  it('keeps the changed columns and their old values', async () => {
    const db = await createTestDb();
    const agent = await anAgent(db);
    const everyColumn = await columnsOf(db, 'agents');
    await db.execute(sql`UPDATE agents SET name = 'Clara' WHERE id = ${agent.id}`);
    const before = (await db.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(a) as row from agents a where id = ${agent.id}`)).rows[0]!.row;
    await db.execute(sql`DELETE FROM agents WHERE id = ${agent.id}`);

    const [inserted, updated, deleted] = await journalOf(db, 'agents');

    expect(inserted).toMatchObject({ op: 'insert', key: { id: agent.id }, old: null });
    expect([...inserted!.cols].sort()).toEqual([...everyColumn].sort());
    expect(updated).toMatchObject({ op: 'update', key: { id: agent.id }, cols: ['name'], old: { name: 'Bruno' } });
    expect(deleted).toMatchObject({ op: 'delete', key: { id: agent.id } });
    expect([...deleted!.cols].sort()).toEqual([...everyColumn].sort());
    expect(deleted!.old).toEqual(before);
  });

  it('keeps a hash of a file, not its bytes', async () => {
    const db = await createTestDb();
    const agent = await anAgent(db);
    const [person] = await db.insert(people).values({ companyId: agent.companyId, name: 'Ivan', email: 'ivan@acme.test', status: 'active', scopeKind: 'company' }).returning();
    const [plan] = await db.insert(subscriptions).values({ companyId: agent.companyId, provider: 'anthropic_api', kind: 'api_key', label: 'Plan', ownerPersonId: person!.id, status: 'ready' }).returning();
    const [job] = await db.insert(jobs).values({ companyId: agent.companyId, subscriptionId: plan!.id, agentId: agent.id, prompt: '', timeoutMs: 1000 }).returning();
    const bytes = Buffer.from('the bytes of a file');
    const [file] = await db.insert(attachments).values({ companyId: agent.companyId, jobId: job!.id, agentId: agent.id, mediaType: 'text/plain', bytes, size: bytes.length }).returning();

    await db.execute(sql`DELETE FROM attachments WHERE id = ${file!.id}`);

    const deleted = (await journalOf(db, 'attachments')).find(row => row.op === 'delete')!;
    expect(deleted.old!.bytes).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  });

  it('journals an update that changes nothing', async () => {
    const db = await createTestDb();
    const agent = await anAgent(db);
    await db.execute(sql`UPDATE agents SET name = name WHERE id = ${agent.id}`);
    const updates = (await journalOf(db, 'agents')).filter(row => row.op === 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.cols).toEqual([]);
  });

  it('names a row by its key alone, not by a column the key only includes', async () => {
    const db = await createTestDb();
    await aJournaledTable(db, 'covered', 'a integer, b integer, c integer, PRIMARY KEY (a, b) INCLUDE (c)');
    await db.$client.exec('INSERT INTO covered VALUES (1, 2, 3)');
    expect((await journalOf(db, 'covered'))[0]!.key).toEqual({ a: 1, b: 2 });
  });

  it("journals what the orchestrator's role changes", async () => {
    const { app, db } = await testApp();
    const testDb = db as unknown as TestDb;
    await aCompany(testDb);
    const [answer] = await app.ctx.agentSql!.run(`INSERT INTO notebook_notes (company_id, number, text) SELECT id, 1, 'A note' FROM companies RETURNING id`, 'write');
    expect((await journalOf(testDb, 'notebook_notes')).map(row => row.key)).toEqual([{ id: answer!.rows[0]!.id }]);
  });
});

describe('fence 1', () => {
  it('refuses a commit once the lease has ended, at the commit and not before', async () => {
    const db = await createTestDb();
    await setLease(db, { until: '-infinity' });
    await db.$client.exec('BEGIN');
    await db.$client.exec(`INSERT INTO companies (name) VALUES ('Acme')`);
    expect((await db.$client.query('SELECT name FROM companies')).rows).toEqual([{ name: 'Acme' }]);

    expect(await refusal(db.$client.exec('COMMIT'))).toBe(true);

    expect((await db.$client.query('SELECT name FROM companies')).rows).toEqual([]);
  });

  it.each<[string, { kind?: LeaseKind; sync?: LeaseSync | null; termNumber?: number }]>([
    ['a maintenance lease', { kind: 'maintenance' }],
    ['a normal lease without sync', { sync: null }],
    ['a lease of another term', { termNumber: 2 }],
  ])('refuses %s', async (_name, change) => {
    const db = await createTestDb();
    await setLease(db, change);
    expect(await refusal(db.transaction(tx => tx.insert(companies).values({ name: 'Acme' })))).toBe(true);
  });

  it('refuses a commit without synchronous commit', async () => {
    const db = await createTestDb();
    const commit = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL synchronous_commit = local`);
      await tx.insert(companies).values({ name: 'Acme' });
    });
    expect(await refusal(commit)).toBe(true);
  });

  it('refuses when this machine has no lease row or no state row', async () => {
    for (const table of ['lease', 'state']) {
      const db = await createTestDb();
      await db.execute(sql`DELETE FROM ${sql.raw(`net_local.${table}`)}`);
      expect(await refusal(db.insert(companies).values({ name: 'Acme' })), table).toBe(true);
    }
  });

  it('commits under a split lease, which has no sync', async () => {
    const db = await createTestDb();
    await setLease(db, { kind: 'split', sync: null });
    expect(await refusal(db.insert(companies).values({ name: 'Acme' }))).toBe('committed');
  });

  it('lets a superuser session that does not say it is fenced pass', async () => {
    const db = await createTestDb();
    await setLease(db, { until: '-infinity' });
    await db.$client.exec('SET hornhoof.fenced = off');
    const companyId = await aCompany(db);
    expect(await journalOf(db, 'companies')).toHaveLength(1);

    await db.$client.exec('SET hornhoof.fenced = on');
    expect(await refusal(db.insert(departments).values(aDepartment('Sales', companyId)))).toBe(true);
  });
});

describe('the journal taken off for a migration', () => {
  it("refuses a fenced session's write under any lease, and lets the migration's pass with no journal row", async () => {
    const db = await createTestDb();
    await takeJournalOff(db);

    expect(await refusal(db.insert(companies).values({ name: 'Acme' }))).toBe(true);
    expect(await db.select().from(companies)).toEqual([]);

    await asMigration(db, `INSERT INTO companies (name) VALUES ('Acme')`);
    expect(await db.select().from(companies)).toHaveLength(1);
    expect(await journalOf(db, 'companies')).toEqual([]);
  });

  it('lets a migration drop a column and write that table, and journals the new shape once back on', async () => {
    const db = await createTestDb();
    await aJournaledTable(db, 'shrinking', 'id integer PRIMARY KEY, kept text, going text');
    await db.$client.exec(`INSERT INTO shrinking VALUES (1, 'old', 'gone')`);
    await takeJournalOff(db);

    await asMigration(db, `ALTER TABLE shrinking DROP COLUMN going; UPDATE shrinking SET kept = 'by the migration'`);
    await putJournalOn(db);
    await db.$client.exec(`UPDATE shrinking SET kept = 'by the app'`);

    const updates = (await journalOf(db, 'shrinking')).filter(row => row.op === 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ cols: ['kept'], old: { kept: 'by the migration' } });
  });

  it('leaves no function behind for a table a migration dropped', async () => {
    const db = await createTestDb();
    await aJournaledTable(db, 'passing', 'id integer PRIMARY KEY');
    await takeJournalOff(db);

    await asMigration(db, 'DROP TABLE passing');
    await putJournalOn(db);

    expect(await journalFunctionThere(db, 'passing')).toBe(false);
    expect(await tablesWithJournalOff(db)).toEqual([]);
  });

  it('journals a table a migration renamed under its new name, and leaves no function of the old one', async () => {
    const db = await createTestDb();
    await aJournaledTable(db, 'before_rename', 'id integer PRIMARY KEY');
    await takeJournalOff(db);

    await asMigration(db, 'ALTER TABLE before_rename RENAME TO after_rename');
    await putJournalOn(db);
    await db.$client.exec('INSERT INTO after_rename VALUES (1)');

    expect(await journalOf(db, 'after_rename')).toHaveLength(1);
    expect(await journalFunctionThere(db, 'before_rename')).toBe(false);
  });

  it("journals a table named off, whose function's name no helper of net takes", async () => {
    const db = await createTestDb();
    await aJournaledTable(db, 'off', 'id integer PRIMARY KEY');
    await db.$client.exec('INSERT INTO off VALUES (1)');
    expect(await journalOf(db, 'off')).toHaveLength(1);
  });

  it("leaves alone a function of net that is no table's journal, whatever its name", async () => {
    const db = await createTestDb();
    await db.$client.exec(`CREATE FUNCTION net.journal_later() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);
    await takeJournalOff(db);
    await putJournalOn(db);
    expect((await db.$client.query('SELECT net.journal_later() AS one')).rows).toEqual([{ one: 1 }]);
  });

  it('names the tables whose journal is off, to the orchestrator as to Hornhoof and not to Operations', async () => {
    const { app, db } = await testApp();
    const testDb = db as unknown as TestDb;
    expect(await tablesWithJournalOff(testDb)).toEqual([]);

    await takeJournalOff(testDb);
    expect(await tablesWithJournalOff(testDb)).toEqual(expect.arrayContaining(['companies', 'notebook_notes']));
    await expect(app.ctx.agentSql!.run('SELECT * FROM net.journals_off()', 'read')).rejects.toThrow(/permission denied/);
    expect((await app.ctx.agentSql!.run('SELECT * FROM net.journals_off()', 'write'))[0]!.rows).toEqual(expect.arrayContaining([{ table_name: 'companies' }]));

    await putJournalOn(testDb);
    expect(await tablesWithJournalOff(testDb)).toEqual([]);
  });
});

describe('what a killed migration can leave', () => {
  const needsPuttingBack = async (db: TestDb): Promise<boolean> => (await db.$client.query<{ needed: boolean }>(JOURNAL_NEEDS_PUTTING_BACK)).rows[0]!.needed;

  it('is nothing on a database whose journal is whole', async () => {
    expect(await needsPuttingBack(await createTestDb())).toBe(false);
  });

  it.each([
    ['a journal function left off', 'SELECT net.detach_journal()'],
    ['a table without its trigger', 'DROP TRIGGER net_journal ON notebook_notes'],
    ['a foreign key not deferrable', 'CREATE TABLE public.later (id integer PRIMARY KEY, company uuid REFERENCES companies (id)); SELECT net.attach_journal()'],
  ])('is seen: %s', async (_name, left) => {
    const db = await createTestDb();
    await db.$client.exec(left);
    expect(await needsPuttingBack(db)).toBe(true);
    await db.$client.exec('SELECT net.attach_journal(); SELECT net.defer_foreign_keys();');
    expect(await needsPuttingBack(db)).toBe(false);
  });
});

describe('a write when the lease has ended', () => {
  it('answers read_only to a write when the lease has ended', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [acme] = await db.select().from(companies);
    const [bruno] = await db.insert(agents).values({ companyId: acme!.id, kind: 'worker', name: 'Bruno', model: '' }).returning();
    await setLease(db, { until: '-infinity' });

    expect((await app.inject({ method: 'GET', url: '/api/me', ...as(ceo) })).statusCode).toBe(200);

    const rename = await app.inject({ method: 'PATCH', url: `/api/agents/${bruno!.id}`, payload: { name: 'Bruno the Second' }, ...as(ceo) });
    expect(rename.statusCode).toBe(503);
    expect(rename.json()).toMatchObject({ error: { code: 'unavailable', reason: 'read_only' } });
  });
});
