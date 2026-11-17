import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { Duplex } from 'node:stream';
import tls, { type TLSSocket } from 'node:tls';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { eventually } from '../../../test-support/eventually.mjs';
import { LinkListener, linkVisitor } from '../src/modules/tls/listener.js';
import { selfSigned } from '../src/modules/tls/x509.js';
import { proxyV2, visitorHeader } from './proxy-v2.js';

const HOST = 'acme.hornhoof.test';
const VISITOR = '203.0.113.9';
const TLS_CLIENT = { servername: HOST, rejectUnauthorized: false };
const V2_LOCAL = 0x20;

/* What the keeper's third door is here: a server with no port of its own, which says who the listener says it serves. */
function sayingWho(options: http.ServerOptions = {}): http.Server {
  return http.createServer(options, (req, res) => {
    req.resume();
    res.end(JSON.stringify({ visitor: linkVisitor(req.socket) ?? null }));
  });
}

const quietLog = { warn: () => {} };

async function listening(server = sayingWho()) {
  let handed = 0;
  server.on('connection', () => handed++);
  const listener = new LinkListener({ server, log: quietLog });
  const port = await listener.listen(0);
  onTestFinished(() => listener.close(0));
  /* Until the listener has finished this many handshakes, so that no deadline of theirs is left, and given each
     connection to the server. */
  const handedOver = (count: number) => eventually(() => handed >= count);
  return { listener, port, server, handedOver };
}

/* From here on the listener's own timers run on a clock that moves only when the test moves it, so every timer the clock
   holds is one of the listener's. The sockets still do real I/O, and what they do is waited for with no deadline. */
function frozenClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  onTestFinished(() => void vi.useRealTimers());
}

const timersArmed = () => vi.getTimerCount();

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

/* A connection as the keeper's frpc opens it for a visitor: the PROXY header, then TLS. */
async function overTls(port: number, header = visitorHeader(VISITOR)): Promise<TLSSocket> {
  const raw = await rawConnection(port);
  raw.write(header);
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

type Answer = { status: number; body: string };

/* A request over a connection that is already open, as one http client would send it. */
function ask(socket: TLSSocket, { path }: { path: string }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = http.request({ createConnection: () => socket, path, headers: { host: HOST } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
    request.end();
  });
}

const health = { path: '/api/health' };

/* The visitor's end of a connection: whether it has seen it close yet, and the moment it does. */
function closing(socket: net.Socket): { closed: () => boolean; close: Promise<void> } {
  let closed = false;
  const close = once(socket, 'close').then(() => void (closed = true));
  return { closed: () => closed, close };
}

/* A visitor whose TLS stops after its hello: it hears nothing of the listener's answer, so it never sends the end of the
   handshake. That answer, when it comes, shows that the listener has read the header and started the handshake. */
async function stalledAfterHello(port: number): Promise<net.Socket> {
  const raw = await rawConnection(port);
  raw.write(visitorHeader(VISITOR));
  const carrier = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, done) {
      raw.write(chunk, done);
    },
  });
  const answered = once(raw, 'data');
  const client = tls.connect({ socket: carrier, ...TLS_CLIENT });
  client.on('error', () => {});
  onTestFinished(() => void client.destroy());
  await answered;
  return raw;
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

