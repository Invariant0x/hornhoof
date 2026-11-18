import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventually } from '../../../test-support/eventually.mjs';
import { listenIn } from '../../../test-support/ports.mjs';
const { sendHook } = createRequire(import.meta.url)('../hh-hook-send.cjs');
const close: (() => void)[] = [];
afterEach(() => { close.splice(0).forEach(fn => fn());vi.unstubAllEnvs();vi.restoreAllMocks(); });

async function bridge(status: number | 'timeout' | 'disconnect', recover = false) {
  const calls: { call: string; pid: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';req.setEncoding('utf8').on('data', s => body += s).on('end', () => {
      calls.push({ call: String(req.headers['x-hh-call']), pid: String(req.headers['x-hh-pid']), body });
      if (recover && calls.length === 3) return void res.end('done');
      if (status === 'timeout') return;
      if (status === 'disconnect') return res.destroy();
      res.writeHead(status).end('');
    });
  });
  await listenIn(server);
  close.push(() => { server.closeAllConnections();server.close(); });
  vi.stubEnv('HH_BRIDGE', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  return calls;
}

describe('shared hook transport', () => {
  it('does nothing without a bridge', async () => {
    vi.stubEnv('HH_BRIDGE', '');expect(await sendHook('stop', '{}')).toBeNull();
  });
  it('recovers from server errors with the same id and body', async () => {
    const calls = await bridge(503, true);
    const res = await sendHook('stop', '{"answer":"Done"}');
    expect(await res.text()).toBe('done');
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map(c => c.call)).size).toBe(1);
    expect(calls.every(c => c.pid === String(process.pid) && c.body === '{"answer":"Done"}')).toBe(true);
  });
  it.each([403, 'disconnect', 'timeout'] as const)('reports a final %s failure and remains bounded', async status => {
    const calls = await bridge(status);
    /* No clock: a call's limit runs out once a bridge that never answers holds that call, and never while a bridge answers. */
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const limit = new AbortController(), heard = calls.length;
      if (status === 'timeout') void eventually(() => calls.length > heard).then(() => { limit.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')); });
      return limit.signal;
    });
    expect(await sendHook('stop', '{}')).toBeNull();
    expect(calls).toHaveLength(status === 403 ? 1 : 3);
  });
  it('does not retry non-stop hooks', async () => {
    const calls = await bridge(503);
    expect(await sendHook('status', '{}')).toBeNull();expect(calls).toHaveLength(1);
  });
});

describe('lifecycle hook delivery', () => {
  it.each(['tool', 'tooldone', 'toolfail'])('%s tries once, and waits three seconds for a busy node to check its caller', async event => {
    const calls = await bridge(503);
    const timer = vi.spyOn(AbortSignal, 'timeout');
    expect(await sendHook(event, '{}')).toBeNull();
    expect(calls).toHaveLength(1);
    expect(timer).toHaveBeenCalledWith(3000);
  });
  it('retries an interrupt with the same call id', async () => {
    const calls = await bridge(503, true);
    expect(await sendHook('interrupt', '{}')).not.toBeNull();
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map(c => c.call)).size).toBe(1);
  });
});
