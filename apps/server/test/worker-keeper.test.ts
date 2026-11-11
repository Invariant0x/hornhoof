import { createHash, generateKeyPairSync, sign, webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { availableParallelism, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { hashToken } from '../src/crypto/tokens.js';
import { companies, computerRuns, machines, people, personKeys } from '../src/db/schema.js';
import { bundleRows } from '../src/modules/backups/records.js';
import { BUNDLES_DIR } from '../src/modules/keeper/backups.js';
import { CERT_FILE, type HeldCertificate } from '../src/modules/keeper/certificate.js';
import { Keeper, type KeeperOptions } from '../src/modules/keeper/keeper.js';
import { machineKey, writePrivately } from '../src/modules/keeper/machine-keys.js';
import { PIN_FILE, readPin } from '../src/modules/keeper/owner-pin.js';
import { keyPrint } from '../src/modules/computer/owner-key.js';
import { PEERS_FILE, TICKET_FILE, WorkerKeeper, type WorkerKeeperOptions, type WorkerStatus } from '../src/modules/keeper/worker.js';
import type { WorkerConfig } from '../src/modules/keeper/worker-config.js';
import { certFacts, issueCertificate } from '../src/modules/network/authority.js';
import { refreshBuild } from '../src/modules/network/follow.js';
import { renewedMessage } from '../src/modules/network/renewal.js';
import { setupCode } from '../src/modules/setup/code.js';
import { authorityOf } from '../src/modules/network/store.js';
import { fakeLease } from './fake-lease.js';
import { as, SETUP, setUpCompany, TEST_SECRET, testApp, until } from './helpers.js';

/* The computer the server runs on, and a computer that joins the company. */
const hostIdOf = (machineKey: string) => hashToken(`hornhoof-host:${machineKey}`);
const HOST_ID = hostIdOf('host-0000-abcd');
const MAC = { machineId: 'mac-0001-abcd', hostname: 'ivan-mac', os: 'darwin', arch: 'arm64' };
const DAY_MS = 86_400_000;
/* A stand-in for an frpc child: it sleeps until it is stopped. */
const SLEEPER = { program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] };

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-worker-keeper-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type Answer = { status: number; headers: http.IncomingHttpHeaders; body: string; json: () => unknown };

function ask(port: number, options: http.RequestOptions = {}, body?: unknown): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers = { ...(text ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) } : {}), ...options.headers };
    const req = http.request({ host: '127.0.0.1', port, agent: false, ...options, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const answer = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode!, headers: res.headers, body: answer, json: () => JSON.parse(answer) as unknown });
      });
    });
    req.on('error', reject);
    req.end(text);
  });
}

/* What a request to the app is answered with in the app's place, as a status; null lets it through. */
type Intercept = (asked: { method: string; url: string; via: string; body: unknown }) => number | null;

/* A door before the app, as an app of another build would answer some of what it is asked: the rest goes on to it. */
async function doorBefore(appPort: number, intercept: Intercept): Promise<number> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let body: unknown = null;
      try {
        body = raw.length > 0 ? JSON.parse(raw.toString()) : null;
      } catch {
        /* No JSON: the test's answer does not go by it. */
      }
      const status = intercept({ method: req.method ?? '', url: req.url ?? '', via: String(req.headers['x-hornhoof-via'] ?? ''), body });
      if (status) return void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: status === 404 ? 'not_found' : 'validation', message: 'An older build.' } }));
      const out = http.request({ host: '127.0.0.1', port: appPort, method: req.method, path: req.url, headers: req.headers, agent: false }, answer => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      out.on('error', () => void res.writeHead(502).end());
      out.end(raw);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  return (server.address() as AddressInfo).port;
}

/* The company's server: its app on a port of its own, and beside it the keeper of a machine that keeps the data, which
   reports the test's own address as the place to dial it at. */
