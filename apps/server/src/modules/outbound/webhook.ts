import { createHmac } from 'node:crypto';
import { lookup as resolveName } from 'node:dns';
import type { IncomingMessage } from 'node:http';
import { Agent, request } from 'node:https';
import { BlockList, isIP, type LookupFunction, type Socket } from 'node:net';
import { z } from 'zod';
import { acceptedWith, definitelyNot, isSendable, isTlsFailure, unknownOutcome, type ReconcileOutcome, type SafeCode, type SealedPayload, type SendOutcome, type TransportAdapter } from './delivery.js';

export type WebhookAccount = { endpoint: string; signingKey: string; readback?: boolean; ca?: string };
export type WebhookOptions = { timeoutMs: number; mayReach: (address: string) => boolean };

type Call = { url: URL; method: 'POST' | 'GET'; headers: Record<string, string>; body?: string };
/* What came of one request: an answer from the receiver, or the failure and whether any byte of the request could have
   left. Until TLS is up nothing has. */
type Answer = { status: number; body: string | null } | { failed: SafeCode; secured: boolean };
type NodeFailure = Error & { code?: string };

const MAX_ANSWER_BYTES = 64 * 1024;
const MAX_RECEIPT = 512;
const ADDRESS_REFUSED = 'HH_ADDRESS_REFUSED';
const DEFAULT_TIMEOUT_MS = 30_000;
/* A 4xx says the request was refused, except these, which also come from a receiver that may have taken it. */
const UNCERTAIN_REFUSALS = new Set([408, 409, 425]);
const RECEIPT = z.object({ attemptId: z.string(), receipt: z.string().min(1).max(MAX_RECEIPT) });

const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) NOT_PUBLIC.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::', 96], ['64:ff9b::', 96], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) NOT_PUBLIC.addSubnet(network, prefix, 'ipv6');

/* Node checks an IPv4 address written in IPv6 against the IPv4 rules. */
export const isPublicAddress = (address: string): boolean => {
  const family = isIP(address);
  return family !== 0 && !NOT_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
};

const hostOf = (url: URL): string => url.hostname.replace(/^\[|\]$/g, '');

/* The one configured endpoint: nothing from a message or a model can choose or change it. */
export function endpointOf(raw: string): URL | null {
  if (!URL.canParse(raw)) return null;
  const url = new URL(raw);
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url : null;
}

/* Every address a name resolves to must be allowed, and the connection uses only these: a second answer from the name
   server cannot move it. The agent of each request asks for all of them. */
function guardedLookup(mayReach: WebhookOptions['mayReach']): LookupFunction {
  return (host, options, answer) => {
    resolveName(host, { ...options, all: true }, (failure, found) => {
      if (failure) return answer(failure, '');
      if (!found.every(entry => mayReach(entry.address))) return answer(Object.assign(new Error('Address refused'), { code: ADDRESS_REFUSED }), '');
      return answer(null, found);
    });
  };
}

function failureOf(failure: NodeFailure, secured: boolean): Answer {
  if (secured) return { failed: 'connection_lost', secured };
  if (failure.code === ADDRESS_REFUSED) return { failed: 'address_refused', secured };
  return { failed: isTlsFailure(failure.code) ? 'tls_refused' : 'connect_failed', secured };
}

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

/* An answer too long to be a receipt is read no further. */
function readAnswer(response: IncomingMessage, status: number, settle: (answer: Answer) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  response.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
    size += chunk.length;
    if (size > MAX_ANSWER_BYTES) settle({ status, body: null });
  });
  response.on('end', () => settle({ status, body: Buffer.concat(chunks).toString('utf8') }));
  response.on('error', () => settle({ failed: 'connection_lost', secured: true }));
}

