/* eslint-disable hornhoof/no-ddl-on-shared-database -- These run on a Postgres database each of them makes and drops, shared with no other test. */
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { describe, expect, it, onTestFinished } from 'vitest';
import { openAgentSql } from '../../src/db/agent-sql.js';
import { APP_NAME, MIGRATE_NAME, MIGRATIONS, migrateDb } from '../../src/db/client.js';
import { FENCED, JOURNAL_TRIGGER, LEASE_REFUSED } from '../../src/db/net.js';
import { ENDLESS_LEASE } from '../prepare-environment.js';
import { until } from '../helpers.js';
import { realDatabase, sessionsWaitingOnALock, type RealDatabase } from './pg.js';

const END_LEASE = `UPDATE net_local.lease SET until = '-infinity'`;
const A_NOTE = `INSERT INTO notebook_notes (company_id, number, text) SELECT id, (SELECT count(*) + 1 FROM notebook_notes), 'A note' FROM companies`;
const FENCED_OPTION = `-c ${FENCED}=on`;

/* A migrated database of its own with a company, under the lease every test database holds. */
async function leasedDatabase(): Promise<RealDatabase> {
  const real = await realDatabase();
  onTestFinished(() => real.drop());
  await migrateDb(real.url);
  await real.admin.query(ENDLESS_LEASE);
  await real.admin.query(`INSERT INTO companies (name) VALUES ('Acme')`);
  return real;
}

async function connected(real: RealDatabase, config: pg.ClientConfig): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: real.url, ...config });
  await client.connect();
  onTestFinished(() => client.end());
  return client;
}

/* A copy of the migrations with one more, as a later build would bring it. */
async function migrationsWith(text: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'hh-real-migrations-'));
  onTestFinished(() => rm(folder, { recursive: true, force: true }));
  await cp(MIGRATIONS, folder, { recursive: true });
  const file = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(file, 'utf8')) as { entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[] };
  const last = journal.entries.at(-1)!;
  journal.entries.push({ idx: last.idx + 1, version: last.version, when: last.when + 1, tag: '9999_later', breakpoints: true });
  await writeFile(file, JSON.stringify(journal));
  await writeFile(join(folder, '9999_later.sql'), text);
  return folder;
}

const tablesWithoutJournal = async (real: RealDatabase): Promise<string[]> =>
  (
    await real.admin.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = $1)`,
      [JOURNAL_TRIGGER],
    )
  ).rows.map(row => row.relname);

const journalOfNotes = async (real: RealDatabase): Promise<string> =>
  (await real.admin.query<{ definition: string }>(`SELECT pg_get_functiondef('net."journal_notebook_notes"'::regproc) AS definition`)).rows[0]!.definition;

const tablesWithJournalOff = async (real: RealDatabase): Promise<string[]> =>
  (await real.admin.query<{ table_name: string }>('SELECT table_name FROM net.journals_off()')).rows.map(row => row.table_name);

const journalTriggers = async (real: RealDatabase): Promise<string[]> =>
  (await real.admin.query<{ oid: string }>('SELECT oid FROM pg_trigger WHERE tgname = $1 ORDER BY oid', [JOURNAL_TRIGGER])).rows.map(row => row.oid);

const journaledNotes = async (real: RealDatabase): Promise<number | null> =>
  (await real.admin.query(`SELECT 1 FROM net.journal WHERE tbl = 'notebook_notes'`)).rowCount;

describe('the fence on real Postgres', () => {
  it("fences the app's commits and lets older builds through", async () => {
    const real = await leasedDatabase();
    const app = await connected(real, { application_name: APP_NAME, options: FENCED_OPTION });
    await app.query(A_NOTE);
    await real.admin.query(END_LEASE);

    await expect(app.query(A_NOTE)).rejects.toMatchObject({ code: LEASE_REFUSED });

    const older = await connected(real, {});
    await older.query(A_NOTE);
    const journaled = await real.admin.query(`SELECT 1 FROM net.journal WHERE tbl = 'notebook_notes'`);
    const notes = await real.admin.query('SELECT 1 FROM notebook_notes');
    expect(notes.rowCount).toBe(2);
    expect(journaled.rowCount).toBe(2);
  });

  it('fences the agent role whatever it sets', async () => {
    const real = await leasedDatabase();
    const agents = (await openAgentSql(real.url))!;
    onTestFinished(() => agents.close());
    await real.admin.query(END_LEASE);

    await expect(agents.run(`SET ${FENCED} = off; ${A_NOTE}`, 'write')).rejects.toMatchObject({ code: LEASE_REFUSED });

    expect((await real.admin.query('SELECT 1 FROM notebook_notes')).rowCount).toBe(0);
  });
});

describe('migrating on real Postgres', () => {
  it('takes the journal off for the migrations and puts it back', async () => {
    const real = await leasedDatabase();
    await real.admin.query(A_NOTE);
    expect(await journalOfNotes(real)).toContain('by_orchestrator');
    const later = await migrationsWith(`ALTER TABLE notebook_notes DROP COLUMN by_orchestrator;
