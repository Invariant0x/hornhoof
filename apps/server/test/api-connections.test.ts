import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, subscriptions, turnTokens } from '../src/db/schema.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import type { ModelsAnswer, ModelsRequest } from '../src/modules/subscriptions/api-models.js';
import { BUILTIN } from './builtin.js';
import { as, invitePerson, listen, setUpCompany, testApp } from './helpers.js';

/* A company pays for an API by the token: OpenRouter, or any API at an address a person names that speaks Anthropic's or
   OpenAI's protocol, next to the Claude and OpenAI APIs. Every turn keeps the tokens it used. */

const OPENROUTER_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdefWXYZ';
const CUSTOM_KEY = 'llm-key-0123456789abcdef-Q7R8';
const OWN = [{ id: 'llama-4-maverick', name: 'Llama 4 Maverick' }];

const post = (app: FastifyInstance, token: string, url: string, payload?: object) => app.inject({ method: 'POST', url, payload, ...as(token) });
const addKey = (app: FastifyInstance, token: string, payload: object) => post(app, token, '/api/subscriptions', { kind: 'api_key', target: { kind: 'any' }, ...payload });
const custom = (over: object = {}) => ({ provider: 'custom_api', label: 'Acme LLM', apiKey: CUSTOM_KEY, baseUrl: 'https://llm.acme.example/v1', protocol: 'openai', models: OWN, ...over });
const rowOf = async (app: FastifyInstance, id: string) => (await app.ctx.db.select().from(subscriptions).where(eq(subscriptions.id, id)))[0]!;

/* Maria works in Marketing alone, without company scope. */
async function maria(app: FastifyInstance, ceo: string): Promise<string> {
  const [acme] = await app.ctx.db.select().from(companies);
  const [marketing] = await app.ctx.db.insert(departments).values({ companyId: acme!.id, name: 'Marketing', roleCode: 'CMO' }).returning();
  return invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [marketing!.id] } });
}

/* The model lists the server asks APIs for: a test sees each request and answers it. */
function apis(app: FastifyInstance, answer: (request: ModelsRequest) => ModelsAnswer) {
  const asked: ModelsRequest[] = [];
  app.ctx.readModels = async request => {
    asked.push(request);
    return answer(request);
  };
  return asked;
}

