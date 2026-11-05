import { randomBytes } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { uptime } from 'node:os';
import { join } from 'node:path';

export const SAMPLE_MS = 20_000;
export const KEEP_SAMPLES = 4320;
const PROBE_FILE = 'fsync-probe';
const PROBE_BYTES = 4096;
const FEWEST_SAMPLES = 10;

export type MachineMeasures = { uptimeS: number; fsyncP99Ms: number | null; diskFree: number };

/* The rank in whole numbers first, so no error of floating point moves it. */
export function fsyncP99(samples: readonly number[]): number | null {
  if (samples.length < FEWEST_SAMPLES) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil((sorted.length * 99) / 100) - 1]!;
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

export class Measures {
  private samples: number[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: { dir: string; sampleMs?: number }) {}

  start(): void {
    this.waitForNext();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async sample(): Promise<void> {
    this.samples = keepLatest(this.samples, await timedSyncedWrite(join(this.opts.dir, PROBE_FILE)));
  }

  /* Throws when the folder is gone: there is no honest number for free space then. */
  snapshot(): MachineMeasures {
    const { bavail, bsize } = statfsSync(this.opts.dir);
    return { uptimeS: Math.floor(uptime()), fsyncP99Ms: fsyncP99(this.samples), diskFree: bavail * bsize };
  }

  /* The wait starts when a sample ends, so a disk that hangs never collects a pile of open writes. */
  private waitForNext(): void {
    this.timer = setTimeout(() => void this.sampleThenWait(), this.opts.sampleMs ?? SAMPLE_MS);
    this.timer.unref();
  }

  /* A sample the disk refuses costs only that sample: a measure changes nothing the company runs, and is tried again. */
  private async sampleThenWait(): Promise<void> {
    await this.sample().catch(() => undefined);
    if (this.timer) this.waitForNext();
  }
}
