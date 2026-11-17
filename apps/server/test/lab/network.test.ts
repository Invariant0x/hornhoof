import http from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { listenIn } from '../../../../test-support/ports.mjs';
import { LeaseProofs } from '../../src/modules/keeper/proofs.js';
import type { HeldCertificate } from '../../src/modules/keeper/certificate.js';
import { serviceName } from '../../src/modules/link/peer-client.js';
import { Relay } from '../../src/modules/link/relay.js';
import { issueCertificate, makeAuthority, makeCrl } from '../../src/modules/network/authority.js';
import { DbDoor } from '../../src/net/db-door.js';
import { PeerServer } from '../../src/net/peer-server.js';
import { PeerSessions } from '../../src/net/peer-sessions.js';
import { fakeRelay } from '../fake-relay.js';
import { bridgeScript, directPeerBlockScript, keeperTcpProbeCommand, probeKeeperTcp, type Ran } from './lab.js';
import { createDelayGate, createPeerRelay, ed25519Key, virtualClock } from './network.js';
import { closedPort } from '../closed-port.js';

const COMPANY_ID = '00000000-0000-4000-8000-0000000000aa';
const MACHINE_A = '11111111-0000-4000-8000-000000000001';
const MACHINE_B = '22222222-0000-4000-8000-000000000002';
const NET_A = 'aa11bb22'.repeat(8);
const NET_B = 'cc33dd44'.repeat(8);

