import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import tls, { type TLSSocket } from 'node:tls';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { loadConfig, type Config } from '../src/config.js';
import { encryptSecret } from '../src/crypto/secrets.js';
import type { Db } from '../src/db/client.js';
import { companies, linkTls, publicLinks } from '../src/db/schema.js';
import { Keeper, type KeeperOptions } from '../src/modules/keeper/keeper.js';
import { KeeperServed } from '../src/modules/keeper/served.js';
import { readKeeperState, writeKeeperState } from '../src/modules/keeper/state.js';
import { configFor, type FrpcLocal } from '../src/modules/link/client.js';
import { saveLink, tunnelSettings, writeTunnelSettings } from '../src/modules/link/link.js';
import type { TunnelSettings } from '../src/modules/link/tunnel.js';
import type { Target } from '../src/net/proxy.js';
import { newAccountKey } from '../src/modules/tls/acme.js';
import { linkMode, readLinkMode, saveTls, servedCertificate, updateTls } from '../src/modules/tls/store.js';
import { certInfo, selfSigned } from '../src/modules/tls/x509.js';
import { SETUP, setUpCompany, TEST_SECRET, testApp, until } from './helpers.js';
import { fakeLease } from './fake-lease.js';
import { visitorHeader } from './proxy-v2.js';

const MACHINE_ID = `ab12cd34${'0'.repeat(24)}`;
const CLIENT_ID = 'acme-ab12cd34-link';
const HOST = 'acme.hornhoof.test';
const VISITOR = '203.0.113.9';
const OTHER_VISITOR = '203.0.113.10';
const CERTIFICATES_ON = { ACME_DIRECTORY: 'https://ca.hornhoof.test/directory' };
const NO_MACHINE_ID = 'The keeper carries no public link: HORNHOOF_MACHINE_ID is not set. Run the install command again.';
const THROUGH_AN_OUTAGE = 20;
const WAIT_MS = 10_000;
/* Nothing listens here, for the tests that send no traffic through to the app. */
const NOWHERE: Target = { host: '127.0.0.1', port: 1 };

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-keeper-link-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function companyWithLink(env: NodeJS.ProcessEnv = {}) {
  const { app, db, config } = await testApp(env);
  await setUpCompany(app);
  const [company] = await db.select().from(companies);
  const companyId = company!.id;
  const tunnel = { serverAddr: 'relay.hornhoof.test', serverPort: 443, protocol: 'wss' };
  await saveLink(db, config, companyId, { name: 'acme', url: `https://${HOST}`, key: 'k'.repeat(32), tunnel });
  return { app, db, config, companyId };
}

/* A link_tls row in https, as the manager leaves it; the certificate's fingerprint is what a visitor should see. */
async function holdCertificate(db: Db, config: Config, companyId: string, name = 'acme'): Promise<string> {
  const pair = await selfSigned(HOST);
  const accountKeyEnc = encryptSecret(await newAccountKey(), config.secret);
  const certKeyEnc = encryptSecret(pair.keyPem, config.secret);
  await saveTls(db, companyId, { directory: CERTIFICATES_ON.ACME_DIRECTORY, accountKeyEnc, name, mode: 'https', certPem: pair.certPem, certKeyEnc });
  return certInfo(pair.certPem).fingerprint256;
}

/* A stand-in for frpc: the config is the real one, and the child sleeps until it is stopped. */
function fakeFrpc(dir: string) {
  const configFile = join(dir, 'frpc.toml');
  const startedFile = join(dir, 'started.txt');
  const SLEEPER = `require('node:fs').appendFileSync(process.argv[1], process.pid + '\\n'); setInterval(() => {}, 1000);`;
  const clientFor = (settings: TunnelSettings, clientId: string, local: FrpcLocal) => {
    writeFileSync(configFile, configFor(settings, { clientId, local }));
    return { program: process.execPath, args: ['-e', SLEEPER, startedFile] };
  };
  const started = () => (existsSync(startedFile) ? readFileSync(startedFile, 'utf8').trim().split('\n') : []);
  const alive = (pid: string) => {
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch {
      return false;
    }
  };
  return { clientFor, started, alive, config: () => readFileSync(configFile, 'utf8') };
}

