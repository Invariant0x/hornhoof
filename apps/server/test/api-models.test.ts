import { EventEmitter } from 'node:events';
import type { LookupFunction } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { internalAddress, modelsFrom, modelsReader, type Send } from '../src/modules/subscriptions/api-models.js';

/* The server reads a model list at an address a person gave, so the request must not reach the internal network unless
   the server allows that host, and must end in time and within a size. The connection itself is a stand-in: we test our
   checks, not the network. */

type Answer = { status: number; body?: string | string[] } | { error: string } | 'silent';
type Sent = { url: URL; headers: Record<string, string>; lookup: LookupFunction; destroyed: boolean };

function stand(answer: Answer) {
  const sent: Sent[] = [];
  const send: Send = (url, options) => {
    const request = Object.assign(new EventEmitter(), {
      end: () => {
        queueMicrotask(() => {
          if (answer === 'silent') return;
          if ('error' in answer) return void request.emit('error', Object.assign(new Error(answer.error), { code: answer.error }));
          const response = Object.assign(new PassThrough(), { statusCode: answer.status });
          request.emit('response', response);
          for (const chunk of [answer.body ?? ''].flat()) response.write(chunk);
          response.end();
        });
      },
      destroy: () => {
        record.destroyed = true;
      },
    });
    const record: Sent = { url, headers: options.headers, lookup: options.lookup, destroyed: false };
    sent.push(record);
    return request;
  };
  return { sent, send };
}

const names: Record<string, string[]> = { 'llm.acme.example': ['93.184.216.34'], 'mixed.acme.example': ['93.184.216.34', '10.0.0.5'], localhost: ['127.0.0.1', '::1'] };
const resolve = async (host: string) => names[host] ?? [];
const reader = (answer: Answer, allowed: string[] = [], extra: { maxBytes?: number; timeoutMs?: number } = {}) => {
  const s = stand(answer);
  return { ...s, read: modelsReader({ allowed, resolve, send: s.send, ...extra }) };
};
const ask = (href: string) => ({ url: new URL(href), headers: { authorization: 'Bearer key-0123456789' } });

const lookedUp = (lookup: LookupFunction, host: string) =>
  new Promise<unknown>((done, fail) => lookup(host, { all: true }, (error, found) => (error ? fail(error) : done(found))));

afterEach(() => {
  vi.useRealTimers();
});

