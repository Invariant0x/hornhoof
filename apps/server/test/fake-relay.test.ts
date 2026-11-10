import { describe, expect, it } from 'vitest';
import { fakeRelay, type FakeRelay } from './fake-relay.js';

/* The tests of the fake relay itself: each one is named by its row in the relay contract table (plan 1), and asserts
   the table's exact bodies, so a drift between the fake and the real relay shows here first. */

const NOT_FOUND = (name: string) => ({ error: 'not_found', message: `There is no binding ${name}.` });
const UNAUTHORIZED = { error: 'unauthorized', message: 'Send the binding key as Authorization: Bearer <key>.' };
const UNKNOWN = { error: 'unknown', message: 'The relay cannot tell whether the route is live.' };
const NO_SYNC = { state: 'off', copy: null, epoch: 0, generation: 0, at: null };

type Options = { key?: string; body?: unknown };

async function call(relay: FakeRelay, method: string, path: string, { key, body }: Options = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (key) headers.authorization = `Bearer ${key}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${relay.url}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const route = (relay: FakeRelay, name: string, key = 'k') => call(relay, 'GET', `/links/${name}/route`, { key });
const sync = (relay: FakeRelay, name: string, body: unknown, key = 'k') => call(relay, 'POST', `/links/${name}/sync`, { key, body });

async function relayWithBinding(name = 'acme', key = 'k'): Promise<FakeRelay> {
  const relay = await fakeRelay();
  relay.bindings.set(name, { key });
  return relay;
}

describe('the fake relay keeps the contract', () => {
  it('R1.1 refuses a second registration of a held name', async () => {
    const relay = await relayWithBinding();
    expect(relay.register('acme', 'acme-aaaaaaaa-link')).toEqual({ ok: true, generation: 1 });
    expect(relay.register('acme', 'acme-bbbbbbbb-link')).toEqual({ ok: false, reason: 'router config conflict' });
    expect((await route(relay, 'acme')).body).toMatchObject({ state: 'held', client: 'acme-aaaaaaaa-link', generation: 1 });
  });

  it('R1.3 refuses a second live login with one client id', async () => {
    const relay = await fakeRelay();
    expect(relay.register('acme', 'acme-aaaaaaaa-link').ok).toBe(true);
    expect(relay.register('globex', 'acme-aaaaaaaa-link')).toEqual({ ok: false, reason: 'already online' });
    relay.drop('acme');
    expect(relay.register('globex', 'acme-aaaaaaaa-link')).toEqual({ ok: true, generation: 1 });
  });

  it('R1.3 meets a busy client id at login, before the name is looked at', async () => {
    const relay = await fakeRelay();
    relay.register('acme', 'acme-aaaaaaaa-link');
    expect(relay.register('acme', 'acme-aaaaaaaa-link')).toEqual({ ok: false, reason: 'already online' });
  });

  it('R1.4 lets two companies of one machine in side by side', async () => {
    const relay = await fakeRelay();
    expect(relay.register('acme', 'acme-aaaaaaaa-link').ok).toBe(true);
    expect(relay.register('globex', 'globex-aaaaaaaa-link').ok).toBe(true);
    expect([relay.routes.get('acme')?.state, relay.routes.get('globex')?.state]).toEqual(['held', 'held']);
  });

  it('R2.1 tells the holder, since and generation', async () => {
    const relay = await relayWithBinding();
    relay.relayStarted = 1_700_000_000;
    const before = Math.floor(Date.now() / 1000);
    relay.register('acme', 'acme-aaaaaaaa-link');
    const { status, body } = await route(relay, 'acme');
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['client', 'evictionBound', 'generation', 'relayStarted', 'since', 'state', 'sync']);
    expect(body).toMatchObject({ state: 'held', client: 'acme-aaaaaaaa-link', generation: 1, relayStarted: 1_700_000_000, evictionBound: 30, sync: NO_SYNC });
    expect(body.since).toBeGreaterThanOrEqual(before);
  });

  it('R2.1 says empty at generation 0 for a binding nobody registered', async () => {
    const relay = await relayWithBinding();
    const { body } = await route(relay, 'acme');
    expect(body).toMatchObject({ state: 'empty', client: null, since: 0, generation: 0 });
  });

  it('R2.1 gives a name bound through the API the time it was bound', async () => {
    const relay = await fakeRelay();
    const before = Math.floor(Date.now() / 1000);
    const bound = await call(relay, 'POST', '/bindings', { body: { name: 'acme' } });
    const { body } = await route(relay, 'acme', bound.body.key);
    expect(body.since).toBeGreaterThanOrEqual(before);
    expect(body.since).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(body.generation).toBe(0);
    expect(relay.register('acme', 'acme-aaaaaaaa-link')).toEqual({ ok: true, generation: 1 });
  });

  it('R2.2 grows the generation with every registration and keeps it across an frps restart', async () => {
    const relay = await relayWithBinding();
    relay.relayStarted = 1;
    expect(relay.register('acme', 'acme-aaaaaaaa-link')).toEqual({ ok: true, generation: 1 });
    relay.drop('acme');
    expect(relay.register('acme', 'acme-bbbbbbbb-link')).toEqual({ ok: true, generation: 2 });
    relay.restartFrps();
    expect(relay.relayStarted).toBeGreaterThan(1);
    expect((await route(relay, 'acme')).body).toMatchObject({ state: 'empty', client: null, generation: 2 });
    expect(relay.register('acme', 'acme-bbbbbbbb-link')).toEqual({ ok: true, generation: 3 });
  });

  it('R2.3 answers 401, 404 and 503, never an empty it is not sure of', async () => {
    const relay = await relayWithBinding();
    expect(await route(relay, 'acme', 'wrong')).toEqual({ status: 401, body: UNAUTHORIZED });
    expect(await call(relay, 'GET', '/links/acme/route')).toEqual({ status: 401, body: UNAUTHORIZED });
    expect(await route(relay, 'nobody')).toEqual({ status: 404, body: NOT_FOUND('nobody') });
    relay.frpsDown = true;
    expect(await route(relay, 'acme')).toEqual({ status: 503, body: UNKNOWN });
    expect((await route(relay, 'acme', 'wrong')).status).toBe(401);
  });

  it('R2.3 can answer the route badly, for the client that must fail closed', async () => {
    const relay = await relayWithBinding();
    relay.register('acme', 'acme-aaaaaaaa-link');
    relay.routeAnswer = 'garbage';
    const garbage = await fetch(`${relay.url}/api/v1/links/acme/route`, { headers: { authorization: 'Bearer k' } });
    expect(garbage.status).toBe(200);
    await expect(garbage.json()).rejects.toThrow();
    relay.routeAnswer = 'extra';
    expect((await route(relay, 'acme')).body).toMatchObject({ state: 'held', surprise: true });
    relay.routeAnswer = 'badstate';
    expect((await route(relay, 'acme')).body).toMatchObject({ state: 'gone' });
    relay.routeAnswer = 'hang';
    await expect(fetch(`${relay.url}/api/v1/links/acme/route`, { headers: { authorization: 'Bearer k' }, signal: AbortSignal.timeout(150) })).rejects.toThrow();
    relay.routeAnswer = 'contract';
    expect((await route(relay, 'acme')).body.state).toBe('held');
  });

  it('R2.4 takes the sync record only from the holder at its generation with a higher epoch, and reads a missing one as off', async () => {
    const relay = await relayWithBinding();
    relay.register('acme', 'acme-aaaaaaaa-link');
    const record = { client: 'acme-aaaaaaaa-link', generation: 1, state: 'on', copy: 'acme-aaaaaaaa-data', epoch: 5 };
    expect((await route(relay, 'acme')).body.sync).toEqual(NO_SYNC);

    expect(await sync(relay, 'acme', { ...record, client: 'acme-bbbbbbbb-link' })).toEqual({ status: 409, body: { error: 'not_holder' } });
    expect(await sync(relay, 'acme', { ...record, generation: 2 })).toEqual({ status: 409, body: { error: 'not_holder' } });
    expect(await sync(relay, 'acme', record, 'wrong')).toEqual({ status: 401, body: UNAUTHORIZED });
    expect(relay.syncs.has('acme')).toBe(false);

    const taken = await sync(relay, 'acme', record);
    expect(taken.status).toBe(200);
    expect(taken.body).toEqual({ sync: { state: 'on', copy: 'acme-aaaaaaaa-data', epoch: 5, generation: 1, at: expect.any(Number) } });
    expect((await route(relay, 'acme')).body.sync).toEqual(taken.body.sync);

    const stale = await sync(relay, 'acme', { ...record, state: 'off', copy: null, epoch: 5 });
    expect([stale.status, stale.body]).toEqual([409, { error: 'stale_epoch' }]);
    expect((await sync(relay, 'acme', { ...record, state: 'off', copy: null, epoch: 6 })).body.sync).toMatchObject({ state: 'off', copy: null, epoch: 6 });
  });

  it('R2.4 refuses a malformed record, a sync with no holder, and a sync while frps is down', async () => {
    const relay = await relayWithBinding();
    const record = { client: 'acme-aaaaaaaa-link', generation: 1, state: 'on', copy: 'acme-aaaaaaaa-data', epoch: 1 };
    expect(await sync(relay, 'acme', { ...record, extra: 1 })).toEqual({ status: 400, body: { error: 'invalid' } });
    expect((await sync(relay, 'acme', { ...record, epoch: 0 })).status).toBe(400);
    expect((await sync(relay, 'acme', { ...record, state: 'maybe' })).status).toBe(400);
    expect((await sync(relay, 'acme', { ...record, copy: null })).status).toBe(400);
    expect(await sync(relay, 'nobody', record)).toEqual({ status: 404, body: NOT_FOUND('nobody') });
    expect(await sync(relay, 'acme', record)).toEqual({ status: 409, body: { error: 'not_holder' } });
    relay.register('acme', 'acme-aaaaaaaa-link');
    relay.frpsDown = true;
    expect(await sync(relay, 'acme', record)).toEqual({ status: 503, body: UNKNOWN });
    expect(relay.syncs.has('acme')).toBe(false);
  });

  it('R2.4 keeps the sync record across an frps restart, and its epoch still guards the next holder', async () => {
    const relay = await relayWithBinding();
    relay.register('acme', 'acme-aaaaaaaa-link');
    const record = { client: 'acme-aaaaaaaa-link', generation: 1, state: 'on', copy: 'acme-aaaaaaaa-data', epoch: 5 };
    await sync(relay, 'acme', record);
    relay.restartFrps();
    const emptied = await route(relay, 'acme');
    expect(emptied.body).toMatchObject({ state: 'empty', client: null, generation: 1, sync: { state: 'on', epoch: 5, generation: 1 } });
    relay.register('acme', 'acme-aaaaaaaa-link');
    const next = { ...record, generation: 2 };
    expect(await sync(relay, 'acme', { ...next, epoch: 5 })).toEqual({ status: 409, body: { error: 'stale_epoch' } });
    expect((await sync(relay, 'acme', { ...next, epoch: 6 })).status).toBe(200);
  });

  it('R2.4 drops the sync record with the binding, so a name freed and bound again starts with none', async () => {
    const relay = await relayWithBinding();
    relay.register('acme', 'acme-aaaaaaaa-link');
    const record = { client: 'acme-aaaaaaaa-link', generation: 1, state: 'on', copy: 'acme-aaaaaaaa-data', epoch: 5 };
    await sync(relay, 'acme', record);
    await call(relay, 'DELETE', '/bindings/acme', { key: 'k' });
    relay.drop('acme');
    const { key } = (await call(relay, 'POST', '/bindings', { body: { name: 'acme' } })).body;
    expect((await route(relay, 'acme', key)).body.sync).toEqual(NO_SYNC);
    relay.register('acme', 'globex-aaaaaaaa-link');
    const next = { ...record, client: 'globex-aaaaaaaa-link', generation: 2, epoch: 1 };
    expect((await sync(relay, 'acme', next, key)).status).toBe(200);
  });

  it('R3.1 empties the route when the holder is dropped', async () => {
    const relay = await relayWithBinding();
    relay.register('acme', 'acme-aaaaaaaa-link');
    relay.drop('acme');
    expect((await route(relay, 'acme')).body).toMatchObject({ state: 'empty', client: null, generation: 1 });
    expect(relay.register('acme', 'acme-bbbbbbbb-link')).toEqual({ ok: true, generation: 2 });
  });

  it('R3.1 leaves an empty or unknown name as it was when it is dropped again', async () => {
    const relay = await relayWithBinding();
    relay.routes.set('acme', { state: 'empty', client: null, since: 7, generation: 3 });
    relay.drop('acme');
    relay.drop('nobody');
    expect(relay.routes.get('acme')).toEqual({ state: 'empty', client: null, since: 7, generation: 3 });
    expect(relay.routes.has('nobody')).toBe(false);
  });

  it('R4.1 answers health only while frps is up, with passthrough', async () => {
    const relay = await fakeRelay();
    relay.relayStarted = 1_700_000_000;
    expect(await call(relay, 'GET', '/health')).toEqual({ status: 200, body: { ok: true, frps: true, relayStarted: 1_700_000_000, passthrough: true } });
    relay.passthrough = false;
    expect((await call(relay, 'GET', '/health')).body.passthrough).toBe(false);
    relay.frpsDown = true;
    expect(await call(relay, 'GET', '/health')).toEqual({ status: 503, body: { ok: false, frps: false } });
  });

  it('R6.1 changes the key and refuses the old one', async () => {
    const relay = await relayWithBinding();
    relay.register('acme', 'acme-aaaaaaaa-link');
    expect(await call(relay, 'POST', '/links/acme/key', { key: 'wrong' })).toEqual({ status: 401, body: UNAUTHORIZED });
    expect(await call(relay, 'POST', '/links/nobody/key', { key: 'k' })).toEqual({ status: 404, body: NOT_FOUND('nobody') });
    const changed = await call(relay, 'POST', '/links/acme/key', { key: 'k' });
    expect(changed.status).toBe(200);
    expect(Object.keys(changed.body)).toEqual(['key']);
    const fresh: string = changed.body.key;
    expect(fresh.length >= 16 && fresh !== 'k').toBe(true);
    expect((await route(relay, 'acme', 'k')).status).toBe(401);
    expect(await call(relay, 'DELETE', '/bindings/acme', { key: 'k' })).toEqual({ status: 401, body: UNAUTHORIZED });
    expect(await call(relay, 'DELETE', '/bindings/nobody', { key: 'k' })).toEqual({ status: 404, body: NOT_FOUND('nobody') });
    expect((await route(relay, 'acme', fresh)).body.state).toBe('held');
    expect((await call(relay, 'DELETE', '/bindings/acme', { key: fresh })).status).toBe(204);
  });

  it('R6.2 hands out a visitor key and replaces it', async () => {
    const relay = await relayWithBinding();
    expect(await call(relay, 'POST', '/links/acme/visitor-key', { key: 'wrong' })).toEqual({ status: 401, body: UNAUTHORIZED });
    expect(await call(relay, 'POST', '/links/nobody/visitor-key', { key: 'k' })).toEqual({ status: 404, body: NOT_FOUND('nobody') });
    const first = await call(relay, 'POST', '/links/acme/visitor-key', { key: 'k' });
    expect([first.status, Object.keys(first.body)]).toEqual([200, ['visitorKey']]);
    expect(typeof first.body.visitorKey === 'string' && first.body.visitorKey.length >= 16).toBe(true);
    expect(relay.visitorKeys.get('acme') === first.body.visitorKey).toBe(true);
    const second = await call(relay, 'POST', '/links/acme/visitor-key', { key: 'k' });
    expect(second.body.visitorKey !== first.body.visitorKey).toBe(true);
    expect(relay.visitorKeys.get('acme') === second.body.visitorKey).toBe(true);
    expect((await route(relay, 'acme')).status).toBe(200);
  });

  it('R6.2 drops the visitor key with the binding', async () => {
    const relay = await relayWithBinding();
    await call(relay, 'POST', '/links/acme/visitor-key', { key: 'k' });
    await call(relay, 'DELETE', '/bindings/acme', { key: 'k' });
    expect(relay.visitorKeys.has('acme')).toBe(false);
  });

  it('R1.5 keeps a freed name until its old tunnel is gone', async () => {
    const relay = await relayWithBinding();
    relay.register('acme', 'acme-aaaaaaaa-link');
    expect((await call(relay, 'DELETE', '/bindings/acme', { key: 'k' })).status).toBe(204);
    expect((await call(relay, 'GET', '/names/acme')).body).toEqual({ name: 'acme', free: false, reason: 'taken' });
    const refused = await call(relay, 'POST', '/bindings', { body: { name: 'acme' } });
    expect([refused.status, refused.body.error]).toEqual([409, 'taken']);
    relay.drop('acme');
    expect((await call(relay, 'GET', '/names/acme')).body).toEqual({ name: 'acme', free: true });
    expect((await call(relay, 'POST', '/bindings', { body: { name: 'acme' } })).status).toBe(201);
  });

  it('R1.5 binds a random name when the post has no body at all, even while frps is down', async () => {
    const relay = await fakeRelay();
    relay.frpsDown = true;
    const bound = await call(relay, 'POST', '/bindings');
    expect([bound.status, relay.bindings.has(bound.body.name)]).toEqual([201, true]);
  });

  it('R1.5 answers 503 for a requested name while frps is down, and never makes a random name wait', async () => {
    const relay = await relayWithBinding();
    relay.frpsDown = true;
    expect(await call(relay, 'GET', '/names/globex')).toEqual({ status: 503, body: UNKNOWN });
    expect(await call(relay, 'POST', '/bindings', { body: { name: 'globex' } })).toEqual({ status: 503, body: UNKNOWN });
    expect((await call(relay, 'GET', '/names/acme')).body.reason).toBe('taken');
    expect((await call(relay, 'GET', '/names/www')).body.reason).toBe('reserved');
    expect((await call(relay, 'GET', '/names/-bad')).body.reason).toBe('invalid');
    expect((await call(relay, 'POST', '/bindings', { body: {} })).status).toBe(201);
    relay.frpsDown = false;
    expect((await call(relay, 'GET', '/names/globex')).body.free).toBe(true);
  });
});
