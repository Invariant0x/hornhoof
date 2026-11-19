import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { decryptSecret, encryptSecret } from '../src/crypto/secrets.js';
import { companies, departments, linkTls, publicLinks } from '../src/db/schema.js';
import { PublicLinks, writeTunnelSettings } from '../src/modules/link/link.js';
import { newAccountKey } from '../src/modules/tls/acme.js';
import { mayRunHttps, saveTls, tlsOf, updateTls } from '../src/modules/tls/store.js';
import { selfSigned } from '../src/modules/tls/x509.js';
import { fakeRelay } from './fake-relay.js';
import { as, invitePerson, setUpCompany, testApp, until } from './helpers.js';

/* A company with its own control folder, asking the fake relay for links. */
async function company(env: NodeJS.ProcessEnv = {}) {
  const relay = await fakeRelay();
  const control = mkdtempSync(join(tmpdir(), 'hh-link-'));
  const { app, db, config } = await testApp({ RELAY_URL: relay.url, HORNHOOF_CONTROL_DIR: control, ...env });
  const ceo = await setUpCompany(app);
  const put = (payload: object, token = ceo) => app.inject({ method: 'PUT', url: '/api/link', payload, ...as(token) });
  const tunnelFile = join(control, 'tunnel.json');
  return { app, db, config, relay, ceo, put, control, tunnelFile };
}

describe('checking a name for the public link', () => {
  it('asks the relay whether it is free', async () => {
    const { app, relay, ceo, put } = await company();
    expect((await app.inject({ url: '/api/link/names/acme', ...as(ceo) })).json()).toEqual({ name: 'acme', free: true });
    relay.bindings.set('globex', { key: 'k' });
    expect((await app.inject({ url: '/api/link/names/globex', ...as(ceo) })).json()).toEqual({ name: 'globex', free: false, reason: 'taken' });
    expect((await app.inject({ url: '/api/link/names/www', ...as(ceo) })).json()).toEqual({ name: 'www', free: false, reason: 'reserved' });
    expect(relay.calls).toEqual(['GET /api/v1/names/acme', 'GET /api/v1/names/globex', 'GET /api/v1/names/www']);
    expect((await put({ name: 'acme' })).statusCode).toBe(200);
  });

  it('answers a name no link can have without asking the relay', async () => {
    const { app, relay, ceo } = await company();
    for (const name of ['-acme', 'Acme', 'acme_corp', 'a'.repeat(64)]) {
      expect((await app.inject({ url: `/api/link/names/${name}`, ...as(ceo) })).json(), name).toEqual({ name, free: false, reason: 'invalid' });
    }
    expect(relay.calls).toEqual([]);
  });

  it('says when hornhoof.org does not answer', async () => {
    const { app, relay, ceo } = await company();
    relay.down = true;
    const res = await app.inject({ url: '/api/link/names/acme', ...as(ceo) });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.reason).toBe('relay_unreachable');
  });
});

const LINK_HOST = 'acme.hornhoof.test';
const CERTIFICATES_ON = { ACME_DIRECTORY: 'https://acme.invalid/directory' };

/* A company with the link acme, and a certificate row that may run https. The tests change one thing of it at a time. */
async function companyWithCertificate(env: NodeJS.ProcessEnv) {
  const made = await company(env);
  await made.put({ name: 'acme' });
  const [acme] = await made.db.select().from(companies);
  const pair = await selfSigned(LINK_HOST);
  const accountKey = await newAccountKey();
  const secret = made.config.secret;
  const good = {
    directory: CERTIFICATES_ON.ACME_DIRECTORY,
    accountKeyEnc: encryptSecret(accountKey, secret),
    name: 'acme',
    mode: 'https' as const,
    certPem: pair.certPem,
    certKeyEnc: encryptSecret(pair.keyPem, secret),
  };
  const written = () => readFileSync(made.tunnelFile, 'utf8');
  const modeWith = async (row: Parameters<typeof saveTls>[2]) => {
    await saveTls(made.db, acme!.id, row);
    await writeTunnelSettings(made.db, made.config);
    return (JSON.parse(written()) as { mode: unknown }).mode;
  };
  return { ...made, companyId: acme!.id, pair, accountKey, good, written, modeWith };
}

