import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as pgliteDb } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as postgresDb } from 'drizzle-orm/node-postgres';
import { migrate as migratePostgres } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { agentRole, grantsFor, readerGrantsFor, readerRole } from '../src/db/agent-sql.js';
import { applyMissingMigrations, MIGRATIONS } from '../src/db/client.js';
import { AFTER_MIGRATIONS } from '../src/db/net.js';
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
function protocolInputPaths(): string[] {
  const directory = 'packages/protocol/dist';
  const entries = existsSync(join(ROOT, directory)) ? readdirSync(join(ROOT, directory), { recursive: true, withFileTypes: true }) : [];
  const paths = entries.filter(entry => entry.isFile()).map(entry => relative(ROOT, join(entry.parentPath, entry.name)).split(sep).join('/'));
  if (!paths.length) throw new Error(`Missing required generated protocol artifact: ${directory}. Run runtime-build first.`);
  return paths;
}
function inputPaths(): string[] {
  const migrations = readdirSync(MIGRATIONS).filter(name => name.endsWith('.sql')).map(name => `apps/server/drizzle/${name}`);
  return [...migrations, ...protocolInputPaths(), 'apps/server/drizzle/meta/_journal.json', 'apps/server/src/db/schema.ts', 'apps/server/src/db/client.ts',
    'apps/server/src/db/agent-sql.ts', 'apps/server/test/prepare-environment.ts', 'apps/server/test/global-setup.ts', 'apps/server/package.json', 'package-lock.json'].sort();
}
function inputs(): Record<string, string> {
  return Object.fromEntries(inputPaths().map(path => [path, sha(readFileSync(join(ROOT, path)))]));
}
/* Every test database holds this lease and says it is fenced (helpers.ts), so the whole suite runs under fence 1. */
const ENDLESS_LEASE = `
  INSERT INTO net_local.state (term_number, term_machine, machine, cluster)
    SELECT 1, 'test', 'test', system_identifier::text FROM pg_control_system();
  INSERT INTO net_local.lease (term_number, term_machine, kind, until, sync) VALUES (1, 'test', 'normal', 'infinity', 'alone');`;

export async function migratedPgliteDump(): Promise<Buffer> {
  const client = new PGlite();
  try {
    const db = pgliteDb(client, { schema });
    await migratePglite(db, { migrationsFolder: MIGRATIONS });
    await applyMissingMigrations(db, { migrationsFolder: MIGRATIONS });
    await client.exec(AFTER_MIGRATIONS);
    await client.exec(ENDLESS_LEASE);
    /* The roles of agent SQL with their rights, as a server makes them as it starts: a test that runs agent SQL then
       changes nothing beyond rows of the database its file shares. */
    await client.exec(`${grantsFor(agentRole('postgres'))};\n${readerGrantsFor(readerRole('postgres'))}`);
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
