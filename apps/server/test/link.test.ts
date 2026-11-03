import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { decryptSecret } from '../src/crypto/secrets.js';
import { companies, departments, publicLinks } from '../src/db/schema.js';
import { fakeRelay } from './fake-relay.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';

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

describe('binding the company to a public link', () => {
  it('takes the name at the relay, keeps the key encrypted and writes the tunnel settings', async () => {
    const { app, db, config, relay, ceo, put, tunnelFile } = await company();
    expect((await app.inject({ url: '/api/link', ...as(ceo) })).json()).toEqual({ link: null, domain: '127.0.0.1' });
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
    });
    /* The link's key is for the tunnel container alone. */
    expect(statSync(tunnelFile).mode & 0o077).toBe(0);
    expect((await app.inject({ url: '/api/link', ...as(ceo) })).json()).toEqual({ link: { name: 'acme', url: 'https://acme.hornhoof.test' }, domain: '127.0.0.1' });
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
    const kate = await invitePerson(app, ceo, { name: 'Kate', email: 'kate@acme.com', access: { departments: [marketing!.id] } });
    for (const res of [
      await app.inject({ url: '/api/link', ...as(kate) }),
      await app.inject({ url: '/api/link/names/acme', ...as(kate) }),
      await put({ name: 'acme' }, kate),
      await app.inject({ method: 'DELETE', url: '/api/link', ...as(kate) }),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.reason).toBe('company_scope_only');
    }
    expect((await app.inject({ url: '/api/link' })).statusCode).toBe(401);
  });
});

describe('the public link as the address of this Hornhoof', () => {
  it('goes into machine commands, invite links and install.sh, and PUBLIC_URL comes back when it goes', async () => {
    const { app, ceo, put } = await company({ PUBLIC_URL: 'http://localhost:8080' });
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

    await app.inject({ method: 'DELETE', url: '/api/link', ...as(ceo) });
    expect((await app.inject({ url: '/install.sh' })).body).toContain('SERVER="${HORNHOOF_SERVER:-http://localhost:8080}"');
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
    expect(JSON.parse(readFileSync(tunnelFile, 'utf8'))).toEqual({ url, name: NAME, key: KEY, tunnel: { serverAddr: hostname, serverPort: Number(port), protocol: 'wss' } });
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

  it('go when there is no link', async () => {
    const control = mkdtempSync(join(tmpdir(), 'hh-link-'));
    writeFileSync(join(control, 'tunnel.json'), '{"url":"https://old.hornhoof.test"}');
    const { app } = await testApp({ HORNHOOF_CONTROL_DIR: control });
    await app.ready();
    expect(existsSync(join(control, 'tunnel.json'))).toBe(false);
  });
});
