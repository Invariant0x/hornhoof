import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite, types } from '@electric-sql/pglite';
import { drizzle, PglitePreparedQuery, type PgliteDatabase } from 'drizzle-orm/pglite';
import { afterAll, inject, onTestFailed, onTestFinished, TestRunner, vi } from 'vitest';
import * as schema from '../src/db/schema.js';
import { FENCED } from '../src/db/net.js';
import { recordSources } from '../src/db/sources.js';

type TestDb = PgliteDatabase<typeof schema> & { $client: PGlite };
/* seeded: the rows a new copy holds, as the horizon of merges its migrations wrote in net. */
type Shared = { client: PGlite; shape: string; planner: string; pointedAtBy: ReadonlyMap<string, readonly string[]>; seeded: Rows };

/* Every test database starts from a copy of the one global-setup.ts migrated for the run. */
let migrated: Blob | undefined;
let opened = 0;

function copyOfMigrated(): PGlite {
  migrated ??= new Blob([readFileSync(inject('migratedDataDir'))]);
  opened += 1;
  return new PGlite({ loadDataDir: migrated });
}

export const databasesOpened = () => opened;

/* PGlite copies a database's parsers into a new map for each query it answers. With a parser for every array type of
   Postgres in it, the copy took about half of what a small query cost outside Postgres. Postgres's own types are the same
   in every database, so their array parsers, built as PGlite builds them, go once into the parsers PGlite falls back on,
   and a test database keeps only those of the types of its own schema. Every value reads back as before. */
const BUILT_IN_ARRAYS = `select b.oid, b.typarray from pg_type a join pg_type b on b.oid = a.typelem
  where a.typcategory = 'A' and b.typarray < 16384 group by b.oid, b.typarray`;
let builtIn: ReadonlySet<string> | undefined;

async function withOwnParsers(client: PGlite): Promise<PGlite> {
  await client.waitReady;
  if (!builtIn) {
    const { rows } = await client.query<{ oid: number; typarray: number }>(BUILT_IN_ARRAYS);
    for (const { oid, typarray } of rows) types.parsers[typarray] = (value: string) => types.arrayParser(value, types.parsers[oid]!, typarray);
    builtIn = new Set(rows.map(row => String(row.typarray)));
  }
  const own = client.parsers as Record<string, unknown>;
  for (const oid of Object.keys(own)) if (builtIn.has(oid) || own[oid] === types.parsers[oid]) delete own[oid];
  return client;
}

/* An unmigrated database, as new PGlite() gives, from a dump of one initdb, which costs several times as much: the run's
   (global-initdb.ts), or under a configuration without it, one the file's first call makes. */
let initdb: File | Blob | undefined;
export async function freshPglite(): Promise<PGlite> {
  const runs = inject('initdbDataDir') as string | undefined;
  if (!initdb && runs) initdb = new Blob([readFileSync(runs)]);
  if (!initdb) {
    const first = new PGlite();
    /* A dump asked for before it is ready never comes. */
    await first.waitReady;
    initdb = await first.dumpDataDir('none');
    await first.close();
  }
  return withOwnParsers(new PGlite({ loadDataDir: initdb }));
}

/* Opening a copy costs far more than emptying one, so the tests of a file share one, emptied before each of them. A file
   whose tests change more than rows says so at its top with this, and each call in it opens a copy of its own, closed
   when its test ends. Lint asks for this where it sees DDL. */
let ownEach = false;
export function ownDatabases(): void {
  ownEach = true;
}

/* A list of rights in one order: granted again after a revoke, a right goes to its end, and means the same. */
const rights = (acl: string) => `(select array_agg(item::text order by item::text) from unnest(${acl}) item)`;

/* All that a truncate leaves as it was and a test can change. Rows of pg_class and the like hold more, but that more moves
   with every truncate. */
