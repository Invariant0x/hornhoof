import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { MIGRATIONS, type Db } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';

export const TEST_SECRET = Buffer.alloc(32, 7).toString('base64');

export async function createTestDb(): Promise<Db> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return db as unknown as Db;
}

export async function testApp(env: NodeJS.ProcessEnv = {}): Promise<{ app: FastifyInstance; db: Db; config: Config }> {
  const db = await createTestDb();
  const config = loadConfig({ HORNHOOF_SECRET: TEST_SECRET, ...env });
  const app = await buildApp({ db, config });
  return { app, db, config };
}
