import { createPublicKey, verify, webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BindViewRequest, BindViewResponse, ObserveRequest, PublicBrowserKey,
  TestTerminalClose, TestTerminalCursor, TestTerminalOrigin, TestTerminalServerFrame,
  TestViewBindingContext, ViewChallenge, ViewProof, ViewSignature,
  checkTestViewBinding, decodeViewChallenge, decodeViewSignature,
  encodeViewChallenge, encodeViewSignature, isTestViewReady,
} from '../src/index.js';

const VIEW = '00000000-0000-4000-8000-000000000001';
const NONCE = '00000000-0000-4000-8000-000000000002';
const LEASE = '00000000-0000-4000-8000-000000000003';
const REGISTRATION = '00000000-0000-4000-8000-000000000004';
const DIGEST = 'a'.repeat(64);
const COORDINATE = 'A'.repeat(43);
const KEY = { algorithm: 'P-256/SHA-256', kty: 'EC', crv: 'P-256', x: COORDINATE, y: COORDINATE };
const NONCE_BYTES = new Uint8Array(32).fill(7);
const MESSAGE = Buffer.concat([Buffer.from('hornhoof:test-terminal:view-proof:v1\0'), NONCE_BYTES]);
const CHALLENGE = MESSAGE.toString('base64url');
const SIGNATURE = Buffer.alloc(64, 7).toString('base64url');
const CURSOR = `ttc1.${COORDINATE}`;
const REQUEST = { operationId: NONCE, leaseId: LEASE, expectedLeaseRevision: 1, registrationId: REGISTRATION, expectedIdentityDigest: DIGEST, browserPublicKey: KEY };
const RESPONSE = { viewId: VIEW, nonceId: NONCE, challenge: CHALLENGE, role: 'controller', rights: { control: true, message: false } };
const PROOF = { type: 'proof', viewId: VIEW, nonceId: NONCE, signature: SIGNATURE };
const CONTEXT = {
  viewId: VIEW, nonceId: NONCE, origin: 'https://example.com', leaseId: LEASE, leaseRevision: 1,
  registrationId: REGISTRATION, identityDigest: DIGEST, currentConnectionBinding: 'connection-1',
  subjectBindingDigest: DIGEST, role: 'controller', rights: RESPONSE.rights, browserPublicKey: KEY,
  nonceExpiresAtMs: 2000, leaseExpiresAtMs: 3000,
};

describe('browser public DTO boundaries', () => {
  it('accepts projected public coordinates without claiming they are an on-curve key', () => {
    expect(PublicBrowserKey.parse(KEY)).toEqual(KEY);
    expect(BindViewRequest.parse(REQUEST)).toEqual(REQUEST);
    expect(BindViewResponse.parse(RESPONSE)).toEqual(RESPONSE);
  });

  it.each(['d', 'ext', 'key_ops'])('rejects unprojected JWK field %s', field => {
    expect(PublicBrowserKey.safeParse({ ...KEY, [field]: 'not public wire data' }).success).toBe(false);
  });

  it.each([
    { algorithm: 'ES256' }, { kty: 'RSA' }, { crv: 'P-384' },
    { x: COORDINATE + '=' }, { y: 'A'.repeat(42) + 'B' }, { x: 'A'.repeat(42) },
  ])('rejects an incompatible public key %j', extra => {
    expect(PublicBrowserKey.safeParse({ ...KEY, ...extra }).success).toBe(false);
  });

  it.each(['role', 'rights', 'origin', 'streamUrl', 'token', 'text', 'argv', 'path'])('rejects caller authority field %s in a bind request', field => {
    expect(BindViewRequest.safeParse({ ...REQUEST, [field]: 'caller supplied' }).success).toBe(false);
  });

  it.each([
    { operationId: 'not-a-uuid' }, { expectedLeaseRevision: 0 }, { expectedLeaseRevision: 1.5 },
    { expectedLeaseRevision: Number.MAX_SAFE_INTEGER + 1 }, { expectedIdentityDigest: 'a'.repeat(40) },
    { browserPublicKey: { ...KEY, d: 'secret' } },
  ])('rejects an invalid bind identity %j', extra => {
    expect(BindViewRequest.safeParse({ ...REQUEST, ...extra }).success).toBe(false);
  });

  it('keeps observer rights false and accepts both controller rights independently', () => {
    expect(BindViewResponse.safeParse({ ...RESPONSE, role: 'observer', rights: { control: false, message: false } }).success).toBe(true);
    expect(BindViewResponse.safeParse({ ...RESPONSE, rights: { control: false, message: true } }).success).toBe(true);
  });

  it.each([
    { role: 'observer' }, { role: 'admin' }, { rights: { control: true } },
    { rights: { control: true, message: false, write: true } }, { streamUrl: 'wss://foreign.example' },
  ])('rejects incompatible derived response %j', extra => {
    expect(BindViewResponse.safeParse({ ...RESPONSE, ...extra }).success).toBe(false);
  });

  it.each([
    ['https://example.com', true], ['http://localhost:8080', true], ['https://example.com:8443', true],
    ['https://EXAMPLE.com', false], ['https://example.com/', false], ['https://example.com:443', false],
    ['https://person@example.com', false], ['https://example.com/path', false],
    ['https://example.com?x=1', false], ['https://example.com#x', false],
    ['null', false], ['file:///tmp/a', false], ['wss://example.com', false], ['not a URL', false],
    [`https://${'a'.repeat(2048)}.example`, false],
  ])('validates the exact serialized origin %s', (origin, accepted) => {
    expect(TestTerminalOrigin.safeParse(origin).success).toBe(accepted);
  });
});

