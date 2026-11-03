import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const HOOK = fileURLToPath(new URL('../hh-hook.cjs', import.meta.url));
const AGY = fileURLToPath(new URL('../hh-agy.cjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fakes/agy', import.meta.url));
const CLOCK = fileURLToPath(new URL('./fakes/hook-clock.cjs', import.meta.url));
type Call = { headers: IncomingHttpHeaders; text: string };
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(close => close()));

async function client(kind: 'hh-hook' | 'hh-agy', answer: (call: number) => 'ok' | 'disconnect' | 'timeout' | 'forbidden') {
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
  const args = kind === 'hh-hook' ? [HOOK, 'stop', '{"last_assistant_message":"Done."}'] : [AGY, FAKE];
  const child: ChildProcessWithoutNullStreams = spawn('node', ['-r', CLOCK, ...args], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, HH_BRIDGE: `http://127.0.0.1:${(server.address() as AddressInfo).port}` } });
  cleanups.push(() => child.kill('SIGKILL'));
  let errors = '';
  child.stdout.resume();
  child.stderr.setEncoding('utf8').on('data', chunk => errors += chunk);
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  if (kind === 'hh-agy') child.stdin.write('hello\r');
  else child.stdin.end();
  return { calls, child, errors: () => errors, exited };
}

for (const kind of ['hh-hook', 'hh-agy'] as const) describe(kind, () => {
  it('retries an interrupted stop with the same call id and its actual pid', async () => {
    const c = await client(kind, n => n < 3 ? 'disconnect' : 'ok');
    await vi.waitFor(() => expect(c.calls).toHaveLength(3));
    const ids = c.calls.map(call => call.headers['x-hh-call']);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(ids).size).toBe(1);
    expect(c.calls.map(call => call.headers['x-hh-pid'])).toEqual([String(c.child.pid), String(c.child.pid), String(c.child.pid)]);
    expect(new Set(c.calls.map(call => call.text)).size).toBe(1);
    if (kind === 'hh-hook') await c.exited;
    expect(c.errors()).toBe('');
  });

  it('retries timed out stops but gives up visibly after three attempts', async () => {
    const c = await client(kind, () => 'timeout');
    await vi.waitFor(() => expect(c.errors()).toContain('stop'), { timeout: 4000 });
    expect(c.calls).toHaveLength(3);
    expect(c.errors()).toContain('not confirmed');
    expect(c.errors()).not.toContain('http://');
  });

  it('reports an owner refusal without retrying a permanent HTTP error', async () => {
    const c = await client(kind, () => 'forbidden');
    await vi.waitFor(() => expect(c.errors()).toContain('403'));
    expect(c.calls).toHaveLength(1);
    expect(c.errors()).toContain('stop');
  });
});
