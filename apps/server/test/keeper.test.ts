import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { clientAddress } from '../src/auth/tunnel.js';
import { loadConfig } from '../src/config.js';
import { machines } from '../src/db/schema.js';
import { Keeper, KEEPER_PORTS, type KeeperOptions } from '../src/modules/keeper/keeper.js';
import { freshState, readKeeperState } from '../src/modules/keeper/state.js';
import { updaterBusy } from '../src/modules/keeper/updater-status.js';
import { LINK_TLS_PORT } from '../src/modules/tls/listener.js';
import type { Target } from '../src/net/proxy.js';
import { SETUP, setUpCompany, TEST_SECRET, testApp, until } from './helpers.js';
import { fakeLease } from './fake-lease.js';

const FAST = { everyMs: 50 };
const MAINTENANCE_MESSAGE = 'Hornhoof is installing an update and takes no changes until it ends.';

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-keeper-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function statusSays(dir: string, state: string, step: string): void {
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ id: 'u1', version: '1.2.3', state, step, log: '', at: '2026-01-01T00:00:00.000Z' }));
}

const wordIn = (dir: string) => readKeeperState(dir)?.mode;

/* The keeper's looks and the time it writes in its word run on the test's clock from here on. */
function looksOnTheTestsClock(): void {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  onTestFinished(() => void vi.useRealTimers());
}

/* The test's clock moves by ms, and the look that came due in it has written its word. */
async function nextWord(dir: string, ms: number): Promise<void> {
  const before = readKeeperState(dir)?.at;
  await vi.advanceTimersByTimeAsync(ms);
  await until(() => readKeeperState(dir)?.at !== before);
}

async function listening(server: http.Server): Promise<Target> {
  onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
}

const echoHeaders = () =>
  listening(
    http.createServer((req, res) => {
      req.resume();
      res.end(JSON.stringify(req.headers));
    }),
  );

/* A port with nobody on it, as the app's is while it is stopped. */
async function appIsDown(): Promise<Target> {
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise(resolve => server.close(resolve));
  return { host: '127.0.0.1', port };
}

async function appListening(app: FastifyInstance): Promise<Target> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  return { host: '127.0.0.1', port: (app.server.address() as AddressInfo).port };
}

async function keeperOn(app: Target, extra: Partial<KeeperOptions> = {}, dir: string = folder()) {
  const lines: string[] = [];
  const keeper = new Keeper({
    config: loadConfig({ HORNHOOF_SECRET: TEST_SECRET, HORNHOOF_CONTROL_DIR: dir }),
    db: null,
    app,
    /* A lease that always holds, as on a healthy machine, unless the test gives another. */
    lease: fakeLease(),
    frontHost: null,
    log: line => lines.push(line),
    host: '127.0.0.1',
    ports: { front: 0, linkHttp: 0, linkTls: 0, peer: 0, peerApp: 0 },
    ...extra,
  });
  const ports = await keeper.start();
  onTestFinished(() => keeper.stop());
  const door = (port: number): Target => ({ host: '127.0.0.1', port });
  return { keeper, dir, lines, ports, front: door(ports.front), link: door(ports.linkHttp) };
}

type Answer = { status: number; headers: http.IncomingHttpHeaders; body: string };

function send(to: Target, options: http.RequestOptions = {}, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const out = http.request({ ...to, agent: false, ...options }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    out.on('error', reject);
    out.end(body);
  });
}

const seenWith = async (door: Target, headers: http.OutgoingHttpHeaders = {}) => JSON.parse((await send(door, { headers })).body);
const forwardedWith = async (door: Target, sent: string) => (await seenWith(door, { 'x-forwarded-for': sent }))['x-forwarded-for'];

const health = async (door: Target) => JSON.parse((await send(door, { path: '/api/health' })).body);

/* Only the names: a session's value is never compared or shown. */
async function signIn(door: Target): Promise<{ status: number; body: string; cookies: string[] }> {
  const payload = JSON.stringify({ email: 'ivan@acme.com', password: SETUP.password });
  const answer = await send(door, { method: 'POST', path: '/api/auth/login', headers: { 'content-type': 'application/json' } }, payload);
  return { status: answer.status, body: answer.body, cookies: (answer.headers['set-cookie'] ?? []).map(cookie => cookie.split('=')[0]!) };
}