async function keeperOn(db: Db, env: NodeJS.ProcessEnv = {}, extra: Partial<KeeperOptions> = {}) {
  const dir = folder();
  const frpc = fakeFrpc(dir);
  const lines: string[] = [];
  const keeper = new Keeper({
    config: loadConfig({ HORNHOOF_SECRET: TEST_SECRET, HORNHOOF_CONTROL_DIR: dir, HORNHOOF_MACHINE_ID: MACHINE_ID, ACME_DIRECTORY: 'off', ...env }),
    db,
    /* A lease that always holds, as on a healthy machine, unless the test gives another. */
    lease: fakeLease(),
    /* The keeper's own folder, where it keeps the key of this machine. */
    dir: folder(),
    app: NOWHERE,
    frontHost: null,
    log: line => lines.push(line),
    host: '127.0.0.1',
    ports: { front: 0, linkHttp: 0, linkTls: 0, peer: 0, peerApp: 0 },
    everyMs: 20,
    linkEveryMs: 50,
    clientFor: frpc.clientFor,
    ...extra,
  });
  const ports = await keeper.start();
  onTestFinished(() => keeper.stop());
  const wordOfLink = () => readKeeperState(dir)?.link ?? null;
  const namesCertificate = (fingerprint256: string | null) => until(() => wordOfLink()?.host === HOST && wordOfLink()?.fingerprint256 === fingerprint256);
  return { keeper, dir, frpc, lines, ports, wordOfLink, namesCertificate };
}

/* The database, with the chosen tables' reads throwing while the test says. Queries go through select().from(). */
function failingDb(db: Db, failsOn: (table: unknown) => boolean) {
  const state = { on: false, failed: 0 };
  const select = (...args: unknown[]) => {
    const query = (db.select as (...a: unknown[]) => { from: (table: unknown) => unknown })(...args);
    return new Proxy(query, {
      get: (target, name, receiver) => {
        if (name !== 'from') return Reflect.get(target, name, receiver) as unknown;
        return (table: unknown) => {
          if (state.on && failsOn(table)) {
            state.failed++;
            throw new Error('the database does not answer');
          }
          return target.from(table);
        };
      },
    });
  };
  return { db: new Proxy(db, { get: (target, name, receiver) => (name === 'select' ? select : (Reflect.get(target, name, receiver) as unknown)) }), state };
}

/* A connection as the keeper's frpc opens it for a visitor: the PROXY header, then TLS. */
async function overTls(port: number, visitor = VISITOR): Promise<TLSSocket> {
  const raw = net.connect(port, '127.0.0.1');
  raw.on('error', () => {});
  onTestFinished(() => void raw.destroy());
  await once(raw, 'connect');
  raw.write(visitorHeader(visitor));
  const secure = tls.connect({ socket: raw, servername: HOST, rejectUnauthorized: false });
  secure.on('error', () => {});
  await once(secure, 'secureConnect');
  return secure;
}

const seenFingerprint = async (port: number) => {
  const secure = await overTls(port);
  const { fingerprint256 } = secure.getPeerCertificate();
  secure.destroy();
  return fingerprint256;
};

function askOver(socket: TLSSocket, options: http.RequestOptions, body?: string): Promise<{ status: number; body: string; cookies: string[]; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const out = http.request({ createConnection: () => socket, ...options, headers: { host: HOST, connection: 'close', ...options.headers } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), cookies: (res.headers['set-cookie'] ?? []).map(cookie => cookie.split('=')[0]!), headers: res.headers }));
    });
    out.on('error', reject);
    out.end(body);
  });
}

async function listening(server: http.Server): Promise<Target> {
  onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
}

