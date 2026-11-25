import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { readMigrationFiles, type MigrationConfig, type MigrationMeta } from 'drizzle-orm/migrator';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { confirmCommits, keepErrors, logTimeouts, noteDatabaseFailure } from './confirm.js';
import { AFTER_MIGRATIONS, BEFORE_MIGRATIONS, FENCED, JOURNAL_NEEDS_PUTTING_BACK } from './net.js';
import * as schema from './schema.js';
import { recordSources } from './sources.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

export const APP_NAME = 'hornhoof-app';
export const MIGRATE_NAME = 'hornhoof-migrate';
export const KEEPER_NAME = 'hornhoof-keeper';

/* The app's transactions end when they run 5 s before their commit, and a commit hears only of warnings. A superuser session
   is fenced only when it says so, and the app says so when it runs with a keeper. The fence lets a commit through only
   under synchronous_commit on, which the app asks for itself: a session left to the server's own setting got whatever the
   server's file said, and a file with local in it refused every write of the app. */
const APP_SETTINGS = '-c transaction_timeout=5s -c client_min_messages=warning -c synchronous_commit=on';
const appSettings = (fenced: boolean | undefined): string => (fenced ? `${APP_SETTINGS} -c ${FENCED}=on` : APP_SETTINGS);

type PoolOptions = { statementTimeoutMs?: number; fenced?: boolean };

/* pg lets an address's options and application_name replace the ones given beside it, and a fence must not depend on what
   an address says. */
export function stripSettings(url: string): string {
  const address = new URL(url);
  address.searchParams.delete('options');
  address.searchParams.delete('application_name');
  return address.toString();
}

function watchClient(client: pg.ClientBase, name: string): void {
  keepErrors(client);
  if (name !== APP_NAME) return;
  confirmCommits(client);
  logTimeouts(client, line => console.warn(line));
}

/* pg reports an idle connection the database dropped, as when Postgres restarts, as an error on the pool. Without a
   listener Node ends the whole server; with one the pool opens a fresh connection for the next query. The name shows
   in pg_stat_activity, so each process can be told apart there. */
export function openPool(url: string, onDropped: (err: Error) => void, name: string, opts: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString: stripSettings(url),
    application_name: name,
    ...(opts.statementTimeoutMs === undefined ? {} : { statement_timeout: opts.statementTimeoutMs }),
    ...(name === APP_NAME ? { options: appSettings(opts.fenced) } : {}),
  });
  pool.on('error', onDropped);
  pool.on('connect', client => watchClient(client, name));
  markConnectFailures(pool);
  return pool;
}

type ConnectCallback = (err: Error | undefined, ...rest: unknown[]) => void;

/* A connect that fails says what any socket says. It is marked as the database's own, so what looks at a failure can
   tell a database out of reach from another service that is. pg-pool connects in both of its forms. */
function markConnectFailures(pool: pg.Pool): void {
  const connect = pool.connect.bind(pool) as (callback?: ConnectCallback) => Promise<pg.PoolClient> | undefined;
  const marked = (err: unknown): unknown => {
    try {
      return noteDatabaseFailure(err);
    } catch {
      return err;
    }
  };
  pool.connect = ((callback?: ConnectCallback) => {
    if (callback) return connect((err, ...rest) => callback(err ? (marked(err) as Error) : err, ...rest));
    return (connect() as Promise<pg.PoolClient>).catch(noteDatabaseFailure);
  }) as typeof pool.connect;
}

const warnDropped = (err: Error) => console.warn(`Lost a database connection, will open another: ${err.message}`);

/* The app and the CLI only read the schema; the migrate entry point is the one place that changes it. Inside the work of a
   node message, a page's request or a tool call, every commit lists where it came from (sources.ts). */
export function openDb(url: string, name: string, opts: PoolOptions = {}): Db {
  return recordSources(drizzle(openPool(url, warnDropped, name, opts), { schema }));
}

/* Runs on a pool with no timeouts, since a migration may take as long as it needs. Answers how many migrations the
   database has recorded. */
