import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { COPY_STATE, CopyMaker, copyName, DISK_FULL, ENABLE_FOR_MS, SCHEMA_FILE, type CopyOrder } from '../src/modules/keeper/copy.js';
import type { Sql } from '../src/modules/keeper/lease-store.js';

const NETWORK_ID = `99BB2233aabbccdd${'2'.repeat(48)}`;
const NAME = 'copy_99bb2233aabbccdd_1';
const PASSWORD = 'the-replica-password';
const MIB = 2 ** 20;
const ORDER: CopyOrder = { slot: 'ok', leaderSize: 4 * MIB, migrations: 108, old: null, upload: null, lastAttempt: null };
/* What the leader says of a machine that never kept a copy. */
const FIRST: CopyOrder = { ...ORDER, slot: null };

/* oid: as Postgres numbers it, one per subscription made. dies: enabled again, it stops on its next error, which one
   look still finds it running before. */
/* leads: its connection leads to the leader, as one made by the maker does. working: the tables a worker of it copies now. */
type Sub = { enabled: boolean; slot: string | null; rels: string[]; oid?: number; dies?: { looked: boolean }; leads?: boolean; working?: number[] };
/* handed: its time as the leader ended in a handover. passfile: the file the replica role's password is read from is there. */
/* leftovers: the origins of tables whose first copy was broken off, which Postgres keeps until that table's copy is
   through, and which no worker uses now. */
type Database = { tables: boolean; led: boolean; handed: boolean; passfile: boolean; migrations: number; size: number; pulse: string | null; subs: Map<string, Sub>; leftovers: string[] };

/* The copy's own database server, as far as the maker asks it: each statement it knows changes what a test set up, and
   every statement is kept, with the database it ran on. */
function cluster() {
  const databases = new Map<string, Database>();
  const run: string[] = [];
  /* The leader's side, where a test turns it on: the slots its Postgres keeps, the count of migrations its schema has,
     whether the copy reaches it, and whether every apply breaks whatever the schema. A subscription that starts makes a
     slot for each table whose first copy it takes; one whose schema is not the leader's, or any while applies break,
     stops at its first error, and its tables' slots stay. Dropped with its slot, a subscription drops all of them there. */
  /* hangs: the link takes a connection to the leader and never answers on it. Postgres then waits for as long as it
     holds, whatever the connection's own timeout says, and only a statement timeout of its session ends the wait. */
  const leader = { live: false, migrations: 108, slots: new Set<string>(), reachable: true, breaks: false, hangs: false };
  /* What Postgres still runs after the keeper stopped waiting for it. */
  const running: string[] = [];
  let oids = 16500;
  const syncSlot = (sub: Sub, table: number): string => `pg_${sub.oid}_sync_${table}_7300000000000000000`;
  const fails = (db: Database): boolean => leader.breaks || db.migrations !== leader.migrations;
  const start = (db: Database, sub: Sub): void => {
    sub.enabled = true;
    if (!leader.live) return;
    sub.rels.forEach((state, table) => void (state !== 'r' && leader.slots.add(syncSlot(sub, table))));
    if (fails(db)) sub.dies = { looked: false };
  };
  const add = (name: string, over: Partial<Database> = {}) => {
    const database: Database = { tables: false, led: false, handed: false, passfile: false, migrations: 108, size: 0, pulse: null, subs: new Map(), leftovers: [], ...over };
    databases.set(name, database);
    return database;
  };
  const nameIn = (text: string): string => /"([^"]+)"/.exec(text)![1]!;
  const answer = (on: string, text: string, params: unknown[] = [], session: { timeout: string | null } = { timeout: null }): Record<string, unknown>[] => {
    const db = databases.get(on);
    if (text.startsWith('SET statement_timeout') || text === 'RESET statement_timeout') {
      session.timeout = text.startsWith('SET') ? text : null;
      return [];
    }
    if (text.includes('FROM pg_replication_origin')) return db!.leftovers.map(name => ({ name }));
    if (text.includes('pg_replication_origin_drop')) {
      db!.leftovers = db!.leftovers.filter(name => name !== params[0]);
      return [];
    }
    if (on !== 'postgres' && !db) throw new Error(`database "${on}" does not exist`);
    if (text.includes("to_regclass('net_local.state')")) return [{ there: db!.tables }];
    /* A row whose time as the leader ended in a handover counts only for a query that does not ask of that. */
    if (text.includes('FROM net_local.state')) return [{ led: db!.led && !(db!.handed && text.includes('handed_lsn')) }];
    if (text.includes('pg_stat_file')) return [{ there: db!.passfile }];
    if (text.includes('FROM pg_tables')) return [{ there: db!.tables }];
    if (text.includes('drizzle.__drizzle_migrations')) return [{ n: db!.migrations }];
    if (text.startsWith('DO $replica$')) return [];
    if (text.includes('FROM pg_subscription s')) {
      for (const sub of db!.subs.values()) {
        if (!sub.dies) continue;
        if (!sub.dies.looked) sub.dies.looked = true;
        else [sub.enabled, sub.dies] = [false, undefined];
      }
      return [...db!.subs].map(([name, sub]) => ({ name, oid: sub.oid ?? 16500, enabled: sub.enabled, slot: sub.slot }));
    }
    if (text.includes('pg_terminate_backend')) return [];
    if (text.startsWith('ALTER DATABASE')) {
      const [from, to] = [...text.matchAll(/"([^"]+)"/g)].map(found => found[1]!);
      if (!databases.has(from!) || databases.has(to!)) throw new Error(`cannot rename "${from}" to "${to}"`);
      databases.set(to!, databases.get(from!)!);
      databases.delete(from!);
      return [];
    }
    if (text.startsWith('ALTER SYSTEM') || text === 'SELECT pg_reload_conf()') return [];
    if (text === 'SHOW data_directory') return [{ data_directory: '/var/lib/postgresql/data' }];
    if (text.startsWith('CREATE SUBSCRIPTION')) {
      /* One that copies no data has every table ready at once. */
      const sub: Sub = { enabled: true, slot: nameIn(text), rels: text.includes('copy_data = false') ? ['r', 'r'] : ['i', 'i'], oid: oids++, leads: text.includes('host=keeper') };
      db!.subs.set(nameIn(text), sub);
      if (leader.live) leader.slots.add(sub.slot!);
      start(db!, sub);
      return [];
    }
    /* The leader's slots of the tables whose first copy broke off, which no worker takes up now. */
    if (text.includes('pg_control_system')) {
      const sub = [...db!.subs.values()].find(found => (found.oid ?? 16500) === params[0]);
      return (sub?.rels ?? []).flatMap((state, table) => (state === 'd' && !sub!.working?.includes(table) ? [{ name: syncSlot(sub!, table) }] : []));
    }
    if (text.includes('FROM pg_subscription_rel')) {
      const sub = [...db!.subs.values()][0];
      /* With the leader on, the first copy of every table is through once the subscription runs and nothing breaks it. */
      if (leader.live && sub?.enabled && !sub.dies && !fails(db!)) {
        sub.rels.forEach((state, table) => void (state !== 'r' && leader.slots.delete(syncSlot(sub, table))));
        sub.rels = sub.rels.map(() => 'r');
      }
      const rels = sub?.rels ?? [];
      return [{ total: rels.length, ready: rels.filter(state => state === 'r').length }];
    }
    if (text.includes('pg_database_size')) return [{ size: db!.size }];
    if (text === 'SELECT at FROM net.pulse') return db!.pulse ? [{ at: db!.pulse }] : [];
    if (text.startsWith('ALTER SUBSCRIPTION')) {
      const sub = db!.subs.get(nameIn(text))!;
      if (text.endsWith('ENABLE')) start(db!, sub);
      else if (text.endsWith('DISABLE')) sub.enabled = false;
      else if (text.endsWith('SET (slot_name = NONE)')) sub.slot = null;
      else if (text.includes(' CONNECTION ')) sub.leads = text.includes('host=keeper');
      return [];
    }
    if (text.startsWith('DROP SUBSCRIPTION')) {
      const sub = db!.subs.get(nameIn(text));
      /* It asks the leader to drop the slot, and those of the tables not through yet, whenever it has either. */
      if (leader.live && leader.hangs && sub?.leads && (sub.slot || sub.rels.some(state => state !== 'r'))) {
        if (session.timeout) throw new Error('canceling statement due to statement timeout');
        running.push(`${on}: ${text}`);
        throw new Error('Query read timeout');
      }
      if (leader.live && sub?.slot) {
        if (!leader.reachable) throw new Error('could not connect to the publisher: connection refused');
        leader.slots.delete(sub.slot);
        sub.rels.forEach((_, table) => leader.slots.delete(syncSlot(sub, table)));
      }
      db!.subs.delete(nameIn(text));
      return [];
    }
    if (text.includes('FROM pg_database WHERE datname')) return databases.has(String(params[0])) ? [{ there: 1 }] : [];
    if (text.startsWith('DROP DATABASE')) {
      databases.delete(nameIn(text));
      return [];
    }
    if (text.startsWith('CREATE DATABASE')) {
      add(nameIn(text));
      return [];
    }
    throw new Error(`The fake does not know: ${text}`);
  };
  /* Every connection that was opened, by its database. */
  const opened: string[] = [];
  const sqlOn = (on: string): Sql & { close(): Promise<void> } => {
    opened.push(on);
    const session = { timeout: null as string | null };
    return {
      query: async <R>(text: string, params?: unknown[]) => {
        run.push(`${on}: ${text.startsWith('DO $replica$') ? 'DO $replica$' : text}`);
        return { rows: answer(on, text, params, session) as R[] };
      },
      close: async () => undefined,
    };
  };
  return { databases, run, add, sqlOn, opened, leader, running };
}

