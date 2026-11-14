import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import { listenIn } from '../../../../test-support/ports.mjs';
import { LeaseProofs } from '../../src/modules/keeper/proofs.js';
import type { HeldCertificate } from '../../src/modules/keeper/certificate.js';
import type { MachineKey } from '../../src/modules/keeper/machine-keys.js';
import { serviceName } from '../../src/modules/link/peer-client.js';
import { Relay } from '../../src/modules/link/relay.js';
import { issueCertificate, makeAuthority, makeCrl } from '../../src/modules/network/authority.js';
import { DbDoor } from '../../src/net/db-door.js';
import { PeerServer } from '../../src/net/peer-server.js';
import { PeerSessions } from '../../src/net/peer-sessions.js';
import { fakeRelay } from '../fake-relay.js';
import { closedPort, createDelayGate, createPeerRelay, virtualClock } from './network.js';

const COMPANY_ID = '00000000-0000-4000-8000-0000000000aa';
const MACHINE_A = '11111111-0000-4000-8000-000000000001';
const MACHINE_B = '22222222-0000-4000-8000-000000000002';
const NET_A = 'aa11bb22'.repeat(8);
const NET_B = 'cc33dd44'.repeat(8);

function ed25519(): MachineKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privatePem: privateKey, publicPem: publicKey };
}

async function dataCerts() {
  const authority = await makeAuthority(COMPANY_ID);
  const crlPem = await makeCrl(authority, []);
  const make = async (machineId: string) => {
    const key = ed25519();
    const issued = await issueCertificate(authority, { machineId, role: 'data', signKey: key.publicPem });
    const held: HeldCertificate = {
      machine: machineId,
      role: 'data',
      certPem: issued.certPem,
      authorityPem: authority.certPem,
      until: issued.until.toISOString(),
    };
    return { key, held };
  };
  return { crlPem, a: await make(MACHINE_A), b: await make(MACHINE_B) };
}

async function echoDbServer(): Promise<{ port: number }> {
  const server = net.createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) socket.write(`db:${line}\n`);
    });
  });
  const port = await listenIn(server, '127.0.0.1');
  onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())));
  return { port };
}

function askLine(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`${text}\n`));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      socket.destroy();
      resolve(buffer.slice(0, newline));
    });
    socket.on('error', reject);
  });
}

