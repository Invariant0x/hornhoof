import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decryptSecret } from '../src/crypto/secrets.js';
import { eq } from 'drizzle-orm';
import { agents, companies, departments, nodeCodes, people, publicLinks, subscriptions } from '../src/db/schema.js';
import { setupCode } from '../src/modules/setup/code.js';
import { fakeRelay } from './fake-relay.js';
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
  it('says setup is needed until a company exists, and where public links live', async () => {
    const { app } = await testApp();
    expect((await app.inject({ url: '/api/setup' })).json()).toEqual({ needed: true, linkDomain: 'hornhoof.org', recovering: false });
    await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP });
    expect((await app.inject({ url: '/api/setup' })).json()).toEqual({ needed: false, linkDomain: 'hornhoof.org', recovering: false });
  });
});

/* A fresh Hornhoof with its own control folder, asking the fake relay for links. */
async function fresh(env: NodeJS.ProcessEnv = {}) {
  const relay = await fakeRelay();
  const control = mkdtempSync(join(tmpdir(), 'hh-setup-'));
  return { relay, control, ...(await testApp({ RELAY_URL: relay.url, HORNHOOF_CONTROL_DIR: control, ...env })) };
}

describe('GET /api/setup/names/:name', () => {
  it('checks a name for the public link with the setup code, and only until the company is set up', async () => {
    const { app, relay } = await fresh();
    relay.bindings.set('globex', { key: 'k' });
    expect((await app.inject({ url: `/api/setup/names/acme?code=${SETUP.code}` })).json()).toEqual({ name: 'acme', free: true });
    expect((await app.inject({ url: `/api/setup/names/globex?code=${SETUP.code}` })).json()).toEqual({ name: 'globex', free: false, reason: 'taken' });
    const wrong = await app.inject({ url: '/api/setup/names/acme?code=wrong' });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.reason).toBe('setup_code');
    expect(relay.calls).toEqual(['GET /api/v1/names/acme', 'GET /api/v1/names/globex']);
    await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP });
    expect((await app.inject({ url: `/api/setup/names/acme?code=${SETUP.code}` })).statusCode).toBe(409);
  });
});

