import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { CopyError, CopyState } from '../../db/schema.js';
import { DB_DOOR_PORT } from '../../net/db-door.js';
import type { Sql } from './lease-store.js';
import { reasonOf, writePrivately } from './machine-keys.js';
import { ensureReplica, PUBLICATION, REPLICA_ROLE } from './replica.js';

/* In the control folder: what the copy maker asks its updater for, the leader's schema loaded into a database here.
   The updater answers in schema/<attempt>.done or .failed, and removes the request. */
export const SCHEMA_FILE = 'schema.json';
export const SCHEMA_DIR = 'schema';
/* In the keeper's own folder: how far the copy has come, so a keeper that starts goes on from there. */
export const COPY_STATE = 'copy-state.json';
/* A subscription that stopped is enabled again for this long before its attempt is given up. */
export const ENABLE_FOR_MS = 600_000;
/* Under this much free disk a subscription that stopped is taken to have stopped for want of room. */
export const DISK_FULL = 2 ** 30;
/* The database a copy is made again in, beside the one that is still read. */
export const NEXT_DB = 'hornhoof_next';
/* A slot the leader does not list any more counts as gone after this many views in a row said so. */
export const MISSING_VIEWS = 2;
const ENABLE_EVERY_MS = 60_000;
const RETRY_MS = 600_000;
/* How long the app gets to read that it is off before the databases change places. */
const OFF_FOR_MS = 2_000;
const FIRST_DB = 'hornhoof';
const LEADER_DB = 'hornhoof';
const PASSFILE = 'replica.pgpass';

/* The steps of putting a copy that was made again in the place of the old one, each written down before it runs. */
export type SwapStep = 'off' | 'disable' | 'rename' | 'enable' | 'drop_sub' | 'drop_db' | 'read';

/* What a copy says of itself in its keeper's report. at: the leader's pulse it holds. name: the name of its
   subscription, its slot on the leader and its connection there. old: the attempt whose database waits to be merged. */
export type CopyReport = { state: CopyState; progress: number | null; error: CopyError | null; at: string | null; name: string | null; old: { attempt: number } | null };
/* What the leader says of the copy in its view. slot: its slot there. leaderSize: the size of the leader's database.
   migrations: how many the leader's schema has. old: how far the leader is with reading the copy's old database.
   upload: what a machine that stopped holding the data still owes: what it holds, nothing while the leader reads that, or
   its wipe. */
export type CopyOrder = { slot: 'ok' | 'lost' | 'missing' | null; leaderSize: number | null; migrations: number | null; old: 'waiting' | 'merged' | 'done' | null; upload: 'waiting' | 'received' | 'wipe' | null };

type Closable = Sql & { close(): Promise<void> };
const Kept = z.object({
  attempt: z.number().int().min(1),
  database: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
  phase: z.enum(['schema', 'grant', 'subscribe', 'sync', 'ready', 'detach', 'drop']),
  /* How many migrations the schema this copy was made with has. */
  migrations: z.number().int().nullable().default(null),
  /* No request for a schema before this moment: an attempt failed, and the next one waits. */
  notBefore: z.string().nullable().default(null),
  /* The attempt whose database, the one that is read, waits for the leader to merge it while a new copy is made beside
     it, and the count of migrations that one was made with. */
  old: z.object({ attempt: z.number().int().min(1), migrations: z.number().int().nullable() }).nullable().default(null),
  /* Whether the leader listed this attempt's slot once, and how many views in a row have not since. */
  seen: z.boolean().default(false),
  missing: z.number().int().min(0).default(0),
  /* The step of the swap that runs, the stamp the old database goes by, and when the app was told to stand still. */
  swap: z.enum(['off', 'disable', 'rename', 'enable', 'drop_sub', 'drop_db', 'read']).nullable().default(null),
  stamp: z.string().regex(/^[0-9]{8}t[0-9]{6}$/).nullable().default(null),
  swapAt: z.string().nullable().default(null),
});
type Kept = z.infer<typeof Kept>;
type Subscription = { name: string; oid: number; enabled: boolean; slot: string | null };

