import { describe, expect, it } from 'vitest';
import { decryptSecret } from '../src/crypto/secrets.js';
import { agents, companies, people, subscriptions } from '../src/db/schema.js';
import { SETUP, TEST_API_KEY as KEY, testApp } from './helpers.js';

describe('GET /api/setup', () => {
  it('says setup is needed until a company exists', async () => {
    const { app } = await testApp();
    expect((await app.inject({ url: '/api/setup' })).json()).toEqual({ needed: true });
    await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP });
    expect((await app.inject({ url: '/api/setup' })).json()).toEqual({ needed: false });
  });
});

describe('POST /api/setup', () => {
  it('creates the company, the CEO, the chief and an encrypted API key', async () => {
    const { app, db, config } = await testApp();
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(KEY);

    const body = res.json();
    expect(body.company.name).toBe('Acme');
    expect(body.person).toMatchObject({ name: 'Ivan', email: 'ivan@acme.com', title: 'CEO' });
    expect(body.joinCode).toBeUndefined();

    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/hh_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).not.toMatch(/Secure/);

    const [ceo] = await db.select().from(people);
    expect(ceo).toMatchObject({ isOwner: true, scopeKind: 'company', status: 'active' });
    const [chief] = await db.select().from(agents);
    expect(chief).toMatchObject({ kind: 'chief', name: 'Chief' });
    const [sub] = await db.select().from(subscriptions);
    expect(sub).toMatchObject({ kind: 'api_key', status: 'active', targetKind: 'chief', last4: '9f3a', label: 'Chief' });
    expect(chief!.subscriptionId).toBe(sub!.id);
    expect(decryptSecret(sub!.secretEnc!, config.secret)).toBe(KEY);
  });

  it('returns a join code for a personal subscription', async () => {
    const { app, db } = await testApp();
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, chief: { mode: 'personal', provider: 'claude' } } });
    expect(res.statusCode).toBe(201);
    expect(res.json().joinCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [sub] = await db.select().from(subscriptions);
    expect(sub).toMatchObject({ kind: 'personal', provider: 'claude', status: 'waiting_machine', secretEnc: null });
    expect(sub!.joinCodeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('tells the browser which address the node should join', async () => {
    const { app } = await testApp({ PUBLIC_URL: 'https://hq.acme.com/' });
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, chief: { mode: 'personal', provider: 'kimi' } } });
    expect(res.json().serverUrl).toBe('https://hq.acme.com');
  });

  it('lets the chief wait for a subscription', async () => {
    const { app, db } = await testApp();
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, chief: { mode: 'later' } } });
    expect(res.statusCode).toBe(201);
    expect(await db.select().from(subscriptions)).toEqual([]);
    const [chief] = await db.select().from(agents);
    expect(chief!.subscriptionId).toBeNull();
  });

  it('refuses a second setup', async () => {
    const { app } = await testApp();
    await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP });
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('conflict');
  });

  it('creates one company when two setups race', async () => {
    const { app, db } = await testApp();
    const results = await Promise.all([
      app.inject({ method: 'POST', url: '/api/setup', payload: SETUP }),
      app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, email: 'other@acme.com' } }),
    ]);
    expect(results.map(r => r.statusCode).sort()).toEqual([201, 409]);
    expect(await db.select().from(companies)).toHaveLength(1);
  });

  it('rejects a short password', async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, password: 'short' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
  });
});
