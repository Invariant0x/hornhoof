import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckClient } from '../src/check-client.js';
import { setCheckClient } from '../src/check-queue.js';
import { startDiskCare } from '../src/disk/care.js';

const GIB = 1024 ** 3;
const folders: string[] = [];
const cares: { stop(): void }[] = [];
afterEach(() => {
  for (const care of cares.splice(0)) care.stop();
  setCheckClient(null);
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
});

function care(dir: string, free: () => number) {
  const started = startDiskCare({ dir, owner: { user: null, home: null }, env: { HORNHOOF_DISK_SHARE: '0', HORNHOOF_DISK_GB: '20' }, checking: () => false, log: () => {}, disk: () => ({ total: 100 * GIB, free: free() }), firstMs: 60_000 });
  cares.push(started);
  return started;
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
    expect(checks.refused()).toMatch(/short of disk space: 5 GB free, and it needs 20 GB for checks and builds/);
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
});
