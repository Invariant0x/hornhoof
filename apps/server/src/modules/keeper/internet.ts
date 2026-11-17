import { readFileSync } from 'node:fs';
import type http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import { z } from 'zod';
import { writePrivately } from './machine-keys.js';
import { RoundTrips } from './round-trips.js';

const INTERNET_EVERY_MS = 600_000;
const PING_TIMEOUT_MS = 5_000;
export const DOWNLOAD_FIRST_MS = 600_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const DOWNLOAD_REDIRECTS = 3;
/* In the keeper's folder: the last good rate with its time, and the time of the last try. */
export const INTERNET_FILE = 'internet.json';
export const DOWNLOAD_EVERY_MS = 86_400_000;
export const DOWNLOAD_BYTES = 4 * 2 ** 20;
const DOWNLOAD_MIN_BYTES = 2 ** 20;
const PING_URL = 'https://github.com/';
/* A file every install already takes from there, so no new host is asked. */
const DOWNLOAD_URL = 'https://github.com/fatedier/frp/releases/download/v0.71.1/frp_0.71.1_linux_amd64.tar.gz';
const FIRST_PING_MS = 60_000;
const CHECK_EVERY_MS = 60_000;
/* The most a report takes for a rate. */
const MBPS_MAX = 600_000;

const Kept = z.object({ mbps: z.number().int().min(0).nullable(), mbpsAt: z.string().nullable(), triedAt: z.string().nullable() });

type InternetMeasuresOptions = {
  /* The keeper's own folder. */
  dir: string;
  pingUrl?: string;
  downloadUrl?: string;
  /* A certificate the tests' server is trusted by; the system's own otherwise. */
  ca?: string;
  /* The time of day, in ms. */
  now?: () => number;
  /* What the timings are taken by. */
  clock?: () => number;
  log?: (line: string) => void;
};

/* How a machine reaches the internet, measured against github.com: the round trip of a request on an open connection,
   every ten minutes, as the day's median; and once a day how fast a file of 4 MiB comes down. An answer of any status
   counts as a round trip; a failure of the connection or of its certificate gives no sample, and nothing is said of it,
   since a machine is often away from the internet. */
export class InternetMeasures {
  private readonly trips = new RoundTrips({ everyMs: 0 });
  private timers: NodeJS.Timeout[] = [];
  /* Every request that has not ended yet: a round trip and a download may run at once, and a stop ends them all. */
  private readonly asked = new Set<http.ClientRequest>();
  private stopped = false;
  private startedAt: number | null = null;
  private mbps: number | null = null;
  private mbpsAt: string | null = null;
  private triedAt: string | null = null;
  private downloading = false;