describe('POST /api/setup with a company template', () => {
  it('creates the template departments and products with the company, and their people', async () => {
    const { app, db } = await fresh();
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, template: 'studio' } });
    expect(res.statusCode).toBe(201);
    const [company] = await db.select().from(companies);
    expect(company!.template).toBe('studio');
    const depts = await db.select().from(departments).where(eq(departments.companyId, company!.id));
    /* Studio: operations, development, and development's three products under it. */
    const top = depts.filter(d => !d.parentId);
    expect(top.map(d => d.templateKey).sort()).toEqual(['development', 'operations']);
    const dev = top.find(d => d.templateKey === 'development')!;
    expect(depts.filter(d => d.parentId === dev.id).map(d => d.name).sort()).toEqual(['Product 1', 'Product 2', 'Product 3']);
    /* The studio's staff includes all pipeline owners and the single-member Hotfix team, in the departments themselves. */
    const staff = await db.select().from(agents).where(eq(agents.companyId, company!.id));
    expect(staff.map(a => a.roleKey ?? a.kind).sort()).toEqual(['DEV-ARCH', 'DEV-DOCS', 'DEV-ENG', 'DEV-ENG', 'DEV-ENG', 'DEV-ENG', 'DEV-HEAD', 'DEV-OPS', 'DEV-PM', 'DEV-REV', 'DEV-REV', 'DEV-SEC', 'DEV-TEST', 'OPS-ACCT', 'OPS-BUGS', 'OPS-FIX', 'OPS-FIX', 'OPS-HEAD', 'OPS-INTEG', 'OPS-PM', 'OPS-PROGRAM', 'OPS-WATCH', 'orchestrator']);
    expect(staff.filter(a => a.kind !== 'orchestrator').every(a => a.departmentId !== null && a.productId === null)).toBe(true);
  });

  it('starts with only Operations and stores no template when none is picked', async () => {
    const { app, db } = await fresh();
    await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP });
    const [company] = await db.select().from(companies);
    expect(company!.template).toBeNull();
    expect((await db.select().from(departments).where(eq(departments.companyId, company!.id))).map(d => d.templateKey)).toEqual(['operations']);
  });

  it('refuses a template that is not one of the ready-made ones', async () => {
    const { app } = await fresh();
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, template: 'cafe' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/setup with a public link', () => {
  it('takes the link with the company and gives it as the address of the machine command', async () => {
    const { app, db, config, relay, control } = await fresh();
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, link: { name: 'acme' }, orchestrator: { mode: 'personal', provider: 'claude' } } });
    expect(res.statusCode).toBe(201);
    expect(res.json().link).toEqual({ name: 'acme', url: 'https://acme.hornhoof.test' });
    expect(res.json().command).toMatch(/^curl -fsSL https:\/\/acme\.hornhoof\.test\/install\.sh \| bash -s -- --join /);
    const [row] = await db.select().from(publicLinks);
    const [acme] = await db.select().from(companies);
    expect(row).toMatchObject({ companyId: acme!.id, name: 'acme' });
    expect(decryptSecret(row!.keyEnc, config.secret)).toBe(relay.bindings.get('acme')!.key);
    expect(JSON.parse(readFileSync(join(control, 'tunnel.json'), 'utf8')).url).toBe('https://acme.hornhoof.test');
  });

  it('takes a long random link when no name is given', async () => {
    const { app } = await fresh();
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, link: {} } });
    expect(res.statusCode).toBe(201);
    expect(res.json().link.name).toMatch(/^[a-z0-9]{20,}$/);
  });

  it('asks the relay for nothing without a link', async () => {
    const { app, db, relay, control } = await fresh();
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP });
    expect(res.statusCode).toBe(201);
    expect(res.json().link).toBeUndefined();
    expect(relay.calls).toEqual([]);
    expect(await db.select().from(publicLinks)).toEqual([]);
    expect(existsSync(join(control, 'tunnel.json'))).toBe(false);
  });

  it('sets nothing up when the name is taken or hornhoof.org does not answer', async () => {
    const { app, db, relay } = await fresh();
    relay.bindings.set('globex', { key: 'k' });
    const taken = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, link: { name: 'globex' } } });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.reason).toBe('link_taken');
    relay.down = true;
    const down = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, link: { name: 'acme' } } });
    expect(down.statusCode).toBe(503);
    expect(down.json().error.reason).toBe('relay_unreachable');
    expect(await db.select().from(companies)).toEqual([]);
    expect(down.headers['set-cookie']).toBeUndefined();
  });

  it('asks the relay for nothing without the setup code', async () => {
    const { app, relay } = await fresh();
    expect((await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, code: 'wrong', link: { name: 'acme' } } })).statusCode).toBe(403);
    expect(relay.calls).toEqual([]);
  });

  it('lets the link of a setup that lost a race go', async () => {
    const { app, db, relay } = await fresh();
    const results = await Promise.all([
      app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, link: { name: 'acme' } } }),
      app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, email: 'other@acme.com', link: { name: 'acme-two' } } }),
    ]);
    expect(results.map(r => r.statusCode).sort()).toEqual([201, 409]);
    const [kept] = await db.select().from(publicLinks);
    expect([...relay.bindings.keys()]).toEqual([kept!.name]);
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

  it('accepts a Google AI plan, which Antigravity CLI runs, as the personal orchestrator', async () => {
    const { app, db } = await testApp();
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, orchestrator: { mode: 'personal', provider: 'antigravity' } } });
    expect(res.statusCode).toBe(201);
    const [sub] = await db.select().from(subscriptions);
    expect(sub).toMatchObject({ kind: 'personal', provider: 'antigravity', label: 'Antigravity', status: 'waiting_machine' });
    const [orchestrator] = await db.select().from(agents);
    expect(orchestrator).toMatchObject({ subscriptionId: sub!.id });
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
    const withoutCode: Partial<typeof SETUP> = { ...SETUP };
    delete withoutCode.code;
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