/* One request on its own connection: no shared agent, no keep-alive, no proxy, and a redirect is only an answer. */
function exchange(call: Call, account: WebhookAccount, options: WebhookOptions): Promise<Answer> {
  return new Promise(resolve => {
    let secured = false;
    const sent = request(call.url, { method: call.method, headers: call.headers, agent: new Agent({ keepAlive: false, autoSelectFamily: true }), lookup: guardedLookup(options.mayReach), ca: account.ca, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    const settle = (answer: Answer) => {
      clearTimeout(limit);
      resolve(answer);
      sent.destroy();
    };
    const limit = setTimeout(() => settle({ failed: secured ? 'timeout' : 'connect_timeout', secured }), options.timeoutMs);
    sent.on('socket', (socket: Socket) => socket.once('secureConnect', () => { secured = true; }));
    sent.on('error', (failure: NodeFailure) => settle(failureOf(failure, secured)));
    sent.on('response', response => {
      const status = Number(response.statusCode);
      if (isSuccess(status)) readAnswer(response, status, settle);
      else settle({ status, body: null });
    });
    sent.end(call.body);
  });
}

const signature = (key: string, stamp: string, signed: string): string => `v1=${createHmac('sha256', key).update(`${stamp}.${signed}`).digest('hex')}`;
const signedHeaders = (key: string, signed: string): Record<string, string> => {
  const stamp = String(Math.floor(Date.now() / 1000));
  return { 'x-hornhoof-timestamp': stamp, 'x-hornhoof-signature': signature(key, stamp, signed) };
};

function posting(url: URL, attemptId: string, payload: SealedPayload, key: string): Call {
  const body = JSON.stringify({ attemptId, recipient: payload.recipient, subject: payload.subject, text: payload.text });
  return { url, method: 'POST', body, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), 'idempotency-key': attemptId, ...signedHeaders(key, body) } };
}

function asking(url: URL, attemptId: string, key: string): Call {
  const target = new URL(url);
  target.searchParams.set('attempt', attemptId);
  return { url: target, method: 'GET', headers: signedHeaders(key, attemptId) };
}

/* A receipt counts only when it names this attempt: an answer about anything else proves nothing. */
function receiptOf(body: string | null, attemptId: string): string | null {
  try {
    const parsed = RECEIPT.parse(JSON.parse(body ?? ''));
    return parsed.attemptId === attemptId ? parsed.receipt : null;
  } catch {
    return null;
  }
}

function statusOutcome(status: number): SendOutcome {
  if (status >= 300 && status < 400) return unknownOutcome('redirect_refused');
  return status >= 400 && status < 500 && !UNCERTAIN_REFUSALS.has(status) ? definitelyNot('receiver_refused') : unknownOutcome('receiver_error');
}

function sendOutcome(answer: Answer, attemptId: string): SendOutcome {
  if ('failed' in answer) return answer.secured ? unknownOutcome(answer.failed) : definitelyNot(answer.failed);
  if (!isSuccess(answer.status)) return statusOutcome(answer.status);
  const receipt = receiptOf(answer.body, attemptId);
  return receipt === null ? unknownOutcome('bad_receipt') : acceptedWith(receipt);
}

/* What the receiver says about an attempt is only ever "here is its receipt": all else leaves the question open. */
function askedOutcome(answer: Answer, attemptId: string): ReconcileOutcome {
  const receipt = 'failed' in answer || answer.status !== 200 ? null : receiptOf(answer.body, attemptId);
  return receipt === null ? { kind: 'pending' } : acceptedWith(receipt);
}

const isRefusedLiteral = (url: URL, mayReach: WebhookOptions['mayReach']): boolean => isIP(hostOf(url)) !== 0 && !mayReach(hostOf(url));

/* An endpoint that may be called now, or why not. An address written in it reaches no name lookup, so it is checked here. */
function reachable(raw: string, mayReach: WebhookOptions['mayReach']): URL | SafeCode {
  const url = endpointOf(raw);
  if (!url) return 'endpoint_invalid';
  return isRefusedLiteral(url, mayReach) ? 'address_refused' : url;
}

export function webhookAdapter(given: Partial<WebhookOptions> = {}): TransportAdapter<WebhookAccount> {
  const options: WebhookOptions = { timeoutMs: DEFAULT_TIMEOUT_MS, mayReach: isPublicAddress, ...given };
  return {
    send: async ({ attemptId, sealedPayload, configuredAccount: account }) => {
      if (!isSendable(attemptId, sealedPayload)) return definitelyNot('invalid_payload');
      const url = reachable(account.endpoint, options.mayReach);
      if (!(url instanceof URL)) return definitelyNot(url);
      return sendOutcome(await exchange(posting(url, attemptId, sealedPayload, account.signingKey), account, options), attemptId);
    },
    reconcile: async ({ attemptId, configuredAccount: account }) => {
      if (!account.readback) return unknownOutcome('no_readback');
      const url = reachable(account.endpoint, options.mayReach);
      if (!(url instanceof URL)) return { kind: 'pending' };
      return askedOutcome(await exchange(asking(url, attemptId, account.signingKey), account, options), attemptId);
    },
  };
}