describe('updaterBusy', () => {
  it.each(['backup', 'install', 'health', 'rollback'])('is true while a running update is at step %s', step => {
    const dir = folder();
    statusSays(dir, 'running', step);
    expect(updaterBusy(dir)).toBe(true);
  });

  it.each([
    ['running', 'pull'],
    /* A worker that has the build and waits for its turn still serves. */
    ['running', 'wait'],
    ['done', 'finished'],
    ['failed', 'install'],
    ['rolled_back', 'rollback'],
  ])('is false for state %s at step %s', (state, step) => {
    const dir = folder();
    statusSays(dir, state, step);
    expect(updaterBusy(dir)).toBe(false);
  });

  it('is false for a running update that names no step, and without a file', () => {
    const dir = folder();
    expect(updaterBusy(dir)).toBe(false);
    writeFileSync(join(dir, 'status.json'), '{"state":"running"}');
    expect(updaterBusy(dir)).toBe(false);
  });

  it.each(['{', '[]', 'null', '{"state":1}', '{"step":"install"}'])('is null for %s, which it cannot tell anything from', text => {
    const dir = folder();
    writeFileSync(join(dir, 'status.json'), text);
    expect(updaterBusy(dir)).toBeNull();
  });

  it('is null for a file it cannot read', () => {
    const dir = folder();
    mkdirSync(join(dir, 'status.json'));
    expect(updaterBusy(dir)).toBeNull();
  });
});