describe("the tunnel's mode", () => {
  it("writes the tunnel's mode: https only for a certificate of the link's own name", async () => {
    const { config, pair, good, written, modeWith } = await companyWithCertificate(CERTIFICATES_ON);
    expect((JSON.parse(written()) as { mode: unknown }).mode).toBe('http');
    expect(await modeWith(good)).toBe('https');

    const sealed = (keyPem: string) => encryptSecret(keyPem, config.secret);
    const another = await selfSigned(LINK_HOST);
    const shortLived = await selfSigned(LINK_HOST, { days: 23 / 24 });
    const otherHost = await selfSigned('other.hornhoof.test');
    const cases: [string, Partial<Parameters<typeof saveTls>[2]>][] = [
      ['the row of another name', { name: 'old' }],
      ['no certificate', { certPem: null }],
      ['no key', { certKeyEnc: null }],
      ['a certificate with 23 h left', { certPem: shortLived.certPem, certKeyEnc: sealed(shortLived.keyPem) }],
      ['a certificate of another host', { certPem: otherHost.certPem, certKeyEnc: sealed(otherHost.keyPem) }],
      ["another certificate's key", { certKeyEnc: sealed(another.keyPem) }],
      ['a key that does not decrypt', { certKeyEnc: encryptSecret(pair.keyPem, Buffer.alloc(32, 9)) }],
      ['a key that is no key', { certKeyEnc: sealed('no key') }],
      ['text that is no certificate', { certPem: 'not a certificate' }],
      ['a chain whose second block is broken', { certPem: `${pair.certPem}-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n` }],
      ['a chain whose second block is cut off', { certPem: `${pair.certPem}${another.certPem.slice(0, 200)}` }],
      ['a row in http mode', { mode: 'http' }],
    ];
    for (const [what, change] of cases) {
      expect(await modeWith({ ...good, ...change }), what).toBe('http');
    }
  });

  it('keeps every private key out of the tunnel settings', async () => {
    const { pair, accountKey, good, written, modeWith } = await companyWithCertificate(CERTIFICATES_ON);
    expect(await modeWith(good)).toBe('https');
    const text = written();
    /* Booleans only: a failure here must not print a key. */
    expect(text.includes('certKeyEnc')).toBe(false);
    expect(text.includes('PRIVATE KEY')).toBe(false);
    expect(text.includes(accountKey)).toBe(false);
    expect(text.includes(pair.keyPem)).toBe(false);
    expect(text.includes(good.accountKeyEnc)).toBe(false);
    expect(text.includes(good.certKeyEnc)).toBe(false);
  });

  it('puts the link on http when certificates are off, which is how tests run unless they ask', async () => {
    for (const env of [{ ACME_DIRECTORY: 'off' }, {}]) {
      const { good, modeWith } = await companyWithCertificate(env);
      expect(await modeWith(good), JSON.stringify(env)).toBe('http');
    }
  });

  it('reads the names in a certificate in any case', async () => {
    const secret = Buffer.alloc(32, 3);
    const pair = await selfSigned('ACME.hornhoof.test');
    const row = { mode: 'https' as const, name: 'acme', certPem: pair.certPem, certKeyEnc: encryptSecret(pair.keyPem, secret) };
    expect(mayRunHttps(row, { name: 'acme', url: `https://${LINK_HOST}` }, secret, new Date())).toBe(true);
  });

  it('asks for more than a day left on the certificate, read from the first of a chain', async () => {
    const secret = Buffer.alloc(32, 3);
    const notBefore = new Date('2026-11-04T12:00:00.000Z');
    const pair = await selfSigned(LINK_HOST, { days: 3, now: notBefore });
    const other = await selfSigned('intermediate.hornhoof.test');
    const row = { mode: 'https' as const, name: 'acme', certPem: `${pair.certPem}${other.certPem}`, certKeyEnc: encryptSecret(pair.keyPem, secret) };
    const link = { name: 'acme', url: `https://${LINK_HOST}` };
    const DAY_MS = 24 * 60 * 60 * 1000;
    const leaving = (leftMs: number) => new Date(notBefore.getTime() + 3 * DAY_MS - leftMs);
    expect(mayRunHttps(row, link, secret, leaving(DAY_MS + 1000))).toBe(true);
    expect(mayRunHttps(row, link, secret, leaving(DAY_MS))).toBe(false);
    expect(mayRunHttps(row, link, secret, new Date(Number.NaN)), 'a date that cannot be read').toBe(false);
  });

  it('says in the log why a certificate that cannot be checked leaves the link on http, with no key in the line', async () => {
    const { db, config, companyId, good, written } = await companyWithCertificate(CERTIFICATES_ON);
    const certKeyEnc = encryptSecret('-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----\n', config.secret);
    await saveTls(db, companyId, { ...good, certKeyEnc });
    const warned: unknown[][] = [];
    const log = { warn: (...line: unknown[]) => warned.push(line) };
    await new PublicLinks({ db, config, log: log as never }).sync();
    expect((JSON.parse(written()) as { mode: unknown }).mode).toBe('http');
    expect(warned.map(line => line[1])).toEqual(['The link stays on http: its certificate could not be checked.']);
    /* Booleans only: a failure here must not print a key. */
    const text = JSON.stringify(warned);
    expect(text.includes('PRIVATE KEY')).toBe(false);
    expect(text.includes(certKeyEnc)).toBe(false);
  });
});

