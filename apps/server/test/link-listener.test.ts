import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { Duplex } from 'node:stream';
import tls, { type TLSSocket } from 'node:tls';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { LinkListener } from '../src/modules/tls/listener.js';
import { selfSigned } from '../src/modules/tls/x509.js';
import { as, listen, SETUP, setUpCompany, testApp } from './helpers.js';
import { visitorHeader } from './proxy-v2.js';

const HOST = 'acme.hornhoof.org';
const VISITOR = '203.0.113.7';
const OTHER_VISITOR = '203.0.113.8';
const IS_TUNNEL = { TUNNEL_HOST: '127.0.0.1' };
const NOT_TUNNEL = { TUNNEL_HOST: '192.0.2.10' };
const TLS_CLIENT = { servername: HOST, rejectUnauthorized: false };

async function listening(env: NodeJS.ProcessEnv = IS_TUNNEL) {
  const { app, config } = await testApp(env);
  const ceo = await setUpCompany(app);
  const listener = new LinkListener({ app, config, log: app.log });
  const port = await listener.listen(0, '127.0.0.1');
  onTestFinished(() => listener.close(0));
  return { app, config, ceo, listener, port };
}

async function rawConnection(port: number): Promise<net.Socket> {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  onTestFinished(() => void socket.destroy());
  await once(socket, 'connect');
  return socket;
}

async function secured(socket: TLSSocket): Promise<TLSSocket> {
  onTestFinished(() => void socket.destroy());
  await once(socket, 'secureConnect');
  return socket;
}

/* A connection as the tunnel container opens it for a visitor: the PROXY header, then TLS. */
async function overTls(port: number, visitor = VISITOR): Promise<TLSSocket> {
  const raw = await rawConnection(port);
  raw.write(visitorHeader(visitor));
  return secured(tls.connect({ socket: raw, ...TLS_CLIENT }));
}

/* TLS whose first bytes leave in one write with the header, so that the listener reads both in one segment. */
async function overTlsInOneWrite(port: number): Promise<TLSSocket> {
  const raw = await rawConnection(port);
  let header: Buffer | null = visitorHeader(VISITOR);
  const carrier = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, done) {
      raw.write(header ? Buffer.concat([header, chunk]) : chunk, done);
      header = null;
    },
  });
  raw.on('data', chunk => carrier.push(chunk));
  return secured(tls.connect({ socket: carrier, ...TLS_CLIENT }));
}

async function overTlsWithHeaderInTwoWrites(port: number): Promise<TLSSocket> {
  const raw = await rawConnection(port);
  const header = visitorHeader(VISITOR);
  raw.write(header.subarray(0, 10));
  await new Promise(resolve => setTimeout(resolve, 50));
  raw.write(header.subarray(10));
  return secured(tls.connect({ socket: raw, ...TLS_CLIENT }));
}

type Asked = { method?: string; path: string; body?: object; headers?: Record<string, string> };
type Answer = { status: number; cookies: string[]; body: string };

/* A request over a connection that is already open, as one http client would send it. */
function ask(socket: TLSSocket, { method = 'GET', path, body, headers = {} }: Asked): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const typed = body ? { 'content-type': 'application/json' } : {};
    const request = http.request({ createConnection: () => socket, method, path, headers: { host: HOST, ...typed, ...headers } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, cookies: response.headers['set-cookie'] ?? [], body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
    request.end(body ? JSON.stringify(body) : undefined);
  });
}

const health = { path: '/api/health' };

async function wrongSignIn(port: number, visitor: string, headers: Record<string, string> = {}, email = 'x@acme.com'): Promise<number> {
  const body = { email, password: 'not the password' };
  return (await ask(await overTls(port, visitor), { method: 'POST', path: '/api/auth/login', body, headers })).status;
}

/* The per email and address limit stops the eleventh. */
const LIMITED_AFTER = 10;

