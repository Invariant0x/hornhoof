import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { requireCompanyScope, type Person } from '../src/auth/session.js';
import { people, sessions } from '../src/db/schema.js';
import { invitePerson, SETUP, sessionFrom, setUpCompany, testApp } from './helpers.js';

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

  it('refuses a disabled person', async () => {
    const { app, db } = await testApp();
    const token = await setUpCompany(app);
    await db.update(people).set({ status: 'disabled' });
    expect((await app.inject(login('ivan@acme.com', SETUP.password))).statusCode).toBe(401);
    expect((await app.inject(me(token))).statusCode).toBe(401);
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
