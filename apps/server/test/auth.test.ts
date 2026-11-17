import { eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { requireCompanyScope, type Person } from '../src/auth/session.js';
import { hashToken } from '../src/crypto/tokens.js';
import { runCli } from '../src/cli.js';
import { people, sessions } from '../src/db/schema.js';
import { as, invitePerson, listen, openStream, statements, SETUP, sessionFrom, setUpCompany, testApp, TUNNEL, viaLink } from './helpers.js';

/* Lets a test hold one sign-in after its password check, where a reset can slip in before the session starts. */
const pause = vi.hoisted(() => ({ next: undefined as undefined | { checked: () => void; resume: Promise<void> } }));
vi.mock('../src/auth/password.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/auth/password.js')>();
  return {
    ...real,
    verifyPassword: async (password: string, stored: string) => {
      const ok = await real.verifyPassword(password, stored);
      const held = pause.next;
      pause.next = undefined;
      if (held) {
        held.checked();
        await held.resume;
      }
      return ok;
    },
  };
});

const login = (email: string, password: string) => ({ method: 'POST' as const, url: '/api/auth/login', payload: { email, password } });
const me = (token?: string) => ({ url: '/api/me', ...(token ? { cookies: { hh_session: token } } : {}) });

describe('POST /api/auth/login', () => {
  it('logs in with a differently cased, padded email', async () => {
    const { app } = await testApp();
    await setUpCompany(app);
    const res = await app.inject(login(' IVAN@acme.com ', SETUP.password));
    expect(res.statusCode).toBe(200);
    expect(res.json().person).toMatchObject({ name: 'Ivan', email: 'ivan@acme.com', title: 'CEO', scopeKind: 'company' });
    expect(res.body).not.toContain('scrypt');
    expect((await app.inject(me(sessionFrom(res)))).statusCode).toBe(200);
  });

  it('gives the same generic error for a wrong password and an unknown email', async () => {
    const { app } = await testApp();
    await setUpCompany(app);
    for (const res of [await app.inject(login('ivan@acme.com', 'wrong password!')), await app.inject(login('nobody@acme.com', SETUP.password))]) {
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toEqual({ code: 'unauthorized', message: 'Wrong email or password.', reason: 'wrong_password' });
    }
  });

  it('stops the 11th attempt for one email within 15 minutes and leaves other emails alone', async () => {
    const { app } = await testApp();
    await setUpCompany(app);
    for (let i = 0; i < 10; i++) expect((await app.inject(login('ivan@acme.com', 'wrong password!'))).statusCode).toBe(401);
    const blocked = await app.inject(login(' IVAN@acme.com', SETUP.password));
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toMatchObject({ code: 'too_many', reason: 'too_many_attempts' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await app.inject(login('maria@acme.com', SETUP.password))).statusCode).toBe(401);
  });

  it('counts per email and address, so failures from elsewhere never lock the owner out', async () => {
    const { app } = await testApp();
    await setUpCompany(app);
    const from = (remoteAddress: string, password = 'wrong password!') => app.inject({ ...login('ivan@acme.com', password), remoteAddress });
    for (let i = 0; i < 10; i++) expect((await from('203.0.113.5')).statusCode).toBe(401);
    expect((await from('203.0.113.5', SETUP.password)).statusCode).toBe(429);
    expect((await from('198.51.100.20', SETUP.password)).statusCode).toBe(200);
  });

  it("takes the visitor's address from X-Forwarded-For only from the tunnel", async () => {
    const { app } = await testApp({ TUNNEL_HOST: '192.0.2.10' });
    await setUpCompany(app);
    const via = (remoteAddress: string, forwarded: string, password = 'wrong password!') =>
      app.inject({ ...login('ivan@acme.com', password), remoteAddress, headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': forwarded } });
    /* The relay puts the visitor first and its own hop after. */
    for (let i = 0; i < 10; i++) expect((await via('192.0.2.10', '203.0.113.5, 10.0.0.2')).statusCode).toBe(401);
    expect((await via('192.0.2.10', '203.0.113.5, 10.0.0.2', SETUP.password)).statusCode).toBe(429);
    expect((await via('::ffff:192.0.2.10', '198.51.100.20, 10.0.0.2', SETUP.password)).statusCode).toBe(200);
    /* Anyone else can write the header, so it changes nothing for them. */
    for (let i = 0; i < 10; i++) expect((await via('203.0.113.9', `198.51.100.${i}`)).statusCode).toBe(401);
    expect((await via('203.0.113.9', '198.51.100.99', SETUP.password)).statusCode).toBe(429);
  });

  it('counts sign-ins through a worker as one address', async () => {
    const { app } = await testApp({ TUNNEL_HOST: '192.0.2.10' });
    await setUpCompany(app);
    const worker = '11111111-1111-4111-8111-111111111111';
    /* The peer door passes on the forwarded address the worker's side wrote, and the worker's owner writes it as they like. */
    const through = (machine: string, forwarded: string, password = 'wrong password!') =>
      app.inject({ ...login('ivan@acme.com', password), remoteAddress: '192.0.2.10', headers: { 'x-hornhoof-via': machine, 'x-forwarded-for': forwarded } });
    for (let i = 0; i < 10; i++) expect((await through(worker, `203.0.113.${i}`)).statusCode).toBe(401);
    const blocked = await through(worker, '203.0.113.99', SETUP.password);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toMatchObject({ code: 'too_many', reason: 'too_many_attempts' });
    expect((await through('22222222-2222-4222-8222-222222222222', '203.0.113.99', SETUP.password)).statusCode).toBe(200);
    /* The header names a machine only from the keeper's address. */
    const direct = (forwarded: string, password = 'wrong password!') =>
      app.inject({ ...login('maria@acme.com', password), remoteAddress: `198.51.100.${forwarded}`, headers: { 'x-hornhoof-via': worker } });
    for (let i = 0; i < 11; i++) expect((await direct(String(i))).statusCode).toBe(401);
  });

  it('stops one email after 50 attempts in an hour from any addresses, and other emails go on', async () => {
    const { app } = await testApp();
    await setUpCompany(app);
    const from = (remoteAddress: string, email = 'ivan@acme.com', password = 'wrong password!') => app.inject({ ...login(email, password), remoteAddress });
    for (let i = 0; i < 50; i++) expect((await from(`203.0.113.${Math.floor(i / 10)}`)).statusCode).toBe(401);
    const blocked = await from('198.51.100.20', 'ivan@acme.com', SETUP.password);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(15 * 60);
    expect((await from('198.51.100.20', 'maria@acme.com')).statusCode).toBe(401);
  });

  it('deletes expired sessions when someone signs in', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { whole: true } });
    const [row] = await db.select().from(people).where(eq(people.email, 'maria@acme.com'));
    await db.insert(sessions).values({ tokenHash: 'expired-session-hash', personId: row!.id, expiresAt: new Date(Date.now() - 1000) });
    expect((await app.inject(login('ivan@acme.com', SETUP.password))).statusCode).toBe(200);
    const left = await db.select().from(sessions).where(eq(sessions.personId, row!.id));
    expect(left.map(s => s.tokenHash)).not.toContain('expired-session-hash');
    expect(left).toHaveLength(1);
    expect((await app.inject(me(maria))).statusCode).toBe(200);
  });

  it('gives no session to a sign-in that checked the old password while an owner link reset it', async () => {
    const { app, db, config } = await testApp();
    await setUpCompany(app);
    let checked!: () => void, resume!: () => void;
    const reached = new Promise<void>(resolve => (checked = resolve));
    pause.next = { checked, resume: new Promise<void>(resolve => (resume = resolve)) };
    const signingIn = app.inject(login('ivan@acme.com', SETUP.password));
    await reached;

    const lines: string[] = [];
    await runCli(['owner-link'], { db, config, print: line => lines.push(line) });
    resume();
    const res = await signingIn;
    expect(res.statusCode).toBe(401);
    expect(res.json().error.reason).toBe('wrong_password');

    const link = lines.join('\n').match(/\/invite\/([A-Za-z0-9_-]{43})/)![1];
    const accepted = await app.inject({ method: 'POST', url: `/api/invites/${link}/accept`, payload: { password: 'a brand new password' } });
    expect(accepted.statusCode).toBe(200);
    expect(await db.select().from(sessions)).toHaveLength(1);
  });

  it('refuses a disabled person', async () => {
    const { app, db } = await testApp();
    const token = await setUpCompany(app);
    await db.update(people).set({ status: 'disabled' });
    expect((await app.inject(login('ivan@acme.com', SETUP.password))).statusCode).toBe(401);
    expect((await app.inject(me(token))).statusCode).toBe(401);
  });
});

