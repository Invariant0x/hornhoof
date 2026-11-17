import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { checkCommand } from '../src/check-command.js';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
vi.mock('../src/check-group.js', () => ({ checkGroupProcess: async () => ({ pid: 4242, group: 4242, session: 4242, started: '100' }) }));
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const original = new Map(signals.map(signal => [signal, process.listeners(signal)]));
afterEach(() => {
  for (const signal of signals) for (const listener of process.listeners(signal)) {
    if (!original.get(signal)!.includes(listener)) process.removeListener(signal, listener);
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const LEASE = '10000000-0000-4000-8000-000000000001';
const AGENT = { HH_BRIDGE: 'http://example.test/hook/sample' };
const line = (frame: object) => new TextEncoder().encode(`${JSON.stringify(frame)}\n`);
const turn = setImmediate;
const tick = () => new Promise<void>(resolve => { turn(resolve); });

/* A recorded command, pid 4242, which leads its own process group: the signals sent to it and to its group are written
   down, and it exits when the test says so. */
function recorded() {
  const child = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn(() => true), send: vi.fn(), disconnect: vi.fn(), unref: vi.fn() });
  spawn.mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child; });
  const group: string[] = [];
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    if (pid !== -4242) throw new Error(`unexpected kill of ${pid}`);
    group.push(String(signal));
    return true;
  }) as typeof process.kill);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return { child, group };
}

/* The stream of the slot as the node's bridge sends it: the slot first, then what each test makes of it. */
function slotStream(): () => ReadableStreamDefaultController<Uint8Array> {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) {
    stream = controller;
    controller.enqueue(line({ type: 'slot', lease: LEASE }));
  } }))));
  return () => stream;
}

it('runs the command in a process group of its own while it holds a slot, and as before with none', async () => {
  const { child } = recorded();
  slotStream();
  const held = checkCommand(['--wait', '--', 'recorded-tool', '-p'], AGENT);
  await tick();
  child.emit('exit', 0, null);
  expect(await held).toBe(0);
  expect(spawn).toHaveBeenLastCalledWith(process.execPath, ['-e', expect.any(String)], expect.objectContaining({ detached: true, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] }));
  expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ command: ['recorded-tool', '-p'], managed: true }));
  const alone = checkCommand(['--wait', '--', 'recorded-tool'], {});
  await tick();
  child.emit('exit', 0, null);
  expect(await alone).toBe(0);
  expect(spawn).toHaveBeenLastCalledWith('recorded-tool', [], expect.objectContaining({ detached: false }));
});

it.each([
  ['ends', (stream: ReadableStreamDefaultController<Uint8Array>) => stream.close()],
  ['fails', (stream: ReadableStreamDefaultController<Uint8Array>) => stream.error(new Error('connection reset'))],
  ['says the node failed', (stream: ReadableStreamDefaultController<Uint8Array>) => stream.enqueue(line({ type: 'error', message: 'The machine check queue failed.' }))],
  ['says the slot or the turn ended', (stream: ReadableStreamDefaultController<Uint8Array>) => stream.enqueue(line({ type: 'stop', message: 'The machine check slot ended.' }))],
] as const)('stops the whole group of the command when the slot stream %s, and the check does not pass', async (_how, end) => {
  const { child, group } = recorded();
  const stream = slotStream();
  const pending = checkCommand(['--wait', '--', 'recorded-tool'], AGENT);
  await tick();
  expect(group).toEqual([]);
  end(stream());
  await tick();
  /* The group alone: its leader gets the signal once, as from a terminal. */
  expect(group).toEqual(['SIGTERM']);
  expect(child.kill).not.toHaveBeenCalled();
  /* A command that catches TERM and exits 0 was still stopped before its end: 128 + 15, as a shell gives. */
  child.emit('exit', 0, null);
  expect(await pending).toBe(143);
});

it('kills the group that outlives its grace after TERM, on the clock the test moves', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { child, group } = recorded();
  const stream = slotStream();
  const pending = checkCommand(['--wait', '--', 'recorded-tool'], AGENT);
  await tick();
  stream().enqueue(line({ type: 'stop', message: 'The machine check slot ended.' }));
  await tick();
  expect(group).toEqual(['SIGTERM']);
  vi.advanceTimersByTime(4999);
  expect(group).toEqual(['SIGTERM']);
  vi.advanceTimersByTime(1);
  expect(group).toEqual(['SIGTERM', 'SIGKILL']);
  child.emit('exit', null, 'SIGKILL');
  expect(await pending).toBe(137);
  expect(vi.getTimerCount()).toBe(0);
});

it('leaves a command that ends on its own to its end, then ends what it left in its group before the slot goes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { child, group } = recorded();
  const stream = slotStream();
  const pending = checkCommand(['--wait', '--', 'recorded-tool'], AGENT);
  await tick();
  child.emit('exit', 7, null);
  expect(await pending).toBe(7);
  expect(group).toEqual([]);
  /* The stream ends as the command lets the slot go: nothing more is stopped and no clock is left. */
  stream().close();
  await tick();
  expect(group).toEqual([]);
  expect(child.kill).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('sends a signal it is given to the whole group of the command', async () => {
  const { child, group } = recorded();
  slotStream();
  const pending = checkCommand(['--wait', '--', 'recorded-tool'], AGENT);
  await tick();
  process.emit('SIGINT', 'SIGINT');
  expect(group).toEqual(['SIGINT']);
  child.emit('exit', null, 'SIGINT');
  expect(await pending).toBe(130);
});

it('never reports success when a command catches the wrapper cancellation and exits zero', async () => {
  const { child } = recorded();
  slotStream();
  const pending = checkCommand(['--wait', '--', 'recorded-tool'], AGENT);
  await tick();
  process.emit('SIGTERM', 'SIGTERM');
  child.emit('exit', 0, null);
  expect(await pending).toBe(143);
});

it('bounds cleanup when a command ignores cancellation sent to the wrapper', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { child, group } = recorded();
  slotStream();
  const pending = checkCommand(['--wait', '--', 'recorded-tool'], AGENT);
  await tick();
  process.emit('SIGTERM', 'SIGTERM');
  try {
    expect(group).toEqual(['SIGTERM']);
    vi.advanceTimersByTime(4999);
    expect(group).toEqual(['SIGTERM']);
    vi.advanceTimersByTime(1);
    expect(group).toEqual(['SIGTERM', 'SIGKILL']);
  } finally {
    child.emit('exit', null, 'SIGKILL');
    await pending;
  }
});

it('keeps cancellation cleanup alive when its diagnostic cannot be written', async () => {
  const { child } = recorded();
  const stream = slotStream();
  const pending = checkCommand(['--wait', '--', 'recorded-tool'], AGENT);
  await tick();
  vi.mocked(process.stderr.write).mockImplementationOnce(() => { throw new Error('recorded EPIPE'); });
  stream().close();
  await tick();
  child.emit('exit', 0, null);
  expect(await pending).toBe(143);
});
