import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { readMigrationFiles, type MigrationConfig } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { AFTER_MIGRATIONS, BEFORE_MIGRATIONS } from './net.js';
import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

export const APP_NAME = 'hornhoof-app';
export const MIGRATE_NAME = 'hornhoof-migrate';
export const KEEPER_NAME = 'hornhoof-keeper';

/* pg reports an idle connection the database dropped, as when Postgres restarts, as an error on the pool. Without a
   listener Node ends the whole server; with one the pool opens a fresh connection for the next query. The name shows
   in pg_stat_activity, so each process can be told apart there. */
export function openPool(url: string, onDropped: (err: Error) => void, name: string, opts: { statementTimeoutMs?: number } = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    application_name: name,
    ...(opts.statementTimeoutMs === undefined ? {} : { statement_timeout: opts.statementTimeoutMs }),
  });
  pool.on('error', onDropped);
  return pool;
}

const warnDropped = (err: Error) => console.warn(`Lost a database connection, will open another: ${err.message}`);

/* The app and the CLI only read the schema; the migrate entry point is the one place that changes it. */
export function openDb(url: string, name: string, opts: { statementTimeoutMs?: number } = {}): Db {
  return drizzle(openPool(url, warnDropped, name, opts), { schema });
}

/* Runs on a pool with no timeouts, since a migration may take as long as it needs. Answers how many migrations the
   database has recorded. */
export async function migrateDb(url: string, folder: string = MIGRATIONS): Promise<number> {
  const pool = openPool(url, warnDropped, MIGRATE_NAME);
  try {
    const db = drizzle(pool, { schema });
    await pool.query(BEFORE_MIGRATIONS);
    await withJournalBackAfter(pool, async () => {
      await migrate(db, { migrationsFolder: folder });
      await applyMissingMigrations(db, { migrationsFolder: folder });
    });
    const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM drizzle.__drizzle_migrations');
    return Number(rows[0]!.count);
  } finally {
    await pool.end();
  }
}

/* The journal goes back also after a failed run, whose failure stays what the caller gets. A failure to put it back after a
   good run is thrown too: the company must not go on without it. An older database has no such function yet. */
async function withJournalBackAfter(pool: pg.Pool, migrations: () => Promise<void>): Promise<void> {
  try {
    await migrations();
  } catch (err) {
    await putJournalBack(pool).catch((failed: Error) => console.warn(`Could not put the journal back after a failed migration: ${failed.message}`));
    throw err;
  }
  await putJournalBack(pool);
}

async function putJournalBack(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ there: boolean }>(`SELECT to_regprocedure('net.attach_journal()') IS NOT NULL AS there`);
  if (rows[0]!.there) await pool.query(AFTER_MIGRATIONS);
}

/* Merged branches can put an unrecorded migration below Drizzle's newest timestamp. */
export async function applyMissingMigrations<T extends PgQueryResultHKT, S extends Record<string, unknown>>(db: PgDatabase<T, S>, config: MigrationConfig): Promise<void> {
  const recorded = await db.select({ when: sql<string>`created_at` }).from(sql`drizzle.__drizzle_migrations`);
  const applied = new Set(recorded.map(row => Number(row.when)));
  const migrations = readMigrationFiles(config);
  const journal = JSON.parse(readFileSync(`${config.migrationsFolder}/meta/_journal.json`, 'utf8')) as { entries: { tag: string }[] };
  for (const [i, migration] of migrations.entries()) {
    if (applied.has(migration.folderMillis)) continue;
    await db.transaction(async tx => {
      for (const statement of migration.sql) await tx.execute(sql.raw(statement));
      await tx.execute(sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${migration.hash}, ${migration.folderMillis})`);
    });
    console.info(`Applied missing migration ${journal.entries[i]!.tag}`);
  }
}