describe('sessions', () => {
  it('last 30 days, with a cookie only the browser sends back over https', async () => {
    const { app, db } = await testApp({ PUBLIC_URL: 'https://hq.acme.com' });
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => { vi.useRealTimers(); });
    const start = new Date('2026-11-01T10:00:00Z');
    vi.setSystemTime(start);
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP });
    const cookie = res.cookies.find(c => c.name === 'hh_session')!;
    const end = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(cookie).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Lax', path: '/', expires: end });
    expect((await db.select().from(sessions)).map(s => s.expiresAt)).toEqual([end]);

    vi.setSystemTime(end.getTime() - 1000);
    expect((await app.inject(me(cookie.value))).statusCode).toBe(200);
    vi.setSystemTime(end.getTime() + 1000);
    expect((await app.inject(me(cookie.value))).statusCode).toBe(401);
  });

  it('send a cookie that also works over plain http when Hornhoof has no https address', async () => {
    const { app } = await testApp({ PUBLIC_URL: 'http://192.168.1.20:8080' });
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP });
    expect(res.cookies.find(c => c.name === 'hh_session')?.secure).toBeFalsy();
  });

  it('send an https-only cookie to whoever came over https through the tunnel, and believe that only from the tunnel', async () => {
    const { app } = await testApp({ TUNNEL_HOST: '192.0.2.10' });
    await setUpCompany(app);
    const signIn = async (remoteAddress: string, headers: Record<string, string> = {}) => {
      const res = await app.inject({ ...login('ivan@acme.com', SETUP.password), remoteAddress, headers });
      expect(res.statusCode).toBe(200);
      const [cookie] = res.cookies;
      return { name: cookie!.name, secure: Boolean(cookie!.secure) };
    };
    const link = { name: '__Host-hh_session', secure: true };
    const local = { name: 'hh_session', secure: false };
    expect(await signIn('192.0.2.10', { 'x-forwarded-proto': 'https' })).toEqual(link);
    expect(await signIn('::ffff:192.0.2.10', { 'x-forwarded-proto': 'https' })).toEqual(link);
    expect(await signIn('192.0.2.10', { 'x-forwarded-proto': 'http' })).toEqual(local);
    expect(await signIn('192.0.2.10')).toEqual(local);
    /* Anyone else can write the header, so it is not believed from them, and plain http to localhost keeps working. */
    expect(await signIn('192.0.2.11', { 'x-forwarded-proto': 'https' })).toEqual(local);
    expect(await signIn('127.0.0.1', { 'x-forwarded-proto': 'https' })).toEqual(local);
    expect(await signIn('127.0.0.1')).toEqual(local);
  });

  it('believe nobody about https while there is no tunnel', async () => {
    const { app } = await testApp();
    await setUpCompany(app);
    const res = await app.inject({ ...login('ivan@acme.com', SETUP.password), headers: { 'x-forwarded-proto': 'https' } });
    expect(res.cookies.find(c => c.name === 'hh_session')?.secure).toBeFalsy();
  });
});