const SHAPE = `select md5(string_agg(line, E'\n' order by line)) as shape from (
  select format('relation %s %s %s %s', c.oid::regclass, c.relkind, ${rights('c.relacl')}, c.relrowsecurity) as line
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
  union all select format('column %s %s %s %s %s', a.attrelid::regclass, a.attname, a.atttypid, ${rights('a.attacl')}, pg_get_expr(d.adbin, d.adrelid))
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attnum > 0 and not a.attisdropped and n.nspname = 'public'
  union all select format('constraint %s %s %s', c.conrelid::regclass, c.conname, pg_get_constraintdef(c.oid))
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public'
  union all select format('index %s', indexdef) from pg_indexes where schemaname = 'public'
  union all select format('trigger %s %s %s', t.tgrelid::regclass, t.tgname, t.tgenabled) from pg_trigger t where not t.tgisinternal
  union all select format('policy %s %s', p.polrelid::regclass, p.polname) from pg_policy p
  union all select format('function %s %s %s', p.oid::regprocedure, md5(p.prosrc), ${rights('p.proacl')})
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
  union all select format('type %s', t.oid::regtype) from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public'
  union all select format('value %s %s', e.enumtypid::regtype, e.enumlabel) from pg_enum e
  union all select format('schema %s %s', n.nspname, ${rights('n.nspacl')}) from pg_namespace n
  union all select format('role %s %s %s', r.rolname, r.rolsuper, r.rolcanlogin) from pg_roles r
  union all select format('member %s %s', m.roleid, m.member) from pg_auth_members m
  union all select format('default rights %s', ${rights('d.defaclacl')}) from pg_default_acl d
  union all select format('database settings %s', s.setconfig) from pg_db_role_setting s
  union all select format('statistics %s', s.starelid::regclass) from pg_statistic s join pg_class c on c.oid = s.starelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
) lines`;

export async function shapeOf(client: PGlite): Promise<string> {
  const { rows } = await client.query<{ shape: string }>(SHAPE);
  return rows[0]!.shape;
}

/* What the planner knows of each table and index of the database: how many pages and rows it has, and how many of its
   pages hold only rows every transaction sees. */
const PLANNER_VIEW = `select coalesce(json_agg(json_build_object('oid', c.oid, 'relpages', c.relpages, 'reltuples', c.reltuples, 'relallvisible', c.relallvisible)), '[]')::text as view
  from pg_class c where c.relnamespace in ('public'::regnamespace, 'net'::regnamespace) and c.relkind in ('r', 'i')`;

/* Each table, with the tables whose foreign keys point at it, each by its schema: the records of merges in net point at
   each other too. */
const POINTED_AT_BY = `select format('%I.%I', t.relnamespace::regnamespace, t.relname) as table, format('%I.%I', f.relnamespace::regnamespace, f.relname) as by
  from pg_constraint c join pg_class t on t.oid = c.confrelid join pg_class f on f.oid = c.conrelid where c.contype = 'f'`;

async function openShared(): Promise<Shared> {
  const client = await withOwnParsers(copyOfMigrated());
  const { rows } = await client.query<{ view: string }>(PLANNER_VIEW);
  const pointedAtBy = new Map<string, string[]>();
  for (const { table, by } of (await client.query<{ table: string; by: string }>(POINTED_AT_BY)).rows) pointedAtBy.set(table, [...(pointedAtBy.get(table) ?? []), by]);
  return { client, shape: await shapeOf(client), planner: rows[0]!.view, pointedAtBy, seeded: await rowsOf(client) };
}

/* Those of the tables a truncate may empty with them: it must name every table whose foreign keys point at one it
   empties, and a table that stays out keeps out every table it points at. */
export function truncatable(tables: readonly string[], pointedAtBy: ReadonlyMap<string, readonly string[]>): string[] {
  const kept = new Set(tables);
  for (let dropped = true; dropped; ) {
    dropped = false;
    for (const table of kept) {
      if ((pointedAtBy.get(table) ?? []).every(by => kept.has(by))) continue;
      kept.delete(table);
      dropped = true;
    }
  }
  return tables.filter(table => kept.has(table));
}

