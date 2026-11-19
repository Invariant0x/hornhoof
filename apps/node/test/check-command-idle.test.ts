import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CheckClient } from '../src/check-client.js';
import { checkCommand } from '../src/check-command.js';
import { configureCheckCommands, serveCheckCommand } from '../src/check-command-runner.js';
import { setCheckClient } from '../src/check-queue.js';
import { eventually } from '../../../test-support/eventually.mjs';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
vi.mock('../src/check-group.js', () => ({
  checkGroupProcess: async () => ({ pid: 4242, group: 4242, session: 4242, started: '100' }),
  assertCheckGroup: async () => {}, checkGroupMembers: vi.fn(), signalCheckGroup: vi.fn(), cleanCheckGroup: async () => {},
}));

const KEY = '10000000-0000-4000-8000-000000000031';
const AGENT = { HH_BRIDGE: 'http://127.0.0.1:1/hook/sample' };
/* How long Node's own fetch lets a response body stay silent before it ends it with the bare word "terminated": the
   bodyTimeout of the undici inside Node, 300 s. */
const SILENT_MS = 300_000;
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const original = new Map(signals.map(signal => [signal, process.listeners(signal)]));

beforeEach(() => {
  configureCheckCommands({ uid: 20000, gid: 20000 });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => {
  for (const signal of signals) for (const listener of process.listeners(signal)) {
    if (!original.get(signal)!.includes(listener)) process.removeListener(signal, listener);
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setCheckClient(null);
  configureCheckCommands(null);
});

/* The machine's queue: the command waits at position 2 until the test gives it the slot. */
function queue() {
  let id = '';
  const client = new CheckClient(frame => {
    if (frame.type === 'check.acquire') { id = frame.id; queueMicrotask(() => client.receive({ type: 'check.state', id, state: 'queued', position: 2 })); }
    return true;
  });
  client.online(true); setCheckClient(client);
  return { grant: () => client.receive({ type: 'check.state', id, state: 'running', position: 0 }) };
}

const timeout = () => new TypeError('terminated', { cause: Object.assign(new Error('Body Timeout Error'), { code: 'UND_ERR_BODY_TIMEOUT' }) });
const closed = () => new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });

/* The command's request to the node's own bridge, served by it, with the body as Node's fetch gives it: the frames as the
   bridge writes them, ended as "terminated" once it stays silent for SILENT_MS. gone() is the node going away. */
function bridge() {
  let body!: ReadableStreamDefaultController<Uint8Array>, quiet: NodeJS.Timeout | undefined, open = true;
  const fail = (error: Error) => {
    if (!open) return;
    open = false; clearTimeout(quiet); body.error(error);
  };
  const heard = () => { clearTimeout(quiet); quiet = setTimeout(() => fail(timeout()), SILENT_MS); };
  const request = new AbortController();
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false,
    writeHead() { return res; },
    write(text: string) { if (open) { body.enqueue(new TextEncoder().encode(text)); heard(); } return true; },
    end() { res.writableEnded = true; if (open) { open = false; clearTimeout(quiet); body.close(); } },
  });
  vi.stubGlobal('fetch', vi.fn(async (_url: URL, init: RequestInit) => {
    init.signal?.addEventListener('abort', () => { request.abort(); fail(new DOMException('This operation was aborted', 'AbortError')); });
    const stream = new ReadableStream<Uint8Array>({ start(controller) { body = controller; } });
    heard();
    void serveCheckCommand(KEY, Buffer.from(String(init.body)), request.signal, res as unknown as ServerResponse, undefined, 4242);
    return new Response(stream);
  }));
  return { gone: () => { res.destroyed = true; res.emit('close'); request.abort(); fail(closed()); } };
}

/* The parked leader of the command's process group, pid 4242: what it is told to start, the signals sent to its group,
   and what the command says on stderr. It exits when the test says so. */
function parked() {
  const child = Object.assign(new EventEmitter(), { pid: 4242, connected: true, kill: vi.fn(() => true), send: vi.fn(), disconnect: vi.fn(), unref: vi.fn() });
  spawn.mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child; });
  const group: string[] = [];
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    if (pid !== -4242) throw new Error(`unexpected kill of ${pid}`);
    group.push(String(signal));
    return true;
  }) as typeof process.kill);
  const said: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(((text: string | Uint8Array) => { said.push(String(text)); return true; }) as typeof process.stderr.write);
  return { child, group, said, started: () => child.send.mock.calls.length > 0, exit: (code: number) => child.emit('message', { code, signal: null }) };
}

/* How the command ends, once it does. */
function ending(run: Promise<number>) {
  const end: { code?: number; error?: string } = {};
  void run.then(code => { end.code = code; }, (error: Error) => { end.error = error.message; });
  return end;
}

it('keeps a command waiting in the queue longer than a silent stream may last, and starts it once its slot comes', async () => {
  const machine = queue(); bridge(); const command = parked();
  const end = ending(checkCommand(['--wait', '--', 'recorded-tool'], AGENT));
  await vi.advanceTimersByTimeAsync(2 * SILENT_MS);
  expect(end).toEqual({});
  expect(command.said).toEqual(['Waiting for a machine check slot. Position 2.\n']);
  expect(command.started()).toBe(false);
  machine.grant();
  await eventually(() => command.started());
  expect(command.child.send.mock.calls[0]![0]).toMatchObject({ command: ['recorded-tool'], managed: true, env: { HH_CHECK_SLOT: expect.any(String) } });
  command.exit(0);
  await eventually(() => end.code !== undefined);
  expect(end).toEqual({ code: 0 });
  /* The bridge ended its stream, and with it whatever kept the stream alive. */
  await eventually(() => vi.getTimerCount() === 0);
});

it('keeps a command that holds its slot running longer than a silent stream may last', async () => {
  const machine = queue(); bridge(); const command = parked();
  const end = ending(checkCommand(['--wait', '--', 'recorded-tool'], AGENT));
  await eventually(() => command.said.length > 0);
  machine.grant();
  await eventually(() => command.started());
  await vi.advanceTimersByTimeAsync(2 * SILENT_MS);
  expect(command.group).toEqual([]);
  expect(command.said).toEqual(['Waiting for a machine check slot. Position 2.\n']);
  command.exit(3);
  await eventually(() => end.code !== undefined);
  expect(end).toEqual({ code: 3 });
});

it('says the connection to the node ended, never a bare "terminated", when the node goes away while the command waits', async () => {
  queue(); const node = bridge(); const command = parked();
  const end = ending(checkCommand(['--wait', '--', 'recorded-tool'], AGENT));
  await eventually(() => command.said.length > 0);
  node.gone();
  await eventually(() => end.error !== undefined);
  expect(end).toEqual({ error: "The connection to the node's machine check bridge ended before the command got a slot (other side closed)." });
  expect(command.started()).toBe(false);
});

it('stops the command with the reason when the node goes away while it holds its slot', async () => {
  const machine = queue(); const node = bridge(); const command = parked();
  const end = ending(checkCommand(['--wait', '--', 'recorded-tool'], AGENT));
  await eventually(() => command.said.length > 0);
  machine.grant();
  await eventually(() => command.started());
  node.gone();
  await eventually(() => command.group.length > 0);
  expect(command.group).toEqual(['SIGTERM']);
  await eventually(() => command.said.length > 1);
  expect(command.said.at(-1)).toBe("The connection to the node's machine check bridge ended (other side closed). The command stops.\n");
  command.child.emit('exit', null, 'SIGTERM');
  await eventually(() => end.code !== undefined);
  expect(end).toEqual({ code: 143 });
});
