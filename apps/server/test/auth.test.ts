import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { requireCompanyScope, type Person } from '../src/auth/session.js';
import { runCli } from '../src/cli.js';
import { people, sessions } from '../src/db/schema.js';
import { invitePerson, SETUP, sessionFrom, setUpCompany, testApp } from './helpers.js';

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
    onTestFinished(() => vi.useRealTimers());
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
    expect(res.cookies.find(c => c.name === 'hh_session')?.value).toBe('');
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
