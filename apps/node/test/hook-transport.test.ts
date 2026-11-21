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
  it.each([403, 'disconnect', 'timeout'] as const)('reports a final %s failure, bounded by one wait', async status => {
    const calls = await bridge(status);
    /* No clock: a call's limit runs out once a bridge that never answers holds that call, and never while a bridge answers. */
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const limit = new AbortController(), heard = calls.length;
      if (status === 'timeout') void eventually(() => calls.length > heard).then(() => { limit.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')); });
      return limit.signal;
    });
    expect(await sendHook('stop', '{}')).toBeNull();
    /* A call out of time is not sent again: on a new connection its check would start over. */
    expect(calls).toHaveLength(status === 'disconnect' ? 3 : 1);
  });
  it('does not retry non-stop hooks', async () => {
    const calls = await bridge(503);
    expect(await sendHook('status', '{}')).toBeNull();expect(calls).toHaveLength(1);
  });
});

describe('lifecycle hook delivery', () => {
  it.each(['start', 'prompt', 'stop', 'interrupt', 'end', 'ask', 'queued', 'invocation'])('%s, told only once, waits fifty seconds in all for a busy node and sends again only after a server error, with the same call id', async event => {
    const calls = await bridge(503, true);
    const timer = vi.spyOn(AbortSignal, 'timeout');
    expect(await sendHook(event, '{}')).not.toBeNull();
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map(c => c.call)).size).toBe(1);
    expect(timer.mock.calls).toEqual([[50_000]]);
  });
  it.each([['tool', 10_000], ['tooldone', 10_000], ['toolfail', 10_000], ['status', 3_000], ['unheard', 3_000]] as const)('%s tries once and waits %i ms for a busy node', async (event, ms) => {
    const calls = await bridge(503);
    const timer = vi.spyOn(AbortSignal, 'timeout');
    expect(await sendHook(event, '{}')).toBeNull();
    expect(calls).toHaveLength(1);
    expect(timer.mock.calls).toEqual([[ms]]);
  });
  it.each([
    [{ '*': 600_000, interrupt: 3_000, end: 3_000 }, { interrupt: 2_500, end: 2_500, stop: 50_000, tool: 10_000 }],
    [{ '*': 30_000 }, { stop: 25_000, prompt: 25_000, tool: 10_000, status: 3_000 }],
    [{ '*': 60_000 }, { stop: 50_000, end: 50_000 }],
    ['not json', { stop: 50_000 }],
  ])('waits less than the program that runs it lets a hook run, as the node tells it: %j', async (limits, waits) => {
    await bridge(200);
    vi.stubEnv('HH_HOOK_LIMITS', typeof limits === 'string' ? limits : JSON.stringify(limits));
    const timer = vi.spyOn(AbortSignal, 'timeout');
    for (const event of Object.keys(waits)) await sendHook(event, '{}');
    expect(timer.mock.calls).toEqual(Object.values(waits).map(ms => [ms]));
  });
});