describe("the certificate's row", () => {
  it('is made once, keeps what a later save does not name, and may not be changed before it exists', async () => {
    const { db } = await company();
    const [acme] = await db.select().from(companies);
    expect(await tlsOf(db, acme!.id)).toBeNull();
    await expect(updateTls(db, acme!.id, { mode: 'https' })).rejects.toThrow('The link has no certificate row to change.');
    expect(await tlsOf(db, acme!.id)).toBeNull();

    await saveTls(db, acme!.id, { directory: 'https://one.invalid/directory', accountKeyEnc: 'sealed one' });
    expect(await tlsOf(db, acme!.id)).toMatchObject({ directory: 'https://one.invalid/directory', accountKeyEnc: 'sealed one', mode: 'http', certPem: null });
    await updateTls(db, acme!.id, { failure: 'refused' });
    await saveTls(db, acme!.id, { directory: 'https://two.invalid/directory', accountKeyEnc: 'sealed two' });
    expect(await tlsOf(db, acme!.id)).toMatchObject({ directory: 'https://two.invalid/directory', accountKeyEnc: 'sealed two', failure: 'refused' });
    expect(await db.select().from(linkTls)).toHaveLength(1);
  });

  it('notes the time of every change', async () => {
    const { db } = await company();
    const [acme] = await db.select().from(companies);
    await saveTls(db, acme!.id, { directory: 'https://one.invalid/directory', accountKeyEnc: 'sealed' });
    const longAgo = new Date('2020-01-01T00:00:00.000Z');
    const updatedAt = async () => (await tlsOf(db, acme!.id))!.updatedAt.getTime();
    await db.update(linkTls).set({ updatedAt: longAgo });
    await updateTls(db, acme!.id, { failure: 'refused' });
    expect(await updatedAt()).toBeGreaterThan(longAgo.getTime());
    await db.update(linkTls).set({ updatedAt: longAgo });
    await saveTls(db, acme!.id, { directory: 'https://one.invalid/directory', accountKeyEnc: 'sealed' });
    expect(await updatedAt()).toBeGreaterThan(longAgo.getTime());
  });
});

