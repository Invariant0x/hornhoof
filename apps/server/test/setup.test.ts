import { describe, expect, it } from 'vitest';
import { decryptSecret } from '../src/crypto/secrets.js';
import { agents, companies, nodeCodes, people, subscriptions } from '../src/db/schema.js';
import { setupCode } from '../src/modules/setup/code.js';
import { SETUP, TEST_API_KEY as KEY, TEST_SECRET, testApp } from './helpers.js';

describe('setup code', () => {
  it('stays the same for a server across restarts and differs between servers', () => {
    const secret = Buffer.from(TEST_SECRET, 'base64');
    expect(setupCode(secret)).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(setupCode(Buffer.from(TEST_SECRET, 'base64'))).toBe(setupCode(secret));
    expect(setupCode(Buffer.alloc(32, 8))).not.toBe(setupCode(secret));
    /* It says nothing about the secret it comes from. */
    expect(setupCode(secret)).not.toContain(TEST_SECRET.slice(0, 8));
  });
});

describe('GET /api/setup', () => {
  it('says setup is needed until a company exists', async () => {
    const { app } = await testApp();
    expect((await app.inject({ url: '/api/setup' })).json()).toEqual({ needed: true });
    await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP });
    expect((await app.inject({ url: '/api/setup' })).json()).toEqual({ needed: false });
  });
});

describe('POST /api/setup', () => {
  it('creates the company, the CEO, the orchestrator and an encrypted API key', async () => {
    const { app, db, config } = await testApp();
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(KEY);

    const body = res.json();
    expect(body.company.name).toBe('Acme');
    expect(body.person).toMatchObject({ name: 'Ivan', email: 'ivan@acme.com', title: 'CEO' });
    expect(body.command).toBeUndefined();

    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/hh_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).not.toMatch(/Secure/);

    const [ceo] = await db.select().from(people);
    expect(ceo).toMatchObject({ isOwner: true, scopeKind: 'company', status: 'active' });
    const [orchestrator] = await db.select().from(agents);
    expect(orchestrator).toMatchObject({ kind: 'orchestrator', name: 'Orchestrator' });
    const [sub] = await db.select().from(subscriptions);
    expect(sub).toMatchObject({ kind: 'api_key', status: 'ready', targetKind: 'any', last4: '9f3a', label: 'Orchestrator' });
    expect(orchestrator!.subscriptionId).toBe(sub!.id);
    expect(decryptSecret(sub!.secretEnc!, config.secret)).toBe(KEY);
  });

  it('answers the install command for a personal subscription', async () => {
    const { app, db } = await testApp();
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, orchestrator: { mode: 'personal', provider: 'claude' } } });
    expect(res.statusCode).toBe(201);
    const { command } = res.json();
    expect(command).toMatch(/^curl -fsSL http:\/\/localhost:8080\/install\.sh \| bash -s -- --join [A-Za-z0-9_-]{43}$/);
    const [sub] = await db.select().from(subscriptions);
    expect(sub).toMatchObject({ kind: 'personal', provider: 'claude', status: 'waiting_machine', secretEnc: null, targetKind: null, targetId: null });
    const codes = await db.select().from(nodeCodes);
    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatchObject({ subscriptionIds: [sub!.id], usedAt: null });
    expect(codes[0]!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body).not.toContain(codes[0]!.codeHash);
  });

  it('builds the command from the public address', async () => {
    const { app } = await testApp({ PUBLIC_URL: 'https://hq.acme.com/' });
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, orchestrator: { mode: 'personal', provider: 'kimi' } } });
    expect(res.json().command).toMatch(/^curl -fsSL https:\/\/hq\.acme\.com\/install\.sh \| bash -s -- --join /);
  });

  it('stores the title the CEO typed, and CEO when it is empty', async () => {
    const first = await testApp();
    const res = await first.app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, title: '  Founder  ' } });
    expect(res.json().person.title).toBe('Founder');
    const [founder] = await first.db.select().from(people);
    expect(founder!.title).toBe('Founder');

    const second = await testApp();
    await second.app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, title: '   ' } });
    const [ceo] = await second.db.select().from(people);
    expect(ceo!.title).toBe('CEO');
  });

  it('refuses a title over 80 characters', async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, title: 'x'.repeat(81) } });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a GLM Coding Plan as the personal orchestrator', async () => {
    const { app, db } = await testApp();
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, orchestrator: { mode: 'personal', provider: 'glm' } } });
    expect(res.statusCode).toBe(201);
    expect(res.json().command).toMatch(/--join /);
    const [sub] = await db.select().from(subscriptions);
    expect(sub).toMatchObject({ kind: 'personal', provider: 'glm', label: 'GLM', status: 'waiting_machine' });
    const [orchestrator] = await db.select().from(agents);
    expect(orchestrator).toMatchObject({ subscriptionId: sub!.id, model: 'glm-5.3' });
  });

  it('lets the orchestrator wait for a subscription', async () => {
    const { app, db } = await testApp();
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, orchestrator: { mode: 'later' } } });
    expect(res.statusCode).toBe(201);
    expect(await db.select().from(subscriptions)).toEqual([]);
    const [orchestrator] = await db.select().from(agents);
    expect(orchestrator!.subscriptionId).toBeNull();
  });

  it('refuses a second setup', async () => {
    const { app } = await testApp();
    await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP });
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('conflict');
    const { code: _, ...withoutCode } = SETUP;
    expect((await app.inject({ method: 'POST', url: '/api/setup', payload: withoutCode })).statusCode).toBe(409);
  });

  /* The port is open to everyone, so whoever opens a fresh Hornhoof first must not become its owner. */
  it('sets up only with the code from the setup link', async () => {
    const { app, db } = await testApp();
    const { code, ...withoutCode } = SETUP;
    for (const payload of [withoutCode, { ...SETUP, code: '' }, { ...SETUP, code: 'x'.repeat(code.length) }, { ...SETUP, code: `${code}x` }]) {
      const res = await app.inject({ method: 'POST', url: '/api/setup', payload });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatchObject({ code: 'forbidden', reason: 'setup_code' });
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect(await db.select().from(companies)).toEqual([]);
    expect(await db.select().from(people)).toEqual([]);
    expect((await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP })).statusCode).toBe(201);
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