/* Only a table with pages can hold rows. The journal of changes, in the schema net, is emptied with the tables it tells of.
   By name, as the order pg_class is read in changes once a truncate rewrites a table, and rows made once are found by it. */
const WITH_PAGES = `select format('%I.%I', c.relnamespace::regnamespace, c.relname) as name from pg_class c
  where c.relnamespace in ('public'::regnamespace, 'net'::regnamespace) and c.relkind = 'r' and pg_relation_size(c.oid) > 0 order by 1`;
/* What the planner knew as the copy opened, and none of the statistics an analyze made since: the next test is planned as
   on a new copy, and the order a query reads rows in does not depend on the tests before. */
const PLANNER_AS_OPENED = `update pg_class c set relpages = s.relpages, reltuples = s.reltuples, relallvisible = s.relallvisible
  from json_to_recordset($1::json) as s(oid oid, relpages integer, reltuples real, relallvisible integer)
  where c.oid = s.oid and (c.relpages, c.reltuples, c.relallvisible) is distinct from (s.relpages, s.reltuples, s.relallvisible)`;
const NO_STATISTICS = `delete from pg_statistic s using pg_class c where c.oid = s.starelid and c.relnamespace in ('public'::regnamespace, 'net'::regnamespace)`;
const RESTART_NUMBERS = `select setval(format('%I.%I', schemaname, sequencename), start_value, false) from pg_sequences
  where schemaname = 'public' and last_value is not null`;

const pagedTables = async (client: PGlite) => (await client.query<{ name: string }>(WITH_PAGES)).rows.map(t => t.name);

/* Empties the tables a test wrote, and their numbers start over; each table and index is left with the pages of a new
   copy. A truncate of all of them took most of a test's time: through the foreign keys it reaches every table, and each
   costs a new file for it and each of its indexes. So a truncate empties only the written tables it may, and the others
   lose their rows to a delete, their pages to a vacuum and the pages their indexes grew to a reindex, which together cost
   less than the rewrite of a vacuum full. Discarding first clears what the connection holds: role, settings, temporary
   tables, prepared statements and locks, and waits for any transaction the last test left running. */
async function emptyRows({ client, planner, pointedAtBy, seeded }: Shared): Promise<void> {
  await client.exec('discard all');
  const kept = await unchangedSeeds(client, seeded);
  const tables = (await pagedTables(client)).filter(name => !kept.includes(name));
  if (tables.length) {
    const truncated = truncatable(tables, pointedAtBy);
    const deleted = tables.filter(name => !truncated.includes(name));
    await client.transaction(async tx => {
      /* No trigger or foreign key has a say, as in a truncate. */
      await tx.exec('set local session_replication_role = replica');
      for (const name of deleted) await tx.exec(`delete from ${name}`);
      if (truncated.length) await tx.exec(`truncate ${truncated.join(', ')}`);
    });
    if (deleted.length) {
      /* Only a page whose dead rows left the indexes too is free to give back. */
      await client.exec(`vacuum (index_cleanup on, truncate on) ${deleted.join(', ')}`);
      await client.exec(deleted.map(name => `reindex table ${name}`).join(';\n'));
    }
  }
  await putSeedsBack(client, seeded, kept);
  await client.query(NO_STATISTICS);
  await client.query(PLANNER_AS_OPENED, [planner]);
  await client.query(RESTART_NUMBERS);
  for (const { name, value } of seeded.numbers) await client.query('select setval($1::regclass, $2::bigint, true)', [name, value]);
}

/* The tables that hold just the rows a new copy holds, which an emptying leaves alone. */
async function unchangedSeeds(client: PGlite, seeded: Rows): Promise<string[]> {
  const kept: string[] = [];
  for (const { name, rows } of seeded.tables) {
    const now = (await client.query(`copy ${name} to '/dev/blob' with (format binary)`)).blob!;
    if (Buffer.from(await now.arrayBuffer()).equals(Buffer.from(await rows.arrayBuffer()))) kept.push(name);
  }
  return kept;
}

