import { createHash, createPublicKey } from 'node:crypto';

/* How many rounds the browser makes of a person's password before it wraps their key with what comes out. */
export const KEY_ITERATIONS = 600_000;

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const derOf = (publicKey: string): Buffer => Buffer.from(publicKey, 'base64url');

/* A person's public key travels as its SPKI DER in base64url. Its print is the SHA-256 of that DER, in base64url: 43
   characters, short enough to compare and to show. */
export function keyPrint(publicKey: string): string {
  return createHash('sha256').update(derOf(publicKey)).digest('base64url');
}

/* Whether the text is a public key of the one kind every browser makes and this server checks: ECDSA on P-256. */
export function isP256(publicKey: string): boolean {
  /* A decoder skips what is no base64url, so a text with anything else in it would read as the key beside it. */
  if (!BASE64URL.test(publicKey)) return false;
  try {
    const key = createPublicKey({ key: derOf(publicKey), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  } catch {
    return false;
  }
}
