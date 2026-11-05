import { spawn } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hookClock } from './hook-test-clock.js';

const HOOK = fileURLToPath(new URL('../hh-hook.cjs', import.meta.url));
const CLOCK = fileURLToPath(new URL('./fakes/hook-clock.cjs', import.meta.url));

type Call = { headers: IncomingHttpHeaders; text: string };
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(close => close()));

async function client(answer: (call: number) => 'ok' | 'disconnect' | 'timeout' | 'forbidden') {
  const calls: Call[] = [];
  const server = createServer((req, res) => {
    let text = '';
    req.setEncoding('utf8').on('data', chunk => text += chunk).on('end', () => {
      if (req.url !== '/stop') return void res.end('');
      calls.push({ headers: req.headers, text });
      const how = answer(calls.length);
      if (how === 'disconnect') return res.destroy();
      if (how === 'timeout') return;
      res.writeHead(how === 'forbidden' ? 403 : 200).end('');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => { server.closeAllConnections(); server.close(); });
  const dir = mkdtempSync(join(tmpdir(), 'hh-client-'));
  const args = [HOOK, 'stop', '{"last_assistant_message":"Done."}'];
  const child = spawn('node', ['-r', CLOCK, ...args], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], cwd: dir, env: { PATH: process.env.PATH, HOME: dir, HH_BRIDGE: `http://127.0.0.1:${(server.address() as AddressInfo).port}` } });
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error('Hook pipe streams unavailable');
  cleanups.push(() => child.kill('SIGKILL'));
  let errors = '';
  child.stdout.resume();
  child.stderr.setEncoding('utf8').on('data', chunk => errors += chunk);
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.stdin.end();
  return { calls, child, clock: hookClock(child), errors: () => errors, exited };
}

describe('hh-hook', () => {
  it('retries an interrupted stop with the same call id and its actual pid', async () => {
    const c = await client(n => n < 3 ? 'disconnect' : 'ok');
    await vi.waitFor(() => expect(c.calls).toHaveLength(3));
    const ids = c.calls.map(call => call.headers['x-hh-call']);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(ids).size).toBe(1);
    expect(c.calls.map(call => call.headers['x-hh-pid'])).toEqual([String(c.child.pid), String(c.child.pid), String(c.child.pid)]);
    expect(new Set(c.calls.map(call => call.text)).size).toBe(1);
    await c.exited;
    expect(c.child.exitCode).toBe(0);
    expect(c.errors()).toBe('');
  });

  it('retries timed out stops but gives up visibly after three attempts', async () => {
    const c = await client(() => 'timeout');
    for (let attempt = 1; attempt <= 3; attempt++) {
      await vi.waitFor(() => expect(c.calls).toHaveLength(attempt));
      await c.clock.advance(15_000);
    }
    await c.exited;
    expect(c.child.exitCode).toBe(0);
    expect(c.calls).toHaveLength(3);
    expect(c.errors()).toContain('not confirmed');
    expect(c.errors()).not.toContain('http://');
  });

  it('reports an owner refusal without retrying a permanent HTTP error', async () => {
    const c = await client(() => 'forbidden');
    await vi.waitFor(() => expect(c.errors()).toContain('403'));
    expect(c.calls).toHaveLength(1);
    expect(c.errors()).toContain('stop');
  });
});
