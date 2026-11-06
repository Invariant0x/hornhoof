import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, PglitePreparedQuery, type PgliteDatabase } from 'drizzle-orm/pglite';
import { inject, onTestFinished, TestRunner, vi } from 'vitest';
import * as schema from '../src/db/schema.js';

/* Every test database starts from a copy of the one global-setup.ts migrated for the run. */
let migrated: Blob | undefined;
let opened = 0;
type TestDb = PgliteDatabase<typeof schema> & { $client: PGlite };

export const databasesOpened = () => opened;

export function ownDatabases(): void {}

export async function freshPglite(): Promise<PGlite> {
  return new PGlite();
}

export async function openTestDb(): Promise<{ client: PGlite; db: TestDb }> {
  migrated ??= new Blob([readFileSync(inject('migratedDataDir'))]);
  opened += 1;
  const client = new PGlite({ loadDataDir: migrated });
  const db = drizzle(client, { schema });
  return { client, db };
}

/* The statements the database runs from now on, in order, with their values. PGlite has one connection, so two moves
   cannot race in a test; this shows instead that a move takes the locks that make them go one after the other. */
export function statements(): { sql: string; params: unknown[] }[] {
  const seen: { sql: string; params: unknown[] }[] = [];
  const execute = PglitePreparedQuery.prototype.execute;
  const spy = vi.spyOn(PglitePreparedQuery.prototype, 'execute').mockImplementation(function (this: PglitePreparedQuery<never>, values) {
    const q = this as unknown as { queryString: string; params: unknown[] };
    seen.push({ sql: q.queryString, params: q.params });
    return execute.call(this, values);
  });
  onTestFinished(() => spy.mockRestore());
  return seen;
}

/* What a test spends on its database and app is no test: the report of test times shows it apart. */
export async function timed<T>(phase: 'setupMs' | 'teardownMs', work: () => Promise<T>): Promise<T> {
  const from = performance.now();
  try {
    return await work();
  } finally {
    const meta = TestRunner.getCurrentTest()?.meta as { setupMs?: number; teardownMs?: number } | undefined;
    if (meta) meta[phase] = (meta[phase] ?? 0) + performance.now() - from;
  }
}

/* Each PGlite is a whole Postgres in WASM memory, so it closes when its test ends. Call these inside a test. */
export async function createTestDb(): Promise<TestDb> {
  const { client, db } = await timed('setupMs', openTestDb);
  onTestFinished(() => timed('teardownMs', () => client.close()));
  return db;
}