/* The rows a new copy holds, back in the tables an emptying emptied, as the migrations wrote them. */
async function putSeedsBack(client: PGlite, seeded: Rows, kept: readonly string[]): Promise<void> {
  const back = seeded.tables.filter(({ name }) => !kept.includes(name));
  if (!back.length) return;
  await client.transaction(async tx => {
    await tx.exec('set local session_replication_role = replica');
    for (const { name, rows } of back) await tx.query(`copy ${name} from '/dev/blob' with (format binary)`, [], { blob: rows });
  });
}

/* Whether it is ready for the next test. Failing is an answer too: a test can leave a database that will not empty.
   What a test changed beyond rows is seen once, as the file ends. */
async function emptied(shared: Shared): Promise<boolean> {
  try {
    await emptyRows(shared);
    return true;
  } catch {
    return false;
  }
}

/* The tables of a database that hold rows, of those with pages: a table emptied in a test keeps its pages. */
async function tablesWithRows(client: PGlite): Promise<string[]> {
  const tables = await pagedTables(client);
  if (!tables.length) return [];
  const { rows } = await client.query<{ at: number }>(tables.map((name, at) => `select ${at} as at where exists (select 1 from ${name})`).join(' union all '));
  return rows.map(r => tables[r.at]!);
}

type Rows = { tables: { name: string; rows: Blob }[]; numbers: { name: string; value: string }[] };
type Made = Rows & { value: unknown };
const made = new Map<string, Made>();

const NUMBERS = `select format('%I.%I', schemaname, sequencename) as name, last_value::text as value from pg_sequences
  where schemaname = 'public' and last_value is not null`;

/* Every row of the database, table by table in the order a scan reads them, and where its numbers stand. */
async function rowsOf(client: PGlite): Promise<Rows> {
  const tables = [];
  for (const name of await tablesWithRows(client)) tables.push({ name, rows: (await client.query(`copy ${name} to '/dev/blob' with (format binary)`)).blob! });
  return { tables, numbers: (await client.query<{ name: string; value: string }>(NUMBERS)).rows };
}

async function digestOf({ tables, numbers }: Rows): Promise<string> {
  const hash = createHash('sha256').update(JSON.stringify(numbers));
  for (const { name, rows } of tables) hash.update(`\n${name}\n`).update(new Uint8Array(await rows.arrayBuffer()));
  return hash.digest('hex');
}

/* The rows as they were kept, in place of those the database holds. */
async function putBack(client: PGlite, { tables, numbers }: Rows): Promise<void> {
  const now = await tablesWithRows(client);
  await client.query(RESTART_NUMBERS);
  await client.transaction(async tx => {
    /* The rows are as the real code made them: no trigger or foreign key has a say again. */
    await tx.exec('set local session_replication_role = replica');
    for (const name of now) await tx.exec(`delete from ${name}`);
    for (const { name, rows } of tables) await tx.query(`copy ${name} from '/dev/blob' with (format binary)`, [], { blob: rows });
    for (const { name, value } of numbers) await tx.query('select setval($1::regclass, $2::bigint, true)', [name, value]);
  });
}

/* Rows fixture() is still making or putting back. */
const making = new Set<Promise<unknown>>();

/* A turn of the event loop as the real clock gives it, as a test can end with the clock not real. */
const { setImmediate: nextTurn } = globalThis;

/* A test whose end waits for rows goes on to the rows it asks for next, which stand on them, within a turn of the event
   loop. */
async function madeAll(): Promise<void> {
  do {
    await Promise.allSettled(making);
    await new Promise(next => nextTurn(next));
  } while (making.size);
}

/* Rows a group of tests starts from: make builds them through the real code for the first test of the file that asks,
   and every later one that asks on the same rows gets the rows and numbers make left back, with a copy of what make
   returned, which holds no function. So one set of rows can stand on another made the same way. On other rows they are
   made again, as on any database, and so they are while the clock is not real: kept ones would hold the time of the real
   one. Under one key, make builds the same rows each time. */
