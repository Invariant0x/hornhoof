import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { certificates, machines } from '../src/db/schema.js';
import { bundleRows } from '../src/modules/backups/records.js';
import { checkHead } from '../src/modules/backups/bundle.js';
import { BUNDLES_DIR } from '../src/modules/keeper/backups.js';
import { CERT_FILE, type HeldCertificate } from '../src/modules/keeper/certificate.js';
import { machineKey, writePrivately } from '../src/modules/keeper/machine-keys.js';
import { PIN_FILE, readPin } from '../src/modules/keeper/owner-pin.js';
import { keyPrint } from '../src/modules/computer/owner-key.js';
import { PEERS_FILE, TICKET_FILE, viewIn, type KeeperView } from '../src/modules/keeper/worker.js';
import type { WorkerView } from '../src/modules/network/join.js';
import { WIPE_FILE, WIPED_FILE } from '../src/modules/keeper/uploads.js';
import type { WorkerConfig } from '../src/modules/keeper/worker-config.js';
import type { VisitSettings } from '../src/modules/link/visit-client.js';
import { certFacts, issueCertificate } from '../src/modules/network/authority.js';
import { refreshBuild } from '../src/modules/network/follow.js';
import { renewedMessage } from '../src/modules/network/renewal.js';
import { setupCode } from '../src/modules/setup/code.js';
import { authorityOf } from '../src/modules/network/store.js';
import { as, SETUP, TEST_SECRET, testApp } from './helpers.js';

import { type Company, DAY_MS, HOST_ID, MAC, SLEEPER, ask, company, folder, hasLeader, heldIn, hostIdOf, worker, workerOn } from './worker-keeper-fixture.js';

import { appAt, controlledTime, registerStep, until } from './worker-keeper-time.js';

beforeEach(controlledTime);

function updaterAlive(control: string): void {
  const file = join(control, 'alive');
  writeFileSync(file, '');
  utimesSync(file, new Date(), new Date());
}

/* A certificate of the company's authority for the worker's key, issued so long ago that it has ended. */
async function expire(c: Company, w: { machine: string; config: WorkerConfig }): Promise<HeldCertificate> {
  const key = machineKey(w.config.dir);
  const authority = (await authorityOf(c.db, c.config))!;
  const old = await issueCertificate(authority, { machineId: w.machine, role: 'worker', signKey: key.publicPem, now: new Date(Date.now() - 31 * DAY_MS) });
  const held: HeldCertificate = { machine: w.machine, role: 'worker', certPem: old.certPem, authorityPem: authority.certPem, until: old.until.toISOString() };
  writePrivately(join(w.config.dir, CERT_FILE), JSON.stringify(held));
  return held;
}

/* Each test here starts a company's app with its keeper and a machine's keeper beside it, and several wait for rounds
   of both: on a loaded runner that takes longer than the limit of a plain test. */
