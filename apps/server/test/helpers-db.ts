import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite, types } from '@electric-sql/pglite';
import { drizzle, PglitePreparedQuery, type PgliteDatabase } from 'drizzle-orm/pglite';
import { afterAll, inject, onTestFailed, onTestFinished, TestRunner, vi } from 'vitest';
import * as schema from '../src/db/schema.js';
import { FENCED } from '../src/db/net.js';
import { recordSources } from '../src/db/sources.js';
import { decodeDatabaseMetadata, pagedTables, rowsOf, shapeOf, tablesWithRows, type Rows } from './helpers-db-metadata.js';
export { shapeOf } from './helpers-db-metadata.js';

type TestDb = PgliteDatabase<typeof schema> & { $client: PGlite };
/* seeded: the rows a new copy holds, as the horizon of merges its migrations wrote in net. */
type Shared = { client: PGlite; shape: string; planner: string; pointedAtBy: ReadonlyMap<string, readonly string[]>; seeded: Rows };

/* Every test database starts from a copy of the one global-setup.ts migrated for the run. */
let migrated: Blob | undefined;
let bytes: Buffer | undefined;
const migratedBytes = () => (bytes ??= readFileSync(inject('migratedDataDir')));
let opened = 0;

function copyOfMigrated(): PGlite {
  migrated ??= new Blob([migratedBytes()]);
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

async function openShared(): Promise<Shared> {
  const metadata = decodeDatabaseMetadata(readFileSync(inject('databaseMetadataFile'), 'utf8'), migratedBytes());
  const client = await withOwnParsers(copyOfMigrated());
  return { client, shape: metadata.shape, planner: metadata.planner, pointedAtBy: new Map(metadata.pointedAtBy), seeded: metadata.seeded };
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

/* What the planner knew as the copy opened, and none of the statistics an analyze made since: the next test is planned as
   on a new copy, and the order a query reads rows in does not depend on the tests before. */
const PLANNER_AS_OPENED = `update pg_class c set relpages = s.relpages, reltuples = s.reltuples, relallvisible = s.relallvisible
  from json_to_recordset($1::json) as s(oid oid, relpages integer, reltuples real, relallvisible integer)
  where c.oid = s.oid and (c.relpages, c.reltuples, c.relallvisible) is distinct from (s.relpages, s.reltuples, s.relallvisible)`;
const NO_STATISTICS = `delete from pg_statistic s using pg_class c where c.oid = s.starelid and c.relnamespace in ('public'::regnamespace, 'net'::regnamespace)`;
const RESTART_NUMBERS = `select setval(format('%I.%I', schemaname, sequencename), start_value, false) from pg_sequences
  where schemaname = 'public' and last_value is not null`;

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

type Made = Rows & { value: unknown };
const made = new Map<string, Made>();

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
export function fixture<T>(client: PGlite, key: string, make: () => Promise<T>): Promise<T> {
  if (vi.isFakeTimers()) return make();
  /* A test can end while rows are still being made, as when its time runs out on a busy machine. Its end waits for them
     then, with its database and app still open, so they are kept: made again, they would cost the next test the same
     time. Its hooks run last first, and those that close the database and the app came before this one. */
  if (TestRunner.getCurrentTest()) onTestFinished(madeAll);
  const call = keptOrMade(client, key, make);
  making.add(call);
  call.then(() => making.delete(call), () => making.delete(call));
  return call;
}

async function keptOrMade<T>(client: PGlite, key: string, make: () => Promise<T>): Promise<T> {
  const on = `${key}\n${await digestOf(await rowsOf(client))}`;
  const kept = made.get(on);
  if (kept) {
    await putBack(client, kept);
    return structuredClone(kept.value) as T;
  }
  const value = await make();
  made.set(on, { ...(await rowsOf(client)), value: structuredClone(value) });
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
