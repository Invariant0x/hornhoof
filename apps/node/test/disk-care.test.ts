import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckQueueRequest } from '@hornhoof/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckClient } from '../src/check-client.js';
import { setCheckClient, suspendCheckSlots } from '../src/check-queue.js';
import { startDiskCare } from '../src/disk/care.js';
import { OWNER_FILE } from '../src/disk/leftovers.js';

const GIB = 1024 ** 3;
const folders: string[] = [];
const cares: { stop(): void }[] = [];
afterEach(() => {
  for (const care of cares.splice(0)) care.stop();
  setCheckClient(null);
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
});

/* The temporary folder of a care is a folder of its own, never the machine's. */
function care(dir: string, free: () => number, more: Partial<Parameters<typeof startDiskCare>[0]> = {}) {
  const started = startDiskCare({ dir, tmp: join(dir, 'os-tmp'), owner: { user: null, home: null }, env: { HORNHOOF_DISK_SHARE: '0', HORNHOOF_DISK_GB: '20' }, checking: () => false, log: () => {}, disk: () => ({ total: 100 * GIB, free: free() }), firstMs: 60_000, ...more });
  cares.push(started);
  return started;
}

/* A client whose server grants every slot at once, as the checks of an agent's turn get theirs. */
function granting(): CheckClient {
  const checks: CheckClient = new CheckClient((frame: CheckQueueRequest) => {
    if (frame.type === 'check.acquire') queueMicrotask(() => checks.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 }));
    return true;
  });
  checks.online(true);
  setCheckClient(checks);
  return checks;
}

const node = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hh-disk-care-'));
  folders.push(dir);
  return dir;
};

