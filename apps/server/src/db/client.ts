import { fileURLToPath } from 'node:url';
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
  return db as unknown as Db;
}
