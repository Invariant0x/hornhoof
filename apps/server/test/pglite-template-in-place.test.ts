import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import setupInitdb from './global-initdb.js';
import setupMigrated from './global-setup.js';
import { preparePgliteTemplate } from './prepare-environment.js';

/* The machine keeps one PGlite template for each set of migrations (.hornhoof/warm-services.json, #2091), and every run
   reads it in place: no run migrates, describes or runs initdb for what the template holds, and none makes a folder of its
   own for it. A template that lacks a part, or is stale, is no template, and the run makes its own as CI does. */
const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function project() {
  const provided: Record<string, string> = {};
  return { provided, provide: (key: string, value: unknown) => { provided[key] = String(value); } };
}

async function template({ described = true, initdb = true } = {}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'hh-template-probe-'));
  made.push(dir);
  await preparePgliteTemplate(dir, { dump: () => Buffer.from('migrated'), pgliteVersion: 'probe' });
  if (described) writeFileSync(join(dir, 'metadata.json'), '{"described":true}');
  if (initdb) writeFileSync(join(dir, 'initdb.tar'), 'initdb');
  return dir;
}

const never = () => { throw new Error('The run made what the template holds.'); };

describe('the machine PGlite template is read in place', () => {
  it('gives the migrated dump and its description from the template, and makes nothing for the run', async () => {
    const dir = await template();
    const run = project();
    const done = await setupMigrated(run, { templatePath: dir, pgliteVersion: 'probe', dump: never, metadata: never });
    expect(run.provided).toEqual({ migratedDataDir: join(dir, 'migrated.tar'), databaseMetadataFile: join(dir, 'metadata.json') });
    done();
    expect(readFileSync(join(dir, 'migrated.tar'), 'utf8')).toBe('migrated');
  });

  it('makes the run its own copy from a template without the description, as one prepared for product runs is', async () => {
    const dir = await template({ described: false });
    const run = project();
    const done = await setupMigrated(run, { templatePath: dir, pgliteVersion: 'probe', dump: never, metadata: () => '{}' });
    const copy = run.provided.migratedDataDir!;
    expect(copy.startsWith(dir)).toBe(false);
    expect(readFileSync(copy, 'utf8')).toBe('migrated');
    done();
    expect(existsSync(copy)).toBe(false);
  });

  it('gives the initdb dump from a template of the same PGlite, and makes nothing for the run', async () => {
    const dir = await template();
    const run = project();
    const done = await setupInitdb(run, { templatePath: dir, pgliteVersion: 'probe', dump: never });
    expect(run.provided).toEqual({ initdbDataDir: join(dir, 'initdb.tar') });
    done();
    expect(readFileSync(join(dir, 'initdb.tar'), 'utf8')).toBe('initdb');
  });

  it('runs initdb for the run when the template was made by another PGlite', async () => {
    const dir = await template();
    const run = project();
    const done = await setupInitdb(run, { templatePath: dir, pgliteVersion: 'other', dump: async () => Buffer.from('fresh') });
    const own = run.provided.initdbDataDir!;
    expect(own.startsWith(dir)).toBe(false);
    expect(readFileSync(own, 'utf8')).toBe('fresh');
    done();
    expect(existsSync(own)).toBe(false);
  });
});
