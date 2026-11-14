import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { migratedPgliteDump, readPgliteTemplate, type PgliteTemplateOptions } from './prepare-environment.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /* The dump of the migrated database every test database starts from. */
    migratedDataDir: string;
  }
}

export interface GlobalSetupOptions extends PgliteTemplateOptions {
  templatePath?: string;
}

/* A new PGlite runs initdb, about two seconds of a processor, and the migrations add half a second more. The run pays for
   that once, before any test file starts, and keeps the dump in a file the test databases open in a fraction of a second. */
async function writeMigratedCopy(file: string, options: GlobalSetupOptions): Promise<void> {
  try {
    const template = options.templatePath ?? process.env.HH_PGLITE_TEMPLATE;
    const dump = template ? readPgliteTemplate(template, options) : null;
    writeFileSync(file, dump ?? Buffer.from(await (options.dump ?? migratedPgliteDump)()));
  } catch (error) {
    rmSync(join(file, '..'), { recursive: true, force: true });
    throw error;
  }
}
export default async function setup(project: Pick<TestProject, 'provide'>, options: GlobalSetupOptions = {}): Promise<() => void> {
  const dir = mkdtempSync(join(tmpdir(), 'hh-test-db-'));
  const file = join(dir, 'migrated.tar');
  await writeMigratedCopy(file, options);
  project.provide('migratedDataDir', file);
  return () => rmSync(dir, { recursive: true, force: true });
}
