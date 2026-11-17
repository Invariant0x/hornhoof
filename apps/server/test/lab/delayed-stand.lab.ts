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
import { writeKeeperState } from '../../src/modules/keeper/state.js';
import { SyncController, type SyncCatalog } from '../../src/modules/keeper/sync.js';
import { PACE_FOR_MS } from '../../src/modules/keeper/sync-step.js';
import { linkClientId } from '../../src/modules/link/client.js';
import { saveLink } from '../../src/modules/link/link.js';
import { serviceName, type PeerServices } from '../../src/modules/link/peer-client.js';
import { Relay } from '../../src/modules/link/relay.js';
import { Merger } from '../../src/modules/merge/merger.js';
import type { MergeSource } from '../../src/modules/merge/source.js';
import { issueCertificate, makeAuthority, makeCrl } from '../../src/modules/network/authority.js';
import { authorityOf } from '../../src/modules/network/store.js';
import { DbDoor } from '../../src/net/db-door.js';
import { PGlite } from '@electric-sql/pglite';
import { PeerServer } from '../../src/net/peer-server.js';
import { PeerSessions } from '../../src/net/peer-sessions.js';
import { fakeLease } from '../fake-lease.js';
import { fakeRelay } from '../fake-relay.js';
import { appOn, setUpCompany, TEST_SECRET } from '../helpers.js';
import { forkOf, pgliteSource, type Side } from '../merge-fixture.js';
import { migratedPgliteDump, readPgliteTemplate } from '../prepare-environment.js';
import { createDelayGate, createPeerRelay, ed25519Key, virtualClock } from './network.js';
import { closedPort } from '../closed-port.js';

let migratedTemplate: Blob | undefined;

async function standClient(): Promise<PGlite> {
  if (!migratedTemplate) {
    const dir = process.env.HH_PGLITE_TEMPLATE;
    const bytes = (dir ? readPgliteTemplate(dir) : null) ?? (await migratedPgliteDump());
    migratedTemplate = new Blob([new Uint8Array(bytes)]);
  }
  const client = new PGlite({ loadDataDir: migratedTemplate });
  await client.waitReady;
  onTestFinished(() => client.close());
  return client;
}

async function standApp(env: NodeJS.ProcessEnv = {}) {
  const client = await standClient();
  const built = await appOn(client, env);
  return { ...built, client };
}

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

