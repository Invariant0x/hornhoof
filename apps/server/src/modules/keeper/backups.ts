import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { Peer } from '../../net/peer-server.js';
import { UUID } from '../../net/proxy.js';
import { BundleRefused, checkHead, sealBundle, type BundleReason, type BundleSecrets } from '../backups/bundle.js';
import { BundleStore } from '../backups/store.js';
import { FORK_KEEP_MS, type MakerView } from '../backups/types.js';
import type { HeldCertificate } from './certificate.js';
import { reasonOf, type MachineKey } from './machine-keys.js';
import { INCOMING_DIR, RESTORE_DIR, RestoreRunner } from './restore.js';

export const BUNDLE_EVERY_MS = 6 * 3_600_000;
/* At most one dump is asked for in this long, but for the first after a new recovery file. */
export const DUMP_GAP_MS = 600_000;
/* A dump not sealed within this long is deleted. */
export const DUMP_LIFE_MS = 86_400_000;
/* How many of its own bundles the machine that makes them keeps. */
const KEEP_OWN = 2;
/* In the keeper's volume. */
export const BUNDLES_DIR = 'bundles';

const EVERY_MS = 10_000;
const REASONS: readonly string[] = ['timer', 'update', 'fork'] satisfies BundleReason[];

/* stop: the ask gives up as soon as it is aborted. */
export type Ask = (method: 'GET' | 'POST', path: string, body?: unknown, stop?: AbortSignal) => Promise<{ status: number; body: unknown }>;
/* What the peer link serves of backups: a bundle to a machine picked to hold it, and a bundle taken back from one. */
export type PeerBackups = {
  get(peer: Peer, id: string): { status: 200; length: number; stream(): Readable } | { status: 403 | 404 };
  put(peer: Peer, id: string, body: Readable): Promise<201 | 400 | 403>;
};
type BackupKeeperOptions = {
  /* The keeper's own folder; the bundles lie in a folder of it. */
  dir: string;
  controlDir: string;
  key: MachineKey;
  held: () => HeldCertificate | null;
  /* The machine's own key for backups: every bundle is sealed to it. */
  age: { identity: string; recipient: string };
  secrets: () => BundleSecrets;
  ask: Ask;
  leads: () => boolean;
  log: (line: string) => void;
  now?: () => Date;
  everyMs?: number;
};
/* A dump as the updater leaves it in the control folder. */
type Dump = { id: string; reason: BundleReason; at: Date; migrations: number };

function readDump(path: string, id: string): Dump | null {
  try {
    const said = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const at = new Date(String(said.at));
    if (said.id !== id || !REASONS.includes(String(said.reason)) || Number.isNaN(at.getTime()) || !Number.isInteger(said.migrations) || (said.migrations as number) < 0) return null;
    return { id, reason: said.reason as BundleReason, at, migrations: said.migrations as number };
  } catch {
    return null;
  }
}

/* The keeper of the machine that holds the company's data makes its backups. Only the updater reaches the database, so
   the keeper asks it for a dump through the control folder, seals what it finds there to the machines that hold the
   data and to the recovery key, signs it, keeps it and has its app record it; then the dump goes. It serves each bundle
   to the machines its app picked to hold it. No dump stays in the clear for longer than a day, whatever else fails. */
export class BackupKeeper {
  private readonly bundles: BundleStore;
  /* The keeper's part of a restore its app orders. */
  private readonly restores: RestoreRunner;
  private readonly dumps: string;
  private readonly request: string;
  private last: MakerView | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  /* Ends an ask that waits for the app when the keeper stops. */
  private readonly stopping = new AbortController();
  /* When it last asked for a dump, and when it last did so ahead of the gap for a new recovery key, and for which. */
  private askedAt: number | null = null;
  private aheadAt: number | null = null;
  private askedFor: string | null = null;
  /* When the newest bundle the app last named was made. */
  private newestSeen: number | null = null;
  /* When it last asked for the dump of each database set aside before a merge. */
  private readonly forkAskedAt = new Map<string, number>();

  constructor(private readonly opts: BackupKeeperOptions) {
    this.bundles = new BundleStore(join(opts.dir, BUNDLES_DIR));
    this.restores = new RestoreRunner({
      controlDir: opts.controlDir, own: this.bundles, incoming: new BundleStore(join(opts.controlDir, RESTORE_DIR, INCOMING_DIR)), identity: opts.age.identity, log: opts.log, now: opts.now,
    });
    this.dumps = join(opts.controlDir, 'dumps');
    this.request = join(opts.controlDir, 'dump.json');
  }

