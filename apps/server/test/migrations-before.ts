import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';

/* The migrations up to the one named, whatever number it has by the time it merges. */
export async function migrationsBefore(name: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), `${name}-migration-`));
  onTestFinished(() => rm(folder, { recursive: true, force: true }));
  await cp(MIGRATIONS, folder, { recursive: true });
  const file = join(folder, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(file, 'utf8')) as { entries: { tag: string }[] };
  const own = journal.entries.findIndex(entry => entry.tag.endsWith(`_${name}`));
  expect(own).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, own);
  await writeFile(file, JSON.stringify(journal));
  return folder;
}
