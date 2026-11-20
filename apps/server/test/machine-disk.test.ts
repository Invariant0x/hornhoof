import type { DiskReport } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { workingFolders } from '../src/modules/nodes/machine-disk.js';
import { together } from '../src/modules/testruns/load.js';

const GB = 1e9;
/* Two made-up nodes on one machine, each measuring its own folder; the disk and Docker's parts are the machine's, the same in
   both reports. */
const SHARED = { total: 500 * GB, free: 120 * GB, threshold: 50 * GB, docker: { total: 200 * GB, free: 85 * GB, threshold: 20 * GB } };
const DOCKER = { images: 60 * GB, containers: 3 * GB, volumes: 40 * GB, buildCache: 20 * GB };
const OLDER: DiskReport = {
  ...SHARED,
  parts: { ...DOCKER, workingCopies: 9 * GB, recordings: GB, checkTemp: 2 * GB },
  low: null,
  cleaned: [{ part: 'checkTemp', bytes: 3 * GB, at: '2026-11-20T09:00:00.000Z' }],
  kept: [{ part: 'workingCopies', agent: 'a', path: 'small', task: 1, bytes: GB, why: 'unpushed' }],
};
const NEWER: DiskReport = {
  ...SHARED,
  free: 110 * GB,
  parts: { ...DOCKER, workingCopies: 14 * GB, checkTemp: GB },
  low: null,
  cleaned: [{ part: 'workingCopies', bytes: 5 * GB, at: '2026-11-20T09:30:00.000Z' }],
  kept: [{ part: 'workingCopies', agent: 'b', path: 'big', task: 2, bytes: 6 * GB, why: 'uncommitted' }],
};
const load = (at: number, disk?: DiskReport) => ({ cpus: 8, load: 1, memFree: 8 * GB, memTotal: 16 * GB, tests: 1, jobs: 2, at, ...(disk ? { disk } : {}) });

describe("a machine's disk from what its nodes say", () => {
  it("takes the machine's own figures from the newest report and adds up what each node measures in its own folder", () => {
    expect(together([load(1, OLDER), load(2, NEWER)])?.disk).toEqual({
      ...SHARED,
      free: 110 * GB,
      parts: { ...DOCKER, workingCopies: 23 * GB, recordings: GB, checkTemp: 3 * GB },
      low: null,
      cleaned: [NEWER.cleaned[0], OLDER.cleaned[0]],
      kept: [NEWER.kept![0], OLDER.kept![0]],
    });
  });

  it('is short of space while any of its nodes says so, since the first of them did', () => {
    const one = { ...OLDER, low: { since: '2026-11-20T08:00:00.000Z' } };
    const other = { ...NEWER, low: { since: '2026-11-20T09:00:00.000Z' } };
    expect(together([load(1, one), load(2, other)])?.disk?.low).toEqual({ since: '2026-11-20T08:00:00.000Z' });
    expect(together([load(1, one), load(2, NEWER)])?.disk?.low).toEqual({ since: '2026-11-20T08:00:00.000Z' });
  });

  it("takes the removals of Docker's parts, which every node repeats, from the newest report, and every node's own, and leaves out what no node measured or kept", () => {
    const docker = { part: 'images' as const, bytes: 7 * GB, at: '2026-11-20T09:10:00.000Z' };
    /* Two nodes that each removed the same amount of their own check files at the same moment: two removals. */
    const own = { part: 'checkTemp' as const, bytes: 2 * GB, at: '2026-11-20T09:20:00.000Z' };
    const a: DiskReport = { ...SHARED, parts: { images: 60 * GB }, low: null, cleaned: [own, { ...docker, bytes: 6 * GB }] };
    const b: DiskReport = { ...SHARED, parts: { images: 60 * GB }, low: null, cleaned: [own, docker] };
    expect(together([load(1, a), load(2, b)])?.disk).toEqual({ ...SHARED, parts: { images: 60 * GB }, low: null, cleaned: [own, own, docker] });
  });

  it('is what the one node says, of a machine with one, and none from nodes too old to say it', () => {
    expect(together([load(1, NEWER)])?.disk).toEqual(NEWER);
    expect(together([load(1), load(2, OLDER)])?.disk).toEqual(OLDER);
    expect(together([load(1), load(2)])?.disk).toBeUndefined();
  });

  it("names each node's working folders by its plan, the biggest first, and none of a node that did not measure them", () => {
    expect(workingFolders([
      { plan: 's-claude', disk: OLDER },
      { plan: null, disk: { ...SHARED, parts: { workingCopies: 0 }, low: null, cleaned: [] } },
      { plan: 's-codex', disk: NEWER },
      { plan: 's-kimi', disk: { ...SHARED, parts: { images: GB }, low: null, cleaned: [] } },
      { plan: 's-old', disk: undefined },
    ])).toEqual([{ plan: 's-codex', bytes: 14 * GB }, { plan: 's-claude', bytes: 9 * GB }, { plan: null, bytes: 0 }]);
  });
});