function stand(over: { diskFree?: number } = {}) {
  const controlDir = mkdtempSync(join(tmpdir(), 'hh-copy-control-'));
  const dir = mkdtempSync(join(tmpdir(), 'hh-copy-keeper-'));
  onTestFinished(() => void [controlDir, dir].forEach(folder => rmSync(folder, { recursive: true, force: true })));
  const c = cluster();
  c.add('hornhoof');
  const state = { now: new Date('2026-11-11T12:00:00Z'), lines: [] as string[], diskFree: over.diskFree ?? 50 * 2 ** 30, updating: false };
  /* What saves a database that led, as a test plays it: how far it is, and what it was asked. */
  const saving = { on: false, done: false, failed: null as string | null, ticks: 0, forgot: 0 };
  const saver = { tick: async () => void (saving.ticks += 1), done: () => saving.done, state: () => ({ term: 7, failed: saving.failed }), forget: () => void (saving.forgot += 1) };
  const maker = () =>
    new CopyMaker({
      admin: c.sqlOn('postgres'), db: c.sqlOn, controlDir, dir, networkId: NETWORK_ID, password: PASSWORD, diskFree: () => state.diskFree, updating: () => state.updating, log: line => state.lines.push(line), now: () => state.now,
      ...(saving.on ? { saver } : {}),
    });
  const later = (ms: number) => void (state.now = new Date(state.now.getTime() + ms));
  const request = () => (existsSync(join(controlDir, SCHEMA_FILE)) ? (JSON.parse(readFileSync(join(controlDir, SCHEMA_FILE), 'utf8')) as Record<string, unknown>) : null);
  const kept = () => JSON.parse(readFileSync(join(dir, COPY_STATE), 'utf8')) as Record<string, unknown>;
  /* The updater's part: the leader's schema loaded into the database the request names. */
  const loaded = (attempt = 1, database = 'hornhoof') => {
    const db = c.databases.get(database)!;
    db.tables = true;
    if (c.leader.live) db.migrations = c.leader.migrations;
    mkdirSync(join(controlDir, 'schema'), { recursive: true });
    writeFileSync(join(controlDir, 'schema', `${attempt}.done`), '');
    rmSync(join(controlDir, SCHEMA_FILE), { force: true });
  };
  return { ...c, controlDir, dir, state, maker, later, request, kept, loaded, saving };
}

/* Ticks until the copy has reached this phase, a few at most. */
async function until(s: ReturnType<typeof stand>, maker: CopyMaker, phase: string, order: CopyOrder | null = ORDER): Promise<void> {
  for (let tries = 0; tries < 8 && (!existsSync(join(s.dir, COPY_STATE)) || s.kept().phase !== phase); tries++) await maker.tick(order);
  expect(s.kept().phase).toBe(phase);
}

