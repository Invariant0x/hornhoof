import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskReport } from '@hornhoof/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { checkTemp, folderBytes } from '../src/disk/clean.js';
import { DiskKeeper } from '../src/disk/keeper.js';

const MB = 1024 * 1024;
const folders: string[] = [];
const folder = () => {
  const made = mkdtempSync(join(tmpdir(), 'disk-keeper-'));
  folders.push(made);
  return made;
};
afterEach(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
});

const fill = (path: string, bytes: number) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 1));
};

/* A disk of 10 MB that holds nothing but the node's folder, as a test sees it. */
const diskOf = (dir: string) => async () => ({ total: 10 * MB, free: Math.max(0, 10 * MB - (await folderBytes(dir))) });
const NEEDS_3_MB = { share: 0, amount: 3 * MB };
const at = new Date(Date.UTC(2026, 10, 20, 12, 0));

describe('the size of a folder', () => {
  it('counts what its files take on the disk and never follows a link out of it', async () => {
    const dir = folder(), outside = folder();
    fill(join(dir, 'a', 'one'), MB);
    fill(join(outside, 'big'), 4 * MB);
    symlinkSync(outside, join(dir, 'a', 'away'));
    const bytes = await folderBytes(dir);
    expect(bytes).toBeGreaterThanOrEqual(MB);
    expect(bytes).toBeLessThan(2 * MB);
  });

  it('is 0 for a folder that is not there', async () => {
    expect(await folderBytes(join(folder(), 'none'))).toBe(0);
  });

  it('gives up on a du that does not finish, so a pass goes on with the part unmeasured', async () => {
    const bin = folder(), path = process.env.PATH;
    writeFileSync(join(bin, 'du'), '#!/bin/sh\nexec sleep 5\n');
    chmodSync(join(bin, 'du'), 0o755);
    process.env.PATH = `${bin}:${path ?? ''}`;
    try {
      await expect(folderBytes(folder(), 100)).rejects.toThrow(/did not finish/);
    } finally {
      process.env.PATH = path;
    }
  });
});

describe('a node whose disk check temp files filled', () => {
  it('brings itself back by its own cleaning, and says what it removed', async () => {
    const dir = folder();
    fill(join(dir, 'runs', 'part-1', 'tmp', 'cache'), 4 * MB);
    fill(join(dir, 'runs', 'worktree-2', 'tree', 'dist'), 3 * MB);
    expect((await diskOf(dir)()).free).toBeLessThan(NEEDS_3_MB.amount);
    const keeper = new DiskKeeper({ disk: diskOf(dir), settings: NEEDS_3_MB, cleaners: [checkTemp(dir, () => false)], now: () => at });
    const report = await keeper.pass();
    expect(existsSync(join(dir, 'runs'))).toBe(true);
    expect(await folderBytes(join(dir, 'runs'))).toBeLessThan(MB / 10);
    expect(report?.low).toBeNull();
    expect(keeper.low).toBe(false);
    expect(report?.free).toBeGreaterThan(9 * MB);
    expect(report?.threshold).toBe(3 * MB);
    expect(report?.cleaned).toEqual([{ part: 'checkTemp', bytes: expect.any(Number), at: at.toISOString() }]);
    expect(report!.cleaned[0]!.bytes).toBeGreaterThanOrEqual(7 * MB);
    expect(report?.parts.checkTemp).toBeLessThan(MB / 10);
  });

  it('leaves the files of a check that runs, stays low and so takes no new heavy work, and comes back once the check ended', async () => {
    const dir = folder();
    fill(join(dir, 'runs', 'part-1', 'tmp', 'cache'), 8 * MB);
    let running = true;
    const keeper = new DiskKeeper({ disk: diskOf(dir), settings: NEEDS_3_MB, cleaners: [checkTemp(dir, () => running)], now: () => at });
    const first = await keeper.pass();
    expect(existsSync(join(dir, 'runs', 'part-1', 'tmp', 'cache'))).toBe(true);
    expect(first?.low).toEqual({ since: at.toISOString() });
    expect(first?.cleaned).toEqual([]);
    expect(keeper.low).toBe(true);
    running = false;
    const second = await keeper.pass();
    expect(second?.low).toBeNull();
    expect(keeper.low).toBe(false);
  });

  it('removes a link in its folder of runs, never what the link points to', async () => {
    const dir = folder(), outside = folder();
    fill(join(outside, 'kept'), MB);
    mkdirSync(join(dir, 'runs'), { recursive: true });
    symlinkSync(outside, join(dir, 'runs', 'away'));
    const keeper = new DiskKeeper({ disk: diskOf(dir), settings: NEEDS_3_MB, cleaners: [checkTemp(dir, () => false)], now: () => at });
    await keeper.pass();
    expect(existsSync(join(dir, 'runs', 'away'))).toBe(false);
    expect(existsSync(join(outside, 'kept'))).toBe(true);
  });
});

