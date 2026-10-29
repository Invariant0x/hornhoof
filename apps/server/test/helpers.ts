import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { MIGRATIONS, type Db } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';

export const TEST_SECRET = Buffer.alloc(32, 7).toString('base64');
export const TEST_API_KEY = 'sk-ant-api03-test-key-9f3a';
export const SETUP = {
  companyName: 'Acme',
  name: 'Ivan',
  email: ' Ivan@Acme.com ',
  password: 'correct horse battery',
  chief: { mode: 'api_key', provider: 'anthropic_api', apiKey: TEST_API_KEY },
};

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

export function sessionFrom(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find(c => c.name === 'hh_session');
  if (!cookie) throw new Error(`No session cookie in a ${res.statusCode} response.`);
  return cookie.value;
}

/* Runs first-run setup and returns the CEO's session token. */
export async function setUpCompany(app: FastifyInstance): Promise<string> {
  return sessionFrom(await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP }));
}
