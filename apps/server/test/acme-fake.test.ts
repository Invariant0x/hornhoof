import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as acme from 'acme-client';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { AcmeAccount, AcmeError, type ChallengeHooks, LETS_ENCRYPT, newAccountKey, problemOf, retryAfterSeconds } from '../src/modules/tls/acme.js';
import { selfSigned } from '../src/modules/tls/x509.js';
import { closedPort } from './closed-port.js';

const RATE_LIMITED = 'urn:ietf:params:acme:error:rateLimited';
const BAD_NONCE = 'urn:ietf:params:acme:error:badNonce';
const CONNECTION = 'urn:ietf:params:acme:error:connection';
const SERVER_INTERNAL = 'urn:ietf:params:acme:error:serverInternal';
const QUICK = { backoff: { attempts: 3, min: 50, max: 50 } };
const HOST = 'acme.test';
const TOKEN = 'tok-1';
const PKCS8_PEM = '-----BEGIN PRIVATE KEY-----';
const CHALLENGE_ANSWER = `/.well-known/acme-challenge/${TOKEN}`;

type Reply = { status?: number; headers?: Record<string, string>; body?: unknown; text?: string };
type Handler = (base: string) => Reply;

// A JWS body's payload, read without checking its signature, which is all this fake needs of a request.
function payloadOf(raw: string): Record<string, unknown> {
  if (!raw) return {};
  const { payload } = JSON.parse(raw) as { payload?: string };
  return payload ? (JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>) : {};
}

