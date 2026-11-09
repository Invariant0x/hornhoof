import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { MigrationConfig } from 'drizzle-orm/migrator';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate as migrateDrizzle } from 'drizzle-orm/pglite/migrator';
import { onTestFinished } from 'vitest';
import { applyMissingMigrations, MIGRATIONS } from '../src/db/client.js';
import { freshPglite } from './helpers-db.js';

/* What the migration tests share. They are split by migration number into files that run side by side. */

export async function migrate(db: PgliteDatabase, config: MigrationConfig): Promise<void> {
  await migrateDrizzle(db, config);
  await applyMissingMigrations(db, config);
}

/* A fresh install, migrated once for the file by the first test that needs one: each test opens a copy of its own. */
let installed: Promise<Blob> | undefined;
export async function freshInstall(): Promise<PGlite> {
  installed ??= (async () => {
    const client = await freshPglite();
    try {
      await migrate(drizzle(client), { migrationsFolder: MIGRATIONS });
      return await client.dumpDataDir('none');
    } finally {
      await client.close();
    }
  })();
  const client = new PGlite({ loadDataDir: await installed });
  onTestFinished(() => client.close());
  return client;
}

/* A copy of the migrations folder that stops after the given tag, as an older install would have it. */
export async function migrationsUpTo(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hh-migrations-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await cp(MIGRATIONS, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const last = journal.entries.findIndex(e => e.tag === tag);
  journal.entries = journal.entries.slice(0, last + 1);
  await writeFile(journalPath, JSON.stringify(journal));
  return dir;
}
