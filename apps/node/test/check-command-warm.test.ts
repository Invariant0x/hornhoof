import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CheckClient } from '../src/check-client.js';
import { configureCheckCommands, serveCheckCommand } from '../src/check-command-runner.js';
import { setCheckClient } from '../src/check-queue.js';
import { eventually } from '../../../test-support/eventually.mjs';

/* #2091: a check that needs a warm service gets a piece of it with its slot, and the piece goes with the slot; one that needs
   none gets its slot at once, whatever the service does. */

const { assertGroup, clean } = vi.hoisted(() => ({ assertGroup: vi.fn(), clean: vi.fn() }));
vi.mock('../src/check-group.js', () => ({ assertCheckGroup: assertGroup, checkGroupMembers: vi.fn(), signalCheckGroup: vi.fn(), cleanCheckGroup: clean, checkGroupProcess: vi.fn() }));
const KEY = '10000000-0000-4000-8000-000000000031';
const waiting = (command: string[], pid: number) => Buffer.from(JSON.stringify({ command, cwd: '/repo/apps/server', env: {}, wait: true, group: { pid, started: '100' } }));
const VITEST = ['node', '/repo/node_modules/vitest/vitest.mjs', 'run', 'test/a.test.ts'];
const TSC = ['node', '/repo/node_modules/typescript/bin/tsc', '--noEmit'];

type Frame = { type: string; lease?: string; env?: Record<string, string>; message?: string };
function shell() {
  const frames: Frame[] = [];
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false,
    writeHead() { return res; },
    write(text: string) { frames.push(JSON.parse(text) as Frame); return true; },
    end() { res.writableEnded = true; },
  });
  return { res: res as unknown as ServerResponse, frames, letGo: () => { res.destroyed = true; res.emit('close'); } };
}
function machine() {
  const told: string[] = [];
  const client = new CheckClient(frame => {
    told.push(frame.type);
    if (frame.type === 'check.acquire') { const { id } = frame; queueMicrotask(() => client.receive({ type: 'check.state', id, state: 'running', position: 0 })); }
    return true;
  });
  client.online(true); setCheckClient(client);
  return { told };
}
function warm() {
  const drop = vi.fn(async () => {});
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const pieceFor = vi.fn(async (_cwd: string, command: readonly string[]) => {
    if (!command.some(word => word.includes('vitest'))) return null;
    await hold;
    return { env: { FAKE_URL: 'fake://hh_0123456789ab' }, drop };
  });
  return { pieceFor, drop, release };
}

beforeEach(() => { assertGroup.mockResolvedValue(undefined); clean.mockResolvedValue(undefined); });
afterEach(() => { setCheckClient(null); configureCheckCommands(null); vi.resetAllMocks(); });

it('gives a check that needs a service its piece with the slot, and drops the piece as the slot ends', async () => {
  const w = warm(); w.release();
  configureCheckCommands({ uid: 20000, gid: 20000 }, undefined, w);
  const m = machine(), s = shell();
  const served = serveCheckCommand(KEY, waiting(VITEST, 4242), new AbortController().signal, s.res, undefined, 42);
  await eventually(() => s.frames.some(frame => frame.type === 'slot'));
  const slot = s.frames.find(frame => frame.type === 'slot')!;
  expect(slot.env).toEqual({ FAKE_URL: 'fake://hh_0123456789ab' });
  expect(w.pieceFor).toHaveBeenCalledWith('/repo/apps/server', VITEST, slot.lease, expect.any(AbortSignal));
  expect(w.drop).not.toHaveBeenCalled();
  s.letGo();
  expect(await served).toBe(true);
  expect(w.drop).toHaveBeenCalledTimes(1);
  expect(m.told).toEqual(['check.acquire', 'check.release']);
});

it('gives a check that needs no service its slot at once while a check before it waits for its service', async () => {
  const w = warm();
  configureCheckCommands({ uid: 20000, gid: 20000 }, undefined, w);
  machine();
  const first = shell(), second = shell();
  const one = serveCheckCommand(KEY, waiting(VITEST, 4242), new AbortController().signal, first.res, undefined, 42);
  await eventually(() => w.pieceFor.mock.calls.length === 1);
  const two = serveCheckCommand(KEY, waiting(TSC, 4343), new AbortController().signal, second.res, undefined, 43);
  await eventually(() => second.frames.some(frame => frame.type === 'slot'));
  expect(second.frames.find(frame => frame.type === 'slot')!.env).toBeUndefined();
  expect(first.frames.some(frame => frame.type === 'slot')).toBe(false);
  second.letGo(); expect(await two).toBe(true);
  w.release();
  await eventually(() => first.frames.some(frame => frame.type === 'slot'));
  first.letGo(); expect(await one).toBe(true);
});

it('tells a check why it got no piece, and lets its slot and group go', async () => {
  const pieceFor = vi.fn(async () => { throw new Error('db did not answer within 60 s.'); });
  configureCheckCommands({ uid: 20000, gid: 20000 }, undefined, { pieceFor });
  const m = machine(), s = shell();
  expect(await serveCheckCommand(KEY, waiting(VITEST, 4242), new AbortController().signal, s.res, undefined, 42)).toBe(false);
  expect(s.frames.at(-1)).toEqual({ type: 'error', message: 'db did not answer within 60 s.' });
  expect(s.frames.some(frame => frame.type === 'slot')).toBe(false);
  expect(clean).toHaveBeenCalledTimes(1);
  expect(m.told).toEqual(['check.acquire', 'check.release']);
});
