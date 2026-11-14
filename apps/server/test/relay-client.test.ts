import { createServer, type RequestListener } from 'node:http';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ApiError } from '../src/errors.js';
import { Relay, type SyncPost } from '../src/modules/link/relay.js';
import { fakeRelay } from './fake-relay.js';

const CLIENT = 'acme-aaaaaaaa-link';

/* A fake relay with a binding for acme, and a client of Hornhoof's that talks to it with that binding's key. */
async function acme() {
  const fake = await fakeRelay();
  const relay = new Relay(fake.url);
  const bound = await relay.bind('acme');
  return { fake, relay, key: bound.key };
}

const post = (over: Partial<SyncPost> = {}): SyncPost => ({ client: CLIENT, generation: 1, state: 'on', copy: 'copy-1', epoch: 1, ...over });

const failure = async (call: Promise<unknown>) => call.then(() => null, (error: unknown) => error);

describe('reading a route', () => {
  it('reads a held route and an empty one', async () => {
    const { fake, relay, key } = await acme();
    fake.register('acme', CLIENT);
    expect(await relay.route('acme', key)).toMatchObject({ known: true, state: 'held', client: CLIENT, generation: 1 });
    fake.drop('acme');
    expect(await relay.route('acme', key)).toMatchObject({ known: true, state: 'empty', client: CLIENT, generation: 1 });
  });

  it('reads anything else as unknown, never as empty', async () => {
    const { fake, relay, key } = await acme();
    fake.frpsDown = true;
    expect(await relay.route('acme', key)).toEqual({ known: false, why: 'refused' });
    fake.frpsDown = false;
    expect(await relay.route('acme', 'a-wrong-key-of-some-length')).toEqual({ known: false, why: 'refused' });
    fake.routeAnswer = 'garbage';
    expect(await relay.route('acme', key)).toEqual({ known: false, why: 'malformed' });
    fake.routeAnswer = 'badstate';
    expect(await relay.route('acme', key)).toEqual({ known: false, why: 'malformed' });
    fake.routeAnswer = 'hang';
    expect(await afterTimeout(200, () => relay.route('acme', key, 200))).toEqual({ known: false, why: 'slow' });
    expect(await new Relay('http://127.0.0.1:1').route('acme', key)).toEqual({ known: false, why: 'unreachable' });
  });

  it('takes an extra field in a route answer', async () => {
    const { fake, relay, key } = await acme();
    fake.routeAnswer = 'extra';
    expect(await relay.route('acme', key)).toMatchObject({ known: true });
  });
});

describe('posting the sync record', () => {
  it('posts the sync record as the holder', async () => {
    const { fake, relay, key } = await acme();
    fake.register('acme', CLIENT);
    const result = await relay.setSync('acme', key, post());
    expect(result).toMatchObject({ stored: true, sync: { state: 'on', copy: 'copy-1', epoch: 1, generation: 1 } });
    const route = await relay.route('acme', key);
    expect(route.known && route.sync).toEqual(result.stored && result.sync);
    expect(await relay.setSync('acme', key, post())).toEqual({ stored: false, why: 'stale_epoch', status: 409, error: 'stale_epoch' });
    expect(await relay.setSync('acme', key, post({ client: 'acme-bbbbbbbb-link', epoch: 2 }))).toEqual({ stored: false, why: 'not_holder', status: 409, error: 'not_holder' });
    fake.frpsDown = true;
    expect(await relay.setSync('acme', key, post({ epoch: 3 }))).toEqual({ stored: false, why: 'refused', status: 503, error: 'unknown' });
  });

  it('fails closed inside its time budget when the relay is slow', async () => {
    const slow = await slowAnswer({ sync: { state: 'on', copy: 'copy-1', epoch: 1, generation: 1, at: 100 } }, 1000);
    const relay = new Relay(slow.url);
    expect(await afterTimeout(100, () => relay.setSync('acme', 'k'.repeat(20), post(), 100), slow.arrived)).toEqual({ stored: false, why: 'slow' });
  });

  it('distinguishes a refused status from an unreachable relay', async () => {
    const { fake, relay, key } = await acme();
    fake.down = true;
    expect(await relay.setSync('acme', key, post())).toEqual({ stored: false, why: 'refused', status: 502, error: null });
    expect(await new Relay('http://127.0.0.1:1').setSync('acme', key, post())).toEqual({ stored: false, why: 'unreachable' });
  });
});