describe('a connection through the TLS listener', () => {
  it('reaches the server it was given, with the visitor of the PROXY header', async () => {
    const { port } = await listening();
    expect(JSON.parse((await ask(await overTls(port), health)).body)).toEqual({ visitor: VISITOR });
  });

  it('has no visitor when the PROXY header names none', async () => {
    const { port } = await listening();
    const answer = await ask(await overTls(port, proxyV2({ versionAndCommand: V2_LOCAL })), health);
    expect(JSON.parse(answer.body)).toEqual({ visitor: null });
  });

  it('carries an upgrade', async () => {
    const server = sayingWho();
    server.on('upgrade', (_req, socket) => socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
    const { port } = await listening(server);
    const client = await overTls(port);
    client.write(`GET /socket HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    const [answer] = (await once(client, 'data')) as [Buffer];
    expect(answer.toString().split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols');
  });

  /* The server has no port of its own, and Node times a connection's headers only on a server that listens. */
  it('holds a connection to the time the server gives for its headers', async () => {
    const { port } = await listening(sayingWho({ requestTimeout: 0, headersTimeout: 100, connectionsCheckingInterval: 20 }));
    const client = await overTls(port);
    client.write(`GET / HTTP/1.1\r\nHost: ${HOST}\r\n`);
    const [answer] = (await once(client, 'data')) as [Buffer];
    expect(answer.toString().split('\r\n')[0]).toBe('HTTP/1.1 408 Request Timeout');
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
    frozenClock();
    const silent = closing(await rawConnection(port));
    const halfHeaderSocket = await rawConnection(port);
    const halfHeader = closing(halfHeaderSocket);
    halfHeaderSocket.write(visitorHeader(VISITOR).subarray(0, 20));
    const bad = await rawConnection(port);
    const badClose = once(bad, 'close');
    bad.write('GET / HTTP/1.1\r\n');

    /* On a clock that has not moved. The listener takes connections in the order they came, so by now it holds the first
       two, each with its deadline for the header. */
    await badClose;
    expect(timersArmed()).toBe(2);

    await vi.advanceTimersByTimeAsync(4999);
    expect(timersArmed()).toBe(2);
    expect([silent.closed(), halfHeader.closed()]).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(1);
    expect(timersArmed()).toBe(0);
    await Promise.all([silent.close, halfHeader.close]);
  });

  it('closes a connection whose handshake does not finish in 10 s, and not one that finished', async () => {
    const { port, handedOver } = await listening();
    frozenClock();
    const finished = await overTls(port);
    await handedOver(1);
    expect(timersArmed()).toBe(0);
    const stalled = closing(await stalledAfterHello(port));
    expect(timersArmed()).toBe(1);

    await vi.advanceTimersByTimeAsync(9999);
    expect(timersArmed()).toBe(1);
    expect(stalled.closed()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(timersArmed()).toBe(0);
    await stalled.close;
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
    frozenClock();
    const raw = await rawConnection(port);
    raw.write(visitorHeader(VISITOR));
    const client = await secured(tls.connect({ socket: raw, ...TLS_CLIENT }));
    client.on('error', () => {});
    const rawClose = once(raw, 'close');
    raw.write(Buffer.alloc(64, 0x17));
    /* On a clock that has not moved: not by the deadline of the handshake, which is let go. */
    await rawClose;
    expect(timersArmed()).toBe(0);
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
    frozenClock();
    const garbled = await rawConnection(port);
    const garbledClose = once(garbled, 'close');
    garbled.write(Buffer.concat([visitorHeader(VISITOR), Buffer.from('these are not the bytes of a TLS hello\r\n')]));

    /* On a clock that has not moved: not by the deadline of the handshake. */
    await garbledClose;
    expect((await ask(await overTls(port), health)).status).toBe(200);
  });
});

describe('opening the TLS listener', () => {
  it('fails when the port is taken', async () => {
    const { port } = await listening();
    const second = new LinkListener({ server: sayingWho(), log: quietLog });
    await expect(second.listen(port, '127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await second.close(0);
  });

  /* Every PROXY header is believed, which is safe only while nobody but the keeper's frpc can reach the port. */
  it('listens on 127.0.0.1 unless told otherwise', async () => {
    const asked = vi.spyOn(net.Server.prototype, 'listen');
    onTestFinished(() => void asked.mockRestore());
    await listening();
    expect(asked.mock.calls[0]!.slice(0, 2)).toEqual([0, '127.0.0.1']);
  });
});

describe('closing the TLS listener', () => {
  it('stops taking connections when closed', async () => {
    const { listener, port, handedOver } = await listening();
    frozenClock();
    const asking = await overTls(port);
    const silent = closing(await overTls(port));
    await handedOver(2);
    let closed = false;
    const closes = listener.close(200).then(() => void (closed = true));
    expect(timersArmed()).toBe(1);

    /* One already open may still finish what it asks in the grace; what is left after the grace is closed. */
    expect((await ask(asking, health)).status).toBe(200);
    await expect(rawConnection(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });

    await vi.advanceTimersByTimeAsync(199);
    expect(timersArmed()).toBe(1);
    expect([closed, silent.closed()]).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(1);
    expect(timersArmed()).toBe(0);
    await Promise.all([closes, silent.close]);
  });

  it('resolves as soon as its connections have ended', async () => {
    const { listener, port, handedOver } = await listening();
    frozenClock();
    const open = await overTls(port);
    await handedOver(1);
    const closes = listener.close(10_000);
    open.destroy();
    /* On a clock that has not moved: the grace is not waited out, and is let go. */
    await closes;
    expect(timersArmed()).toBe(0);
  });
});
