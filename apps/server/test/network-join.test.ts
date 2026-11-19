import { generateKeyPairSync, sign, verify, X509Certificate, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { decryptSecret } from '../src/crypto/secrets.js';
import { hashToken } from '../src/crypto/tokens.js';
import { certificates, companies, machineOnline, machines, machineTickets, nodeCodes, peerSecrets, people } from '../src/db/schema.js';
import { rank } from '../src/modules/copies/order.js';
import { writeKeeperState } from '../src/modules/keeper/state.js';
import { certFacts, issuedBy } from '../src/modules/network/authority.js';
import { companyFolder, issueTicket, onlineShare, renewedMessage, renewMessage, visitorKeyOf, workerView, type WorkerView } from '../src/modules/network/join.js';
import { joinMessage } from '../src/modules/network/join-proof.js';
import { peerSecret } from '../src/modules/network/store.js';
import { fakeRelay } from './fake-relay.js';
import { as, invitePerson, setUpCompany, testApp, TEST_SECRET, until } from './helpers.js';

/* The computer the server itself runs on, as install.sh names it: the server's ids are the hash of that key. */
const HOST_KEY = 'host-0000-abcd';
const hostIdOf = (machineKey: string) => hashToken(`hornhoof-host:${machineKey}`);
const HOST_ID = hostIdOf(HOST_KEY);
const MAC = { machineId: 'mac-0001-abcd', hostname: 'dev-mac', os: 'darwin', arch: 'arm64' };
const LAPTOP = { machineId: 'laptop-0002-abcd', hostname: 'dev-laptop', os: 'linux', arch: 'x86_64' };
const NOBODY = '00000000-0000-4000-8000-000000000000';
const TICKET = /^[A-Za-z0-9_-]{43}$/;
const NODE_LINE = /^[0-9a-f-]{36} machine [A-Za-z0-9_-]{43}$/;

const VIA = 'x-hornhoof-via';
const MARK = 'x-hornhoof-keeper';
/* The keeper's own request, and a worker's keeper's as the peer door passes it on. */
const OWN = { remoteAddress: '127.0.0.1', headers: { [VIA]: 'keeper' } };
const keeperOf = (machine: string) => ({ remoteAddress: '127.0.0.1', headers: { [VIA]: machine, [MARK]: '1' } });
/* What the keeper marks a visitor's request with when it came over the link. */
const OVER_HTTPS = { remoteAddress: '127.0.0.1', headers: { 'x-forwarded-proto': 'https' } };

type Keys = { pem: string; privateKey: KeyObject };
function newKeys(): Keys {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey };
}

const codeOf = (command: string) => command.split('--join ')[1]!;
const errorOf = (res: { json: () => { error: { reason?: string } } }) => res.json().error.reason;

type Joined = { machine: string; role: string; certPem: string; authorityPem: string; until: string; view: WorkerView };
type Worker = { machine: string; keys: Keys; serial: string; authorityPem: string; view: WorkerView };

async function company(env: NodeJS.ProcessEnv = {}) {
  const relay = await fakeRelay();
  const control = mkdtempSync(joinPath(tmpdir(), 'hh-network-join-'));
  onTestFinished(() => rmSync(control, { recursive: true, force: true }));
  /* An app that goes by its keeper's word starts once the keeper says it leads. */
  if (env.HORNHOOF_KEEPER === 'on') writeKeeperState(control, { mode: 'lead', at: new Date().toISOString(), link: null });
  const { app, db, config } = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: HOST_ID, HORNHOOF_HOST_ID: HOST_ID, RELAY_URL: relay.url, HORNHOOF_CONTROL_DIR: control, ...env });
  await app.ready();
  await until(() => app.ctx.mode.current() === 'lead');
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const command = async (token = ceo) => codeOf((await app.inject({ method: 'POST', url: '/api/machines/command', ...as(token) })).json().command);
  const join = (code: string, extra: object = {}, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, ...MAC, ...extra }, headers });
  /* A computer joined by the new installer: its row and the ticket for its core. */
  const cored = async (computer: object = {}, token = ceo) => {
    const said = (await join(await command(token), { core: true, ...computer })).json() as { machine: { id: string }; core: { ticket: string } };
    return { machine: said.machine.id, ticket: said.core.ticket };
  };
  const redeem = (ticket: string, machineKey: string, keys: Keys, networkId = hostIdOf(machineKey), more: object = {}) => {
    const signature = sign(null, Buffer.from(joinMessage(ticket, networkId)), keys.privateKey).toString('base64');
    return app.inject({ method: 'POST', url: '/api/network/join', payload: { ticket, networkId, signKey: keys.pem, signature }, ...more });
  };
  /* A worker: the computer joined, and its keeper redeemed the ticket with a key of its own. */
  const worker = async (computer: typeof MAC = MAC, token = ceo): Promise<Worker> => {
    const { ticket } = await cored(computer, token);
    const keys = newKeys();
    const said = (await redeem(ticket, computer.machineId, keys)).json() as Joined;
    return { machine: said.machine, keys, serial: certFacts(said.certPem).serial, authorityPem: said.authorityPem, view: said.view };
  };
  /* Each renewal is of a later moment than the one before. */
  let moment = 0;
  const renew = (w: Worker, over: { at?: string; serial?: string; key?: KeyObject; machine?: string } = {}, more: object = {}) => {
    const at = over.at ?? new Date(Date.now() + ++moment).toISOString();
    const serial = over.serial ?? w.serial;
    const signature = sign(null, Buffer.from(renewMessage(w.machine, serial, at)), over.key ?? w.keys.privateKey).toString('base64');
    return app.inject({ method: 'POST', url: '/api/network/renew', payload: { machine: over.machine ?? w.machine, serial, at, signature }, ...more });
  };
  const serverCertificate = () => app.inject({ method: 'POST', url: '/api/network/certificate', payload: { signKey: newKeys().pem }, ...OWN });
  const peers = (who: object = OWN) => app.inject({ url: '/api/network/peers', ...who });
  const report = (payload: object, who: object = OWN) => app.inject({ method: 'POST', url: '/api/network/report', payload, ...who });
  const link = async (name = 'acme') => expect((await app.inject({ method: 'PUT', url: '/api/link', payload: { name }, ...as(ceo) })).statusCode).toBe(200);
  const disconnect = (machine: string, token = ceo) => app.inject({ method: 'POST', url: `/api/machines/${machine}/disconnect`, ...as(token) });
  const rowOf = async (machine: string) => (await db.select().from(machines).where(eq(machines.id, machine)))[0]!;
  const visitorKeyCalls = () => relay.calls.filter(call => call.endsWith('/visitor-key')).length;
  return { app, db, config, relay, control, ceo, companyId: acme!.id, command, join, cored, redeem, worker, renew, serverCertificate, peers, report, link, disconnect, rowOf, visitorKeyCalls };
}

