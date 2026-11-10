import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as x509 from '@peculiar/x509';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { authority, certificates, companies, machines, peerSecrets, people } from '../src/db/schema.js';
import { writeKeeperState } from '../src/modules/keeper/state.js';
import { saveLink } from '../src/modules/link/link.js';
import { certFacts, issuedBy } from '../src/modules/network/authority.js';
import { as, setUpCompany, testApp, until } from './helpers.js';

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
    const [computer] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.ownerId, machineKey: 'mac-0001-abcd', hostname: 'ivan-mac' }).returning();
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
    expect(before).toEqual({ machine: null, authorityPem: null, revoked: [], crlPem: null, link: null, data: [] });

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
    expect((await report({ fsyncP99Ms: null })).statusCode).toBe(204);
    expect((await c.serverRows())[0]).toMatchObject({ ...full, fsyncP99Ms: null });
    for (const bad of [{ diskFree: -1 }, { webPort: 0 }, { peerPort: 70_000 }, { commit: 'x'.repeat(65) }, { uptimeS: 1.5 }]) expect((await report(bad)).statusCode, JSON.stringify(bad)).toBe(400);

    const worker = await c.joined('worker', newKey());
    expect((await report({ uptimeS: 7 }, from(worker.id))).statusCode).toBe(204);
    expect((await c.db.select().from(machines).where(eq(machines.id, worker.id)))[0]!.uptimeS).toBe(7);
    expect((await report({ uptimeS: 7 }, from('00000000-0000-4000-8000-000000000000'))).statusCode).toBe(404);
  });

  it('answers that the server has no machine id when it has none', async () => {
    const c = await company({ HORNHOOF_MACHINE_ID: '' });
    const res = await c.certificate(newKey());
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ reason: 'no_machine_id', message: 'This server has no machine id. Run the install command again.' });
  });
});
