import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { readMigrationFiles, type MigrationConfig } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

/* pg reports an idle connection the database dropped, as when Postgres restarts, as an error on the pool. Without a
   listener Node ends the whole server; with one the pool opens a fresh connection for the next query. */
export function openPool(url: string, onDropped: (err: Error) => void): pg.Pool {
  const pool = new pg.Pool({ connectionString: url });
  pool.on('error', onDropped);
  return pool;
}

export async function createDb(url: string): Promise<Db> {
  const pool = openPool(url, err => console.warn(`Lost a database connection, will open another: ${err.message}`));
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await applyMissingMigrations(db, { migrationsFolder: MIGRATIONS });
  return db;
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