async function company(extra: Partial<KeeperOptions> = {}, env: NodeJS.ProcessEnv = {}, keeperEnv: NodeJS.ProcessEnv = {}, intercept?: Intercept) {
  const { app, db, config } = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: HOST_ID, HORNHOOF_HOST_ID: HOST_ID, ...env });
  const ceo = await setUpCompany(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const appPort = (app.server.address() as AddressInfo).port;
  /* Where the keeper finds its app: the app itself, unless the test answers some of it in the app's place. */
  const keeperApp = intercept ? await doorBefore(appPort, intercept) : appPort;
  const lines: string[] = [];
  let peerPort = 1;
  /* The folder the server's keeper shares with its updater. */
  const control = folder();
  const keeper = new Keeper({
    config: loadConfig({ HORNHOOF_SECRET: TEST_SECRET, HORNHOOF_CONTROL_DIR: control, HORNHOOF_MACHINE_ID: HOST_ID, ACME_DIRECTORY: 'off', ...keeperEnv }),
    db,
    lease: fakeLease(),
    app: { host: '127.0.0.1', port: keeperApp },
    frontHost: null,
    log: line => lines.push(line),
    host: '127.0.0.1',
    ports: { front: 0, linkHttp: 0, linkTls: 0, peer: 0, peerApp: 0 },
    everyMs: 20,
    linkEveryMs: 50,
    peerEveryMs: 20,
    reportEveryMs: 30,
    backupsEveryMs: 20,
    dir: folder(),
    clientFor: () => SLEEPER,
    peerClientFor: () => SLEEPER,
    reportAs: () => ({ addresses: ['127.0.0.1'], peerPort, webPort: appPort }),
    computer: { openEveryMs: 10, closedEveryMs: 20 },
    ...extra,
  });
  await keeper.start();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await keeper.stop();
    await app.close();
  };
  onTestFinished(stop);
  peerPort = (await keeper.peerPorts()).peer;
  const serverRow = async () => (await db.select().from(machines).where(eq(machines.networkId, HOST_ID)))[0];
  if (!extra.addresses) await until(async () => (await serverRow())?.peerPort === peerPort);
  const rowOf = async (id: string) => (await db.select().from(machines).where(eq(machines.id, id)))[0]!;
  /* A computer joined with the Machines tab's command, by the installer that asks for the core. */
  const joined = async () => {
    const command = ((await app.inject({ method: 'POST', url: '/api/machines/command', ...as(ceo) })).json() as { command: string }).command;
    const said = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: command.split('--join ')[1], ...MAC, core: true } })).json() as { machine: { id: string }; core: { ticket: string } };
    return { machine: said.machine.id, ticket: said.core.ticket };
  };
  return { app, db, config, ceo, appPort, peerPort, keeper, lines, stop, serverRow, rowOf, joined, control };
}

type Company = Awaited<ReturnType<typeof company>>;

/* A worker's keeper on folders of its own. Every pace is short, so no test waits for a real one. */
async function workerOn(c: Company, config: WorkerConfig, over: Partial<WorkerKeeperOptions> = {}) {
  const lines: string[] = [];
  const keeper = new WorkerKeeper({
    config,
    frontHost: null,
    host: '127.0.0.1',
    ports: { front: 0 },
    log: line => lines.push(line),
    visitClientFor: () => SLEEPER,
    lookEveryMs: 10,
    viewEveryMs: 30,
    reportEveryMs: 30,
    renewAfterMs: 50,
    renewEveryMs: 100,
    holdMs: 400,
    holdEveryMs: 10,
    noLeaderPageMs: 50,
    certificate: { retryMs: 20 },
    sessions: { everyMs: 10, helloMs: 10, connectMs: 1000, directEveryMs: 50, pingMs: 60_000 },
    computer: { openEveryMs: 10, closedEveryMs: 20 },
    ...over,
  });
  const { front } = await keeper.start();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await keeper.stop();
  };
  onTestFinished(stop);
  const status = () => keeper.status();
  return { keeper, front, lines, stop, status };
}

async function worker(c: Company, over: Partial<WorkerKeeperOptions> = {}, more: Partial<WorkerConfig> = {}) {
  const { machine, ticket } = await c.joined();
  const config: WorkerConfig = {
    machineId: hostIdOf(MAC.machineId), joinServer: `http://127.0.0.1:${c.appPort}`, ticket, controlDir: folder(), dir: folder(),
    commit: 'w0rker', ports: { web: 18081, peer: null }, addresses: ['192.168.1.20'], ownerKey: null, hostOs: 'linux', survivorMs: 600_000, ...more,
  };
  return { machine, config, ...(await workerOn(c, config, over)) };
}

const hasLeader = (status: WorkerStatus) => status.certificate && status.leader?.path === 'direct';
const heldIn = (dir: string) => JSON.parse(readFileSync(join(dir, CERT_FILE), 'utf8')) as HeldCertificate;

/* A certificate of the company's authority for the worker's key, issued so long ago that it has ended. */
async function expire(c: Company, w: { machine: string; config: WorkerConfig }): Promise<HeldCertificate> {
  const key = machineKey(w.config.dir);
  const authority = (await authorityOf(c.db, c.config))!;
  const old = await issueCertificate(authority, { machineId: w.machine, role: 'worker', signKey: key.publicPem, now: new Date(Date.now() - 31 * DAY_MS) });
  const held: HeldCertificate = { machine: w.machine, role: 'worker', certPem: old.certPem, authorityPem: authority.certPem, until: old.until.toISOString() };
  writePrivately(join(w.config.dir, CERT_FILE), JSON.stringify(held));
  return held;
}

