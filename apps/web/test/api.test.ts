import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiFailure, newRequestId, RETRY_FOR_MS } from '../src/api';

type Step = (() => Response | Promise<Response>) | Response;

/* The page's own crypto, before a test puts another in its place. */
const realCrypto = globalThis.crypto;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const json = (status: number, data: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const refused = (status: number, reason: string, headers: Record<string, string> = {}) => json(status, { error: { code: 'unavailable', message: 'x', reason } }, headers);
const unreachable = (): Response => {
  throw new TypeError('Failed to fetch');
};
/* An answer whose body breaks off before its JSON ends. */
const cutShort = () => new Response('{"note":{"numb', { status: 200, headers: { 'content-type': 'application/json' } });
/* An answer whose body the browser stops reading, as Firefox does when the page reloads while it comes. */
const aborted = (status = 200) => () =>
  new Response(new ReadableStream({ start: c => c.error(new DOMException('The operation was aborted.', 'AbortError')) }), { status, headers: { 'content-type': 'application/json' } });

/* Answers each call with the next step, and the last step for every call after it. */
function fetchAnswering(...steps: Step[]) {
  const keys: (string | null)[] = [];
  const calls = vi.fn(async (_path: string, init: RequestInit = {}) => {
    keys.push(new Headers(init.headers).get('idempotency-key'));
    const step = steps[Math.min(keys.length, steps.length) - 1]!;
    return typeof step === 'function' ? step() : step.clone();
  });
  vi.stubGlobal('fetch', calls);
  return { calls, keys };
}

/* What the call ended as, once every wait it asks for has passed. */
async function settled<T>(call: Promise<T>): Promise<{ value: T } | { failure: ApiFailure }> {
  const outcome = call.then(value => ({ value }), (failure: ApiFailure) => ({ failure }));
  await vi.runAllTimersAsync();
  return outcome;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a change sent from the page', () => {
  it('sends one request id with a change and keeps it on every try', async () => {
    const { calls, keys } = fetchAnswering(unreachable, refused(503, 'starting', { 'retry-after': '1' }), json(200, { ok: 3 }));
    expect(await settled(api.post('/api/notebook', { text: 'x' }))).toEqual({ value: { ok: 3 } });
    expect(calls).toHaveBeenCalledTimes(3);
    expect(keys[0]).toMatch(UUID_V4);
    expect(new Set(keys).size).toBe(1);
  });

  it('gives every change an id of its own', async () => {
    const { keys } = fetchAnswering(json(200, {}));
    await settled(api.post('/api/notebook', { text: 'x' }));
    await settled(api.patch('/api/notebook/1', { text: 'y' }));
    await settled(api.put('/api/link', { name: 'acme' }));
    await settled(api.del('/api/notebook/1'));
    expect(keys.every(key => UUID_V4.test(key ?? ''))).toBe(true);
    expect(new Set(keys).size).toBe(4);
  });

  it('treats an answer cut short as lost, and an answer with no body as whole', async () => {
    const lost = fetchAnswering(cutShort, json(200, { ok: true }));
    expect(await settled(api.post('/api/notebook', { text: 'x' }))).toEqual({ value: { ok: true } });
    expect(lost.calls).toHaveBeenCalledTimes(2);
    expect(new Set(lost.keys).size).toBe(1);

    const empty = fetchAnswering(new Response(null, { status: 202 }));
    expect(await settled(api.post('/api/agents/a1/stop'))).toEqual({ value: null });
    expect(empty.calls).toHaveBeenCalledTimes(1);
  });

  it('gives up a minute after the first failure, and not before', async () => {
    const { calls } = fetchAnswering(unreachable);
    let failed: ApiFailure | undefined;
    void api.post('/api/notebook', { text: 'x' }).catch((err: ApiFailure) => (failed = err));
    await vi.advanceTimersByTimeAsync(RETRY_FOR_MS - 2001);
    expect(failed).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2001);
    expect(failed).toMatchObject({ status: 0, code: 'network' });
    const tries = calls.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RETRY_FOR_MS);
    expect(calls).toHaveBeenCalledTimes(tries);
  });

  it('does not send again what the server refused', async () => {
    for (const [status, reason] of [[503, 'maintenance'], [503, 'read_only'], [409, 'already_done'], [400, 'attachment_invalid']] as const) {
      const { calls } = fetchAnswering(refused(status, reason));
      expect(await settled(api.post('/api/notebook', { text: 'x' }))).toMatchObject({ failure: { status, reason } });
      expect(calls, reason).toHaveBeenCalledTimes(1);
    }
  });

  it('sends a change again that was not confirmed, or that met a hop with no answer of its own', async () => {
    const unconfirmed = fetchAnswering(refused(503, 'not_confirmed'), json(200, { ok: true }));
    expect(await settled(api.post('/api/notebook', { text: 'x' }))).toEqual({ value: { ok: true } });
    expect(new Set(unconfirmed.keys).size).toBe(1);

    const bare = fetchAnswering(new Response('Bad Gateway', { status: 502 }), json(200, { ok: true }));
    expect(await settled(api.post('/api/notebook', { text: 'x' }))).toEqual({ value: { ok: true } });
    expect(bare.calls).toHaveBeenCalledTimes(2);
  });

  it('waits as long as the server asks, within one to ten seconds, and two when it does not say', async () => {
    const waits = async (header: Record<string, string>): Promise<number> => {
      const { calls } = fetchAnswering(refused(503, 'starting', header), json(200, {}));
      const call = api.post('/api/notebook', { text: 'x' });
      let waited = 0;
      while (calls.mock.calls.length < 2) {
        await vi.advanceTimersByTimeAsync(500);
        waited += 500;
      }
      await call;
      return waited;
    };
    expect(await waits({ 'retry-after': '5' })).toBe(5000);
    expect(await waits({ 'retry-after': '0' })).toBe(1000);
    expect(await waits({ 'retry-after': '600' })).toBe(10_000);
    expect(await waits({})).toBe(2000);
  });
});

