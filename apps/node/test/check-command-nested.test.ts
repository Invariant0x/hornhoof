import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CheckClient } from '../src/check-client.js';
import { configureCheckCommands, serveCheckCommand } from '../src/check-command-runner.js';
import { setCheckClient } from '../src/check-queue.js';
import { eventually } from '../../../test-support/eventually.mjs';

/* #2063: a waiting check started from inside a command that already holds the slot, as a script's own tsc, which lost
   HH_CHECK_SLOT on the way, runs in that slot. It never queues behind its own parent. */
const { assertGroup, clean, inspect } = vi.hoisted(() => ({ assertGroup: vi.fn(), clean: vi.fn(), inspect: vi.fn() }));
vi.mock('../src/check-group.js', () => ({ assertCheckGroup: assertGroup, checkGroupMembers: vi.fn(), signalCheckGroup: vi.fn(), cleanCheckGroup: clean, checkGroupProcess: inspect }));
const KEY = '10000000-0000-4000-8000-000000000031';
const OTHER_KEY = '10000000-0000-4000-8000-000000000032';
const OUTER = { pid: 4242, started: '100' };
const NESTED = { pid: 4400, started: '200' };
const UNRELATED = { pid: 5100, started: '300' };
const wait = (group: { pid: number; started: string }) => Buffer.from(JSON.stringify({ command: ['tsc'], cwd: '/tmp', env: {}, wait: true, group }));

/* Who each process is: its parent, process group and session, as /proc tells. */
const PROCESSES: Record<number, { parent: number; group: number; session: number }> = {
  42: { parent: 1, group: 42, session: 42 },
  /* The outer command's script, and the hh-check its tsc started, in the outer waiting group's session. */
  4300: { parent: 4242, group: 4242, session: 4242 },
  4350: { parent: 4300, group: 4242, session: 4242 },
  /* A script that started its own session, still a descendant of the outer group. */
  4360: { parent: 4300, group: 4360, session: 4360 },
  4370: { parent: 4360, group: 4360, session: 4360 },
  /* Another shell of the agent, outside any held group. */
  5000: { parent: 1, group: 5000, session: 5000 },
};

beforeEach(() => {
  configureCheckCommands({ uid: 20000, gid: 20000 });
  assertGroup.mockResolvedValue(undefined);
  clean.mockResolvedValue(undefined);
  inspect.mockImplementation(async (pid: number) => {
    const p = PROCESSES[pid];
    return p ? { pid, started: '1', state: 'S', uid: 20000, ...p } : null;
  });
});
afterEach(() => { setCheckClient(null); configureCheckCommands(null); vi.resetAllMocks(); });

function shell() {
  const frames: { type: string; lease?: string; position?: number }[] = [];
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false,
    writeHead() { return res; },
    write(text: string) { frames.push(JSON.parse(text) as { type: string }); return true; },
    end() { res.writableEnded = true; },
  });
  return { res: res as unknown as ServerResponse, frames, letGo: () => { res.destroyed = true; res.emit('close'); } };
}

/* A machine with one check slot: the first acquire runs, every later one waits in line until the slot is free. */
function oneSlot() {
  const acquired: string[] = [];
  const client = new CheckClient(frame => {
    if (frame.type === 'check.acquire') {
      const id = frame.id;
      acquired.push(id);
      queueMicrotask(() => client.receive({ type: 'check.state', id, state: acquired.length === 1 ? 'running' : 'queued', position: acquired.length - 1 }));
    }
    return true;
  });
  client.online(true); setCheckClient(client);
  return { acquired };
}

async function holdOuter() {
  const m = oneSlot(), outer = shell(), request = new AbortController();
  const served = serveCheckCommand(KEY, wait(OUTER), request.signal, outer.res, undefined, 42);
  await eventually(() => outer.frames.some(frame => frame.type === 'slot'));
  const lease = outer.frames.find(frame => frame.type === 'slot')!.lease!;
  return { m, outer, request, served, lease };
}

it.each([
  ['in the outer group\'s session', 4350],
  ['in a session a descendant of the outer group started', 4370],
])('runs a nested waiting check %s inside the slot its ancestor holds, with no second acquire', async (_where, caller) => {
  const { m, outer, request, served, lease } = await holdOuter();
  const nested = shell(), nestedRequest = new AbortController();
  const nestedServed = serveCheckCommand(KEY, wait(NESTED), nestedRequest.signal, nested.res, undefined, caller);
  await eventually(() => nested.frames.some(frame => frame.type === 'slot'));
  expect(nested.frames.find(frame => frame.type === 'slot')?.lease).toBe(lease);
  expect(nested.frames.some(frame => frame.type === 'queued')).toBe(false);
  expect(m.acquired).toHaveLength(1);
  /* The nested command ends first, then the outer one: both finish. */
  nested.letGo(); nestedRequest.abort();
  expect(await nestedServed).toBe(true);
  outer.letGo(); request.abort();
  expect(await served).toBe(true);
});

it('keeps an unrelated caller of the same agent waiting in line for the slot', async () => {
  const { m, outer, request, served } = await holdOuter();
  const other = shell(), otherRequest = new AbortController();
  const otherServed = serveCheckCommand(KEY, wait(UNRELATED), otherRequest.signal, other.res, undefined, 5000);
  await eventually(() => m.acquired.length === 2);
  await eventually(() => other.frames.some(frame => frame.type === 'queued'));
  expect(other.frames.some(frame => frame.type === 'slot')).toBe(false);
  otherRequest.abort(); other.letGo();
  await otherServed;
  outer.letGo(); request.abort();
  await served;
});

it('never lends one agent\'s slot to another agent\'s process inside it', async () => {
  const { m, outer, request, served } = await holdOuter();
  const other = shell(), otherRequest = new AbortController();
  const otherServed = serveCheckCommand(OTHER_KEY, wait(NESTED), otherRequest.signal, other.res, undefined, 4350);
  await eventually(() => m.acquired.length === 2);
  expect(other.frames.some(frame => frame.type === 'slot')).toBe(false);
  otherRequest.abort(); other.letGo();
  await otherServed;
  outer.letGo(); request.abort();
  await served;
});

it('queues a nested check again once the outer slot has ended', async () => {
  const { m, outer, request, served } = await holdOuter();
  outer.letGo(); request.abort();
  expect(await served).toBe(true);
  const late = shell(), lateRequest = new AbortController();
  const lateServed = serveCheckCommand(KEY, wait(NESTED), lateRequest.signal, late.res, undefined, 4350);
  await eventually(() => m.acquired.length === 2);
  lateRequest.abort(); late.letGo();
  await lateServed;
});