describe('the purpose-bound challenge and raw P1363 signature codec', () => {
  it('encodes the supplied nonce and decodes all exact bytes to be signed', () => {
    expect(encodeViewChallenge(NONCE_BYTES)).toBe(CHALLENGE);
    expect(decodeViewChallenge(CHALLENGE)).toEqual(new Uint8Array(MESSAGE));
    expect(ViewChallenge.parse(CHALLENGE)).toBe(CHALLENGE);
    expect(NONCE_BYTES).toEqual(new Uint8Array(32).fill(7));
  });

  it.each([
    '', CHALLENGE + '=', CHALLENGE.slice(1), CHALLENGE.replace(/.$/, '*'),
    Buffer.concat([Buffer.from('other-purpose\0'), NONCE_BYTES]).toString('base64url'),
    Buffer.concat([Buffer.from('hornhoof:test-terminal:view-proof:v1\\0'), NONCE_BYTES]).toString('base64url'),
    Buffer.concat([MESSAGE, Buffer.from([0])]).toString('base64url'),
  ])('rejects malformed challenge %j', value => {
    expect(ViewChallenge.safeParse(value).success).toBe(false);
    expect(() => decodeViewChallenge(value)).toThrow(RangeError);
  });

  it.each([0, 31, 33])('rejects a nonce of %d bytes', size => {
    expect(() => encodeViewChallenge(new Uint8Array(size))).toThrow(RangeError);
  });

  it('roundtrips raw64 signature bytes without DER conversion', () => {
    expect(encodeViewSignature(new Uint8Array(64).fill(7))).toBe(SIGNATURE);
    expect(decodeViewSignature(SIGNATURE)).toEqual(new Uint8Array(64).fill(7));
    expect(ViewSignature.safeParse(SIGNATURE).success).toBe(true);
    expect(ViewProof.parse(PROOF)).toEqual(PROOF);
  });

  it.each([
    '', SIGNATURE + '=', 'A'.repeat(85) + 'B', '/'.repeat(86),
    Buffer.alloc(63).toString('base64url'), Buffer.alloc(65).toString('base64url'),
    Buffer.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]).toString('base64url'),
  ])('rejects malformed or DER-shaped signature %j', value => {
    expect(ViewSignature.safeParse(value).success).toBe(false);
    expect(() => decodeViewSignature(value)).toThrow(RangeError);
  });

  it.each([0, 63, 65, 72])('rejects raw signatures of %d bytes', size => {
    expect(() => encodeViewSignature(new Uint8Array(size))).toThrow(RangeError);
  });

  it('interoperates with real WebCrypto and Node verification on the supplied bytes', async () => {
    const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
    const publicWire = { algorithm: 'P-256/SHA-256', kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    expect(PublicBrowserKey.parse(publicWire)).toEqual(publicWire);
    const bytes = decodeViewChallenge(CHALLENGE);
    const raw = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new Uint8Array(bytes));
    const signature = decodeViewSignature(encodeViewSignature(new Uint8Array(raw)));
    const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' });
    expect(verify('sha256', MESSAGE, { key, dsaEncoding: 'ieee-p1363' }, signature)).toBe(true);
    expect(verify('sha256', Buffer.from(CHALLENGE), { key, dsaEncoding: 'ieee-p1363' }, signature)).toBe(false);
    expect(verify('sha256', Buffer.concat([MESSAGE, Buffer.from([1])]), { key, dsaEncoding: 'ieee-p1363' }, signature)).toBe(false);
  });
});

