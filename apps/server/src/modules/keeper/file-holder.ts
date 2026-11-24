import type { Readable } from 'node:stream';
import { z } from 'zod';
import { FileStore } from '../files/store.js';
import { Hourly, reasonOf } from './machine-keys.js';

/* The paths a keeper that holds the company's files asks on: its view and report from the leading app, and the sealed
   files themselves from the leading keeper. */
export const FILES_VIEW_PATH = '/api/network/files';
export const FILE_PATH = '/peer/files/';
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
});
export type HeldView = z.infer<typeof View>;
const Answer = z.object({ unknown: z.array(SHA).default([]), send: z.array(SHA).default([]), again: z.array(SHA).default([]) });

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
};

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

  constructor(private readonly opts: FileHolderOptions) {
    this.store = new FileStore(opts.dir);
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
    const held: string[] = [];
    const dropped: string[] = [];
    for (const file of view.hold) {
      if (this.stopped) break;
      if (this.store.has(file.sha256) || (await this.fetch(file))) held.push(file.sha256);
    }
    for (const sha256 of view.drop) {
      await this.store.remove(sha256);
      dropped.push(sha256);
    }
    for (const sha256 of view.want) await this.send(sha256);
    if (held.length || dropped.length) await this.report(held, dropped);
    /* A file to send back that is not here any more is one this machine lost. */
    const lost = view.want.filter(sha256 => !this.store.has(sha256));
    if (lost.length) await this.report([], lost);
    if (this.now() - this.censusAt >= CENSUS_MS) await this.census();
  }

  /* Says what this machine keeps and let go of; the answer names what of it no record knows, and what of it the leader
     lacks and asks for, which goes at once. */
  private async report(held: string[], dropped: string[], span?: { after: string; through: string }): Promise<string[]> {
    const answer = await this.opts.link.request('POST', FILES_VIEW_PATH, { held, dropped, ...(span ? { span } : {}) });
    if (answer.status >= 300) throw new Error(`the company server answered ${answer.status}`);
    const said = Answer.safeParse(answer.body ?? {}).data ?? { unknown: [], send: [], again: [] };
    for (const sha256 of said.send) await this.send(sha256);
    for (const sha256 of said.again) await this.askAgain(sha256);
    return said.unknown;
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
      for (const file of batch) if (unknown.has(file.sha256) && file.at.getTime() < cutoff) await this.store.remove(file.sha256);
      after = through;
    }
    this.censusAt = this.now();
  }

  private async fetch(file: HeldView['hold'][number]): Promise<boolean> {
    let body: Readable | null = null;
    try {
      const answer = await this.opts.link.stream('GET', `${FILE_PATH}${file.sha256}`);
      body = answer.body;
      if (answer.status !== 200) return false;
      await this.store.take(file.sha256, body, { sealedSha256: file.sealedSha256, sealedSize: file.sealedSize });
      return this.store.has(file.sha256);
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
    try {
      (await this.opts.link.stream('GET', `${FILE_PATH}${sha256}`)).body.destroy();
    } catch (err) {
      this.say('fetch', `Could not fetch a file of the company: ${reasonOf(err)}`);
    }
  }

  /* The leader lacks a file this machine holds, and asks for it. */
  private async send(sha256: string): Promise<void> {
    const sealed = this.store.sealed(sha256);
    if (!sealed) return;
    const body = sealed.stream();
    try {
      const answer = await this.opts.link.stream('PUT', `${FILE_PATH}${sha256}`, body, sealed.length);
      answer.body.destroy();
    } catch (err) {
      this.say('send', `Could not send a file to the company's server: ${reasonOf(err)}`);
    } finally {
      body.destroy();
    }
  }
}
