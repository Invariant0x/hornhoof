import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as x509 from '@peculiar/x509';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { authority, certificates, companies, machines, peerSecrets, people } from '../src/db/schema.js';
import { writeKeeperState } from '../src/modules/keeper/state.js';
import { UPLOAD_SPARE } from '../src/modules/keeper/uploads.js';
import { saveLink } from '../src/modules/link/link.js';
import { LEFT_SLOTS_FRESH_MS } from '../src/modules/copies/left-slots.js';
import { dataViews } from '../src/modules/copies/view.js';
import { certFacts, issuedBy } from '../src/modules/network/authority.js';
import { thisMachine } from '../src/modules/network/store.js';
import { as, invitePerson, setUpCompany, testApp, until } from './helpers.js';

const MACHINE_ID = 'a1b2c3d4'.repeat(4);
const VIA = 'x-hornhoof-via';
/* The keeper's own request: from its address, with the header no door lets through. */
const OWN = { remoteAddress: '127.0.0.1', headers: { [VIA]: 'keeper' } };
/* A peer machine's keeper, as the peer door passes its own requests on: named by its certificate, and marked as the
   keeper's and not a visitor's of that machine. */
const from = (machine: string) => ({ remoteAddress: '127.0.0.1', headers: { [VIA]: machine, 'x-hornhoof-keeper': '1' } });

const newKey = (): string => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();

async function company(env: NodeJS.ProcessEnv = {}) {
  const { app, db, config } = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: MACHINE_ID, ...env });
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const certificate = (signKey: string, who: object = OWN) => app.inject({ method: 'POST', url: '/api/network/certificate', payload: { signKey }, ...who });
  const peers = (who: object = OWN) => app.inject({ url: '/api/network/peers', ...who });
  const serverRows = () => db.select().from(machines).where(and(eq(machines.companyId, acme!.id), isNull(machines.revokedAt)));
  /* A machine that joined the network, as plan 5b makes them. */
  const joined = async (role: 'data' | 'worker', signKey: string, more: Partial<typeof machines.$inferInsert> = {}) =>
    (await db.insert(machines).values({ companyId: acme!.id, personId: owner!.id, machineKey: `joined-${role}-${signKey.length}-${Math.random()}`, role, signKey, ...more }).returning())[0]!;
  return { app, db, config, ceo, companyId: acme!.id, ownerId: owner!.id, certificate, peers, serverRows, joined };
}

const revokedIn = (crlPem: string): string[] => (new x509.X509Crl(crlPem).entries ?? []).map(entry => entry.serialNumber.toLowerCase());