async function dataCerts() {
  const authority = await makeAuthority(COMPANY_ID);
  const crlPem = await makeCrl(authority, []);
  const make = async (machineId: string) => {
    const key = ed25519Key();
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
  const sockets = new Set<net.Socket>();
  const server = net.createServer({ noDelay: true }, socket => {
    socket.setNoDelay(true);
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
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
  onTestFinished(
    () =>
      new Promise<void>(resolve => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  );
  return { port };
}

function askLine(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1', noDelay: true }, () => socket.write(`${text}\n`));
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
    onTestFinished(() => new Promise<void>(resolve => (keeperDoor.closeAllConnections(), keeperDoor.close(() => resolve()))));

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
    const sinkSockets = new Set<net.Socket>();
    const sink = net.createServer(socket => {
      sinkSockets.add(socket);
      socket.once('close', () => sinkSockets.delete(socket));
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => received.push(chunk));
    });
    const sinkPort = await listenIn(sink, '127.0.0.1');
    onTestFinished(
      () =>
        new Promise<void>(resolve => {
          for (const s of sinkSockets) s.destroy();
          sink.close(() => resolve());
        }),
    );
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

  it('preserves byte order across 4000 writes through tcpProxy under fractional delays and sub-ms clock steps', async () => {
    const clock = virtualClock();
    await clock.advance(13);
    let subMs = 0;
    const subMsSchedule = {
      ...clock.schedule,
      /* Models monotonic sub-millisecond performance.now() progression where (now + 20) - now alternates around 20. */
      now: () => clock.schedule.now() + (subMs += 0.00005),
    };

    for (const [schedule, oneWayMs] of [
      [subMsSchedule, 20],
      [clock.schedule, 7.35],
    ] as const) {
      const gate = createDelayGate({ oneWayMs, schedule });
      const got: number[] = [];
      let buf = Buffer.alloc(0);
      const count = 4000;
      const sinkSockets = new Set<net.Socket>();
      const sink = net.createServer({ noDelay: true }, socket => {
        socket.setNoDelay(true);
        sinkSockets.add(socket);
        socket.once('close', () => sinkSockets.delete(socket));
        socket.on('data', (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          while (buf.length >= 4) {
            got.push(buf.readUInt32BE(0));
            buf = buf.subarray(4);
          }
        });
      });
      const sinkPort = await listenIn(sink, '127.0.0.1');
      const proxy = await gate.tcpProxy({ host: '127.0.0.1', port: sinkPort });
      const client = net.connect({ port: proxy.port, host: '127.0.0.1', noDelay: true });
      await new Promise<void>(resolve => client.once('connect', resolve));

      for (let i = 0; i < count; i++) {
        const b = Buffer.alloc(4);
        b.writeUInt32BE(i);
        client.write(b);
        if (i % 3 === 0) await clock.flush(1);
      }
      await clock.until(() => got.length === count, { maxMs: 500, stepMs: 1 });
      const firstOutOfOrder = got.findIndex((v, i) => v !== i);
      client.destroy();
      await proxy.close();
      for (const s of sinkSockets) s.destroy();
      await new Promise<void>(resolve => sink.close(() => resolve()));
      expect(firstOutOfOrder).toBe(-1);
    }
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
    let askReply: { status: number; body: unknown } | null | undefined;
    void sessionsA.ask(NET_B, 'GET', '/peer/switch/status').then(res => {
      askReply = res;
    });
    await clock.advance(350);
    expect(askReply).toBeUndefined();
    await clock.until(() => askReply !== undefined, { maxMs: 1000 });
    expect(askReply).toEqual({ status: 200, body: { echoedPath: '/peer/switch/status' } });
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
    let dbAnswer: string | undefined;
    void askLine(doorPort, 'SELECT 1').then(res => {
      dbAnswer = res;
    });
    await clock.advance(750);
    expect(dbAnswer).toBeUndefined();
    await clock.until(() => dbAnswer !== undefined, { maxMs: 1500 });
    expect(dbAnswer).toBe('db:SELECT 1');
    expect(clock.now() - dbStart).toBeGreaterThanOrEqual(800);

    /* Cutting the gate or closing B's offer tears down active relay streams. */
    gate.setCut(true);
    await clock.advance(100);
    expect(sessionsA.reaches(MACHINE_B)).toBe(false);
    await offerB.close();
  });

  it('builds FORWARD and DOCKER-USER TCP-RST rules for blockDirect and probes TCP inside keeper rather than on docker:dind', async () => {
    const installCmd = directPeerBlockScript(true, 8180, 7070);
    expect(installCmd).toContain('DOCKER-USER ! -i lo -p tcp -m conntrack --ctorigdstport 8180 -j REJECT --reject-with tcp-reset');
    expect(installCmd).toContain('DOCKER-USER ! -i lo -p tcp --dport 7070 -j REJECT --reject-with tcp-reset');
    expect(installCmd).toContain('FORWARD ! -i lo -p tcp --dport 7070 -j REJECT --reject-with tcp-reset');
    expect(installCmd).toContain('INPUT ! -i lo -p tcp --dport 8180 -j REJECT --reject-with tcp-reset');
    const removeCmd = directPeerBlockScript(false, 8180, 7070);
    expect(removeCmd).toContain('iptables -D DOCKER-USER');
    expect(removeCmd).toContain('iptables -D FORWARD');
    expect(removeCmd).toContain('iptables -D INPUT');

    /* Exercise the generated bridgeScript and keeper TCP probe on virtual time: LabMachine (machine.Dockerfile:
       docker:28.5.2-dind + bash/curl/jq/coreutils/iptables) lacks node, whereas container keeper (root Dockerfile:
       node:22.23.4-alpine) has node. */
    const clock = virtualClock();
    const gate = createDelayGate({ oneWayMs: 120, schedule: clock.schedule });
    const relay = await createPeerRelay(gate);
    const backend = await echoDbServer();
    const svc = serviceName('acme', NET_A, 'data');

    const bridgeSockets = new Set<net.Socket>();
    const bridgeServers = new Set<net.Server>();
    let bridgeStopped = false;
    let visitorPort = 0;
    const listeningPromises: Array<Promise<void>> = [];
    const trackedNet = {
      connect: (...args: Parameters<typeof net.connect>) => {
        const s = net.connect(...args);
        bridgeSockets.add(s);
        s.once('close', () => bridgeSockets.delete(s));
        return s;
      },
      createServer: (...args: Parameters<typeof net.createServer>) => {
        const srv = net.createServer(...args);
        bridgeServers.add(srv);
        listeningPromises.push(
          new Promise<void>(resolve => {
            srv.once('listening', () => {
              visitorPort = (srv.address() as net.AddressInfo).port;
              resolve();
            });
          }),
        );
        return srv;
      },
    };
    const runBridge = (code: string): void => {
      vm.runInNewContext(code, {
        require: (id: string) => {
          if (id !== 'node:net') throw new Error(`unexpected module ${id}`);
          return trackedNet;
        },
        setTimeout: (fn: () => void, ms: number) => {
          if (!bridgeStopped) clock.schedule.after(ms, () => !bridgeStopped && fn());
        },
        process: {
          exit: (codeNum: number) => {
            throw new Error(`bridgeScript exited with ${codeNum}`);
          },
        },
      });
    };
    onTestFinished(async () => {
      bridgeStopped = true;
      for (const s of bridgeSockets) s.destroy();
      await Promise.all([...bridgeServers].map(srv => new Promise<void>(resolve => srv.close(() => resolve()))));
    });

    runBridge(bridgeScript('127.0.0.1', relay.port, { [svc]: backend.port }, []));
    runBridge(bridgeScript('127.0.0.1', relay.port, {}, [{ port: 0, service: svc }]));
    await Promise.all(listeningPromises);
    await clock.flush();
    expect(visitorPort).toBeGreaterThan(0);

    const ranCommands: string[] = [];
    const deadDirect = 8180;
    const probeTargets: { host: string; port: number; timeout: number }[] = [];
    const dindMachine = {
      exec: (cmd: string): Promise<Ran> => {
        ranCommands.push(cmd);
        /* On docker:28.5.2-dind, invoking node outside `docker compose exec -T keeper` fails with exit code 127. */
        const match = /^cd '([^']+)' && docker compose exec -T keeper node -e '([\s\S]+)'$/.exec(cmd);
        if (!match) {
          return Promise.resolve({ code: 127, out: 'bash: line 1: node: command not found\n' });
        }
        const script = match[2]!.replaceAll(`'\\''`, "'");
        return new Promise<Ran>(resolve => {
          const lines: string[] = [];
          let settled = false;
          const finish = (code: number) => {
            if (settled) return;
            settled = true;
            resolve({ code, out: lines.length ? `${lines.join('\n')}\n` : '' });
          };
          vm.runInNewContext(script, {
            require: (id: string) => {
              if (id !== 'node:net') throw new Error(`unexpected module ${id}`);
              /* Recorded connect results test our generated probe, without depending on an unowned port. */
              return { connect: (target: { host: string; port: number; timeout: number }, connected: () => void) => {
                probeTargets.push(target);
                const socket = new net.Socket();
                queueMicrotask(() => target.port === deadDirect ? socket.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })) : connected());
                return socket;
              } };
            },
            console: { log: (...parts: unknown[]) => lines.push(parts.map(String).join(' ')) },
            process: { exit: finish },
          });
        });
      },
    };

    const directRes = await probeKeeperTcp({ machine: dindMachine, folder: '/root/hornhoof-abcdef' }, '127.0.0.1', deadDirect);
    expect(directRes.code, directRes.out).toBe(1);
    expect(directRes.out.trim()).toBe('REJECTED:ECONNREFUSED');

    const builtCmd = keeperTcpProbeCommand('/root/hornhoof-abcdef', '10.200.4.2', 8180);
    expect(builtCmd).toMatch(/^cd '\/root\/hornhoof-abcdef' && docker compose exec -T keeper node -e '/);

    const relayedRes = await probeKeeperTcp({ machine: dindMachine, folder: '/root/hornhoof-abcdef' }, '127.0.0.1', visitorPort);
    expect(relayedRes.code, relayedRes.out).toBe(0);
    expect(relayedRes.out.trim()).toBe('CONNECTED');
    expect(ranCommands).toHaveLength(2);
    expect(probeTargets).toEqual([{ host: '127.0.0.1', port: deadDirect, timeout: 3000 }, { host: '127.0.0.1', port: visitorPort, timeout: 3000 }]);

    let relayedReply: string | undefined;
    void askLine(visitorPort, 'PING').then(res => {
      relayedReply = res;
    });
    await clock.advance(200);
    expect(relayedReply).toBeUndefined();
    await clock.until(() => relayedReply !== undefined, { maxMs: 1000 });
    expect(relayedReply).toBe('db:PING');
  });
});