function send(res: ServerResponse, reply: Reply): void {
  const type = reply.text === undefined ? 'application/json' : 'text/plain';
  res.writeHead(reply.status ?? 200, { 'content-type': type, 'replay-nonce': 'fake-nonce', ...reply.headers });
  if (reply.text !== undefined) res.end(reply.text);
  else res.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// An ACME server on a local port: a directory, nonces, and whatever else the test gives it. It checks no signature.
async function fakeAcme(routes: Record<string, Handler>) {
  const seen: { path: string; payload: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const path = req.url ?? '';
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      if (path === '/dir') return send(res, routes[path]?.(base) ?? { body: { newNonce: `${base}/nonce`, newAccount: `${base}/new-account`, newOrder: `${base}/new-order` } });
      if (path === '/nonce') return send(res, {});
      seen.push({ path, payload: payloadOf(raw) });
      return send(res, routes[path]?.(base) ?? { status: 404, text: 'not here' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { port } = server.address() as AddressInfo;
  const requests = (path: string) => seen.filter((request) => request.path === path);
  return {
    directoryUrl: `http://127.0.0.1:${port}/dir`,
    accountUrl: `http://127.0.0.1:${port}/account/1`,
    port,
    paths: () => seen.map((request) => request.path),
    hits: (path: string) => requests(path).length,
    payloads: (path: string) => requests(path).map((request) => request.payload),
  };
}

const problem = (status: number, type: string, detail: string, headers: Record<string, string> = {}): Reply => ({
  status,
  headers: { 'content-type': 'application/problem+json', ...headers },
  body: { type, detail },
});

const accountMade: Handler = (base) => ({ status: 201, headers: { location: `${base}/account/1` }, body: { status: 'valid' } });

const orderBody = (base: string, status: string, more: Record<string, unknown> = {}) => ({
  status,
  identifiers: [{ type: 'dns', value: HOST }],
  finalize: `${base}/finalize`,
  ...more,
});

const orderAt = (base: string, status: string, more: Record<string, unknown> = {}): Reply => ({
  status: 201,
  headers: { location: `${base}/order/1` },
  body: orderBody(base, status, more),
});

const chainAnswer = (chain: string): Handler => () => ({ headers: { 'content-type': 'application/pem-certificate-chain' }, text: chain });

// An order that needs no proof and is valid as soon as it is finalized.
const readyOrder = (chain: string): Record<string, Handler> => ({
  '/new-account': accountMade,
  '/new-order': (base) => orderAt(base, 'ready'),
  '/finalize': (base) => ({ body: orderBody(base, 'valid', { certificate: `${base}/cert` }) }),
  '/cert': chainAnswer(chain),
});

// An authorization whose http-01 challenge stands as the test says; the self-check asks the host it names.
function authorization(base: string, status: string, failure?: unknown): Reply {
  const challenge = { type: 'http-01', url: `${base}/challenge/1`, token: TOKEN, status, error: failure };
  return { body: { status, identifier: { type: 'dns', value: '127.0.0.1' }, challenges: [challenge] } };
}

// An order with one authorization to prove, and the certificate at the end of it.
function orderToProve(chain: string, authz: Handler, more: Record<string, Handler> = {}): Record<string, Handler> {
  const authorizations = (base: string) => ({ authorizations: [`${base}/authz/1`] });
  return {
    '/new-account': accountMade,
    '/new-order': (base) => orderAt(base, 'pending', authorizations(base)),
    '/authz/1': authz,
    '/challenge/1': () => ({ body: { status: 'processing' } }),
    '/finalize': (base) => ({ body: orderBody(base, 'processing', authorizations(base)) }),
    '/order/1': (base) => ({ body: orderBody(base, 'valid', { ...authorizations(base), certificate: `${base}/cert` }) }),
    '/cert': chainAnswer(chain),
    ...more,
  };
}

function recordingHooks() {
  const calls: string[] = [];
  const answers = new Map<string, string>();
  const hooks: ChallengeHooks = {
    answer: (token, keyAuthorization) => {
      calls.push(`answer ${token}`);
      answers.set(token, keyAuthorization);
    },
    forget: (token) => {
      calls.push(`forget ${token}`);
      answers.delete(token);
    },
  };
  return { hooks, calls, answers };
}

const ANSWERED_AND_FORGOTTEN = [`answer ${TOKEN}`, `forget ${TOKEN}`];

async function newAccountOn(fake: { directoryUrl: string }, opts: { backoff?: { attempts: number; min: number; max: number } } = QUICK): Promise<AcmeAccount> {
  return new AcmeAccount(fake.directoryUrl, await newAccountKey(), null, opts);
}

/* The step's outcome on a clock that never moves, so a step that waited for any time would never end. Whatever timer the
   step set while it asked, such as its request's own timeout, it has let go. */
async function withoutWaiting<T>(step: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  onTestFinished(() => void vi.useRealTimers());
  const [outcome] = await Promise.allSettled([step()]);
  expect(vi.getTimerCount(), 'timers left waiting').toBe(0);
  return outcome!;
}

describe('the settings it runs on', () => {
  it("names Let's Encrypt's production directory", () => {
    expect(LETS_ENCRYPT).toBe('https://acme-v02.api.letsencrypt.org/directory');
  });

  it('does not wait forever for an answer', () => {
    expect(acme.axios.defaults.timeout).toBe(15000);
  });

  it('makes account keys of P-256 in PKCS#8', async () => {
    const key = await newAccountKey();
    expect(key.startsWith(PKCS8_PEM)).toBe(true);
    expect(acme.crypto.getJwk(key)).toMatchObject({ kty: 'EC', crv: 'P-256' });
  });
});

describe('AcmeAccount, on a fake ACME server', () => {
  it('tells a rate limit and its Retry-After, without waiting it out', async () => {
    const fake = await fakeAcme({ '/new-account': () => problem(429, RATE_LIMITED, 'too many', { 'retry-after': '7200' }) });
    const account = await newAccountOn(fake);
    expect(await withoutWaiting(() => account.account())).toMatchObject({
      status: 'rejected',
      reason: { kind: 'refused', type: RATE_LIMITED, retryAfterS: 7200, message: expect.stringContaining('too many') },
    });
    expect(fake.hits('/new-account')).toBe(1);
  });

  it('says unreachable for a server error, at once', async () => {
    const fake = await fakeAcme({ '/new-account': () => ({ status: 500 }) });
    const account = await newAccountOn(fake);
    expect(await withoutWaiting(() => account.account())).toMatchObject({ status: 'rejected', reason: { kind: 'unreachable', type: null } });
    expect(fake.hits('/new-account')).toBe(1);
  });

  it('keeps the type and the wait of a server error that has a problem document', async () => {
    const fake = await fakeAcme({ '/new-account': () => problem(503, SERVER_INTERNAL, 'down', { 'retry-after': '60' }) });
    await expect((await newAccountOn(fake)).account()).rejects.toMatchObject({ kind: 'unreachable', type: SERVER_INTERNAL, retryAfterS: 60 });
  });

  it('says unreachable when nothing answers', async () => {
    const closed = { directoryUrl: `http://127.0.0.1:${await closedPort()}/dir` };
    await expect((await newAccountOn(closed)).account()).rejects.toMatchObject({
      kind: 'unreachable',
      message: 'acme unreachable: no answer',
    });
  });

  it('never puts a key in an error', async () => {
    const key = await newAccountKey();
    const keyBody = key.split('\n').slice(1, -2).join('');
    const limited = await fakeAcme({ '/new-account': () => problem(429, RATE_LIMITED, 'too many') });
    const failed = await fakeAcme({ '/new-account': () => ({ status: 500 }) });
    const directories = [limited.directoryUrl, failed.directoryUrl, `http://127.0.0.1:${await closedPort()}/dir`];
    for (const directory of directories) {
      const error = await new AcmeAccount(directory, key).account().catch((reason: unknown) => reason as AcmeError);
      expect(error).toBeInstanceOf(AcmeError);
      const { message } = error as AcmeError;
      expect(message.includes('PRIVATE KEY')).toBe(false);
      expect(message.includes(keyBody)).toBe(false);
    }
  });

  it('cuts a long detail to 200 characters', () => {
    const { message } = new AcmeError('refused', { detail: 'x'.repeat(500) });
    expect(message).toMatch(/^acme refused/);
    expect(message.match(/x+/)?.[0]).toHaveLength(200);
  });

  it('sends again after a refused nonce', async () => {
    let tries = 0;
    const fake = await fakeAcme({
      '/new-account': (base) => {
        tries += 1;
        return tries === 1 ? problem(400, BAD_NONCE, 'stale') : accountMade(base);
      },
    });
    expect(await (await newAccountOn(fake)).account()).toBe(fake.accountUrl);
    expect(fake.hits('/new-account')).toBe(2);
  });

  // For a key it knows, acme-client follows the 200 with an update that says nothing new, and Pebble refuses that update.
  it('finds the account by its key even when the CA refuses the update that follows', async () => {
    const fake = await fakeAcme({
      '/new-account': (base) => ({ ...accountMade(base), status: 200 }),
      '/account/1': () => problem(400, 'urn:ietf:params:acme:error:malformed', 'Use POST-as-GET'),
    });
    expect(await (await newAccountOn(fake)).account()).toBe(fake.accountUrl);
    expect(fake.hits('/account/1')).toBe(1);
  });

  it('leaves nothing of a refused update behind for a later failure to read', async () => {
    const fake = await fakeAcme({
      // With no newOrder, the step after the account fails on this side, before a new answer could replace the last one.
      '/dir': (base) => ({ body: { newNonce: `${base}/nonce`, newAccount: `${base}/new-account` } }),
      '/new-account': (base) => ({ ...accountMade(base), status: 200 }),
      '/account/1': () => problem(400, 'urn:ietf:params:acme:error:malformed', 'Use POST-as-GET'),
    });
    const { hooks } = recordingHooks();
    await expect((await newAccountOn(fake)).issue(HOST, hooks, { selfCheck: false })).rejects.toMatchObject({ kind: 'unreachable', type: null });
  });

  it('gives back a URL it was given and asks the CA nothing, since it can vouch for nothing', async () => {
    const fake = await fakeAcme({ '/new-account': accountMade, '/account/1': () => ({ status: 500 }) });
    const account = new AcmeAccount(fake.directoryUrl, await newAccountKey(), fake.accountUrl, QUICK);
    expect(await account.account()).toBe(fake.accountUrl);
    expect(fake.paths()).toEqual([]);
  });

  it('asks the CA for the account once, however often it is asked', async () => {
    const fake = await fakeAcme({ '/new-account': accountMade });
    const account = await newAccountOn(fake);
    expect(await account.account()).toBe(fake.accountUrl);
    expect(await account.account()).toBe(fake.accountUrl);
    expect(fake.paths()).toEqual(['/new-account']);
  });

  it('accepts the terms and gives no contact', async () => {
    const fake = await fakeAcme({ '/new-account': accountMade });
    await (await newAccountOn(fake)).account();
    expect(fake.payloads('/new-account')).toEqual([{ termsOfServiceAgreed: true }]);
  });

  it('downloads the certificate of an order that was ready from the start', async () => {
    const { certPem: chain } = await selfSigned(HOST);
    const fake = await fakeAcme({
      ...readyOrder(chain),
      '/finalize': (base) => ({ body: orderBody(base, 'processing') }),
      '/order/1': (base) => ({ body: orderBody(base, 'valid', { certificate: `${base}/cert` }) }),
    });
    const { hooks, calls } = recordingHooks();
    const issued = await (await newAccountOn(fake)).issue(HOST, hooks, { selfCheck: false });
    expect(issued.certPem).toBe(chain);
    expect(issued.keyPem.startsWith(PKCS8_PEM)).toBe(true);
    expect(calls).toEqual([]);
  });

  it('asks for the order with replaces when it renews, and makes the account once', async () => {
    const fake = await fakeAcme(readyOrder((await selfSigned(HOST)).certPem));
    const { hooks } = recordingHooks();
    const account = await newAccountOn(fake);
    await account.issue(HOST, hooks, { selfCheck: false });
    await account.issue(HOST, hooks, { replaces: 'aa.bb', selfCheck: false });
    const identifiers = [{ type: 'dns', value: HOST }];
    expect(fake.payloads('/new-order')).toEqual([{ identifiers }, { identifiers, replaces: 'aa.bb' }]);
    expect(fake.hits('/new-account')).toBe(1);
  });

  it('uses the account it was given without making one', async () => {
    const fake = await fakeAcme(readyOrder((await selfSigned(HOST)).certPem));
    const { hooks } = recordingHooks();
    await new AcmeAccount(fake.directoryUrl, await newAccountKey(), fake.accountUrl, QUICK).issue(HOST, hooks, { selfCheck: false });
    expect(fake.hits('/new-account')).toBe(0);
  });

  it('gives every certificate a new key', async () => {
    const fake = await fakeAcme(readyOrder((await selfSigned(HOST)).certPem));
    const { hooks } = recordingHooks();
    const account = await newAccountOn(fake);
    const first = await account.issue(HOST, hooks, { selfCheck: false });
    const second = await account.issue(HOST, hooks, { selfCheck: false });
    expect(first.keyPem === second.keyPem).toBe(false);
  });
});

describe('proving a name, on a fake ACME server', () => {
  const settings = (acme.axios.defaults as unknown as { acmeSettings: { httpChallengePort: number } }).acmeSettings;
  const defaultPort = settings.httpChallengePort;
  afterEach(() => {
    settings.httpChallengePort = defaultPort;
  });

  it('answers, checks its own answer, then asks the CA, and forgets the token', async () => {
    const { certPem: chain } = await selfSigned(HOST);
    let completed = false;
    const { hooks, calls, answers } = recordingHooks();
    const fake = await fakeAcme(orderToProve(chain, (base) => authorization(base, completed ? 'valid' : 'pending'), {
      '/challenge/1': () => {
        completed = true;
        return { body: { status: 'processing' } };
      },
      [CHALLENGE_ANSWER]: () => ({ text: answers.get(TOKEN) ?? '' }),
    }));
    settings.httpChallengePort = fake.port;
    const issued = await (await newAccountOn(fake)).issue(HOST, hooks);
    expect(issued.certPem).toBe(chain);
    expect(calls).toEqual(ANSWERED_AND_FORGOTTEN);
    const asked = fake.paths().indexOf(CHALLENGE_ANSWER);
    expect(asked).toBeGreaterThanOrEqual(0);
    expect(asked).toBeLessThan(fake.paths().indexOf('/challenge/1'));
  });

  it('does not ask the CA while its own check fails, and forgets the token', async () => {
    const { hooks, calls } = recordingHooks();
    const fake = await fakeAcme(orderToProve('', (base) => authorization(base, 'pending')));
    settings.httpChallengePort = fake.port;
    const account = await newAccountOn(fake, { backoff: { attempts: 2, min: 20, max: 20 } });
    await expect(account.issue(HOST, hooks)).rejects.toMatchObject({ kind: 'not_ready' });
    expect(fake.hits(CHALLENGE_ANSWER)).toBe(2);
    expect(fake.hits('/challenge/1')).toBe(0);
    expect(calls).toEqual(ANSWERED_AND_FORGOTTEN);
  });

  it('says invalid, with the type of the challenge error, when the CA could not validate', async () => {
    const { hooks, calls } = recordingHooks();
    const failure = { type: CONNECTION, detail: 'could not connect' };
    const fake = await fakeAcme(orderToProve('', (base) => authorization(base, 'invalid', failure)));
    await expect((await newAccountOn(fake)).issue(HOST, hooks, { selfCheck: false })).rejects.toMatchObject({
      kind: 'invalid',
      type: CONNECTION,
      message: expect.stringContaining('could not connect'),
    });
    expect(calls).toEqual(ANSWERED_AND_FORGOTTEN);
  });

  it('says unreachable when the authorization stays pending past the backoff', async () => {
    const { hooks, calls } = recordingHooks();
    const fake = await fakeAcme(orderToProve('', (base) => authorization(base, 'pending')));
    await expect((await newAccountOn(fake)).issue(HOST, hooks, { selfCheck: false })).rejects.toMatchObject({ kind: 'unreachable', type: null });
    expect(calls).toEqual(ANSWERED_AND_FORGOTTEN);
  });

  it('says refused when the CA turns down the challenge itself', async () => {
    const { hooks, calls } = recordingHooks();
    const fake = await fakeAcme(orderToProve('', (base) => authorization(base, 'pending'), {
      '/challenge/1': () => problem(403, 'urn:ietf:params:acme:error:unauthorized', 'not yours'),
    }));
    await expect((await newAccountOn(fake)).issue(HOST, hooks, { selfCheck: false })).rejects.toMatchObject({
      kind: 'refused',
      type: 'urn:ietf:params:acme:error:unauthorized',
    });
    expect(calls).toEqual(ANSWERED_AND_FORGOTTEN);
  });

  it('says refused when the order offers no http-01 challenge', async () => {
    const { hooks, calls } = recordingHooks();
    const dnsOnly: Handler = () => ({
      body: { status: 'pending', identifier: { type: 'dns', value: HOST }, challenges: [{ type: 'dns-01', url: 'x', token: 't', status: 'pending' }] },
    });
    const fake = await fakeAcme(orderToProve('', dnsOnly));
    await expect((await newAccountOn(fake)).issue(HOST, hooks)).rejects.toMatchObject({ kind: 'refused', type: null });
    expect(calls).toEqual([]);
  });

  it('skips an authorization that is already valid', async () => {
    const { certPem: chain } = await selfSigned(HOST);
    const { hooks, calls } = recordingHooks();
    const fake = await fakeAcme(orderToProve(chain, (base) => authorization(base, 'valid')));
    const issued = await (await newAccountOn(fake)).issue(HOST, hooks);
    expect(issued.certPem).toBe(chain);
    expect(calls).toEqual([]);
  });
});

describe('Retry-After', () => {
  const NOW = Date.parse('2026-11-04T12:00:00Z');

  it('reads seconds', () => {
    expect(retryAfterSeconds('120', NOW)).toBe(120);
  });

  it('reads an HTTP date, as the seconds until it', () => {
    expect(retryAfterSeconds('Wed, 04 Nov 2026 12:10:00 GMT', NOW)).toBe(600);
  });

  it('reads a date that has passed as no wait', () => {
    expect(retryAfterSeconds('Wed, 04 Nov 2026 11:00:00 GMT', NOW)).toBe(0);
  });

  it('has nothing to say for no header or for nonsense', () => {
    expect(retryAfterSeconds(undefined, NOW)).toBeNull();
    expect(retryAfterSeconds('soon', NOW)).toBeNull();
  });

  it.each(['-5', 'retry 10', '12 Nov', 'Sunny 10', '2026-11-04'])('does not take %s for a date', (header) => {
    expect(retryAfterSeconds(header, NOW)).toBeNull();
  });
});

describe('a problem document', () => {
  it('is known by its content type in any case', () => {
    const body = { type: BAD_NONCE, detail: 'stale' };
    expect(problemOf(400, 'Application/Problem+JSON; charset=utf-8', body, undefined)).toEqual({ status: 400, ...body, retryAfterS: null });
  });
});