describe('the link in the keeper', () => {
  it("runs frpc with the link's client id and the network transport, pointed at itself", async () => {
    const { db } = await companyWithLink();
    const { frpc, ports } = await keeperOn(db);
    await until(() => frpc.started().length === 1);
    const config = frpc.config();
    expect(config).toContain(`clientID = "${CLIENT_ID}"`);
    expect(config).toContain(`metadatas.client = "${CLIENT_ID}"`);
    expect(config).toContain('transport.heartbeatInterval = -1');
    expect(config).toContain('type = "http"');
    expect(config).toContain(`localPort = ${ports.linkHttp}`);
  });

  it('runs https when linkMode says so', async () => {
    const { db, config, companyId } = await companyWithLink();
    await holdCertificate(db, config, companyId);
    const { frpc, ports } = await keeperOn(db, CERTIFICATES_ON);
    await until(() => frpc.started().length === 1);
    expect(frpc.config()).toContain('type = "https"');
    expect(frpc.config()).toContain(`localPort = ${ports.linkTls}`);
    expect(frpc.config()).toContain('transport.proxyProtocolVersion = "v2"');
  });

  it("starts frpc again when the link's mode changes, and only then", async () => {
    const { db, config, companyId } = await companyWithLink();
    const { frpc } = await keeperOn(db, CERTIFICATES_ON);
    await until(() => frpc.started().length === 1);
    expect(frpc.config()).toContain('type = "http"');

    await holdCertificate(db, config, companyId);
    await until(() => frpc.started().length === 2);
    expect(frpc.config()).toContain('type = "https"');
    await sleep(200);
    expect(frpc.started()).toHaveLength(2);
  });

  /* Only https may stay on in such an outage: a mode read as http on a failed read would restart frpc on every hiccup. */
  it("keeps frpc in https when only the certificate's read fails", async () => {
    const { db, config, companyId } = await companyWithLink();
    const fingerprint = await holdCertificate(db, config, companyId);
    const flaky = failingDb(db, table => table === linkTls);
    const { frpc, ports, namesCertificate } = await keeperOn(flaky.db, CERTIFICATES_ON);
    await until(() => frpc.started().length === 1);
    await namesCertificate(fingerprint);

    flaky.state.on = true;
    await until(() => flaky.state.failed >= THROUGH_AN_OUTAGE);

    expect(frpc.started()).toHaveLength(1);
    expect(frpc.alive(frpc.started()[0]!)).toBe(true);
    expect(frpc.config()).toContain('type = "https"');
    expect(await seenFingerprint(ports.linkTls)).toBe(fingerprint);
  });

  it('keeps frpc and the certificate when the database does not answer', async () => {
    const { db, config, companyId } = await companyWithLink();
    const fingerprint = await holdCertificate(db, config, companyId);
    const flaky = failingDb(db, () => true);
    const { frpc, ports, lines, wordOfLink, namesCertificate } = await keeperOn(flaky.db, CERTIFICATES_ON);
    await until(() => frpc.started().length === 1);
    await namesCertificate(fingerprint);

    flaky.state.on = true;
    await until(() => flaky.state.failed >= THROUGH_AN_OUTAGE);

    expect(frpc.started()).toHaveLength(1);
    expect(frpc.alive(frpc.started()[0]!)).toBe(true);
    expect(await seenFingerprint(ports.linkTls)).toBe(fingerprint);
    expect(wordOfLink()).toEqual({ host: HOST, fingerprint256: fingerprint });
    /* Once for each thing it reads from the database, not once a read. What it cannot read from its app is another line. */
    expect(lines.filter(line => line.includes('cannot read') && !line.includes('from its app'))).toHaveLength(2);
  });

  it('uses the same client id after the keeper starts again', async () => {
    const { db } = await companyWithLink();
    const first = await keeperOn(db);
    await until(() => first.frpc.started().length === 1);
    expect(first.frpc.config()).toContain(`clientID = "${CLIENT_ID}"`);
    await first.keeper.stop();
    expect(first.frpc.alive(first.frpc.started()[0]!)).toBe(false);

    const second = await keeperOn(db);
    await until(() => second.frpc.started().length === 1);
    expect(second.frpc.config()).toContain(`clientID = "${CLIENT_ID}"`);
  });

  it('waits in stop() for an frpc that is already exiting', async () => {
    const { db } = await companyWithLink();
    const dir = folder();
    const startedFile = join(dir, 'started.txt');
    const termFile = join(dir, 'term.txt');
    const slowFrpc = `
      const fs = require('node:fs');
      const [out, term] = process.argv.slice(1);
      process.on('SIGTERM', () => fs.writeFileSync(term, '1'));
      process.on('SIGUSR2', () => process.exit(0));
      fs.appendFileSync(out, process.pid + '\\n');
      setInterval(() => {}, 1000);
    `;
    const { keeper, frpc } = await keeperOn(db, {}, {
      clientFor: () => ({ program: process.execPath, args: ['-e', slowFrpc, startedFile, termFile] }),
    });
    const pidOf = () => (existsSync(startedFile) ? readFileSync(startedFile, 'utf8').split('\n').slice(0, -1)[0] : undefined);
    onTestFinished(() => {
      const pid = pidOf();
      if (pid) {
        try {
          process.kill(Number(pid), 'SIGKILL');
        } catch {
          /* Already gone. */
        }
      }
    });
    await until(() => pidOf() !== undefined);
    const pid = pidOf()!;

    await db.delete(publicLinks);
    await until(() => existsSync(termFile));

    let stopped = false;
    const stopping = keeper.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stopped).toBe(false);
    expect(frpc.alive(pid)).toBe(true);

    process.kill(Number(pid), 'SIGUSR2');
    await stopping;
    expect(frpc.alive(pid)).toBe(false);
  });

  it('reads a started frpc only from a complete pid line, and never probes pid 0', () => {
    const dir = folder();
    const frpc = fakeFrpc(dir);
    writeFileSync(join(dir, 'started.txt'), '');
    expect(frpc.started()).toEqual([]);
    writeFileSync(join(dir, 'started.txt'), '42');
    expect(frpc.started()).toEqual([]);
    expect(() => frpc.alive('')).toThrow('Not a process id');
    expect(() => frpc.alive('0')).toThrow('Not a process id');
  });

  it('stops frpc when the link goes', async () => {
    const { db } = await companyWithLink();
    const { frpc, wordOfLink, namesCertificate } = await keeperOn(db);
    await until(() => frpc.started().length === 1);
    await namesCertificate(null);

    await db.delete(publicLinks);

    await until(() => !frpc.alive(frpc.started()[0]!));
    await until(() => wordOfLink()?.host === null);
    expect(wordOfLink()).toEqual({ host: null, fingerprint256: null });
  });

  it('runs the link from the recovery file while the database has none', async () => {
    /* A server set up anew after the old one was lost: no company, and so no link of its own. */
    const { db } = await testApp();
    const { frpc, dir } = await keeperOn(db);
    await sleep(150);
    expect(frpc.started()).toEqual([]);
    /* What is no link's settings starts nothing. */
    writeFileSync(join(dir, 'recovery-link.json'), '{"name": "acme"');
    await sleep(150);
    expect(frpc.started()).toEqual([]);
    const link = { name: 'acme', url: `https://${HOST}`, key: 'k'.repeat(32), tunnel: { serverAddr: 'relay.hornhoof.test', serverPort: 443, protocol: 'wss' } };
    writeFileSync(join(dir, 'recovery-link.json'), JSON.stringify(link));
    await until(() => frpc.started().length === 1);
    /* In http: the certificate comes back with the restored database. */
    expect(frpc.config()).toContain('subdomain = "acme"');
    expect(frpc.config()).toContain('type = "http"');
    /* The file gone, as after the restore, with no link in the database still: the link stops. */
    rmSync(join(dir, 'recovery-link.json'));
    await until(() => !frpc.alive(frpc.started()[0]!));

    /* A database that has a link goes by its own, whatever a file says. */
    const own = await companyWithLink();
    const beside = await keeperOn(own.db);
    writeFileSync(join(beside.dir, 'recovery-link.json'), JSON.stringify({ ...link, name: 'other', url: 'https://other.hornhoof.test' }));
    await until(() => beside.frpc.started().length === 1);
    await sleep(150);
    expect(beside.frpc.config()).not.toContain('other');
    expect(beside.frpc.started()).toHaveLength(1);
  });

  it('runs no link without a machine id', async () => {
    const { db } = await companyWithLink();
    const { frpc, lines, namesCertificate } = await keeperOn(db, { HORNHOOF_MACHINE_ID: '' });
    await namesCertificate(null);
    await sleep(200);
    expect(frpc.started()).toEqual([]);
    expect(lines.filter(line => line === NO_MACHINE_ID)).toHaveLength(1);
  });
});

