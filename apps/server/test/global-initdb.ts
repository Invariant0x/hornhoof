import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { TestProject } from 'vitest/node';
import { removeTempFolder, tempFolderSync } from './temp-folder.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /* The dump of a database just made by initdb, which every fresh database of a migration test opens (freshPglite). */
    initdbDataDir: string;
  }
}

/* initdb costs a processor several times what opening its dump does. The run pays for it once, before any test file
   starts, instead of the first test of each migration file paying for it within its own time. */
export default async function setup(project: Pick<TestProject, 'provide'>): Promise<() => void> {
  const dir = tempFolderSync('hh-test-initdb-');
  try {
    const client = new PGlite();
    /* A dump asked for before it is ready never comes. */
    await client.waitReady;
    const dump = await client.dumpDataDir('none');
    await client.close();
    const file = join(dir, 'initdb.tar');
    writeFileSync(file, Buffer.from(await dump.arrayBuffer()));
    project.provide('initdbDataDir', file);
  } catch (error) {
    removeTempFolder(dir);
    throw error;
  }
  return () => removeTempFolder(dir);
}
