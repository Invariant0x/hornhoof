import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { SqlMode } from '../src/db/agent-sql.js';
import { companies, subscriptions } from '../src/db/schema.js';
import { agentSqlOn, as, setUpCompany, testApp } from './helpers.js';
import { createTestDb } from './helpers-db.js';

/* A company's API key lives encrypted in the database alone: no answer of the API, no event, no log line and no agent's
   SQL holds it, only its last 4 characters. */

const ROUTER_KEY = 'sk-or-v1-secret-router-key-0123456789-WXYZ';
const CUSTOM_KEY = 'llm-secret-custom-key-0123456789-Q7R8';
/* The parts of a key someone could still recognise it by: all of it but its last 4 characters, in pieces. */
const pieces = (key: string) => [key, key.slice(0, -4), key.slice(4, 20), Buffer.from(key).toString('base64')];

function expectNoKey(text: string, where: string) {
  for (const key of [ROUTER_KEY, CUSTOM_KEY]) for (const piece of pieces(key)) expect(text, `${where} holds a piece of a key`).not.toContain(piece);
}

const post = (app: FastifyInstance, token: string, url: string, payload?: object) => app.inject({ method: 'POST', url, payload, ...as(token) });

async function withKeys(lines: string[]) {
  const { app, db } = await testApp({}, { level: 'trace', stream: { write: (line: string) => void lines.push(line) } });
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const events: unknown[] = [];
  app.ctx.bus.subscribe(acme!.id, message => void events.push(message));
  app.ctx.readModels = async () => ({ ok: false, reason: 'refused', status: 401 });
  const answers: string[] = [];
  const keep = async (res: Promise<{ body: string }>) => {
    const { body } = await res;
    answers.push(body);
    return JSON.parse(body || '{}');
  };
  const router = (await keep(post(app, ceo, '/api/subscriptions', { kind: 'api_key', provider: 'openrouter', label: 'OpenRouter', apiKey: ROUTER_KEY, target: { kind: 'any' }, models: [{ id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick' }] }))).subscription;
  const custom = (await keep(post(app, ceo, '/api/subscriptions', { kind: 'api_key', provider: 'custom_api', label: 'Acme', apiKey: CUSTOM_KEY, baseUrl: 'https://llm.acme.example/v1', protocol: 'openai', target: { kind: 'orchestrator' } }))).subscription;
  /* A refused body, a refused address and an API that refuses the key say why, and nothing of the key. */
  await keep(post(app, ceo, '/api/subscriptions', { kind: 'api_key', provider: 'custom_api', label: 'Bad', apiKey: CUSTOM_KEY, baseUrl: 'not an address', protocol: 'openai', target: { kind: 'any' } }));
  await keep(post(app, ceo, '/api/subscriptions', { kind: 'api_key', provider: 'custom_api', label: 'Inside', apiKey: CUSTOM_KEY, baseUrl: 'http://10.0.0.7/v1', protocol: 'openai', target: { kind: 'any' } }));
  await keep(post(app, ceo, '/api/subscriptions/models', { provider: 'openrouter', apiKey: ROUTER_KEY }));
  await keep(post(app, ceo, `/api/subscriptions/${custom.id}/models`));
  await keep(app.inject({ method: 'PATCH', url: `/api/subscriptions/${router.id}`, payload: { label: 'Router' }, ...as(ceo) }));
  for (const url of ['/api/subscriptions', '/api/org', `/api/subscriptions/${router.id}/tokens`, '/api/tokens']) await keep(app.inject({ url, ...as(ceo) }));
  await keep(app.inject({ method: 'DELETE', url: `/api/subscriptions/${router.id}`, ...as(ceo) }));
  return { app, db, ceo, router, custom, answers, events };
}

describe('a company API key', () => {
  it('is kept encrypted, and only its last 4 characters are ever shown', async () => {
    const lines: string[] = [];
    const c = await withKeys(lines);
    expect(c.router.last4).toBe('WXYZ');
    expect(c.custom.last4).toBe('Q7R8');
    const [row] = await c.db.select().from(subscriptions).where(eq(subscriptions.id, c.custom.id));
    expect(row!.secretEnc).toMatch(/^v1\./);
    expectNoKey(row!.secretEnc!, 'the stored ciphertext');
    /* A removed key is forgotten. */
    const [gone] = await c.db.select().from(subscriptions).where(eq(subscriptions.id, c.router.id));
    expect(gone!.secretEnc).toBeNull();
  });

  it('is in no answer of the API', async () => {
    const c = await withKeys([]);
    expect(c.answers.length).toBeGreaterThan(8);
    for (const [i, body] of c.answers.entries()) expectNoKey(body, `answer ${i}`);
  });

  it('is in no event that goes to browsers', async () => {
    const c = await withKeys([]);
    expect(c.events.length).toBeGreaterThan(0);
    expectNoKey(JSON.stringify(c.events), 'the events');
  });

  it('is in no log line', async () => {
    const lines: string[] = [];
    await withKeys(lines);
    expect(lines.length).toBeGreaterThan(0);
    expectNoKey(lines.join('\n'), 'the log');
  });
});

describe("the agents' SQL", () => {
  async function roles() {
    const sql = agentSqlOn((await createTestDb()).$client);
    return (mode: SqlMode, statement: string) => sql.run(statement, mode);
  }

  it("shows and changes a key for the orchestrator alone, and both read a connection's address, protocol, models and last 4 characters", async () => {
    const run = await roles();
    await expect(run('read', 'SELECT secret_enc FROM subscriptions')).rejects.toThrow(/permission denied|read-only/);
    expect((await run('write', 'SELECT secret_enc FROM subscriptions'))[0]!.rows).toEqual([]);
    for (const mode of ['write', 'read'] as const) expect((await run(mode, 'SELECT id, provider, last4, base_url, api_protocol, models FROM subscriptions'))[0]!.rows).toEqual([]);
    for (const statement of ["UPDATE subscriptions SET secret_enc = 'forged' WHERE false", "UPDATE subscriptions SET base_url = 'https://elsewhere.example' WHERE false"]) {
      await expect(run('read', statement), statement).rejects.toThrow(/permission denied|read-only/);
      await expect(run('write', statement), statement).resolves.toBeDefined();
    }
  });

  it("lets both read what each turn used, and only the orchestrator change it", async () => {
    const run = await roles();
    for (const mode of ['write', 'read'] as const) {
      expect((await run(mode, 'SELECT job_id, agent_id, subscription_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, at FROM turn_tokens'))[0]!.rows).toEqual([]);
    }
    for (const statement of ['INSERT INTO turn_tokens (job_id) SELECT job_id FROM turn_tokens WHERE false', 'UPDATE turn_tokens SET total_tokens = 0 WHERE false', 'DELETE FROM turn_tokens WHERE false']) {
      await expect(run('read', statement), statement).rejects.toThrow(/permission denied|read-only/);
      await expect(run('write', statement), statement).resolves.toBeDefined();
    }
  });
});
