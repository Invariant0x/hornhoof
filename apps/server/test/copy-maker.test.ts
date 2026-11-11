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
const ORDER: CopyOrder = { slot: 'ok', leaderSize: 4 * MIB, migrations: 108, old: null, upload: null };

type Sub = { enabled: boolean; slot: string | null; rels: string[] };
type Database = { tables: boolean; led: boolean; migrations: number; size: number; pulse: string | null; subs: Map<string, Sub> };

/* The copy's own database server, as far as the maker asks it: each statement it knows changes what a test set up, and
   every statement is kept, with the database it ran on. */
function cluster() {
  const databases = new Map<string, Database>();
  const run: string[] = [];
  const add = (name: string, over: Partial<Database> = {}) => {
    const database: Database = { tables: false, led: false, migrations: 108, size: 0, pulse: null, subs: new Map(), ...over };
    databases.set(name, database);
    return database;
  };
  const nameIn = (text: string): string => /"([^"]+)"/.exec(text)![1]!;
  const answer = (on: string, text: string, params: unknown[] = []): Record<string, unknown>[] => {
    const db = databases.get(on);
    if (on !== 'postgres' && !db) throw new Error(`database "${on}" does not exist`);
    if (text.includes("to_regclass('net_local.state')")) return [{ there: db!.tables }];
    if (text.includes('FROM net_local.state')) return [{ led: db!.led }];
    if (text.includes('FROM pg_tables')) return [{ there: db!.tables }];
    if (text.includes('drizzle.__drizzle_migrations')) return [{ n: db!.migrations }];
    if (text.startsWith('DO $replica$')) return [];
    if (text.includes('FROM pg_subscription s')) return [...db!.subs].map(([name, sub]) => ({ name, oid: 16500, enabled: sub.enabled, slot: sub.slot }));
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
      db!.subs.set(nameIn(text), { enabled: true, slot: nameIn(text), rels: ['i', 'i'] });
      return [];
    }
    if (text.includes('FROM pg_subscription_rel')) {
      const rels = [...db!.subs.values()][0]?.rels ?? [];
      return [{ total: rels.length, ready: rels.filter(state => state === 'r').length }];
    }
    if (text.includes('pg_database_size')) return [{ size: db!.size }];
    if (text === 'SELECT at FROM net.pulse') return db!.pulse ? [{ at: db!.pulse }] : [];
    if (text.startsWith('ALTER SUBSCRIPTION')) {
      const sub = db!.subs.get(nameIn(text))!;
      if (text.endsWith('ENABLE')) sub.enabled = true;
      else if (text.endsWith('DISABLE')) sub.enabled = false;
      else if (text.endsWith('SET (slot_name = NONE)')) sub.slot = null;
      return [];
    }
    if (text.startsWith('DROP SUBSCRIPTION')) {
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
  const sqlOn = (on: string): Sql & { close(): Promise<void> } => (opened.push(on), {
    query: async <R>(text: string, params?: unknown[]) => {
      run.push(`${on}: ${text.startsWith('DO $replica$') ? 'DO $replica$' : text}`);
      return { rows: answer(on, text, params) as R[] };
    },
    close: async () => undefined,
  });
  return { databases, run, add, sqlOn, opened };
}

function stand(over: { diskFree?: number } = {}) {
  const controlDir = mkdtempSync(join(tmpdir(), 'hh-copy-control-'));
  const dir = mkdtempSync(join(tmpdir(), 'hh-copy-keeper-'));
  onTestFinished(() => void [controlDir, dir].forEach(folder => rmSync(folder, { recursive: true, force: true })));
  const c = cluster();
  c.add('hornhoof');
  const state = { now: new Date('2026-11-11T12:00:00Z'), lines: [] as string[], diskFree: over.diskFree ?? 50 * 2 ** 30 };
  const maker = () =>
    new CopyMaker({
      admin: c.sqlOn('postgres'), db: c.sqlOn, controlDir, dir, networkId: NETWORK_ID, password: PASSWORD, diskFree: () => state.diskFree, log: line => state.lines.push(line), now: () => state.now,
    });
  const later = (ms: number) => void (state.now = new Date(state.now.getTime() + ms));
  const request = () => (existsSync(join(controlDir, SCHEMA_FILE)) ? (JSON.parse(readFileSync(join(controlDir, SCHEMA_FILE), 'utf8')) as Record<string, unknown>) : null);
  const kept = () => JSON.parse(readFileSync(join(dir, COPY_STATE), 'utf8')) as Record<string, unknown>;
  /* The updater's part: the leader's schema loaded into the database the request names. */
  const loaded = (attempt = 1, database = 'hornhoof') => {
    c.databases.get(database)!.tables = true;
    mkdirSync(join(controlDir, 'schema'), { recursive: true });
    writeFileSync(join(controlDir, 'schema', `${attempt}.done`), '');
    rmSync(join(controlDir, SCHEMA_FILE), { force: true });
  };
  return { ...c, controlDir, dir, state, maker, later, request, kept, loaded };
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

  it('asks for the schema once', async () => {
    const s = stand();
    const maker = s.maker();
    expect(maker.mode()).toBe('off');
    await maker.tick(null);
    expect(s.request()).toEqual({ attempt: 1, database: 'hornhoof', port: 7432, password: PASSWORD });
    expect(statSync(join(s.controlDir, SCHEMA_FILE)).mode & 0o777).toBe(0o600);
    const written = statSync(join(s.controlDir, SCHEMA_FILE)).mtimeMs;
    await maker.tick(null);
    expect(statSync(join(s.controlDir, SCHEMA_FILE)).mtimeMs).toBe(written);
    expect(maker.report()).toEqual({ state: 'making', progress: 0, error: null, at: null, name: NAME, old: null });
    expect(maker.mode()).toBe('off');
    /* Nothing but looks so far. */
    expect(s.run.every(line => /: SELECT /.test(line))).toBe(true);
  });

  it('tries again with the next attempt', async () => {
    const s = stand();
    const maker = s.maker();
    await maker.tick(null);
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
    await s.maker().tick(null);
    expect(s.request()).toMatchObject({ attempt: 2, database: 'hornhoof' });
    expect(s.state.lines).toHaveLength(1);
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
    expect(maker.report().state).toBe('making');
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
    expect(given).toEqual([
      `hornhoof: ALTER SUBSCRIPTION "${NAME}" DISABLE`,
      `hornhoof: ALTER SUBSCRIPTION "${NAME}" SET (slot_name = NONE)`,
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
      `hornhoof: ALTER SUBSCRIPTION "${NAME}" SET (slot_name = NONE)`,
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
    await made.tick(null);
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
    expect(maker.report().state).toBe('ready');
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
      'hornhoof_next: ALTER SUBSCRIPTION "copy_99bb2233aabbccdd_7" SET (slot_name = NONE)',
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
});
