import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { CopyError, CopyState } from '../../db/schema.js';
import { DB_DOOR_PORT } from '../../net/db-door.js';
import type { AppliedLed, SavingWait } from './led.js';
import type { Sql } from './lease-store.js';
import { reasonOf, writePrivately } from './machine-keys.js';
import { joinSlot } from './promote.js';
import { ensureReplica, PUBLICATION, REPLICA_ROLE } from './replica.js';
import { ident, literal } from './sql-words.js';

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
/* After this many views in a row of a new leader that name no slot for it, a copy is made again from that leader. */
export const MOVED_VIEWS = 2;
const ENABLE_EVERY_MS = 60_000;
/* How often the saver of a database that led is asked to go on. */
const SAVE_EVERY_MS = 10_000;
const RETRY_MS = 600_000;
/* The longest an attempt waits after attempts were given up in a row, each twice as long as the one before. */
const RETRY_MAX_MS = 7_200_000;
const OTHER_VERSION = 'the company server runs another version of the database';
/* How long the app gets to read that it is off before the databases change places. */
const OFF_FOR_MS = 2_000;
const FIRST_DB = 'hornhoof';
const LEADER_DB = 'hornhoof';
const PASSFILE = 'replica.pgpass';
/* How long a statement of the copy's Postgres that asks the leader something may wait for its answer: under the
   20 seconds a keeper waits for any statement of its own. */
const LEADER_WAIT_MS = 10_000;
/* Where a subscription that is given up and could not reach the leader in time is pointed, so its drop asks the leader
   nothing more: a folder that is not there, which no connection gets through. */
const NOWHERE = 'host=/nonexistent';
/* The origins of tables whose first copy was broken off and that no worker uses now: Postgres names a table's origin
   pg_<subscription>_<table>, and a table whose rows were going over when a cut came stays at data copy. */
const LEFT_ORIGINS = `SELECT o.roname::text AS name FROM pg_replication_origin o JOIN pg_subscription_rel r ON o.roname = format('pg_%s_%s', r.srsubid, r.srrelid)
  WHERE r.srsubid = $1::oid AND r.srsubstate = 'd' AND NOT EXISTS (SELECT FROM pg_stat_subscription w WHERE w.subid = r.srsubid AND w.relid = r.srrelid)`;
/* The leader's slots of the same tables, by the name Postgres gives them: pg_<subscription>_sync_<table>_<this database
   server's system id>. Postgres makes a table's slot anew when its first copy starts again, so the old one only takes a
   place on the leader: the copy names them in its report, and the leader drops them. */
const LEFT_SLOTS = `SELECT format('pg_%s_sync_%s_%s', r.srsubid, r.srrelid, (SELECT system_identifier FROM pg_control_system())) AS name FROM pg_subscription_rel r
  WHERE r.srsubid = $1::oid AND r.srsubstate = 'd' AND NOT EXISTS (SELECT FROM pg_stat_subscription w WHERE w.subid = r.srsubid AND w.relid = r.srrelid) ORDER BY r.srrelid`;
/* Whether a file is there, by its path. Its size is asked, and not the whole answer: a row is null to Postgres
   unless every field of it is set, and a file's time of creation never is on Linux. */
export const PASSFILE_THERE = 'SELECT (pg_stat_file($1, true)).size IS NOT NULL AS there';

/* What a copy says of itself in its keeper's report. at: the leader's pulse it holds. name: the name of its
   subscription, its slot on the leader and its connection there. old: the attempt whose database waits to be merged. */
/* old.led: the number of the term the old database led the company under, when it did. left: while the first copy is
   made, the leader's slots of its tables whose first copy broke off, for the leader to drop; none said while there are
   none. */
