import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir, totalmem, uptime } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMIT_PROBE, KEEP_SAMPLES, Measures, SAMPLE_MS, commitProbe, fsyncP99, keepLatest } from '../src/modules/keeper/measures.js';
import { createTestSql } from './helpers.js';

const PROBE_FILE = 'fsync-probe';
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

/* The sampling clock is virtual: a sample starts only when the test moves it by a period, and runs to its end on the real
   disk. A tick moves the clock one period of 1 ms and lets every sample begun so far end, taken or refused. */
async function tick(sample: { mock: { results: { value: unknown }[] } }): Promise<void> {
  await vi.advanceTimersByTimeAsync(1);
  await Promise.allSettled(sample.mock.results.map((result) => result.value));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.useRealTimers();
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
    expect(fsyncP99(oneTo(10))).toBe(9);
  });

  it('leaves the single slowest write out while it has fewer than a hundred', () => {
    /* One slow write while the machine was still being set up says nothing of its disk. */
    const quick = Array.from({ length: 40 }, () => 3);
    expect(fsyncP99([...quick, 900])).toBe(3);
    /* A disk that is slow shows in the rest of its writes. */
    expect(fsyncP99([...quick, 900, 800])).toBe(800);
    expect(fsyncP99(Array.from({ length: 40 }, () => 120))).toBe(120);
    /* From a hundred on the rank is the plain one, which leaves one in a hundred out by itself. */
    expect(fsyncP99(oneTo(99))).toBe(98);
    expect(fsyncP99(oneTo(100))).toBe(99);
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

  it('says the free and whole room of the disk FILES_DIR lies on, and nothing of it with none or where it is gone', () => {
    const files = tempFolder();
    const said = new Measures({ dir: tempFolder(), filesDir: files }).snapshot();
    expect(said.filesDiskFree).toBeGreaterThan(0);
    expect(said.filesDiskTotal).toBeGreaterThanOrEqual(said.filesDiskFree!);
    expect([Number.isSafeInteger(said.filesDiskFree), Number.isSafeInteger(said.filesDiskTotal)]).toEqual([true, true]);
    expect(Object.keys(new Measures({ dir: tempFolder() }).snapshot())).not.toContain('filesDiskFree');
    rmSync(files, { recursive: true, force: true });
    const gone = new Measures({ dir: tempFolder(), filesDir: files }).snapshot();
    expect([gone.filesDiskFree, gone.filesDiskTotal]).toEqual([undefined, undefined]);
  });

  it('reports no sample taken while the machine is busy with its own writes, and the lease still goes by it', async () => {
    /* Pouring a copy in, saving what a database that led held, or a dump of the database keep the disk busy by
       themselves: a write timed then says nothing of the disk the company is ranked by. The lease's statements wait
       for that same disk, though, so what they may take still counts every sample. */
    let busy = true;
    let ms = 500;
    const measures = new Measures({ dir: tempFolder(), busy: () => busy, probe: { time: async () => ms } });
    running.push(measures);
    for (let taken = 0; taken < 10; taken++) await measures.sample();
    expect(measures.snapshot().fsyncP99Ms).toBeNull();
    expect(measures.fsyncP99()).toBeNull();
    expect(measures.leaseFsyncP99()).toBe(500);
    /* Once the machine is done with them, its samples count again. */
    busy = false;
    ms = 3;
    for (let taken = 0; taken < 10; taken++) await measures.sample();
    expect(measures.snapshot().fsyncP99Ms).toBe(3);
    expect(measures.leaseFsyncP99()).toBe(500);
  });

  it('reports no sample during which the machine became busy', async () => {
    let busy = false;
    const measures = new Measures({ dir: tempFolder(), busy: () => busy, probe: { time: async () => { busy = true; return 700; } } });
    running.push(measures);
    for (let taken = 0; taken < 10; taken++) {
      busy = false;
      await measures.sample();
    }
    expect(measures.fsyncP99()).toBeNull();
    expect(measures.leaseFsyncP99()).toBe(700);
  });

  it('times the probe it is given in place of a write to its folder, and closes it when it stops', async () => {
    const dir = tempFolder();
    const close = vi.fn(async () => undefined);
    const measures = new Measures({ dir, probe: { time: async () => 4, close } });
    for (let taken = 0; taken < 10; taken++) await measures.sample();
    expect(existsSync(join(dir, PROBE_FILE))).toBe(false);
    expect(measures.snapshot().fsyncP99Ms).toBe(4);
    measures.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('holds nothing up while a probe hangs: both p99s answer at once, and no second probe piles up', async () => {
    vi.useFakeTimers();
    const time = vi.fn(() => new Promise<number>(() => undefined));
    const measures = new Measures({ dir: tempFolder(), sampleMs: 1, probe: { time } });
    running.push(measures);
    measures.start();
    for (let ticks = 0; ticks < 5; ticks++) await vi.advanceTimersByTimeAsync(1);
    expect(time).toHaveBeenCalledTimes(1);
    expect(measures.fsyncP99()).toBeNull();
    expect(measures.leaseFsyncP99()).toBeNull();
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
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const dir = tempFolder();
    const measures = measuresOn(dir, 1);
    const sample = vi.spyOn(measures, 'sample');
    measures.start();
    expect(sample).not.toHaveBeenCalled();
    await tick(sample);
    await tick(sample);
    expect(sample).toHaveBeenCalledTimes(2);
    measures.stop();
    await vi.advanceTimersByTimeAsync(30);
    expect(sample).toHaveBeenCalledTimes(2);
  });

  it('waits for a slow sample, and takes no further one when stopped during it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const measures = measuresOn(tempFolder(), 1);
    let finish: () => void = () => undefined;
    const sample = vi.spyOn(measures, 'sample').mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    measures.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(sample).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(sample).toHaveBeenCalledTimes(1);
    measures.stop();
    finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(20);
    expect(sample).toHaveBeenCalledTimes(1);
  });

  it('goes on after a sample it could not take', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const dir = join(tempFolder(), 'not-made-yet');
    const measures = measuresOn(dir, 1);
    const sample = vi.spyOn(measures, 'sample');
    measures.start();
    await tick(sample);
    await tick(sample);
    await expect(sample.mock.results[1]!.value).rejects.toThrow(/ENOENT/);
    expect(existsSync(join(dir, PROBE_FILE))).toBe(false);
    mkdirSync(dir);
    await tick(sample);
    expect(sample).toHaveBeenCalledTimes(3);
    expect(existsSync(join(dir, PROBE_FILE))).toBe(true);
  });
});

