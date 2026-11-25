import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { TestProject } from 'vitest/node';
import { templateInitdb } from './prepare-environment.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /* The dump of a database just made by initdb, which every fresh database of a migration test opens (freshPglite). */
    initdbDataDir: string;
  }
}

export interface InitdbSetupOptions { templatePath?: string; pgliteVersion?: string; dump?: () => Promise<Buffer> | Buffer }

export async function initdbDump(): Promise<Buffer> {
  const client = new PGlite();
  try {
    /* A dump asked for before it is ready never comes. */
    await client.waitReady;
    return Buffer.from(await (await client.dumpDataDir('none')).arrayBuffer());
  } finally { await client.close(); }
}

/* initdb costs a processor several times what opening its dump does. The run pays for it once, before any test file
   starts, instead of the first test of each migration file paying for it within its own time; with the machine's template
   (HH_PGLITE_TEMPLATE) of the same PGlite it pays nothing and reads the template's dump in place. */
export default async function setup(project: Pick<TestProject, 'provide'>, options: InitdbSetupOptions = {}): Promise<() => void> {
  const template = options.templatePath ?? process.env.HH_PGLITE_TEMPLATE;
  const kept = template ? templateInitdb(template, options) : null;
  if (kept) {
    project.provide('initdbDataDir', kept);
    return () => {};
  }
  const dir = mkdtempSync(join(tmpdir(), 'hh-test-initdb-'));
  try {
    const file = join(dir, 'initdb.tar');
    writeFileSync(file, await (options.dump ?? initdbDump)());
    project.provide('initdbDataDir', file);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return () => rmSync(dir, { recursive: true, force: true });
}
