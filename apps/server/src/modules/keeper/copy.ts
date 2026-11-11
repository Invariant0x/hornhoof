import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { CopyError, CopyState } from '../../db/schema.js';
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
const ENABLE_EVERY_MS = 60_000;
const RETRY_MS = 600_000;
const FIRST_DB = 'hornhoof';
const LEADER_DB = 'hornhoof';
const PASSFILE = 'replica.pgpass';

/* What a copy says of itself in its keeper's report. at: the leader's pulse it holds. name: the name of its
   subscription, its slot on the leader and its connection there. old: the attempt whose database waits to be merged. */
export type CopyReport = { state: CopyState; progress: number | null; error: CopyError | null; at: string | null; name: string | null; old: { attempt: number } | null };
/* What the leader says of the copy in its view. slot: its slot there. leaderSize: the size of the leader's database.
   migrations: how many the leader's schema has. old and upload: what becomes of an old database and of a machine that
   stopped holding the data; none of either yet. */
export type CopyOrder = { slot: 'ok' | 'lost' | 'missing' | null; leaderSize: number | null; migrations: number | null; old: 'waiting' | 'merged' | 'done' | null; upload: 'waiting' | 'wipe' | null };

type Closable = Sql & { close(): Promise<void> };
const Kept = z.object({
  attempt: z.number().int().min(1),
  database: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
  phase: z.enum(['schema', 'grant', 'subscribe', 'sync', 'ready', 'drop']),
  /* How many migrations the schema this copy was made with has. */
  migrations: z.number().int().nullable().default(null),
  /* No request for a schema before this moment: an attempt failed, and the next one waits. */
  notBefore: z.string().nullable().default(null),
  /* The attempt that is being given up while the phase is drop. */
  dropping: z.number().int().nullable().default(null),
});
type Kept = z.infer<typeof Kept>;

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

/* Makes this machine's copy of the company's database and keeps it: the leader's schema, loaded by the updater, then a
   subscription to the leader's publication, which copies every row and follows every change from then on. One step
   with each tick, each written down first, so nothing is done twice and nothing is left half done. It never touches a
   database that once led the company. */
export class CopyMaker {
  private kept: Kept;
  private open: { database: string; sql: Closable } | null = null;
  private said: CopyReport;
  private busy = false;
  private disabledSince: number | null = null;
  private enabledAt = 0;
  private failing = false;

  constructor(private readonly opts: CopyMakerOptions) {
    this.kept = this.read();
    this.said = this.making(null);
  }

  report(): CopyReport {
    return this.said;
  }

  /* What its app may do: nothing until the copy holds every table once, then read. */
  mode(): 'off' | 'read' {
    return this.kept.phase === 'ready' ? 'read' : 'off';
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
    return { attempt: 1, database: FIRST_DB, phase: 'schema', migrations: null, notBefore: null, dropping: null };
  }

  private keep(next: Partial<Kept>): void {
    const kept = { ...this.kept, ...next };
    writePrivately(join(this.opts.dir, COPY_STATE), JSON.stringify(kept));
    this.kept = kept;
  }

  /* One connection to the copy's database, opened anew after it was closed. */
  private on(database: string): Closable {
    if (this.open?.database === database) return this.open.sql;
    void this.open?.sql.close().catch(() => undefined);
    this.open = { database, sql: this.opts.db(database) };
    return this.open.sql;
  }

  private async close(): Promise<void> {
    const open = this.open;
    this.open = null;
    await open?.sql.close().catch(() => undefined);
  }

  private making(progress: number | null): CopyReport {
    return { state: 'making', progress, error: null, at: null, name: this.name(), old: null };
  }

  private async one<R>(sql: Sql, text: string, params?: unknown[]): Promise<R | undefined> {
    return (await sql.query<R>(text, params)).rows[0];
  }