describe('reading a model list at an address a person gave', () => {
  it('connects only to the addresses it checked, with the key it was given', async () => {
    const r = reader({ status: 200, body: '{"data":[{"id":"llama-4-maverick"}]}' });
    expect(await r.read(ask('https://llm.acme.example/v1/models'))).toEqual({ ok: true, body: { data: [{ id: 'llama-4-maverick' }] } });
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.headers.authorization).toBe('Bearer key-0123456789');
    /* The connection takes the checked addresses: a second answer from the name server cannot move it. */
    expect(await lookedUp(r.sent[0]!.lookup, 'llm.acme.example')).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('refuses an internal address, written in the address or behind its name, before it connects', async () => {
    for (const href of ['http://10.0.0.5/v1/models', 'http://169.254.169.254/v1/models', 'http://[::1]/v1/models', 'https://mixed.acme.example/v1/models', 'https://localhost/v1/models', 'https://unknown.acme.example/v1/models']) {
      const r = reader({ status: 200, body: '{}' });
      const answer = await r.read(ask(href));
      expect(answer, href).toEqual({ ok: false, reason: href.includes('unknown') ? 'unreachable' : 'internal_address' });
      expect(r.sent, href).toEqual([]);
    }
  });

  it('reaches a host the server allows, by its name or its address', async () => {
    for (const [href, allowed] of [['https://localhost/v1/models', ['localhost']], ['http://10.0.0.5/v1/models', ['10.0.0.5']]] as const) {
      const r = reader({ status: 200, body: '{"data":[]}' }, [...allowed]);
      expect(await r.read(ask(href)), href).toEqual({ ok: true, body: { data: [] } });
    }
  });

  it('takes a redirect as the answer and never follows it', async () => {
    const r = reader({ status: 302, body: '' });
    expect(await r.read(ask('https://llm.acme.example/v1/models'))).toEqual({ ok: false, reason: 'redirect' });
    expect(r.sent).toHaveLength(1);
  });

  it('says the API refused, with its status', async () => {
    expect(await reader({ status: 401, body: '{"error":"invalid key"}' }).read(ask('https://llm.acme.example/v1/models'))).toEqual({ ok: false, reason: 'refused', status: 401 });
  });

  it('stops reading an answer past its size, and refuses one that is not JSON', async () => {
    const long = reader({ status: 200, body: ['{"data":[', 'x'.repeat(600), ']}'] }, [], { maxBytes: 512 });
    expect(await long.read(ask('https://llm.acme.example/v1/models'))).toEqual({ ok: false, reason: 'too_large' });
    expect(long.sent[0]!.destroyed).toBe(true);
    expect(await reader({ status: 200, body: '<html>' }).read(ask('https://llm.acme.example/v1/models'))).toEqual({ ok: false, reason: 'bad_answer' });
  });

  it('gives up on an API that does not answer in time', async () => {
    vi.useFakeTimers();
    const r = reader('silent', [], { timeoutMs: 10_000 });
    const answer = r.read(ask('https://llm.acme.example/v1/models'));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(r.sent[0]!.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await answer).toEqual({ ok: false, reason: 'timeout' });
    expect(r.sent[0]!.destroyed).toBe(true);
  });

  it('says an API it could not reach is unreachable', async () => {
    expect(await reader({ error: 'ECONNREFUSED' }).read(ask('https://llm.acme.example/v1/models'))).toEqual({ ok: false, reason: 'unreachable' });
  });
});

describe('an address a person writes', () => {
  it('is internal when it names this machine or a private network, unless the server allows it', () => {
    for (const href of ['http://10.0.0.7:8000/v1', 'http://127.0.0.1:11434', 'http://localhost:11434', 'http://ollama.localhost', 'http://[::1]', 'http://[::ffff:192.168.1.5]', 'http://169.254.169.254', 'http://[fd00::1]']) {
      expect(internalAddress(new URL(href), []), href).toBe(true);
    }
    for (const href of ['https://openrouter.ai/api', 'https://llm.acme.example/v1', 'http://93.184.216.34']) expect(internalAddress(new URL(href), []), href).toBe(false);
    expect(internalAddress(new URL('http://localhost:11434'), ['localhost'])).toBe(false);
    expect(internalAddress(new URL('http://10.0.0.7:8000'), ['10.0.0.7'])).toBe(false);
    expect(internalAddress(new URL('http://10.0.0.8:8000'), ['10.0.0.7'])).toBe(true);
  });
});

describe('the models in an answer', () => {
  it('reads the lists of the OpenAI, Anthropic and OpenRouter protocols, and nothing else', () => {
    expect(modelsFrom({ object: 'list', data: [{ id: 'gpt-5', object: 'model' }] })).toEqual([{ id: 'gpt-5', name: 'gpt-5' }]);
    expect(modelsFrom({ data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }], has_more: false })).toEqual([{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }]);
    expect(modelsFrom({ data: [{ id: 'meta-llama/llama-4-maverick', name: 'Meta: Llama 4 Maverick' }] })).toEqual([{ id: 'meta-llama/llama-4-maverick', name: 'Meta: Llama 4 Maverick' }]);
    /* Bad entries are left out, and an id too long to run, as a cut one would name another model; a long name is cut. */
    expect(modelsFrom({ data: [{ id: '' }, { name: 'no id' }, 7, { id: 'a'.repeat(81) }, { id: 'kept', name: 'b'.repeat(300) }] })).toEqual([{ id: 'kept', name: 'b'.repeat(80) }]);
    expect(modelsFrom({ models: [] })).toBeNull();
    expect(modelsFrom('nope')).toBeNull();
  });

  it('keeps at most a thousand, each once', () => {
    const many = { data: [...Array.from({ length: 1500 }, (_, i) => ({ id: `m-${i}` })), { id: 'm-0' }] };
    const read = modelsFrom(many)!;
    expect(read).toHaveLength(1000);
    expect(new Set(read.map(m => m.id)).size).toBe(1000);
  });
});
