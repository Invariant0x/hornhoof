import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Ctx } from '../src/app.js';
import { programsLive, roomFor, START_FREE_BYTES, turnSent } from '../src/modules/nodes/program-room.js';
import type { NodeLoad } from '@hornhoof/protocol';

const GIB = 2 ** 30;
const node = { kind: 'node' as const, nodeId: 'recorded-node' };
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-01-01T00:00:00Z') }); });
afterEach(() => { vi.useRealTimers(); });

function machine(free: number, live: string[] = []) {
  let load: NodeLoad = { cpus: 10, load: 1, memFree: free, memTotal: 12 * GIB, tests: 0, jobs: 0 };
  const ctx = { hub: { loadOf: () => load } } as unknown as Ctx;
  programsLive(ctx, node, live, 0);
  return { ctx, report: (free: number, live: string[], working: number, busy = 1) => {
    load = { ...load, memFree: free, load: busy };
    return programsLive(ctx, node, live, working);
  } };
}

it('reserves half a GiB for an unreported start and expires that reservation on virtual time', () => {
  expect(START_FREE_BYTES).toBe(1.5 * GIB);
  const m = machine(1.75 * GIB);
  expect(roomFor(m.ctx, node, 'first')).toBe(true);
  turnSent(m.ctx, node, 'first');
  expect(roomFor(m.ctx, node, 'second')).toBe(false);
  vi.setSystemTime(Date.now() + 2 * 60_000);
  expect(m.report(1.75 * GIB, [], 0)).toEqual(['second']);
  expect(roomFor(m.ctx, node, 'second')).toBe(true);
});

it('admits an existing program after CPU pressure ends despite another unreported start, then eases one turn per report', () => {
  const m = machine(1.75 * GIB, ['first', 'waiting']);
  turnSent(m.ctx, node, 'starting');
  m.report(1.75 * GIB, ['first', 'waiting'], 1, 20);
  expect(roomFor(m.ctx, node, 'waiting')).toBe(false);
  expect(m.report(1.75 * GIB, ['first', 'waiting'], 1)).toEqual(['waiting']);
  expect(roomFor(m.ctx, node, 'waiting')).toBe(true);
  turnSent(m.ctx, node, 'waiting');
  expect(roomFor(m.ctx, node, 'first')).toBe(false);
  expect(m.report(1.75 * GIB, ['first', 'waiting'], 2)).toEqual(['first']);
  expect(roomFor(m.ctx, node, 'first')).toBe(true);
});

it('lets an idle resident program continue below the new-program memory threshold', () => {
  const m = machine(0.5 * GIB, ['resident']);
  expect(roomFor(m.ctx, node, 'resident')).toBe(true);
  expect(roomFor(m.ctx, node, 'new')).toBe(false);
  expect(m.report(3 * GIB, ['resident'], 0)).toEqual(['new']);
  expect(roomFor(m.ctx, node, 'new')).toBe(true);
});
