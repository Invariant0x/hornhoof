import type { Route, SyncPost, SyncRecord, SyncResult } from '../link/relay.js';
import { moveTarget } from '../copies/move.js';
import type { Sql } from './lease-store.js';
import { reasonOf } from './machine-keys.js';
import { lsnAtLeast, nextSyncStep, PACE_MS, SAMPLE_EVERY_MS, SILENT_REPLY_MS, SLOW_WAIT_MS, type CopySample, type Flag, type SyncAction, type SyncMemory, type SyncSample } from './sync-step.js';

/* How often the relay is asked who holds the company's route, while a copy exists or something of one is left. */
const ROUTE_EVERY_MS = 5_000;
const PULSE_EVERY_MS = 1_000;
/* How often the request to move the server is read. */
const TARGET_EVERY_MS = 1_000;
const BYTES_OVER_MS = 5_000;

/* What the controller asks the leader's own Postgres. machines: the other live machines that hold the data.
   replication: the slot and the connection of each copy, by the copy's name. setting: the copy each commit waits for,
   or none. position: how far the leader has written. oldestWaitMs: for how long the oldest commit has waited on the
   copy. Each of set, clear and checkpoint ends only once Postgres has done it. pulse: the row every copy reads the
   leader's clock from. moveTarget: the network id of the machine the server is asked to move to, or none. */
export type SyncCatalog = {
  machines(): Promise<{ machine: string; networkId: string; number: number | null; copyName: string | null; ready: boolean }[]>;
  replication(): Promise<{ name: string; confirmed: string | null; pid: number | null; replyTime: string | null; syncState: string | null }[]>;
  setting(): Promise<string | null>;
  position(): Promise<string>;
  oldestWaitMs(): Promise<number | null>;
  set(name: string): Promise<void>;
  clear(): Promise<void>;
  checkpoint(): Promise<void>;
  pulse(): Promise<void>;
  moveTarget(): Promise<string | null>;
};

const STANDBY = /^FIRST 1 \("([^"]+)"\)$/;
const HAS_MOVES = `SELECT to_regclass('net.move') IS NOT NULL AS there`;
const HAS_COPIES = `SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'machines' AND column_name = 'copy_name') AS there`;

/* The catalog of a real Postgres. sql: the keeper's session, whose commits count once this machine wrote them, so none
   of its own statements waits on a copy. slow: a session with patience for a checkpoint. machineId: this machine's id,
   which is not among the others. A database of the build before knows no copies, and then there are none. */
export function pgCatalog(sql: Sql, slow: Sql, machineId: string): SyncCatalog {
  const one = async <R>(on: Sql, text: string, params?: unknown[]): Promise<R | undefined> => (await on.query<R>(text, params)).rows[0];
  /* Asked until the answer is yes, which no later update takes back. */
  let knowsCopies = false;
  let knowsMoves = false;
  return {
    machines: async () => {
      knowsCopies ||= (await one<{ there: boolean }>(sql, HAS_COPIES))?.there === true;
      if (!knowsCopies) return [];
      const { rows } = await sql.query<{ machine: string; networkId: string; number: number | null; copyName: string | null; ready: boolean }>(
        `SELECT id::text AS machine, network_id AS "networkId", server_order AS number, copy_name AS "copyName", copy_state IS NOT DISTINCT FROM 'ready' AS ready
           FROM public.machines WHERE role = 'data' AND revoked_at IS NULL AND network_id IS NOT NULL AND network_id <> $1 ORDER BY server_order NULLS LAST, id`,
        [machineId],
      );
      return rows;
    },
    replication: async () =>
      (
        await sql.query<{ name: string; confirmed: string | null; pid: number | null; replyTime: string | null; syncState: string | null }>(
          `SELECT s.slot_name::text AS name, s.confirmed_flush_lsn::text AS confirmed, r.pid, r.reply_time::text AS "replyTime", r.sync_state AS "syncState"
             FROM pg_replication_slots s LEFT JOIN pg_stat_replication r ON r.application_name = s.slot_name AND r.pid = s.active_pid WHERE s.slot_name LIKE 'copy\\_%'`,
        )
      ).rows,
    setting: async () => STANDBY.exec((await one<{ synchronous_standby_names: string }>(sql, 'SHOW synchronous_standby_names'))?.synchronous_standby_names ?? '')?.[1] ?? null,
    position: async () => (await one<{ lsn: string }>(sql, 'SELECT pg_current_wal_lsn()::text AS lsn'))!.lsn,
    oldestWaitMs: async () => {
      const row = await one<{ ms: number | null }>(sql, `SELECT (max(extract(epoch FROM clock_timestamp() - query_start)) * 1000)::float8 AS ms FROM pg_stat_activity WHERE wait_event = 'SyncRep'`);
      return row?.ms === null || row?.ms === undefined ? null : Number(row.ms);
    },
    set: async name => {
      if (!/^[a-z0-9_]{1,63}$/.test(name)) throw new Error('that is no name of a copy');
      await slow.query(`ALTER SYSTEM SET synchronous_standby_names = 'FIRST 1 ("${name}")'`);
      await slow.query('SELECT pg_reload_conf()');
    },
    clear: async () => {
      await slow.query('ALTER SYSTEM RESET synchronous_standby_names');
      await slow.query('SELECT pg_reload_conf()');
    },
    checkpoint: async () => void (await slow.query('CHECKPOINT')),
    pulse: async () => void (await sql.query('INSERT INTO net.pulse (at) VALUES (clock_timestamp()) ON CONFLICT (id) DO UPDATE SET at = excluded.at')),
    moveTarget: async () => {
      knowsMoves ||= (await one<{ there: boolean }>(sql, HAS_MOVES))?.there === true;
      return knowsMoves ? moveTarget(sql) : null;
    },
  };
}