export type CopyMakerOptions = {
  /* The owner's connection to the database postgres of this machine. */
  admin: Sql;
  /* A new connection of the owner's to a database of this machine. */
  db: (database: string) => Closable;
  controlDir: string;
  dir: string;
  networkId: string;
  /* The password of the replica role, which the schema's request and the role in each new database need. */
  password: string;
  diskFree: () => number | null;
  log: (line: string) => void;
  now?: () => Date;
  /* Where the copy's database finds the leader's: the keeper's door, unless a test names the leader itself. */
  publisher?: { host: string; port: number };
};

/* The name a copy's subscription, its slot and its connection go by: the machine's id and the attempt. An attempt that
   failed never lends its name to the next, so a slot name is never used twice. */
export function copyName(networkId: string, attempt: number): string {
  return `copy_${networkId.slice(0, 16).toLowerCase()}_${attempt}`;
}

const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`;
/* A moment as the name of a database holds it: YYYYMMDDtHHMMSS, in UTC. */
export const stampOf = (at: Date): string => at.toISOString().replace(/[-:]/g, '').replace('T', 't').slice(0, 15);

/* Makes this machine's copy of the company's database and keeps it: the leader's schema, loaded by the updater, then a
   subscription to the leader's publication, which copies every row and follows every change from then on. A copy that
   broke is made again in a database beside the old one, which goes on being read until the new one holds everything
   and the leader has read what the old one holds; then the two change places. One step with each tick, each written
   down first, so nothing is done twice and nothing is left half done. It never touches a database that once led the
   company, and never drops one the leader has not read. */
export class CopyMaker {
  private kept: Kept;
  private open: { database: string; sql: Closable } | null = null;
  /* The connection to the copy that is still read while the next one is made beside it. */
  private beside: Closable | null = null;
  private said: CopyReport;
  private busy = false;
  private disabledSince: number | null = null;
  private enabledAt = 0;
  private failing = false;
  private lastOrder: CopyOrder | null = null;

  constructor(private readonly opts: CopyMakerOptions) {
    this.kept = this.read();
    this.said = this.making(null);
  }

  report(): CopyReport {
    return this.said;
  }

  /* What its app may do: read once the copy holds every table, also while a new copy is made beside it; nothing before
     that, and nothing while the two databases change places. */
  mode(): 'off' | 'read' {
    if (this.kept.swap) return ['off', 'disable', 'rename'].includes(this.kept.swap) ? 'off' : 'read';
    return this.kept.phase === 'ready' || this.kept.old !== null ? 'read' : 'off';
  }

  /* The copy takes nothing more from the leader: every subscription of its databases is disabled, and stays, with its
     slot, so nothing of what the copy holds changes while it is read. For a machine that stops holding the data. */
  async halt(): Promise<void> {
    try {
      for (const database of [FIRST_DB, NEXT_DB]) {
        if (!(await this.exists(database))) continue;
        const sql = this.on(database);
        for (const sub of await this.subscriptions(sql)) if (sub.enabled) await sql.query(`ALTER SUBSCRIPTION ${ident(sub.name)} DISABLE`);
      }
    } finally {
      await this.close();
    }
  }

  /* The count of migrations the copy's schema was made with; null before it has one. */
  migrations(): number | null {
    return this.kept.migrations;
  }

  /* One step. A step that fails is said once an outage, and the next tick tries it again. */
  async tick(order: CopyOrder | null): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.heard(order);
      await this.step(order);
      this.failing = false;
    } catch (err) {
      if (!this.failing) this.opts.log(`The copy of the company's database could not go on: ${reasonOf(err)}`);
      this.failing = true;
      await this.close();
    } finally {
      this.busy = false;
    }
  }

  async stop(): Promise<void> {
    await this.close();
  }

  private now(): number {
    return (this.opts.now?.() ?? new Date()).getTime();
  }

  private name(attempt = this.kept.attempt): string {
    return copyName(this.opts.networkId, attempt);
  }

  private read(): Kept {
    try {
      const parsed = Kept.safeParse(JSON.parse(readFileSync(join(this.opts.dir, COPY_STATE), 'utf8')));
      if (parsed.success) return parsed.data;
    } catch {
      /* None yet. */
    }
    return Kept.parse({ attempt: 1, database: FIRST_DB, phase: 'schema' });
  }

  private keep(next: Partial<Kept>): void {
    const kept = { ...this.kept, ...next };
    writePrivately(join(this.opts.dir, COPY_STATE), JSON.stringify(kept));
    this.kept = kept;
  }

  /* Each view of the leader's counts once, however many ticks pass with it: whether it listed this attempt's slot. */
  private heard(order: CopyOrder | null): void {
    if (!order || order === this.lastOrder) return;
    this.lastOrder = order;
    if (order.slot === 'ok' && (!this.kept.seen || this.kept.missing > 0)) this.keep({ seen: true, missing: 0 });
    else if (order.slot === 'missing' && this.kept.seen) this.keep({ missing: this.kept.missing + 1 });
  }

  /* One connection to a database of the copy, opened anew after it was closed. */
  private on(database: string): Closable {
    if (this.open?.database === database) return this.open.sql;
    void this.open?.sql.close().catch(() => undefined);
    this.open = { database, sql: this.opts.db(database) };
    return this.open.sql;
  }

  private async close(): Promise<void> {
    const [open, beside] = [this.open, this.beside];
    this.open = null;
    this.beside = null;
    await open?.sql.close().catch(() => undefined);
    await beside?.close().catch(() => undefined);
  }

  /* Being made, or being made again beside the copy that is still read. */
  private making(progress: number | null, at: string | null = null): CopyReport {
    return { state: this.kept.old ? 'remaking' : 'making', progress, error: null, at, name: this.name(), old: null };
  }

  private stopped(error: CopyError, at: string | null = null): CopyReport {
    return { state: 'stopped', progress: null, error, at, name: this.name(), old: null };
  }

  private async one<R>(sql: Sql, text: string, params?: unknown[]): Promise<R | undefined> {
    return (await sql.query<R>(text, params)).rows[0];
  }

  private async exists(database: string): Promise<boolean> {
    return Boolean(await this.one(this.opts.admin, 'SELECT 1 AS there FROM pg_database WHERE datname = $1', [database]));
  }

  private async step(order: CopyOrder | null): Promise<void> {
    if (this.kept.swap) {
      /* No session of this keeper's own stays on a database that changes its name. */
      const beside = this.beside;
      this.beside = null;
      await beside?.close().catch(() => undefined);
      return this.swap();
    }
    if (this.kept.phase === 'detach') return this.detach();
    if (this.kept.phase === 'drop') return this.drop();
    const sql = this.on(this.kept.database);
    if (await this.led(sql)) {
      this.said = this.stopped('led');
      return;
    }
    if (this.kept.phase === 'schema') return this.schema(sql);
    if (this.kept.phase === 'grant') return this.grant();
    if (this.kept.phase === 'subscribe') return this.subscribe(sql);
    if (this.kept.phase === 'sync') return this.sync(sql, order);
    return this.ready(sql, order);
  }

  /* Whether the database once held a term of the company: such a one is never dropped, swapped or written here. A
     database with no such table never did. */
  private async led(sql: Sql): Promise<boolean> {
    const table = await this.one<{ there: boolean }>(sql, `SELECT to_regclass('net_local.state') IS NOT NULL AS there`);
    if (!table?.there) return false;
    return (await this.one<{ led: boolean }>(sql, 'SELECT EXISTS (SELECT FROM net_local.state) AS led'))?.led === true;
  }

  /* The updater loads the leader's schema; until it has, the request waits in the control folder. A load that failed
     is one line, and the next attempt asks ten minutes later under the next number. */
  private async schema(sql: Sql): Promise<void> {
    this.said = this.making(0);
    const tables = await this.one<{ there: boolean }>(sql, `SELECT EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public') AS there`);
    if (tables?.there) {
      const counted = await this.one<{ n: number }>(sql, `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`).catch(() => undefined);
      return this.keep({ phase: 'grant', migrations: counted?.n ?? null, notBefore: null });
    }
    const { controlDir } = this.opts;
    const failed = join(controlDir, SCHEMA_DIR, `${this.kept.attempt}.failed`);
    if (existsSync(failed)) {
      this.opts.log(`Could not load the company's schema for a copy: ${readFileSync(failed, 'utf8').trim() || 'no reason was given'}`);
      return this.keep({ attempt: this.kept.attempt + 1, notBefore: new Date(this.now() + RETRY_MS).toISOString() });
    }
    if (this.kept.notBefore && this.now() < Date.parse(this.kept.notBefore)) return;
    const request = join(controlDir, SCHEMA_FILE);
    if (existsSync(request)) return;
    const { port } = this.publisher();
    writePrivately(request, JSON.stringify({ attempt: this.kept.attempt, database: this.kept.database, port, password: this.opts.password }));
  }

  private publisher(): { host: string; port: number } {
    return this.opts.publisher ?? { host: 'keeper', port: DB_DOOR_PORT };
  }

  /* The role's rights are per database, so a merge can read this one too. */
  private async grant(): Promise<void> {
    const { database } = this.kept;
    await ensureReplica(() => this.opts.db(database), this.opts.password);
    this.keep({ phase: 'subscribe' });
  }

  private async subscriptions(sql: Sql): Promise<Subscription[]> {
    const { rows } = await sql.query<Subscription>(
      `SELECT s.subname::text AS name, s.oid::int AS oid, s.subenabled AS enabled, s.subslotname::text AS slot FROM pg_subscription s JOIN pg_database d ON d.oid = s.subdbid WHERE d.datname = current_database() ORDER BY s.subname`,
    );
    return rows;
  }

  private async subscription(sql: Sql, name = this.name()): Promise<Subscription | undefined> {
    return (await this.subscriptions(sql)).find(sub => sub.name === name);
  }

  /* The copy answers the leader each second, so the leader knows within seconds when it falls silent. The password is
     read from a file in the database's own folder, so no statement holds it. A subscription of that name already
     there counts as made. */
  private async subscribe(sql: Sql): Promise<void> {
    if (!(await this.subscription(sql))) {
      await sql.query(`ALTER SYSTEM SET wal_receiver_status_interval = '1s'`);
      await sql.query('SELECT pg_reload_conf()');
      const dir = (await this.one<{ data_directory: string }>(sql, 'SHOW data_directory'))?.data_directory;
      if (!dir) throw new Error('the database does not say where its folder is');
      const { host, port } = this.publisher();
      const conninfo = `host=${host} port=${port} dbname=${LEADER_DB} user=${REPLICA_ROLE} passfile=${dir}/${PASSFILE}`;
      await sql.query(
        `CREATE SUBSCRIPTION ${ident(this.name())} CONNECTION ${literal(conninfo)} PUBLICATION ${ident(PUBLICATION)} WITH (copy_data = true, synchronous_commit = 'local', binary = false, streaming = off, disable_on_error = true)`,
      );
    }
    this.disabledSince = null;
    this.keep({ phase: 'sync', seen: false, missing: 0 });
  }

  /* A subscription that stopped is enabled again once a minute. How long it has been stopped for, in a row. */
  private async stoppedFor(sql: Sql, enabled: boolean): Promise<number> {
    if (enabled) {
      this.disabledSince = null;
      return 0;
    }
    const now = this.now();
    this.disabledSince ??= now;
    if (now - this.enabledAt >= ENABLE_EVERY_MS) {
      this.enabledAt = now;
      await sql.query(`ALTER SUBSCRIPTION ${ident(this.name())} ENABLE`);
    }
    return now - this.disabledSince;
  }

  /* The pulse of the leader a database holds, in the leader's own clock; none before its first. */
  private async pulse(sql: Sql): Promise<string | null> {
    const pulse = await this.one<{ at: Date | string }>(sql, 'SELECT at FROM net.pulse').catch(() => undefined);
    return pulse ? new Date(pulse.at).toISOString() : null;
  }

  /* The first copy of every table. Its progress is this database's size over the leader's, never a whole hundred
     before every table is through. */
  private async sync(sql: Sql, order: CopyOrder | null): Promise<void> {
    const sub = await this.subscription(sql);
    if (!sub) return this.keep({ phase: 'subscribe' });
    const stopped = await this.stoppedFor(sql, sub.enabled);
    if (order?.slot === 'lost' || stopped >= ENABLE_FOR_MS) return this.giveUp();
    const tables = await this.one<{ total: number; ready: number }>(sql, `SELECT count(*)::int AS total, (count(*) FILTER (WHERE srsubstate = 'r'))::int AS ready FROM pg_subscription_rel WHERE srsubid = $1::oid`, [sub.oid]);
    if (tables && tables.total > 0 && tables.ready === tables.total) {
      this.keep({ phase: 'ready' });
      return this.ready(sql, order);
    }
    const size = Number((await this.one<{ size: number }>(sql, 'SELECT pg_database_size(current_database())::float8 AS size'))?.size ?? 0);
    const progress = order?.leaderSize ? Math.min(99, Math.floor((size * 100) / order.leaderSize)) : 0;
    /* While it is made again, the copy that is read says how far it reaches. */
    this.said = this.making(progress, this.kept.old ? await this.oldPulse() : null);
  }

  /* Asked each second for as long as the next copy fills, so on one connection that stays; one that failed is opened
     anew at the next look. */
  private async oldPulse(): Promise<string | null> {
    this.beside ??= this.opts.db(FIRST_DB);
    try {
      return await this.pulse(this.beside);
    } catch (err) {
      const failed = this.beside;
      this.beside = null;
      await failed.close().catch(() => undefined);
      throw err;
    }
  }

  /* Why a copy that follows must be made again, or nothing: its slot is lost on the leader, or the leader has not
     listed it for two views in a row after it did; its subscription stopped and no enabling held; or the leader's
     schema is of another count of migrations than the one this copy was made with. */
  private broken(order: CopyOrder | null, stopped: number): string | null {
    if (order?.slot === 'lost') return 'the company server no longer keeps what this copy had still to read';
    if (this.kept.missing >= MISSING_VIEWS) return 'the company server no longer lists this copy';
    if (stopped >= ENABLE_FOR_MS) return 'its changes stopped coming in and would not start again';
    if (order && order.migrations !== null && this.kept.migrations !== null && order.migrations !== this.kept.migrations) return 'the company server runs another version of the database';
    return null;
  }

  /* The copy follows. One whose subscription stopped says why, as far as it can tell: no room left, or a change that
     did not fit. One that was made again says which old attempt waits for the leader, and changes places with it once
     the leader has read it. */
  private async ready(sql: Sql, order: CopyOrder | null): Promise<void> {
    const sub = await this.subscription(sql);
    const at = await this.pulse(sql);
    const stopped = sub ? await this.stoppedFor(sql, sub.enabled) : 0;
    const why = this.broken(order, sub ? stopped : ENABLE_FOR_MS);
    if (why) return this.kept.old ? this.giveUp() : this.remake(why);
    if (!sub || stopped > 0) {
      const free = this.opts.diskFree();
      this.said = this.stopped(free !== null && free < DISK_FULL ? 'disk_full' : 'apply', at);
      return;
    }
    if (!this.kept.old) {
      this.said = { state: 'ready', progress: null, error: null, at, name: this.name(), old: null };
      return;
    }
    this.said = { state: 'ready', progress: null, error: null, at, name: this.name(), old: { attempt: this.kept.old.attempt } };
    if (order?.old === 'merged' || order?.old === 'done') {
      const now = new Date(this.now());
      this.keep({ swap: 'off', stamp: stampOf(now), swapAt: now.toISOString() });
    }
  }

  /* A copy that broke is made again beside the old one: the next attempt, in a database of its own. Written down
     first; the old subscription is parted from its slot on the next ticks, so the leader drops that slot. */
  private remake(why: string): void {
    this.opts.log(`This machine's copy is made again: ${why}. The old one is read until the new one is whole.`);
    this.keep({ old: { attempt: this.kept.attempt, migrations: this.kept.migrations }, attempt: this.kept.attempt + 1, database: NEXT_DB, phase: 'detach', migrations: null, notBefore: null, seen: false, missing: 0 });
    this.disabledSince = null;
  }

  /* An attempt is given up whole before the next begins: the next number and the phase are written down first, so a
     keeper that starts in the middle goes on with what is left. */
  private giveUp(): void {
    this.keep({ attempt: this.kept.attempt + 1, phase: 'drop', notBefore: new Date(this.now() + RETRY_MS).toISOString(), seen: false, missing: 0 });
    this.disabledSince = null;
    this.said = this.making(0);
  }

  /* Each subscription of a database is given up: disabled, parted from its slot, which the leader then drops, and
     dropped. Each step is skipped when it is done. */
  private async release(sql: Sql, drop: boolean): Promise<void> {
    for (const sub of await this.subscriptions(sql)) {
      if (sub.enabled) await sql.query(`ALTER SUBSCRIPTION ${ident(sub.name)} DISABLE`);
      if (sub.slot) await sql.query(`ALTER SUBSCRIPTION ${ident(sub.name)} SET (slot_name = NONE)`);
      if (drop) await sql.query(`DROP SUBSCRIPTION ${ident(sub.name)}`);
    }
  }

  /* The old copy stops following: its subscription is disabled and parted from its slot, and stays, with its database,
     until the leader has read that one. Then the side database is made, empty. */
  private async detach(): Promise<void> {
    await this.release(this.on(FIRST_DB), false);
    this.keep({ phase: 'drop' });
  }

  /* The database of an attempt that was given up goes, with its subscriptions, and is made anew and empty. Never one
     that once led the company. */
  private async drop(): Promise<void> {
    const { database } = this.kept;
    this.said = this.making(0, this.said.at);
    if (await this.exists(database)) {
      const sql = this.on(database);
      if (await this.led(sql)) {
        this.said = this.stopped('led');
        return;
      }
      await this.release(sql, true);
      await this.close();
      await this.opts.admin.query(`DROP DATABASE ${ident(database)} WITH (FORCE)`);
    }
    await this.opts.admin.query(`CREATE DATABASE ${ident(database)}`);
    this.keep({ phase: 'schema', migrations: null });
  }

  /* The copy that was made again takes the place of the old one. Each step is written down before it runs, and each
     finds out for itself whether its work is done, so a keeper that starts in the middle goes on from there. */
  private async swap(): Promise<void> {
    const step = this.kept.swap!;
    const old = `hornhoof_old_${this.kept.stamp!}`;
    const { admin } = this.opts;
    if (step === 'off') {
      if (this.now() - Date.parse(this.kept.swapAt!) >= OFF_FOR_MS) this.keep({ swap: 'disable' });
      return;
    }
    if (step === 'disable') {
      if (await this.exists(NEXT_DB)) {
        const sql = this.on(NEXT_DB);
        if ((await this.subscription(sql))?.enabled) await sql.query(`ALTER SUBSCRIPTION ${ident(this.name())} DISABLE`);
      }
      return this.keep({ swap: 'rename' });
    }
    if (step === 'rename') {
      await this.close();
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ANY($1::text[]) AND pid <> pg_backend_pid()`, [[FIRST_DB, NEXT_DB]]);
      if ((await this.exists(NEXT_DB)) && (await this.exists(FIRST_DB)) && !(await this.exists(old))) await admin.query(`ALTER DATABASE ${ident(FIRST_DB)} RENAME TO ${ident(old)}`);
      if ((await this.exists(NEXT_DB)) && !(await this.exists(FIRST_DB))) await admin.query(`ALTER DATABASE ${ident(NEXT_DB)} RENAME TO ${ident(FIRST_DB)}`);
      return this.keep({ swap: 'enable', database: FIRST_DB });
    }
    if (step === 'enable') {
      const sql = this.on(FIRST_DB);
      const sub = await this.subscription(sql);
      if (sub && !sub.enabled) await sql.query(`ALTER SUBSCRIPTION ${ident(this.name())} ENABLE`);
      return this.keep({ swap: 'drop_sub' });
    }
    if (step === 'drop_sub') {
      if (await this.exists(old)) await this.release(this.on(old), true);
      return this.keep({ swap: 'drop_db' });
    }
    if (step === 'drop_db') {
      if (await this.exists(old)) {
        /* A database that once led the company stays, and the copy says so. */
        if (await this.led(this.on(old))) {
          this.said = this.stopped('led', this.said.at);
          return;
        }
        await this.close();
        await admin.query(`DROP DATABASE ${ident(old)} WITH (FORCE)`);
      }
      return this.keep({ swap: 'read' });
    }
    /* The role's rights are per database, so they are made in full on the one that is read now. */
    await ensureReplica(() => this.opts.db(FIRST_DB), this.opts.password);
    this.keep({ swap: null, stamp: null, swapAt: null, old: null, database: FIRST_DB, phase: 'ready' });
  }
}