--> statement-breakpoint
UPDATE notebook_notes SET text = 'Changed by the migration';`);

    await migrateDb(real.url, later);

    expect((await real.admin.query('SELECT text FROM notebook_notes')).rows).toEqual([{ text: 'Changed by the migration' }]);
    expect(await journalOfNotes(real)).not.toContain('by_orchestrator');
    expect(await tablesWithoutJournal(real)).toEqual([]);
    expect(await tablesWithJournalOff(real)).toEqual([]);
  });

  it('puts the journal back after a migration that failed, and still answers with its failure', async () => {
    const real = await leasedDatabase();
    const failing = await migrationsWith('SELECT 1/0;');

    await expect(migrateDb(real.url, failing)).rejects.toSatisfy((err: Error) => /division by zero/.test(`${err.message} ${String(err.cause)}`));

    expect(await tablesWithoutJournal(real)).toEqual([]);
    expect(await tablesWithJournalOff(real)).toEqual([]);
  });

  it('leaves the journal alone when there is nothing to apply', async () => {
    const real = await leasedDatabase();
    const triggers = await journalTriggers(real);
    const app = await connected(real, { options: FENCED_OPTION });
    /* Taking a trigger off would have to wait for this open write, so the run below would never end. */
    await app.query('BEGIN');
    await app.query(A_NOTE);

    await migrateDb(real.url);

    await app.query(A_NOTE);
    await app.query('COMMIT');
    expect(await journalTriggers(real)).toEqual(triggers);
    expect(await journaledNotes(real)).toBe(2);
  });

  it('refuses a fenced session while the migrations run, under any lease, and journals it again after', async () => {
    const real = await leasedDatabase();
    const later = await migrationsWith('ALTER TABLE sign_in_attempts ADD COLUMN later text;');
    const app = await connected(real, { options: FENCED_OPTION });
    const holder = await connected(real, {});
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE sign_in_attempts');
    const migrating = migrateDb(real.url, later);
    await until(async () => (await sessionsWaitingOnALock(real, MIGRATE_NAME)) === 1);

    await expect(app.query(A_NOTE)).rejects.toMatchObject({ code: LEASE_REFUSED });

    await holder.query('COMMIT');
    await migrating;
    await app.query(A_NOTE);
    expect(await journaledNotes(real)).toBe(1);
  });

  it('fails closed after a run killed with the journal off, and the next migrate heals it', async () => {
    const real = await leasedDatabase();
    const app = await connected(real, { options: FENCED_OPTION });
    const agents = (await openAgentSql(real.url))!;
    onTestFinished(() => agents.close());
    await real.admin.query('SELECT net.detach_journal()');

    await expect(app.query(A_NOTE)).rejects.toMatchObject({ code: LEASE_REFUSED });
    await expect(agents.run(`SET ${FENCED} = off; ${A_NOTE}`, 'write')).rejects.toMatchObject({ code: LEASE_REFUSED });

    await migrateDb(real.url);

    await app.query(A_NOTE);
    expect(await journaledNotes(real)).toBe(1);
    expect(await tablesWithJournalOff(real)).toEqual([]);
  });
});

describe('a large file on real Postgres', () => {
  it("commits a 50 MB file within the app's limit, and journals its hash", async () => {
    const real = await leasedDatabase();
    await real.admin.query('CREATE TABLE public.big (id int PRIMARY KEY, b bytea)');
    await real.admin.query('SELECT net.attach_journal()');
    const app = await connected(real, { options: `-c transaction_timeout=5s ${FENCED_OPTION}` });
    const bytes = randomBytes(50 * 1024 * 1024);

    await app.query('INSERT INTO big (id, b) VALUES (1, $1)', [bytes]);
    await app.query('DELETE FROM big WHERE id = 1');

    const { rows } = await real.admin.query<{ old: { b: string } }>(`SELECT old FROM net.journal WHERE tbl = 'big' AND op = 'delete'`);
    const matches = rows[0]!.old.b === `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    expect(matches).toBe(true);
  });
});