describe('connecting an API that is paid by the token', () => {
  it("connects OpenRouter in Anthropic's protocol unless told otherwise, with the models it was given", async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const models = [{ id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' }];
    const res = await addKey(app, ceo, { provider: 'openrouter', label: 'OpenRouter', apiKey: OPENROUTER_KEY, models });
    expect(res.statusCode).toBe(201);
    const shown = res.json().subscription;
    expect(shown).toMatchObject({ provider: 'openrouter', kind: 'api_key', label: 'OpenRouter', last4: 'WXYZ', api: { baseUrl: 'https://openrouter.ai/api', protocol: 'anthropic' }, models });
    const row = await rowOf(app, shown.id);
    expect(row).toMatchObject({ baseUrl: null, apiProtocol: 'anthropic', models });
    expect(row.secretEnc).toMatch(/^v1\./);
    expect(row.secretEnc).not.toContain(OPENROUTER_KEY);

    const openai = await addKey(app, ceo, { provider: 'openrouter', label: 'OpenRouter for Codex', apiKey: OPENROUTER_KEY, protocol: 'openai', models });
    expect(openai.json().subscription.api).toEqual({ baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai' });
  });

  it('connects a compatible API at the address and in the protocol a person names', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const res = await addKey(app, ceo, custom({ baseUrl: 'https://llm.acme.example/v1/' }));
    expect(res.statusCode).toBe(201);
    const shown = res.json().subscription;
    expect(shown).toMatchObject({ provider: 'custom_api', label: 'Acme LLM', last4: 'Q7R8', api: { baseUrl: 'https://llm.acme.example/v1', protocol: 'openai' }, models: OWN });
    expect(await rowOf(app, shown.id)).toMatchObject({ baseUrl: 'https://llm.acme.example/v1', apiProtocol: 'openai' });
  });

  it('shows the Claude and OpenAI APIs at their own addresses, and a plan at none', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const res = await addKey(app, ceo, { provider: 'openai_api', label: 'OpenAI', apiKey: 'sk-proj-0123456789-abcd' });
    expect(res.json().subscription).toMatchObject({ api: { baseUrl: 'https://api.openai.com/v1', protocol: 'openai' } });
    const all = (await app.inject({ url: '/api/subscriptions', ...as(ceo) })).json().subscriptions;
    expect(all.find((s: { provider: string }) => s.provider === 'anthropic_api').api).toEqual({ baseUrl: 'https://api.anthropic.com', protocol: 'anthropic' });
    await post(app, ceo, '/api/subscriptions/connect', { providers: ['claude'] });
    const plan = (await app.inject({ url: '/api/subscriptions', ...as(ceo) })).json().subscriptions.find((s: { provider: string }) => s.provider === 'claude');
    expect(plan.api).toBeNull();
  });

  it('refuses a compatible API without its address or protocol, a sign-in in the address, and an address or protocol a provider does not take', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const refused = [
      custom({ baseUrl: undefined }),
      custom({ protocol: undefined }),
      custom({ protocol: 'grpc' }),
      custom({ baseUrl: 'https://user:pass@llm.acme.example/v1' }),
      custom({ baseUrl: 'ftp://llm.acme.example/v1' }),
      { provider: 'anthropic_api', label: 'Claude', apiKey: 'sk-ant-api03-0123456789', baseUrl: 'https://proxy.acme.example' },
      { provider: 'openai_api', label: 'OpenAI', apiKey: 'sk-proj-0123456789-abcd', protocol: 'anthropic' },
      { provider: 'openrouter', label: 'OpenRouter', apiKey: OPENROUTER_KEY, baseUrl: 'https://proxy.acme.example' },
    ];
    for (const payload of refused) {
      const res = await addKey(app, ceo, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe('validation');
    }
    expect((await app.ctx.db.select().from(subscriptions)).length).toBe(1);
  });

  it('keeps a compatible API off the internal network unless the server allows its host', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    for (const baseUrl of ['http://10.0.0.7:8000/v1', 'http://127.0.0.1:11434/v1', 'http://localhost:11434/v1', 'http://169.254.169.254/v1', 'http://[::1]:8000/v1', 'http://[::ffff:192.168.1.5]/v1', 'http://ollama.localhost/v1']) {
      const res = await addKey(app, ceo, custom({ baseUrl }));
      expect(res.statusCode, baseUrl).toBe(400);
      expect(res.json().error.reason, baseUrl).toBe('internal_address');
    }
    const allowed = await testApp({ API_INTERNAL_HOSTS: '10.0.0.7, localhost' });
    const owner = await setUpCompany(allowed.app);
    for (const baseUrl of ['http://10.0.0.7:8000/v1', 'http://localhost:11434/v1']) expect((await addKey(allowed.app, owner, custom({ baseUrl }))).statusCode, baseUrl).toBe(201);
    expect((await addKey(allowed.app, owner, custom({ baseUrl: 'http://10.0.0.8:8000/v1' }))).statusCode).toBe(400);
  });

  it('lets company scope change the models, name and reach of a connection, and only that of a key', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const { id } = (await addKey(app, ceo, custom())).json().subscription;
    const models = [...OWN, { id: 'qwen-3-coder', name: 'Qwen 3 Coder' }];
    const res = await app.inject({ method: 'PATCH', url: `/api/subscriptions/${id}`, payload: { models, label: 'Acme models', target: { kind: 'orchestrator' } }, ...as(ceo) });
    expect(res.statusCode).toBe(200);
    expect(res.json().subscription).toMatchObject({ label: 'Acme models', models, place: { kind: 'company' } });
    expect(await rowOf(app, id)).toMatchObject({ label: 'Acme models', models, targetKind: 'orchestrator' });
    const tooMany = Array.from({ length: 101 }, (_, i) => ({ id: `m-${i}`, name: `M ${i}` }));
    expect((await app.inject({ method: 'PATCH', url: `/api/subscriptions/${id}`, payload: { models: tooMany }, ...as(ceo) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/api/subscriptions/${id}`, payload: {}, ...as(ceo) })).statusCode).toBe(400);
    const [plan] = (await post(app, ceo, '/api/subscriptions/connect', { providers: ['claude'] })).json().subscriptions;
    expect((await app.inject({ method: 'PATCH', url: `/api/subscriptions/${plan.id}`, payload: { models }, ...as(ceo) })).statusCode).toBe(400);
  });
});

describe('the models of an API', () => {
  it('loads the list an API gives at its address, with the key in the header its protocol takes', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const asked = apis(app, request => ({
      ok: true,
      body: request.url.hostname === 'openrouter.ai'
        ? { data: [{ id: 'anthropic/claude-sonnet-4.5', name: 'Anthropic: Claude Sonnet 4.5' }, { id: 'meta-llama/llama-4-maverick', name: 'Meta: Llama 4 Maverick' }] }
        : request.headers['x-api-key']
          ? { data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', type: 'model' }], has_more: false }
          : { object: 'list', data: [{ id: 'llama-4-maverick', object: 'model' }, { id: 'qwen-3-coder', object: 'model' }] },
    }));
    const load = (payload: object) => post(app, ceo, '/api/subscriptions/models', payload);

    const openai = await load({ provider: 'custom_api', baseUrl: 'https://llm.acme.example/v1', protocol: 'openai', apiKey: CUSTOM_KEY });
    expect(openai.statusCode).toBe(200);
    expect(openai.json().models).toEqual([{ id: 'llama-4-maverick', name: 'llama-4-maverick' }, { id: 'qwen-3-coder', name: 'qwen-3-coder' }]);
    expect(asked[0]!.url.href).toBe('https://llm.acme.example/v1/models');
    expect(asked[0]!.headers).toMatchObject({ authorization: `Bearer ${CUSTOM_KEY}` });

    const anthropic = await load({ provider: 'custom_api', baseUrl: 'https://llm.acme.example', protocol: 'anthropic', apiKey: CUSTOM_KEY });
    expect(anthropic.json().models).toEqual([{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }]);
    expect(asked[1]!.url.href).toBe('https://llm.acme.example/v1/models');
    expect(asked[1]!.headers).toMatchObject({ 'x-api-key': CUSTOM_KEY, 'anthropic-version': '2023-06-01' });

    const router = await load({ provider: 'openrouter', apiKey: OPENROUTER_KEY });
    expect(router.json().models).toEqual([{ id: 'anthropic/claude-sonnet-4.5', name: 'Anthropic: Claude Sonnet 4.5' }, { id: 'meta-llama/llama-4-maverick', name: 'Meta: Llama 4 Maverick' }]);
    expect(asked[2]!.url.href).toBe('https://openrouter.ai/api/v1/models');
    expect(asked[2]!.headers).toMatchObject({ authorization: `Bearer ${OPENROUTER_KEY}` });
  });

  it("loads a connection's list with its own key, which the person never sends again", async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const { id } = (await addKey(app, ceo, custom())).json().subscription;
    const asked = apis(app, () => ({ ok: true, body: { data: [{ id: 'llama-4-maverick' }] } }));
    const res = await post(app, ceo, `/api/subscriptions/${id}/models`);
    expect(res.statusCode).toBe(200);
    expect(res.json().models).toEqual([{ id: 'llama-4-maverick', name: 'llama-4-maverick' }]);
    expect(asked[0]!.headers.authorization).toBe(`Bearer ${CUSTOM_KEY}`);
    expect(res.body).not.toContain(CUSTOM_KEY);
  });

  it('says why a list did not come, and never asks the internal network unless the server allows its host', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const reasons = ['internal_address', 'redirect', 'too_large', 'timeout', 'unreachable', 'bad_answer'] as const;
    for (const reason of reasons) {
      apis(app, () => ({ ok: false, reason }));
      const res = await post(app, ceo, '/api/subscriptions/models', { provider: 'custom_api', baseUrl: 'https://llm.acme.example/v1', protocol: 'openai', apiKey: CUSTOM_KEY });
      expect(res.statusCode, reason).toBe(400);
      expect(res.json().error.reason, reason).toBe(`models_${reason}`);
    }
    apis(app, () => ({ ok: false, reason: 'refused', status: 401 }));
    const refused = await post(app, ceo, '/api/subscriptions/models', { provider: 'openrouter', apiKey: OPENROUTER_KEY });
    expect(refused.json().error).toMatchObject({ reason: 'models_refused' });
    expect(refused.json().error.message).toContain('401');

    const asked = apis(app, () => ({ ok: true, body: { data: [] } }));
    const inside = await post(app, ceo, '/api/subscriptions/models', { provider: 'custom_api', baseUrl: 'http://192.168.1.20:8000/v1', protocol: 'openai', apiKey: CUSTOM_KEY });
    expect(inside.json().error.reason).toBe('internal_address');
    expect(asked).toEqual([]);
  });

  it('lets only company scope load a list', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const person = await maria(app, ceo);
    const asked = apis(app, () => ({ ok: true, body: { data: [] } }));
    expect((await post(app, person, '/api/subscriptions/models', { provider: 'openrouter', apiKey: OPENROUTER_KEY })).statusCode).toBe(403);
    expect(asked).toEqual([]);
  });
});

describe('the add_api_key tool', () => {
  it('connects any API by the token, with its address, protocol and models', async () => {
    const { app, db } = await testApp();
    await listen(app);
    await setUpCompany(app);
    const [acme] = await db.select().from(companies);
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const token = 'tool-token-api-connections-0123456789';
    await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: orchestrator!.subscriptionId!, agentId: orchestrator!.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(token) });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    onTestFinished(() => client.close());
    const tool = (await client.listTools()).tools.find(t => t.name === 'add_api_key')!;
    const properties = tool.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(properties.provider!.enum).toEqual(['anthropic_api', 'openai_api', 'openrouter', 'custom_api']);
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(['baseUrl', 'protocol', 'models']));
    expect(tool.description).toContain('openrouter');
  });
});

describe("a turn's tokens", () => {
  const TOKENS = { input: 1200, output: 340, cacheRead: 9000, cacheWrite: 150, total: 10_690 };

  async function onKey() {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [acme] = await db.select().from(companies);
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const job = async (over: Partial<typeof jobs.$inferInsert> = {}) =>
      (await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: orchestrator!.subscriptionId!, agentId: orchestrator!.id, kind: 'conversation', prompt: 'hi', timeoutMs: 60_000, status: 'running', startedAt: new Date(), ...over }).returning())[0]!;
    const end = (jobId: string, tokens: object | null | undefined, now: Date) =>
      handleNodeMessage(app.ctx, BUILTIN, { type: 'job.done', jobId, ok: true, sessionId: 'session', result: 'Done.', tail: '', error: null, ...(tokens === undefined ? {} : { tokens }) } as never, now);
    return { app, db, ceo, companyId: acme!.id, orchestrator: orchestrator!, job, end };
  }

  it('keeps what each turn used on its job, agent and connection, and no data where its program told none', async () => {
    const c = await onKey();
    const told = await c.job();
    const silent = await c.job();
    const older = await c.job();
    const test = await c.job({ agentId: null, kind: 'test' });
    const now = new Date('2026-11-15T02:30:00Z');
    await c.end(told.id, TOKENS, now);
    await c.end(silent.id, null, now);
    await c.end(older.id, undefined, now);
    await c.end(test.id, { input: 12, output: 3, cacheRead: null, cacheWrite: null, total: null }, now);
    /* A node sends an end again after a reconnect: the turn is counted once. */
    await c.end(told.id, { ...TOKENS, input: 99_999 }, now);

    const rows = await c.db.select().from(turnTokens);
    const of = (jobId: string) => rows.find(r => r.jobId === jobId);
    expect(rows).toHaveLength(4);
    expect(of(told.id)).toEqual({ jobId: told.id, companyId: c.companyId, agentId: c.orchestrator.id, subscriptionId: c.orchestrator.subscriptionId, inputTokens: 1200, outputTokens: 340, cacheReadTokens: 9000, cacheWriteTokens: 150, totalTokens: 10_690, at: now });
    for (const id of [silent.id, older.id]) expect(of(id)).toMatchObject({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null });
    /* A program that tells some of the counts gets its total from them. */
    expect(of(test.id)).toMatchObject({ agentId: null, inputTokens: 12, outputTokens: 3, cacheReadTokens: null, totalTokens: 15 });
  });

  it("adds up a connection's tokens today, in 7 and 30 days and all along, in, out and cache, with the turns that told none", async () => {
    const c = await onKey();
    const now = new Date('2026-11-15T02:30:00Z');
    c.app.ctx.clock = () => now.getTime();
    const sub = c.orchestrator.subscriptionId!;
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
    const at = async (when: Date, tokens: Partial<typeof turnTokens.$inferInsert>, subscriptionId = sub) => {
      const job = await c.job({ subscriptionId, status: 'done', finishedAt: when });
      await c.db.insert(turnTokens).values({ jobId: job.id, companyId: c.companyId, agentId: c.orchestrator.id, subscriptionId, at: when, ...tokens });
    };
    const turn = (n: number) => ({ inputTokens: n, outputTokens: n / 10, cacheReadTokens: n * 2, cacheWriteTokens: n / 100, totalTokens: n * 3 + n / 10 + n / 100 });
    await at(hoursAgo(1), turn(1000));
    await at(hoursAgo(1), {});
    await at(hoursAgo(4.5), turn(100));
    await at(hoursAgo(72), turn(2000));
    await at(hoursAgo(20 * 24), turn(3000));
    await at(hoursAgo(100 * 24), turn(4000));
    const sum = (ns: number[], noData = 0) => ({
      input: ns.reduce((a, n) => a + n, 0), output: ns.reduce((a, n) => a + n / 10, 0), cacheRead: ns.reduce((a, n) => a + n * 2, 0), cacheWrite: ns.reduce((a, n) => a + n / 100, 0),
      total: ns.reduce((a, n) => a + n * 3 + n / 10 + n / 100, 0), turns: ns.length + noData, noData,
    });

    const utc = (await c.app.inject({ url: `/api/subscriptions/${sub}/tokens?zone=UTC`, ...as(c.ceo) })).json().tokens;
    expect(utc).toEqual({ today: sum([1000], 1), week: sum([1000, 100, 2000], 1), month: sum([1000, 100, 2000, 3000], 1), all: sum([1000, 100, 2000, 3000, 4000], 1) });
    /* Midnight in Moscow came three hours before midnight in London, so the turn of 4.5 hours ago is today there. */
    const moscow = (await c.app.inject({ url: `/api/subscriptions/${sub}/tokens?zone=Europe/Moscow`, ...as(c.ceo) })).json().tokens;
    expect(moscow.today).toEqual(sum([1000, 100], 1));
    expect((await c.app.inject({ url: `/api/subscriptions/${sub}/tokens?zone=Mars/Olympus`, ...as(c.ceo) })).statusCode).toBe(400);

    /* The list gives each connection its sums, and the whole company's come together. */
    const other = (await addKey(c.app, c.ceo, custom())).json().subscription.id;
    await at(hoursAgo(2), turn(500), other);
    const listed = (await c.app.inject({ url: '/api/subscriptions?zone=UTC', ...as(c.ceo) })).json().subscriptions;
    expect(listed.find((s: { id: string }) => s.id === other).tokens).toEqual({ today: sum([500]), week: sum([500]), month: sum([500]), all: sum([500]) });
    expect(listed.find((s: { id: string }) => s.id === sub).tokens.all).toEqual(sum([1000, 100, 2000, 3000, 4000], 1));
    const whole = (await c.app.inject({ url: '/api/tokens?zone=UTC', ...as(c.ceo) })).json().tokens;
    expect(whole.today).toEqual(sum([1000, 500], 1));
    expect(whole.all).toEqual(sum([1000, 100, 2000, 3000, 4000, 500], 1));
  });

  it('shows each person only the tokens of the connections they see', async () => {
    const c = await onKey();
    const person = await maria(c.app, c.ceo);
    const job = await c.job();
    await c.end(job.id, TOKENS, new Date());
    expect((await c.app.inject({ url: `/api/subscriptions/${c.orchestrator.subscriptionId}/tokens`, ...as(person) })).statusCode).toBe(403);
    expect((await c.app.inject({ url: '/api/tokens', ...as(person) })).json().tokens.all).toMatchObject({ total: 0, turns: 0 });
    expect((await c.app.inject({ url: '/api/tokens', ...as(c.ceo) })).json().tokens.all).toMatchObject({ total: 10_690, turns: 1 });
  });
});
