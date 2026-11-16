import { deferred } from '../../../../test-support/deferred.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { onTestFinished } from 'vitest';
import { buildApp, type Ctx } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { encryptSecret } from '../../src/crypto/secrets.js';
import { agentRole, readerRole } from '../../src/db/agent-sql.js';
import { applyMissingMigrations, MIGRATIONS } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import { createRoute } from '../../src/modules/tasks/echelons-store.js';
import type { ToolJob } from '../../src/modules/tools/job.js';
import { listenIn } from '../../../../test-support/ports.mjs';
import { ENDLESS_LEASE } from '../prepare-environment.js';

type Cleanup = () => Promise<unknown>;
export type PgDb = NodePgDatabase<typeof schema>;
export type PostgresFixture = {
  name: string;
  url: string;
  db: PgDb;
  admin: pg.Pool;
  pool: (label: string) => pg.Pool;
  cleanup: (close: Cleanup) => void;
};
export type Actor = { ctx: Ctx; pool: pg.Pool; task: typeof schema.tasks.$inferSelect; job: ToolJob };
export const FIXTURE_COMMIT = 'b'.repeat(40);

function sourceUrl(): URL {
  if (process.env.TEST_DATABASE_URL) return new URL(process.env.TEST_DATABASE_URL);
  if (!process.env.PGHOST || !process.env.PGDATABASE) {
    throw new Error('Live PostgreSQL 17 is required: supply TEST_DATABASE_URL or PGHOST and PGDATABASE. No PGlite fallback is allowed.');
  }
  const url = new URL('postgresql://localhost');
  url.searchParams.set('host', process.env.PGHOST);
  url.username = process.env.PGUSER ?? userInfo().username;
  url.password = process.env.PGPASSWORD ?? '';
  url.port = process.env.PGPORT ?? '5432';
  url.pathname = `/${process.env.PGDATABASE}`;
  return url;
}

async function dispose(cleanups: Cleanup[]): Promise<void> {
  const errors: unknown[] = [];
  for (const close of cleanups.reverse()) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'PostgreSQL fixture cleanup failed');
}

function ownedPool(url: string, label: string, cleanups: Cleanup[]): pg.Pool {
  /* No limit of the client or the server ends a connection or a statement first: only the runner's limit for a test does. */
  const pool = new pg.Pool({ connectionString: url, application_name: label, max: 1, connectionTimeoutMillis: 2_147_483_647, statement_timeout: 2_147_483_647 });
  const errors: Error[] = [];
  pool.on('error', error => errors.push(error));
  cleanups.push(async () => {
    await pool.end();
    if (errors.length) throw new AggregateError(errors, `Unexpected PostgreSQL pool errors: ${label}`);
  });
  return pool;
}

async function requirePostgres17(pool: pg.Pool): Promise<void> {
  let version: string;
  try {
    version = (await pool.query<{ server_version_num: string }>('SHOW server_version_num')).rows[0]!.server_version_num;
  } catch {
    throw new Error('Live PostgreSQL 17 is required: the supplied test database is unavailable. No skip or PGlite fallback is allowed.');
  }
  if (Math.floor(Number(version) / 10000) !== 17) throw new Error(`Live PostgreSQL 17 is required; server_version_num was ${version}.`);
}

/* A migration holds a lock on each object it makes until it commits, some 3000 for the candidate's, and the cluster has room
   for a few thousand in all: six test files migrating at once on one part ran it out of shared memory. So the databases of
   one cluster migrate one at a time, each in its turn under a lock of the database every test file shares; the session
   that holds the turn gives it up as it ends, and a file waits for its turn with no deadline. A test database that needs
   the candidate's schema is a copy of a template migrated once (migratedTemplate), so only the tests of migrations
   themselves and that one template wait in the line. */
const TAKE_TURN = "SELECT pg_advisory_lock(hashtext('hornhoof: one test database migrates at a time'))";

export async function holdMigrationTurn(label: string): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: sourceUrl().toString(), application_name: label });
  const errors: Error[] = [];
  client.on('error', error => errors.push(error));
  await client.connect();
  try { await client.query(TAKE_TURN); } catch (error) { await client.end(); throw error; }
  return async () => {
    await client.end();
    if (errors.length) throw new AggregateError(errors, `The migration turn was lost: ${label}`);
  };
}

export async function migrateFolder(fixture: Pick<PostgresFixture, 'name' | 'db'>, migrationsFolder: string): Promise<void> {
  const release = await holdMigrationTurn(`${fixture.name}_migration`);
  try {
    await migrate(fixture.db, { migrationsFolder });
    await applyMissingMigrations(fixture.db, { migrationsFolder });
  } finally { await release(); }
}

