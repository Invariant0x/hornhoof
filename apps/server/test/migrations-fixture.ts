import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { MigrationConfig } from 'drizzle-orm/migrator';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate as migrateDrizzle } from 'drizzle-orm/pglite/migrator';
import { afterAll, onTestFinished } from 'vitest';
import { MIGRATIONS, migrateInOrder } from '../src/db/client.js';
import { freshPglite } from './helpers-db.js';
import { migrationsCut } from './migrations-before.js';

/* What the migration tests share. They are split by migration number into files that run side by side. */

/* As the app migrates: what a merged branch left below drizzle's newest record first, then drizzle's run, then the rest. */
export async function migrate(db: PgliteDatabase, config: MigrationConfig): Promise<void> {
  await migrateInOrder(db, config, migrateDrizzle);
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

/* A copy of the migrations folder that stops after the given tag, as an older install would have it: the journal and the
   SQL a migrator reads, without the snapshots. */
export const migrationsUpTo = (tag: string): Promise<string> => migrationsCut('hh-migrations-', entries => entries.slice(0, entries.findIndex(e => e.tag === tag) + 1));

/* The tags in the order they are applied. */
const TAGS = (JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] }).entries.map(entry => entry.tag);

/* Older installs, as the file that asks for them is collected: one database migrated tag by tag from a new one, with a
   copy kept at each of the given tags and at the last migration. Each test then opens a copy of its own, read from one
   the file shares and never changes, and costs what its own steps cost; the migrations are replayed once a file. The
   copies wait on disk, as a dozen of them would fill a busy machine's memory. */
const olderInstalls = new Map<string, string>();
export async function prepareInstalls(tags: readonly string[]): Promise<void> {
  const unknown = tags.filter(tag => !TAGS.includes(tag));
  if (unknown.length) throw new Error(`No migration is tagged ${unknown.join(', ')}.`);
  const ordered = [...new Set(tags)].sort((a, b) => TAGS.indexOf(a) - TAGS.indexOf(b));
  const dir = await mkdtemp(join(tmpdir(), 'hh-installs-'));
  afterAll(() => rm(dir, { recursive: true, force: true }));
  const client = await freshPglite();
  try {
    const db = drizzle(client);
    for (const tag of ordered) {
      await migrate(db, { migrationsFolder: await migrationsUpTo(tag) });
      const file = join(dir, `${tag}.tar`);
      await writeFile(file, new Uint8Array(await (await client.dumpDataDir('none')).arrayBuffer()));
      olderInstalls.set(tag, file);
    }
    await migrate(db, { migrationsFolder: MIGRATIONS });
    installed = Promise.resolve(await client.dumpDataDir('none'));
  } finally {
    await client.close();
  }
}

/* An install migrated up to the given tag, which the file prepared. */
export async function olderInstall(tag: string): Promise<PGlite> {
  const made = olderInstalls.get(tag);
  if (!made) throw new Error(`No install up to ${tag} was prepared: name it where the file prepares its installs.`);
  const client = new PGlite({ loadDataDir: new Blob([await readFile(made)]) });
  onTestFinished(() => client.close());
  return client;
}