describe('the keeper', () => {
  it('writes its mode every second, maintenance while the updater installs', async () => {
    looksOnTheTestsClock();
    const { keeper, dir } = await keeperOn(await echoHeaders());
    /* What the app's own reader takes, so the two sides of the file cannot drift apart. */
    expect(freshState(dir, Date.now(), 2000)).toMatchObject({ mode: 'lead', link: null });
    const first = readKeeperState(dir)?.at;
    await vi.advanceTimersByTimeAsync(999);
    expect(readKeeperState(dir)?.at).toBe(first);
    await nextWord(dir, 1);
    statusSays(dir, 'running', 'install');
    await nextWord(dir, 1000);
    expect(wordIn(dir)).toBe('maintenance');
    expect(keeper.mode()).toBe('maintenance');
    expect(freshState(dir, Date.now(), 2000)?.mode).toBe('maintenance');
    statusSays(dir, 'done', 'finished');
    await nextWord(dir, 1000);
    expect(wordIn(dir)).toBe('lead');
    expect(keeper.mode()).toBe('lead');
  });

  it('keeps maintenance through a status file it cannot read', async () => {
    looksOnTheTestsClock();
    const { keeper, dir } = await keeperOn(await echoHeaders(), FAST);
    statusSays(dir, 'running', 'install');
    await nextWord(dir, FAST.everyMs);
    expect(wordIn(dir)).toBe('maintenance');
    writeFileSync(join(dir, 'status.json'), '{');
    /* As many looks as three seconds hold. */
    for (let look = 0; look < 3000 / FAST.everyMs; look++) {
      await nextWord(dir, FAST.everyMs);
      expect(wordIn(dir)).toBe('maintenance');
      expect(keeper.mode()).toBe('maintenance');
    }
    statusSays(dir, 'failed', 'install');
    await nextWord(dir, FAST.everyMs);
    expect(wordIn(dir)).toBe('lead');
  });

  it('takes its first word from the status file, and leads when it cannot read it', async () => {
    const duringUpdate = folder();
    statusSays(duringUpdate, 'running', 'health');
    const restarted = await keeperOn(await echoHeaders(), {}, duringUpdate);
    expect(restarted.keeper.mode()).toBe('maintenance');
    expect(wordIn(duringUpdate)).toBe('maintenance');

    const broken = folder();
    writeFileSync(join(broken, 'status.json'), '{');
    const fresh = await keeperOn(await echoHeaders(), {}, broken);
    expect(fresh.keeper.mode()).toBe('lead');
    expect(wordIn(broken)).toBe('lead');
  });

  it('keeps its doors open when it cannot write its word, and says so once until it can again', async () => {
    const dir = join(folder(), 'not-there-yet');
    const { front, lines } = await keeperOn(await echoHeaders(), { everyMs: 20 }, dir);
    expect(await forwardedWith(front, '198.51.100.7')).toBe('127.0.0.1');
    await sleep(150);
    expect(lines.filter(line => /could not write/.test(line))).toHaveLength(1);
    mkdirSync(dir);
    await until(() => wordIn(dir) === 'lead');
  });

  it('takes the visitor from front and from nobody else', async () => {
    const app = await echoHeaders();
    const fromFront = await keeperOn(app, { frontHost: 'localhost' });
    expect(await forwardedWith(fromFront.front, '203.0.113.5')).toBe('203.0.113.5');
    expect(await forwardedWith(fromFront.front, '203.0.113.5, 198.51.100.7')).toBe('203.0.113.5');
    expect(await forwardedWith(fromFront.front, ', 203.0.113.5')).toBe('127.0.0.1');
    const notFront = await keeperOn(app, { frontHost: 'front.invalid' });
    expect(await forwardedWith(notFront.front, '203.0.113.5')).toBe('127.0.0.1');
    const noFront = await keeperOn(app, { frontHost: null });
    expect(await forwardedWith(noFront.front, '203.0.113.5')).toBe('127.0.0.1');
  });

  it("marks the link's http traffic as https, and only that", async () => {
    const { front, link } = await keeperOn(await echoHeaders());
    const overLink = await seenWith(link, { 'x-forwarded-for': '203.0.113.5, 198.51.100.7', 'x-forwarded-proto': 'http', 'x-hornhoof-via': 'x' });
    expect(overLink['x-forwarded-for']).toBe('203.0.113.5');
    expect(overLink['x-forwarded-proto']).toBe('https');
    expect(overLink['x-hornhoof-via']).toBeUndefined();
    expect((await seenWith(link))['x-forwarded-for']).toBe('127.0.0.1');
    const overFront = await seenWith(front, { 'x-forwarded-proto': 'https', 'x-hornhoof-via': 'x', 'x-forwarded-host': 'corp.hornhoof.test' });
    expect(overFront['x-forwarded-proto']).toBeUndefined();
    expect(overFront['x-hornhoof-via']).toBeUndefined();
    expect(overFront['x-forwarded-host']).toBe('corp.hornhoof.test');
  });

  it('answers maintenance at once while the app is down during an update, and holds otherwise', async () => {
    const { keeper, dir, front, link } = await keeperOn(await appIsDown(), { ...FAST, holdMs: 30, holdEveryMs: 5 });
    const held = await send(front, { path: '/api/me' });
    expect(held.status).toBe(503);
    expect(held.headers['retry-after']).toBe('5');
    expect(JSON.parse(held.body).error).toMatchObject({ reason: 'starting', message: 'Hornhoof did not answer for a minute. Try again in a few seconds.' });

    statusSays(dir, 'running', 'install');
    await until(() => keeper.mode() === 'maintenance');
    for (const door of [front, link]) {
      for (const path of ['/api/me', '/mcp']) {
        const answer = await send(door, { path, method: 'POST' });
        expect(answer.status).toBe(503);
        expect(answer.headers['retry-after']).toBe('10');
        expect(answer.headers['content-type']).toBe('application/json');
        expect(JSON.parse(answer.body)).toEqual({ error: { code: 'unavailable', message: MAINTENANCE_MESSAGE, reason: 'maintenance' } });
      }
    }
    const page = await send(front, { path: '/tasks' });
    expect(page.status).toBe(503);
    expect(page.headers['retry-after']).toBe('10');
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.body).toContain('<p>Updating</p>');
    expect(page.body).not.toMatch(/[А-Яа-яЁё]/);

    statusSays(dir, 'done', 'finished');
    await until(() => keeper.mode() === 'lead');
    expect((await send(front, { path: '/tasks' })).status).toBe(503);
  });

  it('shows maintenance during the swap of a restore', async () => {
    const { keeper, dir, front } = await keeperOn(await appIsDown(), { ...FAST, holdMs: 30, holdEveryMs: 5 });
    const restoreSays = (state: string, step: string) => writeFileSync(join(dir, 'restore-status.json'), JSON.stringify({ attempt: 'a1', id: 'b1', state, step, line: '', at: '2026-01-01T00:00:00.000Z', kept: null }));
    /* While the keeper still opens the bundle the company works on. */
    restoreSays('running', 'open');
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(keeper.mode()).toBe('lead');
    for (const step of ['load', 'swap', 'start']) {
      restoreSays('running', step);
      await until(() => keeper.mode() === 'maintenance');
      const page = await send(front, { path: '/tasks' });
      expect([step, page.status, page.headers['retry-after']]).toEqual([step, 503, '10']);
      restoreSays('done', 'start');
      await until(() => keeper.mode() === 'lead');
    }
    restoreSays('failed', 'swap');
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(keeper.mode()).toBe('lead');
  });

  it('holds a request while the app is down, and ends the hold with maintenance once an update begins', async () => {
    const down = await appIsDown();
    const { keeper, dir, front } = await keeperOn(down, { ...FAST, holdEveryMs: 5 });
    const held = send(front, { path: '/api/me' });
    const app = http.createServer((req, res) => {
      req.resume();
      res.end('the app');
    });
    await new Promise<void>(resolve => app.listen(down.port, down.host, resolve));
    onTestFinished(() => {
      app.closeAllConnections();
      app.close();
    });
    expect((await held).status).toBe(200);

    await new Promise(resolve => {
      app.closeAllConnections();
      app.close(resolve);
    });
    const waiting = send(front, { path: '/api/me' });
    statusSays(dir, 'running', 'install');
    await until(() => keeper.mode() === 'maintenance');
    expect(JSON.parse((await waiting).body).error.reason).toBe('maintenance');
  });

  it("gets its machine's certificate from its app and reports the machine's measures while it leads", async () => {
    const MACHINE_ID = 'a1b2c3d4'.repeat(4);
    const { app, db } = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: MACHINE_ID });
    await setUpCompany(app);
    const dir = folder();
    const config = loadConfig({ HORNHOOF_SECRET: TEST_SECRET, HORNHOOF_CONTROL_DIR: folder(), HORNHOOF_MACHINE_ID: MACHINE_ID });
    const { keeper } = await keeperOn(await appListening(app), { config, dir, published: { web: 8123, peer: 8223 }, reportEveryMs: 20 });
    await until(() => keeper.certificate() !== null);
    const row = async () => (await db.select().from(machines).where(eq(machines.networkId, MACHINE_ID)))[0]!;
    expect(keeper.certificate()).toMatchObject({ machine: (await row()).id, role: 'data' });
    expect(existsSync(join(dir, 'certificate.json'))).toBe(true);
    await until(async () => (await row()).reportAt !== null);
    expect(await row()).toMatchObject({ webPort: 8123, peerPort: 8223 });
  });

  it('takes no lease before it promoted', async () => {
    const lease = fakeLease();
    const said = { leads: false, tunnel: [] as string[] };
    const front = await appIsDown();
    const taking: KeeperOptions['taking'] = parts => ({
      start: async () => void parts.tunnel.start(),
      stop: async () => undefined,
      leads: () => said.leads,
      handle: async () => ({ status: 404, body: {} }),
    });
    const k = await keeperOn(await echoHeaders(), { lease, taking, takingEveryMs: 10, everyMs: 20, ports: { front: front.port, linkHttp: 0, linkTls: 0, peer: 0, peerApp: 0 } });
    expect(k.ports.front).toBe(front.port);
    /* Until it promoted: no lease, the app off, and nobody let in at the front door. */
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(lease.calls.filter(call => call.method === 'take')).toEqual([]);
    expect([wordIn(k.dir), k.keeper.mode()]).toEqual(['off', 'read']);
    /* It tells the other machines that keep data that it is taking the server. */
    expect(k.keeper.beats().own().stance).toEqual({ kind: 'attempting' });
    await expect(send(front, { path: '/' })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    /* The link's door answers who this machine is, which its own nonce is checked by. */
    const proof = await send(k.link, { path: `/api/network/lease?nonce=${'n'.repeat(22)}` });
    expect([proof.status, JSON.parse(proof.body)]).toEqual([200, { machine: null, term: null, nonce: 'n'.repeat(22) }]);

    said.leads = true;
    await until(() => wordIn(k.dir) === 'lead');
    expect(lease.calls.filter(call => call.method === 'take')).toHaveLength(1);
    await until(async () => (await send(front, { path: '/' }).catch(() => null))?.status === 200);
    expect(k.keeper.mode()).toBe('lead');
    expect(k.keeper.beats().own().stance).toMatchObject({ kind: 'lead', term: { number: 1 }, lease: 'normal', sync: null });
  });

  it('holds while it hands the server over', async () => {
    const lease = fakeLease();
    const said = { holds: false };
    type Parts = Parameters<NonNullable<KeeperOptions['handing']>>[0];
    const given: Parts[] = [];
    const target = { machine: '0f0f0f0f-0000-4000-8000-00000000000b', networkId: 'b0'.repeat(16) };
    const handing: KeeperOptions['handing'] = parts => (given.push(parts), { start: async () => undefined, stop: async () => undefined, holds: () => said.holds, to: () => (said.holds ? target : null) });
    const front = await appIsDown();
    const k = await keeperOn(await echoHeaders(), { lease, handing, everyMs: 20, ports: { front: front.port, linkHttp: 0, linkTls: 0, peer: 0, peerApp: 0 } });
    const parts = given[0]!;
    const count = (method: string) => lease.calls.filter(call => call.method === method).length;
    await until(() => wordIn(k.dir) === 'lead');
    expect([(await send(front, { path: '/' })).status, count('take'), parts.leads(), parts.term()?.number]).toEqual([200, 1, true, 1]);
    /* Whoever asks at its door hears from the keeper itself where the company moves: nothing while it leads, and the
       machine it hands the server to once it does, whatever the app does. */
    const moves = async () => JSON.parse((await send(front, { path: '/api/network/switch?x=1' })).body) as object;
    expect(await moves()).toEqual({ self: null, moving: false, from: null, to: null, since: null, cut: false, question: false });
    /* It stops: the door closes, the lease ends, and it leads no more. */
    said.holds = true;
    expect(await moves()).toMatchObject({ moving: true, to: target.machine, cut: false, question: false });
    await parts.front.close();
    await parts.lease.fence();
    await expect(send(front, { path: '/' })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await until(() => wordIn(k.dir) === 'read');
    expect([k.keeper.mode(), parts.leads(), parts.term(), count('fence')]).toEqual(['read', false, null, 1]);
    /* It tells the other machines that keep data which one the server goes to. */
    expect(k.keeper.beats().own().stance).toEqual({ kind: 'handing', to: target.networkId });
    const renewed = count('renew');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect([count('take'), count('renew') - renewed]).toEqual([1, 0]);
    /* The switch was called off: the door opens, and it leads again under its next term. */
    said.holds = false;
    parts.front.open();
    await until(() => wordIn(k.dir) === 'lead');
    expect([count('take'), parts.term()?.number]).toEqual([2, 2]);
    await until(async () => (await send(front, { path: '/' }).catch(() => null))?.status === 200);

    /* A keeper that starts in the middle of handing over opens no front door and takes no lease. */
    const held = fakeLease();
    said.holds = true;
    const other = await appIsDown();
    const again = await keeperOn(await echoHeaders(), { lease: held, handing, everyMs: 20, ports: { front: other.port, linkHttp: 0, linkTls: 0, peer: 0, peerApp: 0 } });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect([wordIn(again.dir), held.calls.filter(call => call.method === 'take')]).toEqual(['read', []]);
    await expect(send(other, { path: '/' })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('gives its part of an update what it goes by, and moves no server while it is busy', async () => {
    type Parts = Parameters<NonNullable<KeeperOptions['updating']>>[0];
    const given: Parts[] = [];
    const said = { busy: false };
    const order: string[] = [];
    const updating: KeeperOptions['updating'] = parts => (given.push(parts), { start: async () => void order.push('update part started'), stop: async () => undefined, busy: () => said.busy });
    const moves: (() => boolean)[] = [];
    const handing: KeeperOptions['handing'] = parts => (moves.push(parts.updating), { start: async () => void order.push('handing part started'), stop: async () => undefined, holds: () => false });
    const k = await keeperOn(await echoHeaders(), { updating, handing, everyMs: 20 });
    const parts = given[0]!;
    await until(() => wordIn(k.dir) === 'lead');
    expect([parts.leads(), parts.maintenance(), moves[0]!()]).toEqual([true, false, false]);
    /* The part of the update starts before the one that hands the server over looks. */
    expect(order).toEqual(['update part started', 'handing part started']);
    /* While the updater installs, the lease is in maintenance. */
    statusSays(k.dir, 'running', 'backup');
    await until(() => wordIn(k.dir) === 'maintenance');
    expect([parts.leads(), parts.maintenance()]).toEqual([false, true]);
    /* No server is moved while an update is on, in whatever step, or while its keeper still has it to end. */
    expect(moves[0]!()).toBe(true);
    statusSays(k.dir, 'done', 'finished');
    await until(() => wordIn(k.dir) === 'lead');
    expect(moves[0]!()).toBe(false);
    said.busy = true;
    expect(moves[0]!()).toBe(true);
  });

  it('keeps leading and serving when its own folder cannot be written', async () => {
    const config = loadConfig({ HORNHOOF_SECRET: TEST_SECRET, HORNHOOF_CONTROL_DIR: folder(), HORNHOOF_MACHINE_ID: 'a1b2c3d4'.repeat(4) });
    const notAFolder = join(folder(), 'keeper');
    writeFileSync(notAFolder, 'a file where the folder should be');
    const { keeper, lines, front } = await keeperOn(await echoHeaders(), { config, dir: notAFolder });
    expect(keeper.mode()).toBe('lead');
    expect((await send(front)).status).toBe(200);
    expect(keeper.certificate()).toBeNull();
    expect(lines.filter(line => line.startsWith("The keeper cannot keep this machine's key"))).toHaveLength(1);
  });

  it('holds a request no longer than whoever sent it asks, and never longer than its own hold', async () => {
    const { front } = await keeperOn(await appIsDown(), { ...FAST, holdEveryMs: 5 });
    const asked = await send(front, { path: '/api/me', headers: { 'x-hornhoof-hold': '0' } });
    expect(asked.status).toBe(502);
    expect(JSON.parse(asked.body).error.reason).toBe('starting');
    const short = await send(front, { path: '/api/me', headers: { 'x-hornhoof-hold': '30' } });
    expect(short.status).toBe(503);
    /* Words that are no time ask for nothing. */
    const { front: other } = await keeperOn(await appIsDown(), { ...FAST, holdMs: 30, holdEveryMs: 5 });
    for (const hold of ['soon', '-5', '999999999']) expect((await send(other, { path: '/api/me', headers: { 'x-hornhoof-hold': hold } })).status, hold).toBe(503);
  });

  it("passes front's invocation id on, and no one else's", async () => {
    const id = '5f0c2b1e-8a43-4c1d-9e57-2b7f6a1d3c90';
    const seen = async (frontHost: string, value: string) => {
      const { front } = await keeperOn(await echoHeaders(), { frontHost });
      return JSON.parse((await send(front, { headers: { 'x-hornhoof-invocation': value } })).body)['x-hornhoof-invocation'] as string | undefined;
    };
    expect(await seen('localhost', id)).toBe(id);
    expect(await seen('localhost', id.toUpperCase())).toBe(id);
    expect(await seen('localhost', 'not-a-uuid')).toBeUndefined();
    expect(await seen('front.invalid', id)).toBeUndefined();
  });

  it("takes link traffic through the keeper as over the link, and front's as local", async () => {
    const { app } = await testApp({ TUNNEL_HOST: 'localhost' });
    await setUpCompany(app);
    const { front, link } = await keeperOn(await appListening(app), { frontHost: 'localhost' });

    expect(await health(link)).toEqual({ ok: true });
    expect((await signIn(link)).cookies).toContain('__Host-hh_session');

    expect(await health(front)).toMatchObject({ ok: true, version: expect.any(String), commit: expect.any(String) });
    const overFront = await signIn(front);
    expect(overFront.cookies).toContain('hh_session');
    expect(overFront.cookies).not.toContain('__Host-hh_session');
  });

  it('believes no forged header that did not come through its door', async () => {
    const { app, config } = await testApp({ TUNNEL_HOST: 'localhost' });
    app.get('/who', async req => ({ address: await clientAddress(req, config), overLink: req.overLink }));
    const target = await appListening(app);
    const who = async (door: Target, headers: http.OutgoingHttpHeaders) => JSON.parse((await send(door, { path: '/who', headers })).body);
    const forged = { 'x-forwarded-for': '198.51.100.7', 'x-forwarded-proto': 'https' };

    /* The built-in node shares the network with the keeper's front port, and its socket is not front's. */
    const fromNode = await keeperOn(target, { frontHost: 'front.invalid' });
    expect(await who(fromNode.front, forged)).toEqual({ address: '127.0.0.1', overLink: false });

    const fromFront = await keeperOn(target, { frontHost: 'localhost' });
    expect(await who(fromFront.front, forged)).toEqual({ address: '198.51.100.7', overLink: false });

    expect(await who(fromNode.link, { 'x-forwarded-for': '203.0.113.5, 198.51.100.7' })).toEqual({ address: '203.0.113.5', overLink: true });
  });

  it("lets the updater read the new build's health through front during maintenance, while changes wait", async () => {
    const dir = folder();
    const { app } = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_KEEPER: 'on', HORNHOOF_CONTROL_DIR: dir });
    const { front, link } = await keeperOn(await appListening(app), { ...FAST, frontHost: 'localhost' }, dir);
    statusSays(dir, 'running', 'health');
    await until(async () => {
      await app.ctx.mode.check();
      return app.ctx.mode.current() === 'maintenance';
    });

    const seen = await send(front, { path: '/api/health' });
    expect(seen.status).toBe(200);
    expect(JSON.parse(seen.body)).toMatchObject({ ok: true, commit: 'local', mode: 'maintenance' });
    expect(await health(link)).toEqual({ ok: true });

    /* The app's refusal, word for word what the keeper answers while the app is down, so the Update panel reads one state. */
    const change = await signIn(front);
    expect(change.status).toBe(503);
    expect(JSON.parse(change.body)).toEqual({ error: { code: 'unavailable', message: MAINTENANCE_MESSAGE, reason: 'maintenance' } });
  });

  it('finishes a request in flight when it stops, then takes no other and writes no more', async () => {
    let arrived = (): void => {};
    const inFlight = new Promise<void>(resolve => {
      arrived = resolve;
    });
    const answerLate = async (res: http.ServerResponse) => {
      arrived();
      await sleep(200);
      res.end('whole');
    };
    const app = await listening(http.createServer((_req, res) => void answerLate(res)));
    const { keeper, dir, front, ports } = await keeperOn(app, { everyMs: 20 });
    const answer = send(front);
    await inFlight;
    await keeper.stop();
    expect(await answer).toMatchObject({ status: 200, body: 'whole' });
    await expect(send({ host: '127.0.0.1', port: ports.front })).rejects.toThrow('ECONNREFUSED');
    const last = readKeeperState(dir)?.at;
    await sleep(100);
    expect(readKeeperState(dir)?.at).toBe(last);
  });

  it('keeps a socket that stays open through the grace when it stops, and ends the stop once the grace is over', async () => {
    /* The keeper's grace for what is still open when it stops: half of the 10 s Docker waits after its signal. */
    const STOP_GRACE_MS = 5000;
    const app = http.createServer();
    const sockets = new WebSocketServer({ server: app });
    const { keeper, front } = await keeperOn(await listening(app));
    const client = new WebSocket(`ws://127.0.0.1:${front.port}/socket`);
    client.on('error', () => {});
    onTestFinished(() => client.terminate());
    const arrived = once(sockets, 'connection') as Promise<[WebSocket]>;
    await once(client, 'open');
    const [atApp] = await arrived;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => void vi.useRealTimers());
    let stopped = false;
    const stopping = keeper.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1);
    expect(stopped).toBe(false);
    const up = once(atApp, 'message');
    client.send('still here');
    expect(String((await up)[0])).toBe('still here');
    const down = once(client, 'message');
    atApp.send('so am I');
    expect(String((await down)[0])).toBe('so am I');
    expect(stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    await expect(send(front)).rejects.toThrow('ECONNREFUSED');
  });
});