  start(): void {
    const look = () => void this.round().catch(err => this.opts.log(`The keeper could not look after the backups: ${reasonOf(err)}`));
    this.timer = setInterval(look, this.opts.everyMs ?? EVERY_MS);
    this.timer.unref();
    look();
  }

  /* Waits for a round on its way, so nothing of this still asks the app once it has stopped; an ask that waits for the
     app ends now, so an app that hangs does not hold the stop. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopping.abort();
    await this.running?.catch(() => undefined);
  }

  /* One look. A round that still runs is the one a second caller waits for. */
  round(): Promise<void> {
    this.running ??= this.look().finally(() => { this.running = null; });
    return this.running;
  }

  /* What the app said last of the company's backups. */
  view(): MakerView | null {
    return this.last;
  }

  store(): BundleStore {
    return this.bundles;
  }

  /* The public half of the machine's key for backups, which its report carries. */
  ageRecipient(): string {
    return this.opts.age.recipient;
  }

  /* The bundles this machine holds, newest first. */
  held(): string[] {
    return this.bundles.list().map(bundle => bundle.id);
  }

  /* What its report says it holds. */
  reported(): string[] {
    return this.bundles.reported();
  }

  peer(): PeerBackups {
    return {
      get: (peer, id) => {
        const bundle = this.bundles.open(id);
        if (!bundle) return { status: 404 };
        return this.last?.holders[id]?.includes(peer.machine) ? { status: 200, ...bundle } : { status: 403 };
      },
      put: async (peer, id, body) => {
        const view = this.last;
        const held = this.opts.held();
        if (!view || !held || !view.wanted.some(want => want.id === id && want.from === peer.machine)) return 403;
        if (this.bundles.has(id)) return 201;
        try {
          await this.bundles.take(body, head => checkHead(head, { authorityPem: held.authorityPem, company: view.company }), { id });
          return 201;
        } catch {
          body.destroy();
          return 400;
        }
      },
    };
  }

  /* A machine that holds the data and led before gives what its database held, sealed as a fork and signed with its
     own certificate. It is taken only from that very machine, and recorded with the app under its name; the status
     says how that went. A bundle held here already passes the same checks: only its signer sends it again, and no
     answer to any request removes it. */
  async takeLed(peer: Peer, id: string, body: Readable): Promise<number> {
    const view = this.last;
    const held = this.opts.held();
    if (!view || !held || peer.role !== 'data') {
      body.destroy();
      return 403;
    }
    let refused = false;
    const sentBy = (said: string) => {
      const manifest = checkHead(said, { authorityPem: held.authorityPem, company: view.company });
      if (manifest.signer !== peer.machine || manifest.reason !== 'fork') {
        refused = true;
        throw new BundleRefused('role', 'This bundle is not a fork its sender signed.');
      }
      return manifest;
    };
    const stored = this.bundles.list().find(bundle => bundle.id === id);
    let head: string;
    try {
      if (stored) body.destroy();
      /* A take answers with the bundle another request stored meanwhile: that one is checked too. */
      head = stored?.head ?? (await this.bundles.take(body, sentBy, { id })).head;
      sentBy(head);
    } catch {
      body.destroy();
      return refused ? 403 : 400;
    }
    const recorded = await this.opts.ask('POST', '/api/network/backups', { head, from: peer.machine }, this.stopping.signal).catch(() => null);
    if (recorded?.status === 200 || recorded?.status === 201) return recorded.status;
    /* The app would not have what this request brought: nothing of it stays here. */
    if (!stored && recorded && recorded.status >= 400 && recorded.status < 500) this.bundles.remove(id);
    return recorded?.status ?? 503;
  }

  private now(): number {
    return (this.opts.now?.() ?? new Date()).getTime();
  }

  private async look(): Promise<void> {
    this.sweep();
    if (!this.opts.leads()) return;
    const view = await this.ask();
    if (!view) return;
    this.last = view;
    /* The order may carry a recovery identity: it is handed on in memory, and nothing here writes a view anywhere. */
    this.restores.take(view.order);
    const held = this.opts.held();
    if (view.company && held?.role === 'data') {
      /* A database set aside before a merge is saved before it goes: its dump is asked for before one that is due. */
      if (!this.askForFork(view)) this.askForDump(view);
      await this.sealDumps(view, view.company, held);
      await this.recordFork(view);
    }
    this.bundles.keepOnly([...this.ownToKeep(), ...Object.keys(view.holders), ...(view.order ? [view.order.id] : [])]);
  }