describe('a node that cannot measure its disk', () => {
  it('names no disk report and is never low', async () => {
    const keeper = new DiskKeeper({ disk: () => null, settings: NEEDS_3_MB, cleaners: [], now: () => at });
    expect(await keeper.pass()).toBeNull();
    expect(keeper.report).toBeNull();
    expect(keeper.low).toBe(false);
  });
});

describe("a part's cleaning that fails", () => {
  it('frees nothing, is logged, and the others still run', async () => {
    const dir = folder(), lines: string[] = [];
    fill(join(dir, 'runs', 'part-1', 'x'), 2 * MB);
    const broken = { part: 'recordings' as const, size: () => Promise.reject(new Error('no access')), clean: () => Promise.reject(new Error('no access')) };
    const keeper = new DiskKeeper({ disk: diskOf(dir), settings: NEEDS_3_MB, cleaners: [broken, checkTemp(dir, () => false)], now: () => at, log: line => lines.push(line) });
    const report = await keeper.pass();
    expect(report?.cleaned.map(c => c.part)).toEqual(['checkTemp']);
    expect(report?.parts.recordings).toBeUndefined();
    expect(lines.some(line => line.includes('recordings') && line.includes('no access'))).toBe(true);
  });

  it('still empties the folder of runs when the leftovers of the test helpers could not be cleaned, and says why', async () => {
    const dir = folder(), lines: string[] = [];
    fill(join(dir, 'runs', 'part-1', 'x'), 2 * MB);
    const leftovers = { size: async () => 0, clean: () => Promise.reject(new Error('no look at the processes')) };
    const keeper = new DiskKeeper({ disk: diskOf(dir), settings: NEEDS_3_MB, cleaners: [checkTemp(dir, () => false, leftovers)], now: () => at, log: line => lines.push(line) });
    await keeper.pass();
    expect(await folderBytes(join(dir, 'runs'))).toBeLessThan(MB / 10);
    expect(lines.some(line => line.includes('checkTemp') && line.includes('no look at the processes'))).toBe(true);
  });
});

describe('what a cleaning leaves because it cannot come back', () => {
  it('is named for a person with its part, biggest first, the 50 biggest', async () => {
    const stays = Array.from({ length: 60 }, (_, i) => ({ agent: 'agent-a', path: `shop-${i + 1}`, task: i + 1, bytes: (i + 1) * MB, why: 'uncommitted' as const }));
    const copies = { part: 'workingCopies' as const, size: async () => 0, clean: async () => 0, kept: () => stays };
    const keeper = new DiskKeeper({ disk: async () => ({ total: 10 * MB, free: 9 * MB }), settings: NEEDS_3_MB, cleaners: [copies], now: () => at });
    const report = await keeper.pass();
    expect(report?.kept).toHaveLength(50);
    expect(report?.kept?.[0]).toEqual({ part: 'workingCopies', agent: 'agent-a', path: 'shop-60', task: 60, bytes: 60 * MB, why: 'uncommitted' });
    expect(report?.kept?.[49]?.path).toBe('shop-11');
  });

  it('fits what the report can carry: a long path keeps its end, and an entry of no agent of Hornhoof\'s goes', async () => {
    const deep = `${'deep/'.repeat(80)}shop`;
    const stays = [
      { agent: 'agent-a', path: deep, task: 1, bytes: 2 * MB, why: 'unpushed' as const },
      { agent: 'x'.repeat(65), path: 'shop', task: 2, bytes: MB, why: 'uncommitted' as const },
    ];
    const copies = { part: 'workingCopies' as const, size: async () => 0, clean: async () => 0, kept: () => stays };
    const keeper = new DiskKeeper({ disk: async () => ({ total: 10 * MB, free: 9 * MB }), settings: NEEDS_3_MB, cleaners: [copies], now: () => at });
    const report = await keeper.pass();
    expect(DiskReport.safeParse(report).success).toBe(true);
    expect(report?.kept).toHaveLength(1);
    expect(report?.kept?.[0]?.path).toHaveLength(300);
    expect(report?.kept?.[0]?.path.endsWith('deep/shop')).toBe(true);
    expect(report?.kept?.[0]?.path.startsWith('…')).toBe(true);
  });

  it('is empty where nothing stays', async () => {
    const keeper = new DiskKeeper({ disk: async () => ({ total: 10 * MB, free: 9 * MB }), settings: NEEDS_3_MB, cleaners: [], now: () => at });
    expect((await keeper.pass())?.kept).toEqual([]);
  });
});

