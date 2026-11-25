import { createHash } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { floorOf } from '../files/area.js';
import { Challenge, macOf, type Proof } from '../files/proof.js';
import { FileStore } from '../files/store.js';
import { Hourly, reasonOf } from './machine-keys.js';

/* The paths a keeper that holds the company's files asks on: its view and report from the leading app, and the sealed
   files themselves from the leading keeper. */
export const FILES_VIEW_PATH = '/api/network/files';
export const FILE_PATH = '/peer/files/';
/* The sealed files of the store's backup, which the machine picked for it fetches, and one it keeps gives back. */
export const BACKUP_FILE_PATH = '/peer/store-backup/';
/* A file that no record names is left this long before it goes: an upload may still be between the store and its row. */
export const UNNAMED_MS = 86_400_000;
const LOOK_EVERY_MS = 5_000;
/* Every file here is named to the leading app this often, so it says which no record knows. */
const CENSUS_MS = 3_600_000;
const CENSUS_BATCH = 1000;

const SHA = z.string().regex(/^[0-9a-f]{64}$/);
const View = z.object({
  holds: z.boolean(),
  hold: z.array(z.object({ sha256: SHA, sealedSha256: SHA, sealedSize: z.number().int().positive() })),
  drop: z.array(SHA),
  want: z.array(SHA),
  prove: z.array(Challenge).default([]),
  /* The area its owner gives the files; a leader from before it says none. */
  area: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  backup: z
    .object({
      keep: z.boolean(),
      hold: z.array(z.object({ sha256: SHA, sealedSha256: SHA, sealedSize: z.number().int().positive() })),
      drop: z.array(SHA),
      give: z.array(SHA),
      clear: z.boolean(),
      keepDays: z.number().int().positive(),
    })
    .optional(),
});
export type HeldView = z.infer<typeof View>;
const Answer = z.object({ unknown: z.array(SHA).default([]), send: z.array(SHA).default([]), again: z.array(SHA).default([]), prove: z.array(Challenge).default([]), backupUnknown: z.array(SHA).default([]) });

/* The leader as this keeper reaches it: whether one is in reach, a request to its app, and a stream of its own to the
   leading keeper, which carries a file. */
export type FileLink = {
  leader(): unknown;
  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  stream(method: 'GET' | 'PUT', path: string, body?: Readable, length?: number): Promise<{ status: number; length: number | null; body: Readable }>;
};

type FileHolderOptions = {
  /* The store's folder: FILES_DIR/store, which a machine with the data shares with its app. */
  dir: string;
  link: FileLink;
  log: (line: string) => void;
  everyMs?: number;
  now?: () => number;
  /* The free and whole room of the disk the store lies on; none where it cannot be read. */
  disk?: () => { free: number; total: number } | null;
};

/* The room of the disk a folder lies on, or of the one it is to be made in. */
function diskOf(dir: string): { free: number; total: number } | null {
  for (const at of [dir, dirname(dir)]) {
    try {
      const { bavail, blocks, bsize } = statfsSync(at);
      return { free: bavail * bsize, total: blocks * bsize };
    } catch {
      /* Not made yet: the folder it is to be made in. */
    }
  }
  return null;
}

/* Holds the company's files on a machine that gives them an area of its disk: the files the leading app picked it for.
   It takes each file it is to hold from the leading keeper, sealed, and keeps it only when it is as long and hashes to
   what the record says; it cannot open one. It lets a file go only when the leading app says so, sends back a file
   the leader lacks, and says what it keeps. With no leader in reach, it keeps everything. */
export class FileHolder {
  readonly store: FileStore;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private readonly hourly = new Hourly();
  private censusAt = 0;
  private stopped = false;
  /* The sealed bytes the store keeps: counted whole once and at each census, and kept up with each file in or out. */
  private used: number | null = null;

  /* The store's backup, when this machine is picked for it: a folder of its own beside the store, never a live copy. */
  readonly backup: FileStore;
  private backupCensusAt = 0;

  constructor(private readonly opts: FileHolderOptions) {
    this.store = new FileStore(opts.dir);
    this.backup = new FileStore(join(dirname(opts.dir), 'store-backup'));
  }

