import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { BundleRefused, checkHead, openBundle } from '../backups/bundle.js';
import type { BundleStore, StoredBundle } from '../backups/store.js';
import { ROOM, type RestoreOrder, type RestoreStatus, type RestoreStep } from '../backups/types.js';
import { reasonOf } from './machine-keys.js';

/* For how long the keeper waits for a holder to send the bundle. */
export const FETCH_WAIT_MS = 1_800_000;
export const RESTORE_DIR = 'restore';
/* Where the bundles lie that were sent for a restore with no database to check them against. */
export const INCOMING_DIR = 'incoming';

const STATUS_FILE = 'restore-status.json';
const ORDER_FILE = 'restore.json';
const POLL_MS = 1000;
/* The steps that are the keeper's own; the updater's follow them. */
const OWN_STEPS: readonly RestoreStep[] = ['fetch', 'check', 'open'];
const REMEMBERED = 32;

const CALLED_OFF = 'The restore was called off.';
const NOT_SENT = 'No machine sent the backup.';
const NO_MATCH = 'This backup does not match what the company recorded.';
const NO_ROOM = 'Not enough free disk for the restore.';
const NEEDS_FILE = 'This server cannot open the backup. Add the recovery file it was made for.';
const NOT_OPENED = 'The backup could not be opened.';
const RESTARTED = 'The keeper restarted during the restore.';

type RestoreRunnerOptions = {
  controlDir: string;
  /* The keeper's own bundles, and the ones sent to it for a restore after a total loss. */
  own: BundleStore;
  incoming: BundleStore;
  /* The machine's own key for backups. */
  identity: string;
  log: (line: string) => void;
  diskFree?: (dir: string) => number;
  fetchWaitMs?: number;
  now?: () => Date;
  /* How often it looks for the bundle and at its order while it waits. */
  pollMs?: number;
  /* Told each status as it is written. */
  onStatus?: (status: RestoreStatus) => void;
};

/* A step that ended the run: the line a person reads. */
class Stopped extends Error {}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/* The keeper's part of a restore: it gets the bundle its app ordered, checks it against what the company recorded,
   opens it with the machine's key or with the recovery identity the order carries, and lays the dump and the settings
   into the control folder for the updater, which swaps the databases. The identity lives in the order alone: it goes
   into no file and no line. An order the app no longer gives is called off before anything is handed to the updater. */
export class RestoreRunner {
  private readonly dir: string;
  /* The order the app gave last, and the attempts that ran here already. */
  private latest: RestoreOrder | null = null;
  private readonly ran: string[] = [];
  private running = false;

  constructor(private readonly opts: RestoreRunnerOptions) {
    this.dir = join(opts.controlDir, RESTORE_DIR);
    this.tidy();
  }

  /* Starts one run per attempt. A run in progress goes on, unless its order is no longer the one given. */
  take(order: RestoreOrder | null): void {
    this.latest = order;
    if (!this.running) void this.work();
  }

  private async work(): Promise<void> {
    this.running = true;
    try {
      for (let order = this.latest; order && !this.ran.includes(order.attempt); order = this.latest) {
        this.ran.push(order.attempt);
        if (this.ran.length > REMEMBERED) this.ran.shift();
        await this.run(order);
      }
    } finally {
      this.running = false;
    }
  }

  /* What a keeper that was stopped left: every file of a restore the updater was not asked to take goes, and a status
     at one of the keeper's own steps with no order for the updater ends, so the restore can be asked for again. */
  private tidy(): void {
    const asked = readJson<{ attempt?: unknown }>(join(this.opts.controlDir, ORDER_FILE))?.attempt;
    const kept = typeof asked === 'string' ? [`${asked}.sql.gz`, `${asked}.env.json`] : [];
    try {
      for (const name of existsSync(this.dir) ? readdirSync(this.dir) : []) {
        if (name !== INCOMING_DIR && !kept.includes(name)) rmSync(join(this.dir, name), { recursive: true, force: true });
      }
      const status = readJson<RestoreStatus>(join(this.opts.controlDir, STATUS_FILE));
      if (status?.state === 'running' && OWN_STEPS.includes(status.step) && status.attempt !== asked) this.say({ attempt: status.attempt, id: status.id }, 'failed', status.step, RESTARTED);
    } catch (err) {
      this.opts.log(`The keeper could not tidy what a restore left: ${reasonOf(err)}`);
    }
  }

  /* Written whole and then moved, so nobody reads half a status. */
  private say(order: Pick<RestoreOrder, 'attempt' | 'id'>, state: RestoreStatus['state'], step: RestoreStep, line: string): void {
    const status: RestoreStatus = { attempt: order.attempt, id: order.id, state, step, line, at: (this.opts.now?.() ?? new Date()).toISOString(), kept: null };
    const file = join(this.opts.controlDir, STATUS_FILE);
    writeFileSync(`${file}.new`, JSON.stringify(status));
    renameSync(`${file}.new`, file);
    this.opts.onStatus?.(status);
  }