async function pairCerts(companyId: string, idA: string, idB: string) {
  const authority = await makeAuthority(companyId);
  const crlPem = await makeCrl(authority, []);
  const issue = async (machineId: string) => {
    const key = ed25519Key();
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
  const sockets = new Set<net.Socket>();
  const server = net.createServer({ noDelay: true }, socket => {
    socket.setNoDelay(true);
    sockets.add(socket);
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
    socket.once('close', () => {
      sockets.delete(socket);
      void source?.close().catch(() => undefined);
    });
  });
  const port = await listenIn(server, '127.0.0.1');
  const close = () =>
    new Promise<void>(resolve => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  onTestFinished(close);
  return { port, close };
}

async function openOverDoor(port: number, label: string, onQuery?: () => void): Promise<MergeSource> {
  const socket = net.connect({ port, host: '127.0.0.1', noDelay: true });
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

describe('delayed network lab verification of peer merge, lease proofs, sync recovery and relay silence', () => {
  it('merges a returned leader database over a 2 s RTT peer relay while renewing the lease and allowing writes', async () => {
    const clock = virtualClock();
    const gate = createDelayGate({ oneWayMs: 1000, schedule: clock.schedule });
    const peerRelay = await createPeerRelay(gate);

    const client = await standClient();
    const control = tempDir('hh-lab-merge-');
    const { app, db } = await appOn(client, { HORNHOOF_CONTROL_DIR: control });
    await setUpCompany(app);
    const [acme] = await db.select().from(companies);
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));

    /* Real LeaseStore + LeaseHolder on Machine A: 10 s lease renewed every 1 s when the DB session is free. */
    let renewals = 0;
    const sqlOnA: Sql = {
      query: async <R>(text: string, params?: unknown[]) => {
        const res = await client.query<R>(text, params);
        return { rows: res.rows };
      },
    };
    const rawStore = leaseStore(sqlOnA, { machineId: NET_A });
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
    const oldB: Side = await forkOf(client);
    await oldB.client.exec(
      `INSERT INTO net_local.state (term_number, term_machine, machine, cluster) VALUES (7, '${NET_B}', '${NET_B}', 'cluster-b') ON CONFLICT (id) DO UPDATE SET term_number = 7, term_machine = '${NET_B}', machine = '${NET_B}';
       INSERT INTO net_local.lease (term_number, term_machine, kind, until, sync) VALUES (7, '${NET_B}', 'normal', 'infinity', 'alone') ON CONFLICT (id) DO UPDATE SET term_number = 7, term_machine = '${NET_B}', kind = 'normal', until = 'infinity', sync = 'alone'`,
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
    onTestFinished(() => clock.restore());
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
              if (client.isInTransaction()) readsInTx += 1;
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
      if (!client.isInTransaction()) await holder.tick();
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
      if (!client.isInTransaction()) await holder.tick();
    }
    await merging;
    await writing;

    const { rows: mergeRows } = (await db.execute(sql`SELECT source, status, error, path FROM net.merges`)) as unknown as { rows: MergeRow[] };
    expect(totalReads).toBeGreaterThan(5);
    expect(readsInTx).toBe(0);
    expect(writeWaitMs).toBeLessThan(1000);
    expect(renewals).toBeGreaterThanOrEqual(10);
    expect(mergeRows[0]).toMatchObject({ status: 'merged', error: null });
    expect(await db.select().from(departments).where(eq(departments.id, onlyOnB!.id))).toHaveLength(1);
  });

  it('keeps the leader lease when the first copy finishes under a 2.4 s two-hop link probe and logs missing proof on cut', async () => {
    const clock = virtualClock();
    const gate = createDelayGate({ oneWayMs: 600, schedule: clock.schedule });
    const { app, db, config } = await standApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: NET_A });
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
    /* Proxy whose upstream port resolves dynamically to keeper's linkHttp door once started (2 hops = 4 * 600 ms = 2400 ms). */
    const forwarder = http.createServer((req, res) => {
      const ask = http.request({ hostname: '127.0.0.1', port: linkDoorPort, path: req.url, method: req.method, agent: false }, up => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      ask.on('error', () => res.writeHead(502).end());
      ask.end();
    });
    const forwardPort = await listenIn(forwarder, '127.0.0.1');
    onTestFinished(() => new Promise<void>(resolve => (forwarder.closeAllConnections(), forwarder.close(() => resolve()))));
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
    onTestFinished(async () => {
      clock.restore();
      await gate.close();
      await keeper.stop();
    });
    linkDoorPort = ports.linkHttp;

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

  it('restores sync record at hornhoof.org after a 10 s peer cut when WAL confirmation RTT is 1.5 s and logs 503 unknown', async () => {
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
    const starting = controller.start();
    onTestFinished(async () => {
      clock.restore();
      clearInterval(writer);
      await relayGate.close();
      await peerGate.close();
      await controller.stop();
    });
    await clock.advance(2500, 50);
    await starting;

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

  it('keeps leader on lead and its one peer offer through a 4 s delayed-relay silence and brief mode dip', async () => {
    const clock = virtualClock();
    const peerGate = createDelayGate({ oneWayMs: 250, schedule: clock.schedule });
    const relayGate = createDelayGate({ oneWayMs: 150, schedule: clock.schedule });
    const peerRelay = await createPeerRelay(peerGate);
    const upstream = await fakeRelay();
    upstream.bindings.set('acme', { key: 'k'.repeat(32) });
    upstream.register('acme', linkClientId('acme', NET_A));
    const relayProxy = await relayGate.httpProxy(upstream.url);

    const { app, db, config } = await standApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: NET_A });
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

    const copyName = `copy_${NET_B.slice(0, 16)}_1`;
    const catalog: SyncCatalog = {
      machines: async () => [{ machine: MACHINE_B_UUID, networkId: NET_B, number: 2, copyName, ready: false }],
      replication: async () => [],
      setting: async () => null,
      position: async () => '0/3000000',
      oldestWaitMs: async () => null,
      set: async () => undefined,
      clear: async () => undefined,
      checkpoint: async () => undefined,
      pulse: async () => undefined,
      moveTarget: async () => null,
    };

    const STOP_LINE = 'No public link: this machine is not offered to its peers through it.';
    let fenceActive = false;
    let activeOffer: { close(): Promise<void> } | null = null;
    const baseLease = fakeLease({ othersHoldData: true });
    const lines: string[] = [];
    let peerOffersStarted = 0;
    let linkStarts = 0;
    let peerStartedAt = 0;

    const keeper = new Keeper({
      config: loadConfig({ HORNHOOF_SECRET: TEST_SECRET, HORNHOOF_CONTROL_DIR: tempDir('hh-ctrl-4-'), HORNHOOF_MACHINE_ID: NET_A, ACME_DIRECTORY: 'off' }),
      db: db as unknown as Db,
      lease: {
        ...baseLease,
        problems: async () => (fenceActive ? ['transient check hiccup'] : []),
      },
      now: () => clock.clocks(),
      app: { host: '127.0.0.1', port: appPort },
      frontHost: null,
      log: line => {
        lines.push(line);
        if (line === STOP_LINE && activeOffer) {
          const closing = activeOffer;
          activeOffer = null;
          void closing.close();
        }
      },
      host: '127.0.0.1',
      ports: { front: 0, linkHttp: 0, linkTls: 0, peer: 0, peerApp: 0 },
      everyMs: 1000,
      linkEveryMs: 1000,
      peerEveryMs: 500,
      guardEveryMs: 500,
      reportEveryMs: 3_600_000,
      dir: tempDir('hh-keeper-4-'),
      sync: { catalog, relay: new Relay(relayProxy.url), everyMs: 1000, routeEveryMs: 0 },
      clientFor: () => {
        linkStarts += 1;
        return { program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] };
      },
      peerClientFor: (_services: PeerServices, _clientId: string, local: { data: number; app: number }) => {
        peerOffersStarted += 1;
        if (peerOffersStarted === 1) peerStartedAt = clock.now();
        const dataServiceA = serviceName('acme', NET_A, 'data');
        void peerRelay.offer({ [dataServiceA]: { host: '127.0.0.1', port: local.data } }).then(offer => {
          activeOffer = offer;
        });
        return { program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] };
      },
    });
    let openSessionsB: PeerSessions | null = null;
    let started = false;
    const starting = keeper.start().then(() => void (started = true));
    await clock.until(() => started, { maxMs: 10_000, stepMs: 50 });
    await starting;
    onTestFinished(async () => {
      clock.restore();
      await relayGate.close();
      await peerGate.close();
      await openSessionsB?.close();
      await keeper.stop();
    });
    await clock.until(() => keeper.mode() === 'lead' && peerOffersStarted === 1 && activeOffer !== null, { maxMs: 10_000, stepMs: 50 });

    /* Issue Machine B's data certificate under the company's real authority and connect B -> PeerRelay -> A. */
    const keyB = ed25519Key();
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
    openSessionsB = sessionsB;
    sessionsB.use([{ machine: rowA.id, networkId: NET_A, addresses: ['127.0.0.1'], peerPort: await closedPort(), relayPort: visitB.ports[dataServiceA]! }]);
    await clock.until(() => sessionsB.reaches(rowA.id), { maxMs: 8000, stepMs: 50 });

    /* 1) Real two-Macs trigger: relay behind DelayGate goes silent for 4 s (route unknown). Leader must stay on lead
       every second, keep its single peer offer without restarting, and keep B's peer session alive. */
    const modes: string[] = [];
    const sample = async (seconds: number): Promise<void> => {
      for (let i = 0; i < seconds; i++) {
        await clock.advance(1000, 50);
        modes.push(`${Math.round(clock.now() / 1000)}s:${keeper.mode()}`);
      }
    };
    await sample(4);
    relayGate.setCut(true);
    await sample(4);
    relayGate.setCut(false);
    await sample(10);
    expect(modes.filter(m => !m.endsWith(':lead'))).toEqual([]);
    expect([peerOffersStarted, linkStarts]).toEqual([1, 1]);
    expect(lines.filter(l => l.startsWith('Stopping the peer tunnel'))).toEqual([]);
    expect(sessionsB.reaches(rowA.id)).toBe(true);

    /* 2) Brief 1-poll mode dip across one 3000 ms PeerLink tick: PeerLink holds its offer without dropping B's session. */
    baseLease.othersHold(false);
    await clock.advance(1000, 50);
    const elapsed = clock.now() - peerStartedAt;
    const nextTick = (Math.floor((elapsed + 1200) / 3000) + 1) * 3000;
    const beforeDip = peerStartedAt + nextTick - 1200 - clock.now();
    if (beforeDip > 0) await clock.advance(beforeDip, 50);
    fenceActive = true;
    await clock.until(() => keeper.mode() === 'read', { maxMs: 1100, stepMs: 50 });
    const acrossFirstTick = peerStartedAt + nextTick + 400 - clock.now();
    if (acrossFirstTick > 0) await clock.advance(acrossFirstTick, 50);
    fenceActive = false;
    await clock.until(() => keeper.mode() === 'lead', { maxMs: 1100, stepMs: 50 });
    await clock.advance(3500, 50);
    expect(peerOffersStarted).toBe(1);
    expect(lines).not.toContain(STOP_LINE);
    expect(sessionsB.reaches(rowA.id)).toBe(true);

    /* 3) Sustained non-lead across two consecutive 3000 ms polls stops the peer offer and drops B's relay session. */
    fenceActive = true;
    await clock.advance(7000, 50);
    expect(lines).toContain(STOP_LINE);
    expect(sessionsB.reaches(rowA.id)).toBe(false);
  });
});
