import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CheckClient } from '../src/check-client.js';
import { configureCheckCommands, serveCheckCommand } from '../src/check-command-runner.js';
import { setCheckClient } from '../src/check-queue.js';
import { eventually } from '../../../test-support/eventually.mjs';

const KEY = '10000000-0000-4000-8000-000000000021';
const WAIT = Buffer.from(JSON.stringify({ command: ['recorded-tool'], cwd: '/tmp', env: {}, wait: true }));
beforeEach(() => configureCheckCommands({ uid: 20000, gid: 20000 }));
afterEach(() => { setCheckClient(null); configureCheckCommands(null); });

/* The agent's shell on the other end of a waiting command: what the node writes to it, and its going away. */
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

/* A machine whose server grants the slot at once and may end it, with what the node told the server. */
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

it.each([
  ['its lease ends', (m: ReturnType<typeof machine>) => m.endLease()],
  ['the turn token changes', (_m: ReturnType<typeof machine>, request: AbortController) => request.abort()],
] as const)('tells the shell to stop when %s and gives the slot back only once the shell let go', async (_why, end) => {
  const m = machine(), s = shell(), request = new AbortController();
  const served = serveCheckCommand(KEY, WAIT, request.signal, s.res);
  await eventually(() => s.frames.some(frame => frame.type === 'slot'));
  end(m, request);
  await eventually(() => s.frames.some(frame => frame.type === 'stop'));
  expect(s.frames.at(-1)).toEqual({ type: 'stop', message: 'The machine check slot ended.' });
  /* The command and its group still run in the shell: the slot stays taken. */
  for (let turn = 0; turn < 5; turn += 1) await new Promise<void>(resolve => { setImmediate(resolve); });
  expect(m.told).toEqual(['check.acquire']);
  s.letGo();
  expect(await served).toBe(true);
  expect(m.told).toEqual(['check.acquire', 'check.release']);
});

it('gives the slot back at once when the shell lets go first, with no word to stop', async () => {
  const m = machine(), s = shell(), request = new AbortController();
  const served = serveCheckCommand(KEY, WAIT, request.signal, s.res);
  await eventually(() => s.frames.some(frame => frame.type === 'slot'));
  /* As the bridge does: the shell's request closes and aborts what it asked for. */
  s.letGo(); request.abort();
  expect(await served).toBe(true);
  expect(m.told).toEqual(['check.acquire', 'check.release']);
  expect(s.frames.map(frame => frame.type)).toEqual(['slot']);
});