describe('binding the company to a public link', () => {
  it('takes the name at the relay, keeps the key encrypted and writes the tunnel settings', async () => {
    const { app, db, config, relay, ceo, put, tunnelFile } = await company();
    expect((await app.inject({ url: '/api/link', ...as(ceo) })).json()).toEqual({ link: null, domain: '127.0.0.1', tls: null });
    const res = await put({ name: 'acme' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ link: { name: 'acme', url: 'https://acme.hornhoof.test' } });
    const { key } = relay.bindings.get('acme')!;
    expect(res.body).not.toContain(key);

    const [row] = await db.select().from(publicLinks);
    const [acme] = await db.select().from(companies);
    expect(row).toMatchObject({ companyId: acme!.id, name: 'acme', url: 'https://acme.hornhoof.test' });
    expect(row!.keyEnc).not.toContain(key);
    expect(decryptSecret(row!.keyEnc, config.secret)).toBe(key);
    expect(row!.tunnelEnc).not.toContain(key);

    expect(JSON.parse(readFileSync(tunnelFile, 'utf8'))).toEqual({
      url: 'https://acme.hornhoof.test',
      name: 'acme',
      key,
      tunnel: expect.objectContaining({ serverAddr: 'hornhoof.test', serverPort: 443, protocol: 'wss' }),
      mode: 'http',
      hidden: false,
    });
    /* The link's key is for the tunnel container alone. */
    expect(statSync(tunnelFile).mode & 0o077).toBe(0);
    expect((await app.inject({ url: '/api/link', ...as(ceo) })).json()).toEqual({
      link: { name: 'acme', url: 'https://acme.hornhoof.test' },
      domain: '127.0.0.1',
      tls: { mode: 'http', certificate: false, expiresAt: null, failedAt: null },
    });
  });

  it('gets a long random name when none is asked for', async () => {
    const { relay, put } = await company();
    const res = await put({});
    expect(res.statusCode).toBe(200);
    const { name, url } = res.json().link;
    expect(name).toMatch(/^[a-z0-9]{20,}$/);
    expect(url).toBe(`https://${name}.hornhoof.test`);
    expect(relay.bindings.has(name)).toBe(true);
  });

  it('refuses a taken name, and one no link can have without asking the relay', async () => {
    const { db, relay, put } = await company();
    relay.bindings.set('globex', { key: 'k' });
    const taken = await put({ name: 'globex' });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.reason).toBe('link_taken');
    const reserved = await put({ name: 'www' });
    expect(reserved.statusCode).toBe(400);
    expect(reserved.json().error.reason).toBe('link_reserved');
    relay.calls.length = 0;
    const invalid = await put({ name: 'Not a name' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.reason).toBe('link_invalid');
    expect(relay.calls).toEqual([]);
    expect(await db.select().from(publicLinks)).toEqual([]);
  });

  it('says when hornhoof.org does not answer, and keeps nothing', async () => {
    const { db, put, tunnelFile } = await company({ RELAY_URL: 'http://127.0.0.1:1' });
    const res = await put({ name: 'acme' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.reason).toBe('relay_unreachable');
    expect(await db.select().from(publicLinks)).toEqual([]);
    expect(existsSync(tunnelFile)).toBe(false);
  });

  it('takes no address from the relay that is not the link it asked for', async () => {
    const { db, relay, put } = await company();
    for (const url of ['https://evil.test', 'http://acme.hornhoof.test', 'https://acme.hornhoof.test/elsewhere']) {
      relay.urlFor = () => url;
      const res = await put({ name: 'acme' });
      expect(res.statusCode, url).toBe(503);
      relay.bindings.clear();
    }
    expect(await db.select().from(publicLinks)).toEqual([]);
    relay.urlFor = name => `https://${name}.hornhoof.test/`;
    expect((await put({ name: 'acme' })).json().link.url).toBe('https://acme.hornhoof.test');
  });

  it('moves to a new name: the new link comes first, then the old one goes', async () => {
    const { db, relay, put, tunnelFile } = await company();
    await put({ name: 'acme' });
    relay.calls.length = 0;
    const res = await put({ name: 'acme-corp' });
    expect(res.json()).toEqual({ link: { name: 'acme-corp', url: 'https://acme-corp.hornhoof.test' } });
    expect(relay.calls).toEqual(['POST /api/v1/bindings', 'DELETE /api/v1/bindings/acme']);
    expect([...relay.bindings.keys()]).toEqual(['acme-corp']);
    expect((await db.select().from(publicLinks)).map(l => l.name)).toEqual(['acme-corp']);
    expect(JSON.parse(readFileSync(tunnelFile, 'utf8')).url).toBe('https://acme-corp.hornhoof.test');
    /* The same name again changes nothing. */
    relay.calls.length = 0;
    expect((await put({ name: 'acme-corp' })).json()).toEqual({ link: { name: 'acme-corp', url: 'https://acme-corp.hornhoof.test' } });
    expect(relay.calls).toEqual([]);
  });

  it('keeps the old link when the new name is taken', async () => {
    const { db, relay, put } = await company();
    await put({ name: 'acme' });
    relay.bindings.set('globex', { key: 'k' });
    expect((await put({ name: 'globex' })).statusCode).toBe(409);
    expect((await db.select().from(publicLinks)).map(l => l.name)).toEqual(['acme']);
    expect(relay.bindings.has('acme')).toBe(true);
  });

  it('removes the link at the relay and here', async () => {
    const { app, db, relay, ceo, put, tunnelFile } = await company();
    await put({ name: 'acme' });
    const res = await app.inject({ method: 'DELETE', url: '/api/link', ...as(ceo) });
    expect(res.statusCode).toBe(204);
    expect(relay.bindings.size).toBe(0);
    expect(await db.select().from(publicLinks)).toEqual([]);
    expect(existsSync(tunnelFile)).toBe(false);
    expect((await app.inject({ url: '/api/link', ...as(ceo) })).json().link).toBeNull();
    expect((await app.inject({ method: 'DELETE', url: '/api/link', ...as(ceo) })).statusCode).toBe(204);
  });

  it('keeps the link while the relay does not answer the removal', async () => {
    const { app, db, relay, ceo, put, tunnelFile } = await company();
    await put({ name: 'acme' });
    relay.down = true;
    const res = await app.inject({ method: 'DELETE', url: '/api/link', ...as(ceo) });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.reason).toBe('relay_unreachable');
    expect(await db.select().from(publicLinks)).toHaveLength(1);
    expect(existsSync(tunnelFile)).toBe(true);
  });

  it('lets go of a link the relay no longer knows', async () => {
    const { app, db, relay, ceo, put } = await company();
    await put({ name: 'acme' });
    relay.bindings.clear();
    expect((await app.inject({ method: 'DELETE', url: '/api/link', ...as(ceo) })).statusCode).toBe(204);
    expect(await db.select().from(publicLinks)).toEqual([]);
  });

  it('is only for people who see the whole company', async () => {
    const { app, db, ceo, put } = await company();
    const [acme] = await db.select().from(companies);
    const [marketing] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'marketing', roleCode: 'CMO' }).returning();
    const elin = await invitePerson(app, ceo, { name: 'Elin', email: 'elin@acme.com', access: { departments: [marketing!.id] } });
    for (const res of [
      await app.inject({ url: '/api/link', ...as(elin) }),
      await app.inject({ url: '/api/link/names/acme', ...as(elin) }),
      await put({ name: 'acme' }, elin),
      await app.inject({ method: 'DELETE', url: '/api/link', ...as(elin) }),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.reason).toBe('company_scope_only');
    }
    expect((await app.inject({ url: '/api/link' })).statusCode).toBe(401);
  });
});