describe("the link's certificate in the keeper", () => {
  it("serves the link's stored certificate and names it in keeper.json", async () => {
    const { db, config, companyId } = await companyWithLink();
    const fingerprint = await holdCertificate(db, config, companyId);
    const { ports, wordOfLink, namesCertificate } = await keeperOn(db, CERTIFICATES_ON);
    await namesCertificate(fingerprint);
    expect(wordOfLink()).toEqual({ host: HOST, fingerprint256: fingerprint });
    expect(await seenFingerprint(ports.linkTls)).toBe(fingerprint);
  });

  it('serves a stand-in for a certificate of another name', async () => {
    const { db, config, companyId } = await companyWithLink();
    await holdCertificate(db, config, companyId, 'old');
    const { ports, namesCertificate } = await keeperOn(db, CERTIFICATES_ON);
    await namesCertificate(null);
    const secure = await overTls(ports.linkTls);
    const seen = secure.getPeerCertificate();
    secure.destroy();
    expect(seen.subjectaltname).toBe(`DNS:${HOST}`);
    expect(seen.issuer).toEqual(seen.subject);
  });

  it('takes a new certificate from the database', async () => {
    const { db, config, companyId } = await companyWithLink();
    await holdCertificate(db, config, companyId);
    const { ports, namesCertificate } = await keeperOn(db, CERTIFICATES_ON);
    const next = await selfSigned(HOST);
    await updateTls(db, companyId, { certPem: next.certPem, certKeyEnc: encryptSecret(next.keyPem, config.secret) });
    const fingerprint = certInfo(next.certPem).fingerprint256;
    await namesCertificate(fingerprint);
    expect(await seenFingerprint(ports.linkTls)).toBe(fingerprint);
  });

  /* The app moves the link to https on the word, so the word says only what the listener really holds. */
  it('names no certificate the listener did not take', async () => {
    const { db, config, companyId } = await companyWithLink();
    const fingerprint = await holdCertificate(db, config, companyId);
    const { ports, lines, wordOfLink, namesCertificate } = await keeperOn(db, CERTIFICATES_ON);
    await namesCertificate(fingerprint);

    const other = await selfSigned(HOST);
    const another = await selfSigned(HOST);
    await updateTls(db, companyId, { certPem: other.certPem, certKeyEnc: encryptSecret(another.keyPem, config.secret) });
    await until(() => lines.some(line => line.includes('cannot read or serve')));
    await sleep(200);

    expect(wordOfLink()).toEqual({ host: HOST, fingerprint256: fingerprint });
    expect(await seenFingerprint(ports.linkTls)).toBe(fingerprint);
    /* Once, though each read tries again. */
    expect(lines.filter(line => line.includes('cannot read or serve'))).toHaveLength(1);
  });

  it("lets the app's KeeperServed resolve only once the listener serves that certificate", async () => {
    const { db, config, companyId } = await companyWithLink();
    const { dir, ports } = await keeperOn(db, CERTIFICATES_ON);
    const pair = await selfSigned(HOST);
    const served = new KeeperServed({ dir, timeoutMs: WAIT_MS, everyMs: 10 });
    const using = served.use(HOST, pair);

    const accountKeyEnc = encryptSecret(await newAccountKey(), config.secret);
    await saveTls(db, companyId, { directory: CERTIFICATES_ON.ACME_DIRECTORY, accountKeyEnc, name: 'acme', mode: 'http', certPem: pair.certPem, certKeyEnc: encryptSecret(pair.keyPem, config.secret) });

    await using;
    expect(await seenFingerprint(ports.linkTls)).toBe(certInfo(pair.certPem).fingerprint256);
  });

  it('keeps no key in keeper.json', async () => {
    const { db, config, companyId } = await companyWithLink();
    const fingerprint = await holdCertificate(db, config, companyId);
    const { dir, namesCertificate } = await keeperOn(db, CERTIFICATES_ON);
    await namesCertificate(fingerprint);
    /* A boolean only: a failure here must not print a key. */
    expect(readFileSync(join(dir, 'keeper.json'), 'utf8').includes('PRIVATE KEY')).toBe(false);
  });
});

