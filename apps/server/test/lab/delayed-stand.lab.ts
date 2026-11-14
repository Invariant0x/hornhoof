import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { listenIn } from '../../../../test-support/ports.mjs';
import { loadConfig } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import { certificates, companies, departments, machines, people } from '../../src/db/schema.js';
import type { HeldCertificate } from '../../src/modules/keeper/certificate.js';
import { Keeper } from '../../src/modules/keeper/keeper.js';
import { LeaseHolder } from '../../src/modules/keeper/lease-holder.js';
import { leaseStore, type Sql } from '../../src/modules/keeper/lease-store.js';
import type { MachineKey } from '../../src/modules/keeper/machine-keys.js';
import { writeKeeperState } from '../../src/modules/keeper/state.js';
import { SyncController, type SyncCatalog } from '../../src/modules/keeper/sync.js';
import { PACE_FOR_MS } from '../../src/modules/keeper/sync-step.js';
import { linkClientId } from '../../src/modules/link/client.js';
import { saveLink } from '../../src/modules/link/link.js';
import { serviceName, type PeerServices } from '../../src/modules/link/peer-client.js';
import { Relay } from '../../src/modules/link/relay.js';
import { TunnelKeeper } from '../../src/modules/link/tunnel.js';
import { Merger } from '../../src/modules/merge/merger.js';
import type { MergeSource } from '../../src/modules/merge/source.js';
import { issueCertificate, makeAuthority, makeCrl } from '../../src/modules/network/authority.js';
import { authorityOf } from '../../src/modules/network/store.js';
import { DbDoor } from '../../src/net/db-door.js';
import { PeerServer } from '../../src/net/peer-server.js';
import { PeerSessions } from '../../src/net/peer-sessions.js';
import { fakeLease } from '../fake-lease.js';
import { fakeRelay } from '../fake-relay.js';
import { appOn, ownDatabases, setUpCompany, TEST_SECRET, testApp } from '../helpers.js';
import { openTestDb } from '../helpers-db.js';
import { forkOf, pgliteSource, type Side } from '../merge-fixture.js';
import { closedPort, createDelayGate, createPeerRelay, virtualClock } from './network.js';

/* Each scenario owns its PGlite databases and forks. */
ownDatabases();

const NET_A = 'aa11bb22'.repeat(8);
const NET_B = 'cc33dd44'.repeat(8);
const MACHINE_A_UUID = '11111111-0000-4000-8000-000000000001';
const MACHINE_B_UUID = '22222222-0000-4000-8000-000000000002';

type MergeRow = { source: string; status: string; error: string | null; path: string | null };

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function ed25519(): MachineKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privatePem: privateKey, publicPem: publicKey };
}

async function pairCerts(companyId: string, idA: string, idB: string) {
  const authority = await makeAuthority(companyId);
  const crlPem = await makeCrl(authority, []);
  const issue = async (machineId: string) => {
    const key = ed25519();
    const cert = await issueCertificate(authority, { machineId, role: 'data', signKey: key.publicPem });
    const held: HeldCertificate = {
      machine: machineId,
      role: 'data',
      certPem: cert.certPem,
      authorityPem: authority.certPem,
      until: cert.until.toISOString(),
    };
    return { key, held };
  };
  return { crlPem, a: await issue(idA), b: await issue(idB) };
}

/* Serves a MergeSource over TCP lines so every SQL query crosses DbDoor -> PeerSessions -> PeerRelay -> PeerServer. */
async function serveMergeSource(openSource: (label: string) => Promise<MergeSource>): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer(socket => {
    let source: MergeSource | null = null;
    let buffer = '';
    let chain = Promise.resolve();
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        chain = chain.then(async () => {
          const msg = JSON.parse(line) as { id: number; op: 'open' | 'query' | 'close'; label?: string; text?: string; params?: unknown[] };
          try {
            if (msg.op === 'open') {
              source = await openSource(msg.label ?? 'source');
              socket.write(`${JSON.stringify({ id: msg.id, ok: true })}\n`);
            } else if (msg.op === 'query') {
              const rows = await source!.query(msg.text!, msg.params);
              socket.write(`${JSON.stringify({ id: msg.id, ok: true, rows })}\n`);
            } else {
              await source?.close();
              source = null;
              socket.write(`${JSON.stringify({ id: msg.id, ok: true })}\n`);
            }
          } catch (err) {
            socket.write(`${JSON.stringify({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) })}\n`);
          }
        });
      }
    });
    socket.once('close', () => void source?.close().catch(() => undefined));
  });
  const port = await listenIn(server, '127.0.0.1');
  const close = () => new Promise<void>(resolve => server.close(() => resolve()));
  onTestFinished(close);
  return { port, close };
}

