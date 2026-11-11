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
    if (text.includes('FROM pg_subscription s')) {
      const sub = db!.subs.get(String(params[0]));
      return sub ? [{ oid: 16500, enabled: sub.enabled, slot: sub.slot }] : [];
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
  const sqlOn = (on: string): Sql & { close(): Promise<void> } => ({
    query: async <R>(text: string, params?: unknown[]) => {
      run.push(`${on}: ${text.startsWith('DO $replica$') ? 'DO $replica$' : text}`);
      return { rows: answer(on, text, params) as R[] };
    },
    close: async () => undefined,
  });
  return { databases, run, add, sqlOn };
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
    const statements = s.run.filter(line => !/: SELECT (to_regclass|EXISTS|count|s\.oid|1 AS)/.test(line) && !line.includes('FROM pg_subscription'));
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
    expect(s.kept()).toMatchObject({ attempt: 2, phase: 'drop', dropping: 1 });
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
    expect(s.kept()).toMatchObject({ attempt: 2, phase: 'schema', dropping: null });
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
    expect(s.kept()).toMatchObject({ attempt: 2, phase: 'drop', dropping: 1 });
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
});