describe('GET /api/me', () => {
  it('returns the person and the company for a valid session', async () => {
    const { app } = await testApp();
    const token = await setUpCompany(app);
    const res = await app.inject(me(token));
    expect(res.statusCode).toBe(200);
    expect(res.json().person).toMatchObject({ email: 'ivan@acme.com', isOwner: true });
    expect(res.json().company).toMatchObject({ name: 'Acme' });
    expect(res.body).not.toContain('passwordHash');
  });

  it('gives 401 without a cookie or with an unknown one', async () => {
    const { app } = await testApp();
    await setUpCompany(app);
    const res = await app.inject(me());
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
    expect((await app.inject(me('made-up-token'))).statusCode).toBe(401);
  });

  it('gives 401 for an expired session', async () => {
    const { app, db } = await testApp();
    const token = await setUpCompany(app);
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await app.inject(me(token))).statusCode).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('ends the session and clears the cookie', async () => {
    const { app, db } = await testApp();
    const token = await setUpCompany(app);
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { hh_session: token } });
    expect(res.statusCode).toBe(204);
    const cleared = res.cookies.find(c => c.name === 'hh_session')!;
    expect(cleared.value).toBe('');
    /* A plain-http address must still be able to sign out, so the clearing carries no Secure. */
    expect(cleared).toMatchObject({ path: '/' });
    expect(cleared.secure).toBeFalsy();
    expect(cleared.expires!.getTime()).toBeLessThan(Date.now());
    expect(await db.select().from(sessions)).toEqual([]);
    expect((await app.inject(me(token))).statusCode).toBe(401);
  });
});

