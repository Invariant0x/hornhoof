import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskReport } from '@hornhoof/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { readDockerDisk } from '../src/disk/docker.js';
import { DiskKeeper } from '../src/disk/keeper.js';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const NOW = new Date('2026-11-21T12:00:00.000Z');
const folders: string[] = [];
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hh-disk-docker-'));
  folders.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Docker figures handed to the node by the updater', () => {
  it('merges Docker parts and recent removals into the disk report without touching node parts', async () => {
    const dir = folder();
    const freshAt = '2026-11-21T11:30:00.000Z';
    const staleAt = '2026-11-20T11:00:00.000Z';
    writeFileSync(
      join(dir, 'docker-disk.json'),
      JSON.stringify({
        at: freshAt,
        parts: { images: 4 * GIB, containers: 200 * MIB, volumes: 12 * GIB, buildCache: 3 * GIB, workingCopies: 999 },
        cleaned: [
          { part: 'images', bytes: 2 * GIB, at: freshAt },
          { part: 'buildCache', bytes: 1 * GIB, at: staleAt },
          { part: 'workingCopies', bytes: 500, at: freshAt },
        ],
      }),
    );

    const parsed = readDockerDisk(dir, NOW);
    expect(parsed).toEqual({
      parts: { images: 4 * GIB, containers: 200 * MIB, volumes: 12 * GIB, buildCache: 3 * GIB },
      cleaned: [{ part: 'images', bytes: 2 * GIB, at: freshAt }],
    });

    const keeper = new DiskKeeper({
      disk: () => ({ total: 100 * GIB, free: 50 * GIB }),
      settings: { share: 0.1, amount: 20 * GIB },
      cleaners: [{ part: 'checkTemp', size: async () => 10 * MIB, clean: async () => 5 * MIB }],
      docker: () => readDockerDisk(dir, NOW),
      now: () => NOW,
    });
    const report = await keeper.pass();
    expect(DiskReport.safeParse(report).success).toBe(true);
    expect(report?.parts).toEqual({
      images: 4 * GIB,
      containers: 200 * MIB,
      volumes: 12 * GIB,
      buildCache: 3 * GIB,
      checkTemp: 10 * MIB,
    });
    expect(report?.cleaned).toEqual([
      { part: 'checkTemp', bytes: 5 * MIB, at: NOW.toISOString() },
      { part: 'images', bytes: 2 * GIB, at: freshAt },
    ]);
  });

  it('ignores missing, stale, oversized, malformed or symlinked docker-disk.json files', () => {
    expect(readDockerDisk(folder(), NOW)).toBeNull();

    const stale = folder();
    writeFileSync(join(stale, 'docker-disk.json'), JSON.stringify({ at: '2026-11-20T11:59:59.000Z', parts: { images: 10 }, cleaned: [] }));
    expect(readDockerDisk(stale, NOW)).toBeNull();

    const bad = folder();
    writeFileSync(join(bad, 'docker-disk.json'), '{not json');
    expect(readDockerDisk(bad, NOW)).toBeNull();

    const big = folder();
    writeFileSync(join(big, 'docker-disk.json'), ' '.repeat(70 * 1024));
    expect(readDockerDisk(big, NOW)).toBeNull();

    const linked = folder();
    const outside = folder();
    writeFileSync(join(outside, 'target.json'), JSON.stringify({ at: NOW.toISOString(), parts: { images: 10 }, cleaned: [] }));
    symlinkSync(join(outside, 'target.json'), join(linked, 'docker-disk.json'));
    expect(readDockerDisk(linked, NOW)).toBeNull();

    const sub = folder();
    mkdirSync(join(sub, 'docker-disk.json'));
    expect(readDockerDisk(sub, NOW)).toBeNull();
  });

  it('rejects future timestamps beyond clock-skew tolerance in docker-disk.json and cleaned entries', () => {
    const farFuture = folder();
    writeFileSync(
      join(farFuture, 'docker-disk.json'),
      JSON.stringify({ at: '2099-01-01T00:00:00.000Z', parts: { images: 10 }, cleaned: [] }),
    );
    expect(readDockerDisk(farFuture, NOW)).toBeNull();

    const overSkew = folder();
    writeFileSync(
      join(overSkew, 'docker-disk.json'),
      JSON.stringify({ at: '2026-11-21T12:05:01.000Z', parts: { images: 10 }, cleaned: [] }),
    );
    expect(readDockerDisk(overSkew, NOW)).toBeNull();

    const mixed = folder();
    const validAt = '2026-11-21T11:55:00.000Z';
    const smallSkewAt = '2026-11-21T12:04:00.000Z';
    writeFileSync(
      join(mixed, 'docker-disk.json'),
      JSON.stringify({
        at: smallSkewAt,
        parts: { images: 10 },
        cleaned: [
          { part: 'images', bytes: 999, at: '2099-01-01T00:00:00.000Z' },
          { part: 'volumes', bytes: 888, at: '2026-11-21T12:06:00.000Z' },
          { part: 'buildCache', bytes: 777, at: validAt },
        ],
      }),
    );
    expect(readDockerDisk(mixed, NOW)).toEqual({
      parts: { images: 10 },
      cleaned: [{ part: 'buildCache', bytes: 777, at: validAt }],
    });
  });
});
