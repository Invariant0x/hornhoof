import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskStates } from '@hornhoof/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckClient } from '../src/check-client.js';
import { setCheckClient } from '../src/check-queue.js';
import { diskReason, startDiskCare } from '../src/disk/care.js';

const GB = 1_000_000_000;
const folders: string[] = [];
const cares: { stop(): void }[] = [];
afterEach(() => {
  for (const care of cares.splice(0)) care.stop();
  setCheckClient(null);
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
});

function care(dir: string, free: () => number, extra: { total?: number; env?: Record<string, string>; readTasks?: () => Promise<TaskStates | null> } = {}) {
  const total = extra.total ?? 100 * GB;
  const started = startDiskCare({
    dir,
    owner: { user: null, home: null },
    env: extra.env ?? { HORNHOOF_DISK_SHARE: '0', HORNHOOF_DISK_GB: '20' },
    checking: () => false,
    log: () => {},
    disk: () => ({ total, free: free() }),
    firstMs: 60_000,
    ...(extra.readTasks ? { readTasks: extra.readTasks } : {}),
  } as Parameters<typeof startDiskCare>[0]);
  cares.push(started);
  return started;
}

const node = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hh-disk-care-')));
  folders.push(dir);
  return dir;
};

describe("a node's disk care", () => {
  it('holds new checks and builds back while the disk is short after cleaning, says why, and gives them back once there is room', async () => {
    const checks = new CheckClient(() => true);
    setCheckClient(checks);
    let free = 5 * GB;
    const disk = care(node(), () => free);
    await disk.pass();
    expect(checks.refused()).toMatch(/short of disk space: 5 GB free, and it needs 20 GB for checks and builds/);
    await expect(checks.acquire()).rejects.toThrow(/short of disk space/);
    free = 50 * GB;
    await disk.pass();
    expect(checks.refused()).toBeNull();
  });

  it('uses one decimal GB unit throughout, accepts 21 GB and 20.4 GB free against a 20 GB threshold, names the 22 GB resume mark in hysteresis, and clears a stale hold on acquire once room is back', async () => {
    const checks = new CheckClient(frame => {
      if (frame.type === 'check.acquire') queueMicrotask(() => checks.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 }));
      return true;
    });
    checks.online(true);
    setCheckClient(checks);

    /* Synthetic 126 GB data disk: 21 GB and 20.4 GB decimal are above 20 GB decimal though below 20 GiB (21.47 GB). */
    let free = 21 * GB;
    const disk = care(node(), () => free, { total: 126 * GB, env: { HORNHOOF_DISK_SHARE: '10', HORNHOOF_DISK_GB: '20' } });
    await disk.pass();
    expect(disk.report()?.low).toBeNull();
    expect(diskReason(disk.report() ?? null)).toBeNull();
    expect(checks.refused()).toBeNull();

    free = 20.4 * GB;
    await disk.pass();
    expect(disk.report()?.low).toBeNull();
    expect(checks.refused()).toBeNull();

    /* Fall below 20 GB, then recover into the 10% hysteresis band (20.4 GB < 22 GB): text names 22 GB, never "20.4 GB free, needs 20 GB". */
    free = 18.5 * GB;
    await disk.pass();
    expect(checks.refused()).toContain('18.5 GB free, and it needs 20 GB');

    free = 20.4 * GB;
    await disk.pass();
    expect(disk.report()?.low).not.toBeNull();
    expect(checks.refused()).toContain('20.4 GB free, and it needs 22 GB');

    /* Disk recovers to 26.9 GB between 10-minute passes: acquiring a check slot rechecks live room and clears the hold immediately. */
    free = 26.9 * GB;
    const lease = await checks.acquire({ label: 'vitest' });
    expect(checks.refused()).toBeNull();
    lease.release();
  });

  it('removes finished task copies before reaching the threshold using fresh open-task numbers and lists the largest copies in the report', async () => {
    const dir = node();
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
    const origin = join(dir, 'origin.git');
    git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
    const agentId = '11111111-1111-4111-8111-111111111111';
    const agentDir = join(dir, 'work', 'agents', agentId);
    mkdirSync(agentDir, { recursive: true });
    const clone = join(agentDir, 'shop');
    git(agentDir, 'clone', '-q', origin, clone);
    writeFileSync(join(clone, '.gitignore'), 'node_modules/\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'init');
    git(clone, 'push', '-q', 'origin', 'HEAD:main');

    const makeWorktree = (folder: string, branch: string, kb: number, push = true) => {
      const path = join(agentDir, folder);
      git(clone, 'worktree', 'add', '-q', '-b', branch, path, 'origin/main');
      writeFileSync(join(path, `${branch}.txt`), 'work\n');
      git(path, 'add', '.');
      git(path, 'commit', '-q', '-m', branch);
      if (push) git(path, 'push', '-q', 'origin', branch);
      mkdirSync(join(path, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(path, 'node_modules', 'pkg', 'bundle.js'), Buffer.alloc(kb * 1024, 1));
      return path;
    };

    const closedPath = makeWorktree('shop-4', 'task-4', 256);
    const openPath = makeWorktree('shop-5', 'task-5', 512);
    const unpushedClosedPath = makeWorktree('shop-6', 'task-6', 128, false);

    /* Roomy disk (80 GB free of 100 GB, threshold 20 GB), no turn has called noteTasks yet, readTasks supplies fresh company tasks. */
    const disk = care(dir, () => 80 * GB, { readTasks: async () => ({ open: [5], upTo: 6 }) });
    await disk.pass();

    expect(existsSync(closedPath)).toBe(false);
    expect(existsSync(openPath)).toBe(true);
    expect(existsSync(unpushedClosedPath)).toBe(true);
    const report = disk.report() as (ReturnType<typeof disk.report> & { copies?: { agent: string; path: string; task: number | null; bytes: number }[] }) | undefined;
    expect(report?.low).toBeNull();
    expect(report?.copies?.[0]).toMatchObject({ agent: agentId, path: 'shop-5', task: 5 });
    expect(report?.copies?.some(c => c.path === 'shop-4')).toBe(false);
  });

  it('gives the last pass as the report of its load, and none before its first pass', async () => {
    const disk = care(node(), () => 50 * GB);
    expect(disk.report()).toBeUndefined();
    await disk.pass();
    expect(disk.report()).toMatchObject({ total: 100 * GB, free: 50 * GB, threshold: 20 * GB, low: null });
    expect(Object.keys(disk.report()!.parts).sort()).toEqual(['checkTemp', 'recordings', 'workingCopies']);
  });

  it('runs one pass at a time', async () => {
    const disk = care(node(), () => 50 * GB);
    expect(disk.pass()).toBe(disk.pass());
  });

  it('keeps the open tasks a turn named across a restart, and a file that is not one counts as none', () => {
    const dir = node();
    care(dir, () => 50 * GB).noteTasks({ open: [3], upTo: 9 });
    expect(care(dir, () => 50 * GB).tasks()).toEqual({ open: [3], upTo: 9 });
    writeFileSync(join(dir, 'disk-tasks.json'), '{"open":"all"}');
    expect(care(dir, () => 50 * GB).tasks()).toBeNull();
  });

  it('lets checks go when it stops', async () => {
    const checks = new CheckClient(() => true);
    setCheckClient(checks);
    const disk = care(node(), () => 1 * GB);
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
        parts: { images: 2 * GB, containers: 100, volumes: 4 * GB, buildCache: GB },
        cleaned: [{ part: 'images', bytes: GB, at }],
      }),
    );
    const disk = care(dir, () => 50 * GB);
    await disk.pass();
    expect(disk.report()?.parts).toMatchObject({ images: 2 * GB, containers: 100, volumes: 4 * GB, buildCache: GB });
    expect(disk.report()?.cleaned).toEqual([{ part: 'images', bytes: GB, at }]);
  });
});