export type CopyReport = {
  state: CopyState; progress: number | null; error: CopyError | null; at: string | null; name: string | null; old: { attempt: number; led?: number } | null; left?: string[];
  saving?: { waiting: SavingWait; since: string };
};
/* What the leader says of the copy in its view. slot: its slot there. leaderSize: the size of the leader's database.
   migrations: how many the leader's schema has. old: how far the leader is with reading the copy's old database.
   upload: what a machine that stopped holding the data still owes: what it holds, nothing while the leader reads that, or
   its wipe. lastAttempt: the attempt the machine's row names its copy by; null where it never kept one. leader: the
   network id of the leader whose view this is. join: the slot that leader made for this machine when it took the
   server in a planned switch, for a copy that held everything the leader before had written; none else. applied: how
   far a handover from this machine applied its log on the server. A leader of a build before names none of the last three. */
export type CopyOrder = {
  slot: 'ok' | 'lost' | 'missing' | null; leaderSize: number | null; migrations: number | null; old: 'waiting' | 'merged' | 'done' | null; upload: 'waiting' | 'received' | 'wipe' | null;
  lastAttempt: number | null;
  leader?: string;
  join?: string | null;
  applied?: AppliedLed | null;
};

type Closable = Sql & { close(): Promise<void> };
const Kept = z.object({
  attempt: z.number().int().min(1),
  database: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
  phase: z.enum(['schema', 'grant', 'subscribe', 'sync', 'ready', 'detach', 'drop', 'join']),
  /* The slot of the leader this copy joins, with no copy of the data, while the phase is join. */
  slot: z.string().regex(/^copy_[0-9a-f]{16}_[0-9]{1,9}$/).nullable().default(null),
  /* The leader this copy was made on or last joined, by its network id; none in a file of before. */
  leader: z.string().nullable().default(null),
  /* Another leader whose views named no slot for this copy, and how many of its views in a row did so. */
  moved: z.object({ leader: z.string(), views: z.number().int().min(1) }).nullable().default(null),
  /* How many migrations the schema this copy was made with has. */
  migrations: z.number().int().nullable().default(null),
  /* No request for a schema before this moment: an attempt failed, and the next one waits. */
  notBefore: z.string().nullable().default(null),
  /* The attempt whose database, the one that is read, waits for the leader to merge it while a new copy is made beside
     it, and the count of migrations that one was made with. */
  old: z.object({ attempt: z.number().int().min(1), migrations: z.number().int().nullable(), led: z.number().int().min(0).optional() }).nullable().default(null),
  /* Whether the leader listed this attempt's slot once, and how many views in a row have not since. */
  seen: z.boolean().default(false),
  missing: z.number().int().min(0).default(0),
  /* The step of the swap that runs, the stamp the old database goes by, and when the app was told to stand still. */
  swap: z.enum(['off', 'disable', 'rename', 'enable', 'drop_sub', 'drop_db', 'read']).nullable().default(null),
  stamp: z.string().regex(/^[0-9]{8}t[0-9]{6}$/).nullable().default(null),
  swapAt: z.string().nullable().default(null),
  /* How many attempts in a row were given up since the copy was last whole: the next waits the longer. */
  given: z.number().int().min(0).default(0),
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
  /* Whether this machine promised the machine that leads to wait for its update, and the promise holds. */
  updating?: () => boolean;
  /* What saves a database of this machine that led the company, before its copy is made again: asked every ten
     seconds until it is done. state: the term the database led under, and why its dump failed when it did. Without
     it such a database stops the copy, and is never touched. */
  saver?: {
    tick(applied?: AppliedLed | null): Promise<void>;
    done(): boolean;
    state(): { term: number; failed: string | null; skipped?: boolean; waiting?: SavingWait; since?: string } | null;
    forget(): void;
  };
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
  /* Nothing is written down of a copy yet: the first attempt's number waits for the leader's word. */
  private fresh = false;
  private open: { database: string; sql: Closable } | null = null;
  /* The connection to the copy that is still read while the next one is made beside it. */
  private beside: Closable | null = null;
  private said: CopyReport;
  private busy = false;
  private disabledSince: number | null = null;
  private savedAt: number | null = null;
  private lastApplied: string | null = null;
  private enabledAt = 0;
  private failing = false;
  private lastOrder: CopyOrder | null = null;
  /* How many tables of which subscription had got through their first copy at the last look. */
  private through: { oid: number; ready: number } | null = null;

  constructor(private readonly opts: CopyMakerOptions) {
    this.kept = this.read();
    this.said = this.making(null);
  }

  /* Null before the first attempt has its number: nothing is said of a copy until then, so the row keeps the name of
     the copy the machine kept before. */
  report(): CopyReport | null {
    return this.fresh ? null : this.said;
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

  /* The machine this copy was made on or last joined, by its network id; none before a view named one. */
  leader(): string | null {
    return this.kept.leader;
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
      /* A machine that kept a copy before and was wiped starts above the attempt its row still names, so no slot,
         connection or merge of the old copy shares its name with the new one. Until the leader says which that was,
         nothing is asked. */
      if (this.fresh) {
        if (!order) return;
        this.keep({ attempt: (order.lastAttempt ?? 0) + 1 });
        this.fresh = false;
        this.said = this.making(null);
      }
      this.heard(order);
      /* While this machine waits for the leader's update, the copy stays as it is: nothing of it is made, made again,
         swapped or started, and a subscription that stands still counts toward nothing. What the leader's views said
         meanwhile is kept, and the first step after the wait acts on it. */
      if (this.opts.updating?.()) {
        this.disabledSince = null;
        return;
      }
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
    this.fresh = true;
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
    if (order.leader !== undefined) {
      if (this.kept.leader === null) this.keep({ leader: order.leader });
      else if (order.leader !== this.kept.leader) {
        /* The view of another leader than the one this copy follows says nothing of this copy's slot: it counts only
           toward that leader having no place for it. */
        if (!this.joinOf(order)) this.keep({ moved: { leader: order.leader, views: this.kept.moved?.leader === order.leader ? this.kept.moved.views + 1 : 1 } });
        return;
      } else if (this.kept.moved) this.keep({ moved: null });
    }
    if (order.slot === 'ok' && (!this.kept.seen || this.kept.missing > 0)) this.keep({ seen: true, missing: 0 });
    else if (order.slot === 'missing' && this.kept.seen) this.keep({ missing: this.kept.missing + 1 });
  }

  /* The slot a view names for this machine to join, when it is one of its own name above its attempt: a slot of an
     earlier switch is none. */
  private joinOf(order: CopyOrder | null): { slot: string; attempt: number } | null {
    const found = /^(copy_[0-9a-f]{16})_([0-9]{1,9})$/.exec(order?.join ?? '');
    if (!found || `${found[1]}_1` !== copyName(this.opts.networkId, 1) || Number(found[2]) <= this.kept.attempt) return null;
    return { slot: found[0], attempt: Number(found[2]) };
  }

  /* Whether this view is of another leader than the one this copy follows, and whether that leader has now said often
     enough that it holds no place for this copy. */
  private elsewhere(order: CopyOrder | null): { moved: boolean } | null {
    if (order?.leader === undefined || this.kept.leader === null || order.leader === this.kept.leader) return null;
    return { moved: this.kept.moved?.leader === order.leader && this.kept.moved.views >= MOVED_VIEWS };
  }

  /* The same, and once that leader has said often enough that it holds no place for this copy, the copy is of that
     leader from now on. */
  private moving(order: CopyOrder | null): { moved: boolean } | null {
    const elsewhere = this.elsewhere(order);
    if (elsewhere?.moved) this.keep({ leader: order!.leader, moved: null });
    return elsewhere;
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
    if (await this.led(sql)) return this.saveLed(order);
    if (this.kept.phase === 'join') return this.join(sql, order);
    if (this.kept.phase === 'schema') return this.schema(sql);
    if (this.kept.phase === 'grant') return this.grant();
    if (this.kept.phase === 'subscribe') return this.subscribe(sql, order);
    if (this.kept.phase === 'sync') return this.sync(sql, order);
    return this.ready(sql, order);
  }

  private saverDue(now: number, applied: AppliedLed | null): boolean {
    const key = applied ? `${applied.term}:${applied.lsn}` : null;
    if (key !== null && key !== this.lastApplied) {
      this.lastApplied = key;
      return true;
    }
    return this.savedAt === null || now - this.savedAt >= SAVE_EVERY_MS;
  }

  private savingReport(state: ReturnType<NonNullable<CopyMakerOptions['saver']>['state']>): CopyReport {
    const failed = state?.failed ?? null;
    if (failed) return this.stopped(/No space left on device/.test(failed) ? 'disk_full' : 'setup');
    const saving = state?.waiting && state.since ? { saving: { waiting: state.waiting, since: state.since } } : {};
    return { state: 'saving', progress: null, error: null, at: null, name: this.name(), old: null, ...saving };
  }

  /* The database led the company and no handover ended that: what it holds is saved first, as a backup of the company
     the keeper that leads records, unless the leader already applied every WAL byte it wrote. Then the copy is made
     again beside it, and it is read until the new one is whole; it goes only once the leader merged it. */
  private async saveLed(order: CopyOrder | null): Promise<void> {
    const saver = this.opts.saver;
    if (!saver) {
      this.said = this.stopped('led');
      return;
    }
    const applied = order?.applied ?? null;
    if (!saver.done()) {
      const now = this.now();
      if (this.saverDue(now, applied)) {
        this.savedAt = now;
        await saver.tick(applied);
      }
      this.said = this.savingReport(saver.state());
      if (!saver.done()) return;
    }
    const state = saver.state();
    const led = state?.term;
    this.opts.log(
      state?.skipped
        ? 'The company server already holds everything this machine did while it led. Its copy is made again; the database that led is read until the new one is whole.'
        : 'What this machine did while it led is saved. Its copy is made again; the database that led is read until the new one is whole.',
    );
    this.keep({ old: { attempt: this.kept.attempt, migrations: this.kept.migrations, ...(led === undefined ? {} : { led }) }, attempt: this.kept.attempt + 1, database: NEXT_DB, phase: 'detach', migrations: null, notBefore: null, seen: false, missing: 0 });
    this.disabledSince = null;
  }

  /* Whether the database once held a term of the company that did not end in a handover: such a one is never dropped,
     swapped or written here. A database with no such table never did, and one that handed the server over in a
     planned switch wrote nothing the new leader lacks. */
  private async led(sql: Sql): Promise<boolean> {
    const table = await this.one<{ there: boolean }>(sql, `SELECT to_regclass('net_local.state') IS NOT NULL AS there`);
    if (!table?.there) return false;
    return (await this.one<{ led: boolean }>(sql, `SELECT EXISTS (SELECT FROM net_local.state s WHERE to_jsonb(s) ->> 'handed_lsn' IS NULL) AS led`))?.led === true;
  }

  /* The copy joins the slot the new leader made for it, taking no row again: it holds everything up to where that
     slot begins. Every step is looked at first, so a keeper that starts again in the middle goes on: any other
     subscription goes, parted from its slot; the file the replica role's password is read from is asked of the
     updater when it is not there; then the subscription is made, and the copy follows. */
  private async join(sql: Sql, order: CopyOrder | null): Promise<void> {
    const { slot } = this.kept;
    if (!slot) return this.keep({ phase: 'ready' });
    this.said = this.making(null, await this.pulse(sql));
    for (const sub of await this.subscriptions(sql)) {
      if (sub.name === slot) continue;
      if (sub.enabled) await sql.query(`ALTER SUBSCRIPTION ${ident(sub.name)} DISABLE`);
      if (sub.slot) await sql.query(`ALTER SUBSCRIPTION ${ident(sub.name)} SET (slot_name = NONE)`);
      await sql.query(`DROP SUBSCRIPTION ${ident(sub.name)}`);
    }
    const dir = (await this.one<{ data_directory: string }>(sql, 'SHOW data_directory'))?.data_directory;
    if (!dir) throw new Error('the database does not say where its folder is');
    const passfile = `${dir}/${PASSFILE}`;
    if (!(await this.one<{ there: boolean }>(sql, PASSFILE_THERE, [passfile]))?.there) {
      const request = join(this.opts.controlDir, SCHEMA_FILE);
      if (!existsSync(request)) writePrivately(request, JSON.stringify({ attempt: this.kept.attempt, database: this.kept.database, port: this.publisher().port, password: this.opts.password, only: 'passfile' }));
      return;
    }
    await sql.query(`ALTER SYSTEM SET wal_receiver_status_interval = '1s'`);
    await sql.query('SELECT pg_reload_conf()');
    const { host, port } = this.publisher();
    await joinSlot(sql, { name: slot, conninfo: `host=${host} port=${port} dbname=${LEADER_DB} user=${REPLICA_ROLE} passfile=${passfile}` });
    this.disabledSince = null;
    this.keep({ phase: 'ready', slot: null, migrations: order?.migrations ?? this.kept.migrations, seen: false, missing: 0, moved: null, ...(order?.leader === undefined ? {} : { leader: order.leader }) });
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
  private async subscribe(sql: Sql, order: CopyOrder | null): Promise<void> {
    if (await this.otherSchema(sql, order)) return this.schemaChanged();
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

  /* A subscription that stopped is enabled again once a minute. How long it has been stopped for, in a row: one that was
     enabled again holds only once it still runs a minute later, so one that stops on its first error each time it
     starts, however often a look finds it running in between, counts as stopped all along, and is given up. A first
     copy that got a table through since, as one between two cuts of a slow link, has not stood still: see moves. */
  private async stoppedFor(sql: Sql, sub: Subscription): Promise<number> {
    const now = this.now();
    if (sub.enabled) {
      if (now - this.enabledAt >= ENABLE_EVERY_MS) this.disabledSince = null;
      return 0;
    }
    this.disabledSince ??= now;
    if (now - this.enabledAt >= ENABLE_EVERY_MS) {
      this.enabledAt = now;
      await this.freeOrigins(sql, sub.oid);
      await sql.query(`ALTER SUBSCRIPTION ${ident(this.name())} ENABLE`);
    }
    return now - this.disabledSince;
  }

  /* A cut stops a subscription with each table whose rows were going over, and Postgres keeps such a table's origin
     until the table is through. The next start begins other tables first, each with an origin of its own, so cut after
     cut the copy's Postgres runs out of them and no table starts any more. One that no worker uses goes before the
     subscription starts again: the table's next copy begins from its first row all the same, and makes it anew. */
  private async freeOrigins(sql: Sql, oid: number): Promise<void> {
    const { rows } = await sql.query<{ name: string }>(LEFT_ORIGINS, [oid]);
    for (const { name } of rows) await sql.query('SELECT pg_replication_origin_drop($1)', [name]);
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
    /* While the server moved and the new leader has not said its word yet, nothing is given up; once it has, the first
       copy this machine was still making is begun anew, from that leader. */
    const elsewhere = this.moving(order);
    /* The leader's schema changed while its rows were copied, as with an update that added a column: a subscription
       enabled again would stop on the first row of that table, so it is not, and the next attempt loads the schema the
       leader has now. */
    if (!elsewhere && (await this.otherSchema(sql, order))) return this.schemaChanged();
    const tables = await this.tables(sql, sub.oid);
    const stopped = await this.stoppedFor(sql, sub);
    if (elsewhere ? elsewhere.moved : order?.slot === 'lost' || stopped >= ENABLE_FOR_MS) return this.giveUp();
    if (tables.total > 0 && tables.ready === tables.total) {
      this.keep({ phase: 'ready', given: 0 });
      return this.ready(sql, order);
    }
    const size = Number((await this.one<{ size: number }>(sql, 'SELECT pg_database_size(current_database())::float8 AS size'))?.size ?? 0);
    const progress = order?.leaderSize ? Math.min(99, Math.floor((size * 100) / order.leaderSize)) : 0;
    /* While it is made again, the copy that is read says how far it reaches. */
    this.said = { ...this.making(progress, this.kept.old ? await this.oldPulse() : null), ...(await this.leftSlots(sql, sub.oid)) };
  }

  /* The leader's slots of tables whose first copy broke off, to name in the report; nothing when there are none. */
  private async leftSlots(sql: Sql, oid: number): Promise<{ left?: string[] }> {
    const { rows } = await sql.query<{ name: string }>(LEFT_SLOTS, [oid]);
    return rows.length ? { left: rows.map(row => row.name) } : {};
  }

  /* How many tables the subscription takes, and how many of them got through their first copy; each look counts
     toward whether the copy moves. */
  private async tables(sql: Sql, oid: number): Promise<{ total: number; ready: number }> {
    const tables = (await this.one<{ total: number; ready: number }>(sql, `SELECT count(*)::int AS total, (count(*) FILTER (WHERE srsubstate = 'r'))::int AS ready FROM pg_subscription_rel WHERE srsubid = $1::oid`, [oid])) ?? { total: 0, ready: 0 };
    this.moves(oid, tables.ready);
    return tables;
  }

  /* A cut of the link stops a subscription whose tables' first copies are under way, as any error of theirs does, and
     the table whose rows were going over starts again from its first row. A table that got through since the last
     look means the copy moves all the same, however often it was stopped: what it was stopped for so far counts no
     more. One that breaks each time it starts gets nothing through, and is given up after ten minutes as before. */
  private moves(oid: number, ready: number): void {
    if (this.through?.oid === oid && ready > this.through.ready) this.disabledSince = null;
    this.through = { oid, ready };
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
    if (order && order.migrations !== null && this.kept.migrations !== null && order.migrations !== this.kept.migrations) return OTHER_VERSION;
    return null;
  }

  /* How many migrations this copy's schema has: as written down, or, for a copy a build of before made without writing
     it down, counted once in its database. Null when it cannot tell. */
  private async ownMigrations(sql: Sql): Promise<number | null> {
    if (this.kept.migrations !== null) return this.kept.migrations;
    const counted = await this.one<{ n: number }>(sql, `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`).catch(() => undefined);
    if (counted) this.keep({ migrations: counted.n });
    return counted?.n ?? null;
  }

  /* Whether the leader's schema has another count of migrations than this copy's. */
  private async otherSchema(sql: Sql, order: CopyOrder | null): Promise<boolean> {
    if (order?.migrations == null) return false;
    const own = await this.ownMigrations(sql);
    return own !== null && own !== order.migrations;
  }

  /* An attempt made with the leader's schema of before is given up, and the next asks for the schema now: at once the
     first time, as any other attempt given up after that. */
  private schemaChanged(): void {
    this.opts.log("This copy was being made with the company server's schema of before the server's update: it is made again with the schema the server has now.");
    this.giveUp(true);
  }

  /* The copy follows. One whose subscription stopped says why, as far as it can tell: no room left, or a change that
     did not fit. One that was made again says which old attempt waits for the leader, and changes places with it once
     the leader has read it. */
  private async ready(sql: Sql, order: CopyOrder | null): Promise<void> {
    /* The server moved in a planned switch, and the new leader made this copy a slot: written down first, then joined. */
    const joining = this.kept.old ? null : this.joinOf(order);
    if (joining) {
      this.disabledSince = null;
      return this.keep({ attempt: joining.attempt, phase: 'join', slot: joining.slot, moved: null, seen: false, missing: 0, ...(order?.leader === undefined ? {} : { leader: order.leader }) });
    }
    const sub = await this.subscription(sql);
    const at = await this.pulse(sql);
    /* A copy a build of before made says now how many migrations its schema has, so a leader of another version makes
       it again and does not start it. */
    await this.ownMigrations(sql);
    /* A view of another leader than the one this copy follows counts toward none of the reasons to make it again,
       until that leader named no slot for it twice in a row: then it did not hold everything, and is made again. */
    const elsewhere = this.moving(order);
    /* A copy that is to be made again whatever its subscription does is not started first: one that stood still for
       the leader's update takes nothing from a database of another version. */
    const known = elsewhere ? null : this.broken(order, 0);
    const stopped = sub && !known ? await this.stoppedFor(sql, sub) : 0;
    const why = elsewhere ? (elsewhere.moved ? 'the company server moved to a machine that does not hold a place for this copy' : null) : (known ?? this.broken(order, sub ? stopped : ENABLE_FOR_MS));
    if (why) return this.kept.old ? this.giveUp(why === OTHER_VERSION) : this.remake(why);
    if (!sub || stopped > 0) {
      const free = this.opts.diskFree();
      this.said = this.stopped(free !== null && free < DISK_FULL ? 'disk_full' : 'apply', at);
      return;
    }
    if (!this.kept.old) {
      this.said = { state: 'ready', progress: null, error: null, at, name: this.name(), old: null };
      return;
    }
    const { led } = this.kept.old;
    this.said = { state: 'ready', progress: null, error: null, at, name: this.name(), old: { attempt: this.kept.old.attempt, ...(led === undefined ? {} : { led }) } };
    /* A database that led goes only once its bundle is recorded too. */
    if ((order?.old === 'merged' || order?.old === 'done') && (led === undefined || this.opts.saver?.done() === true)) {
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
     keeper that starts in the middle goes on with what is left. The next asks for its schema ten minutes later, twice
     as long after each attempt given up in a row, two hours at most; soon: at once, when none was given up before. */
  private giveUp(soon = false): void {
    const { given } = this.kept;
    const wait = soon && given === 0 ? 0 : Math.min(RETRY_MS * 2 ** given, RETRY_MAX_MS);
    this.keep({ attempt: this.kept.attempt + 1, phase: 'drop', notBefore: wait === 0 ? null : new Date(this.now() + wait).toISOString(), seen: false, missing: 0, given: given + 1 });
    this.disabledSince = null;
    this.said = this.making(0);
  }

  /* Each subscription of a database is given up: disabled, parted from its slot, which the leader then drops, and
     dropped. Each step is skipped when it is done. One that is dropped goes with its slot where the leader answers in
     time: Postgres then drops on the leader that slot and those of its tables' first copies that are not through,
     which would else stay there until the leader's sweep, and reserve its log meanwhile. Otherwise it is parted from
     its slot and from the leader itself, so its drop asks the leader nothing more and leaves those to the sweep. */
  private async release(sql: Sql, drop: boolean): Promise<void> {
    for (const sub of await this.subscriptions(sql)) {
      if (sub.enabled) await sql.query(`ALTER SUBSCRIPTION ${ident(sub.name)} DISABLE`);
      if (drop && sub.slot) {
        try {
          await this.askingLeader(sql, `DROP SUBSCRIPTION ${ident(sub.name)}`);
          continue;
        } catch (err) {
          this.opts.log(`Could not drop the slots of a copy given up on the company server, which drops them itself later: ${reasonOf(err)}`);
        }
      }
      if (sub.slot) await sql.query(`ALTER SUBSCRIPTION ${ident(sub.name)} SET (slot_name = NONE)`);
      if (!drop) continue;
      await sql.query(`ALTER SUBSCRIPTION ${ident(sub.name)} CONNECTION ${literal(NOWHERE)}`);
      await sql.query(`DROP SUBSCRIPTION ${ident(sub.name)}`);
    }
  }

  /* A statement of the copy's Postgres that asks the leader something on the way. Postgres waits for the leader's
     answer for as long as the link holds the connection open with none, whatever the connection's own timeout says,
     and goes on after the keeper stopped waiting: the next tick would then pile the same statement onto it, each
     holding its locks, until the link let go of them all at once. So the statement's own session ends the wait first. */
  private async askingLeader(sql: Sql, text: string): Promise<void> {
    await sql.query(`SET statement_timeout = ${LEADER_WAIT_MS}`);
    try {
      await sql.query(text);
    } finally {
      await sql.query('RESET statement_timeout').catch(() => undefined);
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
        /* A database that led goes only as the old one of a remake whose bundle is recorded and whose merge the leader made. */
        const saved = this.kept.old?.led !== undefined && this.opts.saver?.done() === true;
        if (!saved && (await this.led(this.on(old)))) {
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
    if (this.kept.old?.led !== undefined) this.opts.saver?.forget();
    this.keep({ swap: null, stamp: null, swapAt: null, old: null, database: FIRST_DB, phase: 'ready' });
  }
}