describe('strict proof-only client frames and bounded server frames', () => {
  it('keeps an observe cursor as typed metadata without defining browser resume', () => {
    expect(ObserveRequest.parse({ viewId: VIEW })).toEqual({ viewId: VIEW });
    expect(ObserveRequest.safeParse({ viewId: VIEW, cursor: CURSOR }).success).toBe(true);
    expect(TestTerminalCursor.parse(CURSOR)).toBe(CURSOR);
  });

  it.each([VIEW, CHALLENGE, 'ttc2.' + COORDINATE, CURSOR + '=', 'ttc1.' + 'A'.repeat(42) + 'B'])('rejects a cursor with the wrong purpose or encoding %j', cursor => {
    expect(TestTerminalCursor.safeParse(cursor).success).toBe(false);
    expect(ObserveRequest.safeParse({ viewId: VIEW, cursor }).success).toBe(false);
  });

  it.each(['input', 'resize', 'control', 'execute', 'cursor', 'message', 'close'])('rejects client frame %s even for a controller', type => {
    expect(ViewProof.safeParse({ ...PROOF, type }).success).toBe(false);
  });

  it.each(['text', 'data', 'cols', 'cursor', 'program', 'argv'])('rejects additional proof field %s', field => {
    expect(ViewProof.safeParse({ ...PROOF, [field]: 'unexpected' }).success).toBe(false);
  });

  it.each([
    { type: 'ready', write: false, message: false },
    { type: 'data', data: 'output\n', cursor: CURSOR },
    { type: 'error', reason: 'denied' }, { type: 'error', reason: 'expired' },
    { type: 'error', reason: 'unavailable' }, { type: 'error', reason: 'unknown' },
  ])('accepts bounded server frame %j without claiming proof/state ordering', frame => {
    expect(TestTerminalServerFrame.parse(frame)).toEqual(frame);
  });

  it.each([
    { type: 'ready', write: true }, { type: 'ready', write: false, message: false, token: 'no' },
    { type: 'data', data: 'text' }, { type: 'data', data: 'text', cursor: VIEW },
    { type: 'error', reason: 'secret-detail' }, { type: 'error', reason: 'denied', detail: 'private' },
    { type: 'close', code: 1000, reason: 'closed' },
  ])('rejects invalid server frame %j', frame => {
    expect(TestTerminalServerFrame.safeParse(frame).success).toBe(false);
  });

  it('bounds multibyte data by UTF-8 bytes and rejects unpaired Unicode', () => {
    expect(TestTerminalServerFrame.safeParse({ type: 'data', data: 'é'.repeat(16384), cursor: CURSOR }).success).toBe(true);
    expect(TestTerminalServerFrame.safeParse({ type: 'data', data: 'é'.repeat(16385), cursor: CURSOR }).success).toBe(false);
    expect(TestTerminalServerFrame.safeParse({ type: 'data', data: '\ud800', cursor: CURSOR }).success).toBe(false);
    expect(TestTerminalServerFrame.safeParse({ type: 'data', data: '\udc00', cursor: CURSOR }).success).toBe(false);
  });

  it('also bounds serialized frames when escaping inflates the wire size', () => {
    expect(TestTerminalServerFrame.safeParse({ type: 'data', data: '\0'.repeat(12000), cursor: CURSOR }).success).toBe(false);
  });

  it.each([
    { code: 1000, reason: 'closed' }, { code: 4403, reason: 'denied' },
    { code: 4408, reason: 'expired' }, { code: 4503, reason: 'unavailable' }, { code: 4500, reason: 'unknown' },
  ])('accepts a close event with its exact reason %j', close => {
    expect(TestTerminalClose.parse(close)).toEqual(close);
  });

  it.each([
    { code: 1006, reason: 'unknown' }, { code: 4408, reason: 'denied' },
    { code: 4403, reason: 'private information' }, { code: 1000, reason: 'closed', data: '' },
  ])('rejects mismatched, abnormal or unbounded close events %j', close => {
    expect(TestTerminalClose.safeParse(close).success).toBe(false);
  });
});