describe('reading a sync answer that is not what was posted', () => {
  const stored = { state: 'on', copy: 'copy-1', epoch: 1, generation: 1, at: 100 };

  it('stores nothing when one field of the answer differs from the post', async () => {
    const changes = [{ state: 'off' }, { copy: 'copy-2' }, { epoch: 2 }, { generation: 2 }];
    for (const change of changes) {
      const relay = new Relay(await oneAnswer({ sync: { ...stored, ...change } }));
      expect(await relay.setSync('acme', 'k'.repeat(20), post()), JSON.stringify(change)).toEqual({ stored: false, why: 'mismatch' });
    }
    expect(await new Relay(await oneAnswer({ sync: stored })).setSync('acme', 'k'.repeat(20), post())).toEqual({ stored: true, sync: stored });
  });

  it('stores nothing from a 200 that is not a sync record', async () => {
    for (const body of [{}, { sync: { state: 'on' } }, { sync: { ...stored, at: -1 } }]) {
      expect(await new Relay(await oneAnswer(body)).setSync('acme', 'k'.repeat(20), post())).toEqual({ stored: false, why: 'malformed' });
    }
  });

  it('reads a 409 that names nothing known, or has no body, as refused with its status', async () => {
    expect(await new Relay(await oneAnswer({ error: 'something_else' }, 409)).setSync('acme', 'k'.repeat(20), post())).toEqual({
      stored: false,
      why: 'refused',
      status: 409,
      error: 'something_else',
    });
    expect(await new Relay(await oneAnswer('not json', 409)).setSync('acme', 'k'.repeat(20), post())).toEqual({
      stored: false,
      why: 'refused',
      status: 409,
      error: null,
    });
  });
});

describe('an answer whose body breaks', () => {
  it('reads a body that stalls as slow and one that is cut off as unreachable', async () => {
    const key = 'k'.repeat(20);
    const stall = await brokenBody('stall');
    expect(await afterTimeout(200, () => new Relay(stall.url).route('acme', key, 200), stall.arrived)).toEqual({ known: false, why: 'slow' });
    const cut = await brokenBody('cut');
    expect(await new Relay(cut.url).route('acme', key)).toEqual({ known: false, why: 'unreachable' });
  });
});

describe('the route fields', () => {
  const answer = { state: 'held', client: CLIENT, since: 100, generation: 3, relayStarted: 90, evictionBound: 30, sync: { state: 'off', copy: null, epoch: 0, generation: 0, at: null } };

  it('reads every field of the answer as it came', async () => {
    expect(await new Relay(await oneAnswer(answer)).route('acme', 'k'.repeat(20))).toEqual({ known: true, ...answer });
  });

  it('reads a bad value in any field as malformed', async () => {
    const spoiled: object[] = [
      { since: -1 }, { since: 'x' }, { since: null }, { generation: 1.5 }, { relayStarted: -3 }, { evictionBound: '30' }, { client: 7 },
      { sync: undefined }, { sync: { ...answer.sync, state: 'maybe' } }, { sync: { ...answer.sync, epoch: -1 } }, { sync: { ...answer.sync, copy: 5 } },
    ];
    for (const change of spoiled) {
      const relay = new Relay(await oneAnswer({ ...answer, ...change }));
      expect(await relay.route('acme', 'k'.repeat(20)), JSON.stringify(change)).toEqual({ known: false, why: 'malformed' });
    }
  });

  it('reads a binding nobody registered yet as empty at generation 0', async () => {
    const { relay, key } = await acme();
    expect(await relay.route('acme', key)).toMatchObject({ known: true, state: 'empty', client: null, generation: 0 });
  });
});

