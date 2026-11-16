import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { onTestFinished } from 'vitest';
import { listenAt, listenIn, testPort } from '../../../test-support/ports.mjs';
import { loadConfig } from '../src/config.js';
import { hashToken } from '../src/crypto/tokens.js';
import { machines } from '../src/db/schema.js';
import { CERT_FILE, type HeldCertificate } from '../src/modules/keeper/certificate.js';
import { Keeper, type KeeperOptions } from '../src/modules/keeper/keeper.js';
import { WorkerKeeper, type WorkerKeeperOptions, type WorkerStatus } from '../src/modules/keeper/worker.js';
import type { WorkerConfig } from '../src/modules/keeper/worker-config.js';
import { fakeLease } from './fake-lease.js';
import { as, setUpCompany, TEST_SECRET, testApp, until } from './helpers.js';
import { appAt, fetchApp, manualTime, registerStep } from './worker-keeper-time.js';

/* What the tests of a joined machine's keeper share: the company's server with its keeper, and a worker's keeper beside it. */

/* The computer the server runs on, and a computer that joins the company. */
export const hostIdOf = (machineKey: string) => hashToken(`hornhoof-host:${machineKey}`);
export const HOST_ID = hostIdOf('host-0000-abcd');
export const MAC = { machineId: 'mac-0001-abcd', hostname: 'dev-mac', os: 'darwin', arch: 'arm64' };
export const DAY_MS = 86_400_000;
/* A stand-in for an frpc child: it sleeps until it is stopped. */
export const SLEEPER = { program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] };

export function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-worker-keeper-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export type Answer = { status: number; headers: http.IncomingHttpHeaders; body: string; json: () => unknown };

export function ask(port: number, options: http.RequestOptions = {}, body?: unknown): Promise<Answer> {
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
export type Intercept = (asked: { method: string; url: string; via: string; body: unknown }) => number | null;

/* A door before the app, as an app of another build would answer some of what it is asked: the rest goes on to it. */
export async function doorBefore(appPort: number, intercept: Intercept): Promise<number> {
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
  const port = await listenIn(server);
  onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  return port;
}

/* The company's server: its app on a port of its own, and beside it the keeper of a machine that keeps the data, which
   reports the test's own address as the place to dial it at. With manual time, bootstrap takes its steps directly
   instead of waiting for recurring timers. */
export async function company(extra: Partial<KeeperOptions> = {}, env: NodeJS.ProcessEnv = {}, keeperEnv: NodeJS.ProcessEnv = {}, intercept?: Intercept, manual = manualTime()) {
  const { app, db, config } = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: HOST_ID, HORNHOOF_HOST_ID: HOST_ID, ...env });
  const ceo = await setUpCompany(app);
  await listenAt(port => app.listen({ host: '127.0.0.1', port }));
  const appPort = (app.server.address() as AddressInfo).port;
  if (manual) appAt(appPort, app);
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
    ports: { front: await testPort(), linkHttp: await testPort(), linkTls: await testPort(), peer: await testPort(), peerApp: await testPort() },
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
  const removeStep = manual ? registerStep(async () => {
    await keeper['holder'].tick();
    await keeper['holder'].look();
    await keeper['identity']!['report']();
    await keeper['peers']!['readOnce']();
    await keeper['carrier']?.tick();
    await keeper['backups']?.round();
  }) : () => undefined;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    removeStep();
    await keeper.stop();
    await app.close();
  };
  onTestFinished(stop);
  if (manual) {
    await until(() => keeper['identity']!.certificate() !== null);
    await keeper['peers']!['readOnce']();
  }
  peerPort = (await keeper.peerPorts()).peer;
  if (manual) await keeper['identity']!['report']();
  const serverRow = async () => (await db.select().from(machines).where(eq(machines.networkId, HOST_ID)))[0];
  if (!extra.addresses) await until(async () => (await serverRow())?.peerPort === peerPort);
  const rowOf = async (id: string) => (await db.select().from(machines).where(eq(machines.id, id)))[0]!;
  /* A computer joined with the Machines tab's command, by the installer that asks for the core. */
  const joined = async () => {
    const command = ((await app.inject({ method: 'POST', url: '/api/machines/command', ...as(ceo) })).json() as { command: string }).command;
    const said = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: command.split('--join ')[1], ...MAC, core: true } })).json() as { machine: { id: string }; core: { ticket: string } };
    return { machine: said.machine.id, ticket: said.core.ticket };
  };
  return { app, db, config, ceo, appPort, peerPort, keeper, lines, stop, serverRow, rowOf, joined, control, stopped: () => stopped };
}

export type Company = Awaited<ReturnType<typeof company>>;

/* A worker's keeper on folders of its own. Every pace is short, so no test waits for a real one. */
export async function workerOn(c: Company, config: WorkerConfig, over: Partial<WorkerKeeperOptions> = {}) {
  const lines: string[] = [];
  const keeper = new WorkerKeeper({
    config,
    frontHost: null,
    host: '127.0.0.1',
    ports: { front: await testPort() },
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
    ...(manualTime() ? { fetch: fetchApp, holdMs: 0 } : {}),
    ...over,
  });
  const { front } = await keeper.start();
  let stopped = false;
  const removeStep = manualTime() ? registerStep(async () => {
    keeper.parts().certificates['look']();
    const link = keeper.parts().link;
    link['look']();
    for (const kept of link['kept']) if (kept.session) link['hello'](kept.session, kept);
    keeper['look']();
    await keeper['tunnel']?.['tick']();
    if (!c.stopped() && keeper.status().leader && !keeper.status().disconnected) {
      await keeper['doorWork'];
      await keeper['readView']();
      await keeper['report']();
      await keeper['carrier'].tick();
      await keeper['holder'].round();
    } else await keeper['holder'].survive();
  }) : () => undefined;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    removeStep();
    await keeper.stop();
  };
  onTestFinished(stop);
  const status = () => keeper.status();
  return { keeper, front, lines, stop, status };
}

export async function worker(c: Company, over: Partial<WorkerKeeperOptions> = {}, more: Partial<WorkerConfig> = {}) {
  const { machine, ticket } = await c.joined();
  const config: WorkerConfig = {
    machineId: hostIdOf(MAC.machineId), joinServer: `http://127.0.0.1:${c.appPort}`, ticket, controlDir: folder(), dir: folder(),
    commit: 'w0rker', ports: { web: 18081, peer: null }, addresses: ['192.168.1.20'], ownerKey: null, hostOs: 'linux', survivorMs: 600_000, ...more,
  };
  return { machine, config, ...(await workerOn(c, config, over)) };
}

export const hasLeader = (status: WorkerStatus) => status.certificate && status.leader?.path === 'direct';
export const heldIn = (dir: string) => JSON.parse(readFileSync(join(dir, CERT_FILE), 'utf8')) as HeldCertificate;