  /* Its latest bundles of the database in use, and beside them every fork bundle until its 30 days end. */
  private ownToKeep(): string[] {
    const all = this.bundles.list();
    const now = this.now();
    const latest = all.filter(bundle => bundle.manifest.reason !== 'fork').slice(0, KEEP_OWN);
    const forks = all.filter(bundle => bundle.manifest.reason === 'fork' && now - Date.parse(bundle.manifest.madeAt) < FORK_KEEP_MS);
    return [...latest, ...forks].map(bundle => bundle.id);
  }

  /* Asks the updater for the dump of the database the app names, under the id its merge gave it, when this machine has
     neither its bundle nor its dump and no dump is on its way. Outside the gap between dumps, but for one that failed,
     which is asked for again only after it. True when the request is the fork's now. */
  private askForFork(view: MakerView): boolean {
    const fork = view.fork;
    if (!fork || this.bundles.has(fork.id)) return false;
    const files = this.files();
    if (existsSync(this.request) || files.some(name => name.endsWith('.json'))) return files.some(name => name.startsWith(fork.id)) || this.wantedNow() === fork.id;
    const now = this.now();
    const asked = this.forkAskedAt.get(fork.id);
    if (asked !== undefined && now - asked < DUMP_GAP_MS) return false;
    try {
      writeFileSync(`${this.request}.new`, JSON.stringify({ id: fork.id, database: fork.database, reason: 'fork' }));
      renameSync(`${this.request}.new`, this.request);
    } catch (err) {
      this.opts.log(`The keeper could not ask the updater for a dump of the database: ${reasonOf(err)}`);
      return false;
    }
    this.forkAskedAt.set(fork.id, now);
    return true;
  }

  private wantedNow(): string | null {
    try {
      const id = (JSON.parse(readFileSync(this.request, 'utf8')) as { id?: unknown }).id;
      return typeof id === 'string' ? id : null;
    } catch {
      return null;
    }
  }

  /* A fork the app still has no record of, though this machine holds its bundle and its dump is gone: its stored head
     goes again, each round, until the app has it. */
  private async recordFork(view: MakerView): Promise<void> {
    const fork = view.fork;
    if (!fork || existsSync(join(this.dumps, `${fork.id}.json`))) return;
    const head = this.bundles.list().find(bundle => bundle.id === fork.id)?.head;
    if (head) await this.opts.ask('POST', '/api/network/backups', { head }, this.stopping.signal).catch(() => null);
  }

  /* A dump in the clear is never left for long: this runs first, whether the machine leads, its app answers or its keys
     are ready. */
  private sweep(): void {
    let gone = 0;
    for (const name of this.files()) {
      const path = join(this.dumps, name);
      try {
        if (this.now() - statSync(path).mtimeMs < DUMP_LIFE_MS) continue;
        rmSync(path, { force: true });
        gone += 1;
      } catch {
        /* Gone meanwhile, or not the keeper's to read yet: the next round looks again. */
      }
    }
    if (gone > 0) this.opts.log(`Deleted ${gone} ${gone === 1 ? 'file' : 'files'} of a database dump that was not sealed within a day.`);
  }

  private files(): string[] {
    try {
      return readdirSync(this.dumps);
    } catch {
      return [];
    }
  }

  private async ask(): Promise<MakerView | null> {
    try {
      const answer = await this.opts.ask('GET', '/api/network/backups', undefined, this.stopping.signal);
      return answer.status === 200 ? (answer.body as MakerView) : null;
    } catch {
      return null;
    }
  }

  /* The company's records went back in time: it was restored from a backup. What it holds now is in no bundle, so its
     first dump waits for nothing that was asked before. */
  private noteRestore(view: MakerView): void {
    const newest = view.last ? Date.parse(view.last.madeAt) : null;
    if (this.newestSeen !== null && (newest === null || newest < this.newestSeen)) this.askedAt = this.aheadAt = this.askedFor = null;
    this.newestSeen = newest;
  }

