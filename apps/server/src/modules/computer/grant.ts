import { createPublicKey, verify } from 'node:crypto';
import { isP256 } from './owner-key.js';

/* Older leaders send timed grants signed by the machine owner. Updated keepers still check those grants against their
   pinned key. Standing access has its own reply. */
export type Grant = { payload: string; signature: string };
/* machine: the network id of the one machine it opens. until, at: seconds. nonce: 16 random bytes, in base64url. */
type GrantFacts = { v: 1; machine: string; until: number; at: number; nonce: string };

/* How far a browser's clock and a machine's may be apart. */
const GRANT_SKEW_S = 300;
/* A grant opens for a day at most, and the skew on top. */
export const GRANT_MAX_S = 24 * 3600 + GRANT_SKEW_S;

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const NONCE = /^[A-Za-z0-9_-]{22}$/;
const FIELDS = ['at', 'machine', 'nonce', 'until', 'v'];
/* ECDSA on P-256 as WebCrypto writes it: r and s, 32 bytes each. */
const SIGNATURE_BYTES = 64;

function signedBy(grant: Grant, publicKey: string): boolean {
  if (!isP256(publicKey) || !BASE64URL.test(grant.signature)) return false;
  const signature = Buffer.from(grant.signature, 'base64url');
  if (signature.length !== SIGNATURE_BYTES) return false;
  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
  return verify('sha256', Buffer.from(grant.payload, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, signature);
}

function factsOf(payload: string): GrantFacts | null {
  const said = JSON.parse(payload) as unknown;
  if (typeof said !== 'object' || said === null || Array.isArray(said)) return null;
  if (Object.keys(said).sort().join() !== FIELDS.join()) return null;
  const { v, machine, until, at, nonce } = said as Record<string, unknown>;
  if (v !== 1 || typeof machine !== 'string' || typeof nonce !== 'string' || !NONCE.test(nonce)) return null;
  if (!Number.isSafeInteger(until) || !Number.isSafeInteger(at)) return null;
  return { v, machine, until: until as number, at: at as number, nonce };
}

/* What a grant says, when the key signed it for this machine and it stands now: made no further ahead of this clock
   than the skew, its end ahead, and no longer than a day. Anything else reads as nothing. */
export function readGrant(grant: Grant, publicKey: string, machine: string, nowS: number): GrantFacts | null {
  try {
    if (!signedBy(grant, publicKey)) return null;
    const facts = factsOf(grant.payload);
    if (!facts || facts.machine !== machine) return null;
    if (facts.at > nowS + GRANT_SKEW_S || facts.until <= nowS || facts.until > facts.at + GRANT_MAX_S) return null;
    return facts;
  } catch {
    return null;
  }
}
