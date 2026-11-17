import { z } from 'zod';

/* Public browser metadata and codecs only. Admission, nonce consumption, signature
   verification and stream ordering belong to the authenticated broker. */
const TEST_TERMINAL_LIMITS = { bindBytes: 4096, proofBytes: 1024, frameBytes: 65536, dataBytes: 32768, originBytes: 2048 } as const;
const TEST_TERMINAL_CLOSE = {
  closed: { code: 1000, reason: 'closed' }, denied: { code: 4403, reason: 'denied' },
  expired: { code: 4408, reason: 'expired' }, unavailable: { code: 4503, reason: 'unavailable' },
  unknown: { code: 4500, reason: 'unknown' },
} as const;

const UTF8 = new TextEncoder();
const CHALLENGE_PREFIX = UTF8.encode('hornhoof:test-terminal:view-proof:v1\0');
const UUID = z.uuid();
const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64(value: string, size: number): Uint8Array {
  if (value.length !== Math.ceil(size * 8 / 6) || !/^[A-Za-z0-9_-]+$/.test(value)) throw new RangeError('Invalid base64url value.');
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
  if (bytes.length !== size || encodeBase64(bytes) !== value) throw new RangeError('Noncanonical base64url value.');
  return bytes;
}

function codecString(decode: (value: string) => Uint8Array) {
  return z.string().refine(value => {
    try { decode(value); return true; } catch { return false; }
  }, 'Invalid protocol codec.');
}

function boundedText(maxBytes: number) {
  return z.string().max(maxBytes).refine(value => !/[\uD800-\uDFFF]/u.test(value) && UTF8.encode(value).length <= maxBytes, 'Invalid or oversized UTF-8 text.');
}

const jsonBound = (maxBytes: number) => (value: unknown): boolean => UTF8.encode(JSON.stringify(value)).length <= maxBytes;

export function encodeViewChallenge(nonce: Uint8Array): string {
  if (nonce.length !== 32) throw new RangeError('A view challenge requires 32 nonce bytes.');
  const bytes = new Uint8Array(CHALLENGE_PREFIX.length + 32);
  bytes.set(CHALLENGE_PREFIX); bytes.set(nonce, CHALLENGE_PREFIX.length);
  return encodeBase64(bytes);
}

export function decodeViewChallenge(challenge: string): Uint8Array {
  const bytes = decodeBase64(challenge, CHALLENGE_PREFIX.length + 32);
  if (!CHALLENGE_PREFIX.every((byte, index) => bytes[index] === byte)) throw new RangeError('Unknown view challenge purpose.');
  return bytes;
}

export function encodeViewSignature(signature: Uint8Array): string {
  if (signature.length !== 64) throw new RangeError('A view signature requires 64 raw bytes.');
  return encodeBase64(signature);
}

export function decodeViewSignature(signature: string): Uint8Array {
  return decodeBase64(signature, 64);
}

export const ViewChallenge = codecString(decodeViewChallenge);
export type ViewChallenge = z.infer<typeof ViewChallenge>;
export const ViewSignature = codecString(decodeViewSignature);
export type ViewSignature = z.infer<typeof ViewSignature>;
const Coordinate = codecString(value => decodeBase64(value, 32));
export const PublicBrowserKey = z.strictObject({ algorithm: z.literal('P-256/SHA-256'), kty: z.literal('EC'), crv: z.literal('P-256'), x: Coordinate, y: Coordinate });
export type PublicBrowserKey = z.infer<typeof PublicBrowserKey>;

export const BindViewRequest = z.strictObject({
  operationId: UUID, leaseId: UUID, expectedLeaseRevision: Revision, registrationId: UUID,
  expectedIdentityDigest: Digest, browserPublicKey: PublicBrowserKey,
}).refine(jsonBound(TEST_TERMINAL_LIMITS.bindBytes), 'Oversized bind request.');
export type BindViewRequest = z.infer<typeof BindViewRequest>;

const Role = z.enum(['controller', 'observer']);
const Rights = z.strictObject({ control: z.boolean(), message: z.boolean() });
function derivedRights(value: { role: z.infer<typeof Role>; rights: z.infer<typeof Rights> }): boolean {
  return value.role !== 'observer' || (!value.rights.control && !value.rights.message);
}
export const BindViewResponse = z.strictObject({
  viewId: UUID, nonceId: UUID, challenge: ViewChallenge, role: Role, rights: Rights,
}).refine(derivedRights, 'An observer has no control or message rights.')
  .refine(jsonBound(TEST_TERMINAL_LIMITS.bindBytes), 'Oversized bind response.');
export type BindViewResponse = z.infer<typeof BindViewResponse>;

function exactOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch { return false; }
}
export const TestTerminalOrigin = boundedText(TEST_TERMINAL_LIMITS.originBytes).refine(exactOrigin, 'Expected an exact serialized HTTP origin.');
export type TestTerminalOrigin = z.infer<typeof TestTerminalOrigin>;
export const TestTerminalCursor = z.string().refine(value => {
  if (!value.startsWith('ttc1.')) return false;
  try { decodeBase64(value.slice(5), 32); return true; } catch { return false; }
}, 'Invalid output cursor.');
export type TestTerminalCursor = z.infer<typeof TestTerminalCursor>;

/* The optional catalog cursor does not define an incoming browser resume channel.
   Browser WS URLs have no query, and ViewProof is the sole client frame. */
export const ObserveRequest = z.strictObject({ viewId: UUID, cursor: TestTerminalCursor.optional() });
export type ObserveRequest = z.infer<typeof ObserveRequest>;
export const ViewProof = z.strictObject({ type: z.literal('proof'), viewId: UUID, nonceId: UUID, signature: ViewSignature })
  .refine(jsonBound(TEST_TERMINAL_LIMITS.proofBytes), 'Oversized view proof.');
export type ViewProof = z.infer<typeof ViewProof>;

export const TestTerminalServerFrame = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready'), write: z.boolean(), message: z.boolean() }),
  z.strictObject({ type: z.literal('data'), data: boundedText(TEST_TERMINAL_LIMITS.dataBytes), cursor: TestTerminalCursor }),
  z.strictObject({ type: z.literal('error'), reason: z.enum(['denied', 'expired', 'unavailable', 'unknown']) }),
]).refine(jsonBound(TEST_TERMINAL_LIMITS.frameBytes), 'Oversized server frame.');
export type TestTerminalServerFrame = z.infer<typeof TestTerminalServerFrame>;

function closeSchema<C extends number, R extends string>(value: { code: C; reason: R }) {
  return z.strictObject({ code: z.literal(value.code), reason: z.literal(value.reason) });
}
export const TestTerminalClose = z.discriminatedUnion('code', [
  closeSchema(TEST_TERMINAL_CLOSE.closed), closeSchema(TEST_TERMINAL_CLOSE.denied),
  closeSchema(TEST_TERMINAL_CLOSE.expired), closeSchema(TEST_TERMINAL_CLOSE.unavailable), closeSchema(TEST_TERMINAL_CLOSE.unknown),
]);
export type TestTerminalClose = z.infer<typeof TestTerminalClose>;

/* The server supplies genuine current metadata. A matching comparison is never a grant. */
export const TestViewBindingContext = z.strictObject({
  viewId: UUID, nonceId: UUID, origin: TestTerminalOrigin, leaseId: UUID, leaseRevision: Revision,
  registrationId: UUID, identityDigest: Digest, currentConnectionBinding: boundedText(256).min(1),
  subjectBindingDigest: Digest, role: Role, rights: Rights, browserPublicKey: PublicBrowserKey,
  nonceExpiresAtMs: Timestamp, leaseExpiresAtMs: Timestamp,
}).refine(derivedRights, 'An observer has no control or message rights.');
export type TestViewBindingContext = z.infer<typeof TestViewBindingContext>;

const BINDING_FIELDS = ['viewId', 'nonceId', 'origin', 'leaseId', 'leaseRevision', 'registrationId', 'identityDigest', 'currentConnectionBinding', 'subjectBindingDigest', 'role', 'nonceExpiresAtMs', 'leaseExpiresAtMs'] as const;
function sameBinding(a: TestViewBindingContext, b: TestViewBindingContext): boolean {
  return BINDING_FIELDS.every(field => a[field] === b[field])
    && a.browserPublicKey.x === b.browserPublicKey.x && a.browserPublicKey.y === b.browserPublicKey.y
    && a.rights.control === b.rights.control && a.rights.message === b.rights.message;
}

export function checkTestViewBinding(stored: unknown, current: unknown, nowMs: number): 'current' | 'stale' | 'expired' {
  if (!Number.isFinite(nowMs) || nowMs < 0) return 'stale';
  const a = TestViewBindingContext.safeParse(stored), b = TestViewBindingContext.safeParse(current);
  if (!a.success || !b.success) return 'stale';
  if (!sameBinding(a.data, b.data)) return 'stale';
  if (nowMs >= a.data.nonceExpiresAtMs || nowMs >= a.data.leaseExpiresAtMs) return 'expired';
  return 'current';
}

export function isTestViewReady(response: unknown, frame: unknown): boolean {
  const binding = BindViewResponse.safeParse(response), parsed = TestTerminalServerFrame.safeParse(frame);
  if (!binding.success || !parsed.success || parsed.data.type !== 'ready') return false;
  return parsed.data.write === binding.data.rights.control && parsed.data.message === binding.data.rights.message;
}
