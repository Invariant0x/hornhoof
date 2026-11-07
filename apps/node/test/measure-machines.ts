import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessClaim, HarnessUnit } from '@hornhoof/protocol';
import type { HarnessRemote } from '../src/test-harness.js';

/* What the measurements on real repositories share: machines without root, and Hornhoof's registry with its bundles on this
   same disk, so moving them costs no network here. */
export const ids = { jobUid: 2_000_000_000 + (process.getuid?.() ?? 0) % 1_000_000, builderUid: 2_001_000_000 + (process.getuid?.() ?? 0) % 1_000_000 };

/* While it is on, whatever a command starts finds the network closed. */
export const network = { closed: false };

export function registry(root: string) {
  const builds = new Map<string, { builder: string; unit: string; file?: string; digest?: string; size?: number }>();
  const remote = (name: string): HarnessRemote => ({
    async claim(unit: HarnessUnit): Promise<HarnessClaim> {
      const build = builds.get(unit.key);
      if (build?.file) return { state: 'ready', digest: build.digest!, size: build.size!, partBytes: 32 * 1024 ** 2 };
      if (build && build.builder !== name) return { state: 'wait', afterMs: 100 };
      builds.set(unit.key, { builder: name, unit: unit.unit });
      return { state: 'build', partBytes: 32 * 1024 ** 2 };
    },
    async upload(key, file, digest, size) { const kept = join(root, `${key}.zst`); await copyFile(file, kept); builds.set(key, { ...builds.get(key)!, file: kept, digest, size }); },
    async download(key, file) { await copyFile(builds.get(key)!.file!, file); },
    async failed(key, error) { console.log(`failed ${key}: ${error}`); builds.delete(key); },
  });
  return { builds, remote };
}

export type Timing = { step: string; seconds: number; note?: string };
export const stopwatch = (results: Timing[]) => async <T>(step: string, run: () => Promise<T> | T, note?: (value: T) => string): Promise<T> => {
  const started = performance.now(), value = await run();
  results.push({ step, seconds: Math.round((performance.now() - started) / 10) / 100, ...(note ? { note: note(value) } : {}) });
  console.log(`${step}: ${results.at(-1)!.seconds} s${note ? ` (${note(value)})` : ''}`);
  return value;
};