describe('a read from the page', () => {
  it('carries no request id and is tried once', async () => {
    const { calls, keys } = fetchAnswering(unreachable);
    expect(await settled(api.get('/api/org'))).toMatchObject({ failure: { status: 0, code: 'network' } });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(keys).toEqual([null]);
  });

  /* A body that never came whole is no answer: the read fails as one that met no server, never with null for data. */
  it('fails a read whose answer breaks off as one that met no server, once, and keeps an answer with no body whole', async () => {
    for (const broken of [aborted(), cutShort]) {
      const { calls } = fetchAnswering(broken);
      expect(await settled(api.get('/api/feedback'))).toMatchObject({ failure: { status: 0, code: 'network' } });
      expect(calls).toHaveBeenCalledTimes(1);
    }
    fetchAnswering(new Response(null, { status: 200 }));
    expect(await settled(api.get('/api/map/layout'))).toEqual({ value: null });
    fetchAnswering(new Response(null, { status: 204 }));
    expect(await settled(api.get('/api/map/layout'))).toEqual({ value: undefined });
  });

  it('fails a file sent whole as one that met no server when its answer breaks off', async () => {
    fetchAnswering(aborted());
    expect(await settled(api.upload('/api/agents/a1/pictures?name=a.png', new Blob(['x'])))).toMatchObject({ failure: { status: 0, code: 'network' } });
    fetchAnswering(cutShort);
    expect(await settled(api.putFile('/api/recovery/bundles/b1?code=c', new Blob(['x'])))).toMatchObject({ failure: { status: 0, code: 'network' } });
  });

  it('keeps the status of a refusal whose words break off', async () => {
    fetchAnswering(aborted(503));
    expect(await settled(api.get('/api/org'))).toMatchObject({ failure: { status: 503, code: 'internal' } });
  });
});

describe('newRequestId', () => {
  it('makes a v4 uuid without randomUUID, which a page on plain http lacks', () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => realCrypto.getRandomValues(bytes) });
    const ids = [newRequestId(), newRequestId()];
    expect(ids[0]).toMatch(UUID_V4);
    expect(ids[1]).toMatch(UUID_V4);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
