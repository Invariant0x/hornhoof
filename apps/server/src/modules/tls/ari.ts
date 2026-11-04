import * as x509 from '@peculiar/x509';
import { z } from 'zod';
import { AcmeError, problemOf, retryAfterSeconds, textOf } from './acme.js';

const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_RETRY_AFTER_S = 21600;
const FIRST_BYTE_WITH_SIGN_BIT = 0x80;

export type RenewalWindow = { start: Date; end: Date; retryAfterS: number };

type Reply = { status: number; headers: Headers; body: unknown };

const Directory = z.object({ renewalInfo: z.string() });
const WindowAnswer = z.object({ suggestedWindow: z.object({ start: z.string(), end: z.string() }) });

const base64url = (hex: string): string => Buffer.from(hex, 'hex').toString('base64url');

// RFC 9773 4.1.
export function certIdFrom(keyIdentifierHex: string, serialHex: string): string {
  return `${base64url(keyIdentifierHex)}.${base64url(serialHex)}`;
}

// The library drops the zero that keeps a serial positive, and RFC 9773 wants the octets as they are encoded.
function serialAsEncoded(serialHex: string): string {
  return Number.parseInt(serialHex.slice(0, 2), 16) >= FIRST_BYTE_WITH_SIGN_BIT ? `00${serialHex}` : serialHex;
}

export function certId(certPem: string): string | null {
  const cert = new x509.X509Certificate(x509.PemConverter.decodeFirst(certPem));
  const keyId = cert.getExtension(x509.AuthorityKeyIdentifierExtension)?.keyId;
  return keyId ? certIdFrom(keyId, serialAsEncoded(cert.serialNumber)) : null;
}

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function get(url: string): Promise<Reply> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error' });
    return { status: res.status, headers: res.headers, body: jsonOf(await res.text()) };
  } catch (err) {
    throw new AcmeError('unreachable', { detail: textOf(err) });
  }
}

function refused({ status, headers, body }: Reply): AcmeError {
  const problem = problemOf(status, headers.get('content-type'), body, headers.get('retry-after'));
  return new AcmeError('refused', { type: problem?.type, retryAfterS: problem?.retryAfterS, detail: problem?.detail ?? `answered ${status}` });
}

function suggestedWindow(body: unknown): { start: Date; end: Date } | null {
  const answer = WindowAnswer.safeParse(body);
  if (!answer.success) return null;
  const start = new Date(answer.data.suggestedWindow.start);
  const end = new Date(answer.data.suggestedWindow.end);
  return start < end ? { start, end } : null;
}

async function renewalInfoUrl(directoryUrl: string): Promise<string | null> {
  const reply = await get(directoryUrl);
  if (reply.status !== 200) throw refused(reply);
  const directory = Directory.safeParse(reply.body);
  return directory.success ? directory.data.renewalInfo : null;
}

// One unauthenticated GET: acme-client has no renewal information, and this needs no signing and no account.
export async function renewalInfo(directoryUrl: string, certPem: string): Promise<RenewalWindow | null> {
  const url = await renewalInfoUrl(directoryUrl);
  const id = certId(certPem);
  if (!url || !id) return null;
  const reply = await get(`${url.replace(/\/+$/, '')}/${id}`);
  const window = reply.status === 200 ? suggestedWindow(reply.body) : null;
  if (!window) throw refused(reply);
  return { ...window, retryAfterS: retryAfterSeconds(reply.headers.get('retry-after')) ?? DEFAULT_RETRY_AFTER_S };
}