/* Wrong sign-ins from one visitor, each with another email, so that only the limit per address fills. */
const ADDRESS_LIMIT = 30;
async function fillAddressLimit(port: number, visitor: string): Promise<void> {
  for (let i = 0; i < ADDRESS_LIMIT; i++) expect(await wrongSignIn(port, visitor, {}, `x${i}@acme.com`)).toBe(401);
}
const wrongWithNewEmail = (port: number, visitor: string) => wrongSignIn(port, visitor, {}, `new-${visitor}@acme.com`);

async function closedAfterMs(socket: net.Socket): Promise<number> {
  const started = performance.now();
  await once(socket, 'close');
  return performance.now() - started;
}

const upgrade = (headers: string[] = []) =>
  [
    'GET /api/nodes/socket HTTP/1.1',
    `Host: ${HOST}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    ...headers,
    '',
    '',
  ].join('\r\n');

async function statusLineOf(socket: net.Socket, request: string): Promise<string> {
  socket.write(request);
  const [answer] = (await once(socket, 'data')) as [Buffer];
  return answer.toString().split('\r\n')[0]!;
}

async function nodeKey(app: FastifyInstance, ceo: string): Promise<string> {
  const connected = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) });
  const code = (connected.json().command as string).split('--join ')[1]!;
  const payload = { code, machineId: 'mac-0001-abcd', hostname: 'ivan-mac', os: 'darwin', arch: 'arm64' };
  const joined = await app.inject({ method: 'POST', url: '/api/nodes/join', payload });
  return joined.json().nodes[0].key as string;
}

describe('the certificate of the TLS listener', () => {
  it("serves a stand-in for the link's host until it is given a certificate", async () => {
    const { listener, port } = await listening();
    expect((await overTls(port)).getPeerCertificate().subjectaltname).toBe('DNS:hornhoof.invalid');

    await listener.use(HOST, null);
    const standIn = (await overTls(port)).getPeerCertificate();
    expect(standIn.subjectaltname).toBe(`DNS:${HOST}`);
    expect(standIn.issuer).toEqual(standIn.subject);

    await listener.use(HOST, await selfSigned(HOST, { serial: '0a0b' }));
    expect((await overTls(port)).getPeerCertificate().serialNumber).toBe('0A0B');
  });

  it('goes back to the placeholder name without a host', async () => {
    const { listener, port } = await listening();
    await listener.use(HOST, null);
    await listener.use(null, null);
    expect((await overTls(port)).getPeerCertificate().subjectaltname).toBe('DNS:hornhoof.invalid');
  });

  it('keeps the certificate of the later of two calls, though a stand-in takes longer to make', async () => {
    const { listener, port } = await listening();
    const real = await selfSigned(HOST, { serial: '0a0b' });
    await Promise.all([listener.use('old.hornhoof.org', null), listener.use(HOST, real)]);
    expect((await overTls(port)).getPeerCertificate().serialNumber).toBe('0A0B');
  });

  it('keeps what it serves when it is given a certificate that does not load', async () => {
    const { listener, port } = await listening();
    await listener.use(HOST, null);
    await expect(listener.use(HOST, { certPem: 'not a certificate', keyPem: 'not a key' })).rejects.toThrow();
    expect((await overTls(port)).getPeerCertificate().subjectaltname).toBe(`DNS:${HOST}`);
  });
});

describe('a request through the TLS listener', () => {
  it('answers as over the link', async () => {
    const { port } = await listening();
    const answer = await ask(await overTls(port), health);
    expect(JSON.parse(answer.body)).toEqual({ ok: true });

    const body = { email: 'ivan@acme.com', password: SETUP.password };
    const signedIn = await ask(await overTls(port), { method: 'POST', path: '/api/auth/login', body });
    expect(signedIn.status).toBe(200);
    expect(signedIn.cookies.some(cookie => cookie.startsWith('__Host-hh_session='))).toBe(true);
  });

  it('takes the visitor from the PROXY header of the tunnel container only', async () => {
    const trusted = await listening(IS_TUNNEL);
    for (let i = 0; i < LIMITED_AFTER; i++) expect(await wrongSignIn(trusted.port, VISITOR)).toBe(401);
    expect(await wrongSignIn(trusted.port, VISITOR)).toBe(429);
    expect(await wrongSignIn(trusted.port, OTHER_VISITOR)).toBe(401);

    /* From any other address the header is not believed, so both visitors are 127.0.0.1 here. */
    const other = await listening(NOT_TUNNEL);
    for (let i = 0; i < LIMITED_AFTER; i++) expect(await wrongSignIn(other.port, VISITOR)).toBe(401);
    expect(await wrongSignIn(other.port, OTHER_VISITOR)).toBe(429);
  });

  it('counts the limit of 30 an hour per address by the visitor of the PROXY header', async () => {
    const trusted = await listening(IS_TUNNEL);
    await fillAddressLimit(trusted.port, VISITOR);
    expect(await wrongWithNewEmail(trusted.port, VISITOR)).toBe(429);
    expect(await wrongWithNewEmail(trusted.port, OTHER_VISITOR)).toBe(401);

    /* From any other address the header is not believed, so both visitors are 127.0.0.1 here. */
    const other = await listening(NOT_TUNNEL);
    await fillAddressLimit(other.port, VISITOR);
    expect(await wrongWithNewEmail(other.port, OTHER_VISITOR)).toBe(429);
  });

  it('does not believe an X-Forwarded-For the visitor wrote', async () => {
    const { port } = await listening();
    for (let i = 0; i < LIMITED_AFTER; i++) {
      expect(await wrongSignIn(port, VISITOR, { 'x-forwarded-for': `198.51.100.${i}` })).toBe(401);
    }
    expect(await wrongSignIn(port, VISITOR, { 'x-forwarded-for': '198.51.100.99' })).toBe(429);
  });

  it('carries a WebSocket upgrade', async () => {
    const { app, port } = await listening();
    const plain = new URL((await listen(app)).replace('ws:', 'http:'));
    const overHttp = await statusLineOf(await rawConnection(Number(plain.port)), upgrade());
    expect(overHttp).toMatch(/^HTTP\/1\.1 \d{3} /);
    expect(await statusLineOf(await overTls(port), upgrade())).toBe(overHttp);
  });

  it('opens a WebSocket for a node with its key', async () => {
    const { app, ceo, port } = await listening();
    const key = await nodeKey(app, ceo);
    const line = await statusLineOf(await overTls(port), upgrade([`Authorization: Bearer ${key}`]));
    expect(line).toBe('HTTP/1.1 101 Switching Protocols');
  });
});

describe('how a connection opens', () => {
  it('reads a TLS hello that came in one segment with the header', async () => {
    const { port } = await listening();
    expect((await ask(await overTlsInOneWrite(port), health)).status).toBe(200);
  });

  it('reads a header that came in two segments', async () => {
    const { port } = await listening();
    expect((await ask(await overTlsWithHeaderInTwoWrites(port), health)).status).toBe(200);
  });

  it('closes a connection with no header in 5 s, and a bad header at once', async () => {
    const { port } = await listening();
    const silent = await rawConnection(port);
    const halfHeader = await rawConnection(port);
    const bad = await rawConnection(port);
    const silentMs = closedAfterMs(silent);
    const halfHeaderMs = closedAfterMs(halfHeader);
    const badMs = closedAfterMs(bad);
    halfHeader.write(visitorHeader(VISITOR).subarray(0, 20));
    bad.write('GET / HTTP/1.1\r\n');

    expect(await badMs).toBeLessThan(1000);
    for (const ms of await Promise.all([silentMs, halfHeaderMs])) {
      expect(ms).toBeGreaterThan(4500);
      expect(ms).toBeLessThan(6000);
    }
  });

  it('closes a connection whose handshake does not finish in 10 s, and not one that finished', async () => {
    const { port } = await listening();
    const finished = await overTls(port);
    const stalled = await rawConnection(port);
    const stalledMs = closedAfterMs(stalled);
    stalled.write(visitorHeader(VISITOR));

    const ms = await stalledMs;
    expect(ms).toBeGreaterThan(9500);
    expect(ms).toBeLessThan(11000);
    expect((await ask(finished, health)).status).toBe(200);
  });

  it('goes on after a visitor resets the connection at any stage', async () => {
    const { port } = await listening();
    const pause = () => new Promise(resolve => setTimeout(resolve, 50));

    const inHeader = await rawConnection(port);
    inHeader.write(visitorHeader(VISITOR).subarray(0, 20));
    await pause();
    inHeader.resetAndDestroy();

    const inHandshake = await rawConnection(port);
    inHandshake.write(visitorHeader(VISITOR));
    await pause();
    inHandshake.resetAndDestroy();

    const inRequest = await rawConnection(port);
    inRequest.write(visitorHeader(VISITOR));
    const client = await secured(tls.connect({ socket: inRequest, ...TLS_CLIENT }));
    client.on('error', () => {});
    client.write('GET /api/health HTTP/1.1\r\nHost: x\r\n');
    await pause();
    inRequest.resetAndDestroy();
    await pause();

    expect((await ask(await overTls(port), health)).status).toBe(200);
  });

  it('closes a connection that stops speaking TLS after the handshake', async () => {
    const { port } = await listening();
    const raw = await rawConnection(port);
    raw.write(visitorHeader(VISITOR));
    const client = await secured(tls.connect({ socket: raw, ...TLS_CLIENT }));
    client.on('error', () => {});
    const rawMs = closedAfterMs(raw);
    raw.write(Buffer.alloc(64, 0x17));
    expect(await rawMs).toBeLessThan(1000);
    expect((await ask(await overTls(port), health)).status).toBe(200);
  });

  it('offers only http/1.1 to a client that also knows http/2', async () => {
    const { port } = await listening();
    const raw = await rawConnection(port);
    raw.write(visitorHeader(VISITOR));
    const client = await secured(tls.connect({ socket: raw, ...TLS_CLIENT, ALPNProtocols: ['h2', 'http/1.1'] }));
    expect(client.alpnProtocol).toBe('http/1.1');
  });

  it('closes only that connection when what follows the header is not TLS', async () => {
    const { port } = await listening();
    const garbled = await rawConnection(port);
    const garbledMs = closedAfterMs(garbled);
    garbled.write(Buffer.concat([visitorHeader(VISITOR), Buffer.from('these are not the bytes of a TLS hello\r\n')]));

    expect(await garbledMs).toBeLessThan(1000);
    expect((await ask(await overTls(port), health)).status).toBe(200);
  });
});

describe('opening the TLS listener', () => {
  it('fails when the port is taken', async () => {
    const { app, config, port } = await listening();
    const second = new LinkListener({ app, config, log: app.log });
    await expect(second.listen(port, '127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await second.close(0);
  });
});

describe('closing the TLS listener', () => {
  it('stops taking connections when closed', async () => {
    const { listener, port } = await listening();
    const asking = await overTls(port);
    const silent = await overTls(port);
    const silentMs = closedAfterMs(silent);
    const started = performance.now();
    const closing = listener.close(200);

    /* One already open may still finish what it asks in the grace; what is left after the grace is closed. */
    expect((await ask(asking, health)).status).toBe(200);
    await expect(rawConnection(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });

    await closing;
    expect(performance.now() - started).toBeLessThan(1000);
    expect(await silentMs).toBeLessThan(1000);
  });

  it('resolves as soon as its connections have ended', async () => {
    const { listener, port } = await listening();
    const open = await overTls(port);
    const started = performance.now();
    const closing = listener.close(10_000);
    open.destroy();
    await closing;
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