describe('the public link as the address of this Hornhoof', () => {
  it("goes into machine commands, invite links, an assistant's key and install.sh, and PUBLIC_URL comes back when it goes", async () => {
    const { app, ceo, put } = await company({ PUBLIC_URL: 'http://localhost:8080' });
    const me = (await app.inject({ url: '/api/me', ...as(ceo) })).json().person;
    const ava = (await app.inject({ method: 'POST', url: '/api/people/assistants', payload: { name: 'Ava', owner: me.id, program: 'avaclone' }, ...as(ceo) })).json().person;
    const keyFor = async () => (await app.inject({ method: 'POST', url: `/api/people/${ava.id}/key`, ...as(ceo) })).json();
    await put({ name: 'acme' });
    const connect = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) });
    expect(connect.json().command).toMatch(/^curl -fsSL https:\/\/acme\.hornhoof\.test\/install\.sh \| bash -s -- --join /);
    const again = await app.inject({ method: 'POST', url: '/api/machines/command', ...as(ceo) });
    expect(again.json().command).toMatch(/^curl -fsSL https:\/\/acme\.hornhoof\.test\/install\.sh/);
    const invited = await app.inject({ method: 'POST', url: '/api/people/invite', payload: { name: 'Maria', email: 'maria@acme.com', title: '', access: { whole: true } }, ...as(ceo) });
    expect(invited.json().inviteUrl).toMatch(/^https:\/\/acme\.hornhoof\.test\/invite\/[A-Za-z0-9_-]{43}$/);
    const reinvited = await app.inject({ method: 'POST', url: `/api/people/${invited.json().person.id}/invite`, ...as(ceo) });
    expect(reinvited.json().inviteUrl).toMatch(/^https:\/\/acme\.hornhoof\.test\/invite\//);
    expect((await app.inject({ url: '/install.sh' })).body).toContain('SERVER="${HORNHOOF_SERVER:-https://acme.hornhoof.test}"');
    expect(await keyFor()).toMatchObject({ address: 'https://acme.hornhoof.test', key: expect.stringMatching(/^hha_/) });

    await app.inject({ method: 'DELETE', url: '/api/link', ...as(ceo) });
    expect((await app.inject({ url: '/install.sh' })).body).toContain('SERVER="${HORNHOOF_SERVER:-http://localhost:8080}"');
    expect((await keyFor()).address).toBe('http://localhost:8080');
  });

  it("takes changes from the link's own pages, even when the tunnel names another host", async () => {
    const { app, ceo, put } = await company();
    const me = (await app.inject({ url: '/api/me', ...as(ceo) })).json().person;
    const rename = () =>
      app.inject({ method: 'PATCH', url: `/api/people/${me.id}`, payload: { title: 'Founder' }, headers: { host: 'app:8080', origin: 'https://acme.hornhoof.test' }, ...as(ceo) });
    expect((await rename()).statusCode).toBe(403);
    await put({ name: 'acme' });
    expect((await rename()).statusCode).toBe(200);
    await app.inject({ method: 'DELETE', url: '/api/link', ...as(ceo) });
    expect((await rename()).statusCode).toBe(403);
  });

  it('is the address of the owner link', async () => {
    const { db, config, put } = await company({ PUBLIC_URL: 'https://hq.acme.com' });
    await put({ name: 'acme' });
    const lines: string[] = [];
    expect(await runCli(['owner-link'], { db, config, print: line => lines.push(line) })).toBe(0);
    expect(lines.join('\n')).toMatch(/https:\/\/acme\.hornhoof\.test\/invite\/[A-Za-z0-9_-]{43}/);
  });
});