const authorityKey = (authorityPem: string) => new X509Certificate(authorityPem).publicKey;
/* Whether the company's authority signed this answer to that renewal. */
function signedBy(authorityPem: string, ask: { machine: string; serial: string; at: string }, answer: { payload: string; signature: string }): boolean {
  return verify(null, Buffer.from(renewedMessage(ask.machine, ask.serial, ask.at, answer.payload)), authorityKey(authorityPem), Buffer.from(answer.signature, 'base64'));
}

describe('joining the company as a machine', () => {
  it('answers a new installer with the core and a ticket', async () => {
    const c = await company();
    const res = await c.join(await c.command(), { core: true }, { accept: 'text/plain' });
    expect(res.statusCode).toBe(200);
    const lines = res.body.trim().split('\n');
    expect(lines).toHaveLength(2);
    const [word, folder, ticket, port, companyId] = lines[0]!.split(' ');
    expect([word, port, companyId]).toEqual(['core', '8080', c.companyId]);
    expect(folder).toMatch(/^hornhoof-[a-z]{6}$/);
    expect(folder).toBe(companyFolder(null, c.companyId));
    expect(ticket).toMatch(TICKET);
    expect(lines[1]).toMatch(NODE_LINE);
    const [row] = await c.db.select().from(machineTickets);
    expect(row).toMatchObject({ ticketHash: hashToken(ticket!), usedAt: null });
    expect(JSON.stringify(row)).not.toContain(ticket);
    const hours = (row!.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);

    /* The folder is named after the link once the company has one, and the port is the one the server's keeper reported. */
    await c.link('acme');
    await c.serverCertificate();
    expect((await c.report({ webPort: 18080 })).statusCode).toBe(204);
    const asJson = (await c.join(await c.command(), { core: true, ...LAPTOP })).json() as { core: object; nodes: unknown[] };
    expect(asJson.core).toEqual({ folder: 'hornhoof-acme', ticket: expect.stringMatching(TICKET), port: 18080, company: c.companyId });
    expect(asJson.nodes).toHaveLength(1);

    /* An installer that asks for no core gets the answer it always got. */
    const plain = await c.join(await c.command(), { machineId: 'tower-0003-abcd', hostname: 'tower' }, { accept: 'text/plain' });
    expect(plain.body.trim()).toMatch(NODE_LINE);
    expect(await c.db.select().from(machineTickets)).toHaveLength(2);
  });

  it("tells the server's own computer by its host id", async () => {
    const c = await company();
    const res = await c.join(await c.command(), { core: true, machineId: HOST_KEY }, { accept: 'text/plain' });
    const lines = res.body.trim().split('\n');
    expect(lines[0]).toBe('core-here 8080');
    expect(lines[1]).toMatch(NODE_LINE);
    expect(await c.db.select().from(machineTickets)).toEqual([]);

    /* A server that got its id by hand has no host id, and its machine id says the same. */
    const byHand = await company({ HORNHOOF_HOST_ID: '' });
    expect(((await byHand.join(await byHand.command(), { core: true, machineId: HOST_KEY })).json() as { core: object }).core).toEqual({ here: true, port: 8080 });
    expect(await byHand.db.select().from(machineTickets)).toEqual([]);
  });

  it('requires a signature for the ticket, computer and public key', async () => {
    const c = await company();
    const { machine, ticket } = await c.cored();
    const keys = newKeys();
    const networkId = hostIdOf(MAC.machineId);
    const payload = { ticket, networkId, signKey: keys.pem };
    const ask = (signature?: string) => c.app.inject({ method: 'POST', url: '/api/network/join', payload: { ...payload, signature } });

    expect((await ask()).statusCode).toBe(400);
    const otherTicket = await issueTicket(c.db, machine);
    const proofs = [
      sign(null, Buffer.from(joinMessage(ticket, networkId)), newKeys().privateKey),
      sign(null, Buffer.from(joinMessage(otherTicket, networkId)), keys.privateKey),
      sign(null, Buffer.from(joinMessage(ticket, hostIdOf(LAPTOP.machineId))), keys.privateKey),
    ];
    for (const proof of proofs) expect(errorOf(await ask(proof.toString('base64')))).toBe('join_refused');
    expect(await c.rowOf(machine)).toMatchObject({ networkId: null, role: null, signKey: null });
    expect(await c.db.select().from(certificates).where(eq(certificates.machineId, machine))).toEqual([]);
    expect(await c.db.select().from(machineTickets).where(eq(machineTickets.ticketHash, hashToken(ticket)))).toMatchObject([{ usedAt: null }]);
    expect((await c.redeem(ticket, MAC.machineId, keys)).statusCode).toBe(200);
  });

  it('joins once with a ticket', async () => {
    const c = await company();
    await c.serverCertificate();
    const [server] = await c.db.select().from(machines).where(eq(machines.networkId, HOST_ID));
    const { machine, ticket } = await c.cored();
    const keys = newKeys();

    /* The ticket binds one computer: an id that is not that computer's is refused, and the ticket stays good. */
    const elsewhere = await c.redeem(ticket, MAC.machineId, keys, hostIdOf('another-0009-abcd'));
    expect(elsewhere.statusCode).toBe(409);
    expect(errorOf(elsewhere)).toBe('machine_taken');
    expect(await c.rowOf(machine)).toMatchObject({ networkId: null, role: null, signKey: null });
    expect(await c.db.select().from(certificates).where(eq(certificates.machineId, machine))).toEqual([]);

    const res = await c.redeem(ticket, MAC.machineId, keys);
    expect(res.statusCode).toBe(200);
    const said = res.json() as Joined;
    expect(said).toMatchObject({ machine, role: 'worker' });
    expect(certFacts(said.certPem)).toMatchObject({ machineId: machine, role: 'worker' });
    expect(issuedBy(said.authorityPem, said.certPem)).toBe(true);
    expect(new Date(said.until).getTime()).toBe(new X509Certificate(said.certPem).validToDate.getTime());
    expect(said.view).toMatchObject({ machine, role: 'worker', authorityPem: said.authorityPem, revoked: [] });
    expect(said.view.data).toEqual([{ machine: server!.id, networkId: HOST_ID, hostname: null, addresses: [], peerPort: null, webPort: null, number: null, copyName: null }]);
    expect(await c.rowOf(machine)).toMatchObject({ networkId: hostIdOf(MAC.machineId), role: 'worker', signKey: keys.pem });
    const first = certFacts(said.certPem).serial;
    expect(await c.db.select().from(certificates).where(eq(certificates.machineId, machine))).toMatchObject([{ serial: first, revokedAt: null }]);

    /* A signed retry still gets a new-command prompt and leaves exactly one certificate. */
    const again = await c.redeem(ticket, MAC.machineId, keys);
    expect(again.statusCode).toBe(410);
    expect(again.json().error).toEqual({ code: 'gone', message: 'This join ticket was used or has expired. Run the command from Hornhoof again.', reason: 'ticket_used' });
    expect(errorOf(await c.redeem(ticket, MAC.machineId, newKeys()))).toBe('ticket_used');
    expect((await c.redeem('x'.repeat(43), MAC.machineId, keys)).statusCode).toBe(410);
    const expired = await issueTicket(c.db, machine, new Date(Date.now() - 25 * 3_600_000));
    expect(errorOf(await c.redeem(expired, MAC.machineId, keys))).toBe('ticket_used');
    expect(await c.db.select().from(certificates).where(eq(certificates.machineId, machine))).toHaveLength(1);
    expect((await c.rowOf(machine)).signKey).toBe(keys.pem);

    /* The same key again changes nothing that works; a new key, as after the core was installed anew, ends what the old
       key held. */
    const sameKey = await c.redeem(await issueTicket(c.db, machine), MAC.machineId, keys);
    expect(sameKey.statusCode).toBe(200);
    expect(await c.db.select().from(certificates).where(and(eq(certificates.machineId, machine), isNull(certificates.revokedAt)))).toHaveLength(2);
    const other = newKeys();
    const newKey = (await c.redeem(await issueTicket(c.db, machine), MAC.machineId, other)).json() as Joined;
    const live = await c.db.select().from(certificates).where(and(eq(certificates.machineId, machine), isNull(certificates.revokedAt)));
    expect(live.map(row => row.serial)).toEqual([certFacts(newKey.certPem).serial]);
    expect(newKey.view.revoked).toContain(first);
    expect((await c.rowOf(machine)).signKey).toBe(other.pem);
  });

  it('refuses a ticket of a disabled person, of a disconnected machine and of a computer another row holds', async () => {
    const c = await company();
    const maria = await invitePerson(c.app, c.ceo, { name: 'Maria', email: 'maria@acme.com', access: { whole: true } });
    const first = await c.worker();

    /* Two people on one computer share its core under the first one's row. */
    const second = await c.cored(MAC, maria);
    expect(second.machine).not.toBe(first.machine);
    const keys = newKeys();
    const taken = await c.redeem(second.ticket, MAC.machineId, keys);
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toMatchObject({ code: 'conflict', reason: 'machine_taken' });
    expect(await c.rowOf(second.machine)).toMatchObject({ networkId: null, role: null });
    expect((await c.disconnect(first.machine)).statusCode).toBe(204);
    expect((await c.redeem(second.ticket, MAC.machineId, keys)).statusCode).toBe(200);
    expect(await c.rowOf(second.machine)).toMatchObject({ networkId: hostIdOf(MAC.machineId), role: 'worker' });

    /* A ticket goes with its machine. */
    const laptop = await c.cored(LAPTOP);
    expect((await c.disconnect(laptop.machine)).statusCode).toBe(204);
    expect(errorOf(await c.redeem(laptop.ticket, LAPTOP.machineId, keys))).toBe('ticket_used');

    /* A person disabled between the command and the keeper's first start. */
    const tower = { ...LAPTOP, machineId: 'tower-0003-abcd', hostname: 'tower' };
    const theirs = await c.cored(tower, maria);
    await c.db.update(people).set({ status: 'disabled' }).where(eq(people.email, 'maria@acme.com'));
    const refused = await c.redeem(theirs.ticket, tower.machineId, keys);
    expect(refused.statusCode).toBe(410);
    expect(await c.db.select().from(machineTickets).where(and(eq(machineTickets.machineId, theirs.machine), isNull(machineTickets.usedAt)))).toHaveLength(1);
    expect(await c.rowOf(theirs.machine)).toMatchObject({ networkId: null, role: null });
  });

  it("renews only with the machine's key, once per moment", async () => {
    const c = await company();
    const w = await c.worker();
    const at = new Date().toISOString();
    const first = await c.renew(w, { at });
    expect(first.statusCode).toBe(200);
    const answer = first.json() as { payload: string; signature: string };
    expect(Object.keys(answer).sort()).toEqual(['payload', 'signature']);
    expect(signedBy(w.authorityPem, { machine: w.machine, serial: w.serial, at }, answer)).toBe(true);
    const body = JSON.parse(answer.payload) as { view: WorkerView; certPem: string | null };
    expect(body).toMatchObject({ machine: w.machine, serial: w.serial, at, role: 'worker', authorityPem: w.authorityPem, certPem: null, until: null });
    expect(body.view).toMatchObject({ machine: w.machine, role: 'worker', revoked: [] });

    /* The same moment counts once, and one before it never. */
    const twice = await c.renew(w, { at });
    expect(twice.statusCode).toBe(401);
    expect(twice.json().error).toEqual({ code: 'unauthorized', message: 'This renewal is not signed by the machine, or is too old.', reason: 'renew_refused' });
    expect(errorOf(await c.renew(w, { at: new Date(Date.parse(at) - 1).toISOString() }))).toBe('renew_refused');
    expect(errorOf(await c.renew(w, { at: new Date(Date.now() - 6 * 60_000).toISOString() }))).toBe('renew_refused');
    expect(errorOf(await c.renew(w, { at: new Date(Date.now() + 6 * 60_000).toISOString() }))).toBe('renew_refused');
    const stranger = await c.renew(w, { key: newKeys().privateKey });
    expect(stranger.statusCode).toBe(401);
    expect(errorOf(stranger)).toBe('renew_refused');
    expect((await c.rowOf(w.machine)).renewAt!.toISOString()).toBe(at);

    /* A certificate the server does not know, as one of a database restored from before it, gets a new one. */
    const lost = { serial: 'ab12' };
    const renewed = JSON.parse(((await c.renew(w, lost)).json() as { payload: string }).payload) as { certPem: string; until: string };
    expect(certFacts(renewed.certPem)).toMatchObject({ machineId: w.machine, role: 'worker' });
    expect(new Date(renewed.until).getTime()).toBe(new X509Certificate(renewed.certPem).validToDate.getTime());
    expect(await c.db.select().from(certificates).where(eq(certificates.machineId, w.machine))).toHaveLength(2);
    /* So does one that ends within its last weeks. */
    await c.db.update(certificates).set({ until: new Date(Date.now() + 10 * 86_400_000) }).where(eq(certificates.serial, w.serial));
    expect((JSON.parse(((await c.renew(w)).json() as { payload: string }).payload) as { certPem: string | null }).certPem).not.toBeNull();

    const unknown = await c.renew(w, { machine: NOBODY });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toMatchObject({ reason: 'not_a_machine' });

    expect((await c.disconnect(w.machine)).statusCode).toBe(204);
    const cutAt = new Date(Date.now() + 1000).toISOString();
    const cut = await c.renew(w, { at: cutAt });
    expect(cut.statusCode).toBe(410);
    const gone = cut.json() as { payload: string; signature: string };
    expect(gone.payload).toBe('{"disconnected":true}');
    expect(signedBy(w.authorityPem, { machine: w.machine, serial: w.serial, at: cutAt }, gone)).toBe(true);
    /* Nobody else learns that the machine was cut off. */
    expect((await c.renew(w, { key: newKeys().privateKey })).statusCode).toBe(404);
  });

  it('leaves the link out of a renewal over plain HTTP', async () => {
    const c = await company();
    await c.link('acme');
    const w = await c.worker();
    const viewOf = (res: { json: () => unknown }) => (JSON.parse((res.json() as { payload: string }).payload) as { view: WorkerView }).view;
    const plain = viewOf(await c.renew(w));
    expect(plain).not.toHaveProperty('link');
    expect(plain.machine).toBe(w.machine);
    const secure = viewOf(await c.renew(w, {}, OVER_HTTPS));
    expect(secure.link).toEqual({ name: 'acme', url: 'https://acme.hornhoof.test', serverAddr: 'hornhoof.test', serverPort: 443, appSecret: expect.stringMatching(TICKET), visitorKey: c.relay.visitorKeys.get('acme'), dataSecret: null, hidden: false });
    /* The header from any other address is somebody's own words. */
    expect(viewOf(await c.renew(w, {}, { remoteAddress: '203.0.113.9', headers: { 'x-forwarded-proto': 'https' } }))).not.toHaveProperty('link');

    /* The join's own answer goes by the same rule. */
    const overHttp = (await c.redeem(await issueTicket(c.db, w.machine), MAC.machineId, w.keys)).json() as Joined;
    expect(overHttp.view).not.toHaveProperty('link');
    const overHttps = (await c.redeem(await issueTicket(c.db, w.machine), MAC.machineId, w.keys, undefined, OVER_HTTPS)).json() as Joined;
    expect(overHttps.view.link).toEqual(secure.link);
  });

  it("takes a peer's request only from its keeper", async () => {
    const c = await company();
    const w = await c.worker();
    const routes = (who: object) => [
      c.app.inject({ method: 'POST', url: '/api/network/certificate', payload: { signKey: w.keys.pem }, ...who }),
      c.peers(who),
      c.report({ uptimeS: 9 }, who),
    ];
    const none = await Promise.all(routes({ remoteAddress: '127.0.0.1' }));
    /* What a neighbor of the worker, or a page on its localhost, sends through its front door. */
    const unmarked = await Promise.all(routes({ remoteAddress: '127.0.0.1', headers: { [VIA]: w.machine } }));
    for (const [i, res] of unmarked.entries()) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual(none[i]!.json());
      expect(errorOf(res)).toBe('not_keeper');
    }
    expect((await c.rowOf(w.machine)).uptimeS).toBeNull();
    expect(await c.db.select().from(certificates).where(eq(certificates.machineId, w.machine))).toHaveLength(1);

    expect((await Promise.all(routes(keeperOf(w.machine)))).map(res => res.statusCode)).toEqual([200, 200, 204]);
    expect((await c.rowOf(w.machine)).uptimeS).toBe(9);
    /* The mark from any other address is somebody's own words too. */
    for (const res of await Promise.all(routes({ ...keeperOf(w.machine), remoteAddress: '203.0.113.9' }))) expect(res.statusCode).toBe(403);
  });

  it('gives a worker its view and nothing of the data', async () => {
    const c = await company({ HORNHOOF_KEEPER: 'on' });
    await c.link('acme');
    await c.serverCertificate();
    expect((await c.report({ webPort: 8080, peerPort: 8180, hostname: 'debian', addresses: ['192.168.1.7'] })).statusCode).toBe(204);
    const w = await c.worker();
    const own = (await c.peers()).json() as { machine: string; link: { dataSecret: string; appSecret: string }; data: unknown[] };
    const res = await c.peers(keeperOf(w.machine));
    expect(res.statusCode).toBe(200);
    const said = res.json() as { machine: string; link: Record<string, unknown>; data: unknown[]; authorityPem: string; crlPem: string; revoked: string[] };
    expect(said).toMatchObject({ machine: w.machine, authorityPem: w.authorityPem, revoked: [] });
    expect(said.crlPem).toContain('BEGIN X509 CRL');
    expect(said.data).toEqual([{ machine: own.machine, networkId: HOST_ID, hostname: 'debian', addresses: ['192.168.1.7'], peerPort: 8180, webPort: 8080, number: null, copyName: null }]);
    expect(said.link).toEqual({ name: 'acme', url: 'https://acme.hornhoof.test', serverAddr: 'hornhoof.test', serverPort: 443, appSecret: own.link.appSecret, visitorKey: c.relay.visitorKeys.get('acme'), dataSecret: null, hidden: false });
    /* The data machine's own view keeps what it had, and lists the data machines too. */
    expect(Object.keys(own.link).sort()).toEqual(['appSecret', 'dataSecret', 'name']);
    expect(own.data).toEqual(said.data);
    for (const secret of [TEST_SECRET, c.relay.bindings.get('acme')!.key, own.link.dataSecret]) expect(res.body).not.toContain(secret);

    /* The visitor key is asked for once, and kept sealed. */
    expect(c.visitorKeyCalls()).toBe(1);
    const [kept] = await c.db.select().from(peerSecrets).where(eq(peerSecrets.kind, 'visit'));
    expect(kept!.secretEnc).not.toContain(c.relay.visitorKeys.get('acme'));
    expect(decryptSecret(kept!.secretEnc, c.config.secret)).toContain(c.relay.visitorKeys.get('acme'));

    /* A machine that does not lead makes no secret, so it says nothing of the link: a worker keeps the one it has. Null
       would say that the company has no link. */
    writeKeeperState(c.control, { mode: 'read', at: new Date().toISOString(), link: null });
    await c.app.ctx.mode.check();
    expect((await c.peers(keeperOf(w.machine))).json()).not.toHaveProperty('link');
    /* Nothing is handed out by a machine that does not lead. */
    const ticket = await issueTicket(c.db, w.machine);
    const waiting = await c.redeem(ticket, MAC.machineId, w.keys);
    expect(waiting.statusCode).toBe(503);
    expect((await c.renew(w, { serial: 'ab12' })).statusCode).toBe(503);
  });

  it("names each data machine's number and copy", async () => {
    const c = await company({ HORNHOOF_KEEPER: 'on' });
    await c.link('acme');
    await c.serverCertificate();
    const w = await c.worker();
    await rank(c.app.ctx);
    const view = (await c.peers(keeperOf(w.machine))).json() as { data: { networkId: string; number: number | null; copyName: string | null }[] };
    expect(view.data).toMatchObject([{ networkId: HOST_ID, number: 1, copyName: null }]);
    /* A copy is listed with its place and the name its subscription goes by. */
    await c.db.update(machines).set({ role: 'data', serverOrder: 2, copyName: 'copy_0f0f0f0f0f0f0f0f_1' }).where(eq(machines.id, w.machine));
    const own = (await c.peers()).json() as typeof view;
    expect(own.data.map(row => [row.number, row.copyName])).toEqual([[1, null], [2, 'copy_0f0f0f0f0f0f0f0f_1']]);
  });

  it('tells a machine its role, and the way to the data only to one that holds it', async () => {
    const c = await company({ HORNHOOF_KEEPER: 'on' });
    await c.link('acme');
    await c.serverCertificate();
    const w = await c.worker();
    type Said = { role: string; link: { dataSecret: string | null; appSecret: string; visitorKey: string } };
    const asWorker = (await c.peers(keeperOf(w.machine))).json() as Said;
    expect(asWorker.role).toBe('worker');
    expect(asWorker.link.dataSecret).toBeNull();
    /* The same machine once the server gave it the data: its keeper is told so, and gets the secret of the data service. */
    await c.db.update(machines).set({ role: 'data' }).where(eq(machines.id, w.machine));
    const own = (await c.peers()).json() as { link: { dataSecret: string } };
    const asCopy = (await c.peers(keeperOf(w.machine))).json() as Said;
    expect(asCopy.role).toBe('data');
    expect(asCopy.link).toMatchObject({ dataSecret: own.link.dataSecret, appSecret: asWorker.link.appSecret, visitorKey: asWorker.link.visitorKey });
    /* A row that says data while its person does not see the whole company gets no way to the data. */
    const [row] = await c.db.select().from(machines).where(eq(machines.id, w.machine));
    await c.db.execute(sql`UPDATE people SET is_owner = false, scope_kind = 'listed', status = 'active' WHERE id = ${row!.personId}`);
    expect(((await c.peers(keeperOf(w.machine))).json() as Said).link.dataSecret).toBeNull();
    /* Nor a certificate that opens the data, by a renewal it signs any more than by the one it asks through the link. */
    await c.db.update(certificates).set({ revokedAt: new Date() }).where(eq(certificates.machineId, w.machine));
    const renewed = JSON.parse(((await c.renew(w)).json() as { payload: string }).payload) as { role: string; certPem: string };
    expect(renewed.role).toBe('worker');
    expect(certFacts(renewed.certPem)).toMatchObject({ machineId: w.machine, role: 'worker' });
    /* The server's own keeper is told no role: it is the one that leads. */
    expect((await c.peers()).json()).not.toHaveProperty('role');
  });

  it('tells a copy about its slot', async () => {
    const c = await company({ HORNHOOF_KEEPER: 'on' });
    await c.link('acme');
    await c.serverCertificate();
    const w = await c.worker();
    type Said = { copy?: { slot: string | null; leaderSize: number | null; migrations: number | null; old: string | null; upload: string | null } | null };
    /* A worker hears of no copy. */
    expect(((await c.peers(keeperOf(w.machine))).json() as Said).copy).toBeNull();
    await c.db.update(machines).set({ role: 'data' }).where(eq(machines.id, w.machine));
    let slots: { name: string; pid: number | null; walStatus: string | null; confirmed: string | null }[] = [];
    c.app.ctx.replication = { slots: async () => slots, end: async () => undefined, drop: async () => undefined, standby: async () => '' };
    const told = async () => ((await c.peers(keeperOf(w.machine))).json() as Said).copy!;
    /* It named no copy yet. */
    expect(await told()).toMatchObject({ slot: null, old: null, upload: null });
    expect((await told()).leaderSize).toBeGreaterThan(0);
    expect((await told()).migrations).toBeGreaterThan(100);
    await c.db.update(machines).set({ copyName: 'copy_0f0f0f0f0f0f0f0f_1' }).where(eq(machines.id, w.machine));
    expect((await told()).slot).toBe('missing');
    slots = [{ name: 'copy_0f0f0f0f0f0f0f0f_1', pid: 7, walStatus: 'reserved', confirmed: '0/3000000' }];
    expect((await told()).slot).toBe('ok');
    slots = [{ name: 'copy_0f0f0f0f0f0f0f0f_1', pid: null, walStatus: 'lost', confirmed: '0/3000000' }];
    expect((await told()).slot).toBe('lost');
    /* The view a join or a renewal carries says the same. */
    expect((await workerView(c.app.ctx, w.machine)).copy).toMatchObject({ slot: 'lost' });
  });

  it('tells a machine that left to upload, then to wipe', async () => {
    const c = await company({ HORNHOOF_KEEPER: 'on' });
    await c.link('acme');
    await c.serverCertificate();
    const w = await c.worker();
    type Said = { role: string; copy?: { slot: string | null; upload: string | null } | null };
    const told = async () => (await c.peers(keeperOf(w.machine))).json() as Said;
    /* It held the data and its owner lost the scope: a worker by its row, that still owes what it holds. */
    await c.db.update(machines).set({ role: 'worker', uploadState: 'waiting', dataLeftAt: new Date() }).where(eq(machines.id, w.machine));
    expect(await told()).toMatchObject({ role: 'worker', copy: { slot: null, upload: 'waiting' } });
    /* The leader has it as a database: nothing more is asked of the machine until that is merged and saved. */
    await c.db.update(machines).set({ uploadState: 'received' }).where(eq(machines.id, w.machine));
    expect((await told()).copy).toMatchObject({ upload: 'received' });
    await c.db.update(machines).set({ uploadState: 'kept' }).where(eq(machines.id, w.machine));
    expect((await told()).copy).toMatchObject({ upload: 'wipe' });
    expect((await workerView(c.app.ctx, w.machine)).copy).toMatchObject({ upload: 'wipe' });
    /* Once it said it is wiped it is a worker like any other. */
    await c.db.update(machines).set({ uploadState: null }).where(eq(machines.id, w.machine));
    expect((await told()).copy).toBeNull();
  });

  it('names the last attempt', async () => {
    const c = await company();
    await c.serverCertificate();
    const w = await c.worker();
    const copy = async () => (await workerView(c.app.ctx, w.machine)).copy;
    await c.db.update(machines).set({ role: 'data' }).where(eq(machines.id, w.machine));
    expect(await copy()).toMatchObject({ slot: null, lastAttempt: null });
    /* It kept a copy before, was wiped, and holds the data again: its row still names the last one. */
    await c.db.update(machines).set({ copyName: 'copy_0f0f0f0f0f0f0f0f_7' }).where(eq(machines.id, w.machine));
    expect(await copy()).toMatchObject({ slot: 'missing', lastAttempt: 7 });
  });

  it('names the slot to join', async () => {
    const c = await company();
    await c.serverCertificate();
    const w = await c.worker();
    const copy = async () => (await workerView(c.app.ctx, w.machine)).copy;
    await c.db.update(machines).set({ role: 'data', copyName: 'copy_0f0f0f0f0f0f0f0f_3' }).where(eq(machines.id, w.machine));
    const [row] = await c.db.select().from(machines).where(eq(machines.id, w.machine));
    const [server] = await c.db.select().from(machines).where(eq(machines.networkId, c.app.ctx.config.machineId!));
    /* With no switch on record the view names this leader, and no slot. */
    expect(await copy()).toMatchObject({ leader: server!.networkId, join: null });
    /* This machine took the server in a planned switch, and made the copy a slot above its attempt. */
    const handover = (slot: string, at: string, to = server!.id) =>
      c.db.execute(sql`INSERT INTO net.handovers (id, from_machine_id, term_number, term_machine, applied, to_machine_id, at, slots)
        VALUES (gen_random_uuid(), ${w.machine}, 5, 'a', '0/1', ${to}, ${at}::timestamptz, ${JSON.stringify({ [row!.networkId!]: slot })}::jsonb)`);
    await handover('copy_0f0f0f0f0f0f0f0f_4', '2026-11-10T10:00:00Z');
    expect(await copy()).toMatchObject({ join: 'copy_0f0f0f0f0f0f0f0f_4' });
    /* The view a keeper asks for each few seconds names it too: that is where a copy that follows hears of it. */
    expect(((await c.peers(keeperOf(w.machine))).json() as { copy: { leader: string; join: string | null } }).copy).toMatchObject({ leader: server!.networkId, join: 'copy_0f0f0f0f0f0f0f0f_4' });
    /* Once the copy joined, its row names that slot, and there is nothing more to join. */
    await c.db.update(machines).set({ copyName: 'copy_0f0f0f0f0f0f0f0f_4' }).where(eq(machines.id, w.machine));
    expect(await copy()).toMatchObject({ join: null });
    /* Only the newest switch counts, and only one in which this machine took the server. */
    await handover('copy_0f0f0f0f0f0f0f0f_9', '2026-11-09T10:00:00Z');
    expect(await copy()).toMatchObject({ join: null });
    await handover('copy_0f0f0f0f0f0f0f0f_8', '2026-11-11T10:00:00Z', w.machine);
    expect(await copy()).toMatchObject({ join: null });
    await c.db.execute(sql`INSERT INTO net.handovers (id, from_machine_id, term_number, term_machine, applied, to_machine_id, at, slots) VALUES (gen_random_uuid(), ${w.machine}, 6, 'a', '0/2', ${server!.id}, '2026-11-12T10:00:00Z', '{}'::jsonb)`);
    expect(await copy()).toMatchObject({ join: null });
  });

  it('asks the relay for a visitor key at most once a minute, and again for a link of another name', async () => {
    const c = await company();
    const w = await c.worker();
    /* A company with no link says so. */
    expect(((await c.peers(keeperOf(w.machine))).json() as { link: unknown }).link).toBeNull();
    await c.link('acme');
    c.relay.down = true;
    expect(await visitorKeyOf(c.app.ctx)).toBeNull();
    /* With a link whose key the relay did not give, the view says nothing of the link. */
    expect((await c.peers(keeperOf(w.machine))).json()).not.toHaveProperty('link');
    c.relay.down = false;
    /* A relay that did not answer is not asked again at once. */
    expect(await visitorKeyOf(c.app.ctx)).toBeNull();
    expect(c.visitorKeyCalls()).toBe(1);
    const key = await visitorKeyOf(c.app.ctx, { force: true });
    expect(key).toBe(c.relay.visitorKeys.get('acme'));
    expect(await visitorKeyOf(c.app.ctx)).toBe(key);
    expect(c.visitorKeyCalls()).toBe(2);
    /* The key of the link before is not this link's. */
    await c.link('acme-two');
    expect(await visitorKeyOf(c.app.ctx, { force: true })).toBe(c.relay.visitorKeys.get('acme-two'));
    expect(c.relay.visitorKeys.get('acme-two')).not.toBe(key);
  });

  it('keeps the reported addresses and counts online time', async () => {
    const c = await company();
    await c.serverCertificate();
    const w = await c.worker();
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => void vi.useRealTimers());
    const said = { addresses: ['192.168.1.20', '10.0.0.4'], path: 'relay', directFails: true, hostname: 'not-kept' };
    for (let i = 0; i < 3; i++) {
      expect((await c.report(said, keeperOf(w.machine))).statusCode).toBe(204);
      /* A second report in the same moment, as a keeper started twice sends it, adds nothing. */
      expect((await c.report(said, keeperOf(w.machine))).statusCode).toBe(204);
      vi.setSystemTime(Date.now() + 20_000);
    }
    expect(await c.rowOf(w.machine)).toMatchObject({ addresses: ['192.168.1.20', '10.0.0.4'], path: 'relay', directFails: true, hostname: MAC.hostname });
    const online = await c.db.select({ total: sql<number>`sum(${machineOnline.seconds})::int` }).from(machineOnline).where(eq(machineOnline.machineId, w.machine));
    expect(online).toEqual([{ total: 60 }]);
    expect((await c.report({ path: null, directFails: false }, keeperOf(w.machine))).statusCode).toBe(204);
    expect(await c.rowOf(w.machine)).toMatchObject({ path: null, directFails: false, addresses: ['192.168.1.20', '10.0.0.4'] });

    /* The server's own row has no name but the one its keeper says. */
    expect((await c.report({ hostname: 'debian-box', addresses: ['172.16.3.1', '127.0.0.1', '192.0.2.5'] })).statusCode).toBe(204);
    const [server] = await c.db.select().from(machines).where(eq(machines.networkId, HOST_ID));
    expect(server).toMatchObject({ hostname: 'debian-box', addresses: ['172.16.3.1', '127.0.0.1', '192.0.2.5'] });

    const bad = [{ addresses: ['8.8.8.8'] }, { addresses: ['172.32.0.1'] }, { addresses: ['fe80::1'] }, { addresses: Array<string>(9).fill('10.0.0.1') }, { hostname: 'two words' }, { hostname: 'x'.repeat(121) }, { path: 'tunnel' }];
    for (const body of bad) expect((await c.report(body, keeperOf(w.machine))).statusCode, JSON.stringify(body)).toBe(400);
  });

  it('counts the online share over one window', async () => {
    const c = await company();
    const [owner] = await c.db.select().from(people).where(eq(people.isOwner, true));
    const DAY = 86_400_000;
    const rowAt = async (createdAt: Date) =>
      (await c.db.insert(machines).values({ companyId: c.companyId, personId: owner!.id, machineKey: `online-${createdAt.getTime()}-${Math.random()}`, createdAt }).returning())[0]!.id;
    const dayOf = (at: Date) => at.toISOString().slice(0, 10);

    for (const now of [new Date('2031-03-10T00:05:00Z'), new Date('2031-03-10T12:00:00Z')]) {
      const old = await rowAt(new Date(now.getTime() - 8 * DAY));
      await c.db.insert(machineOnline).values(Array.from({ length: 9 }, (_, back) => ({ machineId: old, day: dayOf(new Date(now.getTime() - back * DAY)), seconds: 86_400 })));
      expect(Math.abs((await onlineShare(c.db, old, now))! - 1)).toBeLessThan(0.01);
    }

    /* Half of each day online is half of the week, whatever the hour. */
    const now = new Date('2031-03-10T12:00:00Z');
    const half = await rowAt(new Date(now.getTime() - 30 * DAY));
    await c.db.insert(machineOnline).values(Array.from({ length: 8 }, (_, back) => ({ machineId: half, day: dayOf(new Date(now.getTime() - back * DAY)), seconds: back === 0 ? 21_600 : 43_200 })));
    expect(Math.abs((await onlineShare(c.db, half, now))! - 0.5)).toBeLessThan(0.01);
    expect(await onlineShare(c.db, await rowAt(new Date(now.getTime() - 30 * DAY)), now)).toBe(0);

    const fresh = await rowAt(new Date(now.getTime() - 30 * 60_000));
    await c.db.insert(machineOnline).values({ machineId: fresh, day: dayOf(now), seconds: 1800 });
    expect(await onlineShare(c.db, fresh, now)).toBe(1);
    await c.db.update(machineOnline).set({ seconds: 2000 }).where(eq(machineOnline.machineId, fresh));
    expect(await onlineShare(c.db, fresh, now)).toBe(1);
    expect(await onlineShare(c.db, await rowAt(new Date(now.getTime() - 20_000)), now)).toBeNull();
    expect(await onlineShare(c.db, NOBODY, now)).toBeNull();
  });

  it('cuts a disconnected machine off', async () => {
    const c = await company();
    await c.link('acme');
    await c.serverCertificate();
    /* The computer joined, its owner asked for one more command for its core, and then its keeper came. */
    const { machine, ticket } = await c.cored();
    const offered = await c.app.inject({ method: 'POST', url: `/api/machines/${machine}/core`, ...as(c.ceo) });
    expect(offered.statusCode).toBe(201);
    const keys = newKeys();
    const said = (await c.redeem(ticket, MAC.machineId, keys)).json() as Joined;
    const w: Worker = { machine, keys, serial: certFacts(said.certPem).serial, authorityPem: said.authorityPem, view: said.view };
    const second = certFacts((JSON.parse(((await c.renew(w, { serial: 'ab12' }, OVER_HTTPS)).json() as { payload: string }).payload) as { certPem: string }).certPem).serial;
    const unused = await issueTicket(c.db, machine);
    const before = (await c.peers()).json() as { link: { appSecret: string; dataSecret: string } };
    const oldVisitorKey = c.relay.visitorKeys.get('acme');
    expect(c.visitorKeyCalls()).toBe(1);

    expect((await c.disconnect(machine)).statusCode).toBe(204);
    /* The secrets a leader makes right after are not the ones the worker held, and nothing takes them away again. */
    const after = { app: await peerSecret(c.db, c.config, 'app', true), data: await peerSecret(c.db, c.config, 'data', true) };
    await until(() => c.visitorKeyCalls() === 2);
    const visitorKey = await visitorKeyOf(c.app.ctx);
    expect(visitorKey).toBe(c.relay.visitorKeys.get('acme'));
    expect(visitorKey).not.toBe(oldVisitorKey);
    expect(c.visitorKeyCalls()).toBe(2);
    expect(after.app).not.toBe(before.link.appSecret);
    expect(after.data).not.toBe(before.link.dataSecret);
    const now = (await c.peers()).json() as { revoked: string[]; link: { appSecret: string; dataSecret: string } };
    expect(now.link).toMatchObject({ appSecret: after.app, dataSecret: after.data });
    expect(now.revoked).toEqual([w.serial, second].sort());

    expect(await c.rowOf(machine)).toMatchObject({ networkId: null });
    expect((await c.rowOf(machine)).revokedAt).not.toBeNull();
    expect(await c.db.select().from(machineTickets).where(isNull(machineTickets.usedAt))).toEqual([]);
    expect(errorOf(await c.redeem(unused, MAC.machineId, keys))).toBe('ticket_used');
    const late = await c.join(codeOf((offered.json() as { command: string }).command), { core: true });
    expect(late.statusCode).toBe(410);
    expect(errorOf(late)).toBe('code_used');
    expect((await c.peers(keeperOf(machine))).statusCode).toBe(404);
    expect((await c.app.inject({ method: 'POST', url: '/api/network/certificate', payload: { signKey: keys.pem }, ...keeperOf(machine) })).statusCode).toBe(404);
  });

  it('gives a machine connected again no place in the network until its keeper redeems a new ticket', async () => {
    const c = await company();
    const w = await c.worker();
    expect((await c.disconnect(w.machine)).statusCode).toBe(204);
    /* The owner runs a command there again, and the row is the machine's once more. */
    const back = (await c.join(await c.command())).json() as { machine: { id: string } };
    expect(back.machine.id).toBe(w.machine);
    expect(await c.rowOf(w.machine)).toMatchObject({ revokedAt: null, role: null, signKey: null, networkId: null });
    /* The key the machine had before the Disconnect opens nothing: whoever holds it is not let back in by it. */
    const old = await c.renew(w);
    expect(old.statusCode).toBe(404);
    expect(await c.db.select().from(certificates).where(and(eq(certificates.machineId, w.machine), isNull(certificates.revokedAt)))).toEqual([]);
    expect((await c.peers(keeperOf(w.machine))).statusCode).toBe(404);
  });

  it('leaves the secrets alone when a computer with no core is disconnected', async () => {
    const c = await company();
    await c.link('acme');
    await c.serverCertificate();
    const w = await c.worker();
    const before = (await c.peers(keeperOf(w.machine))).json() as { link: object };
    const plain = (await c.join(await c.command(), LAPTOP)).json() as { machine: { id: string } };
    expect((await c.disconnect(plain.machine.id)).statusCode).toBe(204);
    expect(((await c.peers(keeperOf(w.machine))).json() as { link: object }).link).toEqual(before.link);
    expect(c.visitorKeyCalls()).toBe(1);
  });

  it('offers the core to a machine that has none', async () => {
    const c = await company();
    const maria = await invitePerson(c.app, c.ceo, { name: 'Maria', email: 'maria@acme.com', access: { whole: true } });
    /* A computer joined before machines had a core: it has its node and no ticket. */
    const old = (await c.join(await c.command())).json() as { machine: { id: string } };
    const offer = (machine: string, token = c.ceo) => c.app.inject({ method: 'POST', url: `/api/machines/${machine}/core`, ...as(token) });

    expect((await offer(old.machine.id, maria)).json().error).toMatchObject({ code: 'forbidden', reason: 'not_owner' });
    expect((await offer(NOBODY)).statusCode).toBe(404);
    const made = await offer(old.machine.id);
    expect(made.statusCode).toBe(201);
    const { id, command, expiresAt } = made.json() as { id: string; command: string; expiresAt: string };
    expect({ id, expiresAt }).toEqual({ id: hashToken(codeOf(command)), expiresAt: expect.any(String) });
    expect(await c.db.select().from(nodeCodes).where(eq(nodeCodes.codeHash, id))).toMatchObject([{ core: true, machineId: old.machine.id, subscriptionIds: [] }]);

    /* The command works on its machine alone, and there it brings the core and no node. */
    expect(errorOf(await c.join(codeOf(command), { core: true, ...LAPTOP }))).toBe('other_machine');
    const res = await c.join(codeOf(command), { core: true }, { accept: 'text/plain' });
    expect(res.statusCode).toBe(200);
    const lines = res.body.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^core hornhoof-[a-z]{6} [A-Za-z0-9_-]{43} 8080 /);
    const ticket = lines[0]!.split(' ')[2]!;
    expect((await c.redeem(ticket, MAC.machineId, newKeys())).statusCode).toBe(200);

    const full = await offer(old.machine.id);
    expect(full.statusCode).toBe(409);
    expect(full.json().error).toEqual({ code: 'conflict', message: 'This machine is a full machine of the company already.', reason: 'core_present' });
    /* The server's own computer has the whole of Hornhoof already. */
    const host = (await c.join(await c.command(), { machineId: HOST_KEY, hostname: 'server-box' })).json() as { machine: { id: string } };
    expect(errorOf(await offer(host.machine.id))).toBe('core_present');
  });
});
