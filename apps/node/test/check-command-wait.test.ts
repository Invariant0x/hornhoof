import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { checkCommand } from '../src/check-command.js';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const original = new Map(signals.map(signal => [signal, process.listeners(signal)]));
afterEach(() => {
  for (const signal of signals) for (const listener of process.listeners(signal)) {
    if (!original.get(signal)!.includes(listener)) process.removeListener(signal, listener);
  }
  vi.unstubAllGlobals();
});

it('reuses an inherited slot for an explicit nested wait', async () => {
  const lease = '10000000-0000-4000-8000-000000000001';
  const request = vi.fn(async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'slot', lease }) + '\n'));
  } })));
  vi.stubGlobal('fetch', request);
  spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    queueMicrotask(() => child.emit('exit', 7, null));
    return child;
  });
  expect(await checkCommand(['--wait', '--', 'recorded-tool'], { HH_BRIDGE: 'http://example.test/hook/sample', HH_CHECK_SLOT: lease })).toBe(7);
  expect(JSON.parse((request.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).lease).toBe(lease);
});

it.each([['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const)('preserves the recorded %s termination as status %i', async (signal, status) => {
  spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    queueMicrotask(() => child.emit('exit', null, signal));
    return child;
  });
  expect(await checkCommand(['--wait', '--', 'recorded-tool'], {})).toBe(status);
});
