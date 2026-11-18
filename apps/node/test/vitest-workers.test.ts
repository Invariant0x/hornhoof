import { describe, expect, it } from 'vitest';
import { namedWorkers, partShare, vitestWorkers, WORKER_BYTES } from '../src/vitest-workers.js';

const GIB = 2 ** 30;

describe('the Vitest workers of a share of a machine', () => {
  /* A fork of the server suites holds a PGlite database: a machine with little free memory and many cores went to swap with
     one worker per core, and tests ended at their limit instead of failing for a reason. */
  it('takes as many workers as the memory holds besides Vitest itself, so 7 GiB free on 16 cores gives 2 of a part', () => {
    expect(vitestWorkers({ cpus: 16, freeBytes: 7 * GIB, workerBytes: WORKER_BYTES.part })).toBe(2);
    expect(vitestWorkers({ cpus: 16, freeBytes: 8.5 * GIB, workerBytes: WORKER_BYTES.part })).toBe(3);
  });

  it('takes no more workers than the processors of the share', () => {
    expect(vitestWorkers({ cpus: 8, freeBytes: 101 * GIB, workerBytes: WORKER_BYTES.part })).toBe(8);
    expect(vitestWorkers({ cpus: 2.5, freeBytes: 101 * GIB, workerBytes: WORKER_BYTES.check })).toBe(2);
  });

  it('takes one worker however little the share is', () => {
    expect(vitestWorkers({ cpus: 4, freeBytes: GIB, workerBytes: WORKER_BYTES.part })).toBe(1);
    expect(vitestWorkers({ cpus: 0, freeBytes: 0, workerBytes: WORKER_BYTES.check })).toBe(1);
  });

  it('counts a worker of a check, which runs the few files it names, at a gigabyte', () => {
    expect(vitestWorkers({ cpus: 16, freeBytes: 7 * GIB, workerBytes: WORKER_BYTES.check })).toBe(6);
  });
});

describe('the share of a part of a test run', () => {
  it('takes the processors the load leaves free, one left for Vitest itself, and the memory free', () => {
    expect(partShare({ cpus: 16, load: 0, memFree: 64 * GIB })).toEqual({ cpus: 15, freeBytes: 64 * GIB, workerBytes: WORKER_BYTES.part });
    expect(partShare({ cpus: 16, load: 4.5, memFree: 64 * GIB }).cpus).toBe(11.5);
    expect(partShare({ cpus: 1, load: 0, memFree: 64 * GIB }).cpus).toBe(0);
  });
});

describe('a count of workers the machine names', () => {
  it('takes the count named in HH_VITEST_MAX_WORKERS first, then the one in VITEST_MAX_WORKERS', () => {
    expect(namedWorkers({ HH_VITEST_MAX_WORKERS: '3', VITEST_MAX_WORKERS: '5' })).toBe(3);
    expect(namedWorkers({ VITEST_MAX_WORKERS: '5' })).toBe(5);
    expect(namedWorkers({})).toBeNull();
  });

  it.each(['', '0', '-2', '2.5', 'four', ' 3', '50%'])('names none by "%s", which is no whole number above zero', named => {
    expect(namedWorkers({ HH_VITEST_MAX_WORKERS: named })).toBeNull();
    expect(namedWorkers({ VITEST_MAX_WORKERS: named })).toBeNull();
  });
});
