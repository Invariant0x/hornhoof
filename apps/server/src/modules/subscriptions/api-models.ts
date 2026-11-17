import { lookup as resolveName } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { ApiEndpoint, ApiProvider, ModelOption } from '@hornhoof/protocol';
import { isPublicAddress } from '../outbound/extension.js';

/* The server asks an API for its models at an address a person gave. It never reaches the internal network unless the
   server's operator allowed that host, follows no redirect, reads a bounded answer and gives up after a while. */

export type ModelsRequest = { url: URL; headers: Record<string, string> };
export const MODELS_FAILURES = ['internal_address', 'redirect', 'too_large', 'timeout', 'unreachable', 'bad_answer', 'refused'] as const;
type ModelsFailure = (typeof MODELS_FAILURES)[number];
export type ModelsAnswer = { ok: true; body: unknown } | { ok: false; reason: ModelsFailure; status?: number };
export type ModelsReader = (request: ModelsRequest) => Promise<ModelsAnswer>;

type Response = { statusCode?: number; on(event: 'data', listener: (chunk: Buffer) => void): unknown; on(event: 'end' | 'error', listener: () => void): unknown };
type Sending = { on(event: 'response', listener: (response: Response) => void): unknown; on(event: 'error', listener: (error: Error) => void): unknown; end(): void; destroy(): void };
/* One GET on a connection of its own that takes its address from lookup alone. */
export type Send = (url: URL, options: { headers: Record<string, string>; lookup: LookupFunction }) => Sending;
type Resolve = (host: string) => Promise<string[]>;

type ReaderOptions = { allowed?: readonly string[]; resolve?: Resolve; send?: Send; timeoutMs?: number; maxBytes?: number };

const TIMEOUT_MS = 15_000;
/* OpenRouter lists a few hundred models in under a megabyte. */
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 1000;

/* A name that ends in the root's dot is the same name. */
const hostOf = (url: URL): string => url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();

/* Whether an address names this machine or a network inside, which the server's operator did not allow. A name that
   only resolves to one is caught when the server asks it. */
export function internalAddress(url: URL, allowed: readonly string[]): boolean {
  const host = hostOf(url);
  if (allowed.includes(host)) return false;
  if (isIP(host)) return !isPublicAddress(host);
  return host === 'localhost' || host.endsWith('.localhost');
}

const resolveAll: Resolve = async host => (await resolveName(host, { all: true, verbatim: true })).map(entry => entry.address);

/* A lookup that answers the addresses already checked, so a second answer of the name server cannot move the connection. */
function pinned(addresses: string[]): LookupFunction {
  const found = addresses.map(address => ({ address, family: isIP(address) }));
  return (_host, options, answer) => {
    if (options.all) return answer(null, found);
    return answer(null, found[0]!.address, found[0]!.family);
  };
}

/* No shared agent, no keep-alive and no proxy; a redirect is only an answer. */
const realSend: Send = (url, { headers, lookup }) =>
  url.protocol === 'https:'
    ? httpsRequest(url, { method: 'GET', headers, lookup, agent: false, minVersion: 'TLSv1.2' })
    : httpRequest(url, { method: 'GET', headers, lookup, agent: false });

function exchange(send: Send, request: ModelsRequest, lookup: LookupFunction, timeoutMs: number, maxBytes: number): Promise<ModelsAnswer> {
  return new Promise(resolve => {
    let settled = false;
    const sent = send(request.url, { headers: { accept: 'application/json', ...request.headers }, lookup });
    const settle = (answer: ModelsAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      sent.destroy();
      resolve(answer);
    };
    const limit = setTimeout(() => settle({ ok: false, reason: 'timeout' }), timeoutMs);
    sent.on('error', () => settle({ ok: false, reason: 'unreachable' }));
    sent.on('response', response => {
      const status = Number(response.statusCode);
      if (status >= 300 && status < 400) return settle({ ok: false, reason: 'redirect' });
      if (status < 200 || status >= 300) return settle({ ok: false, reason: 'refused', status });
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) return settle({ ok: false, reason: 'too_large' });
        chunks.push(Buffer.from(chunk));
      });
      response.on('error', () => settle({ ok: false, reason: 'unreachable' }));
      response.on('end', () => {
        try {
          settle({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
        } catch {
          settle({ ok: false, reason: 'bad_answer' });
        }
      });
    });
    sent.end();
  });
}

export function modelsReader({ allowed = [], resolve = resolveAll, send = realSend, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES }: ReaderOptions = {}): ModelsReader {
  const allow = new Set(allowed.map(host => host.toLowerCase()));
  return async request => {
    const host = hostOf(request.url);
    const addresses = isIP(host) ? [host] : await resolve(host).catch(() => []);
    if (!addresses.length) return { ok: false, reason: 'unreachable' };
    /* Every address the name has must be allowed: the connection may take any of them. */
    if (!allow.has(host) && !addresses.every(address => isPublicAddress(address) || allow.has(address))) return { ok: false, reason: 'internal_address' };
    return exchange(send, request, pinned(addresses), timeoutMs, maxBytes);
  };
}

/* Where an API lists its models, with the key in the header its protocol takes. OpenRouter lists them in OpenAI's
   protocol whichever its connection talks; a compatible API in Anthropic's may take either header, so it gets both. */
export function modelsRequest(provider: ApiProvider, endpoint: ApiEndpoint, key: string): ModelsRequest {
  const bearer = { authorization: `Bearer ${key}` };
  if (provider === 'openrouter') return { url: new URL('https://openrouter.ai/api/v1/models'), headers: bearer };
  if (endpoint.protocol === 'openai') return { url: new URL(`${endpoint.baseUrl}/models`), headers: bearer };
  return { url: new URL(`${endpoint.baseUrl}/v1/models`), headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', ...(provider === 'custom_api' ? bearer : {}) } };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/* The models in a list of OpenAI's, Anthropic's or OpenRouter's protocol: each id once, none too long to run, as a cut id
   would name another model; null for an answer that is no such list. */
export function modelsFrom(body: unknown): ModelOption[] | null {
  if (!isRecord(body) || !Array.isArray(body.data)) return null;
  const models = new Map<string, ModelOption>();
  for (const entry of body.data) {
    if (models.size >= MAX_MODELS) break;
    const id = isRecord(entry) ? text(entry.id) : '';
    if (!id || id.length > 80 || models.has(id)) continue;
    const name = text((entry as Record<string, unknown>).display_name) || text((entry as Record<string, unknown>).name) || id;
    models.set(id, { id, name: name.slice(0, 80) });
  }
  return [...models.values()];
}