export async function migrateDb(url: string, folder: string = MIGRATIONS): Promise<number> {
  const pool = openPool(url, warnDropped, MIGRATE_NAME);
  try {
    const db = drizzle(pool, { schema });
    const config = { migrationsFolder: folder };
    if (await anyMigrationToApply(pool, db, config)) await applyMigrations(pool, db, config);
    else await healJournal(pool);
    const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM drizzle.__drizzle_migrations');
    return Number(rows[0]!.count);
  } finally {
    await pool.end();
  }
}

type MigratingDb = NodePgDatabase<typeof schema>;

/* A fresh database has no record of any migration yet. */
async function anyMigrationToApply(pool: pg.Pool, db: MigratingDb, config: MigrationConfig): Promise<boolean> {
  const { rows } = await pool.query<{ there: boolean }>(`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS there`);
  return !rows[0]!.there || (await unappliedMigrations(db, config)).length > 0;
}

async function applyMigrations(pool: pg.Pool, db: MigratingDb, config: MigrationConfig): Promise<void> {
  await pool.query(BEFORE_MIGRATIONS);
  await withJournalBackAfter(pool, async () => {
    await migrate(db, config);
    await applyMissingMigrations(db, config);
  });
}

const JOURNAL_FUNCTION_IS_THERE = `SELECT to_regprocedure('net.attach_journal()') IS NOT NULL AS needed`;

/* Puts the journal back when the question, one row with one boolean named needed, answers yes. */
async function putJournalBackWhen(pool: pg.Pool, question: string): Promise<void> {
  const { rows } = await pool.query<{ needed: boolean }>(question);
  if (rows[0]!.needed) await pool.query(AFTER_MIGRATIONS);
}

/* With nothing to apply the journal stays on and no table is locked, as a by-hand start over a live company runs this too. */
const healJournal = (pool: pg.Pool): Promise<void> => putJournalBackWhen(pool, JOURNAL_NEEDS_PUTTING_BACK);

/* The journal goes back also after a failed run, whose failure stays what the caller gets. A failure to put it back after a
   good run is thrown too: the company must not go on without it. If it cannot go back after a failed run, the journal stays
   off, which refuses fenced sessions until the next run. An older database has no such function yet. */
async function withJournalBackAfter(pool: pg.Pool, migrations: () => Promise<void>): Promise<void> {
  try {
    await migrations();
  } catch (err) {
    await putJournalBack(pool).catch((failed: Error) => console.warn(`Could not put the journal back after a failed migration: ${failed.message}`));
    throw err;
  }
  await putJournalBack(pool);
}

const putJournalBack = (pool: pg.Pool): Promise<void> => putJournalBackWhen(pool, JOURNAL_FUNCTION_IS_THERE);

/* What no row records yet: drizzle's run applies those above its newest record, applyMissingMigrations those below it. */
async function unappliedMigrations<T extends PgQueryResultHKT, S extends Record<string, unknown>>(db: PgDatabase<T, S>, config: MigrationConfig): Promise<MigrationMeta[]> {
  const recorded = await db.select({ when: sql<string>`created_at` }).from(sql`drizzle.__drizzle_migrations`);
  const applied = new Set(recorded.map(row => Number(row.when)));
  return readMigrationFiles(config).filter(migration => !applied.has(migration.folderMillis));
}

/* Merged branches can put an unrecorded migration below Drizzle's newest timestamp. */
export async function applyMissingMigrations<T extends PgQueryResultHKT, S extends Record<string, unknown>>(db: PgDatabase<T, S>, config: MigrationConfig): Promise<void> {
  const journal = JSON.parse(readFileSync(`${config.migrationsFolder}/meta/_journal.json`, 'utf8')) as { entries: { tag: string; when: number }[] };
  for (const migration of await unappliedMigrations(db, config)) {
    await db.transaction(async tx => {
      for (const statement of migration.sql) await tx.execute(sql.raw(statement));
      await tx.execute(sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${migration.hash}, ${migration.folderMillis})`);
    });
    console.info(`Applied missing migration ${journal.entries.find(entry => entry.when === migration.folderMillis)!.tag}`);
  }
}
