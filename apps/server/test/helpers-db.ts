import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, PglitePreparedQuery, type PgliteDatabase } from 'drizzle-orm/pglite';
import { afterAll, inject, onTestFailed, onTestFinished, TestRunner, vi } from 'vitest';
import * as schema from '../src/db/schema.js';

type TestDb = PgliteDatabase<typeof schema> & { $client: PGlite };
type Shared = { client: PGlite; truncate: string; shape: string };

/* Every test database starts from a copy of the one global-setup.ts migrated for the run. */
let migrated: Blob | undefined;
let opened = 0;

function copyOfMigrated(): PGlite {
  migrated ??= new Blob([readFileSync(inject('migratedDataDir'))]);
  opened += 1;
  return new PGlite({ loadDataDir: migrated });
}

export const databasesOpened = () => opened;

/* An unmigrated database, as new PGlite() gives, from a dump of one initdb, which costs several times as much. */
let initdb: File | Blob | undefined;
export async function freshPglite(): Promise<PGlite> {
  if (!initdb) {
    const first = new PGlite();
    /* A dump asked for before it is ready never comes. */
    await first.waitReady;
    initdb = await first.dumpDataDir('none');
    await first.close();
  }
  return new PGlite({ loadDataDir: initdb });
}

/* Opening a copy costs far more than emptying one, so the tests of a file share one, emptied before each of them. A file
   whose tests change more than rows says so at its top with this, and each call in it opens a copy of its own, closed
   when its test ends. Lint asks for this where it sees DDL. */
let ownEach = false;
export function ownDatabases(): void {
  ownEach = true;
}

/* All that a truncate leaves as it was and a test can change. Rows of pg_class and the like hold more, but that more moves
   with every truncate. */
const SHAPE = `select md5(string_agg(line, E'\n' order by line)) as shape from (
  select format('relation %s %s %s %s', c.oid::regclass, c.relkind, c.relacl, c.relrowsecurity) as line
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
  union all select format('column %s %s %s %s %s %s', a.attrelid::regclass, a.attname, a.atttypid, a.attnotnull, a.attacl, pg_get_expr(d.adbin, d.adrelid))
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attnum > 0 and not a.attisdropped and n.nspname = 'public'
  union all select format('constraint %s %s %s', c.conrelid::regclass, c.conname, pg_get_constraintdef(c.oid))
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public'
  union all select format('index %s', indexdef) from pg_indexes where schemaname = 'public'
  union all select format('trigger %s %s %s', t.tgrelid::regclass, t.tgname, t.tgenabled) from pg_trigger t where not t.tgisinternal
  union all select format('policy %s %s', p.polrelid::regclass, p.polname) from pg_policy p
  union all select format('function %s %s %s', p.oid::regprocedure, md5(p.prosrc), p.proacl)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
  union all select format('type %s', t.oid::regtype) from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public'
  union all select format('value %s %s', e.enumtypid::regtype, e.enumlabel) from pg_enum e
  union all select format('schema %s %s', n.nspname, n.nspacl) from pg_namespace n
  union all select format('role %s %s %s %s', r.rolname, r.rolsuper, r.rolcanlogin, r.rolconfig) from pg_roles r
  union all select format('member %s %s', m.roleid, m.member) from pg_auth_members m
  union all select format('default rights %s', d.defaclacl) from pg_default_acl d
  union all select format('database settings %s', s.setconfig) from pg_db_role_setting s
  union all select format('statistics %s', s.starelid::regclass) from pg_statistic s join pg_class c on c.oid = s.starelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
) lines`;

export async function shapeOf(client: PGlite): Promise<string> {
  const { rows } = await client.query<{ shape: string }>(SHAPE);
  return rows[0]!.shape;
}

async function openShared(): Promise<Shared> {
  const client = copyOfMigrated();
  const tables = await client.query<{ name: string }>(`select format('public.%I', tablename) as name from pg_tables where schemaname = 'public'`);
  return { client, truncate: `truncate ${tables.rows.map(t => t.name).join(', ')} restart identity cascade`, shape: await shapeOf(client) };
}

/* Whether it is back as it was opened. The first statement waits for any transaction the last test left running. Discarding
   clears what the connection holds: role, settings, temporary tables, prepared statements and locks. Failing to do all this
   is an answer too: a test can leave a database that will not truncate. */
async function emptied({ client, truncate, shape }: Shared): Promise<boolean> {
  try {
    await client.exec('discard all');
    await client.exec(truncate);
    return (await shapeOf(client)) === shape;
  } catch {
    return false;
  }
}

let shared: Shared | undefined;
let held = false;

export const sharedDatabase = () => shared?.client;

async function closeShared(): Promise<void> {
  const client = shared?.client;
  shared = undefined;
  await client?.close();
}

afterAll(closeShared);

/* What a test gets of the shared database: closing it only ends the test's hold, and from then on every call fails as on a
   closed database, so work the test left behind cannot write into the rows of the next one. */
function heldByOneTest(client: PGlite): PGlite {
  let ended = false;
  held = true;
  return new Proxy(client, {
    get(target, name) {
      if (name === 'closed') return ended || target.closed;
      if (name === 'close') {
        return async () => {
          if (!ended) held = false;
          ended = true;
        };
      }
      const value: unknown = Reflect.get(target, name, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => (ended ? Promise.reject(new Error('PGlite is closed')) : value.apply(target, args));
    },
  });
}

async function sharedForThisTest(): Promise<PGlite> {
  if (shared && !(await emptied(shared))) await closeShared();
  shared ??= await openShared();
  /* A failed test may have left anything, even a transaction that never ends. One failure should stay one. */
  onTestFailed(() => closeShared().catch(() => {}));
  return heldByOneTest(shared.client);
}

export async function openTestDb(): Promise<{ client: PGlite; db: TestDb }> {
  const client = ownEach || held ? copyOfMigrated() : await sharedForThisTest();
  const db = drizzle(client, { schema });
  return { client, db };
}

/* The statements the database runs from now on, in order, with their values. PGlite has one connection, so two moves
   cannot race in a test; this shows instead that a move takes the locks that make them go one after the other. */
export function statements(): { sql: string; params: unknown[] }[] {
  const seen: { sql: string; params: unknown[] }[] = [];
  const execute = PglitePreparedQuery.prototype.execute;
  const spy = vi.spyOn(PglitePreparedQuery.prototype, 'execute').mockImplementation(function (this: PglitePreparedQuery<never>, values) {
    const q = this as unknown as { queryString: string; params: unknown[] };
    seen.push({ sql: q.queryString, params: q.params });
    return execute.call(this, values);
  });
  onTestFinished(() => spy.mockRestore());
  return seen;
}

/* What a test spends on its database and app is no test: the report of test times shows it apart. */
export async function timed<T>(phase: 'setupMs' | 'teardownMs', work: () => Promise<T>): Promise<T> {
  const from = performance.now();
  try {
    return await work();
  } finally {
    const meta = TestRunner.getCurrentTest()?.meta as { setupMs?: number; teardownMs?: number } | undefined;
    if (meta) meta[phase] = (meta[phase] ?? 0) + performance.now() - from;
  }
}

/* Each PGlite is a whole Postgres in WASM memory, so what a test opened for itself closes when it ends. Call this inside a test. */
export async function createTestDb(): Promise<TestDb> {
  const { client, db } = await timed('setupMs', openTestDb);
  onTestFinished(() => timed('teardownMs', () => client.close()));
  return db;
}