describe("the link's TLS door", () => {
  const echoHeaders = () =>
    listening(
      http.createServer((req, res) => {
        req.resume();
        res.end(JSON.stringify(req.headers));
      }),
    );

  it('passes link TLS traffic to the app with the visitor from the PROXY header', async () => {
    const { db } = await companyWithLink();
    const { ports } = await keeperOn(db, {}, { app: await echoHeaders() });
    const forged = { 'x-forwarded-for': '198.51.100.7', 'x-forwarded-proto': 'http', 'x-hornhoof-via': 'x' };
    const seen = JSON.parse((await askOver(await overTls(ports.linkTls), { headers: forged })).body) as http.IncomingHttpHeaders;
    expect(seen['x-forwarded-for']).toBe(VISITOR);
    expect(seen['x-forwarded-proto']).toBe('https');
    expect(seen['x-hornhoof-via']).toBeUndefined();
  });

  it('carries a WebSocket, and closes it when the visitor goes', async () => {
    const server = http.createServer();
    const sockets = new WebSocketServer({ server });
    const closedAtTheApp = new Promise<void>(resolve => {
      sockets.on('connection', socket => {
        socket.on('message', message => socket.send(`heard ${String(message)}`));
        socket.on('close', () => resolve());
      });
    });
    const { db } = await companyWithLink();
    const { ports } = await keeperOn(db, {}, { app: await listening(server) });
    const secure = await overTls(ports.linkTls);
    const client = new WebSocket(`ws://${HOST}/socket`, { createConnection: () => secure });
    onTestFinished(() => client.terminate());
    await once(client, 'open');
    client.send('hello');
    const [message] = (await once(client, 'message')) as [Buffer];
    expect(message.toString()).toBe('heard hello');
    client.close();
    await closedAtTheApp;
  });

  it('lets a stop end at once when its connections are idle', async () => {
    const { db } = await companyWithLink();
    const { keeper, ports } = await keeperOn(db, {}, { app: await echoHeaders() });
    const secure = await overTls(ports.linkTls);
    const answered = await askOver(secure, { headers: { connection: 'keep-alive' } });
    expect(answered.status).toBe(200);
    /* The grace for what is still in flight is 5 s, on a clock that from here never moves: a stop that waited for it would
       never end. A timer set before is cleared as ever. The test database keeps timers of its own on this clock, so their
       count says nothing about the keeper's. */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true });
    onTestFinished(() => void vi.useRealTimers());
    await keeper.stop();
  });

  it('takes this traffic as over the link, and counts sign-ins by the visitor', async () => {
    const { app, db } = await companyWithLink({ TUNNEL_HOST: 'localhost' });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const target = { host: '127.0.0.1', port: (app.server.address() as AddressInfo).port };
    const { ports } = await keeperOn(db, {}, { app: target });

    const signIn = async (visitor: string, password: string) =>
      askOver(await overTls(ports.linkTls, visitor), { method: 'POST', path: '/api/auth/login', headers: { 'content-type': 'application/json' } }, JSON.stringify({ email: 'ivan@acme.com', password }));

    expect((await signIn(VISITOR, SETUP.password)).cookies).toContain('__Host-hh_session');
    for (let i = 0; i < 10; i++) expect((await signIn(VISITOR, 'not the password')).status).toBe(401);
    expect((await signIn(VISITOR, 'not the password')).status).toBe(429);
    expect((await signIn(OTHER_VISITOR, 'not the password')).status).toBe(401);
  });
});

