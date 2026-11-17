import { ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomUUID, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import http2, { type ClientHttp2Session, type ClientHttp2Stream } from 'node:http2';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { gzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { testPort } from '../../../test-support/ports.mjs';
import type { Db } from '../src/db/client.js';
import { loadConfig } from '../src/config.js';
import { certificates, companies, machines, people, publicLinks } from '../src/db/schema.js';
import { bundleRows } from '../src/modules/backups/records.js';
import { AGE_KEY_FILE } from '../src/modules/keeper/age-key.js';
import { BUNDLES_DIR } from '../src/modules/keeper/backups.js';
import { CERT_FILE, type HeldCertificate } from '../src/modules/keeper/certificate.js';
import { Keeper, type HandingParts, type KeeperOptions } from '../src/modules/keeper/keeper.js';
import { machineKey, type MachineKey } from '../src/modules/keeper/machine-keys.js';
import { CRL_FILE } from '../src/modules/keeper/peer-link.js';
import { saveLink } from '../src/modules/link/link.js';
import { linkClientId } from '../src/modules/link/client.js';
import { Relay } from '../src/modules/link/relay.js';
import type { SyncCatalog, SyncControllerOptions } from '../src/modules/keeper/sync.js';
import type { Sql } from '../src/modules/keeper/lease-store.js';
import { fakeRelay } from './fake-relay.js';
import { peerConfigFor, type PeerServices } from '../src/modules/link/peer-client.js';
import { certFacts, issueCertificate, makeAuthority, makeCrl } from '../src/modules/network/authority.js';
import { authorityOf, peerSecret } from '../src/modules/network/store.js';
import { readKeeperState } from '../src/modules/keeper/state.js';
import { PeerDoor } from '../src/net/peer-door.js';
import type { PeerSessions } from '../src/net/peer-sessions.js';
import { APP_AUTHORITY, PeerServer } from '../src/net/peer-server.js';
import type { Target } from '../src/net/proxy.js';
import { fakeLease } from './fake-lease.js';
import { setUpCompany, TEST_SECRET, testApp, until } from './helpers.js';

const MACHINE_ID = `ab12cd34${'0'.repeat(24)}`;
const ignore = (): void => {};

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-keeper-peer-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ed25519 = (): MachineKey => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { privatePem: privateKey, publicPem: publicKey };
};

/* The company's app, which believes the keeper's address: the test's keeper and the test itself both come from it. */
async function company(withLink = true) {
  const { app, db, config } = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: MACHINE_ID });
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  if (withLink) await saveLink(db, config, acme!.id, { name: 'acme', url: 'https://acme.hornhoof.test', key: 'k'.repeat(32), tunnel: { serverAddr: 'relay.hornhoof.test', serverPort: 443, protocol: 'wss' } });
  return { app, db, config, companyId: acme!.id, ownerId: owner!.id };
}

async function listening(app: FastifyInstance, port = 0): Promise<Target> {
  await app.listen({ host: '127.0.0.1', port });
  return { host: '127.0.0.1', port: (app.server.address() as AddressInfo).port };
}

type Stand = Awaited<ReturnType<typeof company>>;

async function keeperBeside(c: Stand, app: Target, dir = folder(), extra: Partial<KeeperOptions> = {}) {
  const lines: string[] = [];
  const offered: { config: string; clientId: string }[] = [];
  /* A stand-in for the second frpc: the config is the real one, and the child sleeps until it is stopped. */
  const peerClientFor = (services: PeerServices, clientId: string, local: { data: number; app: number }) => {
    offered.push({ config: peerConfigFor(services, { machineId: MACHINE_ID, local }), clientId });
    return { program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] };
  };
  const controlDir = folder();
  const keeper = new Keeper({
    config: loadConfig({ HORNHOOF_SECRET: TEST_SECRET, HORNHOOF_CONTROL_DIR: controlDir, HORNHOOF_MACHINE_ID: MACHINE_ID, ACME_DIRECTORY: 'off' }),
    db: c.db,
    lease: fakeLease(),
    app,
    frontHost: null,
    log: line => lines.push(line),
    host: '127.0.0.1',
    ports: { front: 0, linkHttp: 0, linkTls: 0, peer: 0, peerApp: 0 },
    everyMs: 20,
    linkEveryMs: 50,
    peerEveryMs: 20,
    reportEveryMs: 3_600_000,
    dir,
    clientFor: () => ({ program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }),
    peerClientFor,
    ...extra,
  });
  const ports = await keeper.start();
  onTestFinished(() => keeper.stop());
  return { keeper, dir, controlDir, lines, ports, offered };
}

/* A worker of the company's network: a row with its key, and a certificate of the database's authority for it. */
async function worker(c: Stand) {
  const key = ed25519();
  const [row] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.ownerId, machineKey: `worker-${Math.random()}`, role: 'worker', signKey: key.publicPem }).returning();
  const authority = (await authorityOf(c.db, c.config))!;
  const issued = await issueCertificate(authority, { machineId: row!.id, role: 'worker', signKey: key.publicPem });
  await c.db.insert(certificates).values({ serial: issued.serial, machineId: row!.id, until: issued.until });
  return { id: row!.id, key, certPem: issued.certPem, serial: issued.serial, authorityPem: authority.certPem };
}

type Worker = Awaited<ReturnType<typeof worker>>;

function sessionOf(port: number, w: Worker): ClientHttp2Session {
  const session = http2.connect(`https://127.0.0.1:${port}`, { ca: w.authorityPem, cert: w.certPem, key: w.key.privatePem, checkServerIdentity: () => undefined });
  session.on('error', ignore);
  onTestFinished(() => void session.destroy());
  return session;
}

/* A stream to the app through the peer link, once the keeper has answered the CONNECT; null when it never did. */
function toApp(session: ClientHttp2Session): Promise<ClientHttp2Stream | null> {
  return new Promise(resolve => {
    const stream = session.request({ ':method': 'CONNECT', ':authority': APP_AUTHORITY });
    stream.on('error', ignore);
    stream.once('response', headers => resolve(Number(headers[':status']) === 200 ? stream : null));
    stream.once('close', () => resolve(null));
  });
}

/* One HTTP request to the app over such a stream, written as bytes. Node's own HTTP client is not used here: with a body
   it writes a string and an empty string in one go, which an HTTP/2 stream of Node 22 sends as garbage. */
async function ask(stream: ClientHttp2Stream, options: { method?: string; path: string; headers?: Record<string, string> }, body?: unknown): Promise<{ status: number; body: string }> {
  const text = body === undefined ? '' : JSON.stringify(body);
  const headers = { host: 'app', connection: 'close', ...(text ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) } : {}), ...options.headers };
  const head = [`${options.method ?? 'GET'} ${options.path} HTTP/1.1`, ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)].join('\r\n');
  stream.write(Buffer.from(`${head}\r\n\r\n${text}`));
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const answer = Buffer.concat(chunks).toString();
  const split = answer.indexOf('\r\n\r\n');
  return { status: Number(answer.slice(9, 12)), body: answer.slice(split + 4) };
}

/* A plain request on a connection of its own, which closes with its answer. */
function send(to: Target, options: http.RequestOptions, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const out = http.request({ ...to, agent: false, ...options, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...options.headers } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    out.on('error', reject);
    out.end(text);
  });
}

const closed = (session: ClientHttp2Session): Promise<void> => new Promise(resolve => (session.closed || session.destroyed ? resolve() : session.once('close', () => resolve())));

