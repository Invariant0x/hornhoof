import { describe, expect, it } from 'vitest';
import { DISK_PARTS, DiskReport, MachineReplicas, NODE_DISK_PARTS, parseNodeMessage, parseServerMessage } from '../src/index.js';

const GB = 1e9;
const LOAD = { cpus: 8, load: 1.5, memFree: 4 * GB, memTotal: 16 * GB, tests: 0, jobs: 2 };
const DISK = {
  total: 500 * GB,
  free: 40 * GB,
  docker: { total: 200 * GB, free: 15 * GB, threshold: 20 * GB },
  parts: { images: 60 * GB, containers: 3 * GB, volumes: 30 * GB, buildCache: 20 * GB, workingCopies: 12 * GB, recordings: 2 * GB, checkTemp: 5 * GB },
  threshold: 50 * GB,
  low: { since: '2026-11-20T10:00:00.000Z' },
  cleaned: [{ part: 'checkTemp', bytes: 8 * GB, at: '2026-11-20T09:59:00.000Z' }],
};
const load = (more: object) => parseNodeMessage(JSON.stringify({ type: 'load', ...LOAD, ...more }));

describe("a node's disk report", () => {
  it("names the parts of the disk that are Hornhoof's, in the order the screens show them", () => {
    expect(DISK_PARTS).toEqual(['images', 'containers', 'volumes', 'buildCache', 'workingCopies', 'recordings', 'checkTemp']);
  });

  it('names the parts each node measures in its own folder, apart from what the whole machine shares', () => {
    expect(NODE_DISK_PARTS).toEqual(['workingCopies', 'recordings', 'checkTemp']);
  });

  it('comes with the load of a newer node, in its hello and on its own', () => {
    expect(load({ disk: DISK })).toEqual({ type: 'load', ...LOAD, disk: DISK });
    expect(parseNodeMessage(JSON.stringify({ type: 'hello', version: '0.41.0', loggedIn: true, running: [], load: { ...LOAD, disk: DISK } }))).toMatchObject({ load: { ...LOAD, disk: DISK } });
  });

  it("names the work it keeps because it can't be restored, biggest first, and leaves the list out where it keeps none", () => {
    const kept = [
      { part: 'workingCopies', agent: '11111111-1111-4111-8111-111111111111', path: 'shop', task: 42, bytes: 9 * GB, why: 'uncommitted' },
      { part: 'workingCopies', agent: '22222222-2222-4222-8222-222222222222', path: 'scratch/copy', task: null, bytes: 2 * GB, why: 'unpushed' },
      { part: 'workingCopies', agent: 'agent-c', path: 'shop-7', task: 7, bytes: GB, why: 'ignored', ignored: ['.env', 'local/'] },
    ];
    expect(load({ disk: { ...DISK, kept } })).toEqual({ type: 'load', ...LOAD, disk: { ...DISK, kept } });
    expect(DiskReport.parse(DISK).kept).toBeUndefined();
  });

  it('lists the largest working copies with their agent and task, and leaves the list out when none are reported', () => {
    const copies = [
      { agent: '11111111-1111-4111-8111-111111111111', path: 'shop-42', task: 42, bytes: 9 * GB },
      { agent: '22222222-2222-4222-8222-222222222222', path: 'shop', task: null, bytes: 3 * GB },
    ];
    expect(load({ disk: { ...DISK, copies } })).toEqual({ type: 'load', ...LOAD, disk: { ...DISK, copies } });
    expect((DiskReport.parse(DISK) as { copies?: unknown }).copies).toBeUndefined();
    expect(parseNodeMessage(JSON.stringify({ type: 'tasks.read' }))).toEqual({ type: 'tasks.read' });
    expect(parseServerMessage(JSON.stringify({ type: 'tasks.open', tasks: { open: [4, 9], upTo: 12 } }))).toEqual({
      type: 'tasks.open',
      tasks: { open: [4, 9], upTo: 12 },
    });
  });

  it('is left out by an older node, and the load stands without it', () => {
    expect(load({})).toEqual({ type: 'load', ...LOAD });
  });

  it("leaves out the parts the node could not measure and Docker's own disk where it has none, and says when the disk is not low", () => {
    const said = { total: DISK.total, free: DISK.free, parts: { workingCopies: 12 * GB }, threshold: DISK.threshold, low: null, cleaned: [] };
    expect(DiskReport.parse(said)).toEqual(said);
  });

  it('is dropped when it is not one, and the rest of the load still counts', () => {
    for (const bad of [
      { ...DISK, free: -1 },
      { ...DISK, total: 1.5 },
      { ...DISK, parts: { ...DISK.parts, images: -1 } },
      { ...DISK, low: { since: 'yesterday' } },
      { ...DISK, cleaned: [{ part: 'photos', bytes: GB, at: '2026-11-20T09:59:00.000Z' }] },
      { ...DISK, cleaned: Array.from({ length: 51 }, () => DISK.cleaned[0]) },
      { ...DISK, threshold: undefined },
      { ...DISK, docker: { total: 200 * GB, free: 15 * GB } },
      { ...DISK, kept: [{ part: 'workingCopies', agent: 'a', path: 'x', task: 1, bytes: GB, why: 'dirty' }] },
      { ...DISK, kept: [{ part: 'workingCopies', agent: 'a', path: 'x'.repeat(301), task: 1, bytes: GB, why: 'unpushed' }] },
      { ...DISK, kept: [{ part: 'workingCopies', agent: 'a'.repeat(65), path: 'x', task: 1, bytes: GB, why: 'unpushed' }] },
      { ...DISK, kept: [{ part: 'workingCopies', agent: 'a', path: 'x', task: 0, bytes: GB, why: 'unpushed' }] },
      { ...DISK, kept: [{ part: 'workingCopies', agent: 'a', path: 'x', task: 1, bytes: GB, why: 'ignored', ignored: Array.from({ length: 21 }, (_, i) => `f${i}`) }] },
      { ...DISK, kept: [{ part: 'workingCopies', agent: 'a', path: 'x', task: 1, bytes: GB, why: 'ignored', ignored: ['x'.repeat(301)] }] },
      { ...DISK, kept: Array.from({ length: 51 }, () => ({ part: 'workingCopies', agent: 'a', path: 'x', task: null, bytes: GB, why: 'unpushed' })) },
      'full',
    ]) {
      expect(load({ disk: bad })).toEqual({ type: 'load', ...LOAD });
    }
  });

  it('keeps no part it does not know', () => {
    expect(DiskReport.parse({ ...DISK, parts: { ...DISK.parts, photos: GB } }).parts).toEqual(DISK.parts);
  });
});

describe('the replica part of a machine disk report', () => {
  it('carries the count, total bytes and the visible companies', () => {
    const replicas = { count: 1, bytes: 4096, companies: [{ name: 'Example Company', bytes: 4096 }] };
    expect(MachineReplicas.parse(replicas)).toEqual(replicas);
    expect(MachineReplicas.parse({ count: 0, bytes: 0, companies: [] })).toEqual({ count: 0, bytes: 0, companies: [] });
    expect(MachineReplicas.safeParse({ ...replicas, count: 1.5 }).success).toBe(false);
    expect(MachineReplicas.safeParse({ ...replicas, companies: [{ name: 'Example Company', bytes: -1 }] }).success).toBe(false);
  });
});