describe('the lease proof on the link', () => {
  const NONCE = randomBytes(16).toString('base64url');
  const LEASE = `/api/network/lease?nonce=${NONCE}`;
  const BAD_NONCE = { error: { code: 'validation', message: 'nonce must be 16 to 128 letters, digits, - or _.' } };

  /* An app that notes every request the keeper passed on to it, so a test sees what the keeper answered by itself. What
     the keeper asks the app for itself, as its machine's certificate, is none of those. */
  async function notingApp() {
    const got: string[] = [];
    const target = await listening(
      http.createServer((req, res) => {
        req.resume();
        if (req.headers['x-hornhoof-via'] === 'keeper') return void res.writeHead(503).end();
        got.push(`${req.method} ${req.url}`);
        res.end('the app');
      }),
    );
    return { target, got };
  }

  const ask = (port: number, path: string, method = 'GET'): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> =>
    new Promise((resolve, reject) => {
      const out = http.request({ host: '127.0.0.1', port, path, method, agent: false }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), headers: res.headers }));
      });
      out.on('error', reject);
      out.end();
    });

  it('answers the lease itself on both doors of the link', async () => {
    const { db } = await companyWithLink();
    const { target, got } = await notingApp();
    const { ports, keeper } = await keeperOn(db, {}, { app: target });
    const proof = { machine: MACHINE_ID, term: keeper.term(), nonce: NONCE };
    expect(proof.term).toEqual({ number: 1, machine: 'machine-a', split: false });

    const plain = await ask(ports.linkHttp, LEASE);
    expect(plain.status).toBe(200);
    expect(plain.headers['content-type']).toBe('application/json');
    expect(plain.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(plain.body)).toEqual(proof);

    const secure = await askOver(await overTls(ports.linkTls), { path: LEASE });
    expect(secure.status).toBe(200);
    expect(secure.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(secure.body)).toEqual(proof);
    expect(got).toEqual([]);
  });

  it('answers only the lease on a hidden name, and passes nothing on', async () => {
    const { db, config, companyId } = await companyWithLink();
    /* A name Hornhoof took for the company's machines alone. */
    const tunnel = { serverAddr: 'relay.hornhoof.test', serverPort: 443, protocol: 'wss' };
    await saveLink(db, config, companyId, { name: 'acme', url: `https://${HOST}`, key: 'k'.repeat(32), tunnel }, true);
    expect(await tunnelSettings(db, config)).toMatchObject({ name: 'acme', hidden: true });
    const { target, got } = await notingApp();
    const { ports, keeper } = await keeperOn(db, {}, { app: target });
    await until(async () => (await ask(ports.linkHttp, '/')).status === 404);
    for (const path of ['/', '/api/health', '/api/network/switch', '/api/network/leases?nonce=x']) {
      const refused = await ask(ports.linkHttp, path);
      expect([refused.status, JSON.parse(refused.body)], path).toEqual([404, { ok: false }]);
    }
    expect((await ask(ports.linkHttp, '/api/me', 'POST')).status).toBe(404);
    expect((await askOver(await overTls(ports.linkTls), { path: '/tasks' })).status).toBe(404);
    /* A socket is turned away as a page is, on the path of the lease proof too. */
    for (const path of ['/api/nodes/socket', LEASE]) {
      const socket = new WebSocket(`ws://127.0.0.1:${ports.linkHttp}${path}`);
      socket.on('error', () => undefined);
      const [, refusal] = (await once(socket, 'unexpected-response')) as [http.ClientRequest, http.IncomingMessage];
      expect(refusal.statusCode, path).toBe(404);
      refusal.destroy();
      socket.terminate();
    }
    /* No certificate is ever ordered or served for it: what goes through it rides the relay's TLS. */
    await holdCertificate(db, config, companyId);
    expect(await readLinkMode(db, config)).toBe('http');
    /* Who holds the lease is still said, on both doors, and the front door serves the company as ever. */
    const proof = { machine: MACHINE_ID, term: keeper.term(), nonce: NONCE };
    expect(JSON.parse((await ask(ports.linkHttp, LEASE)).body)).toEqual(proof);
    expect(JSON.parse((await askOver(await overTls(ports.linkTls), { path: LEASE })).body)).toEqual(proof);
    expect((await ask(ports.front, '/')).body).toBe('the app');
    expect(got).toEqual(['GET /']);
  });

  it('answers no term while it holds no lease', async () => {
    const { db } = await companyWithLink();
    const lease = fakeLease({ take: () => Promise.reject(new Error('the database is away')) });
    const { ports } = await keeperOn(db, {}, { lease });
    expect(JSON.parse((await ask(ports.linkHttp, LEASE)).body)).toEqual({ machine: MACHINE_ID, term: null, nonce: NONCE });
  });

  it('refuses a nonce it would not send', async () => {
    const { db } = await companyWithLink();
    const { target, got } = await notingApp();
    const { ports } = await keeperOn(db, {}, { app: target });
    for (const path of ['/api/network/lease?nonce=abc', `/api/network/lease?nonce=${'a'.repeat(129)}`, '/api/network/lease', `${LEASE}!`]) {
      const answer = await ask(ports.linkHttp, path);
      expect(answer.status, path).toBe(400);
      expect(answer.headers['cache-control'], path).toBe('no-store');
      expect(JSON.parse(answer.body), path).toEqual(BAD_NONCE);
    }
    expect(got).toEqual([]);
  });

  it('leaves the path to the app on the front door, and every other method and path on the link', async () => {
    const { db } = await companyWithLink();
    const { target, got } = await notingApp();
    const { ports } = await keeperOn(db, {}, { app: target });
    expect((await ask(ports.front, LEASE)).body).toBe('the app');
    expect((await ask(ports.linkHttp, LEASE, 'POST')).body).toBe('the app');
    expect((await ask(ports.linkHttp, '/api/network/leases?nonce=x')).body).toBe('the app');
    expect(got).toEqual([`GET ${LEASE}`, `POST ${LEASE}`, 'GET /api/network/leases?nonce=x']);
  });
});