describe('the peer link in the keeper', () => {
  it('serves the peer link once its certificate is in, and names each peer to the app by its certificate', async () => {
    const c = await company();
    const { keeper } = await keeperBeside(c, await listening(c.app));
    const { peer } = await keeper.peerPorts();
    const w = await worker(c);

    const health = await ask((await toApp(sessionOf(peer, w)))!, { path: '/api/health' });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ ok: true });

    /* Whatever the peer says of itself, the app hears its certificate's name. */
    const reported = await ask((await toApp(sessionOf(peer, w)))!, { method: 'POST', path: '/api/network/report', headers: { 'x-hornhoof-via': 'keeper' } }, { commit: 'w1' });
    expect(reported.status).toBe(204);
    const rows = await c.db.select().from(machines);
    expect(rows.find(row => row.id === w.id)!.commit).toBe('w1');
    expect(rows.find(row => row.networkId === MACHINE_ID)!.commit).not.toBe('w1');
  });

  it("renews a peer's certificate through the app, for its own row and key", async () => {
    const c = await company();
    const { keeper } = await keeperBeside(c, await listening(c.app));
    const { peer } = await keeper.peerPorts();
    const w = await worker(c);
    const renewed = await ask((await toApp(sessionOf(peer, w)))!, { method: 'POST', path: '/api/network/certificate', headers: { 'x-hornhoof-via': 'keeper' } }, { signKey: w.key.publicPem });
    expect(renewed.status).toBe(200);
    expect(certFacts((JSON.parse(renewed.body) as HeldCertificate).certPem)).toMatchObject({ machineId: w.id, role: 'worker' });
  });

  it("keeps the network routes from the keeper's other doors", async () => {
    const c = await company();
    const { ports } = await keeperBeside(c, await listening(c.app));
    for (const port of [ports.front, ports.linkHttp]) {
      const res = await send({ host: '127.0.0.1', port }, { method: 'POST', path: '/api/network/certificate', headers: { 'x-hornhoof-via': 'keeper' } }, { signKey: ed25519().publicPem });
      expect(res.status).toBe(403);
      expect((JSON.parse(res.body) as { error: { reason: string } }).error.reason).toBe('not_keeper');
    }
  });

  it('reads revocations as they come: the open session closes, a new one is refused, and the list is kept', async () => {
    const c = await company();
    const { keeper, dir } = await keeperBeside(c, await listening(c.app));
    const { peer } = await keeper.peerPorts();
    const w = await worker(c);
    const session = sessionOf(peer, w);
    expect(await toApp(session)).not.toBeNull();

    await c.db.update(certificates).set({ revokedAt: new Date() }).where(eq(certificates.serial, w.serial));
    await closed(session);
    await until(() => (JSON.parse(readFileSync(join(dir, CRL_FILE), 'utf8')) as { serials: string[] }).serials.includes(w.serial));
    const again = sessionOf(peer, w);
    expect(await toApp(again)).toBeNull();
  });

  it('opens the peer link only after checking its certificate and its list with the app', async () => {
    const c = await company();
    const target = await listening(c.app);
    const first = await keeperBeside(c, target);
    const { peer } = await first.keeper.peerPorts();
    const w = await worker(c);
    expect(await toApp(sessionOf(peer, w))).not.toBeNull();
    await first.keeper.stop();
    /* The keeper's folder holds a current certificate and a list that does not name the worker, whom the database has
       revoked since. Its app does not answer. */
    await c.db.update(certificates).set({ revokedAt: new Date() }).where(eq(certificates.serial, w.serial));
    expect((JSON.parse(readFileSync(join(first.dir, CRL_FILE), 'utf8')) as { serials: string[] }).serials).toEqual([]);
    const down = http.createServer();
    await new Promise<void>(resolve => down.listen(0, '127.0.0.1', resolve));
    const away: Target = { host: '127.0.0.1', port: (down.address() as AddressInfo).port };
    await new Promise(resolve => down.close(resolve));
    const second = await keeperBeside(c, away, first.dir, { holdMs: 0 });
    let open = false;
    void second.keeper.peerPorts().then(() => (open = true));
    await until(() => second.lines.some(line => line.startsWith("The keeper cannot read the network's state")));
    expect(open).toBe(false);

    /* The app is back where the keeper asks. */
    const back = http.createServer((req, res) => {
      void c.app.inject({ method: req.method as 'GET', url: req.url!, headers: { 'x-hornhoof-via': String(req.headers['x-hornhoof-via'] ?? '') }, remoteAddress: '127.0.0.1' }).then(answer => {
        res.writeHead(answer.statusCode, { 'content-type': 'application/json' }).end(answer.body);
      });
    });
    await new Promise<void>(resolve => back.listen(away.port, '127.0.0.1', resolve));
    onTestFinished(() => void back.close());
    const ports = await second.keeper.peerPorts();
    expect(await toApp(sessionOf(ports.peer, w))).toBeNull();
  });

  it('takes a new certificate when the database does not know its own', async () => {
    const c = await company();
    const dir = folder();
    /* As after a failed update whose database was restored: a certificate of another authority, for another row. */
    const key = machineKey(dir);
    const stranger = await makeAuthority('00000000-0000-4000-8000-00000000000f');
    const other = '11111111-0000-4000-8000-000000000001';
    const issued = await issueCertificate(stranger, { machineId: other, role: 'data', signKey: key.publicPem });
    const stale: HeldCertificate = { machine: other, role: 'data', certPem: issued.certPem, authorityPem: stranger.certPem, until: issued.until.toISOString() };
    writeFileSync(join(dir, CERT_FILE), JSON.stringify(stale));

    const { keeper } = await keeperBeside(c, await listening(c.app), dir);
    const { peer } = await keeper.peerPorts();
    const authority = (await authorityOf(c.db, c.config))!;
    expect(keeper.certificate()!.authorityPem).toBe(authority.certPem);
    const w = await worker(c);
    const session = sessionOf(peer, w);
    expect(await toApp(session)).not.toBeNull();
    const served = (session.socket as TLSSocket).getPeerX509Certificate()!;
    expect(served.checkIssued(new X509Certificate(authority.certPem))).toBe(true);
  });

  it('offers the peer link and the app through the relay while the company has a link', async () => {
    const c = await company();
    const { keeper, offered } = await keeperBeside(c, await listening(c.app));
    const ports = await keeper.peerPorts();
    await until(() => offered.length > 0);
    const said = (await c.app.inject({ url: '/api/network/peers', headers: { 'x-hornhoof-via': 'keeper' }, remoteAddress: '127.0.0.1' })).json() as { link: { appSecret: string; dataSecret: string } };
    expect(offered[0]!.clientId).toBe('acme-ab12cd34-peer');
    expect(offered[0]!.config).toContain('clientID = "acme-ab12cd34-peer"');
    expect(offered[0]!.config).toContain(`name = "acme-ab12cd34-data"\ntype = "stcp"\nsecretKey = "${said.link.dataSecret}"\nlocalIP = "127.0.0.1"\nlocalPort = ${ports.peer}`);
    expect(offered[0]!.config).toContain(`name = "acme-ab12cd34-app"\ntype = "stcp"\nsecretKey = "${said.link.appSecret}"\nlocalIP = "127.0.0.1"\nlocalPort = ${ports.peerApp}`);
  });

  it('offers nothing through the relay for a company without a link, and still serves the peer port', async () => {
    const c = await company(false);
    const { keeper, offered, lines } = await keeperBeside(c, await listening(c.app));
    const { peer } = await keeper.peerPorts();
    expect(await c.db.select().from(publicLinks)).toEqual([]);
    expect(await toApp(sessionOf(peer, await worker(c)))).not.toBeNull();
    /* The app has been asked many times over by now, and no answer of it names a link to offer through. */
    expect(offered).toEqual([]);
    expect(lines.filter(line => line.startsWith('Offering this machine'))).toEqual([]);
  });

  it("makes the company's backups, reports its key for them, and serves bundles only to their holders", async () => {
    const c = await company(false);
    const { keeper, controlDir, dir } = await keeperBeside(c, await listening(c.app), folder(), { backupsEveryMs: 20, reportEveryMs: 20, backupKeysRetryMs: 20 });
    const serverRow = async () => (await c.db.select().from(machines).where(eq(machines.networkId, MACHINE_ID)))[0];
    /* Its key for backups is kept for the keeper alone, and its public half reaches the company. */
    await until(async () => Boolean((await serverRow())?.ageKey));
    expect((await serverRow())!.ageKey).toMatch(/^age1[0-9a-z]{58}$/);
    expect(statSync(join(dir, AGE_KEY_FILE)).mode & 0o777).toBe(0o600);
    /* It asks the updater for a dump at once; the test dumps in the updater's place. */
    const request = join(controlDir, 'dump.json');
    await until(() => existsSync(request));
    const { id } = JSON.parse(readFileSync(request, 'utf8')) as { id: string };
    mkdirSync(join(controlDir, 'dumps'));
    writeFileSync(join(controlDir, 'dumps', `${id}.sql.gz`), gzipSync('-- a dump of the hornhoof database\n'));
    writeFileSync(join(controlDir, 'dumps', `${id}.json`), JSON.stringify({ id, reason: 'timer', at: new Date().toISOString(), migrations: 106 }));
    await until(async () => (await bundleRows(c.db)).length === 1);
    const [row] = await bundleRows(c.db);
    expect(row).toMatchObject({ id, signer: (await serverRow())!.id, recipients: [(await serverRow())!.ageKey], reason: 'timer' });
    await until(() => !existsSync(request) && readdirSync(join(controlDir, 'dumps')).length === 0);
    await until(async () => (await serverRow())!.heldBackups.includes(id));
    /* The sealed bundle holds none of the dump in the clear. */
    expect(readFileSync(join(dir, BUNDLES_DIR, `${id}.age`)).includes('a dump of the hornhoof database')).toBe(false);

    /* A machine of the company that was not picked to hold it gets none of it through the peer link. */
    const w = await worker(c);
    const session = sessionOf((await keeper.peerPorts()).peer, w);
    const statusOf = (path: string, method = 'GET') => new Promise<number | null>(resolve => {
      const stream = session.request({ ':method': method, ':path': path }, { endStream: true });
      stream.on('error', ignore);
      stream.once('response', headers => resolve(Number(headers[':status'])));
      stream.once('close', () => resolve(null));
      stream.resume();
    });
    expect(await statusOf(`/peer/backups/${id}`)).toBe(403);
    expect(await statusOf(`/peer/backups/${id.replace(/^./, id.startsWith('0') ? '1' : '0')}`)).toBe(404);
    expect(await statusOf(`/peer/backups/${id}`, 'PUT')).toBe(403);
  });

  it('takes what a machine that left the data uploads, and from no other machine', async () => {
    const c = await company(false);
    const { keeper, controlDir } = await keeperBeside(c, await listening(c.app), folder(), { peerEveryMs: 20 });
    const { peer } = await keeper.peerPorts();
    const w = await worker(c);
    const session = sessionOf(peer, w);
    const put = (bytes: Buffer) => new Promise<number | null>(resolve => {
      const stream = session.request({ ':method': 'PUT', ':path': `/peer/upload/${randomUUID()}`, 'content-length': bytes.length });
      stream.on('error', ignore);
      stream.once('response', headers => resolve(Number(headers[':status'])));
      stream.once('close', () => resolve(null));
      stream.resume();
      stream.end(bytes);
    });
    /* A machine that owes nothing is refused. */
    expect(await put(Buffer.from('rows'))).toBe(403);
    expect(existsSync(join(controlDir, 'load.json'))).toBe(false);
    /* Its owner lost the scope: the app names it, and the keeper takes its upload and asks the updater to load it. */
    /* An id of the length older installs have, which is a machine's id as much as today's. */
    const networkId = `77cc${'3'.repeat(28)}`;
    await c.db.update(machines).set({ networkId, uploadState: 'waiting', dataLeftAt: new Date() }).where(eq(machines.id, w.id));
    await until(async () => (await put(Buffer.from('rows'))) === 201);
    const load = JSON.parse(readFileSync(join(controlDir, 'load.json'), 'utf8')) as { machine: string; file: string; database: string; unpackMax: number };
    expect(load.machine).toBe(w.id);
    expect(load.database).toMatch(/^hornhoof_upload_77cc333333333333_[0-9]{8}t[0-9]{6}$/);
    expect(load.unpackMax).toBeGreaterThan(2 ** 30);
    expect(readFileSync(load.file, 'utf8')).toBe('rows');
    expect(load.file.startsWith(join(controlDir, 'uploads', `${networkId}-`))).toBe(true);
  });

  it('writes what it sent each machine', async () => {
    const c = await company(false);
    const best = { 'bbbbbbbb-0000-4000-8000-00000000000b': { mbps: 80, at: '2026-11-11T12:00:00.000Z' } };
    let running = 0;
    const { keeper, controlDir } = await keeperBeside(c, await listening(c.app), folder(), { throughput: { start: () => void (running += 1), stop: () => void (running -= 1), best: () => best } });
    await until(() => readKeeperState(controlDir)?.throughput !== undefined);
    expect(readKeeperState(controlDir)!.throughput).toEqual(best);
    expect(running).toBe(1);
    await keeper.stop();
    expect(running).toBe(0);
  });

  it('reports the address its copies saw', async () => {
    const c = await company(false);
    const saw = { addresses: ['192.168.1.9'] };
    /* What dials the copies, as far as the report asks it. */
    const dial = { seen: () => saw.addresses, use: () => undefined, close: async () => undefined, reaches: () => false } as unknown as PeerSessions;
    await keeperBeside(c, await listening(c.app), folder(), { addresses: ['192.168.1.5'], reportEveryMs: 20, copies: { dial } });
    const own = async () => (await c.db.select().from(machines).where(eq(machines.networkId, MACHINE_ID)))[0]?.addresses ?? [];
    /* Its own address first, then the one a copy saw it come from: a machine that moved is found there. */
    await until(async () => (await own()).length === 2);
    expect(await own()).toEqual(['192.168.1.5', '192.168.1.9']);
    /* What a session through the relay sees is this machine's own loopback, which is no address of it. */
    saw.addresses = ['127.0.0.1'];
    await until(async () => (await own()).length === 1);
    expect(await own()).toEqual(['192.168.1.5']);
  });

  it('opens a door to a copy its app names', async () => {
    const c = await company(false);
    const target = await listening(c.app);
    /* A copy of the company: its row, its certificate, and its peer link with a database that sends back what it gets. */
    const copyNetworkId = `99bb2233${'2'.repeat(24)}`;
    const key = ed25519();
    const db = net.createServer(socket => void socket.on('error', ignore).on('data', chunk => socket.write(`copy: ${String(chunk)}`)));
    await new Promise<void>(resolve => db.listen(0, '127.0.0.1', resolve));
    onTestFinished(() => void db.close());
    const { keeper, controlDir } = await keeperBeside(c, target, folder(), { copies: { doorHost: '127.0.0.1', allowed: async () => ['127.0.0.1'], everyMs: 20, sessions: { everyMs: 20, helloMs: 20 } } });
    await until(() => keeper.certificate() !== null);
    const authority = (await authorityOf(c.db, c.config))!;
    const [row] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.ownerId, machineKey: 'copy-1', role: 'data', networkId: copyNetworkId, signKey: key.publicPem }).returning();
    const issued = await issueCertificate(authority, { machineId: row!.id, role: 'data', signKey: key.publicPem });
    const door = new PeerDoor({ app: target });
    await door.start();
    onTestFinished(() => door.stop());
    const peers = new PeerServer({
      held: () => ({ machine: row!.id, role: 'data', certPem: issued.certPem, authorityPem: authority.certPem, until: issued.until.toISOString() }), key,
      crl: () => crlPem, revoked: () => new Set<string>(), door, db: { host: '127.0.0.1', port: (db.address() as AddressInfo).port },
      hello: () => ({ machine: row!.id, role: 'data', lead: false, commit: 'c0ffee' }), log: ignore,
    });
    const crlPem = await makeCrl(authority, []);
    onTestFinished(() => peers.close());
    const peerPort = await peers.listen(0, 'peer', '127.0.0.1');
    await c.db.update(machines).set({ addresses: ['127.0.0.1'], peerPort }).where(eq(machines.id, row!.id));
    const doorsSaid = () => readKeeperState(controlDir)?.doors ?? {};
    expect(doorsSaid()).toEqual({});

    c.app.ctx.doorsWanted = async () => [copyNetworkId];
    await until(() => copyNetworkId in doorsSaid());
    const said = (port: number): Promise<string> =>
      new Promise(resolve => {
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.on('error', () => resolve('closed'));
        socket.once('close', () => resolve('closed'));
        socket.once('data', chunk => (resolve(String(chunk)), socket.destroy()));
        socket.write('ping');
      });
    const port = doorsSaid()[copyNetworkId]!;
    await until(async () => (await said(port)) === 'copy: ping');
    /* Named no more, the door closes and the word forgets it. */
    c.app.ctx.doorsWanted = async () => [];
    await until(() => Object.keys(doorsSaid()).length === 0);
    expect(await said(port)).toBe('closed');
  });

  it('beats as the leader', async () => {
    const c = await company(false);
    const target = await listening(c.app);
    const copyNetworkId = `99bb2233${'2'.repeat(24)}`;
    const key = ed25519();
    /* A lease store that can be told to take no term, and a clock the test moves. */
    const able = { take: true };
    const skew = { ms: 0 };
    const lease = fakeLease({ take: () => (able.take ? Promise.resolve({ number: 4, machine: MACHINE_ID, split: false }) : Promise.reject(new Error('the database is down'))) });
    const { keeper } = await keeperBeside(c, target, folder(), {
      lease, beatEveryMs: 20, now: () => ({ wall: Date.now() + skew.ms, mono: performance.now() + skew.ms }),
      copies: { doorHost: '127.0.0.1', allowed: async () => ['127.0.0.1'], everyMs: 20, sessions: { everyMs: 20, helloMs: 20 } },
    });
    await until(() => keeper.certificate() !== null && keeper.mode() === 'lead');
    const authority = (await authorityOf(c.db, c.config))!;
    const [row] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.ownerId, machineKey: 'copy-1', hostname: 'mac', role: 'data', networkId: copyNetworkId, signKey: key.publicPem }).returning();
    const issued = await issueCertificate(authority, { machineId: row!.id, role: 'data', signKey: key.publicPem });
    await c.db.insert(certificates).values({ serial: issued.serial, machineId: row!.id, until: issued.until });
    const door = new PeerDoor({ app: target });
    await door.start();
    onTestFinished(() => door.stop());
    /* The copy's keeper, as far as beats go: it keeps each one it gets and answers with its own. */
    const follows = { machine: copyNetworkId, host: 'mac', stance: { kind: 'follow', term: null }, number: 2, reach: null, ready: false, full: false };
    const heard: { from: string; path: string; body: { machine: string; host: string; stance: { kind: string; term?: unknown; lease?: string; sync?: unknown; until?: number }; ready: boolean; full: boolean; reach: string | null } }[] = [];
    const crlPem = await makeCrl(authority, []);
    const peers = new PeerServer({
      held: () => ({ machine: row!.id, role: 'data', certPem: issued.certPem, authorityPem: authority.certPem, until: issued.until.toISOString() }), key,
      crl: () => crlPem, revoked: () => new Set<string>(), door, db: null,
      hello: () => ({ machine: row!.id, role: 'data', lead: false, commit: 'c0ffee' }), log: ignore,
      switches: { handle: async (peer, _method, path, body) => (heard.push({ from: peer.machine, path, body: body as (typeof heard)[number]['body'] }), { status: 200, body: follows }) },
    });
    onTestFinished(() => peers.close());
    const peerPort = await peers.listen(0, 'peer', '127.0.0.1');
    await c.db.update(machines).set({ addresses: ['127.0.0.1'], peerPort }).where(eq(machines.id, row!.id));

    /* It tells the copy each second that it leads, under which term and until when, and that commits wait for no copy. */
    await until(() => heard.some(beat => beat.body.stance.kind === 'lead'));
    const [own] = await c.db.select().from(machines).where(eq(machines.networkId, MACHINE_ID));
    const beat = heard.find(one => one.body.stance.kind === 'lead')!;
    expect([beat.from, beat.path]).toEqual([own!.id, '/peer/beat']);
    expect(beat.body).toMatchObject({ machine: MACHINE_ID, stance: { kind: 'lead', term: { number: 4, machine: MACHINE_ID, split: false }, lease: 'normal', sync: null }, ready: true, full: false });
    expect(beat.body.stance.until).toBeGreaterThan(Date.now());
    expect(Number.isNaN(Date.parse(beat.body.reach ?? ''))).toBe(false);
    /* Its hello names its term to whoever asks. */
    const hello = async () => {
      const stream = sessionOf((await keeper.peerPorts()).peer, { id: row!.id, key, certPem: issued.certPem, serial: issued.serial, authorityPem: authority.certPem }).request({ ':method': 'GET', ':path': '/peer/hello' });
      let text = '';
      for await (const chunk of stream) text += String(chunk);
      return JSON.parse(text) as { lead: boolean; term: unknown; sync: unknown; moving: unknown };
    };
    expect(await hello()).toMatchObject({ lead: true, term: { number: 4, machine: MACHINE_ID, split: false }, sync: null, moving: null });
    /* The copy's answers are kept as what it said last. */
    await until(() => keeper.beats().answer(copyNetworkId) !== null);
    expect(keeper.beats().last(copyNetworkId)?.beat).toEqual(follows);

    /* Its lease ends and none can be taken: it goes on beating, as a keeper that would lead and holds no lease. */
    able.take = false;
    skew.ms = 60_000;
    await until(() => heard.at(-1)?.body.stance.kind === 'idle');
    expect(heard.at(-1)!.body.stance).toEqual({ kind: 'idle', term: { number: 4, machine: MACHINE_ID, split: false } });
    expect(await hello()).toMatchObject({ lead: false, term: null });
  });

  /* The test's own clocks: its intervals, Date and performance are fake and move only when the test steps them, so the
     seconds a lease and a window take pass with no real wait, however busy the machine is. */
  /* A keeper's intervals in the stepped tests' own time: a tick every 400 ms of its clocks, as those tests were written for. */
  const STEPPED = { everyMs: 400, linkEveryMs: 1_000, peerEveryMs: 400 } as const;
  function steppedClock() {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date', 'performance'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const began = performance.now();
    const now = (): { wall: number; mono: number } => ({ wall: Date.now(), mono: performance.now() - began });
    /* The clocks move on by ms, every interval due on the way fires, and what those started settles. */
    const step = async (ms: number): Promise<void> => {
      await vi.advanceTimersByTimeAsync(ms);
      await new Promise<void>(resolve => setImmediate(resolve));
    };
    /* A keeper's tick at a time until the state comes; with no deadline, as until has none. */
    const stepUntil = async (check: () => boolean): Promise<void> => {
      while (!check()) await step(STEPPED.everyMs);
    };
    return { now, step, stepUntil };
  }
  const OWN_CLIENT = linkClientId('acme', MACHINE_ID);
  type Name = { state: 'held' | 'empty'; client: string | null; generation: number };
  /* What a keeper whose lease takes proofs goes by, as the test sets it. */
  function proving(now: () => { wall: number; mono: number }, said: { needed: boolean; link: 'self' | 'other' | 'silent'; name: Name }) {
    const did: string[] = [];
    const probes: string[] = [];
    const proofs: NonNullable<KeeperOptions['proofs']> = {
      needed: async () => said.needed,
      probe: async nonce => {
        probes.push(nonce);
        return said.link === 'silent' ? null : { machine: said.link === 'self' ? MACHINE_ID : 'b0'.repeat(16), nonce };
      },
      ownTerm: async () => null,
      poll: async () => ({ sent: now(), replied: now().mono, route: { known: true, ...said.name, since: 0, relayStarted: 100, evictionBound: 30, sync: { state: 'off', copy: null, epoch: 1, generation: said.name.generation, at: null } }, health: { up: true, relayStarted: 100 } }),
      follow: async () => void did.push('follow'),
      everyMs: STEPPED.everyMs,
    };
    return { proofs, did, probes };
  }

  it('renews by itself until a copy finished, then only on a proof, and ends its lease when another machine answers at its link', async ({ signal }) => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    onTestFinished(() => { vi.useRealTimers(); });
    const c = await company();
    const clock = { wall: Date.now(), mono: 0 };
    const now = () => ({ ...clock });
    const said = { needed: false, link: 'self' as 'self' | 'other' | 'silent', name: { state: 'held', client: OWN_CLIENT, generation: 7 } as Name };
    const p = proving(now, said);
    /* A deferred answer, on the event loop rather than a real-time deadline. Machine load cannot age the lease. */
    const probe = p.proofs.probe;
    p.proofs.probe = async (nonce, link) => {
      await new Promise<void>(resolve => setImmediate(resolve));
      return probe(nonce, link);
    };
    const lease = fakeLease();
    const ports = { front: await testPort(), linkHttp: await testPort(), linkTls: await testPort(), peer: await testPort(), peerApp: await testPort() };
    const { keeper, lines } = await keeperBeside(c, await listening(c.app, await testPort()), folder(), { lease, now, proofs: p.proofs, ports });
    await until(() => Boolean(keeper['ownLink']()));
    const step = async (ms = 20) => {
      clock.wall += ms;
      clock.mono += ms;
      vi.setSystemTime(clock.wall);
      await keeper['readNeeded']();
      if (said.needed) {
        if (keeper['holder'].standing()) await keeper['leaseProofs']!.tick();
        else await keeper['reentry']!.tick();
      }
      await keeper['holder'].tick();
      keeper['giveWord']();
    };
    const stepUntil = (check: () => boolean) => until(async () => { signal.throwIfAborted(); await step(); return check(); });
    const renewals = () => lease.calls.filter(call => call.method === 'renew').length;
    await stepUntil(() => keeper.mode() === 'lead' && renewals() > 3);
    /* Alone with the data it asks nobody: its lease is its own word. */
    expect([p.probes, keeper.linkWanted()]).toEqual([[], true]);
    /* Another machine holds a copy that finished: each renewal now rests on an answer at the company's link. */
    said.needed = true;
    await stepUntil(() => p.probes.length > 3);
    const before = renewals();
    await stepUntil(() => renewals() > before + 2);
    expect(keeper.mode()).toBe('lead');
    /* Nobody answers at the link: nothing new is renewed. */
    said.link = 'silent';
    await step(1_200);
    const stopped = renewals();
    await step(2_000);
    expect(renewals()).toBe(stopped);
    /* Another machine answers there: the lease ends at once, and the link's client stops with it. */
    said.link = 'other';
    await stepUntil(() => lease.calls.some(call => call.method === 'fence'));
    await stepUntil(() => keeper.mode() === 'read');
    expect(lines.some(line => line.includes('The lease ended (another machine answers at the link)'))).toBe(true);
    expect(keeper.linkWanted()).toBe(false);
    expect(keeper.beats().own().stance.kind).toBe('idle');
    /* The name is another client's now: this machine follows, and takes no term again. */
    const taken = lease.calls.filter(call => call.method === 'take').length;
    said.name = { state: 'held', client: linkClientId('acme', 'b0'.repeat(16)), generation: 8 };
    await stepUntil(() => p.did.includes('follow'));
    expect([lease.calls.filter(call => call.method === 'take').length, keeper.linkWanted()]).toEqual([taken, false]);
  });

  it("comes back in through the relay's window, on a registration of its own", async () => {
    const c = await company();
    const { now, step, stepUntil } = steppedClock();
    /* A keeper that starts with a finished copy elsewhere, its copy silent: the name is free, and its own client made
       the last registration, at 7. */
    const said = { needed: true, link: 'silent' as 'self' | 'other' | 'silent', name: { state: 'empty', client: OWN_CLIENT, generation: 7 } as Name };
    const p = proving(now, said);
    const lease = fakeLease();
    const { keeper } = await keeperBeside(c, await listening(c.app), folder(), { lease, now, proofs: p.proofs, ...STEPPED });
    const takes = () => lease.calls.filter(call => call.method === 'take');
    /* It takes no term on its own word, and holds no name, until the name was free long enough. */
    await step(6_000);
    expect([takes(), keeper.linkWanted(), keeper.mode()]).toEqual([[], false, 'read']);
    await stepUntil(() => keeper.linkWanted());
    expect(now().mono).toBeGreaterThanOrEqual(12_000);
    expect(takes()).toEqual([]);
    /* Its own client holds the name at 8: that is its proof, and it leads under the next term. */
    said.name = { state: 'held', client: OWN_CLIENT, generation: 8 };
    said.link = 'self';
    await stepUntil(() => takes().length === 1);
    expect(takes()[0]!.args[3]).toEqual({ number: 1, machine: MACHINE_ID, split: false });
    await stepUntil(() => keeper.mode() === 'lead');
    expect([keeper.linkWanted(), p.did]).toEqual([true, []]);
  });

  it('holds no name on the word of an earlier way in, once a switch took the name away', async () => {
    const c = await company();
    const { now, stepUntil } = steppedClock();
    const said = { needed: true, link: 'silent' as 'self' | 'other' | 'silent', name: { state: 'empty', client: OWN_CLIENT, generation: 7 } as Name };
    const p = proving(now, said);
    let parts: HandingParts | undefined;
    const handing = (given: HandingParts) => ((parts = given), { start: async () => undefined, stop: async () => undefined, holds: () => false });
    const { keeper } = await keeperBeside(c, await listening(c.app), folder(), { lease: fakeLease(), now, proofs: p.proofs, handing, ...STEPPED });
    /* The way back in takes the name, with no lease standing yet. */
    await stepUntil(() => keeper.linkWanted());
    expect(keeper.mode()).toBe('read');
    /* A planned switch stops the link, and the server stays after all: the link may run again, and the way back in
       takes the name anew by itself. */
    await parts!.tunnel.stop();
    expect(keeper.linkWanted()).toBe(false);
    parts!.tunnel.start();
    expect(keeper.linkWanted()).toBe(false);
    await stepUntil(() => keeper.linkWanted());
  });

  it('holds no name before it knows whether its lease takes a proof', async () => {
    const c = await company();
    const { now, step } = steppedClock();
    const said = { needed: true, link: 'silent' as 'self' | 'other' | 'silent', name: { state: 'empty', client: OWN_CLIENT, generation: 7 } as Name };
    const p = proving(now, said);
    /* Its database cannot be asked yet, as while it recovers: whether another machine holds a finished copy is not known. */
    p.proofs.needed = async () => Promise.reject(new Error('the database is starting up'));
    const lease = fakeLease();
    const { keeper } = await keeperBeside(c, await listening(c.app), folder(), { lease, now, proofs: p.proofs, ...STEPPED });
    await step(6_000);
    /* It takes no lease on a guess, and its link's client does not run either: a keeper with no lease holds no name. */
    expect([lease.calls.filter(call => call.method === 'take'), keeper.linkWanted(), keeper.mode()]).toEqual([[], false, 'read']);
  });

  /* The leader's Postgres as far as the sync controller asks it, with one copy listed or none. */
  function syncCatalog(copy: { machine: string; networkId: string } | null) {
    const state = { setting: null as string | null, pulses: 0, listed: copy !== null };
    const name = copy ? `copy_${copy.networkId.slice(0, 16)}_1` : '';
    const catalog: SyncCatalog = {
      machines: async () => (copy && state.listed ? [{ machine: copy.machine, networkId: copy.networkId, number: 2, copyName: name, ready: false }] : []),
      replication: async () => [],
      setting: async () => state.setting,
      position: async () => '0/3000000',
      oldestWaitMs: async () => null,
      set: async chosen => void (state.setting = chosen),
      clear: async () => void (state.setting = null),
      checkpoint: async () => undefined,
      pulse: async () => void (state.pulses += 1),
      moveTarget: async () => null,
    };
    return { state, catalog };
  }

  it('leads under the flag its sync controller gives, and says how its copies do', async () => {
    const c = await company(false);
    const target = await listening(c.app);
    const relay = await fakeRelay();
    const { catalog, state } = syncCatalog(null);
    const lease = fakeLease();
    const { keeper, controlDir } = await keeperBeside(c, target, folder(), { lease, sync: { catalog, relay: new Relay(relay.url), everyMs: 20 } });
    await until(() => keeper.mode() === 'lead');
    /* Alone, as the controller found it: no copy, nothing to tell the relay, no pulse. */
    expect(lease.calls.find(call => call.method === 'take')!.args[2]).toBe('alone');
    await until(() => readKeeperState(controlDir)?.copies !== undefined);
    expect(readKeeperState(controlDir)).toMatchObject({ mode: 'lead', copies: [] });
    expect(state.pulses).toBe(0);
    expect(relay.calls.some(call => call.includes('/sync'))).toBe(false);
  });

  it('drops at its next sweep the slot of a broken-off table that a copy named to its app, and keeps the one nobody named', async () => {
    const c = await company(false);
    const target = await listening(c.app);
    const relay = await fakeRelay();
    const { catalog } = syncCatalog(null);
    const [broken, other] = ['pg_16500_sync_16384_7300000000000000000', 'pg_16500_sync_16390_7300000000000000000'];
    /* The leader's Postgres as far as the sweep asks it: two slots of tables' first copies that nobody reads. */
    const slots = [broken, other];
    const dropped: string[] = [];
    const sql: Sql = {
      query: async <R>(text: string, params: unknown[] = []) => {
        if (text.includes('FROM pg_replication_slots')) return { rows: slots.map(name => ({ name, active: false, pid: null, copying: false })) as R[] };
        if (text.includes('pg_drop_replication_slot')) {
          dropped.push(String(params[0]));
          slots.splice(slots.indexOf(String(params[0])), 1);
        }
        return { rows: [] as R[] };
      },
    };
    const { keeper } = await keeperBeside(c, target, folder(), { lease: fakeLease(), sync: { catalog, relay: new Relay(relay.url), everyMs: 20, slots: { sql, diskFree: () => null, everyMs: 20 } } });
    await until(() => keeper.mode() === 'lead');
    c.app.ctx.leftSlots.say('cccccccc-0000-4000-8000-00000000000c', [broken]);
    await until(() => dropped.length > 0);
    expect(dropped).toEqual([broken]);
    expect(slots).toEqual([other]);
  });

  it('stops its link when its lease ends with a copy listed, and starts it again to tell the relay', async () => {
    const c = await company(true);
    const target = await listening(c.app);
    const relay = await fakeRelay();
    relay.bindings.set('acme', { key: 'k'.repeat(32) });
    relay.register('acme', `acme-${MACHINE_ID.slice(0, 8)}-link`);
    const copy = { machine: 'cccccccc-0000-4000-8000-00000000000c', networkId: `99bb2233${'2'.repeat(24)}` };
    const { catalog, state } = syncCatalog(copy);
    /* Clocks the test moves, so a lease runs out when the test says so. */
    const clock = { wall: Date.now(), mono: 1_000_000 };
    const renews = { hold: true };
    const lease = fakeLease({ othersHoldData: true, renew: async () => renews.hold });
    let started = 0;
    const { keeper, lines } = await keeperBeside(c, target, folder(), {
      lease, now: () => ({ ...clock }),
      clientFor: () => (started++, { program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }),
      sync: { catalog, relay: new Relay(relay.url), everyMs: 20, routeEveryMs: 0, linkPauseMs: 400 },
    });
    /* Another machine holds the data: it leads only once the relay stored that this one alone has the latest changes. */
    await until(() => keeper.mode() === 'lead');
    expect(relay.syncs.get('acme')).toMatchObject({ state: 'off' });
    expect(lease.calls.find(call => call.method === 'take')!.args[2]).toBe('relay_off');
    await until(() => started === 1);
    await until(() => state.pulses > 0);

    /* Its renewals stop holding, and ten seconds pass: the lease ends. */
    renews.hold = false;
    clock.wall += 11_000;
    clock.mono += 11_000;
    await until(() => lines.some(line => line.startsWith('The lease ended')));
    expect(keeper.mode()).toBe('read');
    /* The link's frpc is stopped, so the company's name is free, and comes back by itself a moment later. */
    await until(() => lines.includes('No public link: the tunnel waits.'));
    renews.hold = true;
    await until(() => started === 2);
    await until(() => keeper.mode() === 'lead');
  });

  it('keeps its link when its lease ends while no other machine holds a copy that finished', async () => {
    const c = await company(true);
    const target = await listening(c.app);
    const relay = await fakeRelay();
    relay.bindings.set('acme', { key: 'k'.repeat(32) });
    relay.register('acme', `acme-${MACHINE_ID.slice(0, 8)}-link`);
    const copy = { machine: 'cccccccc-0000-4000-8000-00000000000c', networkId: `99bb2233${'2'.repeat(24)}` };
    /* The copy is listed and still being made: nobody but this machine could lead. */
    const { catalog } = syncCatalog(copy);
    const clock = { wall: Date.now(), mono: 1_000_000 };
    const renews = { hold: true };
    const lease = fakeLease({ othersHoldData: true, renew: async () => renews.hold });
    let started = 0;
    const { keeper, lines } = await keeperBeside(c, target, folder(), {
      lease, now: () => ({ ...clock }),
      clientFor: () => (started++, { program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }),
      sync: { catalog, relay: new Relay(relay.url), everyMs: 20, routeEveryMs: 0, linkPauseMs: 30_000 },
      proofs: {
        needed: async () => false,
        probe: async () => null,
        ownTerm: async () => null,
        poll: async () => { throw new Error('no machine needs the relay to come back in here'); },
        follow: async () => undefined,
      },
    });
    await until(() => keeper.mode() === 'lead');
    await until(() => started === 1);

    /* Its disk holds every renewal back for ten seconds: the lease ends, and the link the company is reached by stays. */
    renews.hold = false;
    clock.wall += 11_000;
    clock.mono += 11_000;
    await until(() => lines.some(line => line.startsWith('The lease ended')));
    expect(keeper.linkWanted()).toBe(true);
    renews.hold = true;
    await until(() => keeper.mode() === 'lead');
    expect([keeper.linkWanted(), started, lines.includes('No public link: the tunnel waits.')]).toEqual([true, 1, false]);
  });

  it('never leads alone while its controller says a copy is listed and the relay cannot be told', async () => {
    const c = await company(true);
    const target = await listening(c.app);
    const relay = await fakeRelay();
    /* The relay knows no such link: nothing can be stored there. */
    const copy = { machine: 'cccccccc-0000-4000-8000-00000000000c', networkId: `99bb2233${'2'.repeat(24)}` };
    const { catalog, state } = syncCatalog(copy);
    const lease = fakeLease({ othersHoldData: true });
    const { keeper, lines } = await keeperBeside(c, target, folder(), { lease, guardEveryMs: 50, sync: { catalog, relay: new Relay(relay.url), everyMs: 20, routeEveryMs: 0 } });
    await until(() => lines.some(line => line.startsWith('Could not tell hornhoof.org which machine holds the latest changes')));
    expect(keeper.mode()).toBe('read');
    expect(lease.calls.some(call => call.method === 'take')).toBe(false);
    /* The copy is gone again: this machine is alone, and leads. */
    state.listed = false;
    lease.othersHold(false);
    await until(() => keeper.mode() === 'lead');
    expect(lease.calls.find(call => call.method === 'take')!.args[2]).toBe('alone');
  });

  it('keeps mode and the word to the app on lead through four-second relay hiccups every six minutes', async () => {
    const { vi } = await import('vitest');
    const c = await company(true);
    const target = await listening(c.app);
    const copy = { machine: 'cccccccc-0000-4000-8000-00000000000c', networkId: `99bb2233${'2'.repeat(24)}` };
    const { catalog } = syncCatalog(copy);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date', 'performance'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const startMono = performance.now();
    const ownClient = `acme-${MACHINE_ID.slice(0, 8)}-link`;
    let syncRecord = { state: 'off' as 'on' | 'off', copy: null as string | null, epoch: 0, generation: 1, at: null as number | null };
    let unknownReads = 0;
    const relayClient: NonNullable<KeeperOptions['sync']>['relay'] = {
      route: async () => {
        const elapsed = performance.now() - startMono;
        if ((elapsed >= 357_000 && elapsed < 361_000) || (elapsed >= 717_000 && elapsed < 721_000)) {
          unknownReads += 1;
          return { known: false, why: 'unreachable' };
        }
        return { known: true, state: 'held', client: ownClient, since: 1, generation: 1, relayStarted: 100, evictionBound: 30, sync: syncRecord };
      },
      setSync: async (_name, _key, post) => {
        syncRecord = { state: post.state, copy: post.copy, epoch: post.epoch, generation: post.generation, at: Math.floor(Date.now() / 1000) };
        return { stored: true, sync: syncRecord };
      },
    };
    const { keeper, controlDir } = await keeperBeside(c, target, folder(), {
      lease: fakeLease({ othersHoldData: true }),
      now: () => ({ wall: Date.now(), mono: performance.now() }),
      throughput: { start: ignore, stop: ignore, best: () => ({}) },
      everyMs: 3000,
      linkEveryMs: 3000,
      peerEveryMs: 3000,
      beatEveryMs: 60_000,
      guardEveryMs: 60_000,
      copies: { everyMs: 60_000 },
      sync: { catalog, relay: relayClient, everyMs: 1000, routeEveryMs: 1000, linkPauseMs: 30_000 },
    });
    while (!(keeper.mode() === 'lead' && readKeeperState(controlDir)?.mode === 'lead')) {
      await vi.advanceTimersByTimeAsync(1000);
      await new Promise<void>(resolve => setImmediate(resolve));
    }

    const modes: string[] = [];
    for (const windowStartMs of [355_000, 715_000]) {
      await vi.advanceTimersByTimeAsync(windowStartMs - (performance.now() - startMono));
      for (let second = 0; second < 12; second++) {
        await vi.advanceTimersByTimeAsync(1000);
        await new Promise<void>(resolve => setImmediate(resolve));
        modes.push(`${Math.round((performance.now() - startMono) / 1000)}s:${keeper.mode()}/${readKeeperState(controlDir)?.mode}`);
      }
    }
    expect(unknownReads).toBeGreaterThanOrEqual(8);
    expect(modes.filter(entry => entry.includes('read'))).toEqual([]);
  });

  it('keeps the list of revoked certificates where only the keeper reads it', async () => {
    const c = await company();
    const { keeper, dir } = await keeperBeside(c, await listening(c.app));
    await keeper.peerPorts();
    expect(existsSync(join(dir, CRL_FILE))).toBe(true);
    expect(statSync(join(dir, CRL_FILE)).mode & 0o777).toBe(0o600);
  });

  async function relaySilenceStand(silent: (elapsedMs: number) => boolean) {
    const c = await company(true);
    const target = await listening(c.app);
    const copy = { machine: 'cccccccc-0000-4000-8000-00000000000c', networkId: `99bb2233${'2'.repeat(24)}` };
    const { catalog } = syncCatalog(copy);
    const failOnce = { on: false };
    const db = new Proxy(c.db, {
      get: (obj, prop, receiver) => {
        if (prop !== 'select') return Reflect.get(obj, prop, receiver) as unknown;
        return (...args: unknown[]) => {
          const query = (obj.select as (...a: unknown[]) => { from: (table: unknown) => unknown })(...args);
          return new Proxy(query, {
            get: (q, name, qReceiver) =>
              name !== 'from'
                ? (Reflect.get(q, name, qReceiver) as unknown)
                : (table: unknown) => {
                    if (failOnce.on && table === publicLinks) {
                      failOnce.on = false;
                      throw new Error('statement timeout');
                    }
                    return q.from(table);
                  },
          });
        };
      },
    }) as Db;

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date', 'performance'] });
    const startMono = performance.now();
    const ownClient = `acme-${MACHINE_ID.slice(0, 8)}-link`;
    let syncRecord = { state: 'off' as 'on' | 'off', copy: null as string | null, epoch: 0, generation: 1, at: null as number | null };
    let silentReads = 0;
    const relayClient: SyncControllerOptions['relay'] = {
      route: async () => {
        if (silent(performance.now() - startMono)) {
          silentReads += 1;
          return { known: false, why: 'unreachable' };
        }
        return { known: true, state: 'held', client: ownClient, since: 1, generation: 1, relayStarted: 100, evictionBound: 30, sync: syncRecord };
      },
      setSync: async (_name, _key, post) => {
        syncRecord = { state: post.state, copy: post.copy, epoch: post.epoch, generation: post.generation, at: Math.floor(Date.now() / 1000) };
        return { stored: true, sync: syncRecord };
      },
    };
    let linkStarts = 0;
    const { keeper, lines, offered } = await keeperBeside({ ...c, db }, target, folder(), {
      lease: fakeLease({ othersHoldData: true }),
      now: () => ({ wall: Date.now(), mono: performance.now() }),
      throughput: { start: ignore, stop: ignore, best: () => ({}) },
      everyMs: 3000,
      linkEveryMs: 3000,
      peerEveryMs: 60_000,
      beatEveryMs: 60_000,
      guardEveryMs: 60_000,
      copies: { everyMs: 60_000 },
      clientFor: () => (linkStarts++, { program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }),
      sync: { catalog, relay: relayClient, everyMs: 3000, routeEveryMs: 0 },
    });
    onTestFinished(async () => {
      await keeper.stop();
      vi.useRealTimers();
    });

    const stepUntil = async (stepMs: number, check: () => boolean) => {
      while (!check()) {
        await vi.advanceTimersByTimeAsync(stepMs);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    };
    return { c, keeper, lines, offered, failOnce, startMono, linkStarts: () => linkStarts, silentReads: () => silentReads, stepUntil };
  }

  it('keeps the leader link and peer tunnel running through six-minute hiccups on virtual clocks, and says why when the link goes', async () => {
    /* Every six virtual minutes the path through hornhoof.org gives no answer for four seconds. */
    const { c, keeper, lines, offered, failOnce, startMono, linkStarts, stepUntil } = await relaySilenceStand(
      elapsed => (elapsed >= 357_000 && elapsed < 361_000) || (elapsed >= 717_000 && elapsed < 721_000),
    );
    await stepUntil(3000, () => keeper.mode() === 'lead' && offered.length === 1 && linkStarts() === 1);

    /* Six virtual minutes in: the relay hiccup drops neither tunnel, and restarts neither frpc. */
    const toSixMin = 360_000 - (performance.now() - startMono);
    await vi.advanceTimersByTimeAsync(toSixMin + 6_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(keeper.mode()).toBe('lead');
    expect([offered.length, linkStarts()]).toEqual([1, 1]);
    expect(lines).not.toContain('No public link: this machine is not offered to its peers through it.');

    /* Twelve virtual minutes in, with a failed settings read at the same mark: ownLink stays known, so leading resumes
       as soon as the relay answers again, and the peer tunnel still never restarts. */
    const toBeforeTwelveMin = 719_500 - (performance.now() - startMono);
    await vi.advanceTimersByTimeAsync(toBeforeTwelveMin);
    failOnce.on = true;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(keeper.mode()).toBe('lead');
    expect([offered.length, linkStarts()]).toEqual([1, 1]);
    expect(lines).not.toContain('No public link: this machine is not offered to its peers through it.');

    /* When the link goes for good, the keeper says why before stopping each tunnel. */
    await c.db.delete(publicLinks);
    await stepUntil(3000, () => lines.includes('No public link: the tunnel waits.') && lines.includes('No public link: this machine is not offered to its peers through it.'));
    const linkWhyAt = lines.indexOf('Stopping the public link: the database holds no public link.');
    const peerWhyAt = lines.indexOf('Stopping the peer tunnel: the database holds no public link.');
    expect(linkWhyAt).toBeGreaterThanOrEqual(0);
    expect(linkWhyAt).toBeLessThan(lines.indexOf('No public link: the tunnel waits.'));
    expect(peerWhyAt).toBeGreaterThanOrEqual(0);
    expect(peerWhyAt).toBeLessThan(lines.indexOf('No public link: this machine is not offered to its peers through it.'));

    await keeper.stop();
    vi.useRealTimers();
  });

  it('holds the peer tunnel through one empty read during a one-second relay silence, and says why when the link goes', async () => {
    let silenceFrom = Number.POSITIVE_INFINITY;
    const { c, keeper, lines, offered, failOnce, startMono, linkStarts, silentReads, stepUntil } = await relaySilenceStand(
      elapsed => elapsed >= silenceFrom && elapsed < silenceFrom + 1_000,
    );
    await stepUntil(3000, () => offered.length === 1 && linkStarts() === 1);

    /* A one-second relay silence leaves one peer read empty; holdThroughOneEmptyRead keeps the peer frpc running. */
    silenceFrom = performance.now() - startMono + 2_500;
    await vi.advanceTimersByTimeAsync(9_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(silentReads()).toBeGreaterThan(0);
    expect([offered.length, linkStarts()]).toEqual([1, 1]);
    expect(lines).not.toContain('No public link: this machine is not offered to its peers through it.');

    /* A single failed settings read keeps the last settings as well, restarting neither tunnel. */
    failOnce.on = true;
    await vi.advanceTimersByTimeAsync(3_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect([offered.length, linkStarts()]).toEqual([1, 1]);
    expect(lines).not.toContain('No public link: this machine is not offered to its peers through it.');

    /* When the link goes for good, the keeper says why before stopping each tunnel. */
    await c.db.delete(publicLinks);
    await stepUntil(3000, () => lines.includes('No public link: the tunnel waits.') && lines.includes('No public link: this machine is not offered to its peers through it.'));
    const linkWhyAt = lines.indexOf('Stopping the public link: the database holds no public link.');
    const peerWhyAt = lines.indexOf('Stopping the peer tunnel: the database holds no public link.');
    expect(linkWhyAt).toBeGreaterThanOrEqual(0);
    expect(linkWhyAt).toBeLessThan(lines.indexOf('No public link: the tunnel waits.'));
    expect(peerWhyAt).toBeGreaterThanOrEqual(0);
    expect(peerWhyAt).toBeLessThan(lines.indexOf('No public link: this machine is not offered to its peers through it.'));

    await keeper.stop();
    vi.useRealTimers();
  });

  it('offers no peer doors in read mode, stops the public link on the first read after a lease ends, and stops peer doors when leading ends', async () => {
    const c = await company(true);
    await peerSecret(c.db, c.config, 'data', true);
    await peerSecret(c.db, c.config, 'app', true);
    const target = await listening(c.app);
    const copy = { machine: 'cccccccc-0000-4000-8000-00000000000c', networkId: `99bb2233${'2'.repeat(24)}` };
    const { catalog } = syncCatalog(copy);
    const ownClient = `acme-${MACHINE_ID.slice(0, 8)}-link`;
    let syncRecord = { state: 'off' as 'on' | 'off', copy: null as string | null, epoch: 0, generation: 1, at: null as number | null };
    const relayClient: SyncControllerOptions['relay'] = {
      route: async () => ({ known: true, state: 'held', client: ownClient, since: 1, generation: 1, relayStarted: 100, evictionBound: 30, sync: syncRecord }),
      setSync: async (_name, _key, post) => {
        syncRecord = { state: post.state, copy: post.copy, epoch: post.epoch, generation: post.generation, at: Math.floor(Date.now() / 1000) };
        return { stored: true, sync: syncRecord };
      },
    };

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    onTestFinished(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });
    const stepUntil = async (stepMs: number, check: () => boolean) => {
      while (!check()) {
        await vi.advanceTimersByTimeAsync(stepMs);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    };

    /* A keeper in read mode never offers peer doors through hornhoof.org, even when both peer secrets exist. */
    const reader = await keeperBeside(c, target, folder(), {
      lease: null,
      throughput: { start: ignore, stop: ignore, best: () => ({}) },
      everyMs: 3000,
      linkEveryMs: 3000,
      peerEveryMs: 3000,
      beatEveryMs: 60_000,
      guardEveryMs: 60_000,
    });
    let readerPorts = false;
    void reader.keeper.peerPorts().then(() => {
      readerPorts = true;
    });
    await stepUntil(3000, () => readerPorts);
    await vi.advanceTimersByTimeAsync(9000);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(reader.keeper.mode()).toBe('read');
    expect(reader.offered).toEqual([]);
    await reader.keeper.stop();

    /* When a leader's lease ends, its public link stops at the first read, and its peer tunnel stops once read mode holds. */
    const clock = { wall: Date.now(), mono: 1_000_000 };
    const renews = { hold: true };
    const leaderLease = fakeLease({ othersHoldData: true, renew: async () => renews.hold });
    let linkStarts = 0;
    const leader = await keeperBeside(c, target, folder(), {
      lease: leaderLease,
      now: () => ({ ...clock }),
      throughput: { start: ignore, stop: ignore, best: () => ({}) },
      everyMs: 20,
      linkEveryMs: 3000,
      peerEveryMs: 3000,
      beatEveryMs: 60_000,
      guardEveryMs: 60_000,
      copies: { everyMs: 60_000 },
      clientFor: () => (linkStarts++, { program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }),
      sync: { catalog, relay: relayClient, everyMs: 3000, routeEveryMs: 0, linkPauseMs: 30_000 },
    });
    let leaderPorts = false;
    void leader.keeper.peerPorts().then(() => {
      leaderPorts = true;
    });
    await stepUntil(20, () => leaderPorts && leader.keeper.mode() === 'lead' && leader.offered.length === 1 && linkStarts === 1);

    const kill = vi.spyOn(ChildProcess.prototype, 'kill');
    leaderLease.problemsAre(['another machine holds the lease']);
    renews.hold = false;
    clock.wall += 11_000;
    clock.mono += 11_000;
    await stepUntil(20, () => leader.keeper.mode() === 'read' && !leader.keeper.linkWanted());
    expect(kill).not.toHaveBeenCalled();

    /* First 3 s read: the public link is told to stop at once, while the peer tunnel holds through one read. */
    await vi.advanceTimersByTimeAsync(3000);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(kill).toHaveBeenCalledTimes(1);
    await until(() => leader.lines.includes('No public link: the tunnel waits.'));
    expect(leader.lines).toContain('Stopping the public link while this keeper holds no lease or waits after a lease ended.');

    /* Second 3 s read: sustained read mode stops the peer tunnel as well, saying why first. */
    await vi.advanceTimersByTimeAsync(3000);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(kill).toHaveBeenCalledTimes(2);
    await until(() => leader.lines.includes('No public link: this machine is not offered to its peers through it.'));
    const peerWhyAt = leader.lines.indexOf('Stopping the peer tunnel: this keeper no longer leads.');
    expect(peerWhyAt).toBeGreaterThanOrEqual(0);
    expect(peerWhyAt).toBeLessThan(leader.lines.indexOf('No public link: this machine is not offered to its peers through it.'));

    await leader.keeper.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
});