  private async step(order: CopyOrder | null): Promise<void> {
    if (this.kept.phase === 'drop') return this.drop();
    const sql = this.on(this.kept.database);
    if (await this.led(sql)) {
      this.said = { state: 'stopped', progress: null, error: 'led', at: null, name: this.name(), old: null };
      return;
    }
    if (this.kept.phase === 'schema') return this.schema(sql);
    if (this.kept.phase === 'grant') return this.grant();
    if (this.kept.phase === 'subscribe') return this.subscribe(sql);
    if (this.kept.phase === 'sync') return this.sync(sql, order);
    return this.ready(sql);
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
    return this.opts.publisher ?? { host: 'keeper', port: 7432 };
  }

  /* The role's rights are per database, so a merge can read this one too. */
  private async grant(): Promise<void> {
    const { database } = this.kept;
    await ensureReplica(() => this.opts.db(database), this.opts.password);
    this.keep({ phase: 'subscribe' });
  }

  private subscription(sql: Sql, name = this.name()): Promise<{ oid: number; enabled: boolean; slot: string | null } | undefined> {
    return this.one(sql, `SELECT s.oid::int AS oid, s.subenabled AS enabled, s.subslotname::text AS slot FROM pg_subscription s JOIN pg_database d ON d.oid = s.subdbid WHERE d.datname = current_database() AND s.subname = $1`, [name]);
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
    this.keep({ phase: 'sync' });
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
      return this.ready(sql);
    }
    const size = Number((await this.one<{ size: number }>(sql, 'SELECT pg_database_size(current_database())::float8 AS size'))?.size ?? 0);
    const progress = order?.leaderSize ? Math.min(99, Math.floor((size * 100) / order.leaderSize)) : 0;
    this.said = this.making(progress);
  }

  /* The copy follows. One whose subscription stopped says why, as far as it can tell: no room left, or a change that
     did not fit. */
  private async ready(sql: Sql): Promise<void> {
    const sub = await this.subscription(sql);
    const pulse = await this.one<{ at: Date | string }>(sql, 'SELECT at FROM net.pulse').catch(() => undefined);
    const at = pulse ? new Date(pulse.at).toISOString() : null;
    const stopped = sub ? await this.stoppedFor(sql, sub.enabled) : 0;
    if (!sub || stopped > 0) {
      const free = this.opts.diskFree();
      this.said = { state: 'stopped', progress: null, error: free !== null && free < DISK_FULL ? 'disk_full' : 'apply', at, name: this.name(), old: null };
      return;
    }
    this.said = { state: 'ready', progress: null, error: null, at, name: this.name(), old: null };
  }

  /* An attempt is given up whole before the next begins: the next number and the phase are written down first, so a
     keeper that starts in the middle goes on with what is left. */
  private giveUp(): void {
    this.keep({ attempt: this.kept.attempt + 1, phase: 'drop', dropping: this.kept.attempt, notBefore: new Date(this.now() + RETRY_MS).toISOString() });
    this.disabledSince = null;
    this.said = this.making(0);
  }

  /* Each step is skipped when it is done: the subscription disabled, parted from its slot, which the leader then
     drops, and dropped; then the database, which is made anew and empty. */
  private async drop(): Promise<void> {
    const { database, dropping } = this.kept;
    this.said = this.making(0);
    const exists = await this.one(this.opts.admin, 'SELECT 1 AS there FROM pg_database WHERE datname = $1', [database]);
    if (exists) {
      const sql = this.on(database);
      if (await this.led(sql)) {
        this.said = { state: 'stopped', progress: null, error: 'led', at: null, name: this.name(), old: null };
        return;
      }
      const name = this.name(dropping ?? this.kept.attempt);
      const sub = await this.subscription(sql, name);
      if (sub?.enabled) await sql.query(`ALTER SUBSCRIPTION ${ident(name)} DISABLE`);
      if (sub?.slot) await sql.query(`ALTER SUBSCRIPTION ${ident(name)} SET (slot_name = NONE)`);
      if (sub) await sql.query(`DROP SUBSCRIPTION ${ident(name)}`);
      await this.close();
      await this.opts.admin.query(`DROP DATABASE ${ident(database)} WITH (FORCE)`);
    }
    await this.opts.admin.query(`CREATE DATABASE ${ident(database)}`);
    this.keep({ phase: 'schema', dropping: null, migrations: null });
  }
}
