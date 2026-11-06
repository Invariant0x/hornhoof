import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { ModelIdentity, ProviderId } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../src/crypto/secrets.js';
import { subscriptions } from '../src/db/schema.js';
import { FRESH_INFERENCE_HASH, freshModelCheck } from '../src/modules/jobs/dispatch.js';
import { company as companyWithAKey } from './department-owner-fixture.js';

type C = Awaited<ReturnType<typeof companyWithAKey>>;

/* A company with no key of any provider yet: each test gives the ones it is about. */
async function company(): Promise<C> {
  const c = await companyWithAKey();
  await c.db.update(subscriptions).set({ removedAt: new Date() });
  return c;
}

/* A vendor's API stands in here as a real HTTP server on this machine, with a synthetic key, so a call is seen as it really goes. */
const KEY = 'synthetic-model-key-77c1';
const SYSTEM = 'You check one message. Answer with JSON only.';
const USER = '{"message":"Quoted, untrusted words."}';
const OUTPUT = '{"kind":"review","decision":"allow","reasonCodes":[]}';

type Heard = { url: string; headers: IncomingMessage['headers']; body: Record<string, unknown> };
type Answer = (response: ServerResponse) => void;

const json = (status: number, value: unknown): Answer => response => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};

const closing: (() => void)[] = [];
afterEach(() => {
  closing.splice(0).forEach(close => close());
  vi.restoreAllMocks();
});

