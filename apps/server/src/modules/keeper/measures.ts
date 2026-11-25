import { randomBytes } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { availableParallelism, totalmem, uptime } from 'node:os';
import { join } from 'node:path';

export const SAMPLE_MS = 20_000;
export const KEEP_SAMPLES = 4320;
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

export function keepLatest(samples: readonly number[], ms: number): number[] {
  return [...samples, ms].slice(-KEEP_SAMPLES);
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
  private samples: number[] = [];
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  /* copying: whether the machine makes its copy of the company's data now, or makes it again. filesDir: FILES_DIR, whose
     disk the company's files lie on, which need not be the keeper's. */
  constructor(private readonly opts: { dir: string; sampleMs?: number; internet?: Internet; copying?: () => boolean; filesDir?: string | null }) {}

  start(): void {
    this.timer = setInterval(() => void this.sampleUnlessBusy(), this.opts.sampleMs ?? SAMPLE_MS);
    this.timer.unref();
    this.opts.internet?.start();
  }

  stop(): void {
    clearInterval(this.timer);
    this.opts.internet?.stop();
  }

  /* The machine's connection to the internet, where it is measured: a measure it has none of yet is left out, so the
     server keeps the one it had. */
  network(): { internetRttMs?: number; internetMbps?: number } {
    const said = this.opts.internet?.snapshot();
    return { ...(said?.internetRttMs != null ? { internetRttMs: said.internetRttMs } : {}), ...(said?.internetMbps != null ? { internetMbps: said.internetMbps } : {}) };
  }

  /* While the copy is poured in, the disk is busy with that, and a write timed then measures the copy, not the disk:
     none is taken until it is made. */
  async sample(): Promise<void> {
    if (this.opts.copying?.()) return;
    this.samples = keepLatest(this.samples, await timedSyncedWrite(join(this.opts.dir, PROBE_FILE)));
  }

  /* The fsync p99 of the disk as measured so far, none before there are enough samples. */
  fsyncP99(): number | null {
    return fsyncP99(this.samples);
  }

  /* Throws when the folder is gone: there is no honest number for free space then. */
  snapshot(): MachineMeasures {
    const { bavail, bsize } = statfsSync(this.opts.dir);
    return { uptimeS: Math.floor(uptime()), fsyncP99Ms: fsyncP99(this.samples), diskFree: bavail * bsize, memory: totalmem(), cores: availableParallelism(), ...this.filesDisk() };
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
