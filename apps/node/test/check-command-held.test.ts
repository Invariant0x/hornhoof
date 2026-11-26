import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CheckClient } from '../src/check-client.js';
import { configureCheckCommands, serveCheckCommand } from '../src/check-command-runner.js';
import { setCheckClient } from '../src/check-queue.js';
import { eventually } from '../../../test-support/eventually.mjs';

const { assertGroup, clean, processOf } = vi.hoisted(() => ({ assertGroup: vi.fn(), clean: vi.fn(), processOf: vi.fn() }));
vi.mock('../src/check-group.js', () => ({ assertCheckGroup: assertGroup, checkGroupMembers: vi.fn(), signalCheckGroup: vi.fn(), cleanCheckGroup: clean, checkGroupProcess: processOf }));
const KEY = '10000000-0000-4000-8000-000000000021';
const GROUP = { pid: 4242, started: '100' };
const WAIT = Buffer.from(JSON.stringify({ command: ['recorded-tool'], cwd: '/tmp', env: {}, wait: true, group: GROUP }));
/* No check of these runs inside another's slot (#2063): its caller has no process of a held group above it. */
beforeEach(() => { configureCheckCommands({ uid: 20000, gid: 20000 }); assertGroup.mockResolvedValue(undefined); processOf.mockResolvedValue(null); });
afterEach(() => { setCheckClient(null); configureCheckCommands(null); vi.resetAllMocks(); });

function shell() {
  const frames: { type: string; message?: string }[] = [];
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false,
    writeHead() { return res; },
    write(text: string) { frames.push(JSON.parse(text) as { type: string }); return true; },
    end() { res.writableEnded = true; },
  });
  return { res: res as unknown as ServerResponse, frames, letGo: () => { res.destroyed = true; res.emit('close'); } };
}
function machine() {
  const told: string[] = [];
  let id = '';
  const client = new CheckClient(frame => {
    told.push(frame.type);
    if (frame.type === 'check.acquire') { id = frame.id; queueMicrotask(() => client.receive({ type: 'check.state', id, state: 'running', position: 0 })); }
    return true;
  });
  client.online(true); setCheckClient(client);
  return { told, endLease: () => client.receive({ type: 'check.state', id, state: 'ended', position: 0 }) };
}

it.each(['lease', 'turn', 'close'] as const)('owns cleanup on %s without trusting the wrapper to close or kill its group', async why => {
  let gone!: () => void;
  clean.mockImplementation(() => new Promise<void>(resolve => { gone = resolve; }));
  const m = machine(), s = shell(), request = new AbortController();
  const served = serveCheckCommand(KEY, WAIT, request.signal, s.res, undefined, 42);
  await eventually(() => s.frames.some(frame => frame.type === 'slot'));
  expect(assertGroup).toHaveBeenCalledWith(GROUP, 20000, 42);
  if (why === 'lease') m.endLease();
  else if (why === 'turn') request.abort();
  else { s.letGo(); request.abort(); }
  await eventually(() => clean.mock.calls.length === 1);
  expect(clean).toHaveBeenCalledWith(GROUP, 20000, expect.any(Object));
  expect(m.told).toEqual(['check.acquire']);
  if (why !== 'close') expect(s.frames.at(-1)?.type).toBe('stop');
  gone();
  expect(await served).toBe(true);
  expect(m.told).toEqual(['check.acquire', 'check.release']);
});

it('never acquires or signals a group whose identity is refused', async () => {
  assertGroup.mockRejectedValue(new Error('wrong process owner'));
  const m = machine(), s = shell();
  expect(await serveCheckCommand(KEY, WAIT, new AbortController().signal, s.res, undefined, 42)).toBe(false);
  expect(m.told).toEqual([]);
  expect(clean).not.toHaveBeenCalled();
  expect(s.frames).toEqual([{ type: 'error', message: 'wrong process owner' }]);
});