describe("a worker's keeper", { timeout: 60_000 }, () => {
  it('joins with its ticket and serves the company on its front door', async () => {
    const c = await company({}, {}, {}, undefined, true);
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

  it('says the company moves when the leader is lost, by itself and to anyone', async () => {
    const c = await company();
    const w = await worker(c);
    await until(() => w.status().leader !== null);
    const leader = w.status().leader!.machine;
    const word = async () => (await ask(w.front, { path: '/api/network/switch' })).json() as { self: string | null; moving: boolean; from: string | null; to: string | null; since: string | null };
    await until(async () => (await word()).self === w.machine);
    expect(await word()).toEqual({ self: w.machine, moving: false, from: null, to: null, since: null, cut: false, question: false });
    /* The leader is gone: for a while the page hears that the company moves, from that machine, to nobody this one
       knows, since the leader named no copy its commits waited for. */
    await c.stop();
    await until(async () => (await word()).moving);
    const lost = await word();
    expect(lost).toMatchObject({ self: w.machine, moving: true, from: leader, to: null, cut: false, question: false });
    expect(Number.isNaN(Date.parse(lost.since!))).toBe(false);
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

  it("keeps what the leader says of this machine's copy whole: the leader it is of, and the slot to join", async () => {
    const c = await company();
    const views: KeeperView[] = [];
    const w = await worker(c, { onView: view => views.push(view) });
    await until(async () => (await c.rowOf(w.machine)).ageKey !== null);
    await c.db.update(machines).set({ role: 'data' }).where(eq(machines.id, w.machine));
    await until(() => views.some(view => view.copy !== null));
    /* The leader's own network id, which the copy's keeper follows, votes for and takes over from; no slot to join,
       since no switch made one. */
    expect(views.find(view => view.copy !== null)!.copy).toMatchObject({ slot: null, lastAttempt: null, leader: HOST_ID, join: null });
  });

  it('drops nothing of a view the server gives', () => {
    const [network, other] = [HOST_ID, 'b'.repeat(64)];
    const view: WorkerView = {
      machine: '6f0e2c1a-0d7b-4a53-9c58-2f1c7c0f6d11', role: 'data', authorityPem: 'pem', revoked: ['01'],
      data: [{ machine: '0b0f6c7e-3a43-4d0e-8a57-6f4f6f0a2b22', networkId: other, hostname: 'deb', addresses: ['10.0.0.2'], peerPort: 8180, webPort: 8080, number: 2, copyName: 'copy_bbbbbbbbbbbbbbbb_1' }],
      link: { name: 'acme', url: 'https://acme.hornhoof.test', serverAddr: 'hornhoof.test', serverPort: 443, appSecret: 'a'.repeat(43), visitorKey: 'v'.repeat(32), dataSecret: 'd'.repeat(43), hidden: true },
      build: null, go: null,
      copy: { slot: 'ok', leaderSize: 1024, migrations: 116, old: 'waiting', upload: null, lastAttempt: 1, leader: network, join: 'copy_bbbbbbbbbbbbbbbb_2' },
    };
    /* The build and this machine's turn to install it are read apart. */
    const kept: Partial<WorkerView> = { ...view };
    delete kept.build;
    delete kept.go;
    expect(viewIn(JSON.parse(JSON.stringify(view)))).toEqual(kept);
    /* A server of the build before names less, and what it leaves out is no word of it. */
    expect(viewIn({ data: [{ machine: 'm', networkId: other, hostname: null, addresses: [], peerPort: null, webPort: null }], copy: { slot: null, leaderSize: null, migrations: null } })).toEqual({
      data: [{ machine: 'm', networkId: other, hostname: null, addresses: [], peerPort: null, webPort: null, number: null, copyName: null }],
      copy: { slot: null, leaderSize: null, migrations: null, old: null, upload: null, lastAttempt: null },
    });
    expect(viewIn('nothing')).toBeNull();
  });

  it('says when it could not become a data machine', async () => {
    const c = await company();
    const w = await worker(c);
    await until(async () => (await c.rowOf(w.machine)).ageKey !== null);
    /* The updater could not write the settings: it took the request and the marker away and left its line. */
    writeFileSync(join(w.config.controlDir, 'role.failed'), "The company's settings cannot be written here, so this machine stays a worker.\n");
    await c.db.update(machines).set({ role: 'data' }).where(eq(machines.id, w.machine));
    await until(async () => (await c.rowOf(w.machine)).copyState === 'stopped');
    expect(await c.rowOf(w.machine)).toMatchObject({ copyState: 'stopped', copyError: 'setup', copyName: null, copyProgress: null });
    /* It asks for nothing more for an hour. */
    expect(existsSync(join(w.config.controlDir, 'role.json'))).toBe(false);
    expect(existsSync(join(w.config.controlDir, 'role.failed'))).toBe(false);
  });

  it('shows its parts', async () => {
    const c = await company();
    const w = await worker(c);
    await until(() => hasLeader(w.status()));
    const [first, second] = [w.keeper.parts(), w.keeper.parts()];
    expect(first.link).toBe(second.link);
    expect(first.certificates).toBe(second.certificates);
    /* They are the ones it works with: the session to the leader, and the certificate it holds. */
    expect(first.link.leader()?.machine).toBe(w.status().leader!.machine);
    expect(first.certificates.current()?.machine).toBe(w.machine);
    expect(w.status().role).toBe('worker');
  });

  /* The test in the updater's place on the server: it answers every request for a dump, until the test ends. */
  function updaterOf(c: Company, manual = false): () => void {
    const request = join(c.control, 'dump.json');
    const dumps = join(c.control, 'dumps');
    const step = () => {
      try {
        const { id } = JSON.parse(readFileSync(request, 'utf8')) as { id: string };
        if (existsSync(join(dumps, `${id}.json`))) return;
        mkdirSync(dumps, { recursive: true });
        writeFileSync(join(dumps, `${id}.sql.gz`), gzipSync('-- a dump of the hornhoof database\n'));
        writeFileSync(join(dumps, `${id}.json`), JSON.stringify({ id, reason: 'timer', at: new Date().toISOString(), migrations: 106 }));
      } catch {
        /* No request now. */
      }
    };
    if (!manual) {
      const remove = registerStep(step);
      onTestFinished(remove);
    }
    return step;
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
    appAt(c.appPort, fresh.app);
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
    updaterAlive(control);
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
    }, true);
    const w = await worker(c, { holderEveryMs: 30 });
    await until(() => hasLeader(w.status()) && c.keeper['backups'] !== null && w.keeper['ageRecipient'] !== null);
    await w.keeper['report']();
    const saved = await c.app.inject({ method: 'POST', url: '/api/backups/recovery', ...as(c.ceo) });
    expect(saved.statusCode).toBe(200);
    const backups = c.keeper['backups']!;
    await backups.round();
    updaterOf(c, true)();
    await backups.round();
    const [held] = await bundleRows(c.db, { limit: 1, withRecovery: true });
    expect(held).toBeDefined();
    /* Arrange a held, signed bundle directly. Fetching it over a timed socket belongs to the holder's own tests. */
    const bundle = backups.store().open(held!.id)!;
    await w.keeper['holder'].store().take(bundle.stream(), head => checkHead(head, { authorityPem: heldIn(w.config.dir).authorityPem, company: null }), { id: held!.id });
    await w.keeper['report']();
    older = true;
    const before = (await c.rowOf(w.machine)).reportAt;
    /* Its report is refused with the new words and goes again at once without them: first without its newest words
       alone, which this leader refuses as well, then bare. */
    const mine = () => seen.filter(report => report.via !== 'keeper').map(report => report.words).filter((words, at, all) => words !== all[at - 1]);
    vi.setSystemTime(Date.now() + 1);
    await w.keeper['holder'].round();
    await w.keeper['report']();
    await w.keeper['report']();
    await c.keeper['identity']!['report']();
    expect(mine().slice(0, 4)).toEqual([true, false, true, false]);
    expect((await c.rowOf(w.machine)).reportAt!.getTime()).toBeGreaterThan(before!.getTime());
    /* The server's own keeper does the same. */
    expect(seen.filter(report => report.via === 'keeper').slice(0, 2).map(report => report.words)).toEqual([true, false]);
    expect(bundlesIn(w.config.dir)).toEqual([`${held!.id}.age`]);
    expect(readFileSync(join(w.config.dir, BUNDLES_DIR, `${held!.id}.age`))).toEqual(readFileSync(backups.store().ageFile(held!.id)));
    expect([...w.lines, ...c.lines].filter(line => line.includes('Could not report'))).toEqual([]);
  });

  it('goes on telling a leader of the build before of its copy and its backups, without the measures that one refuses', async () => {
    /* A leader an update took back one build: it knows backups and copies, and nothing of the server order's measures. */
    let older = false;
    const seen: { measures: boolean; backups: boolean }[] = [];
    const c = await company({}, {}, {}, ({ method, url, via, body }) => {
      if (!older || via === 'keeper' || method !== 'POST' || url !== '/api/network/report') return null;
      const measures = ['linkRttMs', 'internetRttMs', 'internetMbps'].some(word => word in (body as object));
      seen.push({ measures, backups: 'heldBackups' in (body as object) });
      return measures ? 400 : null;
    });
    const w = await worker(c);
    await until(async () => (await c.rowOf(w.machine)).linkRttMs !== null);
    older = true;
    await until(() => seen.filter(report => !report.measures).length >= 2);
    /* Refused with the measures, each report goes again at once with everything else it had to say. On a loaded
       machine two reports may be on their way at once, so each one without the measures has a refused one before it. */
    const said = [...seen];
    expect(said.every(report => report.backups)).toBe(true);
    let refused = 0;
    for (const report of said) {
      refused += report.measures ? 1 : -1;
      expect(refused, JSON.stringify(said)).toBeGreaterThanOrEqual(0);
    }
    expect(w.lines.filter(line => line.includes('Could not report'))).toEqual([]);
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
    vi.setSystemTime(Date.now() + 50);
    again.keeper['look']();
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

  it("dials by the view's secret", async () => {
    const c = await company();
    const w = await worker(c);
    await until(async () => hasLeader(w.status()) && (await c.rowOf(w.machine)).reportAt !== null);
    await w.stop();
    await c.stop();
    /* The view the keeper wrote down, with a link of the company as the leader gives it to a machine that holds the
       data, or to any other. */
    const peers = join(w.config.dir, PEERS_FILE);
    const view = JSON.parse(readFileSync(peers, 'utf8')) as Record<string, unknown>;
    const link = { name: 'acme', url: 'https://acme.hornhoof.test', serverAddr: 'relay.hornhoof.test', serverPort: 443, appSecret: 'a'.repeat(43), visitorKey: 'v'.repeat(32) };
    const started = async (dataSecret: string | null, over: { visitKind?: 'view' } = {}) => {
      writePrivately(peers, JSON.stringify({ ...view, link: { ...link, dataSecret } }));
      const visits: VisitSettings[] = [];
      const again = await workerOn(c, w.config, { ...over, visitClientFor: settings => (visits.push(settings), SLEEPER) });
      await until(() => visits.length > 0);
      await again.stop();
      return visits[0]!;
    };
    /* A keeper that keeps a copy reaches the service with the way to the data while its view carries that secret. */
    expect(await started('d'.repeat(43), { visitKind: 'view' })).toMatchObject({ appSecret: link.appSecret, dataSecret: 'd'.repeat(43) });
    /* Its copy was retired: the leader gives it that secret no more, and it reaches the app's service from the start. */
    expect(await started(null, { visitKind: 'view' })).not.toHaveProperty('dataSecret');
    /* A worker's keeper never reaches for the data, whatever its view says. */
    expect(await started('d'.repeat(43))).not.toHaveProperty('dataSecret');
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

  it("retries keeping its owner's key after the ticket is accepted", async () => {
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
    expect(existsSync(join(config.dir, TICKET_FILE))).toBe(false);
    /* The keeper can finish pinning locally once the folder becomes writable. */
    rmSync(join(config.dir, PIN_FILE), { recursive: true });
    await until(() => readPin(config.dir) === ownerKey);
    await until(async () => (await c.rowOf(machine)).ownerPin === keyPrint(ownerKey));
    expect(readFileSync(join(config.dir, TICKET_FILE), 'utf8')).toBe(JSON.stringify({ hash: hashToken(ticket) }));
    expect(await c.db.select().from(certificates).where(eq(certificates.machineId, machine))).toHaveLength(1);
    await w.stop();
  });

  it("has a data machine's keeper report its addresses and its host's name", async () => {
    const c = await company({ addresses: ['192.0.2.4', '8.8.8.8'], hostname: 'deb', reportAs: undefined });
    await until(async () => (await c.serverRow())?.hostname === 'deb');
    expect(await c.serverRow()).toMatchObject({ hostname: 'deb', addresses: ['192.0.2.4'] });
  });
  it("reports what its updater learned of the machine where the installer wrote neither name nor system", async () => {
    /* A server that came to this build by Update: its settings name no host, and its updater asked the engine. */
    const c = await company({ addresses: [], hostname: null, reportAs: undefined });
    writeFileSync(join(c.control, 'host.json'), JSON.stringify({ os: 'linux', hostname: 'host-a' }));
    writeFileSync(join(c.control, 'addresses.json'), JSON.stringify({ at: Math.floor(Date.now() / 1000), addresses: ['192.0.2.4'] }));
    await until(async () => (await c.serverRow())?.hostname === 'host-a');
    expect(await c.serverRow()).toMatchObject({ hostname: 'host-a', os: 'linux', addresses: ['192.0.2.4'] });
  });
  it('reports its round trip and the internet', async () => {
    const c = await company();
    const w = await worker(c, { internet: { start: () => undefined, stop: () => undefined, snapshot: () => ({ internetRttMs: 48, internetMbps: 84 }) } });
    await until(async () => (await c.rowOf(w.machine)).internetMbps === 84);
    const row = await c.rowOf(w.machine);
    expect(row.internetRttMs).toBe(48);
    /* The day's median of its hellos to the leader, both on this computer. */
    await until(async () => (await c.rowOf(w.machine)).linkRttMs !== null);
    expect((await c.rowOf(w.machine)).linkRttMs).toBeLessThan(2000);
    /* How fast the leader sends to it is the leader's to measure. */
    expect(row.linkMbps).toBeNull();
  });

  it('says a machine that holds no database is wiped, and one that was wiped once its updater said so', async () => {
    const c = await company();
    const w = await worker(c);
    const row = () => c.rowOf(w.machine);
    const control = (name: string) => join(w.config.controlDir, name);
    /* Rounds until the leader's word on this machine's upload reached it. A round reads the view and then reports, so
       that report is made on the word; and rounds go one at a time, so none made before a step lands after it. */
    const told = (upload: 'waiting' | 'wipe') => until(() => w.keeper.known()?.copy?.upload === upload);
    /* Rounds until one more report of the machine reached the leader. */
    const report = async () => {
      const before = (await row()).reportAt?.getTime() ?? 0;
      await until(async () => ((await row()).reportAt?.getTime() ?? 0) > before);
    };
    /* While its updater still wipes it, it says nothing of the kind. */
    writeFileSync(control(WIPE_FILE), JSON.stringify({ id: 'w1', step: 'volume' }));
    await c.db.update(machines).set({ uploadState: 'kept', dataLeftAt: new Date() }).where(eq(machines.id, w.machine));
    await told('wipe');
    await report();
    expect((await row()).uploadState).toBe('kept');
    /* The updater is done: the leader hears it, and the updater's word goes once it did. */
    rmSync(control(WIPE_FILE));
    writeFileSync(control(WIPED_FILE), JSON.stringify({ id: 'w1', at: new Date().toISOString() }));
    await report();
    expect((await row()).uploadState).toBeNull();
    expect(existsSync(control(WIPED_FILE))).toBe(false);
    /* The leader counts on a machine for what it held, though a worker's keeper holds no database: it says so, and owes
       nothing. */
    await c.db.update(machines).set({ uploadState: 'waiting' }).where(eq(machines.id, w.machine));
    await told('waiting');
    await report();
    expect((await row()).uploadState).toBeNull();
    /* A machine marked as one that keeps a copy holds a database, whatever keeper runs on it: it says nothing either. */
    writeFileSync(control('replica.json'), '{}');
    await c.db.update(machines).set({ uploadState: 'kept' }).where(eq(machines.id, w.machine));
    await told('wipe');
    await report();
    expect((await row()).uploadState).toBe('kept');
  });
});