describe("a node's disk care", () => {
  it('holds new checks and builds back while the disk is short after cleaning, says why, and gives them back once there is room', async () => {
    const checks = new CheckClient(() => true);
    setCheckClient(checks);
    let free = 5 * GIB;
    const disk = care(node(), () => free);
    await disk.pass();
    expect(checks.refused()).toMatch(/short of disk space: it has 5 of the 22 GiB free that builds and browser runs wait for/);
    await expect(checks.acquire()).rejects.toThrow(/short of disk space/);
    free = 50 * GIB;
    await disk.pass();
    expect(checks.refused()).toBeNull();
  });

  it('gives the last pass as the report of its load, and none before its first pass', async () => {
    const disk = care(node(), () => 50 * GIB);
    expect(disk.report()).toBeUndefined();
    await disk.pass();
    expect(disk.report()).toMatchObject({ total: 100 * GIB, free: 50 * GIB, threshold: 20 * GIB, low: null });
    expect(Object.keys(disk.report()!.parts).sort()).toEqual(['checkTemp', 'recordings', 'workingCopies']);
  });

  it('runs one pass at a time', async () => {
    const disk = care(node(), () => 50 * GIB);
    expect(disk.pass()).toBe(disk.pass());
  });

  it('keeps the open tasks a turn named across a restart, and a file that is not one counts as none', () => {
    const dir = node();
    care(dir, () => 50 * GIB).noteTasks({ open: [3], upTo: 9 });
    expect(care(dir, () => 50 * GIB).tasks()).toEqual({ open: [3], upTo: 9 });
    writeFileSync(join(dir, 'disk-tasks.json'), '{"open":"all"}');
    expect(care(dir, () => 50 * GIB).tasks()).toBeNull();
  });

  it('lets checks go when it stops', async () => {
    const checks = new CheckClient(() => true);
    setCheckClient(checks);
    const disk = care(node(), () => 1 * GIB);
    await disk.pass();
    expect(checks.refused()).not.toBeNull();
    disk.stop();
    expect(checks.refused()).toBeNull();
  });

  it('includes Docker parts and recent removals from docker-disk.json when the updater has delivered one', async () => {
    const dir = node();
    const at = new Date().toISOString();
    writeFileSync(
      join(dir, 'docker-disk.json'),
      JSON.stringify({
        at,
        parts: { images: 2 * GIB, containers: 100, volumes: 4 * GIB, buildCache: GIB },
        cleaned: [{ part: 'images', bytes: GIB, at }],
      }),
    );
    const disk = care(dir, () => 50 * GIB);
    await disk.pass();
    expect(disk.report()?.parts).toMatchObject({ images: 2 * GIB, containers: 100, volumes: 4 * GIB, buildCache: GIB });
    expect(disk.report()?.cleaned).toEqual([{ part: 'images', bytes: GIB, at }]);
  });

  it('holds the checks of types, style and tests back below a few GiB only, and builds and browser runs below their level', async () => {
    const checks = granting();
    let free = 19 * GIB;
    const disk = care(node(), () => free);
    await disk.pass();
    (await checks.acquire({ light: true })).release();
    await expect(checks.acquire()).rejects.toThrow(/short of disk space/);
    await expect(checks.acquire({ light: false })).rejects.toThrow(/short of disk space/);
    free = 2 * GIB;
    await disk.pass();
    await expect(checks.acquire({ light: true })).rejects.toThrow(/nearly out of disk space/);
    await expect(checks.acquire()).rejects.toThrow(/nearly out of disk space|short of disk space/);
    free = 50 * GIB;
    await disk.pass();
    (await checks.acquire({ light: true })).release();
    (await checks.acquire()).release();
  });

  it('takes a light check at 21.8 GiB free on a disk that waits for 22 for heavy work, and says what heavy work waits for', async () => {
    const checks = granting();
    let free = 19 * GIB;
    const disk = care(node(), () => free);
    await disk.pass();
    free = 21.8 * GIB;
    await disk.pass();
    (await checks.acquire({ light: true })).release();
    await expect(checks.acquire()).rejects.toThrow('it has 21.8 of the 22 GiB free that builds and browser runs wait for');
    free = 22 * GIB;
    await disk.pass();
    expect(checks.refused()).toBeNull();
    (await checks.acquire()).release();
  });

  it('refuses a light check only below its floor, keeps refusing until a tenth above it, and names that level and the space it has', async () => {
    const checks = granting();
    let free = 5 * GIB;
    const disk = care(node(), () => free);
    await disk.pass();
    expect(checks.refused(true)).toBeNull();
    free = 2.9 * GIB;
    await disk.pass();
    expect(checks.refused(true)).toBe('This machine is nearly out of disk space: it has 2.9 of the 3.3 GiB free that types, style and test checks wait for. Nothing new starts until it has room. Turns go on.');
    free = 3.2 * GIB;
    await disk.pass();
    expect(checks.refused(true)).toMatch(/it has 3\.2 of the 3\.3 GiB free/);
    await expect(checks.acquire({ light: true })).rejects.toThrow(/it has 3\.2 of the 3\.3 GiB free/);
    free = 3.4 * GIB;
    await disk.pass();
    expect(checks.refused(true)).toBeNull();
    (await checks.acquire({ light: true })).release();
  });

  it('names its levels in one unit, said once, and never GB', async () => {
    const checks = granting();
    const disk = care(node(), () => 1.5 * GIB);
    await disk.pass();
    for (const words of [checks.refused(true), checks.refused()]) {
      expect(words).not.toBeNull();
      expect(words!.match(/GiB/g)).toHaveLength(1);
      expect(words).not.toMatch(/\bGB\b/);
    }
  });

  it('keeps what a stuck check group refuses for every class, beside what the disk holds', async () => {
    const checks = granting();
    const disk = care(node(), () => 19 * GIB);
    await disk.pass();
    suspendCheckSlots(777, 'Check group 777 has not stopped.');
    await expect(checks.acquire({ light: true })).rejects.toThrow('Check group 777 has not stopped.');
    suspendCheckSlots(777, null);
    (await checks.acquire({ light: true })).release();
    await expect(checks.acquire()).rejects.toThrow(/short of disk space/);
  });

  it('reads the disk again and goes on with a refusal it lifted, once a pass ends or a check meets it', async () => {
    const checks = granting();
    let free = 2 * GIB;
    const disk = care(node(), () => free, { settleMs: 0 });
    checks.beforeRefusing = () => disk.settle();
    await disk.pass();
    free = 50 * GIB;
    (await checks.acquire({ light: true })).release();
    expect(checks.refused(true)).toBeNull();
  });

  /* The temporary folder of the machine, as the tests of this repository leave it after a run that was killed. */
  const OLD = 5 * 60 * 60_000;
  const start = () => readFileSync('/proc/self/stat', 'utf8').split(') ')[1]!.split(' ')[19]!;
  function leftover(tmp: string, name: string, ageMs: number, owner?: string): string {
    const made = join(tmp, name);
    mkdirSync(made, { recursive: true });
    writeFileSync(join(made, 'migrated.tar'), Buffer.alloc(1024 * 1024, 7));
    if (owner !== undefined) writeFileSync(join(made, OWNER_FILE), owner);
    const at = new Date(Date.now() - ageMs);
    utimesSync(made, at, at);
    return made;
  }

  it.runIf(existsSync('/proc/self/stat'))('removes the leftovers of test runs that nothing holds before it refuses a check, keeps what lives, and decides again', async () => {
    const dir = node(), tmp = join(dir, 'os-tmp');
    mkdirSync(tmp);
    const checks = granting();
    let appeared = false, stale = '';
    const free = () => (2 + (appeared && !existsSync(stale) ? 10 : 0)) * GIB;
    let clock = Date.now();
    const disk = care(dir, free, { now: () => clock });
    checks.beforeRefusing = () => disk.settle();
    await disk.pass();
    expect(checks.refused(true)).toMatch(/it has 2 of the 3\.3 GiB/);
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    stale = leftover(tmp, 'hh-test-db-AbCd12', OLD);
    const gone = leftover(tmp, 'hh-installs-ZzZz99', 60_000, `${dead} 1`);
    const live = leftover(tmp, 'hh-test-initdb-LiVe12', OLD, `${process.pid} ${start()}`);
    const young = leftover(tmp, 'hh-test-db-YoUnG1', 60_000);
    const other = leftover(tmp, 'keep-me-AbCd12', OLD);
    const target = join(dir, 'precious');
    mkdirSync(target); writeFileSync(join(target, 'data'), 'keep');
    symlinkSync(target, join(tmp, 'hh-test-db-LnK123'));
    appeared = true;
    clock += 60_000;
    (await checks.acquire({ light: true })).release();
    expect([stale, gone].map(made => existsSync(made))).toEqual([false, false]);
    expect([live, young, other, join(target, 'data')].map(made => existsSync(made))).toEqual([true, true, true, true]);
    expect(checks.refused(true)).toBeNull();
    expect(Object.keys(disk.report()!.parts).sort()).toEqual(['checkTemp', 'recordings', 'workingCopies']);
    expect(disk.report()!.cleaned[0]).toMatchObject({ part: 'checkTemp' });
    expect(disk.report()!.cleaned[0]!.bytes).toBeGreaterThanOrEqual(2 * 1024 * 1024);
  });

  it('refuses with the level and the space it has when cleaning freed nothing', async () => {
    const dir = node();
    mkdirSync(join(dir, 'os-tmp'));
    const checks = granting();
    const disk = care(dir, () => 2 * GIB, { settleMs: 0 });
    checks.beforeRefusing = () => disk.settle();
    await disk.pass();
    await expect(checks.acquire({ light: true })).rejects.toThrow('it has 2 of the 3.3 GiB free that types, style and test checks wait for');
  });

  it('looks again at most once in the time it is given, so many refused checks do not read the disk each time', async () => {
    const dir = node();
    const checks = granting();
    let reads = 0, clock = Date.now();
    const disk = care(dir, () => { reads++; return 2 * GIB; }, { now: () => clock, settleMs: 30_000 });
    checks.beforeRefusing = () => disk.settle();
    await disk.pass();
    expect(reads).toBe(1);
    await expect(checks.acquire({ light: true })).rejects.toThrow(/nearly out/);
    await expect(checks.acquire({ light: true })).rejects.toThrow(/nearly out/);
    expect(reads).toBe(1);
    clock += 31_000;
    await expect(checks.acquire({ light: true })).rejects.toThrow(/nearly out/);
    await expect(checks.acquire({ light: true })).rejects.toThrow(/nearly out/);
    expect(reads).toBe(2);
  });

  it('shares a look that is under way, and a pass that is, among the checks that meet a refusal together', async () => {
    const disk = care(node(), () => 2 * GIB, { settleMs: 0 });
    await disk.pass();
    const look = disk.settle();
    expect(disk.settle()).toBe(look);
    expect(disk.pass()).not.toBe(look);
    await look;
  });
});