describe('requireCompanyScope', () => {
  it('lets the whole company through and stops a list of departments', async () => {
    const { app, db } = await testApp();
    await setUpCompany(app);
    const [row] = await db.select().from(people).where(eq(people.email, 'ivan@acme.com'));
    const person = row as unknown as Person;
    expect(() => requireCompanyScope(person)).not.toThrow();
    expect(() => requireCompanyScope({ ...person, scopeKind: 'listed' })).toThrow(expect.objectContaining({ status: 403, code: 'forbidden' }));
  });
});

describe('the session cookie over the link', () => {
  const signInViaLink = async (app: Awaited<ReturnType<typeof testApp>>['app']) =>
    sessionFrom(await app.inject({ ...login('ivan@acme.com', SETUP.password), ...viaLink() }));

  it('names the session cookie __Host-hh_session over the link, https only, path / and no domain', async () => {
    const { app } = await testApp({ TUNNEL_HOST: TUNNEL });
    await setUpCompany(app);
    const res = await app.inject({ ...login('ivan@acme.com', SETUP.password), ...viaLink() });
    expect(res.statusCode).toBe(200);
    expect(res.cookies).toHaveLength(1);
    expect(res.cookies[0]).toMatchObject({ name: '__Host-hh_session', secure: true, path: '/', httpOnly: true, sameSite: 'Lax' });
    expect(res.cookies[0]).not.toHaveProperty('domain');
  });

  it('reads only __Host-hh_session over the link and only hh_session elsewhere', async () => {
    const { app } = await testApp({ TUNNEL_HOST: TUNNEL });
    await setUpCompany(app);
    const token = await signInViaLink(app);
    const status = async (extra: InjectOptions) => (await app.inject({ url: '/api/me', ...extra })).statusCode;
    expect(await status(viaLink(token))).toBe(200);
    expect(await status({ ...viaLink(), cookies: { hh_session: token } })).toBe(401);
    expect(await status({ remoteAddress: '127.0.0.1', ...as(token) })).toBe(200);
    expect(await status({ remoteAddress: '127.0.0.1', cookies: { '__Host-hh_session': token } })).toBe(401);
  });

  it('signs out over the link', async () => {
    const { app } = await testApp({ TUNNEL_HOST: TUNNEL });
    await setUpCompany(app);
    const token = await signInViaLink(app);
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout', ...viaLink(token) });
    const header = [res.headers['set-cookie']].flat().find(h => String(h).startsWith('__Host-hh_session='));
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/Path=\//);
    expect(header).not.toMatch(/Domain/i);
    expect(res.cookies.find(c => c.name === '__Host-hh_session')!.expires!.getTime()).toBeLessThan(Date.now());
    expect((await app.inject({ url: '/api/me', ...viaLink(token) })).statusCode).toBe(401);
  });

  it("sets the link's cookie when an invite is accepted over the link", async () => {
    const { app } = await testApp({ TUNNEL_HOST: TUNNEL });
    const ceo = await setUpCompany(app);
    const invited = await app.inject({ method: 'POST', url: '/api/people/invite', payload: { name: 'Maria', email: 'maria@acme.com', title: '', access: { whole: true } }, ...as(ceo) });
    const token = new URL(invited.json().inviteUrl).pathname.split('/').pop();
    const accepted = await app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, payload: { password: SETUP.password }, ...viaLink() });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.cookies[0]).toMatchObject({ name: '__Host-hh_session', secure: true });
  });
});