async function vendor(answer: Answer) {
  const heard: Heard[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      heard.push({ url: String(request.url), headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
      answer(response);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  closing.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { heard, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/call` };
}

const CLAUDE: ModelIdentity = { providerId: 'anthropic_api', vendorId: 'anthropic', modelId: 'claude-check', revisionId: 'claude-check-20260101', inferenceConfigHash: FRESH_INFERENCE_HASH };
const GPT: ModelIdentity = { providerId: 'openai_api', vendorId: 'openai', modelId: 'gpt-check', revisionId: 'gpt-check-2026-01-01', inferenceConfigHash: FRESH_INFERENCE_HASH };
const FROM_CLAUDE = { model: CLAUDE.revisionId, content: [{ type: 'text', text: OUTPUT }], stop_reason: 'end_turn' };
const FROM_GPT = { model: GPT.revisionId, choices: [{ message: { role: 'assistant', content: OUTPUT }, finish_reason: 'stop' }] };

async function aKey(c: C, provider: ProviderId, secret = KEY) {
  const [plan] = await c.db.select().from(subscriptions).limit(1);
  const [made] = await c.db.insert(subscriptions).values({ companyId: c.companyId, provider, kind: 'api_key', label: `${provider} key`, ownerPersonId: plan!.ownerPersonId, secretEnc: encryptSecret(secret, c.app.ctx.config.secret), last4: secret.slice(-4), status: plan!.status }).returning();
  return made!;
}

const ask = (c: C, url: string, expectedModel: ModelIdentity, timeoutMs = 2000) =>
  freshModelCheck(c.app.ctx, { endpoints: { anthropic_api: url, openai_api: url }, timeoutMs })({ kind: 'outbound_review', expectedModel, systemPrompt: SYSTEM, userPayload: USER });

const UNAVAILABLE = { status: 'unavailable' };

describe('a fresh call for a model check', () => {
  it('asks Anthropic\'s API with one system and one user message: no tools, no session, no history of anyone', async () => {
    const c = await company();
    await aKey(c, 'anthropic_api');
    const api = await vendor(json(200, FROM_CLAUDE));
    const said = await ask(c, api.url, CLAUDE);
    expect(said).toEqual({ status: 'ok', reviewer: CLAUDE, rawOutput: OUTPUT, isolated: true });
    expect(api.heard).toHaveLength(1);
    expect(api.heard[0]!.headers['x-api-key']).toBe(KEY);
    expect(api.heard[0]!.headers['anthropic-version']).toBeTruthy();
    expect(api.heard[0]!.body).toEqual({ model: 'claude-check', max_tokens: 1024, temperature: 0, system: SYSTEM, messages: [{ role: 'user', content: USER }] });
  });

  it('asks OpenAI\'s API the same way', async () => {
    const c = await company();
    await aKey(c, 'openai_api');
    const api = await vendor(json(200, FROM_GPT));
    const said = await ask(c, api.url, GPT);
    expect(said).toEqual({ status: 'ok', reviewer: GPT, rawOutput: OUTPUT, isolated: true });
    expect(api.heard[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(api.heard[0]!.body).toEqual({ model: 'gpt-check', max_completion_tokens: 1024, temperature: 0, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: USER }] });
  });

  it('never goes through a node: a job would come with its program\'s own tools', async () => {
    const c = await company();
    await aKey(c, 'anthropic_api');
    const api = await vendor(json(200, FROM_CLAUDE));
    const send = vi.spyOn(c.app.ctx.hub, 'send');
    await ask(c, api.url, CLAUDE);
    expect(send).not.toHaveBeenCalled();
  });

  it('takes the oldest key of the provider, so the same one answers every time', async () => {
    const c = await company();
    await aKey(c, 'anthropic_api', 'synthetic-older-key');
    await aKey(c, 'anthropic_api', 'synthetic-newer-key');
    const api = await vendor(json(200, FROM_CLAUDE));
    await ask(c, api.url, CLAUDE);
    expect(api.heard[0]!.headers['x-api-key']).toBe('synthetic-older-key');
  });

  it('is unavailable when the model that answered is not the one certified: an alias moved', async () => {
    const c = await company();
    await aKey(c, 'anthropic_api');
    const api = await vendor(json(200, { ...FROM_CLAUDE, model: 'claude-check-20270101' }));
    expect(await ask(c, api.url, CLAUDE)).toEqual(UNAVAILABLE);
  });

  it.each<[string, ModelIdentity]>([
    ['a plan on a machine, whose program has tools', { ...CLAUDE, providerId: 'claude' }],
    ['a plan of another vendor on a machine', { ...GPT, providerId: 'codex' }],
    ['a vendor it cannot prove', { ...CLAUDE, vendorId: 'someone' }],
    ['settings other than the ones it calls with', { ...CLAUDE, inferenceConfigHash: 'a'.repeat(64) }],
    ['a provider with no direct call', { ...CLAUDE, providerId: 'kimi', vendorId: 'moonshot' }],
  ])('is unavailable without calling anyone for %s', async (_name, expected) => {
    const c = await company();
    await aKey(c, 'anthropic_api');
    await aKey(c, 'openai_api');
    const api = await vendor(json(200, FROM_CLAUDE));
    expect(await ask(c, api.url, expected)).toEqual(UNAVAILABLE);
    expect(api.heard).toEqual([]);
  });

  it('is unavailable with no key of that provider, or one taken away', async () => {
    const c = await company();
    const api = await vendor(json(200, FROM_CLAUDE));
    expect(await ask(c, api.url, CLAUDE)).toEqual(UNAVAILABLE);
    const key = await aKey(c, 'anthropic_api');
    await c.db.update(subscriptions).set({ removedAt: new Date() }).where(eq(subscriptions.id, key.id));
    expect(await ask(c, api.url, CLAUDE)).toEqual(UNAVAILABLE);
    expect(api.heard).toEqual([]);
  });

  it.each<[string, Answer]>([
    ['refuses', json(401, { error: { message: `bad key ${KEY}` } })],
    ['fails', json(500, {})],
    ['answers with no words', json(200, { ...FROM_CLAUDE, content: [] })],
    ['tries to use a tool', json(200, { ...FROM_CLAUDE, content: [{ type: 'tool_use', name: 'bash', input: {} }] })],
    ['answers something else', json(200, { nothing: true })],
    ['does not answer in JSON', response => { response.writeHead(200); response.end('<html>'); }],
    ['redirects', response => { response.writeHead(307, { location: 'http://127.0.0.1:1/elsewhere' }); response.end(); }],
    ['goes quiet', () => undefined],
    ['hangs up', response => { response.destroy(); }],
  ])('is unavailable, with nothing of what was said, when the vendor %s', async (_name, answer) => {
    const c = await company();
    await aKey(c, 'anthropic_api');
    const api = await vendor(answer);
    const said = await ask(c, api.url, CLAUDE, 200);
    expect(said).toEqual(UNAVAILABLE);
    expect(JSON.stringify(said)).not.toContain(KEY);
    expect(api.heard).toHaveLength(1);
  });

  it('is unavailable when nothing listens', async () => {
    const c = await company();
    await aKey(c, 'anthropic_api');
    expect(await ask(c, 'http://127.0.0.1:1/v1/call', CLAUDE, 200)).toEqual(UNAVAILABLE);
  });

  it('goes to the vendor\'s own address when nobody says otherwise, and only there', async () => {
    const c = await company();
    await aKey(c, 'openai_api');
    const fetching = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FROM_GPT), { status: 200 }));
    const said = await freshModelCheck(c.app.ctx)({ kind: 'outbound_review', expectedModel: GPT, systemPrompt: SYSTEM, userPayload: USER });
    expect(said).toMatchObject({ status: 'ok' });
    expect(fetching.mock.calls[0]![0]).toBe('https://api.openai.com/v1/chat/completions');
    expect(fetching.mock.calls[0]![1]).toMatchObject({ method: 'POST', redirect: 'error' });
  });
});