describe('taking over a link made before', () => {
  const NAME = '5y32cnxttxtucl3hhwbnzq4q';
  const KEY = 'a-key-the-relay-gave-for-this-link-0123456789';

  it('keeps the name and key from the command line, without asking hornhoof.org for a new link', async () => {
    const { app, db, config, relay, ceo, tunnelFile } = await company();
    relay.bindings.set(NAME, { key: KEY });
    const lines: string[] = [];
    expect(await runCli(['link', NAME], { db, config, print: line => lines.push(line), read: async () => `${KEY}\n` })).toBe(0);
    expect(relay.calls).toEqual([`GET /api/v1/names/${NAME}`]);
    const { hostname, port } = new URL(relay.url);
    const url = `https://${NAME}.${hostname}`;
    expect(lines.join('\n')).toContain(url);
    expect((await app.inject({ url: '/api/link', ...as(ceo) })).json().link).toEqual({ name: NAME, url });
    expect(JSON.parse(readFileSync(tunnelFile, 'utf8'))).toEqual({ url, name: NAME, key: KEY, tunnel: { serverAddr: hostname, serverPort: Number(port), protocol: 'wss' }, mode: 'http', hidden: false });
    expect(statSync(tunnelFile).mode & 0o077).toBe(0);

    /* The key it keeps is the one that frees the link. */
    expect((await app.inject({ method: 'DELETE', url: '/api/link', ...as(ceo) })).statusCode).toBe(204);
    expect(relay.bindings.has(NAME)).toBe(false);
  });

  it('refuses a link hornhoof.org does not hold, a missing key, and a second link', async () => {
    const { db, config, relay, put } = await company();
    const run = async (name: string, key: string) => {
      const lines: string[] = [];
      const code = await runCli(['link', name], { db, config, print: line => lines.push(line), read: async () => key });
      return { code, out: lines.join('\n') };
    };
    const free = await run(NAME, KEY);
    expect(free.code).toBe(1);
    expect(free.out).toContain('has no link');
    relay.bindings.set(NAME, { key: KEY });
    expect((await run(NAME, '  \n')).code).toBe(1);
    expect((await run('Not a name', KEY)).code).toBe(1);
    expect(await db.select().from(publicLinks)).toEqual([]);

    await put({ name: 'acme' });
    const second = await run(NAME, KEY);
    expect(second.code).toBe(1);
    expect(second.out).toContain('https://acme.hornhoof.test');
    expect(second.out).toContain('Remove it under Share access first.');
    expect((await db.select().from(publicLinks)).map(r => r.name)).toEqual(['acme']);
  });
});