describe('the maker of a copy', () => {
  it('names a copy by its machine and its attempt', () => {
    expect(copyName(NETWORK_ID, 1)).toBe(NAME);
    expect(copyName(NETWORK_ID, 12)).toBe('copy_99bb2233aabbccdd_12');
  });

  it('starts above its last attempt after a wipe', async () => {
    const s = stand();
    const maker = s.maker();
    /* Not before the leader said which attempt this machine's row names: nothing is asked, and nothing said of a copy. */
    await maker.tick(null);
    expect([s.request(), maker.report(), existsSync(join(s.dir, COPY_STATE))]).toEqual([null, null, false]);
    await maker.tick({ ...ORDER, slot: 'missing', lastAttempt: 7 });
    expect(s.request()).toMatchObject({ attempt: 8 });
    expect(maker.report()).toMatchObject({ state: 'making', name: 'copy_99bb2233aabbccdd_8' });
    s.loaded(8);
    await until(s, maker, 'sync', null);
    expect([...s.databases.get('hornhoof')!.subs.keys()]).toEqual(['copy_99bb2233aabbccdd_8']);
    /* A keeper that starts again goes on from what it wrote down. */
    expect(s.maker().report()).toMatchObject({ name: 'copy_99bb2233aabbccdd_8' });
    /* A machine that never kept one starts at 1. */
    const first = stand();
    await first.maker().tick(FIRST);
    expect(first.request()).toMatchObject({ attempt: 1 });
  });

  it('asks for the schema once', async () => {
    const s = stand();
    const maker = s.maker();
    expect(maker.mode()).toBe('off');
    await maker.tick(FIRST);
    expect(s.request()).toEqual({ attempt: 1, database: 'hornhoof', port: 7432, password: PASSWORD });
    expect(statSync(join(s.controlDir, SCHEMA_FILE)).mode & 0o777).toBe(0o600);
    const written = statSync(join(s.controlDir, SCHEMA_FILE)).mtimeMs;
    await maker.tick(null);
    expect(statSync(join(s.controlDir, SCHEMA_FILE)).mtimeMs).toBe(written);
    expect(maker.report()).toMatchObject({ state: 'making', progress: 0, error: null, at: null, name: NAME, old: null });
    expect(maker.mode()).toBe('off');
    /* Nothing but looks so far. */
    expect(s.run.every(line => /: SELECT /.test(line))).toBe(true);
  });

  it('tries again with the next attempt', async () => {
    const s = stand();
    const maker = s.maker();
    await maker.tick(FIRST);
    const first = { attempt: 1, since: s.state.now.toISOString() };
    expect(maker.report()).toMatchObject({ schema: first });
    mkdirSync(join(s.controlDir, 'schema'));
    writeFileSync(join(s.controlDir, 'schema', '1.failed'), 'The database is not empty.\n');
    rmSync(join(s.controlDir, SCHEMA_FILE));
    await maker.tick(null);
    expect(s.state.lines).toEqual(["Could not load the company's schema for a copy: The database is not empty."]);
    expect(s.kept()).toMatchObject({ attempt: 2, phase: 'schema' });
    /* The next request comes ten minutes later, under the next number, also from a keeper that started meanwhile. */
    s.later(9 * 60_000);
    await s.maker().tick(null);
    expect(s.request()).toBeNull();
    s.later(61_000);
    const restarted = s.maker();
    await restarted.tick(null);
    expect(restarted.report()).toMatchObject({ schema: first });
    expect(s.request()).toMatchObject({ attempt: 2, database: 'hornhoof' });
    expect(s.state.lines).toHaveLength(1);
    s.loaded(2);
    await restarted.tick(null);
    expect(restarted.report()).not.toHaveProperty('schema');
  });

  it('subscribes with these options', async () => {
    const s = stand();
    const maker = s.maker();
    await maker.tick(null);
    s.loaded();
    await until(s, maker, 'sync');
    const statements = s.run.filter(line => !/: SELECT (to_regclass|EXISTS|count|at|1 AS)/.test(line) && !line.includes('FROM pg_subscription'));
    expect(statements).toEqual([
      'hornhoof: DO $replica$',
      "hornhoof: ALTER SYSTEM SET wal_receiver_status_interval = '1s'",
      'hornhoof: SELECT pg_reload_conf()',
      'hornhoof: SHOW data_directory',
      `hornhoof: CREATE SUBSCRIPTION "${NAME}" CONNECTION 'host=keeper port=7432 dbname=hornhoof user=hornhoof_replica passfile=/var/lib/postgresql/data/replica.pgpass' PUBLICATION "hornhoof" WITH (copy_data = true, synchronous_commit = 'local', binary = false, streaming = off, disable_on_error = true)`,
    ]);
    for (const text of [...s.run, ...s.state.lines]) expect(text).not.toContain(PASSWORD);
    expect(s.kept()).toMatchObject({ attempt: 1, database: 'hornhoof', phase: 'sync', migrations: 108 });
    expect(maker.migrations()).toBe(108);
    /* A keeper that starts with the subscription there makes no second one. */
    writeFileSync(join(s.dir, COPY_STATE), JSON.stringify({ ...s.kept(), phase: 'subscribe' }));
    const again = s.maker();
    await again.tick(ORDER);
    expect(s.run.filter(line => line.includes('CREATE SUBSCRIPTION'))).toHaveLength(1);
    expect(s.kept().phase).toBe('sync');
  });

  it('counts its progress', async () => {
    const s = stand();
    const maker = s.maker();
    await maker.tick(null);
    s.loaded();
    await until(s, maker, 'sync');
    const db = s.databases.get('hornhoof')!;
    db.size = 3 * MIB;
    await maker.tick(ORDER);
    expect(maker.report()).toMatchObject({ state: 'making', progress: 75 });
    db.size = 5 * MIB;
    await maker.tick(ORDER);
    expect(maker.report()).toMatchObject({ state: 'making', progress: 99 });
    /* Before the leader said its size there is nothing to count against. */
    await maker.tick(null);
    expect(maker.report()).toMatchObject({ state: 'making', progress: 0 });
    expect(maker.mode()).toBe('off');
  });

  it("names in its report the leader's slots of the tables whose first copy broke off, and no more once they start again", async () => {
    const s = stand();
    const maker = s.maker();
    await maker.tick(null);
    s.loaded();
    await until(s, maker, 'sync');
    const sub = s.databases.get('hornhoof')!.subs.get(NAME)!;
    /* A cut broke off two tables mid-copy, and a worker took one of them up again; a third waits for its first start. */
    sub.rels = ['d', 'd', 'i', 'r'];
    sub.working = [1];
    await maker.tick(ORDER);
    expect(maker.report()).toMatchObject({ state: 'making', left: [`pg_${sub.oid}_sync_0_7300000000000000000`] });
    sub.working = [0, 1];
    await maker.tick(ORDER);
    expect(maker.report()).not.toHaveProperty('left');
  });

  it('finishes when every table is ready', async () => {
    const s = stand();
    const maker = s.maker();
    await maker.tick(null);
    s.loaded();
    await until(s, maker, 'sync');
    const db = s.databases.get('hornhoof')!;
    const sub = db.subs.get(NAME)!;
    sub.rels = ['r', 'd'];
    await maker.tick(ORDER);
    expect(maker.report()?.state).toBe('making');
    sub.rels = ['r', 'r'];
    db.pulse = '2026-11-11T11:59:59.000Z';
    await maker.tick(ORDER);
    expect(maker.report()).toEqual({ state: 'ready', progress: null, error: null, at: '2026-11-11T11:59:59.000Z', name: NAME, old: null });
    expect(maker.mode()).toBe('read');
    /* It stays ready across a start of its keeper. */
    expect(s.maker().mode()).toBe('read');
  });

  it('tells a full disk from a broken apply', async () => {
    const s = stand();
    const maker = s.maker();
    await maker.tick(null);
    s.loaded();
    await until(s, maker, 'sync');
    const sub = s.databases.get('hornhoof')!.subs.get(NAME)!;
    sub.rels = ['r'];
    await until(s, maker, 'ready');
    /* The subscription stopped on an error. */
    sub.enabled = false;
    s.state.diskFree = 500 * MIB;
    const enables = () => s.run.filter(line => line.endsWith('ENABLE')).length;
    let asked = enables();
    /* Each look enables it once a minute, and it stops again. */
    for (const [ms, tries] of [[0, 1], [30_000, 1], [31_000, 2]] as const) {
      s.later(ms);
      await maker.tick(ORDER);
      sub.enabled = false;
      expect(enables() - asked).toBe(tries);
    }
    asked = enables();
    expect(maker.report()).toMatchObject({ state: 'stopped', error: 'disk_full' });
    expect(DISK_FULL).toBe(2 ** 30);
    s.state.diskFree = 50 * 2 ** 30;
    await maker.tick(ORDER);
    expect(maker.report()).toMatchObject({ state: 'stopped', error: 'apply' });
    /* Enabled again and holding. */
    s.later(61_000);
    await maker.tick(ORDER);
    await maker.tick(ORDER);
    expect(maker.report()).toMatchObject({ state: 'ready', error: null });
  });

  it('never touches a database that led', async () => {
    const s = stand();
    Object.assign(s.databases.get('hornhoof')!, { tables: true, led: true });
    const maker = s.maker();
    for (let tries = 0; tries < 3; tries++) await maker.tick(ORDER);
    expect(maker.report()).toEqual({ state: 'stopped', progress: null, error: 'led', at: null, name: NAME, old: null });
    expect(s.run.every(line => /: SELECT (to_regclass|EXISTS)/.test(line))).toBe(true);
    expect(s.request()).toBeNull();
    expect(maker.mode()).toBe('off');
  });

  it('saves a led database before remaking it', async () => {
    const s = stand();
    s.saving.on = true;
    Object.assign(s.databases.get('hornhoof')!, { tables: true, led: true });
    const maker = s.maker();
    const from = s.run.length;
    /* What it did while it led is saved first: nothing of a copy starts, and the saver is asked every ten seconds. */
    for (let seconds = 0; seconds < 25; seconds++) {
      await maker.tick(ORDER);
      s.later(1000);
    }
    expect(maker.report()).toEqual({ state: 'saving', progress: null, error: null, at: null, name: NAME, old: null });
    expect([s.saving.ticks, changes(s, from), s.request(), maker.mode()]).toEqual([3, [], null, 'off']);
    /* The updater could not dump it: the copy says why, as far as it can tell. */
    s.saving.failed = 'pg_dump: error: could not write: No space left on device';
    await maker.tick(ORDER);
    expect(maker.report()).toMatchObject({ state: 'stopped', error: 'disk_full' });
    s.saving.failed = 'pg_dump: error: connection refused';
    await maker.tick(ORDER);
    expect(maker.report()).toMatchObject({ state: 'stopped', error: 'setup' });
    s.saving.failed = null;
    /* Saved: the copy is made again beside the database that led, which is read until the new one is whole. */
    s.saving.done = true;
    s.later(10_000);
    await maker.tick(ORDER);
    expect(s.kept()).toMatchObject({ attempt: 2, database: 'hornhoof_next', phase: 'detach', old: { attempt: 1, led: 7 } });
    expect(maker.mode()).toBe('read');
    await remade(s, maker);
    await maker.tick({ ...ORDER });
    expect(maker.report()).toEqual({ state: 'ready', progress: null, error: null, at: '2026-11-11T12:00:30.000Z', name: NEXT, old: { attempt: 1, led: 7 } });
    expect(s.databases.get('hornhoof')!.led).toBe(true);
  });

  it('swaps a led database only once its bundle is recorded', async () => {
    const s = stand();
    s.saving.on = true;
    s.saving.done = true;
    Object.assign(s.databases.get('hornhoof')!, { tables: true, led: true });
    const maker = s.maker();
    await maker.tick(ORDER);
    await remade(s, maker);
    await maker.tick({ ...ORDER });
    /* The leader merged what it held, but its bundle is not recorded any more as far as this keeper knows: it stays. */
    s.saving.done = false;
    for (let ticks = 0; ticks < 3; ticks++) await maker.tick({ ...ORDER, old: 'merged' });
    expect([s.kept().swap, s.databases.has('hornhoof_next')]).toEqual([null, true]);
    s.saving.done = true;
    await maker.tick({ ...ORDER, old: 'merged' });
    expect(s.kept()).toMatchObject({ swap: 'off' });
    s.later(2000);
    for (let ticks = 0; ticks < 8 && s.kept().swap !== null; ticks++) await maker.tick({ ...ORDER, old: 'merged' });
    /* The database that led went, with its merge and its bundle behind it, and nothing is left to remember of it. */
    expect(s.kept()).toMatchObject({ attempt: 2, database: 'hornhoof', phase: 'ready', old: null, swap: null });
    expect([[...s.databases.keys()], s.databases.get('hornhoof')!.led, s.saving.forgot]).toEqual([['hornhoof'], false, 1]);
  });

  it('skips saving immediately when the leader already holds everything, and reports why saving waits', async () => {
    const s = stand();
    Object.assign(s.databases.get('hornhoof')!, { tables: true, led: true });
    const seen: unknown[] = [];
    const step = { done: false, skipped: false, waiting: 'seal' as const, since: '2026-11-11T01:09:00.000Z' };
    const maker = new CopyMaker({
      admin: s.sqlOn('postgres'), db: s.sqlOn, controlDir: s.controlDir, dir: s.dir, networkId: NETWORK_ID, password: PASSWORD,
      diskFree: () => s.state.diskFree, updating: () => s.state.updating, log: line => s.state.lines.push(line), now: () => s.state.now,
      saver: {
        tick: async (applied?: { term: number; lsn: string } | null) => {
          seen.push(applied ?? null);
          if (applied?.lsn === '0/4000000') step.done = step.skipped = true;
        },
        done: () => step.done,
        state: () => ({ term: 7, failed: null, ...step }),
        forget: () => undefined,
      } as never,
    });
    await maker.tick(ORDER);
    expect(maker.report()).toEqual({
      state: 'saving', progress: null, error: null, at: null, name: NAME, old: null,
      saving: { waiting: 'seal', since: '2026-11-11T01:09:00.000Z' },
    });
    /* One second later (without waiting the 10-second save interval) the leader's applied LSN arrives and skips the save. */
    s.later(1000);
    await maker.tick({ ...ORDER, applied: { term: 7, lsn: '0/4000000' } } as CopyOrder);
    expect(seen).toEqual([null, { term: 7, lsn: '0/4000000' }]);
    expect(s.kept()).toMatchObject({ attempt: 2, database: 'hornhoof_next', phase: 'detach', old: { attempt: 1, led: 7 } });
    expect(maker.mode()).toBe('read');
  });

  it('gives a failed attempt up whole', async () => {
    const s = stand();
    const maker = s.maker();
    await maker.tick(null);
    s.loaded();
    await until(s, maker, 'sync');
    const sub = s.databases.get('hornhoof')!.subs.get(NAME)!;
    /* It stopped during its first copy, and no enabling holds. */
    for (let minutes = 0; minutes <= 10; minutes++) {
      sub.enabled = false;
      await maker.tick(ORDER);
      s.later(60_000);
    }
    expect(s.kept()).toMatchObject({ attempt: 2, phase: 'drop' });
    /* Written down before the first statement of the giving up. */
    expect(s.run.some(line => /DISABLE|slot_name = NONE|DROP /.test(line))).toBe(false);
    /* A keeper that stopped right after the first statement, and one that starts over the same files. */
    sub.enabled = true;
    const first = s.run.length;
    await maker.tick(ORDER);
    const given = s.run.slice(first).filter(line => /ALTER SUBSCRIPTION|DROP |CREATE DATABASE/.test(line));
    /* Dropped with its slot, which Postgres drops on the leader with those of the tables' first copies. */
    expect(given).toEqual([
      `hornhoof: ALTER SUBSCRIPTION "${NAME}" DISABLE`,
      `hornhoof: DROP SUBSCRIPTION "${NAME}"`,
      'postgres: DROP DATABASE "hornhoof" WITH (FORCE)',
      'postgres: CREATE DATABASE "hornhoof"',
    ]);
    expect(s.kept()).toMatchObject({ attempt: 2, phase: 'schema' });
    expect(s.databases.get('hornhoof')).toMatchObject({ tables: false });
    /* The next attempt asks for its schema only ten minutes after the giving up. */
    await maker.tick(ORDER);
    expect(s.request()).toBeNull();
    s.later(ENABLE_FOR_MS);
    await maker.tick(ORDER);
    expect(s.request()).toMatchObject({ attempt: 2, database: 'hornhoof' });
    expect(maker.report()).toMatchObject({ state: 'making', name: 'copy_99bb2233aabbccdd_2' });

    s.loaded(2, 'hornhoof');
    const restarted = s.maker();
    await until(s, restarted, 'sync');
    await s.maker().tick(ORDER);
    expect([...s.databases.keys()]).toEqual(['hornhoof']);
    expect([...s.databases.get('hornhoof')!.subs.keys()]).toEqual(['copy_99bb2233aabbccdd_2']);
  });

  it('goes on with a giving up that was cut short, and gives up when its slot is lost', async () => {
    const s = stand();
    const maker = s.maker();
    await maker.tick(null);
    s.loaded();
    await until(s, maker, 'sync');
    await maker.tick({ ...ORDER, slot: 'lost' });
    expect(s.kept()).toMatchObject({ attempt: 2, phase: 'drop' });
    /* As a keeper that stopped after the DISABLE left it. */
    s.databases.get('hornhoof')!.subs.get(NAME)!.enabled = false;
    const first = s.run.length;
    await s.maker().tick(ORDER);
    expect(s.run.slice(first).filter(line => /ALTER SUBSCRIPTION|DROP |CREATE DATABASE/.test(line))).toEqual([
      `hornhoof: DROP SUBSCRIPTION "${NAME}"`,
      'postgres: DROP DATABASE "hornhoof" WITH (FORCE)',
      'postgres: CREATE DATABASE "hornhoof"',
    ]);
  });

  /* A copy that follows: its first attempt, through every step. */
  async function following(s: ReturnType<typeof stand>) {
    const maker = s.maker();
    await maker.tick(null);
    s.loaded();
    await until(s, maker, 'sync');
    const db = s.databases.get('hornhoof')!;
    db.subs.get(NAME)!.rels = ['r'];
    db.pulse = '2026-11-11T11:59:59.000Z';
    await until(s, maker, 'ready');
    await maker.tick({ ...ORDER });
    expect(maker.report()).toMatchObject({ state: 'ready', name: NAME });
    return maker;
  }
  const NEXT = 'copy_99bb2233aabbccdd_2';
  const changes = (s: ReturnType<typeof stand>, from = 0) => s.run.slice(from).filter(line => /ALTER SUBSCRIPTION|ALTER DATABASE|DROP |CREATE DATABASE|CREATE SUBSCRIPTION/.test(line)).map(line => line.replace(/ CONNECTION .*/, ''));
  /* The side database filled: the updater's part, then every table through its first copy. */
  async function remade(s: ReturnType<typeof stand>, maker: CopyMaker, order: CopyOrder = ORDER) {
    await until(s, maker, 'schema', order);
    await maker.tick({ ...order });
    expect(s.request()).toMatchObject({ attempt: 2, database: 'hornhoof_next' });
    s.loaded(2, 'hornhoof_next');
    await until(s, maker, 'sync', order);
    const next = s.databases.get('hornhoof_next')!;
    next.subs.get(NEXT)!.rels = ['r'];
    next.pulse = '2026-11-11T12:00:30.000Z';
    await until(s, maker, 'ready', order);
  }

  it('remakes when its slot is lost', async () => {
    const s = stand();
    const maker = await following(s);
    const from = s.run.length;
    await maker.tick({ ...ORDER, slot: 'lost' });
    /* Written down first: the next attempt, in a database beside the old one, which is still read. */
    expect(s.kept()).toMatchObject({ attempt: 2, database: 'hornhoof_next', phase: 'detach', old: { attempt: 1, migrations: 108 } });
    expect(changes(s, from)).toEqual([]);
    expect(maker.mode()).toBe('read');
    await until(s, maker, 'schema');
    /* The old subscription stops and lets go of its slot, so the leader drops that one; it stays, with its database. */
    expect(changes(s, from)).toEqual([`hornhoof: ALTER SUBSCRIPTION "${NAME}" DISABLE`, `hornhoof: ALTER SUBSCRIPTION "${NAME}" SET (slot_name = NONE)`, 'postgres: CREATE DATABASE "hornhoof_next"']);
    expect(s.databases.get('hornhoof')!.subs.get(NAME)).toMatchObject({ enabled: false, slot: null });
    await maker.tick({ ...ORDER });
    expect(s.request()).toEqual({ attempt: 2, database: 'hornhoof_next', port: 7432, password: PASSWORD });
    expect(maker.report()).toMatchObject({ state: 'remaking', name: NEXT, old: null });
    expect(maker.mode()).toBe('read');
    expect(s.state.lines).toEqual(["This machine's copy is made again: the company server no longer keeps what this copy had still to read. The old one is read until the new one is whole."]);
    /* While the new one fills, the old one is asked how far it reaches on one connection, not on a new one each second. */
    s.loaded(2, 'hornhoof_next');
    await until(s, maker, 'sync');
    const active = [...s.databases.values()].flatMap(database => [...database.subs].filter(([, sub]) => sub.enabled).map(([name]) => name));
    expect(active).toEqual([NEXT]);
    const before = s.opened.filter(database => database === 'hornhoof').length;
    for (let n = 0; n < 5; n++) await maker.tick({ ...ORDER });
    expect(s.opened.filter(database => database === 'hornhoof').length - before).toBeLessThanOrEqual(1);
  });

  it('remakes after two views without its slot', async () => {
    const s = stand();
    const maker = await following(s);
    /* One view that does not list it changes nothing, however many ticks pass with it. */
    const missing = { ...ORDER, slot: 'missing' as const };
    for (let ticks = 0; ticks < 5; ticks++) await maker.tick(missing);
    expect(s.kept()).toMatchObject({ attempt: 1, phase: 'ready', missing: 1 });
    /* A view that lists it again starts the count over. */
    await maker.tick({ ...ORDER });
    await maker.tick({ ...missing });
    expect(s.kept()).toMatchObject({ attempt: 1, phase: 'ready', missing: 1 });
    await maker.tick({ ...missing });
    expect(s.kept()).toMatchObject({ attempt: 2, database: 'hornhoof_next', old: { attempt: 1 } });
    /* A copy the leader never listed yet is not gone for that. */
    const fresh = stand();
    const made = fresh.maker();
    await made.tick(FIRST);
    fresh.loaded();
    await until(fresh, made, 'sync', null);
    fresh.databases.get('hornhoof')!.subs.get(NAME)!.rels = ['r'];
    for (let views = 0; views < 4; views++) await made.tick({ ...missing });
    expect(fresh.kept()).toMatchObject({ attempt: 1, phase: 'ready' });
  });

  it('remakes after a stop that does not mend', async () => {
    const s = stand();
    const maker = await following(s);
    const sub = s.databases.get('hornhoof')!.subs.get(NAME)!;
    /* Stopped for nine minutes, then it holds again: nothing is made again. */
    for (let minutes = 0; minutes < 9; minutes++) {
      sub.enabled = false;
      await maker.tick({ ...ORDER });
      s.later(60_000);
    }
    await maker.tick({ ...ORDER });
    await maker.tick({ ...ORDER });
    expect(s.kept()).toMatchObject({ attempt: 1, phase: 'ready' });
    expect(maker.report()?.state).toBe('ready');
    /* Stopped for ten minutes whatever is tried. */
    for (let minutes = 0; minutes <= 10; minutes++) {
      sub.enabled = false;
      await maker.tick({ ...ORDER });
      s.later(60_000);
    }
    expect(s.kept()).toMatchObject({ attempt: 2, database: 'hornhoof_next', old: { attempt: 1 } });
  });

  it('remakes after a migration', async () => {
    const s = stand();
    const maker = await following(s);
    await maker.tick({ ...ORDER, migrations: null });
    expect(s.kept()).toMatchObject({ attempt: 1, phase: 'ready' });
    await maker.tick({ ...ORDER, migrations: 109 });
    expect(s.kept()).toMatchObject({ attempt: 2, database: 'hornhoof_next', old: { attempt: 1, migrations: 108 } });
    expect(s.state.lines[0]).toContain('the company server runs another version of the database');
  });

  it('holds its subscription for the update', async () => {
    const s = stand();
    const maker = await following(s);
    const sub = s.databases.get('hornhoof')!.subs.get(NAME)!;
    /* The leader's word stopped it: for ten minutes the maker starts nothing, asks nothing and counts nothing. */
    s.state.updating = true;
    sub.enabled = false;
    const from = s.run.length;
    for (let minutes = 0; minutes <= 10; minutes++) {
      await maker.tick({ ...ORDER });
      s.later(60_000);
    }
    expect([s.run.length, sub.enabled, maker.report()?.state]).toEqual([from, false, 'ready']);
    expect(s.kept()).toMatchObject({ attempt: 1, phase: 'ready' });
    /* The word gone and the leader's database as it was: the copy follows again. */
    s.state.updating = false;
    await maker.tick({ ...ORDER });
    expect(changes(s, from)).toEqual([`hornhoof: ALTER SUBSCRIPTION "${NAME}" ENABLE`]);
    await maker.tick({ ...ORDER });
    expect([s.kept().attempt, maker.report()?.state, s.state.lines]).toEqual([1, 'ready', []]);
    /* With the leader's database of another version, it is made again, and not started first. */
    const other = stand();
    const made = await following(other);
    other.state.updating = true;
    other.databases.get('hornhoof')!.subs.get(NAME)!.enabled = false;
    await made.tick({ ...ORDER, migrations: 109 });
    other.later(60_000);
    other.state.updating = false;
    const at = other.run.length;
    await made.tick({ ...ORDER, migrations: 109 });
    expect(other.kept()).toMatchObject({ attempt: 2, database: 'hornhoof_next', phase: 'detach', old: { attempt: 1, migrations: 108 } });
    expect(changes(other, at)).toEqual([]);
  });

  it('remakes nothing while the word holds', async () => {
    const s = stand();
    const maker = await following(s);
    s.state.updating = true;
    const from = s.run.length;
    await maker.tick({ ...ORDER, migrations: 109 });
    for (let views = 0; views < 3; views++) await maker.tick({ ...ORDER, slot: 'missing' });
    expect([s.run.length, s.databases.has('hornhoof_next'), s.request()]).toEqual([from, false, null]);
    /* What the views said is kept. */
    expect(s.kept()).toMatchObject({ attempt: 1, database: 'hornhoof', phase: 'ready', missing: 3 });
    /* The word gone: one remake, against the order of then. */
    s.state.updating = false;
    await maker.tick({ ...ORDER, migrations: 110 });
    expect(s.kept()).toMatchObject({ attempt: 2, database: 'hornhoof_next', phase: 'detach', old: { attempt: 1, migrations: 108 }, missing: 0 });
    expect(s.state.lines).toEqual(["This machine's copy is made again: the company server runs another version of the database. The old one is read until the new one is whole."]);
    /* A remake under way when a word comes stops where it is, and goes on after. */
    s.state.updating = true;
    const under = s.run.length;
    for (let ticks = 0; ticks < 5; ticks++) await maker.tick({ ...ORDER, migrations: 110 });
    expect([s.run.length, s.kept().phase, s.databases.has('hornhoof_next')]).toEqual([under, 'detach', false]);
    s.state.updating = false;
    await until(s, maker, 'schema', { ...ORDER, migrations: 110 });
    await maker.tick({ ...ORDER, migrations: 110 });
    expect(s.request()).toMatchObject({ attempt: 2, database: 'hornhoof_next' });
    expect(changes(s, from).filter(line => line.includes('CREATE DATABASE'))).toEqual(['postgres: CREATE DATABASE "hornhoof_next"']);
  });

  it('gives up an earlier side database whole', async () => {
    const s = stand();
    const maker = await following(s);
    /* A side database an earlier try left, with a subscription of its own. */
    s.add('hornhoof_next', { tables: true }).subs.set('copy_99bb2233aabbccdd_7', { enabled: true, slot: 'copy_99bb2233aabbccdd_7', rels: ['d'] });
    const from = s.run.length;
    await maker.tick({ ...ORDER, slot: 'lost' });
    await until(s, maker, 'schema');
    expect(changes(s, from)).toEqual([
      `hornhoof: ALTER SUBSCRIPTION "${NAME}" DISABLE`,
      `hornhoof: ALTER SUBSCRIPTION "${NAME}" SET (slot_name = NONE)`,
      'hornhoof_next: ALTER SUBSCRIPTION "copy_99bb2233aabbccdd_7" DISABLE',
      'hornhoof_next: DROP SUBSCRIPTION "copy_99bb2233aabbccdd_7"',
      'postgres: DROP DATABASE "hornhoof_next" WITH (FORCE)',
      'postgres: CREATE DATABASE "hornhoof_next"',
    ]);
    /* The same when the new copy itself fails while the old one waits: the old database stays. */
    await maker.tick({ ...ORDER });
    s.loaded(2, 'hornhoof_next');
    await until(s, maker, 'sync');
    await maker.tick({ ...ORDER, slot: 'lost' });
    await until(s, maker, 'schema');
    expect(s.kept()).toMatchObject({ attempt: 3, database: 'hornhoof_next', old: { attempt: 1 } });
    expect(s.databases.has('hornhoof')).toBe(true);
    expect(maker.mode()).toBe('read');
  });

  it('swaps only after the merge', async () => {
    const s = stand();
    const maker = await following(s);
    await maker.tick({ ...ORDER, slot: 'lost' });
    await remade(s, maker);
    await maker.tick({ ...ORDER });
    /* The new copy holds everything; the old database waits for the leader to read it. */
    expect(maker.report()).toEqual({ state: 'ready', progress: null, error: null, at: '2026-11-11T12:00:30.000Z', name: NEXT, old: { attempt: 1 } });
    const from = s.run.length;
    for (const old of ['waiting', null] as const) for (let ticks = 0; ticks < 3; ticks++) await maker.tick({ ...ORDER, old });
    expect(changes(s, from)).toEqual([]);
    expect(maker.mode()).toBe('read');
    /* The leader has read it: the app stands still, and the two change places. */
    await maker.tick({ ...ORDER, old: 'merged' });
    expect(s.kept()).toMatchObject({ swap: 'off' });
    expect(maker.mode()).toBe('off');
    await maker.tick({ ...ORDER, old: 'merged' });
    expect(changes(s, from)).toEqual([]);
    s.later(2000);
    for (let ticks = 0; ticks < 8 && s.kept().swap !== null; ticks++) {
      await maker.tick({ ...ORDER, old: 'merged' });
      if (['disable', 'rename'].includes(String(s.kept().swap))) expect(maker.mode()).toBe('off');
    }
    const stamp = '20261111t120000';
    expect(changes(s, from)).toEqual([
      `hornhoof_next: ALTER SUBSCRIPTION "${NEXT}" DISABLE`,
      `postgres: ALTER DATABASE "hornhoof" RENAME TO "hornhoof_old_${stamp}"`,
      'postgres: ALTER DATABASE "hornhoof_next" RENAME TO "hornhoof"',
      `hornhoof: ALTER SUBSCRIPTION "${NEXT}" ENABLE`,
      /* Parted from its slot when it was detached, the old subscription is pointed nowhere, so its drop asks the
         leader nothing. */
      `hornhoof_old_${stamp}: ALTER SUBSCRIPTION "${NAME}"`,
      `hornhoof_old_${stamp}: DROP SUBSCRIPTION "${NAME}"`,
      `postgres: DROP DATABASE "hornhoof_old_${stamp}" WITH (FORCE)`,
    ]);
    expect(s.run.slice(from).filter(line => line.includes('pg_terminate_backend'))).toHaveLength(1);
    expect(s.run.slice(from).at(-1)).toBe('hornhoof: DO $replica$');
    expect(s.kept()).toMatchObject({ attempt: 2, database: 'hornhoof', phase: 'ready', old: null, swap: null });
    expect([...s.databases.keys()]).toEqual(['hornhoof']);
    expect(maker.mode()).toBe('read');
    await maker.tick({ ...ORDER });
    expect(maker.report()).toEqual({ state: 'ready', progress: null, error: null, at: '2026-11-11T12:00:30.000Z', name: NEXT, old: null });
    /* The leader left the old one out, as the CEO said: the same. */
    const left = stand();
    const again = await following(left);
    await again.tick({ ...ORDER, slot: 'lost' });
    await remade(left, again);
    await again.tick({ ...ORDER, old: 'done' });
    expect(left.kept()).toMatchObject({ swap: 'off' });
  });

  it('finishes a half-done swap', async () => {
    const s = stand();
    const maker = await following(s);
    await maker.tick({ ...ORDER, slot: 'lost' });
    await remade(s, maker);
    await maker.tick({ ...ORDER, old: 'merged' });
    s.later(2000);
    /* Up to the renames, and then the keeper stops. */
    while (s.kept().swap !== 'enable') await maker.tick({ ...ORDER, old: 'merged' });
    const from = s.run.length;
    const started = s.maker();
    expect(started.mode()).toBe('read');
    for (let ticks = 0; ticks < 6 && s.kept().swap !== null; ticks++) await started.tick(null);
    const stamp = '20261111t120000';
    expect(changes(s, from)).toEqual([
      `hornhoof: ALTER SUBSCRIPTION "${NEXT}" ENABLE`,
      /* Parted from its slot when it was detached, the old subscription is pointed nowhere, so its drop asks the
         leader nothing. */
      `hornhoof_old_${stamp}: ALTER SUBSCRIPTION "${NAME}"`,
      `hornhoof_old_${stamp}: DROP SUBSCRIPTION "${NAME}"`,
      `postgres: DROP DATABASE "hornhoof_old_${stamp}" WITH (FORCE)`,
    ]);
    expect(s.kept()).toMatchObject({ attempt: 2, database: 'hornhoof', phase: 'ready', old: null, swap: null });
    /* Stopped between the two renames: only the second is left to do. */
    const between = stand();
    const one = await following(between);
    await one.tick({ ...ORDER, slot: 'lost' });
    await remade(between, one);
    await one.tick({ ...ORDER, old: 'merged' });
    between.later(2000);
    while (between.kept().swap !== 'rename') await one.tick({ ...ORDER, old: 'merged' });
    between.databases.set(`hornhoof_old_${stamp}`, between.databases.get('hornhoof')!);
    between.databases.delete('hornhoof');
    const mark = between.run.length;
    await between.maker().tick(null);
    expect(changes(between, mark)).toEqual(['postgres: ALTER DATABASE "hornhoof_next" RENAME TO "hornhoof"']);
  });

  it('halts every subscription of its databases, and drops none', async () => {
    const s = stand();
    const maker = s.maker();
    await maker.tick(null);
    s.loaded();
    await until(s, maker, 'sync');
    /* A copy that is being made again has a second database, with a subscription of its own. */
    s.add('hornhoof_next').subs.set('copy_99bb2233aabbccdd_2', { enabled: true, slot: 'copy_99bb2233aabbccdd_2', rels: ['i'] });
    const before = s.run.length;
    await maker.halt();
    expect(s.databases.get('hornhoof')!.subs.get(NAME)).toMatchObject({ enabled: false, slot: NAME });
    expect(s.databases.get('hornhoof_next')!.subs.get('copy_99bb2233aabbccdd_2')).toMatchObject({ enabled: false, slot: 'copy_99bb2233aabbccdd_2' });
    const did = s.run.slice(before).filter(line => !line.includes('SELECT'));
    expect(did).toEqual([`hornhoof: ALTER SUBSCRIPTION "${NAME}" DISABLE`, 'hornhoof_next: ALTER SUBSCRIPTION "copy_99bb2233aabbccdd_2" DISABLE']);
    /* Halted already, or with no second database: nothing more is done. */
    s.databases.delete('hornhoof_next');
    const again = s.run.length;
    await maker.halt();
    expect(s.run.slice(again).filter(line => !line.includes('SELECT'))).toEqual([]);
  });

  const A_ID = 'a0'.repeat(32);
  const B_ID = 'b0'.repeat(32);
  const FROM_A: CopyOrder = { ...ORDER, leader: A_ID, join: null };
  /* A copy made on A, as the views of A named it. */
  async function followingA(s: ReturnType<typeof stand>) {
    const maker = s.maker();
    await maker.tick(null);
    s.loaded();
    await until(s, maker, 'sync', FROM_A);
    const db = s.databases.get('hornhoof')!;
    db.subs.get(NAME)!.rels = ['r'];
    db.pulse = '2026-11-11T11:59:59.000Z';
    db.passfile = true;
    await until(s, maker, 'ready', FROM_A);
    await maker.tick({ ...FROM_A });
    expect([maker.report()?.state, s.kept().leader]).toEqual(['ready', A_ID]);
    return maker;
  }

  it("waits for the new leader's word before a remake", async () => {
    /* The server moved to B: A dropped its slots, so the copy's subscription stopped, and B does not list its slot. */
    const joining = stand();
    const first = await followingA(joining);
    joining.databases.get('hornhoof')!.subs.get(NAME)!.enabled = false;
    joining.later(ENABLE_FOR_MS + 1000);
    await first.tick({ ...FROM_A, leader: B_ID, slot: 'missing', join: NEXT });
    /* B made it a slot, since it held everything A wrote: it joins, and is not made again. */
    expect(joining.kept()).toMatchObject({ attempt: 2, database: 'hornhoof', phase: 'join', slot: NEXT, leader: B_ID, old: null });
    for (let ticks = 0; ticks < 4; ticks++) await first.tick({ ...FROM_A, leader: B_ID, slot: 'ok', join: null });
    expect(joining.kept()).toMatchObject({ attempt: 2, database: 'hornhoof', phase: 'ready', leader: B_ID, old: null });
    expect(first.report()).toMatchObject({ state: 'ready', name: NEXT, old: null });
    expect(joining.state.lines).toEqual([]);

    /* B names no slot for it, in two views in a row: it did not hold everything, and is made again from B. */
    const behind = stand();
    const second = await followingA(behind);
    behind.databases.get('hornhoof')!.subs.get(NAME)!.enabled = false;
    behind.later(ENABLE_FOR_MS + 1000);
    const view = { ...FROM_A, leader: B_ID, slot: 'missing' as const, join: null };
    for (let ticks = 0; ticks < 4; ticks++) await second.tick(view);
    /* One view, however many ticks pass with it, decides nothing. */
    expect(behind.kept()).toMatchObject({ attempt: 1, phase: 'ready', leader: A_ID, old: null });
    await second.tick({ ...view });
    expect(behind.kept()).toMatchObject({ attempt: 2, database: 'hornhoof_next', phase: 'detach', leader: B_ID, old: { attempt: 1 } });
    expect(behind.state.lines).toEqual(["This machine's copy is made again: the company server moved to a machine that does not hold a place for this copy. The old one is read until the new one is whole."]);
    /* A view of A's again in between starts the count anew. */
    const back = stand();
    const third = await followingA(back);
    await third.tick({ ...view });
    await third.tick({ ...FROM_A });
    await third.tick({ ...view });
    expect(back.kept()).toMatchObject({ attempt: 1, phase: 'ready', leader: A_ID });
  });

  it('joins a slot with no copy of the data', async () => {
    /* As a machine that handed the server over starts to follow: its database holds everything, and no passfile. */
    const s = stand();
    Object.assign(s.databases.get('hornhoof')!, { tables: true, led: true, handed: true, pulse: '2026-11-11T11:59:59.000Z' });
    const slot = 'copy_99bb2233aabbccdd_1';
    writeFileSync(join(s.dir, COPY_STATE), JSON.stringify({ attempt: 1, database: 'hornhoof', phase: 'join', slot, leader: B_ID }));
    const maker = s.maker();
    const order = { ...ORDER, leader: B_ID, join: null, slot: 'ok' as const, migrations: 109 };
    for (let ticks = 0; ticks < 3; ticks++) await maker.tick(order);
    /* The updater is asked for the passfile alone, once. */
    expect(s.request()).toEqual({ attempt: 1, database: 'hornhoof', port: 7432, password: PASSWORD, only: 'passfile' });
    expect(changes(s)).toEqual([]);
    expect([maker.report()?.state, maker.mode()]).toEqual(['making', 'off']);
    s.databases.get('hornhoof')!.passfile = true;
    rmSync(join(s.controlDir, SCHEMA_FILE));
    for (let ticks = 0; ticks < 3; ticks++) await maker.tick(order);
    expect(s.request()).toBeNull();
    const made = s.run.filter(line => line.includes('CREATE SUBSCRIPTION'));
    expect(made).toEqual([
      `hornhoof: CREATE SUBSCRIPTION "${slot}" CONNECTION 'host=keeper port=7432 dbname=hornhoof user=hornhoof_replica passfile=/var/lib/postgresql/data/replica.pgpass' PUBLICATION "hornhoof" WITH (create_slot = false, slot_name = '${slot}', copy_data = false, synchronous_commit = 'local', binary = false, streaming = off, disable_on_error = true)`,
    ]);
    expect(s.run).toContain("hornhoof: ALTER SYSTEM SET wal_receiver_status_interval = '1s'");
    expect(s.kept()).toMatchObject({ attempt: 1, database: 'hornhoof', phase: 'ready', leader: B_ID, migrations: 109 });
    expect(maker.report()).toMatchObject({ state: 'ready', name: slot, at: '2026-11-11T11:59:59.000Z' });
    expect(maker.mode()).toBe('read');
    for (const text of [...s.run, ...s.state.lines]) expect(text).not.toContain(PASSWORD);
  });

  it("moves to the new leader's slot", async () => {
    const s = stand();
    const maker = await followingA(s);
    const from = s.run.length;
    const slot = 'copy_99bb2233aabbccdd_4';
    const order = { ...FROM_A, leader: B_ID, slot: 'missing' as const, join: slot };
    await maker.tick({ ...order });
    /* Written down first, before the old subscription is touched. */
    expect(s.kept()).toMatchObject({ attempt: 4, database: 'hornhoof', phase: 'join', slot, leader: B_ID });
    expect(changes(s, from)).toEqual([]);
    /* A keeper that starts again in the middle, with the old subscription still there, drops it before it joins. */
    const again = s.maker();
    for (let ticks = 0; ticks < 4; ticks++) await again.tick(order);
    expect(changes(s, from)).toEqual([
      `hornhoof: ALTER SUBSCRIPTION "${NAME}" DISABLE`,
      `hornhoof: ALTER SUBSCRIPTION "${NAME}" SET (slot_name = NONE)`,
      `hornhoof: DROP SUBSCRIPTION "${NAME}"`,
      `hornhoof: CREATE SUBSCRIPTION "${slot}"`,
    ]);
    expect(s.kept()).toMatchObject({ attempt: 4, phase: 'ready', leader: B_ID });
    expect(again.report()).toMatchObject({ state: 'ready', name: slot });
    /* A slot that is not above its own attempt, as of a switch before, is none to join. */
    await again.tick({ ...order, join: 'copy_99bb2233aabbccdd_3', slot: 'ok' });
    expect(s.kept()).toMatchObject({ attempt: 4, phase: 'ready' });
  });

  it('counts a handed database as no led one', async () => {
    const s = stand();
    Object.assign(s.databases.get('hornhoof')!, { tables: true, led: true, handed: true });
    const maker = s.maker();
    for (let tries = 0; tries < 3; tries++) await maker.tick(ORDER);
    expect(maker.report()?.error).not.toBe('led');
    /* One that led and handed nothing over stays untouched, as before. */
    s.databases.get('hornhoof')!.handed = false;
    for (let tries = 0; tries < 3; tries++) await maker.tick(ORDER);
    expect(maker.report()).toMatchObject({ state: 'stopped', error: 'led' });
  });

  it('keeps a database that led', async () => {
    const s = stand();
    const maker = await following(s);
    await maker.tick({ ...ORDER, slot: 'lost' });
    await remade(s, maker);
    await maker.tick({ ...ORDER, old: 'merged' });
    s.later(2000);
    /* The old database once held a term of the company. */
    s.databases.get('hornhoof')!.led = true;
    for (let ticks = 0; ticks < 10; ticks++) await maker.tick({ ...ORDER, old: 'merged' });
    expect(s.run.some(line => line.includes('DROP DATABASE "hornhoof_old_'))).toBe(false);
    expect([...s.databases.keys()].sort()).toEqual(['hornhoof', 'hornhoof_old_20261111t120000']);
    expect(maker.report()).toMatchObject({ state: 'stopped', error: 'led' });
    expect(s.kept()).toMatchObject({ swap: 'drop_db' });
    /* The new copy is in place and is read. */
    expect(maker.mode()).toBe('read');
  });

  /* The leader's side on, and the updater's part played whenever the maker asks: a run of seconds of virtual time, each
     with one look of the leader's. What every second leaves on the leader is counted. */
  async function run(s: ReturnType<typeof stand>, maker: CopyMaker, seconds: number, done: () => boolean = () => false) {
    const seen = { most: 0, asked: [] as { attempt: number; at: number }[] };
    const begun = s.state.now.getTime();
    for (let second = 0; second < seconds && !done(); second++) {
      const asked = s.request() as { attempt: number; database: string } | null;
      if (asked) {
        seen.asked.push({ attempt: asked.attempt, at: (s.state.now.getTime() - begun) / 60_000 });
        s.loaded(asked.attempt, asked.database);
      }
      await maker.tick({ ...ORDER, migrations: s.leader.migrations });
      seen.most = Math.max(seen.most, s.leader.slots.size);
      s.later(1000);
    }
    return seen;
  }

  it("takes the leader's new schema before it follows, and leaves no slot of the attempt behind", async () => {
    const s = stand();
    s.leader.live = true;
    s.leader.breaks = true;
    const maker = s.maker();
    await maker.tick(FIRST);
    s.loaded();
    await until(s, maker, 'sync');
    /* The first copy runs: the leader keeps the subscription's slot and one for each table it copies. */
    expect(s.leader.slots.size).toBe(3);
    /* The leader is updated meanwhile, and its new migration adds a column this copy's tables lack: the update stopped
       the subscription, and enabled it would stop again on the first row of that table. */
    s.leader.breaks = false;
    s.leader.migrations = 109;
    s.databases.get('hornhoof')!.subs.get(NAME)!.enabled = false;
    const from = s.run.length;
    const seen = await run(s, maker, 3 * 3600, () => maker.report()?.state === 'ready');
    /* Never started on the schema of before: given up at once, and made again with the leader's schema now. */
    expect(s.run.slice(from).filter(line => line.startsWith('hornhoof: ALTER SUBSCRIPTION') && line.endsWith('ENABLE'))).toEqual([]);
    expect(maker.report()).toMatchObject({ state: 'ready', name: NEXT });
    expect(s.kept()).toMatchObject({ attempt: 2, phase: 'ready', migrations: 109 });
    expect(seen.asked.map(({ attempt }) => attempt)).toEqual([2]);
    expect(seen.asked[0]!.at).toBeLessThan(1);
    expect(s.state.lines).toEqual(["This copy was being made with the company server's schema of before the server's update: it is made again with the schema the server has now."]);
    /* The attempt given up left nothing on the leader: only the slot of the copy that follows is there. */
    expect([...s.leader.slots]).toEqual([NEXT]);
    expect(seen.most).toBe(3);
  });

  it('goes on with a first copy that its link cuts again and again while its tables get through, and gives up one that gets nothing more through', async () => {
    const s = stand();
    const maker = s.maker();
    await maker.tick(null);
    s.loaded();
    await until(s, maker, 'sync');
    const sub = s.databases.get('hornhoof')!.subs.get(NAME)!;
    sub.rels = Array.from({ length: 40 }, () => 'i');
    /* A slow link that drops within a minute of each start: Postgres stops the subscription on each cut, as on any error
       of a table's first copy, so no enabling holds a minute. One more table gets through between two cuts. */
    for (let minute = 0; minute < 25; minute++) {
      sub.rels[minute] = 'r';
      sub.enabled = false;
      await maker.tick({ ...ORDER });
      s.later(60_000);
    }
    expect(s.kept()).toMatchObject({ attempt: 1, phase: 'sync', given: 0 });
    expect(maker.report()).toMatchObject({ state: 'making', name: NAME });
    /* Nothing more gets through: ten minutes stopped, and the attempt is given up, as one that breaks each time it starts. */
    for (let minute = 0; minute <= 10; minute++) {
      sub.enabled = false;
      await maker.tick({ ...ORDER });
      s.later(60_000);
    }
    expect(s.kept()).toMatchObject({ attempt: 2, given: 1 });
  });

  it('frees the origins of tables whose first copy was broken off before it starts its subscription again', async () => {
    const s = stand();
    const maker = s.maker();
    await maker.tick(null);
    s.loaded();
    await until(s, maker, 'sync');
    const db = s.databases.get('hornhoof')!;
    const sub = db.subs.get(NAME)!;
    sub.rels = ['r', 'd', 'd', 'i'];
    /* While it runs, nothing of it is touched. */
    db.leftovers = ['pg_16500_2', 'pg_16500_3'];
    await maker.tick({ ...ORDER });
    expect(db.leftovers).toEqual(['pg_16500_2', 'pg_16500_3']);
    /* A cut stopped it: each table whose rows were going over keeps its origin, and the next start would begin other
       tables, each with an origin of its own, until the copy's Postgres has none left. */
    s.later(60_000);
    sub.enabled = false;
    const before = s.run.length;
    await maker.tick({ ...ORDER });
    expect(db.leftovers).toEqual([]);
    const after = s.run.slice(before);
    const dropped = after.findIndex(line => line.includes('pg_replication_origin_drop'));
    const enabled = after.findIndex(line => line.endsWith('ENABLE'));
    expect(dropped).toBeGreaterThanOrEqual(0);
    expect(enabled).toBeGreaterThan(dropped);
  });

  it('gives up an attempt while the leader holds its connection without an answer, and leaves nothing running', async () => {
    const s = stand();
    const maker = s.maker();
    await maker.tick(FIRST);
    s.loaded();
    await until(s, maker, 'sync');
    /* The copy was taking its tables' first copies when a cut stopped its subscription and its slot was lost, and the
       link to the leader now takes a connection and answers nothing on it. */
    s.databases.get('hornhoof')!.subs.get(NAME)!.enabled = false;
    s.leader.live = true;
    s.leader.hangs = true;
    for (let second = 0; second < 60; second++) {
      await maker.tick({ ...ORDER, slot: 'lost' });
      s.later(1000);
    }
    /* Nothing is left waiting in the copy's Postgres for the next tick to pile onto, and the attempt is gone whole: its
       subscription asked the leader once, then parted from it and went. */
    expect(s.running).toEqual([]);
    expect(s.kept()).toMatchObject({ attempt: 2, phase: 'schema' });
    expect([...s.databases.get('hornhoof')!.subs.keys()]).toEqual([]);
    expect(s.run.filter(line => line.includes('DROP SUBSCRIPTION'))).toHaveLength(2);
  });

  it('gives up an attempt whose subscription stops each time it starts, takes its slots with it and waits longer each time, and parks the copy at the fourth', async () => {
    const s = stand();
    s.leader.live = true;
    s.leader.breaks = true;
    const maker = s.maker();
    await maker.tick(FIRST);
    s.loaded();
    await until(s, maker, 'sync');
    /* Every start stops on its first error, which one look still finds it running before. */
    const seen = await run(s, maker, 4 * 3600);
    /* Ten minutes stopped, then the wait before the next request: ten minutes, twice as long each time after. The
       fourth attempt given up in a row is the last: no fifth is asked for. */
    expect(seen.asked.map(({ attempt }) => attempt)).toEqual([2, 3, 4]);
    expect(seen.asked.map(({ at }) => Math.round(at))).toEqual([20, 50, 100]);
    /* An attempt given up takes its slot and those of its tables' first copies with it, so they never pile up. */
    expect(seen.most).toBe(3);
    expect(s.kept()).toMatchObject({ attempt: 5, phase: 'parked', given: 4 });
    expect([...s.leader.slots]).toEqual([]);
    expect([...s.databases.get('hornhoof')!.subs.keys()]).toEqual([]);
    expect(maker.report()).toMatchObject({ state: 'stopped', error: 'apply', gaveUp: { attempts: 4 } });
    expect(s.state.lines.filter(line => line.includes('gives up this copy'))).toHaveLength(1);
    /* A parked copy asks for nothing, however long it stands, and holds no slot of the leader's. */
    s.later(48 * 3600_000);
    for (let n = 0; n < 20; n++) await maker.tick({ ...ORDER, migrations: s.leader.migrations });
    expect(s.request()).toBeNull();
    expect(s.kept()).toMatchObject({ attempt: 5, phase: 'parked', given: 4 });
    expect(maker.report()).toMatchObject({ state: 'stopped', gaveUp: { attempts: 4 } });
    expect([...s.leader.slots]).toEqual([]);
    expect(maker.mode()).toBe('off');
  });

  it("parks a copy whose leader is out of reach all the same, and leaves its slots to the leader's sweep", async () => {
    const s = stand();
    s.leader.live = true;
    s.leader.breaks = true;
    const maker = s.maker();
    await maker.tick(FIRST);
    s.loaded();
    await until(s, maker, 'sync');
    await run(s, maker, 3 * 3600, () => s.kept().attempt === 4 && s.kept().phase === 'sync');
    expect(s.leader.slots.size).toBe(3);
    s.leader.reachable = false;
    await run(s, maker, 3 * 3600, () => s.kept().phase === 'parked');
    expect(s.kept()).toMatchObject({ phase: 'parked', given: 4 });
    expect([...s.databases.get('hornhoof')!.subs.keys()]).toEqual([]);
    expect(s.leader.slots.size).toBe(3);
    expect(s.state.lines.filter(line => line.includes('Could not drop'))).toHaveLength(1);
  });

  it('ends an attempt whose subscription is cut thirty times, however many tables got through between the cuts', async () => {
    const s = stand();
    const maker = s.maker();
    await maker.tick(null);
    s.loaded();
    await until(s, maker, 'sync');
    const sub = s.databases.get('hornhoof')!.subs.get(NAME)!;
    sub.rels = Array.from({ length: 80 }, () => 'i');
    for (let minute = 0; minute < 29; minute++) {
      sub.rels[minute] = 'r';
      sub.enabled = false;
      await maker.tick({ ...ORDER });
      s.later(60_000);
    }
    expect(s.kept()).toMatchObject({ attempt: 1, phase: 'sync', given: 0, cuts: 29 });
    /* The thirtieth cut: a link that cuts each time a table has hardly started, over and over, loads the leader with a
       new slot and a new snapshot for each, so the attempt is given up with a table gone through now and then. */
    sub.rels[29] = 'r';
    sub.enabled = false;
    await maker.tick({ ...ORDER });
    s.later(60_000);
    await maker.tick({ ...ORDER });
    expect(s.kept()).toMatchObject({ attempt: 2, given: 1, cuts: 0 });
  });

  it('gives up an attempt that goes no further for two hours although nothing stops its subscription, and goes on with one that still grows', async () => {
    const s = stand();
    const maker = s.maker();
    await maker.tick(null);
    s.loaded();
    await until(s, maker, 'sync');
    const db = s.databases.get('hornhoof')!;
    db.subs.get(NAME)!.rels = Array.from({ length: 40 }, () => 'i');
    /* A table that starts again from its first row each time holds the database where it was: a few bytes more or less. */
    for (let minute = 0; minute < 100; minute++) {
      db.size = (minute % 2) * 1024;
      await maker.tick({ ...ORDER });
      s.later(60_000);
    }
    expect(s.kept()).toMatchObject({ attempt: 1, phase: 'sync', given: 0 });
    /* A copy that grows by 8 MiB in the two hours has not stood still, however slowly. */
    db.size = 9 * MIB;
    await maker.tick({ ...ORDER });
    s.later(100 * 60_000);
    await maker.tick({ ...ORDER });
    expect(s.kept()).toMatchObject({ attempt: 1, phase: 'sync', given: 0 });
    /* Two hours with nothing more: given up, as an attempt whose subscription stopped. */
    s.later(21 * 60_000);
    await maker.tick({ ...ORDER });
    expect(s.kept()).toMatchObject({ attempt: 2, phase: 'drop', given: 1 });
  });

  it('counts attempts given up in a row until the copy has been whole for an hour', async () => {
    const s = stand();
    s.leader.live = true;
    s.leader.breaks = true;
    const maker = s.maker();
    await maker.tick(FIRST);
    s.loaded();
    await until(s, maker, 'sync');
    await run(s, maker, 3 * 3600, () => s.kept().attempt === 4 && s.kept().phase === 'schema');
    expect(s.kept()).toMatchObject({ attempt: 4, given: 3 });
    /* Once applies hold again, the copy is made whole. One that broke again at once would count on from three. */
    s.leader.breaks = false;
    await run(s, maker, 3 * 3600, () => maker.report()?.state === 'ready');
    expect(maker.report()).toMatchObject({ state: 'ready', name: 'copy_99bb2233aabbccdd_4' });
    expect(s.kept()).toMatchObject({ given: 3 });
    s.later(3_600_000 - 5000);
    await maker.tick({ ...ORDER, migrations: s.leader.migrations });
    expect(s.kept()).toMatchObject({ given: 3 });
    s.later(6000);
    await maker.tick({ ...ORDER, migrations: s.leader.migrations });
    expect(s.kept()).toMatchObject({ given: 0, phase: 'ready' });
  });

  it('remakes a copy that broke soon after it was whole, after a wait that grows, and parks it at the limit', async () => {
    const readyAt = (s: ReturnType<typeof stand>, ago: number) => new Date(s.state.now.getTime() - ago).toISOString();
    /* Two attempts given up before, whole for ten minutes: the third waits forty. */
    const once = stand();
    const kept = await following(once);
    await kept.stop();
    writeFileSync(join(once.dir, COPY_STATE), JSON.stringify({ ...once.kept(), given: 2, readyAt: readyAt(once, 600_000) }));
    const again = once.maker();
    await again.tick({ ...ORDER, slot: 'lost' });
    expect(once.kept()).toMatchObject({ attempt: 2, phase: 'detach', given: 3, old: { attempt: 1 } });
    expect(Date.parse(once.kept().notBefore as string) - once.state.now.getTime()).toBe(2400_000);
    /* The fourth in a row: the old copy stays read, no new one is made, and none is asked for. */
    const last = stand();
    await (await following(last)).stop();
    writeFileSync(join(last.dir, COPY_STATE), JSON.stringify({ ...last.kept(), given: 3, readyAt: readyAt(last, 600_000) }));
    const parked = last.maker();
    await parked.tick({ ...ORDER, slot: 'lost' });
    for (let n = 0; n < 6; n++) await parked.tick({ ...ORDER });
    expect(last.kept()).toMatchObject({ phase: 'parked', given: 4, old: { attempt: 1 } });
    expect(last.request()).toBeNull();
    expect(parked.mode()).toBe('read');
    expect(parked.report()).toMatchObject({ state: 'stopped', error: 'apply', gaveUp: { attempts: 4 } });
    /* One that was whole for an hour first starts the count over, and is remade at once. */
    const stable = stand();
    await (await following(stable)).stop();
    writeFileSync(join(stable.dir, COPY_STATE), JSON.stringify({ ...stable.kept(), given: 3, readyAt: readyAt(stable, 3_700_000) }));
    const fresh = stable.maker();
    await fresh.tick({ ...ORDER, slot: 'lost' });
    expect(stable.kept()).toMatchObject({ attempt: 2, phase: 'detach', given: 1, notBefore: null });
  });

  it('makes a copy that was given up again only when the CEO asks for it by hand', async () => {
    const s = stand();
    s.leader.live = true;
    s.leader.breaks = true;
    const maker = s.maker();
    await maker.tick(FIRST);
    s.loaded();
    await until(s, maker, 'sync');
    await run(s, maker, 6 * 3600, () => s.kept().phase === 'parked');
    expect(s.kept()).toMatchObject({ attempt: 5, phase: 'parked', given: 4 });
    /* Applies hold again; a copy given up still waits for the word, however long it has stood. */
    s.leader.breaks = false;
    s.later(72 * 3600_000);
    for (let n = 0; n < 5; n++) await maker.tick({ ...ORDER, migrations: s.leader.migrations });
    expect(s.kept()).toMatchObject({ phase: 'parked' });
    expect(s.request()).toBeNull();
    /* The word: the next attempt begins in the empty database, with the count starting over, under the number it was given. */
    await maker.tick({ ...ORDER, migrations: s.leader.migrations, retry: true });
    expect(s.kept()).toMatchObject({ attempt: 5, phase: 'schema', given: 0, cuts: 0, parked: null });
    expect(maker.report()).toMatchObject({ state: 'making', name: 'copy_99bb2233aabbccdd_5' });
    expect(maker.report()?.gaveUp).toBeUndefined();
    await run(s, maker, 3 * 3600, () => maker.report()?.state === 'ready');
    expect(maker.report()).toMatchObject({ state: 'ready', name: 'copy_99bb2233aabbccdd_5' });
    /* A word that comes again after the copy was made is no word for a copy that is not given up. */
    await maker.tick({ ...ORDER, migrations: s.leader.migrations, retry: true });
    expect(maker.report()).toMatchObject({ state: 'ready' });
  });

  it.each(['slow', 'late'] as const)('makes no copy over a path the leader measured %s for it, and goes on by itself when the path is mended', async weak => {
    const s = stand();
    s.leader.live = true;
    const maker = s.maker();
    await maker.tick(FIRST);
    s.loaded();
    await until(s, maker, 'sync');
    expect(s.leader.slots.size).toBeGreaterThan(0);
    /* The slots of what was made go with it, and no attempt is counted given up. */
    await maker.tick({ ...ORDER, migrations: s.leader.migrations, weak });
    for (let n = 0; n < 4; n++) await maker.tick({ ...ORDER, migrations: s.leader.migrations, weak });
    expect(s.kept()).toMatchObject({ attempt: 2, phase: 'parked', given: 0, parked: { why: weak, attempts: 0 } });
    expect([...s.leader.slots]).toEqual([]);
    expect(maker.report()).toMatchObject({ state: 'stopped', error: 'apply', gaveUp: { why: weak } });
    expect(s.request()).toBeNull();
    /* The path stays weak: nothing is made, however long. */
    s.later(24 * 3600_000);
    for (let n = 0; n < 5; n++) await maker.tick({ ...ORDER, migrations: s.leader.migrations, weak });
    expect(s.kept()).toMatchObject({ phase: 'parked' });
    expect(s.request()).toBeNull();
    /* The leader no longer says so: the copy is made. */
    await maker.tick({ ...ORDER, migrations: s.leader.migrations });
    expect(s.kept()).toMatchObject({ attempt: 2, phase: 'schema', parked: null, given: 0 });
    await run(s, maker, 3 * 3600, () => maker.report()?.state === 'ready');
    expect(maker.report()).toMatchObject({ state: 'ready', name: 'copy_99bb2233aabbccdd_2' });
  });

  it('keeps a copy that is whole over a path measured weak, and parks one that is being made again beside it', async () => {
    const s = stand();
    const maker = await following(s);
    await maker.tick({ ...ORDER, weak: 'slow' });
    expect(s.kept()).toMatchObject({ attempt: 1, phase: 'ready', parked: null });
    expect(maker.report()).toMatchObject({ state: 'ready' });
    await maker.tick({ ...ORDER, slot: 'lost' });
    await until(s, maker, 'schema');
    await maker.tick({ ...ORDER, weak: 'slow' });
    expect(s.kept()).toMatchObject({ phase: 'drop', parked: { why: 'slow' }, old: { attempt: 1 } });
    await maker.tick({ ...ORDER, weak: 'slow' });
    expect(s.kept()).toMatchObject({ phase: 'parked' });
    expect(maker.mode()).toBe('read');
  });

  it('leaves a copy that is whole and follows alone: no cut, no attempt, no wait', async () => {
    const s = stand();
    const maker = await following(s);
    for (let hour = 0; hour < 30; hour++) {
      s.later(3_600_000);
      await maker.tick({ ...ORDER });
    }
    expect(s.kept()).toMatchObject({ attempt: 1, phase: 'ready', given: 0, cuts: 0, parked: null });
    expect(maker.report()).toMatchObject({ state: 'ready', name: NAME });
    expect(maker.report()?.gaveUp).toBeUndefined();
  });
});
