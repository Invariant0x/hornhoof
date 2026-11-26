import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
/* The machine's template (HH_PGLITE_TEMPLATE, .hornhoof/warm-services.json) keeps the dump of these migrations and its
   description, made once for every run of the machine: the run reads both in place. */
function inPlace(template: string, options: GlobalSetupOptions): { file: string; metadata: string } | null {
  const metadata = join(template, 'metadata.json');
  return existsSync(metadata) && readPgliteTemplate(template, options) ? { file: join(template, 'migrated.tar'), metadata } : null;
}

export default async function setup(project: Pick<TestProject, 'provide'>, options: GlobalSetupOptions = {}): Promise<() => void> {
  const template = options.templatePath ?? process.env.HH_PGLITE_TEMPLATE;
  const kept = template ? inPlace(template, options) : null;
  if (kept) {
    project.provide('migratedDataDir', kept.file);
    project.provide('databaseMetadataFile', kept.metadata);
    return () => {};
  }
  const dir = mkdtempSync(join(tmpdir(), 'hh-test-db-'));
  const file = join(dir, 'migrated.tar');
  const metadata = join(dir, 'metadata.json');
  await writeMigratedCopy(file, metadata, options);
  project.provide('migratedDataDir', file);
  project.provide('databaseMetadataFile', metadata);
  return () => rmSync(dir, { recursive: true, force: true });
}