describe('what the keeper reads', () => {
  it('readLinkMode throws on a failed read, where linkMode says http', async () => {
    const { db, config, companyId } = await companyWithLink();
    await holdCertificate(db, config, companyId);
    const on = { ...config, acmeDirectory: CERTIFICATES_ON.ACME_DIRECTORY };
    const flaky = failingDb(db, table => table === linkTls);
    expect(await readLinkMode(flaky.db, on)).toBe('https');

    flaky.state.on = true;
    await expect(readLinkMode(flaky.db, on)).rejects.toThrow('the database does not answer');
    expect(await linkMode(flaky.db, on)).toBe('http');
  });

  it('readLinkMode says http for certificate data that does not pass', async () => {
    const { db, config, companyId } = await companyWithLink();
    await holdCertificate(db, config, companyId);
    const on = { ...config, acmeDirectory: CERTIFICATES_ON.ACME_DIRECTORY };
    await updateTls(db, companyId, { certPem: 'not a certificate' });
    expect(await readLinkMode(db, on)).toBe('http');
  });

  it('tunnelSettings is what is written to tunnel.json, and null without a link', async () => {
    const { db, config } = await companyWithLink();
    const dir = folder();
    const here = { ...config, controlDir: dir };
    await writeTunnelSettings(db, here);
    const written: unknown = JSON.parse(readFileSync(join(dir, 'tunnel.json'), 'utf8'));
    expect(await tunnelSettings(db, here)).toEqual(written);

    await db.delete(publicLinks);
    expect(await tunnelSettings(db, here)).toBeNull();
  });

  it("tunnelSettings throws when only the certificate's read fails", async () => {
    const { db, config, companyId } = await companyWithLink();
    await holdCertificate(db, config, companyId);
    const on = { ...config, acmeDirectory: CERTIFICATES_ON.ACME_DIRECTORY };
    const flaky = failingDb(db, table => table === linkTls);
    flaky.state.on = true;
    await expect(tunnelSettings(flaky.db, on)).rejects.toThrow('the database does not answer');
  });

  it("servedCertificate gives the row's certificate with its key, for the link's name only", async () => {
    const { db, config, companyId } = await companyWithLink();
    const on = { ...config, acmeDirectory: CERTIFICATES_ON.ACME_DIRECTORY };
    expect(await servedCertificate(db, on)).toEqual({ host: HOST, cert: null });

    const pair = await selfSigned(HOST);
    const accountKeyEnc = encryptSecret(await newAccountKey(), config.secret);
    await saveTls(db, companyId, { directory: on.acmeDirectory, accountKeyEnc, name: 'acme', mode: 'http', certPem: pair.certPem, certKeyEnc: encryptSecret(pair.keyPem, config.secret) });
    const served = await servedCertificate(db, on);
    expect(served?.host).toBe(HOST);
    expect(served?.cert?.certPem).toBe(pair.certPem);
    /* A boolean only: a failure here must not print a key. */
    expect(served?.cert?.keyPem === pair.keyPem).toBe(true);

    await updateTls(db, companyId, { name: 'old' });
    expect(await servedCertificate(db, on)).toEqual({ host: HOST, cert: null });
  });

  /* The manager gives the listener no certificate with certificates off, so the keeper's word must say the same. */
  it('servedCertificate gives no certificate with certificates off', async () => {
    const { db, config, companyId } = await companyWithLink();
    await holdCertificate(db, config, companyId);
    expect(config.acmeDirectory).toBeNull();
    expect(await servedCertificate(db, config)).toEqual({ host: HOST, cert: null });
  });

  it('servedCertificate is null without a link', async () => {
    const { db, config } = await companyWithLink();
    await db.delete(publicLinks);
    expect(await servedCertificate(db, config)).toBeNull();
  });
});

