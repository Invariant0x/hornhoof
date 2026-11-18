import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Ctx } from '../src/app.js';
import { programsLive, roomFor, turnSent } from '../src/modules/nodes/program-room.js';
import type { NodeLoad } from '@hornhoof/protocol';

const GIB = 2 ** 30;
const node = { kind: 'node' as const, nodeId: 'recorded-node' };
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-01-01T00:00:00Z') }); });
afterEach(() => { vi.useRealTimers(); });

/* What a node said of its machine on 18 November 2026: 7 GB of 15 free, while its tests kept the processors busy. */
const SAID: NodeLoad = { cpus: 16, load: 6.95, memFree: 7 * GIB, memTotal: 15 * GIB, tests: 0, jobs: 3, memoryShort: false };

/* A node that reports its machine: each report says whether the kernel killed for want of memory since the one before,
   and names the programs that run there unless live is null. */
function machine(first: Partial<NodeLoad>, live: string[] | null = []) {
  let load: NodeLoad = { ...SAID, ...first };
  const ctx = { hub: { loadOf: () => load } } as unknown as Ctx;
  programsLive(ctx, node, live ?? undefined);
  return { ctx, report: (said: Partial<NodeLoad>, now: string[] | null = live) => {
    load = { ...SAID, ...said };
    return programsLive(ctx, node, now ?? undefined);
  } };
}

it('starts a new program however little memory is free and however busy the processors are, while the kernel killed nothing', () => {
  const m = machine({ memFree: 0.2 * GIB, load: 64 }, ['resident']);
  expect(roomFor(m.ctx, node, 'new')).toBe(true);
  turnSent(m.ctx, node, 'new');
  expect(roomFor(m.ctx, node, 'another')).toBe(true);
  expect(roomFor(m.ctx, node, 'resident')).toBe(true);
});

it('holds new programs after a report of a kill, lets the programs that run or start there go on, and lets every one that waited go with the next report that finds none', () => {
  const m = machine({}, ['resident']);
  turnSent(m.ctx, node, 'starting');
  expect(m.report({ memoryShort: true })).toEqual([]);
  expect(roomFor(m.ctx, node, 'resident')).toBe(true);
  expect(roomFor(m.ctx, node, 'starting')).toBe(true);
  expect(roomFor(m.ctx, node, 'first')).toBe(false);
  expect(roomFor(m.ctx, node, 'second')).toBe(false);
  /* An agent's window only asks, and so waits nowhere. */
  expect(roomFor(m.ctx, node, 'looking', true)).toBe(false);
  /* Another kill holds them again. */
  expect(m.report({ memoryShort: true })).toEqual([]);
  expect(m.report({ memoryShort: false, memFree: 0.1 * GIB })).toEqual(['first', 'second']);
  expect(roomFor(m.ctx, node, 'first')).toBe(true);
  expect(roomFor(m.ctx, node, 'second')).toBe(true);
  expect(m.report({ memoryShort: false })).toEqual([]);
});

it('stops counting a program sent to start as there two minutes on, if its node never names it', () => {
  const m = machine({});
  turnSent(m.ctx, node, 'starting');
  m.report({ memoryShort: true }, []);
  expect(roomFor(m.ctx, node, 'starting')).toBe(true);
  vi.setSystemTime(Date.now() + 2 * 60_000);
  expect(roomFor(m.ctx, node, 'starting')).toBe(false);
});

it('holds every turn after a kill on a node that does not name its programs, for each of its turns starts one', () => {
  const m = machine({}, null);
  expect(roomFor(m.ctx, node, 'any')).toBe(true);
  m.report({ memoryShort: true });
  expect(roomFor(m.ctx, node, 'any')).toBe(false);
  expect(m.report({ memoryShort: false })).toEqual(['any']);
});

it('never holds a turn on a node that says nothing of kills, as one from before does, whatever its memory', () => {
  const m = machine({ memoryShort: undefined, memFree: 0 }, []);
  expect(roomFor(m.ctx, node, 'new')).toBe(true);
});
