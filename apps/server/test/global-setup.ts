import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { migratedPgliteDump, readPgliteTemplate } from './prepare-environment.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /* The dump of the migrated database every test database starts from. */
    migratedDataDir: string;
  }
}

/* A new PGlite runs initdb, about two seconds of a processor, and the migrations add half a second more. The run pays for
   that once, before any test file starts, and keeps the dump in a file the test databases open in a fraction of a second. */
async function writeMigratedCopy(file: string): Promise<void> {
  try {
    const template = process.env.HH_PGLITE_TEMPLATE;
    const dump = template ? readPgliteTemplate(template) : null;
    writeFileSync(file, dump ?? await migratedPgliteDump());
  } catch (error) {
    rmSync(join(file, '..'), { recursive: true, force: true });
    throw error;
  }
}
export default async function setup(project: TestProject): Promise<() => void> {
  const dir = mkdtempSync(join(tmpdir(), 'hh-test-db-'));
  const file = join(dir, 'migrated.tar');
  await writeMigratedCopy(file);
  project.provide('migratedDataDir', file);
  return () => rmSync(dir, { recursive: true, force: true });
}