  private wanted(order: RestoreOrder): boolean {
    return this.latest?.attempt === order.attempt;
  }

  private filesOf(order: RestoreOrder): { dump: string; env: string } {
    return { dump: join(this.dir, `${order.attempt}.sql.gz`), env: join(this.dir, `${order.attempt}.env.json`) };
  }

  private drop(order: RestoreOrder): void {
    const { dump, env } = this.filesOf(order);
    for (const path of [dump, `${dump}.part`, env, `${env}.new`]) rmSync(path, { force: true });
  }

  private async run(order: RestoreOrder): Promise<void> {
    let step: RestoreStep = 'fetch';
    /* Before each step: an order the app let go is followed no further. */
    const begin = (next: RestoreStep, line: string) => {
      if (!this.wanted(order)) throw new Stopped(CALLED_OFF);
      step = next;
      this.say(order, 'running', next, line);
    };
    try {
      begin('fetch', 'Getting the backup.');
      const store = order.source === 'incoming' ? this.opts.incoming : this.opts.own;
      await this.fetched(order, store);
      begin('check', 'Checking the backup.');
      const held = await this.checked(order, store);
      begin('open', 'Opening the backup.');
      await this.opened(order, store, held);
      if (!this.wanted(order)) throw new Stopped(CALLED_OFF);
      this.handOver(order);
    } catch (err) {
      this.drop(order);
      /* Only this module's own lines are passed on: what a library says of a failure may quote a key. */
      const line = err instanceof Stopped ? err.message : NOT_OPENED;
      try {
        this.say(order, 'failed', step, line);
      } catch (failure) {
        this.opts.log(`The keeper could not write how a restore ended: ${reasonOf(failure)}`);
      }
    }
  }

  private async fetched(order: RestoreOrder, store: BundleStore): Promise<void> {
    const pollMs = this.opts.pollMs ?? POLL_MS;
    for (let waited = 0; !store.has(order.id); waited += pollMs) {
      if (!this.wanted(order)) throw new Stopped(CALLED_OFF);
      if (waited >= (this.opts.fetchWaitMs ?? FETCH_WAIT_MS)) throw new Stopped(NOT_SENT);
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  }

  /* The stored file is hashed again, its head is checked against the authority and the company the order names, and it
     is the very bundle the company recorded, when there is a record. */
  private async checked(order: RestoreOrder, store: BundleStore): Promise<StoredBundle> {
    try {
      const held = await store.verify(order.id);
      const manifest = checkHead(held.head, { authorityPem: order.authorityPem, company: order.company });
      const { expect } = order;
      if (expect && (manifest.sha256 !== expect.sha256 || manifest.size !== expect.size || manifest.signer !== expect.signer)) throw new Stopped(NO_MATCH);
      return { ...held, manifest };
    } catch {
      throw new Stopped(NO_MATCH);
    }
  }

  private free(): number {
    if (this.opts.diskFree) return this.opts.diskFree(this.opts.controlDir);
    const { bavail, bsize } = statfsSync(this.opts.controlDir);
    return bavail * bsize;
  }

  private async opened(order: RestoreOrder, store: BundleStore, held: StoredBundle): Promise<void> {
    /* The dump and the settings in the clear need as much room as a bundle does where it is kept. */
    if (this.free() < ROOM * held.manifest.size) throw new Stopped(NO_ROOM);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const { dump, env } = this.filesOf(order);
    try {
      const identities = [this.opts.identity, ...(order.identity ? [order.identity] : [])];
      const bundle = await openBundle(createReadStream(store.ageFile(order.id)), held.manifest, identities);
      await pipeline(bundle.dump, createWriteStream(`${dump}.part`, { flags: 'w', mode: 0o600 }));
      renameSync(`${dump}.part`, dump);
      writeFileSync(`${env}.new`, JSON.stringify(bundle.secrets), { mode: 0o600 });
      renameSync(`${env}.new`, env);
    } catch (err) {
      throw new Stopped(err instanceof BundleRefused && err.reason === 'key' ? NEEDS_FILE : NOT_OPENED);
    }
  }

  /* The updater takes over from this file, which names only what is whole. */
  private handOver(order: RestoreOrder): void {
    const file = join(this.opts.controlDir, ORDER_FILE);
    writeFileSync(`${file}.new`, JSON.stringify({ attempt: order.attempt, id: order.id, dumpedAt: order.dumpedAt, carry: order.carry }));
    renameSync(`${file}.new`, file);
  }
}
