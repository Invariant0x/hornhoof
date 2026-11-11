import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { hashToken } from '../src/crypto/tokens.js';
import { machines } from '../src/db/schema.js';
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

/* The company's server: its app on a port of its own, and beside it the keeper of a machine that keeps the data, which
   reports the test's own address as the place to dial it at. */
async function company(extra: Partial<KeeperOptions> = {}, env: NodeJS.ProcessEnv = {}) {
  const { app, db, config } = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: HOST_ID, HORNHOOF_HOST_ID: HOST_ID, ...env });
  const ceo = await setUpCompany(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const appPort = (app.server.address() as AddressInfo).port;
  const lines: string[] = [];
  let peerPort = 1;
  const keeper = new Keeper({
    config: loadConfig({ HORNHOOF_SECRET: TEST_SECRET, HORNHOOF_CONTROL_DIR: folder(), HORNHOOF_MACHINE_ID: HOST_ID, ACME_DIRECTORY: 'off' }),
    db,
    lease: fakeLease(),
    app: { host: '127.0.0.1', port: appPort },
    frontHost: null,
    log: line => lines.push(line),
    host: '127.0.0.1',
    ports: { front: 0, linkHttp: 0, linkTls: 0, peer: 0, peerApp: 0 },
    everyMs: 20,
    linkEveryMs: 50,
    peerEveryMs: 20,
    reportEveryMs: 30,
    dir: folder(),
    clientFor: () => SLEEPER,
    peerClientFor: () => SLEEPER,
    reportAs: () => ({ addresses: ['127.0.0.1'], peerPort, webPort: appPort }),
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
  return { app, db, config, ceo, appPort, peerPort, keeper, lines, stop, serverRow, rowOf, joined };
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

async function worker(c: Company, over: Partial<WorkerKeeperOptions> = {}) {
  const { machine, ticket } = await c.joined();
  const config: WorkerConfig = {
    machineId: hostIdOf(MAC.machineId), joinServer: `http://127.0.0.1:${c.appPort}`, ticket, controlDir: folder(), dir: folder(),
    commit: 'w0rker', ports: { web: 18081, peer: null }, addresses: ['192.168.1.20'], ownerKey: null,
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
    const said = await ask(w.front, { path: '/api/keeper' });
    expect(said.status).toBe(200);
    expect(said.json()).toEqual(w.status());
    /* The app has no such address: a request passed on would come back as its 404. */
    expect((await c.app.inject({ url: '/api/keeper' })).statusCode).toBe(404);
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
    const config: WorkerConfig = { machineId: hostIdOf(MAC.machineId), joinServer: `http://127.0.0.1:${c.appPort}`, ticket, controlDir: folder(), dir: folder(), commit: 'w0rker', ports: { web: 18081, peer: null }, addresses: [], ownerKey };
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
    const config: WorkerConfig = { machineId: hostIdOf(MAC.machineId), joinServer: `http://127.0.0.1:${c.appPort}`, ticket, controlDir: folder(), dir: folder(), commit: 'w0rker', ports: { web: 18081, peer: null }, addresses: [], ownerKey };
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

  it("has a data machine's keeper report its addresses and its host's name", async () => {
    const c = await company({ addresses: ['192.0.2.4', '8.8.8.8'], hostname: 'deb', reportAs: undefined });
    await until(async () => (await c.serverRow())?.hostname === 'deb');
    expect(await c.serverRow()).toMatchObject({ hostname: 'deb', addresses: ['192.0.2.4'] });
  });
});
