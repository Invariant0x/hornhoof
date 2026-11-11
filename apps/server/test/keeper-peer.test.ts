import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import http2, { type ClientHttp2Session, type ClientHttp2Stream } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { gzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { loadConfig } from '../src/config.js';
import { certificates, companies, machines, people, publicLinks } from '../src/db/schema.js';
import { bundleRows } from '../src/modules/backups/records.js';
import { AGE_KEY_FILE } from '../src/modules/keeper/age-key.js';
import { BUNDLES_DIR } from '../src/modules/keeper/backups.js';
import { CERT_FILE, type HeldCertificate } from '../src/modules/keeper/certificate.js';
import { Keeper, type KeeperOptions } from '../src/modules/keeper/keeper.js';
import { machineKey, type MachineKey } from '../src/modules/keeper/machine-keys.js';
import { CRL_FILE } from '../src/modules/keeper/peer-link.js';
import { saveLink } from '../src/modules/link/link.js';
import { peerConfigFor, type PeerServices } from '../src/modules/link/peer-client.js';
import { certFacts, issueCertificate, makeAuthority } from '../src/modules/network/authority.js';
import { authorityOf } from '../src/modules/network/store.js';
import { APP_AUTHORITY } from '../src/net/peer-server.js';
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

async function listening(app: FastifyInstance): Promise<Target> {
  await app.listen({ host: '127.0.0.1', port: 0 });
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

  it('keeps the list of revoked certificates where only the keeper reads it', async () => {
    const c = await company();
    const { keeper, dir } = await keeperBeside(c, await listening(c.app));
    await keeper.peerPorts();
    expect(existsSync(join(dir, CRL_FILE))).toBe(true);
    expect(statSync(join(dir, CRL_FILE)).mode & 0o777).toBe(0o600);
  });
});