export function fixture<T>(client: PGlite, key: string, make: () => Promise<T>, clock?: { at: number }): Promise<T> {
  if (vi.isFakeTimers() && !clock) return make();
  /* Keep Switch's completion barrier: a test that ends while rows are being made must finish that work before its
     app and database close, so the next test can reuse the completed snapshot. */
  if (TestRunner.getCurrentTest()) onTestFinished(madeAll);
  const call = keptOrMade(client, key, make, clock);
  making.add(call);
  call.then(() => making.delete(call), () => making.delete(call));
  return call;
}

async function keptOrMade<T>(client: PGlite, key: string, make: () => Promise<T>, clock?: { at: number }): Promise<T> {
  /* An explicit frozen wall time has its own cache. Ordinary fake-clock callers still make fresh rows. */
  const checkClock = () => {
    if (clock && (!vi.isFakeTimers() || Date.now() !== clock.at)) throw new Error('The fixture clock must stay frozen at its declared time.');
  };
  checkClock();
  const on = `${clock ? `at ${clock.at}` : 'real'}\n${key}\n${await digestOf(await rowsOf(client))}`;
  const kept = made.get(on);
  if (kept) {
    await putBack(client, kept);
    checkClock();
    return structuredClone(kept.value) as T;
  }
  const value = await make();
  checkClock();
  const rows = await rowsOf(client);
  checkClock();
  made.set(on, { ...rows, value: structuredClone(value) });
  return value;
}

let shared: Shared | undefined;
let held = false;

export const sharedDatabase = () => shared?.client;

async function closeShared(): Promise<void> {
  const client = shared?.client;
  shared = undefined;
  await client?.close();
}

async function rejectSharedDatabase(): Promise<never> {
  await closeShared();
  throw new Error('A test of this file changed the shared database beyond its rows, which reaches every test after it. Call ownDatabases() at the top of this file.');
}

/* Whether the tests of the file left the shared database as it opened, but for its rows. A change beyond them, such as a
   trigger, a function, a table, a role, a right, a setting of the database or a statistic, reached every later test of
   the file, so the file fails, and the database is put aside. */
export async function checkSharedDatabase(): Promise<void> {
  if (!shared) return;
  /* A cleanup failure cannot prove isolation, even when the last test itself passed. */
  if (!(await emptied(shared))) return rejectSharedDatabase();
  const now = await shapeOf(shared.client).catch(() => null);
  if (now === shared.shape) return;
  return rejectSharedDatabase();
}

afterAll(async () => {
  try {
    await checkSharedDatabase();
  } finally {
    await closeShared();
  }
});

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
  if (shared && !(await emptied(shared))) return rejectSharedDatabase();
  shared ??= await openShared();
  /* A failed test may have left anything, even a transaction that never ends. One failure should stay one. */
  onTestFailed(() => closeShared().catch(() => {}));
  return heldByOneTest(shared.client);
}

export async function openTestDb(): Promise<{ client: PGlite; db: TestDb }> {
  const client = ownEach || held ? await withOwnParsers(copyOfMigrated()) : await sharedForThisTest();
  /* Every test database holds an endless lease (prepare-environment.ts) and says it is fenced, so the whole suite runs
     under the first fence. PGlite applies no ALTER DATABASE or ALTER ROLE setting when it loads a dump, and the discard
     that empties a shared one forgets it, so each test says it for itself. */
  await client.exec(`SET ${FENCED} = 'on'`);
  const db = recordSources(drizzle(client, { schema }));
  return { client, db };
}

/* A database a test made from another one's files, as a test database: with its own parsers, fenced and wrapped. */
export async function asTestDb(client: PGlite): Promise<{ client: PGlite; db: TestDb }> {
  await withOwnParsers(client);
  await client.exec(`SET ${FENCED} = 'on'`);
  return { client, db: recordSources(drizzle(client, { schema })) };
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