describe('the network routes the keeper calls', () => {
  it('gives its own machine a data certificate, from an authority made once', async () => {
    const c = await company();
    const key = newKey();
    const first = await c.certificate(key);
    expect(first.statusCode).toBe(200);
    const answer = first.json() as { machine: string; role: string; certPem: string; authorityPem: string; until: string };
    const [row] = await c.serverRows();
    expect(row).toMatchObject({ personId: c.ownerId, networkId: MACHINE_ID, role: 'data', machineKey: `server:${MACHINE_ID}`, hostname: '', signKey: key });
    expect(answer).toMatchObject({ machine: row!.id, role: 'data' });
    expect(certFacts(answer.certPem)).toMatchObject({ machineId: row!.id, role: 'data' });
    expect(issuedBy(answer.authorityPem, answer.certPem)).toBe(true);
    expect(new Date(answer.until).getTime()).toBe(new X509Certificate(answer.certPem).validToDate.getTime());
    expect(await c.db.select().from(authority)).toHaveLength(1);
    expect(await c.db.select().from(certificates)).toMatchObject([{ serial: certFacts(answer.certPem).serial, machineId: row!.id, revokedAt: null }]);

    const second = (await c.certificate(key)).json() as { certPem: string; authorityPem: string };
    expect(second.authorityPem).toBe(answer.authorityPem);
    expect(certFacts(second.certPem).serial).not.toBe(certFacts(answer.certPem).serial);
    expect(await c.serverRows()).toHaveLength(1);
    expect(await c.db.select().from(certificates)).toHaveLength(2);

    /* The keeper lost its volume and made a new key. */
    const other = newKey();
    const third = (await c.certificate(other)).json() as { certPem: string };
    expect(certFacts(third.certPem).signKey.trim()).toBe(other.trim());
    expect((await c.serverRows())[0]!.signKey).toBe(other);
  });

  it("keeps the leader's row apart from people's machines", async () => {
    const c = await company();
    const [computer] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.ownerId, machineKey: 'mac-0001-abcd', hostname: 'dev-mac' }).returning();
    await c.certificate(newKey());
    const [server] = await c.db.select().from(machines).where(eq(machines.networkId, MACHINE_ID));
    expect(server!.id).not.toBe(computer!.id);

    const listed = (await c.app.inject({ url: '/api/machines', ...as(c.ceo) })).json() as { machines: { id: string }[] };
    expect(listed.machines.map(m => m.id)).toEqual([computer!.id]);
    const pool = JSON.stringify((await c.app.inject({ url: '/api/pool', ...as(c.ceo) })).json());
    expect(pool).not.toContain(server!.id);
    for (const [method, url, payload] of [['POST', `/api/machines/${server!.id}/disconnect`, undefined], ['PATCH', `/api/machines/${server!.id}`, { lendsTests: false }]] as const) {
      expect((await c.app.inject({ method, url, payload, ...as(c.ceo) })).statusCode, url).toBe(404);
    }
    expect((await c.app.inject({ method: 'POST', url: `/api/machines/${computer!.id}/disconnect`, ...as(c.ceo) })).statusCode).toBeLessThan(300);
    expect((await c.db.select().from(machines).where(eq(machines.id, server!.id)))[0]!.revokedAt).toBeNull();
  });

  it('retires an older identity of this server, and lists its certificates as revoked', async () => {
    const c = await company();
    const [older] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.ownerId, machineKey: 'server:older', networkId: 'f'.repeat(32), role: 'data' }).returning();
    await c.db.insert(certificates).values({ serial: 'aa01', machineId: older!.id, until: new Date(Date.now() + 86_400_000) });
    await c.certificate(newKey());
    expect((await c.db.select().from(machines).where(eq(machines.id, older!.id)))[0]!.revokedAt).not.toBeNull();
    expect((await c.serverRows()).map(row => row.networkId)).toEqual([MACHINE_ID]);
    const said = (await c.peers()).json() as { revoked: string[]; crlPem: string };
    expect(said.revoked).toEqual(['aa01']);
    expect(revokedIn(said.crlPem)).toEqual(['aa01']);
  });

  it("keeps the old leader's install when a copy leads", async () => {
    const c = await company();
    /* A, where the company was installed, with its certificate, and B, a joined computer that took the server: this
       app runs on B. */
    const [a] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.ownerId, machineKey: `server:${'f'.repeat(32)}`, hostname: 'old-rack', networkId: 'f'.repeat(32), role: 'data' }).returning();
    await c.db.insert(certificates).values({ serial: 'aa01', machineId: a!.id, until: new Date(Date.now() + 86_400_000) });
    const b = await c.joined('data', newKey(), { hostname: 'b-box', networkId: MACHINE_ID });
    const answer = (await c.certificate(newKey())).json() as { machine: string };
    expect(answer.machine).toBe(b.id);
    expect((await c.db.select().from(machines).where(eq(machines.id, a!.id)))[0]!.revokedAt).toBeNull();
    expect((await c.db.select().from(certificates).where(eq(certificates.serial, 'aa01')))[0]!.revokedAt).toBeNull();
    expect(((await c.peers()).json() as { revoked: string[] }).revoked).toEqual([]);

    /* The install is listed as a machine, by the name its keeper reported, and is no computer to disconnect. The
       machine that leads is listed too, as the computer its owner joined, and does not leave either. */
    const listed = (await c.app.inject({ url: '/api/machines', ...as(c.ceo) })).json() as { machines: { id: string; hostname: string; serverInstall: boolean }[] };
    expect(listed.machines.map(m => [m.id, m.hostname, m.serverInstall])).toEqual(expect.arrayContaining([[a!.id, 'old-rack', true], [b.id, 'b-box', false]]));
    const refusal = async (id: string) => {
      const res = await c.app.inject({ method: 'POST', url: `/api/machines/${id}/disconnect`, ...as(c.ceo) });
      const { error } = res.json() as { error: { reason: string; message: string } };
      return [res.statusCode, error.reason, error.message];
    };
    expect(await refusal(a!.id)).toEqual([409, 'server_install', 'The company was installed on old-rack, so it cannot be disconnected.']);
    expect(await refusal(b.id)).toEqual([409, 'leader', 'b-box runs the company server. Move the server to another machine first.']);
    expect((await c.serverRows()).map(row => row.id).sort()).toEqual([a!.id, b.id].sort());
    /* The other routes of a machine take the install. */
    expect((await c.app.inject({ method: 'PATCH', url: `/api/machines/${a!.id}`, payload: { lendsTests: false }, ...as(c.ceo) })).statusCode).toBe(200);
  });

  it("refuses to disable the leader's person", async () => {
    const c = await company();
    const pat = await invitePerson(c.app, c.ceo, { name: 'Pat', email: 'pat@acme.test', access: { whole: true } });
    const [person] = await c.db.select().from(people).where(eq(people.email, 'pat@acme.test'));
    const [box] = await c.db.insert(machines).values({ companyId: c.companyId, personId: person!.id, machineKey: 'pat-0001-abcd', hostname: 'pat-box', networkId: MACHINE_ID, role: 'data' }).returning();
    const res = await c.app.inject({ method: 'PATCH', url: `/api/people/${person!.id}`, payload: { status: 'disabled' }, ...as(c.ceo) });
    const { error } = res.json() as { error: { reason: string; message: string } };
    expect([res.statusCode, error.reason, error.message]).toEqual([409, 'leader', 'pat-box runs the company server. Move the server to another machine first.']);
    expect((await c.db.select().from(people).where(eq(people.id, person!.id)))[0]!.status).toBe('active');
    expect((await c.db.select().from(machines).where(eq(machines.id, box!.id)))[0]!.revokedAt).toBeNull();
    expect((await c.app.inject({ url: '/api/me', ...as(pat) })).statusCode).toBe(200);
  });

  it("renews a peer's certificate for the same key only", async () => {
    const c = await company();
    const key = newKey();
    const worker = await c.joined('worker', key);
    const renewed = await c.certificate(key, from(worker.id));
    expect(renewed.statusCode).toBe(200);
    expect(certFacts((renewed.json() as { certPem: string }).certPem)).toMatchObject({ machineId: worker.id, role: 'worker' });
    expect(await c.db.select().from(certificates).where(eq(certificates.machineId, worker.id))).toHaveLength(1);

    const changed = await c.certificate(newKey(), from(worker.id));
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error).toMatchObject({ reason: 'key_changed', message: "This machine's key changed. Connect it again with a new command." });

    await c.db.update(machines).set({ revokedAt: new Date() }).where(eq(machines.id, worker.id));
    expect((await c.certificate(key, from(worker.id))).json().error.reason).toBe('not_a_machine');
    expect((await c.certificate(key, from('00000000-0000-4000-8000-000000000000'))).statusCode).toBe(404);
    const computer = await c.joined('worker', key, { role: null });
    expect((await c.certificate(key, from(computer.id))).json().error.reason).toBe('not_a_machine');
  });

  it('believes the via header from the keeper alone', async () => {
    const routes = (app: FastifyInstance, more: object) => [
      app.inject({ method: 'POST', url: '/api/network/certificate', payload: { signKey: newKey() }, ...more }),
      app.inject({ url: '/api/network/peers', ...more }),
      app.inject({ method: 'POST', url: '/api/network/report', payload: { uptimeS: 1 }, ...more }),
    ];
    const refused = async (app: FastifyInstance, more: object) => {
      for (const res of await Promise.all(routes(app, more))) {
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toEqual({ code: 'forbidden', message: "Only this machine's keeper may ask this.", reason: 'not_keeper' });
      }
    };
    const c = await company();
    await refused(c.app, { remoteAddress: '127.0.0.1' });
    await refused(c.app, { remoteAddress: '127.0.0.1', headers: { [VIA]: 'forged' } });
    /* The keeper's address alone says nothing, and the header from anywhere else is somebody's own words. */
    await refused(c.app, { remoteAddress: '203.0.113.9', headers: { [VIA]: 'keeper' } });
    const elsewhere = await company({ TUNNEL_HOST: 'keeper.invalid' });
    await refused(elsewhere.app, OWN);
    await refused(elsewhere.app, from('00000000-0000-4000-8000-000000000000'));
    expect(await c.db.select().from(authority)).toEqual([]);
  });

  it('hands the peer secrets to the machine that offers them', async () => {
    const c = await company();
    const before = (await c.peers()).json();
    expect(before).toEqual({ machine: null, authorityPem: null, revoked: [], crlPem: null, link: null, data: [], doors: [], uploads: [], leftSlots: [] });

    const tunnel = { serverAddr: 'relay.hornhoof.test', serverPort: 443, protocol: 'wss' };
    await saveLink(c.db, c.config, c.companyId, { name: 'acme', url: 'https://acme.hornhoof.test', key: 'k'.repeat(32), tunnel });
    const { machine, authorityPem } = (await c.certificate(newKey())).json() as { machine: string; authorityPem: string };
    const own = (await c.peers()).json() as { machine: string; authorityPem: string; crlPem: string; link: { name: string; appSecret: string; dataSecret?: string } };
    expect(own).toMatchObject({ machine, authorityPem, revoked: [], link: { name: 'acme' } });
    expect(own.link.appSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(own.link.dataSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(own.link.dataSecret).not.toBe(own.link.appSecret);
    expect(revokedIn(own.crlPem)).toEqual([]);
    expect(((await c.peers()).json() as typeof own).link).toEqual(own.link);
    expect(await c.db.select().from(peerSecrets)).toHaveLength(2);

    /* What a worker gets of the link is in network-join.test.ts: it needs the relay's visitor key. */
    expect((await c.peers(from('00000000-0000-4000-8000-000000000000'))).json().error.reason).toBe('not_a_machine');
  });

  it('lists the revoked certificates that have not expired, and signs the list while it leads', async () => {
    const c = await company();
    const { machine } = (await c.certificate(newKey())).json() as { machine: string };
    const day = 86_400_000;
    await c.db.insert(certificates).values([
      { serial: 'bb02', machineId: machine, until: new Date(Date.now() + day), revokedAt: new Date() },
      { serial: 'aa01', machineId: machine, until: new Date(Date.now() + day), revokedAt: new Date() },
      { serial: 'cc03', machineId: machine, until: new Date(Date.now() - day), revokedAt: new Date() },
    ]);
    const said = (await c.peers()).json() as { revoked: string[]; crlPem: string };
    expect(said.revoked).toEqual(['aa01', 'bb02']);
    expect(revokedIn(said.crlPem).sort()).toEqual(['aa01', 'bb02']);
  });

  it('makes no secret and signs no list while it only reads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-network-routes-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeKeeperState(dir, { mode: 'lead', at: new Date().toISOString(), link: null });
    const c = await company({ HORNHOOF_KEEPER: 'on', HORNHOOF_CONTROL_DIR: dir });
    await until(() => c.app.ctx.mode.current() === 'lead');
    const tunnel = { serverAddr: 'relay.hornhoof.test', serverPort: 443, protocol: 'wss' };
    await saveLink(c.db, c.config, c.companyId, { name: 'acme', url: 'https://acme.hornhoof.test', key: 'k'.repeat(32), tunnel });
    await c.certificate(newKey());
    writeKeeperState(dir, { mode: 'read', at: new Date().toISOString(), link: null });
    await c.app.ctx.mode.check();
    const said = (await c.peers()).json() as { machine: string | null; link: unknown; crlPem: unknown };
    expect(said.machine).not.toBeNull();
    expect(said).toMatchObject({ link: null, crlPem: null });
    expect(await c.db.select().from(peerSecrets)).toEqual([]);
  });

  it("stores the machine's measures", async () => {
    const c = await company();
    const report = (payload: object, who: object = OWN) => c.app.inject({ method: 'POST', url: '/api/network/report', payload, ...who });
    /* Before the machine has a row there is nowhere to keep them. */
    expect((await report({ uptimeS: 5 })).statusCode).toBe(204);
    expect(await c.serverRows()).toEqual([]);
    await c.certificate(newKey());
    const full = { uptimeS: 3600, fsyncP99Ms: 4.5, diskFree: 123_456_789_012, commit: 'c0ffee', webPort: 8080, peerPort: 8180 };
    expect((await report(full)).statusCode).toBe(204);
    const [row] = await c.serverRows();
    expect(row).toMatchObject(full);
    expect(row!.reportAt).toBeInstanceOf(Date);
    /* A keeper that just started has not timed its disk yet: the row keeps what it last said, so a machine does not
       read as never measured after each restart. */
    expect((await report({ fsyncP99Ms: null })).statusCode).toBe(204);
    expect((await c.serverRows())[0]).toMatchObject(full);
    for (const bad of [{ diskFree: -1 }, { webPort: 0 }, { peerPort: 70_000 }, { commit: 'x'.repeat(65) }, { uptimeS: 1.5 }]) expect((await report(bad)).statusCode, JSON.stringify(bad)).toBe(400);

    const worker = await c.joined('worker', newKey());
    expect((await report({ uptimeS: 7 }, from(worker.id))).statusCode).toBe(204);
    expect((await c.db.select().from(machines).where(eq(machines.id, worker.id)))[0]!.uptimeS).toBe(7);
    expect((await report({ uptimeS: 7 }, from('00000000-0000-4000-8000-000000000000'))).statusCode).toBe(404);
  });

  it('names the doors its app wants, and what reaches the copies through the relay', async () => {
    const c = await company();
    await c.certificate(newKey());
    type Own = { doors?: string[]; link: { visitorKey?: string } | null };
    expect(((await c.peers()).json() as Own).doors).toEqual([]);
    c.app.ctx.doorsWanted = async () => ['f'.repeat(64)];
    expect(((await c.peers()).json() as Own).doors).toEqual(['f'.repeat(64)]);
    /* Only the machine's own keeper opens doors: a peer hears of none. */
    const worker = await c.joined('worker', newKey());
    expect((await c.peers(from(worker.id))).json()).not.toHaveProperty('doors');
  });

  it("keeps the copy's report", async () => {
    const c = await company();
    const copy = await c.joined('data', newKey());
    const worker = await c.joined('worker', newKey());
    const report = (payload: object, machine: string) => c.app.inject({ method: 'POST', url: '/api/network/report', payload, ...from(machine) });
    const rowOf = async (id: string) => (await c.db.select().from(machines).where(eq(machines.id, id)))[0]!;
    const said = { state: 'making', progress: 40, error: null, at: null, name: 'copy_0f0f0f0f0f0f0f0f_2', old: null };
    expect((await report({ copy: said }, copy.id)).statusCode).toBe(204);
    expect(await rowOf(copy.id)).toMatchObject({ copyState: 'making', copyProgress: 40, copyError: null, copyAt: null, copyName: 'copy_0f0f0f0f0f0f0f0f_2', copyOld: null });
    const ready = { state: 'ready', progress: null, error: null, at: '2026-11-11T12:00:00.000Z', name: 'copy_0f0f0f0f0f0f0f0f_2', old: { attempt: 1 } };
    expect((await report({ copy: ready }, copy.id)).statusCode).toBe(204);
    expect(await rowOf(copy.id)).toMatchObject({ copyState: 'ready', copyProgress: null, copyAt: new Date('2026-11-11T12:00:00.000Z'), copyOld: 1 });
    /* A machine that led says which term's database waits there, while it saves it and while its copy is made again. */
    const saving = { state: 'saving', progress: null, error: null, at: null, name: 'copy_0f0f0f0f0f0f0f0f_2', old: { attempt: 2, led: 7 } };
    expect((await report({ copy: saving }, copy.id)).statusCode).toBe(204);
    expect(await rowOf(copy.id)).toMatchObject({ copyState: 'saving', copyOld: 2, copyOldLed: 7 });
    expect((await report({ copy: { ...saving, state: 'remaking', progress: 5, name: 'copy_0f0f0f0f0f0f0f0f_3' } }, copy.id)).statusCode).toBe(204);
    expect(await rowOf(copy.id)).toMatchObject({ copyState: 'remaking', copyOld: 2, copyOldLed: 7 });
    expect((await report({ copy: ready }, copy.id)).statusCode).toBe(204);
    expect(await rowOf(copy.id)).toMatchObject({ copyState: 'ready', copyOld: 1, copyOldLed: null });
    expect((await report({ copy: { ...ready, old: null } }, copy.id)).statusCode).toBe(204);
    expect(await rowOf(copy.id)).toMatchObject({ copyOld: null, copyOldLed: null });
    expect((await report({ copy: ready }, copy.id)).statusCode).toBe(204);
    /* A report that says nothing of the copy keeps what the row has. */
    expect((await report({ uptimeS: 3 }, copy.id)).statusCode).toBe(204);
    expect(await rowOf(copy.id)).toMatchObject({ copyState: 'ready', copyName: 'copy_0f0f0f0f0f0f0f0f_2' });
    /* A worker holds no copy, whatever it says. */
    expect((await report({ copy: said }, worker.id)).statusCode).toBe(204);
    expect(await rowOf(worker.id)).toMatchObject({ copyState: null, copyProgress: null, copyName: null });
    for (const bad of [{ ...said, progress: 100 }, { ...said, state: 'other' }, { ...said, error: 'other' }, { ...said, name: 'x'.repeat(64) }, { ...said, old: { attempt: 0 } }]) {
      expect((await report({ copy: bad }, copy.id)).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it('reports replica count and measured bytes only for machines that hold a copy', async () => {
    const c = await company();
    await c.db.update(companies).set({ name: 'Example Company' }).where(eq(companies.id, c.companyId));
    await c.certificate(newKey());
    const replica = await c.joined('data', newKey(), { networkId: '1'.repeat(32) });
    const worker = await c.joined('worker', newKey(), { networkId: '2'.repeat(32) });
    const copy = { state: 'ready', progress: null, error: null, at: null, name: 'copy_1111111111111111_1', old: null };
    const report = (machine: string, payload: object) => c.app.inject({ method: 'POST', url: '/api/network/report', payload, ...from(machine) });
    const listed = async () => (await c.app.inject({ url: '/api/machines', ...as(c.ceo) })).json() as {
      builtin: { replicas?: unknown }; machines: { id: string; replicas?: unknown }[];
    };
    expect((await report(replica.id, { copy, replicaBytes: 4096 })).statusCode).toBe(204);
    expect((await report(worker.id, { copy, replicaBytes: 8192 })).statusCode).toBe(204);
    const view = await listed();
    const empty = { count: 0, bytes: 0, companies: [] };
    expect(view.builtin.replicas).toEqual(empty);
    expect(view.machines.find(row => row.id === replica.id)?.replicas).toEqual({
      count: 1, bytes: 4096, companies: [{ name: 'Example Company', bytes: 4096 }],
    });
    expect(view.machines.find(row => row.id === worker.id)?.replicas).toEqual(empty);

    await c.db.update(machines).set({ role: 'worker', uploadState: 'kept' }).where(eq(machines.id, replica.id));
    expect((await listed()).machines.find(row => row.id === replica.id)?.replicas).toMatchObject({ count: 1, bytes: 4096 });
    expect((await report(replica.id, { wiped: true })).statusCode).toBe(204);
    expect((await listed()).machines.find(row => row.id === replica.id)?.replicas).toEqual(empty);
  });

  it("hands its own keeper the leader's slots of broken-off tables that a copy named in its last report, while that report is fresh", async () => {
    const c = await company();
    const copy = await c.joined('data', newKey());
    const other = await c.joined('data', newKey());
    const worker = await c.joined('worker', newKey());
    const report = (payload: object, machine: string) => c.app.inject({ method: 'POST', url: '/api/network/report', payload, ...from(machine) });
    const leftSlots = async () => ((await c.peers()).json() as { leftSlots?: string[] }).leftSlots;
    const making = { state: 'making', progress: 40, error: null, at: null, name: 'copy_0f0f0f0f0f0f0f0f_2', old: null };
    const [one, two, three] = ['pg_16500_sync_16384_7300000000000000000', 'pg_16500_sync_16390_7300000000000000000', 'pg_16611_sync_16384_7311111111111111111'];
    let now = Date.parse('2026-11-16T20:00:00Z');
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    onTestFinished(() => clock.mockRestore());
    expect(await leftSlots()).toEqual([]);
    expect((await report({ copy: { ...making, left: [one, two] } }, copy.id)).statusCode).toBe(204);
    expect((await report({ copy: { ...making, name: 'copy_1e1e1e1e1e1e1e1e_1', left: [three] } }, other.id)).statusCode).toBe(204);
    /* A worker holds no copy, whatever it says. */
    expect((await report({ copy: { ...making, left: ['pg_1_sync_2_3'] } }, worker.id)).statusCode).toBe(204);
    expect(await leftSlots()).toEqual([one, two, three]);
    /* Only the leader's own keeper sweeps slots: a peer hears of none. */
    expect((await c.peers(from(copy.id))).json()).not.toHaveProperty('leftSlots');
    /* The next report says what is left now, and a report that says nothing of the copy keeps it. */
    expect((await report({ copy: { ...making, left: [two] } }, copy.id)).statusCode).toBe(204);
    expect((await report({ uptimeS: 3 }, copy.id)).statusCode).toBe(204);
    expect(await leftSlots()).toEqual([two, three]);
    expect((await report({ copy: making }, other.id)).statusCode).toBe(204);
    expect(await leftSlots()).toEqual([two]);
    /* A copy that stopped reporting may have started those tables again by now: its names go stale. */
    now += LEFT_SLOTS_FRESH_MS + 1;
    expect(await leftSlots()).toEqual([]);
    for (const bad of [['copy_0f0f0f0f0f0f0f0f_2'], ['pg_16500_sync_16384'], ["pg_1_sync_2_3'; DROP"], Array.from({ length: 201 }, (_, i) => `pg_1_sync_${i}_3`)]) {
      expect((await report({ copy: { ...making, left: bad } }, copy.id)).statusCode, bad[0]).toBe(400);
    }
  });

  it('stores the network measures', async () => {
    const c = await company();
    const worker = await c.joined('worker', newKey());
    const report = (payload: object) => c.app.inject({ method: 'POST', url: '/api/network/report', payload, ...from(worker.id) });
    const rowOf = async () => (await c.db.select().from(machines).where(eq(machines.id, worker.id)))[0]!;
    expect((await report({ linkRttMs: 12, internetRttMs: 48, internetMbps: 84 })).statusCode).toBe(204);
    expect(await rowOf()).toMatchObject({ linkRttMs: 12, internetRttMs: 48, internetMbps: 84 });
    /* A report that says none of them keeps what the row has, and one of them leaves the others. */
    expect((await report({ uptimeS: 3 })).statusCode).toBe(204);
    expect((await report({ internetRttMs: 50 })).statusCode).toBe(204);
    expect(await rowOf()).toMatchObject({ linkRttMs: 12, internetRttMs: 50, internetMbps: 84 });
    /* How fast the leader sends to a machine is the leader's to say, never the machine's own. */
    expect((await report({ linkMbps: 900 })).statusCode).toBe(204);
    expect((await rowOf()).linkMbps).toBeNull();
    for (const bad of [{ linkRttMs: 600_001 }, { internetRttMs: -1 }, { internetMbps: 1.5 }, { linkRttMs: null }]) expect((await report(bad)).statusCode, JSON.stringify(bad)).toBe(400);
  });

  it('names who must upload', async () => {
    const c = await company();
    await c.certificate(newKey());
    type Own = { uploads?: { machine: string; networkId: string; max: number; unpackMax: number }[] };
    expect(((await c.peers()).json() as Own).uploads).toEqual([]);
    const nid = 'ab'.repeat(32);
    const left = await c.joined('worker', newKey(), { networkId: nid, uploadState: 'waiting', dataLeftAt: new Date() });
    /* One the leader already has, one that left the network, and one of no network id owe nothing here. */
    await c.joined('worker', newKey(), { networkId: 'cd'.repeat(32), uploadState: 'received' });
    await c.joined('worker', newKey(), { networkId: 'ef'.repeat(32), uploadState: 'waiting', revokedAt: new Date() });
    await c.joined('worker', newKey(), { uploadState: 'waiting' });
    const [{ size }] = (await c.db.execute(sql`SELECT pg_database_size(current_database())::float8 AS size`) as unknown as { rows: { size: number }[] }).rows as [{ size: number }];
    const { uploads } = (await c.peers()).json() as Own;
    expect(uploads).toEqual([{ machine: left.id, networkId: nid, max: 3 * size + UPLOAD_SPARE, unpackMax: 4 * size + UPLOAD_SPARE }]);
    /* Only the leader's own keeper takes uploads: a peer hears of none. */
    expect((await c.peers(from(left.id))).json()).not.toHaveProperty('uploads');
  });

  it('forgets the copy when a machine is wiped', async () => {
    const c = await company();
    const report = (payload: object, machine: string) => c.app.inject({ method: 'POST', url: '/api/network/report', payload, ...from(machine) });
    const rowOf = async (id: string) => (await c.db.select().from(machines).where(eq(machines.id, id)))[0]!;
    const held = { copyState: 'ready', copyName: 'copy_0f0f0f0f0f0f0f0f_7', copyAt: new Date(), copyOld: 6 } as const;
    const left = await c.joined('worker', newKey(), { uploadState: 'kept', dataLeftAt: new Date(), ...held });
    /* A report that says nothing of it keeps what the row has. */
    expect((await report({ uptimeS: 3 }, left.id)).statusCode).toBe(204);
    expect(await rowOf(left.id)).toMatchObject({ uploadState: 'kept', copyName: held.copyName });
    /* A merge of an old copy of its: one the leader read, and one it never got to. */
    await c.db.execute(sql`INSERT INTO net.merges (source, label, status, machine, merged_at, done_at) VALUES (${`machine:${left.id}:5`}, 'an old copy', 'done', ${left.id}, now(), now()), (${`machine:${left.id}:6`}, 'an old copy', 'pending', ${left.id}, NULL, NULL)`);
    expect((await report({ wiped: true }, left.id)).statusCode).toBe(204);
    /* The name stays: the next copy on this machine starts at the attempt above it, so no name is used twice. */
    expect(await rowOf(left.id)).toMatchObject({ uploadState: null, copyState: null, copyProgress: null, copyError: null, copyAt: null, copyName: held.copyName, copyOld: null });
    /* The merges of its old copies give their names up, should a keeper ever count from 1 again, and one that was
       never read is ended: that database is gone. */
    const merges = (await c.db.execute(sql`SELECT source, status, error FROM net.merges WHERE machine = ${left.id} ORDER BY source`) as unknown as { rows: { source: string; status: string; error: string | null }[] }).rows;
    expect(merges.map(merge => merge.status)).toEqual(['done', 'done']);
    for (const merge of merges) expect(merge.source).toMatch(new RegExp(`^machine:${left.id}:[56]:wiped:[0-9a-f-]{36}$`));
    expect(merges[1]!.error).toBe('The machine was wiped before its old copy was read.');
    /* A machine that holds the data again is not one that left, whatever an old keeper says. */
    const copy = await c.joined('data', newKey(), held);
    expect((await report({ wiped: true }, copy.id)).statusCode).toBe(204);
    expect(await rowOf(copy.id)).toMatchObject({ copyState: 'ready', copyName: held.copyName, copyOld: 6 });
    expect((await report({ wiped: false }, left.id)).statusCode).toBe(400);
    /* It holds the data again and could not be set up: what it says of that names no copy, and the row keeps the name
       of the last one, above which the next begins. */
    const again = await c.joined('data', newKey(), { copyName: held.copyName });
    expect((await report({ copy: { state: 'stopped', progress: null, error: 'setup', at: null, name: null, old: null } }, again.id)).statusCode).toBe(204);
    expect(await rowOf(again.id)).toMatchObject({ copyState: 'stopped', copyError: 'setup', copyName: held.copyName });
  });

  it('stores memory and cores', async () => {
    const c = await company();
    const worker = await c.joined('worker', newKey());
    const report = (payload: object) => c.app.inject({ method: 'POST', url: '/api/network/report', payload, ...from(worker.id) });
    const rowOf = async () => (await c.db.select().from(machines).where(eq(machines.id, worker.id)))[0]!;
    expect((await report({ memory: 8 * 2 ** 30, cores: 10 })).statusCode).toBe(204);
    expect(await rowOf()).toMatchObject({ memory: 8 * 2 ** 30, cores: 10 });
    /* A report of a keeper from before says neither, and the row keeps both. */
    expect((await report({ uptimeS: 3 })).statusCode).toBe(204);
    expect(await rowOf()).toMatchObject({ memory: 8 * 2 ** 30, cores: 10 });
    for (const bad of [{ cores: 0 }, { cores: 4097 }, { cores: 1.5 }, { memory: -1 }, { memory: 1.5 }]) expect((await report(bad)).statusCode, JSON.stringify(bad)).toBe(400);
  });

  it("keeps the print of the owner's key a machine pinned", async () => {
    const c = await company();
    const worker = await c.joined('worker', newKey());
    const report = (payload: object) => c.app.inject({ method: 'POST', url: '/api/network/report', payload, ...from(worker.id) });
    const pinOf = async () => (await c.db.select().from(machines).where(eq(machines.id, worker.id)))[0]!.ownerPin;
    const pin = 'P'.repeat(43);
    expect((await report({ pin })).statusCode).toBe(204);
    expect(await pinOf()).toBe(pin);
    /* A report that says nothing of it keeps it, and one that says there is none clears it. */
    expect((await report({ uptimeS: 3 })).statusCode).toBe(204);
    expect(await pinOf()).toBe(pin);
    expect((await report({ pin: null })).statusCode).toBe(204);
    expect(await pinOf()).toBeNull();
    for (const bad of ['P'.repeat(42), 'P'.repeat(44), `${'P'.repeat(42)}$`]) expect((await report({ pin: bad })).statusCode, bad).toBe(400);
  });

  it("takes the system a machine's keeper names, and keeps what the row said when it names none", async () => {
    const c = await company();
    const worker = await c.joined('worker', newKey());
    await c.db.update(machines).set({ os: 'darwin' }).where(eq(machines.id, worker.id));
    const report = (payload: object) => c.app.inject({ method: 'POST', url: '/api/network/report', payload, ...from(worker.id) });
    const osOf = async () => (await c.db.select().from(machines).where(eq(machines.id, worker.id)))[0]!.os;
    expect((await report({ uptimeS: 3 })).statusCode).toBe(204);
    expect(await osOf()).toBe('darwin');
    expect((await report({ os: 'linux' })).statusCode).toBe(204);
    expect(await osOf()).toBe('linux');
    for (const bad of ['windows', '', null]) expect((await report({ os: bad })).statusCode, String(bad)).toBe(400);
  });

  it('answers that the server has no machine id when it has none', async () => {
    const c = await company({ HORNHOOF_MACHINE_ID: '' });
    const res = await c.certificate(newKey());
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ reason: 'no_machine_id', message: 'This server has no machine id. Run the install command again.' });
  });

  it('tells a former leader how far the server applied its log, and surfaces why saving waits', async () => {
    const c = await company();
    const leader = await thisMachine(c.db, c.config, c.companyId);
    const former = await c.joined('data', newKey(), { networkId: 'b0'.repeat(32), serverOrder: 2 });
    const third = await c.joined('data', newKey(), { networkId: 'c0'.repeat(32), serverOrder: 3 });
    await c.db.execute(sql`INSERT INTO net.handovers (id, from_machine_id, term_number, term_machine, applied, to_machine_id, at, kind)
      VALUES (gen_random_uuid(), ${former.id}, 7, ${'b0'.repeat(16)}, '0/4500120', ${leader.id}, '2026-11-24T01:08:00.000Z'::timestamptz, 'takeover'),
             (gen_random_uuid(), ${former.id}, 8, ${'b0'.repeat(16)}, '0/9999999', ${third.id}, '2026-11-24T01:12:00.000Z'::timestamptz, 'takeover')`);
    expect((await c.peers(from(former.id))).json().copy).toMatchObject({ applied: { term: 7, lsn: '0/4500120' } });
    const report = (payload: object) => c.app.inject({ method: 'POST', url: '/api/network/report', payload, ...from(former.id) });
    const saving = {
      state: 'saving', progress: null, error: null, at: null, name: 'copy_b0b0b0b0b0b0b0b0_1', old: null,
      saving: { waiting: 'retry', since: '2026-11-24T01:09:00.000Z' },
    };
    expect((await report({ copy: saving })).statusCode).toBe(204);
    expect((await dataViews(c.app.ctx, new Date())).get(former.id)?.copy).toEqual({
      line: 'saving', waiting: 'retry', since: '2026-11-24T01:09:00.000Z',
    });
    expect((await report({ copy: { ...saving, state: 'remaking', progress: 5, saving: undefined } })).statusCode).toBe(204);
    expect((await dataViews(c.app.ctx, new Date())).get(former.id)?.copy).toEqual({ line: 'remaking', progress: 5 });
    expect((await report({ copy: { ...saving, saving: undefined } })).statusCode).toBe(204);
    expect((await dataViews(c.app.ctx, new Date())).get(former.id)?.copy).toEqual({ line: 'saving' });
    /* A restore from an older backup than the handover means the leader may no longer hold everything up to applied. */
    await c.db.execute(sql`INSERT INTO net.restores (attempt, backup, dumped_at, kept) VALUES (gen_random_uuid(), gen_random_uuid(), '2026-11-24T01:00:00.000Z'::timestamptz, 'hornhoof_before_20261124_010000')`);
    expect((await c.peers(from(former.id))).json().copy.applied).toBeNull();
  });
});