export type SyncControllerOptions = {
  catalog: SyncCatalog;
  relay: { route(name: string, key: string): Promise<Route>; setSync(name: string, key: string, post: SyncPost): Promise<SyncResult> };
  /* The company's link as this keeper's own frpc logs in: its name, its key, and the id that client goes by. Null
     without a link, undefined when it cannot be read now. */
  link: () => Promise<{ name: string; key: string; client: string } | null | undefined>;
  /* What this machine's database sent a copy's machine over the peer link so far. */
  dbBytes: (machine: string) => number;
  /* Whether this keeper leads now: only then is the pulse written. */
  leads: () => boolean;
  log: (line: string) => void;
  /* A clock that never steps back, in milliseconds. */
  now?: () => number;
  everyMs?: number;
  routeEveryMs?: number;
};

type Seen = { pid: number | null; replyTime: string | null; at: number };

/* Decides, look by look, whether a commit waits for a copy, and keeps hornhoof.org told which machine holds the latest
   changes. A copy that holds every table and keeps pace is named, and the relay learns it only once the copy holds
   everything the leader had written when the setting took hold. A copy that falls silent is dropped within seconds,
   and only after the relay stored that this machine alone holds the latest changes. So whoever reads the relay's
   record is never told of a copy that lacks a confirmed change. */
export class SyncController {
  private memory: SyncMemory = { w: null, posting: false, flag: null, checkpointed: false, blocked: false };
  private stored: SyncRecord | null = null;
  private route: { client: string; generation: number } | null = null;
  private made: number | null = null;
  private routeAt = -Infinity;
  private timer: NodeJS.Timeout | null = null;
  private working: Promise<void> | null = null;
  private stopped = false;
  private failing = false;
  private readonly replies = new Map<string, Seen>();
  private readonly paceSince = new Map<string, number>();
  private positions: { at: number; lsn: string }[] = [];
  private bytes: { at: number; machine: string; bytes: number }[] = [];
  private slowSince: number | null = null;
  private pulsedAt = -Infinity;
  private target: string | null = null;
  private targetAt = -Infinity;
  private holding = false;
  private heldNow = false;
  private postLine = '';
  private last: { listed: number; copies: CopyView[]; named: string | null } = { listed: 0, copies: [], named: null };

  constructor(private readonly opts: SyncControllerOptions) {}

  private now(): number {
    return this.opts.now?.() ?? performance.now();
  }