describe("a worker's keeper", () => {
  it('joins with its ticket and serves the company on its front door', async () => {
    const c = await company();
    const w = await worker(c);
    await until(() => hasLeader(w.status()));
    const server = await c.serverRow();
    expect(w.status()).toEqual({ role: 'worker', commit: 'w0rker', machine: w.machine, certificate: true, leader: { machine: server!.id, hostname: null, path: 'direct' }, disconnected: false });
    expect(await c.rowOf(w.machine)).toMatchObject({ role: 'worker', networkId: hostIdOf(MAC.machineId) });
    expect(heldIn(w.config.dir)).toMatchObject({ machine: w.machine, role: 'worker' });
    /* The ticket is sent once: only its hash stays, so a restart does not send it again. */
    expect(readFileSync(join(w.config.dir, TICKET_FILE), 'utf8')).toBe(JSON.stringify({ hash: hashToken(w.config.ticket!) }));

    const health = await ask(w.front, { path: '/api/health' });
    expect(health.status).toBe(200);
    expect(health.json()).toEqual((await c.app.inject({ url: '/api/health' })).json());
    /* A person signs in at the machine's own address, and the app takes that address for one of its own. */
    const own = `127.0.0.1:${w.front}`;
    const signedIn = await ask(w.front, { method: 'POST', path: '/api/auth/login', headers: { host: own, origin: `http://${own}` } }, { email: SETUP.email, password: SETUP.password });
    expect(signedIn.status).toBe(200);
    const cookie = String(signedIn.headers['set-cookie']).split(';')[0]!;
    expect(cookie).toMatch(/^hh_session=/);
    const me = await ask(w.front, { path: '/api/me', headers: { cookie } });
    expect((me.json() as { person: { email: string } }).person.email).toBe(SETUP.email.trim().toLowerCase());
    expect((await ask(w.front, { method: 'POST', path: '/api/auth/logout', headers: { host: own, origin: 'http://elsewhere.test', cookie } })).status).toBe(403);
  });

  it('reports its machine, and answers its own status without passing it on', async () => {
    const c = await company();
    const w = await worker(c);
    await until(async () => (await c.rowOf(w.machine)).reportAt !== null);
    expect(await c.rowOf(w.machine)).toMatchObject({ path: 'direct', directFails: false, addresses: ['192.168.1.20'], webPort: 18081, commit: 'w0rker' });
    expect(await c.rowOf(w.machine)).toMatchObject({ memory: totalmem(), cores: availableParallelism() });
    const said = await ask(w.front, { path: '/api/keeper' });
    expect(said.status).toBe(200);
    expect(said.json()).toEqual(w.status());
    /* The app has no such address: a request passed on would come back as its 404. */
    expect((await c.app.inject({ url: '/api/keeper' })).statusCode).toBe(404);
  });

  it('becomes a data machine when its row says so', async () => {
    const c = await company();
    const w = await worker(c);
    await until(async () => (await c.rowOf(w.machine)).ageKey !== null);
    const file = (name: string) => join(w.config.controlDir, name);
    expect(existsSync(file('replica.json')) || existsSync(file('role.json'))).toBe(false);
    /* The server's ranking gives it the data. */
    await c.db.update(machines).set({ role: 'data' }).where(eq(machines.id, w.machine));
    await until(() => existsSync(file('role.json')));
    expect(existsSync(file('replica.json'))).toBe(true);
    expect(heldIn(w.config.dir).role).toBe('data');
    const request = JSON.parse(readFileSync(file('role.json'), 'utf8')) as { secrets: Record<string, string> };
    expect(request.secrets).toEqual({ HORNHOOF_SECRET: TEST_SECRET, NODE_KEY: '', RELAY_URL: c.config.relayUrl });
    expect(statSync(file('role.json')).mode & 0o777).toBe(0o600);
    for (const line of w.lines) expect(line).not.toContain(TEST_SECRET);
  });

  /* The test in the updater's place on the server: it answers every request for a dump, until the test ends. */
  function updaterOf(c: Company): void {
    const request = join(c.control, 'dump.json');
    const dumps = join(c.control, 'dumps');
    const timer = setInterval(() => {
      try {
        const { id } = JSON.parse(readFileSync(request, 'utf8')) as { id: string };
        if (existsSync(join(dumps, `${id}.json`))) return;
        mkdirSync(dumps, { recursive: true });
        writeFileSync(join(dumps, `${id}.sql.gz`), gzipSync('-- a dump of the hornhoof database\n'));
        writeFileSync(join(dumps, `${id}.json`), JSON.stringify({ id, reason: 'timer', at: new Date().toISOString(), migrations: 106 }));
      } catch {
        /* No request now. */
      }
    }, 10);
    onTestFinished(() => clearInterval(timer));
  }

  /* The CEO saves the recovery file, so the next bundle gets machines to hold it, and the worker fetches it. */
  async function bundleHeld(c: Company, w: { machine: string; config: WorkerConfig }): Promise<{ id: string; sha256: string; recoveryFile: string }> {
    updaterOf(c);
    await until(async () => (await c.rowOf(w.machine)).reportAt !== null);
    const saved = await c.app.inject({ method: 'POST', url: '/api/backups/recovery', ...as(c.ceo) });
    expect(saved.statusCode).toBe(200);
    const recoveryFile = (saved.json() as { text: string }).text;
    await until(async () => (await bundleRows(c.db, { limit: 1, withRecovery: true })).some(row => row.holders.includes(w.machine)));
    const [row] = await bundleRows(c.db, { limit: 1, withRecovery: true });
    await until(async () => (await c.rowOf(w.machine)).heldBackups.includes(row!.id));
    return { id: row!.id, sha256: row!.sha256, recoveryFile };
  }
  const bundlesIn = (dir: string) => readdirSync(join(dir, BUNDLES_DIR)).filter(name => name.endsWith('.age')).sort();

  it('reports its key for backups, and holds the bundles it is picked for until its owner says no', async () => {
    const c = await company();
    const w = await worker(c, { holderEveryMs: 30 });
    await until(async () => Boolean((await c.rowOf(w.machine)).ageKey));
    expect((await c.rowOf(w.machine)).ageKey).toMatch(/^age1[0-9a-z]{58}$/);
    const held = await bundleHeld(c, w);
    /* The very bundle the server recorded, which this machine cannot open. */
    expect(bundlesIn(w.config.dir)).toEqual([`${held.id}.age`]);
    const sealed = readFileSync(join(w.config.dir, BUNDLES_DIR, `${held.id}.age`));
    expect(createHash('sha256').update(sealed).digest('hex')).toBe(held.sha256);
    expect(sealed.includes('a dump of the hornhoof database')).toBe(false);
    /* Its owner unticks "Keep company backups": what it holds goes, and its report says so. */
    expect((await c.app.inject({ method: 'PATCH', url: `/api/machines/${w.machine}`, payload: { keepsBackups: false }, ...as(c.ceo) })).statusCode).toBe(200);
    await until(() => bundlesIn(w.config.dir).length === 0);
    await until(async () => (await c.rowOf(w.machine)).heldBackups.length === 0);
  });

  it('finds the server set up in the place of the one that was lost, and sends it the bundles it holds', async () => {
    const c = await company();
    /* It looks for a restored server after a moment without a leader, where a real one waits ten minutes. */
    const w = await worker(c, { holderEveryMs: 30 }, { survivorMs: 300 });
    const held = await bundleHeld(c, w);
    /* The server is lost with everything on it. */
    await c.stop();
    /* A new one is set up at the old address, and whoever has its setup code gives it the recovery file. */
    const control = folder();
    const fresh = await testApp({ HORNHOOF_CONTROL_DIR: control, TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: hostIdOf('new-server-0001') });
    await fresh.app.listen({ host: '127.0.0.1', port: c.appPort });
    const code = setupCode(fresh.config.secret);
    const begun = await fresh.app.inject({ method: 'POST', url: '/api/recovery', payload: { code, file: held.recoveryFile } });
    expect(begun.statusCode).toBe(200);
    /* The machine that survived finds it by a challenge only that file answers, and sends what it holds. */
    const listed = async () => ((await fresh.app.inject({ url: `/api/recovery?code=${code}` })).json() as { bundles: { id: string }[] }).bundles;
    await until(async () => (await listed()).length === 1);
    expect((await listed())[0]!.id).toBe(held.id);
    const sent = readFileSync(join(control, 'restore', 'incoming', `${held.id}.age`));
    expect(createHash('sha256').update(sent).digest('hex')).toBe(held.sha256);
    expect(w.lines.filter(line => line.startsWith('survivor:') && line.endsWith('answered'))).toHaveLength(1);
    /* The CEO can restore it there, with no database to check it against. */
    writeFileSync(join(control, 'alive'), '');
    const restore = await fresh.app.inject({ method: 'POST', url: '/api/recovery/restore', payload: { code, id: held.id } });
    expect(restore.statusCode).toBe(202);
  });

  it('keeps its bundles behind an older leader, and goes on reporting to it', async () => {
    /* A leader an update took back to the build before: it knows nothing of backups. */
    let older = false;
    const seen: { via: string; words: boolean }[] = [];
    const c = await company({}, {}, {}, ({ method, url, via, body }) => {
      if (!older) return null;
      if (method === 'GET' && url === '/api/network/backups') return 404;
      if (method !== 'POST' || url !== '/api/network/report') return null;
      const words = Boolean(body) && ('ageKey' in (body as object) || 'heldBackups' in (body as object));
      seen.push({ via, words });
      return words ? 400 : null;
    });
    const w = await worker(c, { holderEveryMs: 30 });
    const held = await bundleHeld(c, w);
    older = true;
    const before = (await c.rowOf(w.machine)).reportAt;
    /* Its report is refused with the new words and goes again at once without them. */
    const mine = () => seen.filter(report => report.via !== 'keeper');
    await until(() => mine().length >= 4);
    expect(mine().slice(0, 4).map(report => report.words)).toEqual([true, false, true, false]);
    await until(async () => (await c.rowOf(w.machine)).reportAt!.getTime() > before!.getTime());
    /* The server's own keeper does the same. */
    expect(seen.filter(report => report.via === 'keeper').slice(0, 2).map(report => report.words)).toEqual([true, false]);
    expect(bundlesIn(w.config.dir)).toEqual([`${held.id}.age`]);
    expect([...w.lines, ...c.lines].filter(line => line.includes('Could not report'))).toEqual([]);
  });

  it("refuses the network routes to whoever comes to the worker's web port", async () => {
    const c = await company();
    const w = await worker(c, { frontHost: '127.0.0.1' });
    await until(() => hasLeader(w.status()));
    const key = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    /* A neighbor on the local network, a page on the machine's own localhost, and one that writes the keeper's headers. */
    const visitors = [{ 'x-forwarded-for': '192.0.2.7' }, { host: `localhost:${w.front}`, origin: `http://localhost:${w.front}` }, { 'x-hornhoof-via': 'keeper', 'x-hornhoof-keeper': '1' }];
    for (const headers of visitors) {
      const answers = await Promise.all([
        ask(w.front, { path: '/api/network/peers', headers }),
        ask(w.front, { method: 'POST', path: '/api/network/report', headers }, { uptimeS: 1 }),
        ask(w.front, { method: 'POST', path: '/api/network/certificate', headers }, { signKey: key }),
      ]);
      for (const answer of answers) {
        expect(answer.status).toBe(403);
        expect((answer.json() as { error: { reason: string } }).error.reason).toBe('not_keeper');
      }
    }
    /* The keeper's own asks go on meanwhile. */
    const before = (await c.rowOf(w.machine)).reportAt;
    await until(async () => (await c.rowOf(w.machine)).reportAt?.getTime() !== before?.getTime());
  });

  it('keeps the network across a restart without the server, and says where the company is', async () => {
    const c = await company();
    const w = await worker(c);
    await until(async () => hasLeader(w.status()) && (await c.rowOf(w.machine)).reportAt !== null);
    await w.stop();
    await c.stop();
    const again = await workerOn(c, w.config);
    expect(again.status()).toMatchObject({ certificate: true, machine: w.machine, leader: null, disconnected: false });
    const page = await ask(again.front, { path: '/tasks', headers: { accept: 'text/html' } });
    expect(page.status).toBe(503);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.body).toContain(`<li>the company server: localhost:${c.appPort}</li>`);
    const call = await ask(again.front, { path: '/api/tasks' });
    expect(call.status).toBe(503);
    expect((call.json() as { error: { reason: string } }).error.reason).toBe('no_leader');
    expect(again.status().certificate).toBe(true);
  });

  it('renews by its key when its certificate has ended', async () => {
    const c = await company();
    const w = await worker(c);
    await until(() => hasLeader(w.status()));
    await w.stop();
    const old = await expire(c, w);
    const again = await workerOn(c, w.config);
    await until(() => hasLeader(again.status()));
    const held = heldIn(w.config.dir);
    expect(certFacts(held.certPem).serial).not.toBe(certFacts(old.certPem).serial);
    expect(new Date(held.until).getTime()).toBeGreaterThan(Date.now() + 20 * DAY_MS);
    expect((await ask(again.front, { path: '/api/health' })).status).toBe(200);
  });

  it('stops at disconnect and says so', async () => {
    const c = await company();
    const w = await worker(c);
    await until(() => hasLeader(w.status()));
    expect((await c.app.inject({ method: 'POST', url: `/api/machines/${w.machine}/disconnect`, ...as(c.ceo) })).statusCode).toBe(204);
    await until(() => w.status().disconnected);
    expect(w.status()).toMatchObject({ leader: null, disconnected: true });
    expect(w.lines.filter(line => line.startsWith('This machine was disconnected from the company.'))).toHaveLength(1);
    const page = await ask(w.front, { path: '/tasks', headers: { accept: 'text/html' } });
    expect(page.status).toBe(410);
    expect(page.body).toContain('This machine was disconnected from the company.');
    expect(((await ask(w.front, { path: '/api/tasks' })).json() as { error: { reason: string } }).error.reason).toBe('disconnected');
    /* It asks nothing more: a keeper started again on its folders gets the same word and stops too. */
    const again = await workerOn(c, w.config);
    await until(() => again.status().disconnected);
  });

  it('drops a renewal answer it cannot trust', async () => {
    const c = await company();
    const w = await worker(c);
    await until(async () => hasLeader(w.status()) && (await c.rowOf(w.machine)).reportAt !== null);
    await w.stop();
    await c.stop();
    const held = await expire(c, w);
    const view = readFileSync(join(w.config.dir, PEERS_FILE), 'utf8');
    /* Whoever answers at the server's address: a view signed by a key of its own, then a refusal, then a cut-off, each
       without the company's signature. */
    const stranger = generateKeyPairSync('ed25519').privateKey;
    const asked: { machine: string; serial: string; at: string }[] = [];
    const forged = (ask: (typeof asked)[number]) => {
      const payload = JSON.stringify({ machine: ask.machine, serial: ask.serial, at: ask.at, role: 'worker', authorityPem: held.authorityPem, certPem: null, until: null, view: { data: [], revoked: [], link: null } });
      return { payload, signature: sign(null, Buffer.from(renewedMessage(ask.machine, ask.serial, ask.at, payload)), stranger).toString('base64') };
    };
    const answers = [
      (ask: (typeof asked)[number]) => Response.json(forged(ask)),
      () => Response.json({ error: { code: 'not_found', reason: 'not_a_machine' } }, { status: 404 }),
      () => Response.json({ payload: '{"disconnected":true}', signature: 'AAAA' }, { status: 410 }),
    ];
    const fake = (async (_url: unknown, init?: { body?: unknown }) => {
      const ask = JSON.parse(String(init?.body)) as (typeof asked)[number];
      asked.push(ask);
      return answers[(asked.length - 1) % answers.length]!(ask);
    }) as typeof fetch;
    const again = await workerOn(c, w.config, { fetch: fake });
    await until(() => asked.length >= 6);
    expect(again.status()).toMatchObject({ certificate: true, disconnected: false, leader: null });
    expect(heldIn(w.config.dir).certPem).toBe(held.certPem);
    expect(readFileSync(join(w.config.dir, PEERS_FILE), 'utf8')).toBe(view);
    /* Each request is of a later moment than the one before, since the server takes a moment once. */
    const moments = asked.map(ask => Date.parse(ask.at));
    expect(moments).toEqual([...new Set(moments)].sort((a, b) => a - b));
    expect(again.lines.filter(line => line.startsWith("Could not renew this machine's place"))).toHaveLength(1);
  });

  it('waits for a computer another row holds, and takes no ticket twice', async () => {
    const c = await company();
    const w = await worker(c);
    await until(() => hasLeader(w.status()));
    await w.stop();
    /* The same folders with the same ticket: it is not sent again, and the certificate it holds serves. */
    const sameTicket = await workerOn(c, w.config);
    await until(() => hasLeader(sameTicket.status()));
    expect(sameTicket.lines.join('\n')).not.toContain('Could not get');
    await sameTicket.stop();
    /* A ticket that was used, on a keeper that holds nothing: it has no way in. */
    const empty = await workerOn(c, { ...w.config, dir: folder() });
    await until(() => empty.status().disconnected);
    expect(empty.lines.join('\n')).toContain('its join ticket was used or has expired');
  });

  it("downloads the server's build and installs when told", async () => {
    const c = await company({}, { HORNHOOF_COMMIT: 'b'.repeat(40) });
    const build = { version: '0.19.0', tag: 'b'.repeat(40), digest: 'sha256:app', nodeDigest: 'sha256:node', updaterDigest: 'sha256:updater', commit: 'b'.repeat(40) };
    vi.spyOn(c.app.ctx.updates, 'find').mockResolvedValue({ tag: build.tag, digest: build.digest, version: build.version, commit: build.commit, created: '', title: '', migrations: 0 });
    vi.spyOn(c.app.ctx.updates, 'siblings').mockResolvedValue({ node: build.nodeDigest, updater: build.updaterDigest });
    await refreshBuild(c.app.ctx);
    const w = await worker(c);
    const control = (name: string) => join(w.config.controlDir, name);
    const read = (name: string) => JSON.parse(readFileSync(control(name), 'utf8')) as { id: string; tag?: string; commit?: string; until?: number };
    /* The view names the server's build, and the keeper asks the machine's updater for it. */
    await until(() => existsSync(control('request.json')));
    const request = read('request.json');
    expect(request).toMatchObject({ version: '0.19.0', tag: build.tag, digest: 'sha256:app', nodeDigest: 'sha256:node', updaterDigest: 'sha256:updater' });
    expect(existsSync(control('go.json'))).toBe(false);
    /* The updater downloaded it and waits: the keeper says so, and the server gives this machine its turn. */
    writeFileSync(control('status.json'), JSON.stringify({ id: request.id, version: '0.19.0', state: 'running', step: 'wait', log: '', at: '' }));
    await until(async () => (await c.rowOf(w.machine)).updateState === 'ready');
    await until(() => existsSync(control('go.json')));
    const go = read('go.json');
    expect(go).toMatchObject({ id: request.id, commit: build.tag });
    expect(go.until! * 1000 - Date.now()).toBeGreaterThan(14 * 60_000);
    expect((await c.rowOf(w.machine)).goCommit).toBe(build.tag);
    expect(read('request.json').id).toBe(request.id);
  });

  it("pins its owner's key only from a ticket that let it in, and reports the pin's print", async () => {
    const c = await company();
    const keyOf = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const ownerKey = keyOf();
    const { machine, ticket } = await c.joined();
    const config: WorkerConfig = { machineId: hostIdOf(MAC.machineId), joinServer: `http://127.0.0.1:${c.appPort}`, ticket, controlDir: folder(), dir: folder(), commit: 'w0rker', ports: { web: 18081, peer: null }, addresses: [], ownerKey, hostOs: null, survivorMs: 600_000 };
    const w = await workerOn(c, config);
    await until(() => hasLeader(w.status()));
    expect(readPin(config.dir)).toBe(ownerKey);
    expect(statSync(join(config.dir, PIN_FILE)).mode & 0o777).toBe(0o600);
    await until(async () => (await c.rowOf(machine)).ownerPin === keyPrint(ownerKey));
    await w.stop();

    /* A ticket the server refuses pins nothing, whatever key came with it. */
    const refused = await workerOn(c, { ...config, ticket: 'x'.repeat(43), ownerKey: keyOf() });
    await until(() => refused.lines.some(line => line.includes('its join ticket was used or has expired')));
    expect(readPin(config.dir)).toBe(ownerKey);
    await refused.stop();

    /* The owner runs a new command there, which carries another key: its ticket lets the machine in, and the pin follows. */
    const { issueTicket } = await import('../src/modules/network/join.js');
    const next = keyOf();
    const renewed = await workerOn(c, { ...config, ticket: await issueTicket(c.db, machine), ownerKey: next });
    await until(() => readPin(config.dir) === next);
    await until(async () => (await c.rowOf(machine)).ownerPin === keyPrint(next));
    await renewed.stop();
  });

  it("sends its ticket again when its owner's key could not be kept", async () => {
    const c = await company();
    const ownerKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const { machine, ticket } = await c.joined();
    const config: WorkerConfig = { machineId: hostIdOf(MAC.machineId), joinServer: `http://127.0.0.1:${c.appPort}`, ticket, controlDir: folder(), dir: folder(), commit: 'w0rker', ports: { web: 18081, peer: null }, addresses: [], ownerKey, hostOs: null, survivorMs: 600_000 };
    /* A folder stands where the pin goes, so the key cannot be written there. */
    mkdirSync(join(config.dir, PIN_FILE, 'taken'), { recursive: true });
    const w = await workerOn(c, config);
    await until(() => w.lines.some(line => line.includes("Could not keep the owner's key")));
    await until(() => hasLeader(w.status()));
    expect(readPin(config.dir)).toBeNull();
    /* The ticket was not noted as used, so the next ask sends it again, and the key is kept once it can be. */
    rmSync(join(config.dir, PIN_FILE), { recursive: true });
    await until(() => readPin(config.dir) === ownerKey);
    await until(async () => (await c.rowOf(machine)).ownerPin === keyPrint(ownerKey));
    await w.stop();
  });

  /* What a machine's updater reads of its computer access, and the updater's side of a command. */
  const accessIn = (control: string) => {
    try {
      return JSON.parse(readFileSync(join(control, 'computer.json'), 'utf8')) as { untilSec: number | null; by?: string };
    } catch {
      return null;
    }
  };
  const updaterAlive = (control: string) => writeFileSync(join(control, 'alive'), '');
  async function command(c: Company, machine: string, text: string): Promise<string> {
    const [acme] = await c.db.select().from(companies);
    const [run] = await c.db.insert(computerRuns).values({ companyId: acme!.id, machineId: machine, command: text, timeoutS: 30 }).returning();
    return run!.id;
  }
  const runOf = async (c: Company, id: string) => (await c.db.select().from(computerRuns).where(eq(computerRuns.id, id)))[0]!;
  async function updaterAnswers(control: string, id: string, output: string): Promise<{ command: string }> {
    const file = join(control, 'computer', `${id}.json`);
    await until(() => existsSync(file));
    const taken = JSON.parse(readFileSync(file, 'utf8')) as { command: string };
    writeFileSync(join(control, 'computer', `${id}.out.json.new`), JSON.stringify({ id, exit: 0, output }));
    writeFileSync(join(control, 'computer', `${id}.out.json`), JSON.stringify({ id, exit: 0, output }));
    return taken;
  }

  it("carries the server's own computer access from its app to its updater", async () => {
    const c = await company();
    updaterAlive(c.control);
    const server = (await c.serverRow())!.id;
    /* Its keeper asks with its updater alive, so the machine is reachable; it holds no key and takes its app's word. */
    await until(() => c.app.ctx.computer.reachable(server));
    expect(accessIn(c.control)).toEqual({ untilSec: null, until: null, asked: null, by: 'keeper' });
    const opened = await c.app.inject({ method: 'POST', url: `/api/machines/${server}/access/open`, payload: {}, ...as(c.ceo) });
    expect(opened.statusCode).toBe(200);
    const untilSec = Math.floor(Date.parse((opened.json() as { until: string }).until) / 1000);
    await until(() => accessIn(c.control)?.untilSec === untilSec);
    const id = await command(c, server, 'uname -a');
    expect(await updaterAnswers(c.control, id, 'Linux\n')).toMatchObject({ command: 'uname -a' });
    await until(async () => (await runOf(c, id)).state === 'done');
    expect(await runOf(c, id)).toMatchObject({ exit: 0, output: 'Linux\n' });
    await until(() => !existsSync(join(c.control, 'computer', `${id}.json`)));
    /* The close reaches the updater's folder too, and the keeper leaves it closed when it stops. */
    expect((await c.app.inject({ method: 'POST', url: `/api/machines/${server}/access/close`, ...as(c.ceo) })).statusCode).toBe(200);
    await until(() => accessIn(c.control)?.untilSec === null);
    expect((await c.serverRow())!.ownerPin).toBeNull();
  });

  it("reports the print of the key its owner gave the server's machine, and its system", async () => {
    const ownerKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const c = await company({}, {}, { HORNHOOF_OWNER_KEY: ownerKey, HORNHOOF_HOST_OS: 'linux' });
    await until(async () => (await c.serverRow())?.ownerPin === keyPrint(ownerKey));
    expect(await c.serverRow()).toMatchObject({ os: 'linux' });
    /* With a key it takes no app's word: an open without its owner's signature opens nothing there. */
    updaterAlive(c.control);
    const server = (await c.serverRow())!.id;
    await until(() => c.app.ctx.computer.reachable(server));
    const refused = await c.app.inject({ method: 'POST', url: `/api/machines/${server}/access/open`, payload: {}, ...as(c.ceo) });
    expect([refused.statusCode, (refused.json() as { error: { reason: string } }).error.reason]).toEqual([400, 'grant_needed']);
    /* A row written past the app says open, and the keeper stays closed. */
    const [acme] = await c.db.select().from(companies);
    const { machineAccess } = await import('../src/db/schema.js');
    await c.db.insert(machineAccess).values({ machineId: server, companyId: acme!.id, until: new Date(Date.now() + 3_600_000) });
    await until(() => c.lines.some(line => line.includes('with no grant of its owner')));
    expect(accessIn(c.control)?.untilSec).toBeNull();
  });

  it('carries computer access over the peer link, opened only by what its owner signed', async () => {
    const c = await company();
    const { subtle } = webcrypto;
    const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const ownerKey = Buffer.from(await subtle.exportKey('spki', pair.publicKey)).toString('base64url');
    const [acme] = await c.db.select().from(companies);
    const [owner] = await c.db.select().from(people).where(eq(people.isOwner, true));
    await c.db.insert(personKeys).values({ personId: owner!.id, companyId: acme!.id, publicKey: ownerKey, wrapped: 'w', salt: 's', iv: 'i', iterations: 600_000 });
    const { machine, ticket } = await c.joined();
    const config: WorkerConfig = { machineId: hostIdOf(MAC.machineId), joinServer: `http://127.0.0.1:${c.appPort}`, ticket, controlDir: folder(), dir: folder(), commit: 'w0rker', ports: { web: 18081, peer: null }, addresses: [], ownerKey, hostOs: 'darwin', survivorMs: 600_000 };
    updaterAlive(config.controlDir);
    const w = await workerOn(c, config);
    await until(() => hasLeader(w.status()));
    await until(async () => (await c.rowOf(machine)).ownerPin === keyPrint(ownerKey));
    await until(() => c.app.ctx.computer.reachable(machine));
    expect(accessIn(config.controlDir)).toMatchObject({ untilSec: null, by: 'keeper' });

    const signed = async (over: object = {}) => {
      const at = Math.floor(Date.now() / 1000);
      const payload = JSON.stringify({ v: 1, machine: config.machineId, until: at + 3600, at, nonce: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url'), ...over });
      return { payload, signature: Buffer.from(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(payload))).toString('base64url') };
    };
    const grant = await signed();
    expect((await c.app.inject({ method: 'POST', url: `/api/machines/${machine}/access/open`, payload: { grant }, ...as(c.ceo) })).statusCode).toBe(200);
    const untilSec = (JSON.parse(grant.payload) as { until: number }).until;
    await until(() => accessIn(config.controlDir)?.untilSec === untilSec);
    /* A command for it goes through the leader to its updater's folder, and the answer back. */
    const id = await command(c, machine, 'cat /host/etc/hostname');
    expect(await updaterAnswers(config.controlDir, id, 'ivan-mac\n')).toMatchObject({ command: 'cat /host/etc/hostname' });
    await until(async () => (await runOf(c, id)).state === 'done');
    expect(await runOf(c, id)).toMatchObject({ exit: 0, output: 'ivan-mac\n' });
    /* Whoever comes to the worker's own web port is no keeper, whatever they write: nothing is taken through it. */
    const next = await command(c, machine, 'id');
    const through = await ask(w.front, { path: '/api/network/computer?updater=1', headers: { 'x-hornhoof-via': 'keeper', 'x-hornhoof-keeper': '1' } });
    expect(through.status).toBe(403);
    await updaterAnswers(config.controlDir, next, 'uid=0\n');
    await until(async () => (await runOf(c, next)).state === 'done');

    /* A row written past the app that says open, with the old grant or with none, opens nothing on the machine. */
    expect((await c.app.inject({ method: 'POST', url: `/api/machines/${machine}/access/close`, ...as(c.ceo) })).statusCode).toBe(200);
    await until(() => accessIn(config.controlDir)?.untilSec === null);
    const { machineAccess } = await import('../src/db/schema.js');
    await c.db.update(machineAccess).set({ until: new Date(Date.now() + 3_600_000), grant }).where(eq(machineAccess.machineId, machine));
    await until(() => w.lines.some(line => line.includes('with no grant of its owner')));
    expect(accessIn(config.controlDir)?.untilSec).toBeNull();
    /* Its keeper tells the server so, and the row says closed again: nobody is shown an open machine that runs nothing,
       and a command that comes then is ended without reaching the machine. */
    await until(async () => (await c.db.select().from(machineAccess).where(eq(machineAccess.machineId, machine)))[0]!.until === null);
    const late = await command(c, machine, 'id');
    await until(async () => (await runOf(c, late)).state === 'done');
    expect(await runOf(c, late)).toMatchObject({ exit: 126 });
    expect(existsSync(join(config.controlDir, 'computer', `${late}.json`))).toBe(false);

    /* Disconnected, it closes and asks no more. */
    expect((await c.app.inject({ method: 'POST', url: `/api/machines/${machine}/disconnect`, ...as(c.ceo) })).statusCode).toBe(204);
    await until(() => w.status().disconnected);
    expect(accessIn(config.controlDir)).toMatchObject({ untilSec: null, by: 'keeper' });
  });

  it("has a data machine's keeper report its addresses and its host's name", async () => {
    const c = await company({ addresses: ['192.0.2.4', '8.8.8.8'], hostname: 'deb', reportAs: undefined });
    await until(async () => (await c.serverRow())?.hostname === 'deb');
    expect(await c.serverRow()).toMatchObject({ hostname: 'deb', addresses: ['192.0.2.4'] });
  });
});
