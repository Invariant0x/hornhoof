import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';

/* A copy of the migrations folder that stops at the one named, whatever number it has by the time it merges. */
async function journalCutAt(name: string, entriesPastIt: number): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), `${name}-migration-`));
  onTestFinished(() => rm(folder, { recursive: true, force: true }));
  const journal = JSON.parse(await readFile(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  const own = journal.entries.findIndex(entry => entry.tag.endsWith(`_${name}`));
  expect(own).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, own + entriesPastIt);
  /* A migrator reads the journal and the SQL of each migration it names. The snapshots beside them, 32.7 of the folder's
     33 MB, it never opens, and copying them twice a test cost a busy machine up to a second each time. */
  await mkdir(join(folder, 'meta'));
  await Promise.all(journal.entries.map(({ tag }) => copyFile(join(MIGRATIONS, `${tag}.sql`), join(folder, `${tag}.sql`))));
  await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  return folder;
}

/* The schema just before the migration named, and with it applied: what a later migration adds is no part of its check. */
export const migrationsBefore = (name: string): Promise<string> => journalCutAt(name, 0);
export const migrationsThrough = (name: string): Promise<string> => journalCutAt(name, 1);