describe('health', () => {
  it('tells relay health', async () => {
    const { fake, relay } = await acme();
    fake.passthrough = true;
    expect(await relay.health()).toEqual({ up: true, relayStarted: fake.relayStarted, passthrough: true });
    fake.passthrough = false;
    expect(await relay.health()).toEqual({ up: true, relayStarted: fake.relayStarted, passthrough: false });
    fake.frpsDown = true;
    expect(await relay.health()).toEqual({ up: false, relayStarted: null, passthrough: false });
    fake.frpsDown = false;
    fake.down = true;
    expect(await relay.health()).toEqual({ up: false, relayStarted: null, passthrough: false });
  });

  it('reads a relay from before Task 9, with no passthrough field, as not passing through', async () => {
    const old = new Relay(await oneAnswer({ ok: true, frps: true, relayStarted: 5 }));
    expect(await old.health()).toEqual({ up: true, relayStarted: 5, passthrough: false });
  });

  it('reads a malformed or slow health answer as down', async () => {
    expect(await new Relay(await oneAnswer({ ok: true, frps: true, relayStarted: 'now' })).health()).toEqual({ up: false, relayStarted: null, passthrough: false });
    const slow = await slowAnswer({ ok: true, frps: true, relayStarted: 5 }, 300);
    expect(await afterTimeout(100, () => new Relay(slow.url).health(100), slow.arrived)).toEqual({ up: false, relayStarted: null, passthrough: false });
  });
});

describe('changing keys', () => {
  it('changes the key and gets a visitor key', async () => {
    const { fake, relay, key } = await acme();
    const fresh = await relay.changeKey('acme', key);
    expect(fresh === fake.bindings.get('acme')?.key, 'the fresh key is the one the relay holds').toBe(true);
    expect(fresh !== key, 'the key changed').toBe(true);
    expect(await relay.route('acme', key)).toEqual({ known: false, why: 'refused' });
    expect((await relay.route('acme', fresh)).known, 'the fresh key reads a route').toBe(true);
    expect((await relay.visitorKey('acme', fresh)) === fake.visitorKeys.get('acme'), 'the visitor key is the one the relay holds').toBe(true);
    fake.down = true;
    for (const call of [() => relay.changeKey('acme', fresh), () => relay.visitorKey('acme', fresh)]) {
      const error = await failure(call());
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).reason).toBe('relay_unreachable');
    }
  });

  it('sets the key it is given', async () => {
    const { fake, relay, key } = await acme();
    const next = 'n'.repeat(43);
    expect(await relay.changeKey('acme', key, next)).toBe(next);
    expect(fake.bindings.get('acme')?.key).toBe(next);
    expect(await relay.route('acme', key)).toEqual({ known: false, why: 'refused' });
    expect((await relay.route('acme', next)).known).toBe(true);
    /* A key the relay does not take leaves the one it has. */
    for (const bad of ['n'.repeat(42), next]) {
      expect((await failure(relay.changeKey('acme', next, bad)) as ApiError).reason, bad).toBe('relay_unreachable');
      expect(fake.bindings.get('acme')?.key).toBe(next);
    }
    /* An answer lost on the way reads as no answer, and the relay holds the new key. */
    fake.loseAnswer = true;
    const other = 'o'.repeat(43);
    expect((await failure(relay.changeKey('acme', next, other)) as ApiError).reason).toBe('relay_unreachable');
    expect((await relay.route('acme', other)).known).toBe(true);
  });

  it('refuses a key answer that is not a key', async () => {
    const error = await failure(new Relay(await oneAnswer({ key: 5 })).changeKey('acme', 'k'.repeat(20)));
    expect((error as ApiError).reason).toBe('relay_unreachable');
  });
});

describe('key calls that fail', () => {
  const key = 'k'.repeat(20);
  const reasonOf = async (call: Promise<unknown>) => ((await failure(call)) as ApiError).reason;

  it('tells a busy relay from an unreachable one', async () => {
    const busy = new Relay(await oneAnswer({}, 429));
    for (const call of [() => busy.changeKey('acme', key), () => busy.visitorKey('acme', key)]) {
      const error = (await failure(call())) as ApiError;
      expect([error.status, error.code]).toEqual([429, 'too_many']);
    }
  });

  it('keeps a refused key and an unknown name as relay_unreachable, as bind does', async () => {
    for (const status of [401, 404, 500]) {
      const relay = new Relay(await oneAnswer({ error: 'no' }, status));
      expect(await reasonOf(relay.changeKey('acme', key)), String(status)).toBe('relay_unreachable');
      expect(await reasonOf(relay.visitorKey('acme', key)), String(status)).toBe('relay_unreachable');
    }
  });

  it('refuses a visitor key answer that is missing, short or not text', async () => {
    for (const body of [{}, { visitorKey: 'short' }, { visitorKey: 5 }, { key: 'k'.repeat(20) }]) {
      expect(await reasonOf(new Relay(await oneAnswer(body)).visitorKey('acme', key)), JSON.stringify(body)).toBe('relay_unreachable');
    }
  });

  it('refuses a key answer that is short', async () => {
    expect(await reasonOf(new Relay(await oneAnswer({ key: 'short' })).changeKey('acme', key))).toBe('relay_unreachable');
  });
});

