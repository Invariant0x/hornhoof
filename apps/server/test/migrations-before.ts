import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, expect, onTestFinished, TestRunner } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { removeTempFolder, tempFolder } from './temp-folder.js';

type Entry = { tag: string };

/* A copy of the migrations folder with its journal cut as asked, for a folder named from prefix. A migrator reads the
   journal and the SQL of each migration it names. The snapshots beside them, 32.7 of the folder's 33 MB, it never opens,
   and copying them twice a test cost a busy machine up to a second each time. The folder goes when the test ends, or,
   cut as the file is collected, once the file's tests have run. */
export async function migrationsCut(prefix: string, cut: (entries: Entry[]) => Entry[]): Promise<string> {
  const folder = await tempFolder(prefix);
  (TestRunner.getCurrentTest() ? onTestFinished : afterAll)(() => removeTempFolder(folder));
  const journal = JSON.parse(await readFile(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as { entries: Entry[] };
  journal.entries = cut(journal.entries);
  await mkdir(join(folder, 'meta'));
  await Promise.all(journal.entries.map(({ tag }) => copyFile(join(MIGRATIONS, `${tag}.sql`), join(folder, `${tag}.sql`))));
  await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  return folder;
}

/* A copy of the migrations folder that stops at the one named, whatever number it has by the time it merges. */
function journalCutAt(name: string, entriesPastIt: number): Promise<string> {
  return migrationsCut(`${name}-migration-`, entries => {
    const own = entries.findIndex(entry => entry.tag.endsWith(`_${name}`));
    expect(own).toBeGreaterThan(0);
    return entries.slice(0, own + entriesPastIt);
  });
}

/* The schema just before the migration named, and with it applied: what a later migration adds is no part of its check. */
export const migrationsBefore = (name: string): Promise<string> => journalCutAt(name, 0);
export const migrationsThrough = (name: string): Promise<string> => journalCutAt(name, 1);