describe('the tunnel settings', () => {
  it('follow the database when Hornhoof starts', async () => {
    const { app, put, tunnelFile } = await company();
    await put({ name: 'acme' });
    writeFileSync(tunnelFile, '{}');
    await app.ctx.links.sync();
    expect(JSON.parse(readFileSync(tunnelFile, 'utf8')).url).toBe('https://acme.hornhoof.test');
  });

  it('say whether they were written, and a failure goes to the log', async () => {
    const { app, put, tunnelFile, control } = await company();
    await put({ name: 'acme' });
    expect(await app.ctx.links.sync()).toBe(true);
    rmSync(control, { recursive: true });
    const error = vi.spyOn(app.ctx.log, 'error');
    expect(await app.ctx.links.sync()).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(existsSync(tunnelFile)).toBe(false);
  });

  it('wait for a change of the link under way, so they never write what it replaced', async () => {
    const { app, put, tunnelFile, db } = await company();
    await put({ name: 'acme' });
    const [acme] = await db.select().from(companies);
    const { relay } = app.ctx.links;
    const bind = relay.bind.bind(relay);
    let letBind: () => void = () => {};
    const held = new Promise<void>(resolve => (letBind = resolve));
    const binding = vi.spyOn(relay, 'bind').mockImplementation(async name => {
      await held;
      return bind(name);
    });
    const finished: string[] = [];
    const renamed = app.ctx.links.set(acme!.id, 'globex').then(() => finished.push('rename'));
    await until(() => binding.mock.calls.length === 1);
    const synced = app.ctx.links.sync().then(() => finished.push('sync'));
    letBind();
    await Promise.all([renamed, synced]);
    expect(finished).toEqual(['rename', 'sync']);
    expect(JSON.parse(readFileSync(tunnelFile, 'utf8')).name).toBe('globex');
  });

  it('go when there is no link', async () => {
    const control = mkdtempSync(join(tmpdir(), 'hh-link-'));
    writeFileSync(join(control, 'tunnel.json'), '{"url":"https://old.hornhoof.test"}');
    const { app } = await testApp({ HORNHOOF_CONTROL_DIR: control });
    await app.ready();
    expect(existsSync(join(control, 'tunnel.json'))).toBe(false);
  });
});
