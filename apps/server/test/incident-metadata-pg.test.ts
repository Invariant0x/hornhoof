import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { asc, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, type Db } from '../src/db/client.js';
import { agents, companies, jobs, people, subscriptions, tasks } from '../src/db/schema.js';
import { createIncidentMetadataOperation, type IncidentMetadataResult, type ProtectedInstallation } from '../src/modules/installation/incident-metadata-entrypoint.js';
import { TEST_SECRET, as, setUpCompany } from './helpers.js';

const execute = promisify(execFile);
const pgRoot = process.env.TASK79_PG_ROOT;
const describePg = pgRoot ? describe : describe.skip;
const TASK_ID = '25256ddc-66ce-4a4d-9198-093fc4ca4fd6';
const AGENT_ID = '7f038470-9455-432f-a113-0d7f72bd87cd';
const ENV = {
  HORNHOOF_SECRET: TEST_SECRET,
  UPDATE_CHECK_MS: '0',
  HORNHOOF_COMMIT: 'task79-pg-fixture-commit',
  HORNHOOF_IMAGE: 'fixture/task79-pg',
  HORNHOOF_CONTROL_DIR: '/fixture/task79-pg-control',
};

const bundleSha256 = (): string => {
  const hash = createHash('sha256');
  for (const name of ['incident-metadata-entrypoint.ts', 'incident-metadata.ts']) {
    hash.update(readFileSync(fileURLToPath(new URL(`../src/modules/installation/${name}`, import.meta.url))));
    hash.update([0]);
  }
  return hash.digest('hex');
};

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  return port;
};

async function stopPostgres(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGINT');
  await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && !child.signalCode) {
    child.kill('SIGKILL');
    await exited;
  }
}