describe('comparison of trusted stored/current metadata, never a grant', () => {
  it('accepts matching live metadata without depending on object key order', () => {
    expect(TestViewBindingContext.parse(CONTEXT)).toEqual(CONTEXT);
    expect(checkTestViewBinding(CONTEXT, { ...CONTEXT, rights: { message: false, control: true } }, 1000)).toBe('current');
  });

  it.each([
    { viewId: NONCE }, { nonceId: VIEW }, { origin: 'https://foreign.example' }, { leaseId: VIEW },
    { leaseRevision: 2 }, { registrationId: VIEW }, { identityDigest: 'b'.repeat(64) },
    { currentConnectionBinding: 'connection-2' }, { subjectBindingDigest: 'b'.repeat(64) },
    { role: 'observer', rights: { control: false, message: false } },
    { rights: { control: false, message: false } }, { browserPublicKey: { ...KEY, y: 'B'.repeat(42) + 'A' } },
    { nonceExpiresAtMs: 2001 }, { leaseExpiresAtMs: 3001 }, { token: 'unexpected' },
  ])('marks changed binding metadata stale: %j', extra => {
    expect(checkTestViewBinding(CONTEXT, { ...CONTEXT, ...extra }, 1000)).toBe('stale');
    expect(checkTestViewBinding({ ...CONTEXT, ...extra }, CONTEXT, 1000)).toBe('stale');
  });

  it.each([
    { now: 1999, nonceExpiresAtMs: 2000, leaseExpiresAtMs: 3000, want: 'current' },
    { now: 2000, nonceExpiresAtMs: 2000, leaseExpiresAtMs: 3000, want: 'expired' },
    { now: 1000, nonceExpiresAtMs: 2000, leaseExpiresAtMs: 1000, want: 'expired' },
  ])('checks inclusive nonce and lease expiry: %j', ({ now, nonceExpiresAtMs, leaseExpiresAtMs, want }) => {
    const context = { ...CONTEXT, nonceExpiresAtMs, leaseExpiresAtMs };
    expect(checkTestViewBinding(context, context, now)).toBe(want);
  });

  it.each([null, {}, { ...CONTEXT, role: 'observer' }, { ...CONTEXT, leaseRevision: 0 }])('treats malformed metadata as stale: %j', value => {
    expect(checkTestViewBinding(value, value, 1000)).toBe('stale');
  });

  it.each([NaN, Infinity, -1])('does not accept invalid clock %j', now => {
    expect(checkTestViewBinding(CONTEXT, CONTEXT, now)).toBe('stale');
  });

  it.each([
    { frame: { type: 'ready', write: true, message: false }, want: true },
    { frame: { type: 'ready', write: true, message: true }, want: false },
    { frame: { type: 'ready', write: false, message: false }, want: false },
    { frame: { type: 'ready', write: true }, want: false },
    { frame: { type: 'data', data: '', cursor: CURSOR }, want: false },
  ])('requires the exact ready.write/control and ready.message/message mapping: %j', ({ frame, want }) => {
    expect(isTestViewReady(RESPONSE, frame)).toBe(want);
  });

  it('requires an observer ready with both rights false and rejects invalid responses', () => {
    const observer = { ...RESPONSE, role: 'observer', rights: { control: false, message: false } };
    expect(isTestViewReady(observer, { type: 'ready', write: false, message: false })).toBe(true);
    expect(isTestViewReady({ ...RESPONSE, role: 'observer' }, { type: 'ready', write: true, message: false })).toBe(false);
  });
});