describe('the keeper container', () => {
  const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

  /* The entry point has its ports and its app written in. This keeps them from reaching anything real on this machine:
     it runs the entry point as it is, says what it asked for, and goes to the test's own target instead. */
  const PRELOAD = `
    import http from 'node:http';
    import net from 'node:net';
    const { listen } = net.Server.prototype;
    net.Server.prototype.listen = function (port, host, done) {
      return listen.call(this, 0, '127.0.0.1', () => {
        console.log(JSON.stringify({ asked: { port, host }, port: this.address().port }));
        done();
      });
    };
    const { request } = http;
    http.request = options => {
      console.log(JSON.stringify({ target: { host: options.host, port: options.port } }));
      return request({ ...options, host: '127.0.0.1', port: Number(process.env.KEEPER_TEST_APP) });
    };
    const { connect } = net;
    net.connect = () => connect(Number(process.env.KEEPER_TEST_APP), '127.0.0.1');
  `;

  async function container(app: Target) {
    const dir = folder();
    const env = {
      ...process.env,
      HORNHOOF_SECRET: TEST_SECRET,
      HORNHOOF_CONTROL_DIR: dir,
      /* Nothing answers here, so the keeper reads no link and runs no frpc. */
      DATABASE_URL: 'postgres://hornhoof:hornhoof@127.0.0.1:1/hornhoof',
      KEEPER_TEST_APP: String(app.port),
    };
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', `data:text/javascript,${encodeURIComponent(PRELOAD)}`, 'src/keeper.ts'], {
      cwd: SERVER_DIR,
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    onTestFinished(() => void child.kill('SIGKILL'));
    const exit = once(child, 'exit');
    const said: Record<string, unknown>[] = [];
    const everyDoor = new Promise<void>(resolve => {
      createInterface({ input: child.stdout as NodeJS.ReadableStream }).on('line', line => {
        /* The keeper's own log lines go here too. */
        if (line.startsWith('{')) said.push(JSON.parse(line) as Record<string, unknown>);
        if (said.filter(word => word.asked).length === 3) resolve();
      });
    });
    await everyDoor;
    const doors = said.filter(word => word.asked);
    return { child, dir, said, doors, exit, front: { host: '127.0.0.1', port: doors[0]!.port as number } };
  }

  it.each(['SIGINT', 'SIGTERM'] as const)('opens the front port to all and the link doors to itself, and exits 0 on %s', async signal => {
    const { child, dir, said, doors, exit, front } = await container(await echoHeaders());
    expect(doors.map(door => door.asked)).toEqual([
      { port: KEEPER_PORTS.front, host: '0.0.0.0' },
      { port: KEEPER_PORTS.linkHttp, host: '127.0.0.1' },
      { port: LINK_TLS_PORT, host: '127.0.0.1' },
    ]);
    expect(await forwardedWith(front, '198.51.100.7')).toBe('127.0.0.1');
    expect(said.find(word => word.target)?.target).toEqual({ host: 'app', port: 8080 });
    /* It was started with no machine id, so it holds no lease, and without one the app never leads on its word. */
    expect(wordIn(dir)).toBe('read');
    child.kill(signal);
    expect(await exit).toEqual([0, null]);
  });
});
