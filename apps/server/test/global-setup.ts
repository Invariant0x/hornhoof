import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { TestProject } from 'vitest/node';
import { applyMissingMigrations, MIGRATIONS } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /* The dump of the migrated database every test database starts from. */
    migratedDataDir: string;
  }
}

/* A new PGlite runs initdb, about two seconds of a processor, and the migrations add half a second more. The run pays for
   that once, before any test file starts, and keeps the dump in a file the test databases open in a fraction of a second. */
export default async function setup(project: TestProject): Promise<() => void> {
  const dir = mkdtempSync(join(tmpdir(), 'hh-test-db-'));
  const file = join(dir, 'migrated.tar');
  const client = new PGlite();
  try {
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    await applyMissingMigrations(db, { migrationsFolder: MIGRATIONS });
    writeFileSync(file, Buffer.from(await (await client.dumpDataDir('none')).arrayBuffer()));
  } finally {
    await client.close();
  }
  project.provide('migratedDataDir', file);
  return () => rmSync(dir, { recursive: true, force: true });
}