describe('what a quick look keeps and what it reads again', () => {
  const part = (calls: string[]) => ({
    part: 'checkTemp' as const, size: async () => 7, clean: async () => { calls.push('clean'); return 5; }, quick: async () => { calls.push('quick'); return 3; },
  });
  const other = (calls: string[]) => ({ part: 'recordings' as const, size: async () => 9, clean: async () => { calls.push('clean-other'); return 1; } });

  it('runs only what a part can clean in a moment, keeps what the last full pass measured, and reads the disk again', async () => {
    const calls: string[] = [];
    let free = 2 * MB;
    const keeper = new DiskKeeper({ disk: async () => ({ total: 10 * MB, free }), settings: NEEDS_3_MB, cleaners: [part(calls), other(calls)], now: () => at });
    expect((await keeper.pass())?.parts).toEqual({ checkTemp: 7, recordings: 9 });
    expect(keeper.low).toBe(true);
    calls.length = 0;
    free = 6 * MB;
    const report = await keeper.pass(true);
    expect(calls).toEqual(['quick']);
    expect(report?.parts).toEqual({ checkTemp: 7, recordings: 9 });
    expect(report?.free).toBe(6 * MB);
    expect(report?.low).toBeNull();
    expect(report?.cleaned).toContainEqual({ part: 'checkTemp', bytes: 3, at: at.toISOString() });
  });

  it('is a full pass when none came before it, as it has nothing to keep', async () => {
    const calls: string[] = [];
    const keeper = new DiskKeeper({ disk: async () => ({ total: 10 * MB, free: 9 * MB }), settings: NEEDS_3_MB, cleaners: [part(calls), other(calls)], now: () => at });
    const report = await keeper.pass(true);
    expect(calls).toEqual(['clean', 'clean-other']);
    expect(report?.parts).toEqual({ checkTemp: 7, recordings: 9 });
  });
});

describe('the room a light check needs', () => {
  const settings = { share: 0, amount: 8 * MB, light: 3 * MB };
  const keeperAt = (free: () => number | null) => new DiskKeeper({ disk: async () => (free() === null ? null : { total: 10 * MB, free: free()! }), settings, cleaners: [], now: () => at });

  it('is none before the first pass, and none where the disk cannot be read', async () => {
    let free: number | null = 2 * MB;
    const keeper = keeperAt(() => free);
    expect(keeper.light).toBeNull();
    await keeper.pass();
    expect(keeper.light).not.toBeNull();
    free = null;
    await keeper.pass();
    expect(keeper.light).toBeNull();
  });

  it('is short under its own amount, which is less than what heavy work needs, and is back a tenth above it', async () => {
    let free = 5 * MB;
    const keeper = keeperAt(() => free);
    expect((await keeper.pass())?.low).toEqual({ since: at.toISOString() });
    expect(keeper.light).toEqual({ free: 5 * MB, threshold: 3 * MB, low: null });
    free = 2 * MB;
    await keeper.pass();
    expect(keeper.light).toEqual({ free: 2 * MB, threshold: 3 * MB, low: { since: at.toISOString() } });
    free = 3.2 * MB;
    await keeper.pass();
    expect(keeper.light?.low).toEqual({ since: at.toISOString() });
    free = 3.4 * MB;
    await keeper.pass();
    expect(keeper.light?.low).toBeNull();
  });

  it('is never more than what heavy work needs', async () => {
    const keeper = new DiskKeeper({ disk: async () => ({ total: 10 * MB, free: 5 * MB }), settings: { share: 0, amount: 2 * MB, light: 3 * MB }, cleaners: [], now: () => at });
    await keeper.pass();
    expect(keeper.light).toEqual({ free: 5 * MB, threshold: 2 * MB, low: null });
  });
});
