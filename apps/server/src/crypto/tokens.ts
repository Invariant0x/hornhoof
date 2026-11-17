import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const newToken = (): string => randomBytes(32).toString('base64url');

/* Only hashes of session, invite and join tokens are stored. */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/* A token this server signs for one purpose, which names it so that no other signature of the server is ever one of these:
   the body as base64url JSON, a dot, and the HMAC of the purpose, a newline and that. */
const macOf = (secret: Buffer, purpose: string, payload: string): Buffer => createHmac('sha256', secret).update(`${purpose}\n${payload}`).digest();

export function signedToken(secret: Buffer, purpose: string, body: object): string {
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${payload}.${macOf(secret, purpose, payload).toString('base64url')}`;
}

/* The body of a token signed for this purpose, or null for anything else. */
export function signedBody(secret: Buffer, purpose: string, token: string): unknown {
  const [payload, mac, ...rest] = token.split('.');
  if (!payload || !mac || rest.length) return null;
  const want = macOf(secret, purpose, payload);
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()) as unknown;
  } catch {
    return null;
  }
}