  start(): void {
    this.timer = setInterval(() => void this.lookOnce(), this.opts.everyMs ?? LOOK_EVERY_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  /* One look at a time; a look asked for while one runs is the one running. */
  lookOnce(): Promise<void> {
    this.running ??= this.look()
      .catch(err => this.say('look', `Could not keep the company's files in step: ${reasonOf(err)}`))
      .finally(() => (this.running = null));
    return this.running;
  }

  /* What the company's files take here, as its keeper reports it; none before it was counted. */
  usedBytes(): number | null {
    return this.used;
  }

  private async countUsed(): Promise<void> {
    let used = 0;
    for (const store of [this.store, this.backup]) for (const file of await store.list()) used += store.sealed(file.sha256)?.length ?? 0;
    this.used = used;
  }

  /* Lets a file go, and counts it no more. */
  async drop(sha256: string, store = this.store): Promise<void> {
    const size = store.sealed(sha256)?.length ?? 0;
    await store.remove(sha256);
    if (this.used !== null && size > 0 && !store.has(sha256)) this.used = Math.max(0, this.used - size);
  }

  /* Whether a file of that size fits: in the area its owner gives the files, past what they take, and on a disk that
     keeps its floor once it came. A disk that cannot be read takes nothing. */
  private roomFor(size: number, area: number | undefined): boolean {
    if (area !== undefined && (this.used ?? 0) + size > area) return false;
    const disk = (this.opts.disk ?? (() => diskOf(this.opts.dir)))();
    return disk !== null && disk.free - floorOf(disk.total) >= size;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private say(key: string, line: string): void {
    if (this.hourly.due(key)) this.opts.log(line);
  }

  private async look(): Promise<void> {
    await this.store.tidy(new Date(this.now()));
    if (this.stopped || !this.opts.link.leader()) return;
    const asked = await this.opts.link.request('GET', `${FILES_VIEW_PATH}?wait=1`);
    if (asked.status !== 200) return;
    const view = View.parse(asked.body);
    if (this.used === null) await this.countUsed();
    const held: string[] = [];
    const dropped: string[] = [];
    /* What is let go of first, so its room is there for what comes. */
    for (const sha256 of view.drop) {
      await this.drop(sha256);
      dropped.push(sha256);
    }
    for (const file of view.hold) {
      if (this.stopped) break;
      if (this.store.has(file.sha256) || (await this.fetch(file, view.area))) held.push(file.sha256);
    }
    for (const sha256 of view.want) await this.send(sha256);
    const proofs = await this.proofsOf(view.prove);
    if (held.length || dropped.length || proofs.length) await this.report(held, dropped, undefined, proofs);
    /* A file to send back that is not here any more is one this machine lost. */
    const lost = view.want.filter(sha256 => !this.store.has(sha256));
    if (lost.length) await this.report([], lost);
    if (this.now() - this.censusAt >= CENSUS_MS) await this.census();
    if (view.backup) await this.lookBackup(view.backup, view.area);
  }

  /* The backup's part of a look: its folder empties once it keeps nothing of the backup; what it lets go of goes first,
     what it is to keep it fetches, what only it keeps as the backup moves off it it gives back, and it says so. The
     machine picked for it names its folder each hour, and lets go of what the backup does not know once older than the
     days it keeps. */
  private async lookBackup(view: NonNullable<HeldView['backup']>, area: number | undefined): Promise<void> {
    await this.backup.tidy(new Date(this.now()));
    if (view.clear) for (const file of await this.backup.list()) await this.drop(file.sha256, this.backup);
    const held: string[] = [];
    const dropped: string[] = [];
    for (const sha256 of view.drop) {
      await this.drop(sha256, this.backup);
      dropped.push(sha256);
    }
    for (const file of view.hold) {
      if (this.stopped) break;
      if (this.backup.has(file.sha256) || (await this.fetch(file, area, this.backup))) held.push(file.sha256);
    }
    for (const sha256 of view.give) await this.send(sha256, this.backup);
    if (held.length || dropped.length) await this.reportBackup({ held, dropped });
    if (view.keep && this.now() - this.backupCensusAt >= CENSUS_MS) await this.censusBackup(view.keepDays);
  }

  private async reportBackup(backup: { held: string[]; dropped: string[]; span?: { after: string; through: string } }): Promise<string[]> {
    const answer = await this.opts.link.request('POST', FILES_VIEW_PATH, { held: [], dropped: [], backup });
    if (answer.status >= 300) throw new Error(`the company server answered ${answer.status}`);
    return Answer.safeParse(answer.body ?? {}).data?.backupUnknown ?? [];
  }

  /* Names every file of its backup folder, a span at a time, so the leading app fetches again what it lost there. */
  async censusBackup(keepDays: number): Promise<void> {
    const here = (await this.backup.list()).sort((x, y) => (x.sha256 < y.sha256 ? -1 : 1));
    const cutoff = this.now() - keepDays * UNNAMED_MS;
    let after = '';
    for (let at = 0; at === 0 || at < here.length; at += CENSUS_BATCH) {
      const batch = here.slice(at, at + CENSUS_BATCH);
      const through = at + CENSUS_BATCH >= here.length ? 'g' : batch.at(-1)!.sha256;
      const unknown = new Set(await this.reportBackup({ held: batch.map(file => file.sha256), dropped: [], span: { after, through } }));
      for (const file of batch) if (unknown.has(file.sha256) && file.at.getTime() < cutoff) await this.drop(file.sha256, this.backup);
      after = through;
    }
    this.backupCensusAt = this.now();
  }

  /* Says what this machine keeps and let go of; the answer names what of it no record knows, and what of it the leader
     lacks and asks for, which goes at once. */
  private async report(held: string[], dropped: string[], span?: { after: string; through: string }, proofs: Proof[] = [], last = false): Promise<string[]> {
    const answer = await this.opts.link.request('POST', FILES_VIEW_PATH, { held, dropped, ...(span ? { span } : {}), ...(proofs.length ? { proofs } : {}) });
    if (answer.status >= 300) throw new Error(`the company server answered ${answer.status}`);
    const said = Answer.safeParse(answer.body ?? {}).data ?? { unknown: [], send: [], again: [], prove: [] };
    for (const sha256 of said.send) await this.send(sha256);
    for (const sha256 of said.again) await this.askAgain(sha256);
    /* The copies it counted are to be shown at once, in one more word, so they count in this same look. */
    if (!last && said.prove.length) {
      const more = await this.proofsOf(said.prove);
      if (more.length) await this.report([], [], undefined, more, true);
    }
    return said.unknown;
  }

  /* Shows it keeps the copies asked of: the HMAC, under each nonce, of the slices of its own copy. A copy not here any
     more shows nothing that matches, and stops counting. */
  private async proofsOf(challenges: Challenge[]): Promise<Proof[]> {
    const proofs: Proof[] = [];
    for (const { sha256, nonce, slices } of challenges) proofs.push({ sha256, nonce, mac: macOf(nonce, await this.store.slicesOf(sha256, slices)) });
    return proofs;
  }

  /* Names every file here, a span of names at a time in their order, so the leading app forgets what this machine lost
     and asks for it again; a file no record knows, and older than a day, goes. */
  async census(): Promise<void> {
    const here = (await this.store.list()).sort((x, y) => (x.sha256 < y.sha256 ? -1 : 1));
    const cutoff = this.now() - UNNAMED_MS;
    let after = '';
    for (let at = 0; at === 0 || at < here.length; at += CENSUS_BATCH) {
      const batch = here.slice(at, at + CENSUS_BATCH);
      const through = at + CENSUS_BATCH >= here.length ? 'g' : batch.at(-1)!.sha256;
      const unknown = new Set(await this.report(batch.map(file => file.sha256), [], { after, through }));
      for (const file of batch) if (unknown.has(file.sha256) && file.at.getTime() < cutoff) await this.drop(file.sha256);
      after = through;
    }
    await this.countUsed();
    this.censusAt = this.now();
  }

  private async fetch(file: HeldView['hold'][number], area: number | undefined, store = this.store): Promise<boolean> {
    if (!this.roomFor(file.sealedSize, area)) {
      this.say('room', "Has no room for a file of the company it is picked to keep: its area or its disk is full.");
      return false;
    }
    let body: Readable | null = null;
    try {
      const answer = await this.opts.link.stream('GET', `${store === this.backup ? BACKUP_FILE_PATH : FILE_PATH}${file.sha256}`);
      body = answer.body;
      if (answer.status !== 200) return false;
      const fresh = !store.has(file.sha256);
      await store.take(file.sha256, body, { sealedSha256: file.sealedSha256, sealedSize: file.sealedSize });
      const has = store.has(file.sha256);
      if (has && fresh && this.used !== null) this.used += file.sealedSize;
      return has;
    } catch (err) {
      this.say('fetch', `Could not fetch a file of the company: ${reasonOf(err)}`);
      return false;
    } finally {
      body?.destroy();
    }
  }

  /* A file this machine keeps already and was not given, as one it kept from before it was picked for it: it asks the
     leading keeper for it, so its word that it keeps it counts on its next look. */
  private async askAgain(sha256: string): Promise<void> {
    let body: Readable | null = null;
    try {
      const answer = await this.opts.link.stream('GET', `${FILE_PATH}${sha256}`);
      body = answer.body;
      if (answer.status !== 200) return;
      /* Read whole, as the leading keeper records a file as given only once all of it went out. A copy here that is not
         the same bytes goes, and the next look fetches the one the record names. */
      const hash = createHash('sha256');
      for await (const chunk of body) hash.update(chunk as Buffer);
      if ((await this.store.sealedFacts(sha256)).sealedSha256 !== hash.digest('hex')) await this.drop(sha256);
    } catch (err) {
      this.say('fetch', `Could not fetch a file of the company: ${reasonOf(err)}`);
    } finally {
      body?.destroy();
    }
  }

  /* The leader lacks a file this machine holds, and asks for it; or one only the backup folder here keeps, as the backup
     moves off this machine. */
  private async send(sha256: string, store = this.store): Promise<void> {
    const sealed = store.sealed(sha256);
    if (!sealed) return;
    const body = sealed.stream();
    try {
      const answer = await this.opts.link.stream('PUT', `${store === this.backup ? BACKUP_FILE_PATH : FILE_PATH}${sha256}`, body, sealed.length);
      answer.body.destroy();
    } catch (err) {
      this.say('send', `Could not send a file to the company's server: ${reasonOf(err)}`);
    } finally {
      body.destroy();
    }
  }
}