describe('KeeperServed', () => {
  const AT = Date.parse('2026-01-01T00:00:00.000Z');
  const word = (dir: string, link: { host: string | null; fingerprint256: string | null } | null, at = AT) =>
    writeKeeperState(dir, { mode: 'lead', at: new Date(at).toISOString(), link });
  const served = (dir: string, now = AT) => new KeeperServed({ dir, timeoutMs: 100, everyMs: 5, now: () => now });

  it('resolves once keeper.json names that host and fingerprint', async () => {
    const dir = folder();
    const pair = await selfSigned(HOST);
    const fingerprint256 = certInfo(pair.certPem).fingerprint256;
    word(dir, { host: HOST, fingerprint256: 'AA:BB' });
    let resolved = false;
    const using = served(dir)
      .use(HOST, pair)
      .then(() => {
        resolved = true;
      });
    await sleep(30);
    expect(resolved).toBe(false);
    word(dir, { host: HOST, fingerprint256 });
    await using;
    expect(resolved).toBe(true);
  });

  it('takes a stand-in as a null fingerprint, and no link as a null host', async () => {
    const dir = folder();
    word(dir, { host: HOST, fingerprint256: null });
    await expect(served(dir).use(HOST, null)).resolves.toBeUndefined();
    word(dir, { host: null, fingerprint256: null });
    await expect(served(dir).use(null, null)).resolves.toBeUndefined();
  });

  it('throws after timeoutMs otherwise', async () => {
    const dir = folder();
    const pair = await selfSigned(HOST);
    const refused = 'The keeper does not serve this certificate yet.';
    /* A keeper that has not read the link yet says link: null, which is not the word for no link. */
    word(dir, null);
    await expect(served(dir).use(null, null)).rejects.toThrow(refused);
    word(dir, { host: HOST, fingerprint256: null });
    await expect(served(dir).use(HOST, pair)).rejects.toThrow(refused);
    word(dir, { host: 'other.hornhoof.test', fingerprint256: null });
    await expect(served(dir).use(HOST, null)).rejects.toThrow(refused);
  });

  it('does not take a keeper.json whose at is 11 s old', async () => {
    const dir = folder();
    word(dir, { host: HOST, fingerprint256: null });
    await expect(served(dir, AT + 11_000).use(HOST, null)).rejects.toThrow('The keeper does not serve this certificate yet.');
    await expect(served(dir, AT + 9_000).use(HOST, null)).resolves.toBeUndefined();
  });
});