export const migrateCandidate = (fixture: Pick<PostgresFixture, 'name' | 'db'>): Promise<void> => migrateFolder(fixture, MIGRATIONS);

/* The database the test databases of a cluster copy for these migrations: its name carries what they hold, so two candidates
   on one cluster keep their own. */
export const templateName = (migrationsFolder: string): string => `hh_tpl_${createHash('sha256')
  .update(JSON.stringify(readMigrationFiles({ migrationsFolder }).map(migration => [migration.hash, migration.folderMillis])))
  .digest('hex').slice(0, 24)}`;

const templateState = async (control: pg.Pool, name: string): Promise<'whole' | 'half' | 'none'> => {
  const [row] = (await control.query<{ whole: boolean }>('SELECT datistemplate AND NOT datallowconn AS whole FROM pg_database WHERE datname = $1', [name])).rows;
  return row ? (row.whole ? 'whole' : 'half') : 'none';
};

/* Migrated in the turn, then marked a template no session may connect to, which is what a copy needs of it. One a stopped run
   left half made, never marked, is made again; a whole one is copied at once, without the turn. */
export async function migratedTemplate(control: pg.Pool, migrationsFolder: string): Promise<string> {
  const name = templateName(migrationsFolder);
  if (await templateState(control, name) === 'whole') return name;
  const release = await holdMigrationTurn(`${name}_migration`);
  try {
    const state = await templateState(control, name);
    if (state === 'whole') return name;
    if (state === 'half') {
      await control.query(`ALTER DATABASE "${name}" WITH IS_TEMPLATE false`);
      await control.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    }
    await control.query(`CREATE DATABASE "${name}"`);
    const url = sourceUrl();
    url.pathname = `/${name}`;
    const cleanups: Cleanup[] = [];
    try {
      const db = drizzle(ownedPool(url.toString(), `${name}_migration`, cleanups), { schema });
      await migrate(db, { migrationsFolder });
      await applyMissingMigrations(db, { migrationsFolder });
    } finally { await dispose(cleanups); }
    await control.query(`ALTER DATABASE "${name}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
    return name;
  } finally { await release(); }
}

/* Every test owns a new database, including grants and migration history: a copy of the template of its migrations, the
   candidate's unless it names others, or an empty one. The supplied database is never reset. */
export async function privatePostgres(options: { migrate?: boolean; migrations?: string } = {}): Promise<PostgresFixture> {
  const source = sourceUrl();
  const cleanups: Cleanup[] = [];
  onTestFinished(() => dispose(cleanups));
  const name = `hh_pg_${randomBytes(12).toString('hex')}`;
  const control = ownedPool(source.toString(), `${name}_control`, cleanups);
  await requirePostgres17(control);
  const migrated = options.migrate !== false;
  const template = migrated ? ` TEMPLATE "${await migratedTemplate(control, options.migrations ?? MIGRATIONS)}"` : '';
  await control.query(`CREATE DATABASE "${name}"${template}`);
  cleanups.push(async () => {
    await control.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await control.query(`DROP ROLE IF EXISTS "${agentRole(name)}", "${readerRole(name)}"`);
  });
  const url = new URL(source);
  url.pathname = `/${name}`;
  const pool = (label: string) => ownedPool(url.toString(), `${name}_${label}`, cleanups);
  const admin = pool('admin');
  const db = drizzle(admin, { schema });
  const fixture: PostgresFixture = { name, url: url.toString(), db, admin, pool, cleanup: close => { cleanups.push(close); } };
  /* The lease every PGlite test database holds too (prepare-environment.ts): agent SQL writes only under one. Other
     migrations may not have its table yet. */
  if (migrated && !options.migrations) await admin.query(ENDLESS_LEASE);
  return fixture;
}

export async function backendPid(pool: pg.Pool): Promise<number> {
  return (await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
}

function advertisement(): Buffer {
  const packet = (text: string) => `${(Buffer.byteLength(text) + 4).toString(16).padStart(4, '0')}${text}`;
  return Buffer.from(packet('# service=git-upload-pack\n') + '0000' + packet(`${FIXTURE_COMMIT} refs/heads/release-1\0multi_ack\n`) + packet(`${FIXTURE_COMMIT} refs/heads/release-2\n`) + '0000');
}

/* A real authorized Git refs endpoint is the barrier immediately before startRun enters its numbering transaction. */
async function localRepository(fixture: PostgresFixture, held: boolean) {
  const token = randomBytes(24).toString('hex');
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  const waiting: ServerResponse[] = [];
  const arrived = deferred();
  let released = !held;
  let requests = 0;
  const send = (response: ServerResponse) => {
    response.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
    response.end(advertisement());
  };
  const release = () => { released = true; waiting.splice(0).forEach(send); };
  const server = createServer((request, response) => {
    if (request.headers.authorization !== authorization || request.url !== '/fixture.git/info/refs?service=git-upload-pack') {
      response.writeHead(401).end();
      return;
    }
    requests++;
    if (requests === 2) arrived.resolve();
    if (released) send(response);
    else waiting.push(response);
  });
  await listenIn(server);
  fixture.cleanup(async () => {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/fixture.git`, token, ready: arrived.promise, release, requests: () => requests };
}

export async function appContext(fixture: PostgresFixture, label: string, secret: string, env: NodeJS.ProcessEnv): Promise<{ ctx: Ctx; pool: pg.Pool }> {
  const folder = await mkdtemp(join(tmpdir(), 'hh-pg-app-'));
  fixture.cleanup(() => rm(folder, { recursive: true, force: true }));
  const config = loadConfig({ HORNHOOF_SECRET: secret, UPDATE_CHECK_MS: '0', HORNHOOF_CONTROL_DIR: folder, WEB_DIST: join(folder, 'web'), ...env });
  const pool = fixture.pool(label);
  const app = await buildApp({ db: drizzle(pool, { schema }), config });
  fixture.cleanup(() => app.close());
  await app.ready();
  return { ctx: app.ctx, pool };
}

async function seedActor(fixture: PostgresFixture, context: { ctx: Ctx; pool: pg.Pool }, companyId: string, departmentId: string, subscriptionId: string, number: number): Promise<Actor> {
  const [agent] = await fixture.db.insert(schema.agents).values({ companyId, departmentId, subscriptionId, kind: 'worker', name: `Worker ${number}`, model: '', roleKey: 'DEV-BE' }).returning();
  const [task] = await fixture.db.insert(schema.tasks).values({ companyId, departmentId, number, title: `PostgreSQL task ${number}`, status: 'working', assigneeAgentId: agent!.id, executorAgentId: agent!.id }).returning();
  /* Every executable task has its required route, as createTask gives it. */
  await context.ctx.db.transaction(tx => createRoute(tx, task!, { paths: ['**'] }, context.ctx.templates.stagesOf('development')));
  const [job] = await fixture.db.insert(schema.jobs).values({ companyId, subscriptionId, agentId: agent!.id, taskId: task!.id, kind: 'conversation', prompt: 'Check PostgreSQL', timeoutMs: 900000, status: 'running' }).returning();
  return { ...context, task: task!, job: { id: job!.id, companyId, agentId: agent!.id, agentKind: 'worker', roleKey: 'DEV-BE', departmentId, skills: [] } };
}

export async function runFixture(fixture: PostgresFixture, options: { barrier?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<{ companyId: string; departmentId: string; actors: [Actor, Actor]; repository: Awaited<ReturnType<typeof localRepository>> }> {
  const repository = await localRepository(fixture, options.barrier === true);
  /* Ready the real apps before inserting a company, so setup restoration has no queued turns to start. */
  const secret = randomBytes(32).toString('base64');
  const first = await appContext(fixture, 'actor_a', secret, options.env ?? {});
  const second = await appContext(fixture, 'actor_b', secret, options.env ?? {});
  const [company] = await fixture.db.insert(schema.companies).values({ name: 'PostgreSQL fixture' }).returning();
  const companyId = company!.id;
  const [person] = await fixture.db.insert(schema.people).values({ companyId, name: 'Fixture owner', email: 'postgres-fixture@example.test', status: 'active', scopeKind: 'company', isOwner: true }).returning();
  const [subscription] = await fixture.db.insert(schema.subscriptions).values({ companyId, ownerPersonId: person!.id, provider: 'anthropic_api', kind: 'api_key', label: 'Fixture plan', status: 'ready' }).returning();
  const [department] = await fixture.db.insert(schema.departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: repository.url, repoTokenEnc: encryptSecret(repository.token, first.ctx.config.secret) }).returning();
  const actors: [Actor, Actor] = [await seedActor(fixture, first, companyId, department!.id, subscription!.id, 1), await seedActor(fixture, second, companyId, department!.id, subscription!.id, 2)];
  return { companyId, departmentId: department!.id, actors, repository };
}