  constructor(private readonly opts: InternetMeasuresOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private clock(): number {
    return this.opts.clock?.() ?? performance.now();
  }

  private file(): string {
    return join(this.opts.dir, INTERNET_FILE);
  }

  /* Reads what the keeper before it measured; a file of another shape is no file. */
  start(): void {
    try {
      const read = Kept.safeParse(JSON.parse(readFileSync(this.file(), 'utf8')));
      if (read.success) ({ mbps: this.mbps, mbpsAt: this.mbpsAt, triedAt: this.triedAt } = read.data);
    } catch {
      /* None yet. */
    }
    this.stopped = false;
    this.startedAt = this.now();
    const first = setTimeout(() => void this.ping(), FIRST_PING_MS);
    const pings = setInterval(() => void this.ping(), INTERNET_EVERY_MS);
    const downloads = setInterval(() => void (this.downloadIn() === 0 && this.download()), CHECK_EVERY_MS);
    this.timers = [first, pings, downloads];
    for (const timer of this.timers) timer.unref();
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    for (const req of this.asked) req.destroy();
    this.asked.clear();
  }

  /* How long until the next download: a day after the last try, and ten minutes after the keeper started at the
     earliest, so a restart neither forgets the rate nor downloads again. */
  downloadIn(): number {
    const now = this.now();
    const afterStart = (this.startedAt ?? now) + DOWNLOAD_FIRST_MS;
    const afterTry = this.triedAt ? Date.parse(this.triedAt) + DOWNLOAD_EVERY_MS : -Infinity;
    return Math.max(0, Math.max(afterStart, afterTry) - now);
  }

  snapshot(): { internetRttMs: number | null; internetMbps: number | null } {
    return { internetRttMs: this.trips.median(this.now()), internetMbps: this.mbps };
  }

  /* One request, answered by its headers; its body, if any, is read away so the connection can be used again. */
  private request(url: string, method: 'HEAD' | 'GET', agent: https.Agent, headers: Record<string, string> = {}): Promise<{ res: http.IncomingMessage; at: number }> {
    return new Promise((resolve, reject) => {
      const req = https.request(url, { method, agent, headers, ca: this.opts.ca, timeout: PING_TIMEOUT_MS });
      this.asked.add(req);
      req.once('close', () => this.asked.delete(req));
      req.once('timeout', () => req.destroy(new Error('no answer in time')));
      req.once('error', reject);
      req.once('response', res => resolve({ res, at: this.clock() }));
      req.end();
    });
  }

  /* Two requests in a row on one connection, the second timed: it holds no handshake, unless the server closed the
     connection in between, and then the sample holds a new one and stands. */
  async ping(): Promise<void> {
    /* Not while a download fills the line: its round trip would say more of the download than of the way. */
    if (this.stopped || this.downloading) return;
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    const url = this.opts.pingUrl ?? PING_URL;
    try {
      const opened = await this.request(url, 'HEAD', agent);
      await new Promise<void>(resolve => opened.res.once('end', resolve).once('close', resolve).resume());
      const from = this.clock();
      const second = await this.request(url, 'HEAD', agent);
      second.res.resume();
      this.trips.add(Math.max(0, Math.round(second.at - from)), this.now());
    } catch {
      /* No sample. */
    } finally {
      agent.destroy();
    }
  }

  /* One download a time. The try is written down whatever came of it, and a good one with its rate. */
  async download(): Promise<void> {
    if (this.stopped || this.downloading) return;
    this.downloading = true;
    const tried = new Date(this.now()).toISOString();
    const agent = new https.Agent({ keepAlive: false });
    const ends = this.clock() + DOWNLOAD_TIMEOUT_MS;
    try {
      const rate = await this.rateOf(this.opts.downloadUrl ?? DOWNLOAD_URL, agent, DOWNLOAD_REDIRECTS, ends).catch(() => null);
      if (this.stopped) return;
      if (rate !== null) [this.mbps, this.mbpsAt] = [rate, tried];
      this.triedAt = tried;
      try {
        writePrivately(this.file(), JSON.stringify({ mbps: this.mbps, mbpsAt: this.mbpsAt, triedAt: this.triedAt }));
      } catch (err) {
        this.opts.log?.(`Could not keep this machine's download rate in its folder: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      this.downloading = false;
      agent.destroy();
    }
  }

  /* The first 4 MiB of the file, following a few redirects: the rate from the answer's headers to the last byte read,
     in Mbit/s. Null for another status, a body that ends under 1 MiB, or one that breaks or takes too long. */
  private async rateOf(url: string, agent: https.Agent, redirects: number, ends: number): Promise<number | null> {
    const { res, at } = await this.request(url, 'GET', agent, { range: `bytes=0-${DOWNLOAD_BYTES - 1}` });
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      return redirects > 0 ? this.rateOf(new URL(res.headers.location, url).toString(), agent, redirects - 1, ends) : null;
    }
    if (status !== 200 && status !== 206) {
      res.destroy();
      return null;
    }
    return new Promise(resolve => {
      let bytes = 0;
      let done = false;
      const finish = (counts: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(late);
        res.destroy();
        const seconds = Math.max(this.clock() - at, 1) / 1000;
        resolve(counts && bytes >= DOWNLOAD_MIN_BYTES ? Math.min(MBPS_MAX, Math.round((bytes * 8) / seconds / 1e6)) : null);
      };
      const late = setTimeout(() => finish(false), Math.max(0, ends - this.clock()));
      late.unref();
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes >= DOWNLOAD_BYTES) finish(true);
      });
      res.once('end', () => finish(true));
      res.once('error', () => finish(false));
      res.once('aborted', () => finish(false));
      res.once('close', () => finish(false));
    });
  }
}
