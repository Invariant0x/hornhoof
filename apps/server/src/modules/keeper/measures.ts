import { randomBytes } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { availableParallelism, totalmem, uptime } from 'node:os';
import { join } from 'node:path';
import type { Sql } from './lease-store.js';

export const SAMPLE_MS = 20_000;
const HOUR_MS = 3_600_000;
const REPORT_HOURS = 24;
export const KEEP_SAMPLES = REPORT_HOURS * HOUR_MS / SAMPLE_MS;
const PROBE_FILE = 'fsync-probe';
const PROBE_BYTES = 4096;
const FEWEST_SAMPLES = 10;

/* memory and cores: what the keeper's container sees, which on a Mac is what Docker's VM was given. */
export type MachineMeasures = { uptimeS: number; fsyncP99Ms: number | null; diskFree: number; memory: number; cores: number; filesDiskFree?: number; filesDiskTotal?: number };

/* The rank in whole numbers first, so no error of floating point moves it. With fewer than a hundred samples the
   ninety-ninth of a hundred would be the slowest one of all, and one slow write while a machine is still being set up
   would call its disk slow for its first half hour: until then the single slowest is left out, as it is from a hundred
   on. */
export function fsyncP99(samples: readonly number[]): number | null {
  if (samples.length < FEWEST_SAMPLES) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((sorted.length * 99) / 100);
  return sorted[Math.min(rank, sorted.length - 1) - 1]!;
}

type TimedSample = { at: number; ms: number };

/* The middle p99 of the last day's hours with enough samples, taking the higher of the middle two. Hours follow the clock, so a busy
   disk or a probe that could not be taken does not move older measurements into newer hours. */
function reportedP99(samples: readonly TimedSample[], now: number): number | null {
  const hours = Array.from({ length: REPORT_HOURS }, (): number[] => []);
  for (const sample of samples) hours[Math.floor((now - sample.at) / HOUR_MS)]?.push(sample.ms);
  const p99s = hours.map(fsyncP99).filter(p99 => p99 !== null).sort((a, b) => a - b);
  return p99s[Math.floor(p99s.length / 2)] ?? null;
}

export function keepLatest(samples: readonly number[], ms: number): number[] {
  return [...samples, ms].slice(-KEEP_SAMPLES);
}

/* What a sample times: one write the disk must make durable before it answers. */
export type Probe = { time(): Promise<number>; close?(): Promise<void> };

/* A transaction of its own that writes no row and locks no table, only takes a transaction id: its commit is flushed to
   the disk of the database's WAL before the database answers, so it times the disk Postgres keeps the company's data
   on, whatever volume that is. It reaches no journal, so nothing of it goes to another machine, and a publication
   sends no transaction that changed nothing. */
export const COMMIT_PROBE = 'SELECT pg_current_xact_id()';

/* What the session of the commit probe gives one commit. A commit that took all of it is a sample of that long, as the
   disk took at least that; one refused sooner says nothing of the disk and is no sample. */
export const PROBE_TIMEOUT_MS = 120_000;

/* The commit probe on a session of its own: the keeper's kind, which commits once this machine wrote it, as the lease
   does, and never the one the lease is renewed on, so a slow probe holds up no renewal. */
export function commitProbe(sql: Sql & { close?(): Promise<void> }, timeoutMs = PROBE_TIMEOUT_MS): Probe {
  return {
    async time() {
      const began = performance.now();
      try {
        await sql.query(COMMIT_PROBE);
      } catch (err) {
        if (performance.now() - began < timeoutMs) throw err;
      }
      return performance.now() - began;
    },
    close: async () => sql.close?.(),
  };
}

async function timedSyncedWrite(path: string): Promise<number> {
  const bytes = randomBytes(PROBE_BYTES);
  const file = await open(path, 'w');
  try {
    const began = performance.now();
    await file.writeFile(bytes);
    await file.sync();
    return performance.now() - began;
  } finally {
    await file.close();
  }
}

/* What measures a machine's connection to the internet, started and stopped with the machine's other measures. */
export type Internet = { start(): void; stop(): void; snapshot(): { internetRttMs: number | null; internetMbps: number | null } };