describe('the network lab relay and peer path with controllable delay', () => {
  it('delays relay HTTP round trips by 2 * oneWayMs on virtual time, enforces timeouts, and cuts and mends', async () => {
    const clock = virtualClock();
    const gate = createDelayGate({ oneWayMs: 350, schedule: clock.schedule });
    const upstream = await fakeRelay();
    upstream.bindings.set('acme', { key: 'k'.repeat(32) });
    upstream.register('acme', 'acme-a-link');
    const proxy = await gate.httpProxy(upstream.url);
    const relay = new Relay(proxy.url);

    let routeDone = false;
    const asking = relay.route('acme', 'k'.repeat(32)).then(res => {
      routeDone = true;
      return res;
    });
    await clock.advance(650);
    expect(routeDone).toBe(false);
    await clock.advance(50);
    expect(routeDone).toBe(true);
    expect(await asking).toMatchObject({ known: true, state: 'held', client: 'acme-a-link' });

    /* Relay timeout obeys virtual time without depending on machine speed. */
    const slow = relay.route('acme', 'k'.repeat(32), 500);
    await clock.advance(550);
    expect(await slow).toEqual({ known: false, why: 'slow' });
    await clock.advance(200);

    /* Cutting the gate drops relay calls immediately; mending restores the path. */
    gate.setCut(true);
    const dropped = relay.health(500);
    await clock.advance(50);
    expect((await dropped).up).toBe(false);
    expect(gate.stats().cuts).toBeGreaterThanOrEqual(1);

    gate.setCut(false);
    const restored = relay.health(2000);
    await clock.advance(700);
    expect((await restored).up).toBe(true);
  });

  it('models the two-hop public link probe at 4 * oneWayMs and exposes the 2 s probe cliff on network-1', async () => {
    const clock = virtualClock();
    const gate = createDelayGate({ oneWayMs: 150, schedule: clock.schedule });
    const keeperDoor = http.createServer((req, res) => {
      const nonce = new URL(String(req.url), 'http://keeper').searchParams.get('nonce') ?? '';
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ machine: NET_A, nonce }));
    });
    const doorPort = await listenIn(keeperDoor, '127.0.0.1');
    onTestFinished(() => new Promise<void>(resolve => keeperDoor.close(() => resolve())));

    /* Hop 1: keeper -> hornhoof.org edge; Hop 2: edge -> frps tunnel -> keeper door (4 * oneWayMs total). */
    const edge = await gate.httpProxy(`http://127.0.0.1:${doorPort}`, { hops: 2 });
    const beats = { answer: () => null, all: () => new Map() };
    const proofs = new LeaseProofs({
      probe: async nonce => {
        const res = await fetch(`${edge.url}/api/network/lease?nonce=${nonce}`);
        return res.ok ? ((await res.json()) as { machine: string; nonce: string }) : null;
      },
      beats,
      self: NET_A,
      term: () => ({ number: 1, machine: NET_A, split: false }),
      b: () => null,
      now: () => clock.clocks(),
    });

    /* At 150 ms one-way (600 ms 2-RTT), the probe finishes at 600 ms and proves the link. */
    const fastTick = proofs.tick();
    await clock.advance(550);
    expect(proofs.proof()).toBeNull();
    await clock.advance(50);
    await fastTick;
    expect(proofs.proof()).not.toBeNull();

    /* At 600 ms one-way (2400 ms 2-RTT), a single raw probe takes 2400 ms on virtual time. */
    gate.setOneWayMs(600);
    let rawAnsweredAt = -1;
    const start = clock.now();
    const raw = fetch(`${edge.url}/api/network/lease?nonce=${'n'.repeat(24)}`).then(async r => {
      await r.json();
      rawAnsweredAt = clock.now() - start;
    });
    await clock.advance(2350);
    expect(rawAnsweredAt).toBe(-1);
    await clock.advance(100);
    await raw;
    expect(rawAnsweredAt).toBeGreaterThanOrEqual(2400);
  });

  it('preserves strict FIFO chunk ordering on delayed streams when latency shrinks mid-flight', async () => {
    const clock = virtualClock();
    const gate = createDelayGate({ oneWayMs: 400, schedule: clock.schedule });
    const received: string[] = [];
    const sink = net.createServer(socket => {
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => received.push(chunk));
    });
    const sinkPort = await listenIn(sink, '127.0.0.1');
    onTestFinished(() => new Promise<void>(resolve => sink.close(() => resolve())));
    const proxy = await gate.tcpProxy({ host: '127.0.0.1', port: sinkPort });

    const client = net.connect(proxy.port, '127.0.0.1');
    onTestFinished(() => {
      client.destroy();
    });
    await clock.flush();
    client.write('first;');
    await clock.advance(50);
    gate.setOneWayMs(50);
    client.write('second;');
    await clock.advance(300);
    expect(received.join('')).toBe('');
    await clock.advance(100);
    expect(received.join('')).toBe('first;second;');
  });

  it('carries mTLS + HTTP/2 PeerSessions and DbDoor between A and B over PeerRelay when direct LAN fails', async () => {
    const clock = virtualClock();
    const gate = createDelayGate({ oneWayMs: 200, schedule: clock.schedule });
    const peerRelay = await createPeerRelay(gate);
    const certs = await dataCerts();
    const dbServer = await echoDbServer();

    const serverB = new PeerServer({
      held: () => certs.b.held,
      key: certs.b.key,
      crl: () => certs.crlPem,
      revoked: () => new Set(),
      door: { connect: () => Promise.reject(new Error('unused')) },
      db: { host: '127.0.0.1', port: dbServer.port },
      hello: () => ({ machine: MACHINE_B, role: 'data', lead: true, commit: 'ad5d2130', term: { number: 3, machine: NET_B, split: false } }),
      switches: { handle: async (_peer, _method, path) => ({ status: 200, body: { echoedPath: path } }) },
      log: () => undefined,
      now: () => new Date(clock.clocks().wall),
    });
    onTestFinished(() => serverB.close());
    const peerPortB = await serverB.listen(0, 'peer', '127.0.0.1');

    const dataServiceB = serviceName('acme', NET_B, 'data');
    const offerB = await peerRelay.offer({ [dataServiceB]: { host: '127.0.0.1', port: peerPortB } });
    const visitA = await peerRelay.visit([dataServiceB]);
    const deadDirectPort = await closedPort();

    const sessionsA = new PeerSessions({
      held: () => certs.a.held,
      key: certs.a.key,
      revoked: () => new Set(),
      own: () => ['127.0.0.1'],
      log: () => undefined,
      connectMs: 4000,
      everyMs: 1000,
      helloMs: 5000,
      pingMs: 10_000,
    });
    onTestFinished(() => sessionsA.close());
    sessionsA.use([
      {
        machine: MACHINE_B,
        networkId: NET_B,
        addresses: ['127.0.0.1'],
        peerPort: deadDirectPort,
        relayPort: visitA.ports[dataServiceB]!,
      },
    ]);

    /* TLS 1.3 + HTTP/2 hello takes 2 round trips (4 * 200 ms = 800 ms) over the peer relay. */
    await clock.advance(350);
    expect(sessionsA.reaches(MACHINE_B)).toBe(false);
    await clock.until(() => sessionsA.reaches(MACHINE_B), { maxMs: 1500 });
    expect(sessionsA.state()).toEqual({ path: 'relay', directFails: true, refused: false });
    expect(sessionsA.leader()?.machine).toBe(MACHINE_B);

    /* Each peer ask crosses the relay (1 round trip = 400 ms). */
    const askStart = clock.now();
    const asking = sessionsA.ask(NET_B, 'GET', '/peer/switch/status');
    await clock.advance(350);
    await clock.advance(100);
    expect(await asking).toEqual({ status: 200, body: { echoedPath: '/peer/switch/status' } });
    expect(clock.now() - askStart).toBeGreaterThanOrEqual(400);

    /* DbDoor streams database queries over HTTP/2 CONNECT db:5432 through PeerRelay with 2 * oneWayMs per trip. */
    const door = new DbDoor({
      connect: () => sessionsA.connectDb(MACHINE_B),
      allowed: async () => ['127.0.0.1'],
      log: () => undefined,
      host: '127.0.0.1',
    });
    onTestFinished(() => door.close());
    const doorPort = await door.listen(0);
    const dbStart = clock.now();
    const queried = askLine(doorPort, 'SELECT 1');
    await clock.advance(900);
    expect(await queried).toBe('db:SELECT 1');
    expect(clock.now() - dbStart).toBeGreaterThanOrEqual(800);

    /* Cutting the gate or closing B's offer tears down active relay streams. */
    gate.setCut(true);
    await clock.advance(100);
    expect(sessionsA.reaches(MACHINE_B)).toBe(false);
    await offerB.close();
  });
});