  /* A bundle is due when there is none, when the newest is six hours old, and when the recovery key changed since. */
  private askForDump(view: MakerView): void {
    this.noteRestore(view);
    const now = this.now();
    const forKey = view.recovery && view.recovery.recipient !== view.last?.recovery ? view.recovery.recipient : null;
    const due = !view.last || now - Date.parse(view.last.madeAt) >= BUNDLE_EVERY_MS || forKey !== null;
    if (!due || existsSync(this.request) || this.files().some(name => name.endsWith('.json'))) return;
    /* A new recovery file soon has a bundle it opens: its first dump does not wait for the gap. Only one such dump in a
       gap, so a file made again and again asks for no more than any other reason does. */
    const ahead = forKey !== null && forKey !== this.askedFor && (this.aheadAt === null || now - this.aheadAt >= DUMP_GAP_MS);
    if (this.askedAt !== null && now - this.askedAt < DUMP_GAP_MS && !ahead) return;
    try {
      writeFileSync(`${this.request}.new`, JSON.stringify({ id: randomUUID() }));
      renameSync(`${this.request}.new`, this.request);
    } catch (err) {
      this.opts.log(`The keeper could not ask the updater for a dump of the database: ${reasonOf(err)}`);
      return;
    }
    if (this.askedAt !== null && now - this.askedAt < DUMP_GAP_MS) this.aheadAt = now;
    this.askedAt = now;
    this.askedFor = forKey;
  }

  private async sealDumps(view: MakerView, company: string, held: HeldCertificate): Promise<void> {
    for (const name of this.files()) {
      const id = name.slice(0, name.lastIndexOf('.'));
      if (name.endsWith('.failed')) this.failed(id, name);
      else if (name.endsWith('.json')) await this.seal(id, view, company, held);
    }
  }

  /* The updater could not dump: one line, and the keeper asks anew once the gap is over. */
  private failed(id: string, name: string): void {
    let why = '';
    try {
      why = readFileSync(join(this.dumps, name), 'utf8').trim().slice(0, 200);
    } catch {
      /* Not readable: the line goes without it. */
    }
    this.opts.log(`The updater could not dump the database for a backup${why ? `: ${why}` : '.'}`);
    this.forget(id);
  }

  /* The request goes first when it names this dump: an updater that finds it again with no dump there would dump twice. */
  private forget(id: string): void {
    try {
      if ((JSON.parse(readFileSync(this.request, 'utf8')) as { id?: unknown }).id === id) rmSync(this.request, { force: true });
    } catch {
      /* No request, or not one to read. */
    }
    for (const end of ['.sql.gz', '.json', '.failed']) rmSync(join(this.dumps, `${id}${end}`), { force: true });
  }

  private async seal(id: string, view: MakerView, company: string, held: HeldCertificate): Promise<void> {
    const dump = UUID.test(id) ? readDump(join(this.dumps, `${id}.json`), id) : null;
    const file = join(this.dumps, `${id}.sql.gz`);
    if (!dump || !existsSync(file)) {
      this.opts.log('The keeper deleted a dump of the database it could not read.');
      return this.forget(id);
    }
    let head = this.bundles.list().find(bundle => bundle.id === id)?.head;
    if (!head) {
      mkdirSync(join(this.opts.dir, BUNDLES_DIR), { recursive: true, mode: 0o700 });
      const out = join(this.opts.dir, BUNDLES_DIR, `${id}.${randomBytes(6).toString('hex')}.part`);
      try {
        const sealed = await sealBundle({
          dump: createReadStream(file), id, company, dumpedAt: dump.at, now: new Date(this.now()), reason: dump.reason, migrations: dump.migrations,
          secrets: this.opts.secrets(), recipients: [...view.recipients, this.opts.age.recipient], recovery: view.recovery?.recipient ?? null,
          recoveryLink: view.recovery?.link ?? null, key: this.opts.key, held, out,
        });
        head = this.bundles.put(sealed.head, sealed.manifest, out).head;
      } catch (err) {
        rmSync(out, { force: true });
        this.opts.log(`The keeper could not seal a dump of the database: ${reasonOf(err)}`);
        return;
      }
    }
    /* Recorded, the dump goes. An app that does not take the record leaves it for the next round, which seals nothing
       again and only records. */
    const recorded = await this.opts.ask('POST', '/api/network/backups', { head }, this.stopping.signal).catch(() => null);
    if (recorded?.status === 200 || recorded?.status === 201) this.forget(id);
  }
}
