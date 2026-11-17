import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { migratedPgliteDump, readPgliteTemplate, type PgliteTemplateOptions } from './prepare-environment.js';
import { databaseMetadata, encodeDatabaseMetadata } from './helpers-db-metadata.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /* The dump of the migrated database every test database starts from. */
    migratedDataDir: string;
    /* Catalog, planner and seed description of that exact dump, prepared outside individual test cases. */
    databaseMetadataFile: string;
  }
}

export interface GlobalSetupOptions extends PgliteTemplateOptions {
  templatePath?: string;
  metadata?: (dump: Buffer) => Promise<string> | string;
}

async function metadataOf(dump: Buffer): Promise<string> {
  const { PGlite } = await import('@electric-sql/pglite');
  const client = new PGlite({ loadDataDir: new Blob([dump]) });
  try {
    await client.waitReady;
    return await encodeDatabaseMetadata(await databaseMetadata(client), dump);
  } finally {
    await client.close();
  }
}

/* A new PGlite runs initdb, about two seconds of a processor, and the migrations add half a second more. The run pays for
   that once, before any test file starts, and keeps the dump in a file the test databases open in a fraction of a second. */
async function writeMigratedCopy(file: string, metadata: string, options: GlobalSetupOptions): Promise<void> {
  try {
    const template = options.templatePath ?? process.env.HH_PGLITE_TEMPLATE;
    const dump = template ? readPgliteTemplate(template, options) : null;
    const bytes = dump ?? Buffer.from(await (options.dump ?? migratedPgliteDump)());
    writeFileSync(file, bytes);
    writeFileSync(metadata, await (options.metadata ?? metadataOf)(bytes));
  } catch (error) {
    rmSync(join(file, '..'), { recursive: true, force: true });
    throw error;
  }
}
export default async function setup(project: Pick<TestProject, 'provide'>, options: GlobalSetupOptions = {}): Promise<() => void> {
  const dir = mkdtempSync(join(tmpdir(), 'hh-test-db-'));
  const file = join(dir, 'migrated.tar');
  const metadata = join(dir, 'metadata.json');
  await writeMigratedCopy(file, metadata, options);
  project.provide('migratedDataDir', file);
  project.provide('databaseMetadataFile', metadata);
  return () => rmSync(dir, { recursive: true, force: true });
}