  /* Its first look, so the keeper knows its flag before it first takes a lease, then one each quarter of a second. */
  async start(): Promise<void> {
    await this.look();
    this.timer = setInterval(() => void this.look(), this.opts.everyMs ?? SAMPLE_EVERY_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.working;
  }

  /* What the lease carries: none while nothing may be confirmed. */
  flag(): Flag {
    return this.memory.flag;
  }

  /* False while a commit has waited long on a copy that cannot be dropped: the lease then ends by itself. */
  renew(): boolean {
    return !this.memory.blocked;
  }

  /* How many other machines hold the data, as the last look found. */
  listed(): number {
    return this.last.listed;
  }

  /* Each copy as the last look found it, for the app to show. */
  copies(): CopyView[] {
    return this.last.copies;
  }

  /* The network id of the machine whose copy commits wait for, as the last look found the setting. */
  named(): string | null {
    return this.last.named;
  }

  /* What the relay holds of which machine has the latest changes, as last read or stored. */
  record(): SyncRecord | null {
    return this.stored;
  }

  /* Commits wait for no copy from the next look on, until this is taken back: for an update whose migrations run. */
  hold(on: boolean): void {
    this.holding = on;
    if (!on) this.heldNow = false;
  }

  /* Whether the hold took: it is on, the relay stored that this machine alone holds the latest changes at the route's
     generation of now, and the setting names nobody. As the last look found it. */
  held(): boolean {
    return this.holding && this.heldNow;
  }

  /* The generation of the company's route while this keeper's own client holds it, as last read. */
  generation(): number | null {
    return this.route?.generation ?? null;
  }

  /* The generation at which this keeper's own client last held the company's route, also once it holds it no more:
     hornhoof.org names nobody for a name that is free, so a keeper that comes back to it knows its own registration
     only by this. None until it saw its client hold the route. */
  lastHeld(): number | null {
    return this.made;
  }

  /* One look at a time. A look that fails changes nothing, the flag included, and is said once an outage. */
  look(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.working ??= this.lookOnce()
      .then(
        () => void (this.failing = false),
        (err: unknown) => {
          if (!this.failing) this.opts.log(`The keeper could not look at the copies: ${reasonOf(err)}`);
          this.failing = true;
        },
      )
      .finally(() => void (this.working = null));
    return this.working;
  }

  private async lookOnce(): Promise<void> {
    const sample = await this.sample();
    const step = nextSyncStep(sample, this.memory);
    this.memory = step.memory;
    await this.act(step.action);
    if (sample.listed > 0 && this.opts.leads() && sample.now - this.pulsedAt >= PULSE_EVERY_MS) {
      this.pulsedAt = sample.now;
      await this.opts.catalog.pulse();
    }
  }

  /* The relay is asked now and again while a copy exists or something of one is left to undo; a company of one
     machine that never had a copy asks it once. */
  private async readRoute(force = false): Promise<void> {
    const now = this.now();
    if (!force && now - this.routeAt < (this.opts.routeEveryMs ?? ROUTE_EVERY_MS)) return;
    this.routeAt = now;
    const link = await this.opts.link();
    if (link === undefined) return;
    if (link === null) {
      this.route = null;
      this.stored = null;
      return;
    }
    const route = await this.opts.relay.route(link.name, link.key);
    if (!route.known) {
      this.route = null;
      return;
    }
    this.stored = route.sync;
    this.route = route.state === 'held' && route.client === link.client ? { client: link.client, generation: route.generation } : null;
    if (this.route) this.made = this.route.generation;
  }

  private async sample(): Promise<SyncSample> {
    const { catalog } = this.opts;
    const now = this.now();
    const machines = await catalog.machines();
    const setting = await catalog.setting();
    if (machines.length > 0 || setting !== null || this.stored?.state === 'on' || this.routeAt === -Infinity) await this.readRoute();
    const replication = machines.length > 0 || setting !== null ? await catalog.replication() : [];
    const position = machines.length > 0 ? await catalog.position() : null;
    if (position) this.positions.push({ at: now, lsn: position });
    this.positions = this.positions.filter(seen => now - seen.at <= PACE_MS * 4);
    const before = [...this.positions].reverse().find(seen => now - seen.at >= PACE_MS);
    const others: CopySample[] = [];
    for (const machine of machines) {
      if (!machine.copyName) continue;
      const found = replication.find(row => row.name === machine.copyName);
      const keeps = Boolean(before && found?.confirmed && found.pid !== null && lsnAtLeast(found.confirmed, before.lsn));
      if (!keeps) this.paceSince.delete(machine.copyName);
      else if (!this.paceSince.has(machine.copyName)) this.paceSince.set(machine.copyName, now);
      others.push({
        machine: machine.machine, networkId: machine.networkId, number: machine.number ?? Number.MAX_SAFE_INTEGER, name: machine.copyName, finished: machine.ready,
        keptPaceMs: keeps ? now - this.paceSince.get(machine.copyName)! : 0,
        replyAgeMs: this.replyAge(machine.copyName, found ?? null, now),
        confirmed: found?.confirmed ?? null,
        syncState: found?.syncState ?? null,
      });
    }
    for (const name of [...this.replies.keys()]) if (!others.some(copy => copy.name === name)) this.replies.delete(name);
    const oldestWaitMs = setting !== null ? await catalog.oldestWaitMs() : null;
    this.slowSince = oldestWaitMs !== null && oldestWaitMs > SLOW_WAIT_MS ? (this.slowSince ?? now) : null;
    const named = others.find(copy => copy.name === setting);
    this.last = { listed: machines.length, copies: others.map(copy => ({ name: copy.name, networkId: copy.networkId, state: stateOf(copy, setting) })), named: named?.networkId ?? null };
    /* The request is read only where a copy could be its target. */
    if (machines.length === 0) this.target = null;
    else if (now - this.targetAt >= TARGET_EVERY_MS) {
      this.targetAt = now;
      this.target = await catalog.moveTarget();
    }
    this.heldNow = this.holding && setting === null && this.route !== null && this.stored?.state === 'off' && this.stored.generation === this.route.generation;
    return {
      hold: this.holding,
      now, others, listed: machines.length, setting, route: this.route, record: this.stored, oldestWaitMs,
      slowForMs: this.slowSince === null ? 0 : now - this.slowSince,
      namedBytes5s: named ? this.bytesOver(named.machine, now) : 0,
      target: others.some(copy => copy.networkId === this.target) ? this.target : null,
    };
  }

  /* The time since the copy's answer last changed, by this machine's own clock: the answer carries the copy's clock,
     which may be off by seconds, so it is only ever compared with itself. A connection seen first, or a new one,
     starts its clock then. */
  private replyAge(name: string, found: { pid: number | null; replyTime: string | null } | null, now: number): number | null {
    if (!found || found.pid === null) {
      this.replies.delete(name);
      return null;
    }
    const seen = this.replies.get(name);
    if (!seen || seen.pid !== found.pid || seen.replyTime !== found.replyTime) {
      this.replies.set(name, { pid: found.pid, replyTime: found.replyTime, at: now });
      return 0;
    }
    return now - seen.at;
  }

  /* What the named copy took over the last five seconds. */
  private bytesOver(machine: string, now: number): number {
    const bytes = this.opts.dbBytes(machine);
    this.bytes = this.bytes.filter(seen => seen.machine === machine && now - seen.at <= BYTES_OVER_MS);
    this.bytes.push({ at: now, machine, bytes });
    return bytes - this.bytes[0]!.bytes;
  }

  private async act(action: SyncAction): Promise<void> {
    const { catalog } = this.opts;
    if (action.do === 'none') return;
    if (action.do === 'post') return this.post(action.state, action.state === 'on' ? action.copy : null);
    if (action.do === 'set') return catalog.set(action.name);
    if (action.do === 'clear') return catalog.clear();
    if (action.do === 'checkpoint') {
      await catalog.checkpoint();
      this.memory = { ...this.memory, checkpointed: true };
      return;
    }
    /* Read only after the checkpoint ended: every commit from here on waits for the copy. */
    this.memory = { ...this.memory, w: await catalog.position() };
  }

  /* The route is read again first, so the record is stored at the generation this keeper's client holds now, one epoch
     above the one the relay has. Anything but a stored record is one line, and the next look decides again. */
  private async post(state: 'on' | 'off', copy: string | null): Promise<void> {
    try {
      await this.readRoute(true);
      const link = await this.opts.link();
      if (!link || !this.route) throw new Error("this keeper's own link does not hold the company's route now");
      const stored = await this.opts.relay.setSync(link.name, link.key, { client: this.route.client, generation: this.route.generation, state, copy, epoch: (this.stored?.epoch ?? 0) + 1 });
      if (!stored.stored) throw new Error(`hornhoof.org did not store it (${stored.why})`);
      this.stored = stored.sync;
      this.posted('');
    } catch (err) {
      this.posted(`Could not tell hornhoof.org which machine holds the latest changes: ${reasonOf(err)}`);
    } finally {
      this.memory = { ...this.memory, posting: false };
    }
  }

  /* A failure that goes on is said once; an empty line only forgets it. */
  private posted(line: string): void {
    if (line && line !== this.postLine) this.opts.log(line);
    this.postLine = line;
  }
}

/* A copy as the last look found it: the name of its slot, its machine's network id, and how it does. */
export type CopyView = { name: string; networkId: string; state: 'sync' | 'pace' | 'behind' | 'silent' };

/* How a copy does, as the app shows it: the one commits wait for, one that keeps pace, one that is connected and
   behind, and one that says nothing. */
function stateOf(copy: CopySample, setting: string | null): 'sync' | 'pace' | 'behind' | 'silent' {
  if (copy.replyAgeMs === null || copy.replyAgeMs > SILENT_REPLY_MS) return 'silent';
  if (copy.name === setting && copy.syncState === 'sync') return 'sync';
  return copy.keptPaceMs > 0 ? 'pace' : 'behind';
}
