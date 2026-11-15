import { describe, expect, it } from 'vitest';
import { API_PROTOCOLS, API_PROVIDERS, apiEndpoint, isApiProvider, modelsFor, parseNodeMessage, parseServerMessage, PROVIDER_IDS, TurnTokens } from '../src/index.js';

/* A company pays for an API by the token: Claude API, OpenAI API, OpenRouter, or any API that speaks Anthropic's or
   OpenAI's protocol at an address the company names. Every turn, on any plan or key, says how many tokens it used. */

const RUN = {
  type: 'job.run', jobId: 'job-1', subscriptionId: 'sub-1', provider: 'custom_api', prompt: 'Go.', sessionId: null, model: 'llama-4-maverick',
  timeoutMs: 60_000, secret: 'sk-live-0123456789abcdef', instructions: null, toolToken: null,
};
const DONE = { type: 'job.done', jobId: 'job-1', ok: true, sessionId: null, result: 'Done.', tail: '', error: null, n: 1 };

describe('API connections', () => {
  it('knows OpenRouter and any compatible API next to the Claude and OpenAI APIs', () => {
    expect(PROVIDER_IDS).toEqual(expect.arrayContaining(['anthropic_api', 'openai_api', 'openrouter', 'custom_api']));
    expect(API_PROVIDERS).toEqual(['anthropic_api', 'openai_api', 'openrouter', 'custom_api']);
    expect(API_PROTOCOLS).toEqual(['anthropic', 'openai']);
    expect(API_PROVIDERS.every(isApiProvider)).toBe(true);
    expect(['claude', 'codex', 'kimi', 'glm', 'antigravity'].some(p => isApiProvider(p))).toBe(false);
  });

  it('gives each API the address and protocol its program talks to', () => {
    expect(apiEndpoint('anthropic_api', {})).toEqual({ baseUrl: 'https://api.anthropic.com', protocol: 'anthropic' });
    expect(apiEndpoint('openai_api', {})).toEqual({ baseUrl: 'https://api.openai.com/v1', protocol: 'openai' });
    expect(apiEndpoint('openrouter', {})).toEqual({ baseUrl: 'https://openrouter.ai/api', protocol: 'anthropic' });
    expect(apiEndpoint('openrouter', { protocol: 'openai' })).toEqual({ baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai' });
    expect(apiEndpoint('custom_api', { baseUrl: 'https://llm.acme.example/v1/', protocol: 'openai' })).toEqual({ baseUrl: 'https://llm.acme.example/v1', protocol: 'openai' });
    expect(apiEndpoint('custom_api', { protocol: 'openai' })).toBeNull();
    expect(apiEndpoint('custom_api', { baseUrl: 'https://llm.acme.example' })).toBeNull();
    expect(apiEndpoint('claude', {})).toBeNull();
  });

  it('runs the models a connection was given, and the Claude and OpenAI APIs their known ones without a list', () => {
    const own = [{ id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick' }];
    expect(modelsFor('openrouter', own)).toEqual(own);
    expect(modelsFor('custom_api', own)).toEqual(own);
    expect(modelsFor('custom_api', null)).toEqual([]);
    expect(modelsFor('anthropic_api', null).length).toBeGreaterThan(0);
  });

  it("sends the program an API's address and protocol with the turn, and an older node takes a turn without them", () => {
    const api = { baseUrl: 'https://openrouter.ai/api', protocol: 'anthropic' };
    expect(parseServerMessage(JSON.stringify({ ...RUN, api }))).toMatchObject({ api });
    expect(parseServerMessage(JSON.stringify(RUN))).not.toBeNull();
    for (const bad of [{ ...api, protocol: 'grpc' }, { ...api, baseUrl: 'not an address' }, { ...api, baseUrl: 'ftp://llm.acme.example' }, { ...api, baseUrl: 'https://key:secret@llm.acme.example' }]) {
      expect(parseServerMessage(JSON.stringify({ ...RUN, api: bad })), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("a turn's tokens", () => {
  it('come with its end as plain counts, null where the program gave none, and an older node sends none', () => {
    const tokens = { input: 1200, output: 340, cacheRead: 9000, cacheWrite: 150, total: 10_690 };
    expect(parseNodeMessage(JSON.stringify({ ...DONE, tokens }))).toMatchObject({ tokens });
    expect(parseNodeMessage(JSON.stringify({ ...DONE, tokens: null }))).toMatchObject({ tokens: null });
    expect(parseNodeMessage(JSON.stringify(DONE))).not.toBeNull();
    expect(parseNodeMessage(JSON.stringify({ ...DONE, tokens: { ...tokens, output: -1 } }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ ...DONE, tokens: { ...tokens, input: 1.5 } }))).toBeNull();
  });

  it('may lack a part the program does not tell, but never all of them', () => {
    expect(TurnTokens.safeParse({ input: 10, output: 2, cacheRead: null, cacheWrite: null, total: 12 }).success).toBe(true);
    expect(TurnTokens.safeParse({ input: null, output: null, cacheRead: null, cacheWrite: null, total: null }).success).toBe(false);
  });
});