describe('moving a session from before the switch to __Host-hh_session', () => {
  /* A session of an older install: signed in on localhost, then marked as the migration marks older rows. */
  async function olderSession(tunnelHost = TUNNEL, addRoutes: (app: Awaited<ReturnType<typeof testApp>>['app']) => void = () => {}) {
    const made = await testApp({ TUNNEL_HOST: tunnelHost });
    addRoutes(made.app);
    const token = await setUpCompany(made.app);
    await made.db.update(sessions).set({ beforeHostCookie: true }).where(eq(sessions.tokenHash, hashToken(token)));
    return { ...made, token };
  }
  const withOldCookie = (token: string) => ({ ...viaLink(), cookies: { hh_session: token } });
  const rowOf = async (db: Awaited<ReturnType<typeof testApp>>['db'], token: string) =>
    (await db.select().from(sessions).where(eq(sessions.tokenHash, hashToken(token))))[0];

  /* hh_session must be dropped the way a browser takes for a plain cookie it set itself: expired, path / and secure. */
  const expectOldCookieCleared = (res: { cookies: { name: string; value: string; secure?: boolean; path?: string; domain?: string; expires?: Date }[] }) => {
    const cleared = res.cookies.find(c => c.name === 'hh_session')!;
    expect(cleared).toMatchObject({ value: '', secure: true, path: '/' });
    expect(cleared).not.toHaveProperty('domain');
    expect(cleared.expires!.getTime()).toBeLessThan(Date.now());
  };
  const DAY = 24 * 60 * 60 * 1000;

  it('moves it once', async () => {
    const { app, db, token } = await olderSession();
    const res = await app.inject({ url: '/api/me', ...withOldCookie(token) });
    expect(res.statusCode).toBe(200);
    const fresh = res.cookies.find(c => c.name === '__Host-hh_session')!;
    expect(fresh.value).not.toBe(token);
    expect(fresh).toMatchObject({ secure: true, path: '/' });
    expect(fresh).not.toHaveProperty('domain');
    expectOldCookieCleared(res);
    expect((await app.inject({ url: '/api/me', ...viaLink(fresh.value) })).statusCode).toBe(200);
    const old = await rowOf(db, token);
    expect(old!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
    expect((await rowOf(db, fresh.value))!.beforeHostCookie).toBe(false);
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.tokenHash, hashToken(token)));
    expect((await app.inject({ url: '/api/me', ...withOldCookie(token) })).statusCode).toBe(401);
  });

  it('lets a burst with the old cookie through, into one new session', async () => {
    const { app, db, token } = await olderSession();
    const burst = await Promise.all([1, 2, 3].map(() => app.inject({ url: '/api/me', ...withOldCookie(token) })));
    expect(burst.map(r => r.statusCode)).toEqual([200, 200, 200]);
    /* A page asks for many things at once, each with the old cookie: all of them get the same new one, and no session is
       left that no browser holds. */
    const fresh = burst.map(r => r.cookies.find(c => c.name === '__Host-hh_session')!.value);
    expect(new Set(fresh).size).toBe(1);
    expect(fresh[0]).not.toBe(token);
    expect(await db.select().from(sessions)).toHaveLength(2);
    const later = await app.inject({ url: '/api/me', ...withOldCookie(token) });
    expect(later.cookies.find(c => c.name === '__Host-hh_session')!.value).toBe(fresh[0]);
    expect(await db.select().from(sessions)).toHaveLength(2);
  });

  it('gives each older session a new one of its own, which nobody can work out from the old one', async () => {
    const { app, db, token } = await olderSession();
    /* A second sign-in of the same person from before the switch. */
    const second = sessionFrom(await app.inject({ ...login('ivan@acme.com', SETUP.password), remoteAddress: '127.0.0.1' }));
    await db.update(sessions).set({ beforeHostCookie: true }).where(eq(sessions.tokenHash, hashToken(second)));
    const moved = async (old: string) => (await app.inject({ url: '/api/me', ...withOldCookie(old) })).cookies.find(c => c.name === '__Host-hh_session')!.value;
    const [first, other] = [await moved(token), await moved(second)];
    expect(first).not.toBe(other);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toContain(token);
  });

  it('moves no session made after the switch, expired or of a disabled person', async () => {
    const { app, db, token } = await olderSession();
    const fresh = sessionFrom(await app.inject({ ...login('ivan@acme.com', SETUP.password), remoteAddress: '127.0.0.1' }));
    const refused = async (t: string) => {
      const res = await app.inject({ url: '/api/me', ...withOldCookie(t) });
      expect(res.statusCode).toBe(401);
      expect(res.cookies.find(c => c.name === '__Host-hh_session')).toBeUndefined();
      expectOldCookieCleared(res);
    };
    await refused(fresh);
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.tokenHash, hashToken(token)));
    await refused(token);
    await db.update(sessions).set({ expiresAt: new Date(Date.now() + 60_000) }).where(eq(sessions.tokenHash, hashToken(token)));
    await db.update(people).set({ status: 'disabled' });
    await refused(token);
  });

  it('leaves hh_session alone on localhost', async () => {
    const { app, token } = await olderSession();
    const res = await app.inject({ url: '/api/me', remoteAddress: '127.0.0.1', ...as(token) });
    expect(res.statusCode).toBe(200);
    expect(res.cookies).toHaveLength(0);
  });

  /* What the move set is read against the clock just before and just after the request, whatever the time it took: the new
     session lasts 30 days from the move and the old one a minute from it, by the server's clock or the database's. A cookie
     says its end to the second. */
  it('gives the new cookie the link attributes and the usual 30 days, and takes the old row to a minute at most', async () => {
    const { app, db, token } = await olderSession();
    const before = Date.now();
    const res = await app.inject({ url: '/api/me', ...withOldCookie(token) });
    const after = Date.now();
    const fresh = res.cookies.find(c => c.name === '__Host-hh_session')!;
    expect(fresh).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
    expect(fresh.expires!.getTime()).toBeGreaterThanOrEqual(before + 30 * DAY - 1000);
    expect(fresh.expires!.getTime()).toBeLessThanOrEqual(after + 30 * DAY);
    const row = (await rowOf(db, fresh.value))!.expiresAt.getTime();
    expect(row).toBeGreaterThanOrEqual(before + 30 * DAY);
    expect(row).toBeLessThanOrEqual(after + 30 * DAY);
    const old = (await rowOf(db, token))!.expiresAt.getTime();
    expect(old).toBeGreaterThanOrEqual(before + 60_000);
    expect(old).toBeLessThanOrEqual(after + 60_000);
  });

  it('does not lengthen an old session that ends sooner than a minute', async () => {
    const { app, db, token } = await olderSession();
    /* Half a minute: longer than a test may run, so the session still lives when it is moved, however slow the machine. */
    const soon = new Date(Date.now() + 30_000);
    await db.update(sessions).set({ expiresAt: soon }).where(eq(sessions.tokenHash, hashToken(token)));
    expect((await app.inject({ url: '/api/me', ...withOldCookie(token) })).statusCode).toBe(200);
    expect(await db.select().from(sessions)).toHaveLength(2);
    expect((await rowOf(db, token))!.expiresAt.getTime()).toBe(soon.getTime());
  });

  it("leaves another person's session alone", async () => {
    const { app, db, token } = await olderSession();
    const maria = await invitePerson(app, token, { name: 'Maria', email: 'maria@acme.com', access: { whole: true } });
    await db.update(sessions).set({ beforeHostCookie: true }).where(eq(sessions.tokenHash, hashToken(maria)));
    const before = await rowOf(db, maria);
    await app.inject({ url: '/api/me', ...withOldCookie(token) });
    expect(await rowOf(db, maria)).toEqual(before);
  });

  it('does nothing when the request already carries __Host-hh_session', async () => {
    const { app, db, token } = await olderSession();
    const current = sessionFrom(await app.inject({ ...login('ivan@acme.com', SETUP.password), ...viaLink() }));
    const res = await app.inject({ url: '/api/me', ...viaLink(current), cookies: { hh_session: token, '__Host-hh_session': current } });
    expect(res.statusCode).toBe(200);
    expect(res.cookies).toHaveLength(0);
    expect((await rowOf(db, token))!.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * DAY);
  });

  it('does nothing for a socket upgrade', async () => {
    const { app, db, token } = await olderSession();
    const res = await app.inject({ url: '/api/me', ...withOldCookie(token), headers: { ...viaLink().headers, upgrade: 'websocket' } });
    expect(res.statusCode).toBe(401);
    expect(res.cookies).toHaveLength(0);
    expect((await rowOf(db, token))!.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * DAY);
  });

  it('delivers the new cookie on the event stream, which sends its own headers', async () => {
    const { app, db, token } = await olderSession('127.0.0.1');
    await listen(app);
    const stream = await openStream(app, undefined, { cookie: `hh_session=${token}`, 'x-forwarded-proto': 'https' });
    expect(stream.res.status).toBe(200);
    const header = stream.res.headers.getSetCookie().find(h => h.startsWith('__Host-hh_session='));
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/Path=\//);
    const fresh = decodeURIComponent(header!.split(';')[0]!.split('=')[1]!);
    expect((await rowOf(db, fresh))!.beforeHostCookie).toBe(false);
    expect(stream.res.headers.getSetCookie().some(h => h.startsWith('hh_session=;'))).toBe(true);
  });

  it("holds the person's row, then the session's, before it makes the new session, in one transaction", async () => {
    const { app, db, token } = await olderSession();
    const client = (db as unknown as { $client: { transaction: (...a: unknown[]) => unknown } }).$client;
    const transactions = vi.spyOn(client, 'transaction');
    onTestFinished(() => transactions.mockRestore());
    const seen = statements();
    const res = await app.inject({ url: '/api/me', ...withOldCookie(token) });
    expect(res.statusCode).toBe(200);
    expect(transactions).toHaveBeenCalledTimes(1);
    const at = (test: (s: { sql: string; params: unknown[] }) => boolean) => seen.findIndex(test);
    const people = at(q => /^select .* from "people" where .* for share$/.test(q.sql));
    const session = at(q => /^select .* from "sessions" where .* for update$/.test(q.sql));
    const insert = at(q => q.sql.startsWith('insert into "sessions"'));
    expect(people).toBeGreaterThanOrEqual(0);
    expect(people).toBeLessThan(session);
    expect(session).toBeLessThan(insert);
  });

  it('only clears hh_session when the token is unknown, and makes no session', async () => {
    const { app, db } = await olderSession();
    const before = await db.select().from(sessions);
    const res = await app.inject({ url: '/api/me', ...withOldCookie('no-such-token') });
    expect(res.statusCode).toBe(401);
    expect(res.cookies.map(c => c.name)).toEqual(['hh_session']);
    expect(await db.select().from(sessions)).toEqual(before);
  });

  it('delivers the cookies of a route that hijacks the reply and sends only a status', async () => {
    const { app, token } = await olderSession(TUNNEL, app =>
      app.get('/hijacked', (_req, reply) => {
        reply.hijack();
        reply.raw.writeHead(200);
        reply.raw.end('x');
      }),
    );
    const res = await app.inject({ url: '/hijacked', ...withOldCookie(token) });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.map(c => c.name).sort()).toEqual(['__Host-hh_session', 'hh_session']);
  });

  describe('a request that decides the session cookie itself', () => {
    const linkCookies = (res: { cookies: { name: string; value: string }[] }) => res.cookies.filter(c => c.name === '__Host-hh_session');
    const rowsOf = (db: Awaited<ReturnType<typeof testApp>>['db'], personId: string) => db.select().from(sessions).where(eq(sessions.personId, personId));

    it('signs in with one __Host-hh_session and no session made for the older cookie', async () => {
      const { app, db, token } = await olderSession();
      const res = await app.inject({ ...login('ivan@acme.com', SETUP.password), ...withOldCookie(token) });
      expect(res.statusCode).toBe(200);
      expect(linkCookies(res)).toHaveLength(1);
      const mine = (await rowOf(db, linkCookies(res)[0]!.value))!;
      expect(await rowsOf(db, mine.personId)).toHaveLength(2);
      expect((await rowOf(db, token))!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
    });

    it("accepts an invite with one __Host-hh_session, Maria's, and none made for the person of the older cookie", async () => {
      const { app, db, token } = await olderSession();
      const invited = await app.inject({ method: 'POST', url: '/api/people/invite', payload: { name: 'Maria', email: 'maria@acme.com', title: '', access: { whole: true } }, ...as(token) });
      const invite = new URL(invited.json().inviteUrl).pathname.split('/').pop();
      const res = await app.inject({ method: 'POST', url: `/api/invites/${invite}/accept`, payload: { password: SETUP.password }, ...withOldCookie(token) });
      expect(res.statusCode).toBe(200);
      expect(linkCookies(res)).toHaveLength(1);
      const maria = (await rowOf(db, linkCookies(res)[0]!.value))!;
      expect(maria.personId).toBe(res.json().person.id);
      const ivan = (await db.select().from(sessions)).filter(r => r.personId !== maria.personId);
      expect(ivan).toHaveLength(1);
      expect(ivan[0]!.tokenHash).toBe(hashToken(token));
    });

    it('signs out with one expired __Host-hh_session and leaves no session of the person', async () => {
      const { app, db, token } = await olderSession();
      const res = await app.inject({ method: 'POST', url: '/api/auth/logout', ...withOldCookie(token) });
      expect(res.statusCode).toBe(204);
      expect(linkCookies(res)).toHaveLength(1);
      expect(linkCookies(res)[0]).toMatchObject({ value: '' });
      expect(await db.select().from(sessions)).toEqual([]);
      expect((await app.inject({ url: '/api/me', ...withOldCookie(token) })).statusCode).toBe(401);
    });
  });
});
