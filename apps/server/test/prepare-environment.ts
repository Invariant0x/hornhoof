import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as pgliteDb } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as postgresDb } from 'drizzle-orm/node-postgres';
import { migrate as migratePostgres } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { applyMissingMigrations, MIGRATIONS } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';

const FORMAT = 'hornhoof-pglite-v1';
const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
interface TemplateMetadata { format: string; pgliteVersion: string; inputDigest: string; dumpDigest: string; inputs: Record<string, string> }
function sha(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex'); }
function pgliteVersion(): string {
  const manifest = join(dirname(require.resolve('@electric-sql/pglite')), '../package.json');
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version;
}
function inputPaths(): string[] {
  const migrations = readdirSync(MIGRATIONS).filter(name => name.endsWith('.sql')).map(name => `apps/server/drizzle/${name}`);
  return [...migrations, 'apps/server/drizzle/meta/_journal.json', 'apps/server/src/db/schema.ts', 'apps/server/src/db/client.ts',
    'apps/server/test/prepare-environment.ts', 'apps/server/test/global-setup.ts', 'apps/server/package.json', 'package-lock.json'].sort();
}
function inputs(): Record<string, string> {
  return Object.fromEntries(inputPaths().map(path => [path, sha(readFileSync(join(ROOT, path)))]));
}
export async function migratedPgliteDump(): Promise<Buffer> {
  const client = new PGlite();
  try {
    const db = pgliteDb(client, { schema });
    await migratePglite(db, { migrationsFolder: MIGRATIONS });
    await applyMissingMigrations(db, { migrationsFolder: MIGRATIONS });
    return Buffer.from(await (await client.dumpDataDir('none')).arrayBuffer());
  } finally { await client.close(); }
}
export async function preparePgliteTemplate(output: string): Promise<void> {
  const source = inputs();
  const dump = await migratedPgliteDump();
  const metadata: TemplateMetadata = { format: FORMAT, pgliteVersion: pgliteVersion(), inputDigest: sha(JSON.stringify(source)), dumpDigest: sha(dump), inputs: source };
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'migrated.tar'), dump);
  writeFileSync(join(output, 'READY.json'), JSON.stringify(metadata));
}
/* A caller's invalid or stale artifact has exactly the same behavior as no optional artifact. */
export function readPgliteTemplate(path: string): Buffer | null {
  try {
    const metadata = JSON.parse(readFileSync(join(path, 'READY.json'), 'utf8')) as TemplateMetadata;
    if (metadata.format !== FORMAT || metadata.pgliteVersion !== pgliteVersion()) return null;
    const source = inputs();
    if (metadata.inputDigest !== sha(JSON.stringify(source)) || JSON.stringify(metadata.inputs) !== JSON.stringify(source)) return null;
    const dump = readFileSync(join(path, 'migrated.tar'));
    return metadata.dumpDigest === sha(dump) ? dump : null;
  } catch { return null; }
}
async function preparePostgres(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('PostgreSQL preparation requires the generated DATABASE_URL');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await pool.query<{ server_version_num: string }>('SHOW server_version_num');
    if (Math.floor(Number(result.rows[0]?.server_version_num) / 10000) !== 17) throw new Error('PostgreSQL 17 is required');
    const db = postgresDb(pool, { schema });
    await migratePostgres(db, { migrationsFolder: MIGRATIONS });
    await applyMissingMigrations(db, { migrationsFolder: MIGRATIONS });
  } finally { await pool.end(); }
}
async function main(): Promise<void> {
  if (process.argv[2] === '--postgres') return preparePostgres();
  if (process.argv[2] !== '--output' || !process.argv[3]) throw new Error('Usage: prepare-environment.ts --output PATH | --postgres');
  await preparePgliteTemplate(resolve(process.argv[3]));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