export class Measures {
  /* What the machine reports, and the company ranks its disk by: none taken while the machine is busy with its own writes. */
  private samples: TimedSample[] = [];
  /* What the keeper's statements on the lease may take: every sample, as they wait for the same disk then too. */
  private leaseSamples: number[] = [];
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  /* busy: whether the machine keeps its disk busy by itself now: it makes its copy of the company's data or makes it
     again, saves what a database that led held, or dumps and seals a backup. probe: what a sample times, a synced write
     to dir unless given. filesDir: FILES_DIR, whose disk the company's files lie on, which need not be the keeper's. */
  constructor(private readonly opts: { dir: string; sampleMs?: number; internet?: Internet; busy?: () => boolean; probe?: Probe; filesDir?: string | null }) {}

  start(): void {
    this.timer = setInterval(() => void this.sampleUnlessBusy(), this.opts.sampleMs ?? SAMPLE_MS);
    this.timer.unref();
    this.opts.internet?.start();
  }

  stop(): void {
    clearInterval(this.timer);
    this.opts.internet?.stop();
    void this.opts.probe?.close?.().catch(() => undefined);
  }

  /* The machine's connection to the internet, where it is measured: a measure it has none of yet is left out, so the
     server keeps the one it had. */
  network(): { internetRttMs?: number; internetMbps?: number } {
    const said = this.opts.internet?.snapshot();
    return { ...(said?.internetRttMs != null ? { internetRttMs: said.internetRttMs } : {}), ...(said?.internetMbps != null ? { internetMbps: said.internetMbps } : {}) };
  }

  /* While the machine keeps its disk busy by itself, a write timed then measures that, not the disk: such a sample, or
     one during which that began, is left out of what the machine reports. The lease counts it, as its statements wait
     for that same disk. */
  async sample(): Promise<void> {
    const before = this.opts.busy?.() ?? false;
    const ms = await (this.opts.probe ? this.opts.probe.time() : timedSyncedWrite(join(this.opts.dir, PROBE_FILE)));
    this.leaseSamples = keepLatest(this.leaseSamples, ms);
    if (!before && !(this.opts.busy?.() ?? false)) {
      this.samples.push({ at: performance.now(), ms });
      if (this.samples.length > KEEP_SAMPLES) this.samples.shift();
    }
  }

  /* The fsync p99 of the disk as the machine reports it, the middle one of its hours; none before there are enough samples. */
  fsyncP99(): number | null {
    return reportedP99(this.samples, performance.now());
  }

  /* The fsync p99 the lease's statements go by: of every sample, so a disk slow under the machine's own dumps is slow for
     the lease too. */
  leaseFsyncP99(): number | null {
    return fsyncP99(this.leaseSamples);
  }

  /* Throws when the folder is gone: there is no honest number for free space then. */
  snapshot(): MachineMeasures {
    const { bavail, bsize } = statfsSync(this.opts.dir);
    return { uptimeS: Math.floor(uptime()), fsyncP99Ms: this.fsyncP99(), diskFree: bavail * bsize, memory: totalmem(), cores: availableParallelism(), ...this.filesDisk() };
  }

  /* The room of the disk FILES_DIR lies on; nothing where there is none or it cannot be read, and the server keeps what
     it had. */
  private filesDisk(): { filesDiskFree?: number; filesDiskTotal?: number } {
    if (!this.opts.filesDir) return {};
    try {
      const { bavail, blocks, bsize } = statfsSync(this.opts.filesDir);
      const free = bavail * bsize;
      const total = blocks * bsize;
      return Number.isSafeInteger(free) && Number.isSafeInteger(total) ? { filesDiskFree: free, filesDiskTotal: total } : {};
    } catch {
      return {};
    }
  }

  /* A disk that hangs never collects a pile of open writes. A sample it refuses costs only that sample: a measure changes
     nothing the company runs, and is tried again. */
  private async sampleUnlessBusy(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    await this.sample().catch(() => undefined);
    this.busy = false;
  }
}