describe('the commit probe of the machine\'s database', () => {
  it('times a commit of its own that touches no table, no row and no journal, so a copy that runs it sends nothing', async () => {
    const { sql: run } = await createTestSql();
    const statements: string[] = [];
    const probe = commitProbe({ query: async (text, params) => { statements.push(text); return run.query(text, params); } });
    const journal = async () => (await run.query<{ n: string }>('SELECT count(*)::text AS n FROM net.journal')).rows[0]!.n;
    const xid = async () => BigInt((await run.query<{ x: string }>('SELECT pg_current_xact_id()::text AS x')).rows[0]!.x);
    const before = { journal: await journal(), xid: await xid() };
    expect(await probe.time()).toBeGreaterThanOrEqual(0);
    expect(statements).toEqual([COMMIT_PROBE]);
    /* It committed a transaction of its own, which the database flushes to its disk before it answers... */
    expect(await xid()).toBeGreaterThan(before.xid + 1n);
    /* ...and one that writes no row and locks no table: nothing reaches the journal, so nothing goes to another machine. */
    expect(await journal()).toBe(before.journal);
    await run.query('BEGIN');
    await run.query(COMMIT_PROBE);
    const locked = (await run.query<{ name: string }>(`SELECT c.relname::text AS name FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND n.nspname NOT IN ('pg_catalog', 'information_schema')`)).rows;
    await run.query('ROLLBACK');
    expect(locked).toEqual([]);
  });

  it('counts a commit that took the whole time of its session as a sample of that long, and one refused sooner as none', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const slow = commitProbe({ query: async () => { vi.advanceTimersByTime(50); throw new Error('statement timeout'); } }, 50);
    expect(await slow.time()).toBeGreaterThanOrEqual(50);
    const down = commitProbe({ query: async () => { vi.advanceTimersByTime(5); throw new Error('connection refused'); } }, 50);
    await expect(down.time()).rejects.toThrow('connection refused');
  });

  it('closes the session it times on', async () => {
    const close = vi.fn(async () => undefined);
    await commitProbe({ query: async () => ({ rows: [] }), close }).close?.();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
