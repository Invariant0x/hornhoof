import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FORMAT = 'hornhoof-pglite-v1';
const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
interface TemplateMetadata { format: string; pgliteVersion: string; inputDigest: string; dumpDigest: string; inputs: Record<string, string> }
export interface PgliteTemplateOptions { root?: string; pgliteVersion?: string; dump?: () => Promise<Buffer> | Buffer }
function sha(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex'); }
function pgliteVersion(): string {
  const manifest = join(dirname(require.resolve('@electric-sql/pglite')), '../package.json');
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version;
}
function protocolInputPaths(root: string): string[] {
  const directory = 'packages/protocol/dist';
  const entries = existsSync(join(root, directory)) ? readdirSync(join(root, directory), { recursive: true, withFileTypes: true }) : [];
  const paths = entries.filter(entry => entry.isFile()).map(entry => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'));
  if (!paths.length) throw new Error(`Missing required generated protocol artifact: ${directory}. Run runtime-build first.`);
  return paths;
}
function inputPaths(root: string): string[] {
  const migrations = readdirSync(join(root, 'apps/server/drizzle')).filter(name => name.endsWith('.sql')).map(name => `apps/server/drizzle/${name}`);
  return [...migrations, ...protocolInputPaths(root), 'apps/server/drizzle/meta/_journal.json', 'apps/server/src/db/schema.ts', 'apps/server/src/db/client.ts',
    'apps/server/src/db/agent-sql.ts', 'apps/server/test/prepare-environment.ts', 'apps/server/test/global-setup.ts', 'apps/server/package.json', 'package-lock.json'].sort();
}
function inputs(root: string): Record<string, string> {
  return Object.fromEntries(inputPaths(root).map(path => [path, sha(readFileSync(join(root, path)))]));
}
/* Every test database holds this lease and says it is fenced (helpers.ts), so the whole suite runs under fence 1. */
export const ENDLESS_LEASE = `
  INSERT INTO net_local.state (term_number, term_machine, machine, cluster)
    SELECT 1, 'test', 'test', system_identifier::text FROM pg_control_system();
  INSERT INTO net_local.lease (term_number, term_machine, kind, until, sync) VALUES (1, 'test', 'normal', 'infinity', 'alone');`;

export async function migratedPgliteDump(): Promise<Buffer> {
  const [
    { PGlite },
    { drizzle: pgliteDb },
    { migrate: migratePglite },
    { readerGrantsFor, readerRole },
    { applyMissingMigrations, MIGRATIONS },
    { AFTER_MIGRATIONS },
    schema,
  ] = await Promise.all([
    import('@electric-sql/pglite'),
    import('drizzle-orm/pglite'),
    import('drizzle-orm/pglite/migrator'),
    import('../src/db/agent-sql.js'),
    import('../src/db/client.js'),
    import('../src/db/net.js'),
    import('../src/db/schema.js'),
  ]);
  const client = new PGlite();
  try {
    const db = pgliteDb(client, { schema });
    await migratePglite(db, { migrationsFolder: MIGRATIONS });
    await applyMissingMigrations(db, { migrationsFolder: MIGRATIONS });
    await client.exec(AFTER_MIGRATIONS);
    await client.exec(ENDLESS_LEASE);
    /* Operations' role with its rights, as a server makes it as it starts. */
    await client.exec(readerGrantsFor(readerRole('postgres')));
    return Buffer.from(await (await client.dumpDataDir('none')).arrayBuffer());
  } finally { await client.close(); }
}
export async function preparePgliteTemplate(output: string, options: PgliteTemplateOptions = {}): Promise<void> {
  const source = inputs(options.root ?? ROOT);
  const dump = Buffer.from(await (options.dump ?? migratedPgliteDump)());
  const metadata: TemplateMetadata = {
    format: FORMAT,
    pgliteVersion: options.pgliteVersion ?? pgliteVersion(),
    inputDigest: sha(JSON.stringify(source)),
    dumpDigest: sha(dump),
    inputs: source,
  };
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'migrated.tar'), dump);
  writeFileSync(join(output, 'READY.json'), JSON.stringify(metadata));
}
/* A caller's invalid or stale artifact has exactly the same behavior as no optional artifact. */
export function readPgliteTemplate(path: string, options: Omit<PgliteTemplateOptions, 'dump'> = {}): Buffer | null {
  try {
    const metadata = JSON.parse(readFileSync(join(path, 'READY.json'), 'utf8')) as TemplateMetadata;
    if (metadata.format !== FORMAT || metadata.pgliteVersion !== (options.pgliteVersion ?? pgliteVersion())) return null;
    const source = inputs(options.root ?? ROOT);
    if (metadata.inputDigest !== sha(JSON.stringify(source)) || JSON.stringify(metadata.inputs) !== JSON.stringify(source)) return null;
    const dump = readFileSync(join(path, 'migrated.tar'));
    return metadata.dumpDigest === sha(dump) ? dump : null;
  } catch { return null; }
}
/* The initdb dump a machine's template keeps beside the migrated one (warm/pglite-build.ts) depends only on the PGlite that
   made it. */
export function templateInitdb(path: string, options: Pick<PgliteTemplateOptions, 'pgliteVersion'> = {}): string | null {
  try {
    const metadata = JSON.parse(readFileSync(join(path, 'READY.json'), 'utf8')) as TemplateMetadata;
    const file = join(path, 'initdb.tar');
    return metadata.format === FORMAT && metadata.pgliteVersion === (options.pgliteVersion ?? pgliteVersion()) && existsSync(file) ? file : null;
  } catch { return null; }
}
async function preparePostgres(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('PostgreSQL preparation requires the generated DATABASE_URL');
  const [
    { drizzle: postgresDb },
    { migrate: migratePostgres },
    { default: pg },
    { applyMissingMigrations, MIGRATIONS },
    schema,
  ] = await Promise.all([
    import('drizzle-orm/node-postgres'),
    import('drizzle-orm/node-postgres/migrator'),
    import('pg'),
    import('../src/db/client.js'),
    import('../src/db/schema.js'),
  ]);
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
