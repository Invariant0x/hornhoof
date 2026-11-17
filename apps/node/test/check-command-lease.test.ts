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

it('stops a local check when its recorded lease stream ends', async () => {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  spawn.mockReturnValue(child);
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) {
    stream = controller;
    controller.enqueue(new TextEncoder().encode('{"type":"slot","lease":"10000000-0000-4000-8000-000000000001"}\n'));
  } }))));
  const pending = checkCommand(['--wait', '--', 'recorded-tool'], { HH_BRIDGE: 'http://example.test/hook/sample' });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(spawn).toHaveBeenCalled();
  stream.close();
  await new Promise<void>(resolve => setImmediate(resolve));
  try { expect(child.kill).toHaveBeenCalled(); }
  finally { child.emit('exit', 0, null); await pending; }
});