describePg('real PostgreSQL incident metadata pool qualification', () => {
  let run = '';
  let child: ChildProcess;
  let databaseUrl = '';
  let app: Awaited<ReturnType<typeof buildApp>>;
  let db: Db;
  let invoke: () => Promise<IncidentMetadataResult>;
  let ceo = '';
  let targetRows: Record<string, string> = {};

  beforeAll(async () => {
    const bin = join(pgRoot!, 'usr/lib/postgresql/17/bin');
    const version = await execute(join(bin, 'postgres'), ['--version']);
    expect(version.stdout).toContain('17.11');
    run = mkdtempSync(join(tmpdir(), 'task79-pg-'));
    const data = join(run, 'data');
    await execute(join(bin, 'initdb'), ['-D', data, '-A', 'trust', '-U', 'task79', '--no-locale', '-E', 'UTF8']);
    const port = await freePort();
    databaseUrl = `postgres://task79@127.0.0.1:${port}/postgres`;
    child = spawn(join(bin, 'postgres'), ['-D', data, '-p', String(port), '-c', 'listen_addresses=127.0.0.1', '-c', 'shared_buffers=32MB', '-c', 'max_connections=40', '-c', 'fsync=off'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let postgresLog = '';
    child.stderr!.on('data', chunk => {
      postgresLog += String(chunk);
    });
    for (let attempt = 0; ; attempt += 1) {
      try {
        await execute(join(bin, 'pg_isready'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'task79']);
        break;
      } catch (error) {
        if (attempt >= 50) {
          await stopPostgres(child);
          throw new Error(`PostgreSQL fixture did not start: ${postgresLog}`, { cause: error });
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    db = await createDb(databaseUrl);
    const env = { ...ENV, DATABASE_URL: databaseUrl };
    const config = loadConfig(env);
    app = await buildApp({ db, config });
    let operation: ReturnType<typeof createIncidentMetadataOperation>;
    app.get('/__task79_pg_incident_metadata', async req => operation.invoke(req));
    ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [subscription] = await db.select().from(subscriptions);
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    await db.insert(tasks).values({ id: TASK_ID, companyId: company!.id, number: 29, title: 'Incident' });
    await db.insert(agents).values({ id: AGENT_ID, companyId: company!.id, kind: 'worker', name: 'Incident target', roleKey: 'DEV-BE', model: '', subscriptionId: subscription!.id });
    const installation: ProtectedInstallation = {
      companyId: company!.id,
      commit: config.commit,
      image: config.image,
      controlDir: config.controlDir,
      approvedBundleSha256: bundleSha256(),
    };
    operation = createIncidentMetadataOperation(app.ctx, installation, env);
    invoke = async () => (await app.inject({ method: 'GET', url: '/__task79_pg_incident_metadata', ...as(ceo) })).json() as IncidentMetadataResult;
    const common = { companyId: company!.id, subscriptionId: subscription!.id, agentId: AGENT_ID, timeoutMs: 1000 };
    const definitions = [
      { key: 'predecessor', kind: 'conversation' as const, prompt: 'predecessor prompt', status: 'done' as const, createdAt: new Date('2026-11-01T00:15:00Z'), startedAt: new Date('2026-11-01T00:15:01Z'), finishedAt: new Date('2026-11-01T00:16:59Z') },
      { key: 'started', kind: 'test' as const, prompt: 'started only', status: 'running' as const, createdAt: new Date('2026-11-01T00:16:00Z'), startedAt: new Date('2026-11-01T00:18:00Z'), finishedAt: null },
      { key: 'finished', kind: 'conversation' as const, prompt: '', status: 'done' as const, createdAt: new Date('2026-11-01T00:16:30Z'), startedAt: null, finishedAt: new Date('2026-11-01T00:19:00Z') },
      { key: 'emptyTest', kind: 'test' as const, prompt: '', status: 'queued' as const, createdAt: new Date('2026-11-01T00:20:00Z'), startedAt: null, finishedAt: null },
      { key: 'unicode', kind: 'conversation' as const, prompt: 'A😀ё', status: 'running' as const, createdAt: new Date('2026-11-01T00:21:00Z'), startedAt: null, finishedAt: null, createdBy: owner!.id, result: 'hidden result canary', tail: 'hidden tail canary' },
    ];
    for (const { key, ...values } of definitions) {
      const [row] = await db.insert(jobs).values({ ...common, ...values }).returning({ id: jobs.id });
      targetRows[key] = row!.id;
    }
    await db.execute(sql`update jobs set started_at = '2026-11-01T00:18:00.123456Z'::timestamptz where id = ${targetRows.started}`);
    await db.execute(sql`update jobs set finished_at = '2026-11-01T00:19:00.654321Z'::timestamptz where id = ${targetRows.finished}`);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await (db?.$client as pg.Pool | undefined)?.end();
    if (child) await stopPostgres(child);
    if (run) rmSync(run, { recursive: true, force: true });
  });

  it('uses the reviewed SQL with independent timestamps, UTC microseconds and exact metadata', async () => {
    const before = await db.select().from(jobs).orderBy(asc(jobs.id));
    const result = await invoke();
    expect(result).toMatchObject({ complete: true });
    if (!('jobs' in result)) throw new Error('Expected metadata');
    expect(result.jobs.map(row => row.id)).toEqual([targetRows.predecessor, targetRows.started, targetRows.finished, targetRows.emptyTest, targetRows.unicode]);
    expect(result.jobs.map(row => Object.keys(row).sort())).toEqual(result.jobs.map(() => ['created_at', 'created_by', 'empty_start', 'error', 'finished_at', 'id', 'instructions_hash', 'kind', 'predecessor_before_window', 'prompt_characters', 'prompt_md5', 'recovery_prefix', 'session_id', 'started_at', 'status', 'subscription_id', 'task_id']));
    expect(result.jobs[0]).toMatchObject({ predecessor_before_window: true, created_at: '2026-11-01T00:15:00.000000Z' });
    expect(result.jobs[1]).toMatchObject({ started_at: '2026-11-01T00:18:00.123456Z', finished_at: null, predecessor_before_window: false });
    expect(result.jobs[2]).toMatchObject({ finished_at: '2026-11-01T00:19:00.654321Z', started_at: null, empty_start: true });
    expect(result.jobs[3]).toMatchObject({ kind: 'test', empty_start: false });
    expect(result.jobs[4]).toMatchObject({ prompt_characters: 3, prompt_md5: createHash('md5').update('A😀ё').digest('hex') });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('predecessor prompt');
    expect(serialized).not.toContain('started only');
    expect(serialized).not.toContain('A😀ё');
    expect(serialized).not.toContain('hidden result canary');
    expect(serialized).not.toContain('hidden tail canary');
    expect(await db.select().from(jobs).orderBy(asc(jobs.id))).toEqual(before);
  });

  it('rolls back and closes the real diagnostic pool after permission and lock-timeout failures', async () => {
    const connect = vi.spyOn(pg.Pool.prototype, 'connect');
    const end = vi.spyOn(pg.Pool.prototype, 'end');
    await db.execute(sql`alter table jobs enable row level security`);
    await db.execute(sql`alter table jobs force row level security`);
    expect(await invoke()).toEqual({ error: { code: 'unavailable', message: 'Incident metadata is temporarily unavailable.' } });
    await db.execute(sql`alter table jobs no force row level security`);
    await db.execute(sql`alter table jobs disable row level security`);
    expect(await invoke()).toMatchObject({ complete: true });

    const blocker = new pg.Client({ connectionString: databaseUrl });
    await blocker.connect();
    await blocker.query('begin');
    await blocker.query('lock table jobs in access exclusive mode');
    try {
      expect(await invoke()).toEqual({ error: { code: 'unavailable', message: 'Incident metadata is temporarily unavailable.' } });
    } finally {
      await blocker.query('rollback');
      await blocker.end();
    }
    expect(await invoke()).toMatchObject({ complete: true });
    expect(connect).toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(4);
    const statements = connect.mock.results.map(result => result.value as Promise<pg.PoolClient>);
    expect(statements.length).toBeGreaterThan(0);
    connect.mockRestore();
    end.mockRestore();
  }, 30_000);
});
