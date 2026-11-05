import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { TestProject } from 'vitest/node';
import { applyMissingMigrations, MIGRATIONS } from '../src/db/client.js';
import { AFTER_MIGRATIONS } from '../src/db/net.js';
import * as schema from '../src/db/schema.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /* The dump of the migrated database every test database starts from. */
    migratedDataDir: string;
  }
}

/* Every test database holds this lease and says it is fenced (helpers.ts), so the whole suite runs under fence 1. */
export const ENDLESS_LEASE = `
  INSERT INTO net_local.state (term_number, term_machine, machine, cluster)
    SELECT 1, 'test', 'test', system_identifier::text FROM pg_control_system();
  INSERT INTO net_local.lease (term_number, term_machine, kind, until, sync) VALUES (1, 'test', 'normal', 'infinity', 'alone');`;

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
    await client.exec(AFTER_MIGRATIONS);
    await client.exec(ENDLESS_LEASE);
    writeFileSync(file, Buffer.from(await (await client.dumpDataDir('none')).arrayBuffer()));
  } finally {
    await client.close();
  }
  project.provide('migratedDataDir', file);
  return () => rmSync(dir, { recursive: true, force: true });
}