describe('the key stays out of results and errors', () => {
  it('never puts the key in a result or an error', async () => {
    const { fake, relay, key } = await acme();
    fake.register('acme', CLIENT);
    const shown = (value: unknown) => JSON.stringify(value instanceof Error ? { ...value, message: value.message } : value);
    const results: unknown[] = [await relay.route('acme', key), await relay.setSync('acme', key, post()), await relay.setSync('acme', key, post())];
    fake.routeAnswer = 'garbage';
    results.push(await relay.route('acme', key));
    fake.routeAnswer = 'contract';
    results.push(await relay.visitorKey('acme', key));
    fake.frpsDown = true;
    results.push(await relay.route('acme', key), await relay.setSync('acme', key, post({ epoch: 9 })));
    fake.frpsDown = false;
    fake.down = true;
    results.push(await failure(relay.visitorKey('acme', key)), await failure(relay.changeKey('acme', key)));
    fake.down = false;
    fake.routeAnswer = 'hang';
    results.push(await afterTimeout(100, () => relay.route('acme', key, 100)));
    const closed = new Relay('http://127.0.0.1:1');
    results.push(await closed.route('acme', key), await closed.setSync('acme', key, post()), await failure(closed.changeKey('acme', key)));
    results.push(await new Relay(await oneAnswer({ error: key }, 503)).setSync('acme', key, post()));
    results.push(await relay.changeKey('acme', key));
    expect(results.every(result => !shown(result).includes(key))).toBe(true);
  });
});

/* Runs one relay call on controlled timers, checking that it stays pending at budgetMs - 1 and aborts at budgetMs. */
async function afterTimeout<T>(budgetMs: number, startCall: () => Promise<T>, arrived?: Promise<void>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms);
    timer.unref?.();
    return abort.signal;
  });
  try {
    const pending = startCall();
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    if (arrived) await arrived;
    await vi.advanceTimersByTimeAsync(budgetMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    return await pending;
  } finally {
    timeoutSpy.mockRestore();
    vi.useRealTimers();
  }
}

/* A local server that answers every request with the handler, and is shut down with the test. */
async function stubServer(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

/* A relay that gives one fixed answer to every call at once. */
function oneAnswer(body: object | string, status = 200): Promise<string> {
  return stubServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

/* A relay that schedules its answer on the test's controlled clock after pauseMs, signalling once the request arrives. */
async function slowAnswer(body: object | string, pauseMs: number, status = 200): Promise<{ url: string; arrived: Promise<void> }> {
  let markArrived!: () => void;
  const arrived = new Promise<void>(resolve => {
    markArrived = resolve;
  });
  const timers = new Set<NodeJS.Timeout>();
  onTestFinished(() => timers.forEach(clearTimeout));
  const url = await stubServer((_req, res) => {
    timers.add(setTimeout(() => res.writeHead(status, { 'content-type': 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body)), pauseMs));
    markArrived();
  });
  return { url, arrived };
}

/* A relay that sends a 200 and then stalls in the middle of its body, or cuts the connection once that fragment flushes. */
async function brokenBody(mode: 'stall' | 'cut'): Promise<{ url: string; arrived: Promise<void> }> {
  let markArrived!: () => void;
  const arrived = new Promise<void>(resolve => {
    markArrived = resolve;
  });
  const url = await stubServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"state":', () => {
      if (mode === 'cut') req.socket.destroy();
      markArrived();
    });
  });
  return { url, arrived };
}
