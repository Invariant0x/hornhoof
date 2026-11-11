import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir, totalmem, uptime } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEEP_SAMPLES, Measures, SAMPLE_MS, fsyncP99, keepLatest } from '../src/modules/keeper/measures.js';

const PROBE_FILE = 'fsync-probe';
// Real timers under a busy machine: what must come is given time, and a correct run ends as soon as it comes.
const SOON = { timeout: 10_000 };
const folders: string[] = [];
const running: Measures[] = [];

function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'hh-measures-'));
  folders.push(folder);
  return folder;
}

function measuresOn(dir: string, sampleMs?: number): Measures {
  const measures = new Measures({ dir, sampleMs });
  running.push(measures);
  return measures;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  for (const measures of running.splice(0)) measures.stop();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('fsyncP99', () => {
  const oneTo = (count: number): number[] => Array.from({ length: count }, (_, i) => i + 1);

  it('takes the 99th percentile of what it kept', () => {
    expect(fsyncP99(oneTo(100).reverse())).toBe(99);
  });

  it('has none with fewer than 10 samples', () => {
    expect(fsyncP99(oneTo(9))).toBeNull();
    expect(fsyncP99(oneTo(10))).toBe(10);
  });

  it('takes the nearest rank, not a value between two samples', () => {
    expect(fsyncP99(oneTo(101))).toBe(100);
    expect(fsyncP99(oneTo(KEEP_SAMPLES))).toBe(Math.ceil(KEEP_SAMPLES * 0.99));
  });
});

describe('keepLatest', () => {
  it('keeps 24 hours of samples, dropping the oldest', () => {
    const full = Array.from({ length: KEEP_SAMPLES }, (_, i) => i);
    const kept = keepLatest(full, -1);
    expect(kept.length).toBe(KEEP_SAMPLES);
    expect(kept[0]).toBe(1);
    expect(kept[KEEP_SAMPLES - 1]).toBe(-1);
    expect(KEEP_SAMPLES * SAMPLE_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('Measures', () => {
  it('reports the machine after 10 real samples, not before', async () => {
    const measures = measuresOn(tempFolder());
    for (let taken = 0; taken < 9; taken++) await measures.sample();
    expect(measures.snapshot().fsyncP99Ms).toBeNull();
    await measures.sample();
    const { uptimeS, fsyncP99Ms, diskFree, memory, cores } = measures.snapshot();
    expect(memory).toBe(totalmem());
    expect(cores).toBe(availableParallelism());
    expect(fsyncP99Ms).toBeGreaterThanOrEqual(0);
    expect(diskFree).toBeGreaterThan(0);
    expect(Number.isInteger(diskFree)).toBe(true);
    expect(Number.isInteger(uptimeS)).toBe(true);
    expect(Math.abs(uptimeS - Math.floor(uptime()))).toBeLessThanOrEqual(2);
  });

  it('writes 4096 new random bytes for each sample', async () => {
    const dir = tempFolder();
    const measures = measuresOn(dir);
    await measures.sample();
    const first = readFileSync(join(dir, PROBE_FILE));
    await measures.sample();
    const second = readFileSync(join(dir, PROBE_FILE));
    expect(first.length).toBe(4096);
    expect(second.length).toBe(4096);
    expect(first.equals(second)).toBe(false);
  });

  it('keeps no sample of a write that failed', async () => {
    const dir = join(tempFolder(), 'volume');
    mkdirSync(dir);
    const measures = measuresOn(dir);
    for (let taken = 0; taken < 9; taken++) await measures.sample();
    rmSync(dir, { recursive: true });
    await expect(measures.sample()).rejects.toThrow(/ENOENT/);
    mkdirSync(dir);
    expect(measures.snapshot().fsyncP99Ms).toBeNull();
  });

  it('samples by itself until it stops', async () => {
    const dir = tempFolder();
    const measures = measuresOn(dir, 1);
    const sample = vi.spyOn(measures, 'sample');
    measures.start();
    await vi.waitFor(() => expect(sample.mock.calls.length).toBeGreaterThanOrEqual(2), SOON);
    measures.stop();
    const taken = sample.mock.calls.length;
    await pause(30);
    expect(sample.mock.calls.length).toBe(taken);
  });

  it('waits for a slow sample, and takes no further one when stopped during it', async () => {
    const measures = measuresOn(tempFolder(), 1);
    let finish: () => void = () => undefined;
    const sample = vi.spyOn(measures, 'sample').mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    measures.start();
    await vi.waitFor(() => expect(sample).toHaveBeenCalledTimes(1), SOON);
    await pause(20);
    expect(sample).toHaveBeenCalledTimes(1);
    measures.stop();
    finish();
    await pause(20);
    expect(sample).toHaveBeenCalledTimes(1);
  });

  it('goes on after a sample it could not take', async () => {
    const dir = join(tempFolder(), 'not-made-yet');
    const measures = measuresOn(dir, 1);
    const sample = vi.spyOn(measures, 'sample');
    measures.start();
    await vi.waitFor(() => expect(sample.mock.calls.length).toBeGreaterThanOrEqual(2), SOON);
    mkdirSync(dir);
    await vi.waitFor(() => expect(existsSync(join(dir, PROBE_FILE))).toBe(true), SOON);
  });
});
