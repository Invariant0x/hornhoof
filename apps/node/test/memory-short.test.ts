import { describe, expect, it } from 'vitest';
import { machineLoad } from '../src/load.js';
import { MemoryShort } from '../src/memory-short.js';

const GIB = 1024 ** 3;

/* What a machine said on 18 November 2026: 7 GB of its 15 available, 2.7 GB in swap kept in memory (zram), and so
   all its programs stalled on memory now and then for a moment, while its kernel had killed none since the readings
   before. */
const MEMINFO = 'MemTotal:       16077516 kB\nMemFree:         3145728 kB\nMemAvailable:    7340032 kB\n';
const PRESSURE = 'some avg10=0.14 avg60=0.16 avg300=0.06 total=7336216051\nfull avg10=0.14 avg60=0.16 avg300=0.06 total=6437348121\n';
const vmstat = (kills: number) => `pgrotated 27442135\ndrop_pagecache 0\ndrop_slab 0\noom_kill ${kills}\nnuma_pte_updates 0\nnuma_huge_pte_updates 1\n`;
const recorded = (kills: number) => (path: string) =>
  ({ '/proc/meminfo': MEMINFO, '/proc/pressure/memory': PRESSURE, '/proc/vmstat': vmstat(kills) } as Record<string, string>)[path] ?? null;

/* What one report of the node finds: the kills its machine counts, read the way the node reads them. */
const kills = (read: (path: string) => string | null) => machineLoad({ read, cpus: 16, load: 2.84, disk: () => null, env: {} }).oomKills;

describe('a machine short of memory, as its node reports it', () => {
  it('is not short while its kernel killed nothing, however its programs stall on memory', () => {
    const memory = new MemoryShort();
    for (let i = 0; i < 3; i++) expect(memory.report(kills(recorded(26)))).toBe(false);
    expect(memory.now).toBe(false);
  });

  it('is short for the report after its kernel killed a process for want of memory, and no longer once a report finds no new kill', () => {
    const memory = new MemoryShort();
    expect(memory.report(kills(recorded(26)))).toBe(false);
    expect(memory.report(kills(recorded(27)))).toBe(true);
    expect(memory.now).toBe(true);
    expect(memory.report(kills(recorded(27)))).toBe(false);
    expect(memory.now).toBe(false);
  });

  it('is never short where there is no /proc, as on a Mac', () => {
    const memory = new MemoryShort();
    const none = () => machineLoad({ read: () => null, cpus: 10, load: 1, free: 6 * GIB, total: 32 * GIB, disk: () => null, env: {} }).oomKills;
    for (let i = 0; i < 3; i++) expect(memory.report(none())).toBe(false);
  });

  it('takes no kill from the first report of a node, nor from a count that starts again or wraps around, only from what grows after it', () => {
    const memory = new MemoryShort();
    expect(memory.report(kills(recorded(26)))).toBe(false);
    /* The machine started again, and its count with it. */
    expect(memory.report(kills(recorded(0)))).toBe(false);
    expect(memory.report(kills(recorded(1)))).toBe(true);
    expect(memory.report(kills(recorded(2 ** 64 - 1)))).toBe(true);
    expect(memory.report(kills(recorded(0)))).toBe(false);
    /* A reading that finds no count says nothing, and the one after it has nothing to compare with. */
    expect(memory.report(undefined)).toBe(false);
    expect(memory.report(kills(recorded(5)))).toBe(false);
  });
});
