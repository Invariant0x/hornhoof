import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