async function openOverDoor(port: number, label: string, onQuery?: () => void): Promise<MergeSource> {
  const socket = net.connect(port, '127.0.0.1');
  let seq = 0;
  let buffer = '';
  const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (err: Error) => void }>();
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop()!;
    for (const line of lines) {
      const reply = JSON.parse(line) as { id: number; ok: boolean; rows?: unknown[]; error?: string };
      const waiter = pending.get(reply.id);
      if (!waiter) continue;
      pending.delete(reply.id);
      if (reply.ok) waiter.resolve(reply.rows ?? []);
      else waiter.reject(new Error(reply.error ?? 'remote query failed'));
    }
  });
  socket.on('close', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('peer door closed'));
    pending.clear();
  });
  const rpc = (payload: Record<string, unknown>): Promise<unknown[]> =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      socket.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
  await rpc({ op: 'open', label });
  return {
    label,
    query: async <T>(text: string, params?: unknown[]) => {
      onQuery?.();
      return (await rpc({ op: 'query', text, params })) as T[];
    },
    close: async () => {
      await rpc({ op: 'close' }).catch(() => undefined);
      socket.destroy();
    },
  };
}

describe('delayed network lab verification of #825 items 1-4', () => {
  it('#825 item 1: merges a returned leader database over a 2 s RTT peer relay while renewing the lease and allowing writes', async () => {
    const clock = virtualClock();
    const gate = createDelayGate({ oneWayMs: 1000, schedule: clock.schedule });
    const peerRelay = await createPeerRelay(gate);

    const opened = await openTestDb();
    onTestFinished(() => opened.client.close());
    const control = tempDir('hh-lab-merge-');
    const { app, db } = await appOn(opened.client, { HORNHOOF_CONTROL_DIR: control });
    await setUpCompany(app);
    const [acme] = await db.select().from(companies);
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));

    /* Real LeaseStore + LeaseHolder on Machine A: 10 s lease renewed every 1 s when the DB session is free. */
    let renewals = 0;
    const pgliteSql: Sql = {
      query: async <R>(text: string, params?: unknown[]) => (await opened.client.query<R>(text, params)).rows ? { rows: (await opened.client.query<R>(text, params)).rows } : { rows: [] },
    };
    const rawStore = leaseStore(
      {
        query: async <R>(text: string, params?: unknown[]) => {
          const res = await opened.client.query<R>(text, params);
          return { rows: res.rows };
        },
      },
      { machineId: NET_A },
    );
    const holder = new LeaseHolder({
      lease: {
        ...rawStore,
        problems: async () => [],
        othersHoldData: async () => false,
        endSessions: async () => 0,
        renew: async (term, kind, until, ending, sync) => {
          const ok = await rawStore.renew(term, kind, until, ending, sync);
          if (ok) renewals += 1;
          return ok;
        },
      },
      updaterBusy: () => false,
      now: () => clock.clocks(),
      log: () => undefined,
    });
    await holder.look();
    await holder.tick();
    expect(holder.mode()).toBe('lead');

    const [machineB] = await db
      .insert(machines)
      .values({
        companyId: acme!.id,
        personId: owner!.id,
        machineKey: 'returned-leader-b',
        hostname: 'mac-b',
        role: 'data',
        networkId: NET_B,
        copyOld: 2,
        copyOldLed: 7,
        copyName: 'copy_cc33dd44_2',
        copyState: 'ready',
      })
      .returning();

    /* Machine B's old database from when it led, holding a department created while B was isolated. */
    const oldB: Side = await forkOf(opened.client);
    await oldB.client.exec(
      `INSERT INTO net_local.state (term_number, term_machine, machine, cluster) VALUES (7, '${NET_B}', '${NET_B}', 'cluster-b') ON CONFLICT (id) DO UPDATE SET term_number = 7, term_machine = '${NET_B}';
       INSERT INTO net_local.lease (term_number, term_machine, kind, until, sync) VALUES (7, '${NET_B}', 'normal', 'infinity', 'alone') ON CONFLICT (id) DO UPDATE SET until = 'infinity'`,
    );
    const [onlyOnB] = await oldB.db.insert(departments).values({ companyId: acme!.id, name: 'Written on B', roleCode: 'ONB' }).returning();

    /* Wire real PeerSessions (A) -> PeerRelay (1000 ms one-way = 2000 ms RTT) -> PeerServer (B) -> B's DB. */
    const certs = await pairCerts(acme!.id, MACHINE_A_UUID, machineB!.id);
    const bDb = await serveMergeSource(label => pgliteSource(oldB.client, label));
    const serverB = new PeerServer({
      held: () => certs.b.held,
      key: certs.b.key,
      crl: () => certs.crlPem,
      revoked: () => new Set(),
      door: { connect: () => Promise.reject(new Error('unused')) },
      db: { host: '127.0.0.1', port: bDb.port },
      hello: () => ({ machine: machineB!.id, role: 'data', lead: false, commit: 'ad5d2130' }),
      log: () => undefined,
      now: () => new Date(clock.clocks().wall),
    });
    onTestFinished(() => serverB.close());
    const peerPortB = await serverB.listen(0, 'peer', '127.0.0.1');
    const dataServiceB = serviceName('acme', NET_B, 'data');
    await peerRelay.offer({ [dataServiceB]: { host: '127.0.0.1', port: peerPortB } });
    const visitA = await peerRelay.visit([dataServiceB]);
    const sessionsA = new PeerSessions({
      held: () => certs.a.held,
      key: certs.a.key,
      revoked: () => new Set(),
      own: () => ['127.0.0.1'],
      log: () => undefined,
      connectMs: 10_000,
      everyMs: 2000,
      helloMs: 20_000,
      pingMs: 30_000,
    });
    onTestFinished(() => sessionsA.close());
    sessionsA.use([{ machine: machineB!.id, networkId: NET_B, addresses: ['127.0.0.1'], peerPort: await closedPort(), relayPort: visitA.ports[dataServiceB]! }]);
    await clock.until(() => sessionsA.reaches(machineB!.id), { maxMs: 8000, stepMs: 50 });

    const doorA = new DbDoor({
      connect: () => sessionsA.connectDb(machineB!.id),
      allowed: async () => ['127.0.0.1'],
      log: () => undefined,
      host: '127.0.0.1',
    });
    onTestFinished(() => doorA.close());
    const doorPort = await doorA.listen(0);
    writeKeeperState(control, { mode: 'lead', at: new Date(clock.clocks().wall).toISOString(), link: null, doors: { [NET_B]: doorPort } });

    let readsInTx = 0;
    let totalReads = 0;
    const merger = new Merger(
      app.ctx,
      { list: async () => [], open: async () => Promise.reject(new Error('none')), drop: async () => undefined },
      {
        peers: {
          open: (port, label) =>
            openOverDoor(port, label, () => {
              totalReads += 1;
              if (opened.client.isInTransaction()) readsInTx += 1;
            }),
        },
      },
    );

    await merger.discover();
    let mergeFinished = false;
    const merging = merger.tick().finally(() => void (mergeFinished = true));

    /* Advance 3 s into the slow network reads, then issue an ordinary company write through writeGate. */
    for (let s = 0; s < 3 && !mergeFinished; s++) {
      await clock.advance(1000, 50);
      if (!opened.client.isInTransaction()) await holder.tick();
    }
    const writeStart = clock.now();
    let writeWaitMs = -1;
    const writing = db
      .insert(departments)
      .values({ companyId: acme!.id, name: 'Written during merge', roleCode: 'LIVE' })
      .then(() => {
        writeWaitMs = clock.now() - writeStart;
      });

    for (let step = 0; step < 300 && !mergeFinished; step++) {
      await clock.advance(1000, 50);
      if (!opened.client.isInTransaction()) await holder.tick();
    }
    await merging;
    await writing;
    void pgliteSql;

    const { rows: mergeRows } = (await db.execute(sql`SELECT source, status, error, path FROM net.merges`)) as unknown as { rows: MergeRow[] };
    expect(totalReads).toBeGreaterThan(5);
    expect(readsInTx).toBe(0);
    expect(writeWaitMs).toBeLessThan(1000);
    expect(renewals).toBeGreaterThanOrEqual(10);
    expect(mergeRows[0]).toMatchObject({ status: 'merged', error: null });
    expect(await db.select().from(departments).where(eq(departments.id, onlyOnB!.id))).toHaveLength(1);
  });

  it('#825 item 2: keeps the leader lease when the first copy finishes under a 2.4 s two-hop link probe and logs missing proof on cut', async () => {
    const clock = virtualClock();
    const gate = createDelayGate({ oneWayMs: 600, schedule: clock.schedule });
    const upstream = await fakeRelay();
    const { app, db, config } = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: NET_A });
    await setUpCompany(app);
    const [acme] = await db.select().from(companies);
    await saveLink(db, config, acme!.id, {
      name: 'acme',
      url: 'https://acme.hornhoof.test',
      key: 'k'.repeat(32),
      tunnel: { serverAddr: 'relay.hornhoof.test', serverPort: 443, protocol: 'wss' },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const appPort = (app.server.address() as AddressInfo).port;

    let copyReady = false;
    let linkDoorPort = 0;
    const edge = await gate.httpProxy('http://127.0.0.1:1', { hops: 2 });
    await edge.close();
    /* Proxy whose upstream port resolves dynamically to keeper's linkHttp door once started (2 hops = 4 * 600 ms = 2400 ms). */
    const forwarder = http.createServer((req, res) => {
      const ask = http.request({ hostname: '127.0.0.1', port: linkDoorPort, path: req.url, method: req.method }, up => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      ask.on('error', () => res.writeHead(502).end());
      ask.end();
    });
    const forwardPort = await listenIn(forwarder, '127.0.0.1');
    onTestFinished(() => new Promise<void>(resolve => forwarder.close(() => resolve())));
    const twoHopEdge = await gate.httpProxy(`http://127.0.0.1:${forwardPort}`, { hops: 2 });

    const lines: string[] = [];
    const keeper = new Keeper({
      config: loadConfig({ HORNHOOF_SECRET: TEST_SECRET, HORNHOOF_CONTROL_DIR: tempDir('hh-ctrl-2-'), HORNHOOF_MACHINE_ID: NET_A, ACME_DIRECTORY: 'off' }),
      db: db as unknown as Db,
      lease: fakeLease(),
      now: () => clock.clocks(),
      app: { host: '127.0.0.1', port: appPort },
      frontHost: null,
      log: line => lines.push(line),
      host: '127.0.0.1',
      ports: { front: 0, linkHttp: 0, linkTls: 0, peer: 0, peerApp: 0 },
      everyMs: 1000,
      linkEveryMs: 1000,
      peerEveryMs: 60_000,
      reportEveryMs: 3_600_000,
      dir: tempDir('hh-keeper-2-'),
      clientFor: () => ({ program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }),
      peerClientFor: () => ({ program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }),
      proofs: {
        needed: async () => copyReady,
        probe: async nonce => {
          const res = await fetch(`${twoHopEdge.url}/api/network/lease?nonce=${nonce}`);
          return res.ok ? ((await res.json()) as { machine: string; nonce: string }) : null;
        },
        ownTerm: async () => ({ number: 1, machine: NET_A, split: false }),
        poll: async () => ({
          sent: clock.clocks(),
          replied: clock.clocks().mono,
          route: { known: false, why: 'unreachable' },
          health: { up: false, relayStarted: null },
        }),
        follow: async () => undefined,
        everyMs: 1000,
      },
    });
    const ports = await keeper.start();
    onTestFinished(() => keeper.stop());
    linkDoorPort = ports.linkHttp;
    void upstream;

    expect(keeper.mode()).toBe('lead');
    /* Copy B finishes initial sync: proofs become required while each 2-RTT link probe takes 2400 ms (> old 2000 ms). */
    copyReady = true;
    await clock.advance(16_000, 50);
    expect(keeper.mode()).toBe('lead');
    expect(lines.some(line => line.startsWith('The lease ended'))).toBe(false);

    /* Now cut the public link: keeper must log which proof is missing before the lease expires. */
    gate.setCut(true);
    await clock.advance(6000, 50);
    expect(lines.some(line => line.includes('missing proof'))).toBe(true);
  });

  it('#825 item 3: restores sync record at hornhoof.org after a 10 s peer cut when WAL confirmation RTT is 1.5 s and logs 503 unknown', async () => {
    const clock = virtualClock();
    const relayGate = createDelayGate({ oneWayMs: 300, schedule: clock.schedule });
    const peerGate = createDelayGate({ oneWayMs: 750, schedule: clock.schedule });
    const upstream = await fakeRelay();
    const client = linkClientId('acme', NET_A);
    upstream.bindings.set('acme', { key: 'k'.repeat(32) });
    upstream.register('acme', client);

    let failNextSync503 = false;
    const relayProxy = await relayGate.httpProxy(upstream.url, {
      beforeForward: req => {
        if (failNextSync503 && req.method === 'POST' && String(req.url).endsWith('/sync')) {
          upstream.frpsDown = true;
          failNextSync503 = false;
        } else if (upstream.frpsDown && req.method === 'GET') {
          upstream.frpsDown = false;
        }
      },
    });

    const copyName = 'copy_cc33dd44_1';
    let lsnSeq = 100;
    let position = `0/${lsnSeq.toString(16).padStart(7, '0')}`;
    let confirmed = position;
    let replySeq = 1;
    let replyTime = `r${replySeq}`;
    let syncState: string | null = 'async';
    let setting: string | null = null;

    /* Continuous company writes advance leader WAL position every 250 ms; B confirms over peerGate (2 * 750 ms = 1500 ms RTT). */
    const writer = setInterval(() => {
      lsnSeq += 1;
      const written = `0/${lsnSeq.toString(16).padStart(7, '0')}`;
      position = written;
      void peerGate.wait(2).then(delivered => {
        if (!delivered) return;
        confirmed = written;
        replySeq += 1;
        replyTime = `r${replySeq}`;
      });
    }, 250);
    writer.unref();
    onTestFinished(() => clearInterval(writer));

    const catalog: SyncCatalog = {
      machines: async () => [{ machine: MACHINE_B_UUID, networkId: NET_B, number: 2, copyName, ready: true }],
      replication: async () => (peerGate.cut() ? [{ name: copyName, confirmed, pid: 41, replyTime, syncState }] : [{ name: copyName, confirmed, pid: 41, replyTime, syncState }]),
      setting: async () => setting,
      position: async () => position,
      oldestWaitMs: async () => null,
      set: async name => {
        setting = name;
        syncState = 'sync';
      },
      clear: async () => {
        setting = null;
        syncState = 'async';
      },
      checkpoint: async () => undefined,
      pulse: async () => undefined,
      moveTarget: async () => null,
    };

    const lines: string[] = [];
    const controller = new SyncController({
      catalog,
      relay: new Relay(relayProxy.url),
      link: async () => ({ name: 'acme', key: 'k'.repeat(32), client }),
      dbBytes: () => 0,
      leads: () => true,
      log: line => lines.push(line),
      now: () => clock.clocks().mono,
      everyMs: 250,
      routeEveryMs: 2000,
    });
    await controller.start();
    onTestFinished(() => controller.stop());

    /* Initial naming across the 1.5 s WAL lag + 600 ms relay RTT. */
    await clock.advance(PACE_FOR_MS + 8000, 50);
    expect(upstream.syncs.get('acme')).toMatchObject({ state: 'on', copy: NET_B });

    /* 10 s peer cut drops sync to off at the relay. */
    peerGate.setCut(true);
    await clock.advance(10_000, 50);
    expect(upstream.syncs.get('acme')).toMatchObject({ state: 'off' });

    /* Mending the peer path must bring hornhoof.org's sync record back to state 'on' naming B despite 1.5 s RTT. */
    peerGate.setCut(false);
    failNextSync503 = true;
    await clock.advance(PACE_FOR_MS + 12_000, 50);
    upstream.frpsDown = false;
    await clock.advance(4000, 50);

    expect(upstream.syncs.get('acme')).toMatchObject({ state: 'on', copy: NET_B });
    expect(lines.some(line => line.includes('503 unknown'))).toBe(true);
  });

  it('#825 item 4: keeps leader peer and link tunnels running over PeerRelay through a single empty read and brief mode dip', async () => {
    const clock = virtualClock();
    const gate = createDelayGate({ oneWayMs: 250, schedule: clock.schedule });
    const peerRelay = await createPeerRelay(gate);

    const { app, db, config } = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: NET_A });
    await setUpCompany(app);
    const [acme] = await db.select().from(companies);
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    await saveLink(db, config, acme!.id, {
      name: 'acme',
      url: 'https://acme.hornhoof.test',
      key: 'k'.repeat(32),
      tunnel: { serverAddr: 'relay.hornhoof.test', serverPort: 443, protocol: 'wss' },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const appPort = (app.server.address() as AddressInfo).port;

    let dipFenceOnce = false;
    const baseLease = fakeLease();
    const lines: string[] = [];
    let peerOffersStarted = 0;

    const keeper = new Keeper({
      config: loadConfig({ HORNHOOF_SECRET: TEST_SECRET, HORNHOOF_CONTROL_DIR: tempDir('hh-ctrl-4-'), HORNHOOF_MACHINE_ID: NET_A, ACME_DIRECTORY: 'off' }),
      db: db as unknown as Db,
      lease: {
        ...baseLease,
        problems: async () => {
          if (!dipFenceOnce) return [];
          dipFenceOnce = false;
          return ['transient check hiccup'];
        },
      },
      now: () => clock.clocks(),
      app: { host: '127.0.0.1', port: appPort },
      frontHost: null,
      log: line => lines.push(line),
      host: '127.0.0.1',
      ports: { front: 0, linkHttp: 0, linkTls: 0, peer: 0, peerApp: 0 },
      everyMs: 1000,
      linkEveryMs: 1000,
      peerEveryMs: 500,
      reportEveryMs: 3_600_000,
      dir: tempDir('hh-keeper-4-'),
      clientFor: () => ({ program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }),
      peerClientFor: (_services: PeerServices, _clientId: string, local: { data: number; app: number }) => {
        peerOffersStarted += 1;
        const dataServiceA = serviceName('acme', NET_A, 'data');
        void peerRelay.offer({ [dataServiceA]: { host: '127.0.0.1', port: local.data } });
        return { program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] };
      },
    });
    await keeper.start();
    onTestFinished(() => keeper.stop());
    await clock.until(() => peerOffersStarted === 1, { maxMs: 5000, stepMs: 50 });

    /* Issue Machine B's data certificate under the company's real authority and connect B -> PeerRelay -> A. */
    const keyB = ed25519();
    const [rowB] = await db
      .insert(machines)
      .values({ companyId: acme!.id, personId: owner!.id, machineKey: 'copy-b', role: 'data', networkId: NET_B, signKey: keyB.publicPem })
      .returning();
    const auth = (await authorityOf(db as unknown as Db, config))!;
    const issuedB = await issueCertificate(auth, { machineId: rowB!.id, role: 'data', signKey: keyB.publicPem });
    await db.insert(certificates).values({ serial: issuedB.serial, machineId: rowB!.id, until: issuedB.until });
    const heldB: HeldCertificate = { machine: rowB!.id, role: 'data', certPem: issuedB.certPem, authorityPem: auth.certPem, until: issuedB.until.toISOString() };

    const rowA = (await db.select().from(machines)).find(m => m.networkId === NET_A)!;
    const dataServiceA = serviceName('acme', NET_A, 'data');
    const visitB = await peerRelay.visit([dataServiceA]);
    const sessionsB = new PeerSessions({
      held: () => heldB,
      key: keyB,
      revoked: () => new Set(),
      own: () => ['127.0.0.1'],
      log: () => undefined,
      connectMs: 5000,
      everyMs: 1000,
    });
    onTestFinished(() => sessionsB.close());
    sessionsB.use([{ machine: rowA.id, networkId: NET_A, addresses: ['127.0.0.1'], peerPort: await closedPort(), relayPort: visitB.ports[dataServiceA]! }]);
    await clock.until(() => sessionsB.reaches(rowA.id), { maxMs: 5000, stepMs: 50 });

    /* 1) Brief 1-tick dip out of lead (the ~6-minute hiccup): PeerLink must NOT stop and restart its peer frpc offer. */
    dipFenceOnce = true;
    await clock.advance(4500, 50);
    expect(keeper.mode()).toBe('lead');
    expect(peerOffersStarted).toBe(1);
    expect(lines).not.toContain('No public link: this machine is not offered to its peers through it.');
    expect(sessionsB.reaches(rowA.id)).toBe(true);

    /* 2) Single empty read on TunnelKeeper must NOT tear down a running tunnel; two consecutive empty reads do. */
    const reads: Array<{ name: string } | null> = [{ name: 'acme' }, null, { name: 'acme' }, null, null];
    let idx = 0;
    let starts = 0;
    const tk = new TunnelKeeper<{ name: string }>({
      read: async () => reads[Math.min(idx++, reads.length - 1)]!,
      everyMs: 1000,
      restartMs: 500,
      clientFor: () => {
        starts += 1;
        return { program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] };
      },
      log: () => undefined,
    });
    tk.start();
    onTestFinished(() => tk.stop());
    await clock.advance(2500, 50);
    expect(starts).toBe(1);
  });
});
