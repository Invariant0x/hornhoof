import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function createDb(url: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return db as unknown as Db;
}
