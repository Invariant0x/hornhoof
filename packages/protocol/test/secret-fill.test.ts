import { describe, expect, it } from 'vitest';
import { FillPlain, FILL_SHOT_MAX, NUMBERED, parseNodeMessage, parseServerMessage, SecretFill, SecretFilled, SiteSession } from '../src/index.js';

const REQUEST = '10000000-0000-4000-8000-000000000001';
const ENTRY = '10000000-0000-4000-8000-000000000002';
const JOB = '10000000-0000-4000-8000-000000000003';
const PHONE_SESSION = '10000000-0000-4000-8000-000000000004';

const fill = (over: Record<string, unknown> = {}) => ({
  type: 'secret.fill',
  requestId: REQUEST,
  jobId: JOB,
  entryId: ENTRY,
  sealed: '-----BEGIN AGE ENCRYPTED FILE-----\nabc\n-----END AGE ENCRYPTED FILE-----\n',
  fields: ['login', 'password', 'code'],
  target: { kind: 'browser', address: 'https://example.com/login' },
  expiresAt: '2030-01-01T00:01:00.000Z',
  ...over,
});

describe('secret fill messages', () => {
  it('carries a browser and a phone fill from the server to a node', () => {
    expect(parseServerMessage(JSON.stringify(fill()))).toEqual(fill());
    const phone = fill({ fields: ['password'], target: { kind: 'phone', phoneSessionId: PHONE_SESSION, generation: 3, element: 'node-17', site: 'https://example.com/login' } });
    expect(parseServerMessage(JSON.stringify(phone))).toEqual(phone);
  });

  it('refuses a fill with no field, a repeated field, an unknown field or extra keys', () => {
    expect(SecretFill.safeParse(fill({ fields: [] })).success).toBe(false);
    expect(SecretFill.safeParse(fill({ fields: ['password', 'password'] })).success).toBe(false);
    expect(SecretFill.safeParse(fill({ fields: ['pin'] })).success).toBe(false);
    expect(SecretFill.safeParse(fill({ password: 'plain' })).success).toBe(false);
  });

  it('opens a browser only on a public web address', () => {
    for (const address of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'not an address', `https://example.com/${'a'.repeat(2100)}`]) {
      expect(SecretFill.safeParse(fill({ target: { kind: 'browser', address } })).success, address).toBe(false);
    }
    expect(SecretFill.safeParse(fill({ target: { kind: 'browser', address: 'http://example.com' } })).success).toBe(true);
  });

  it('bounds the element reference of a phone target', () => {
    const phone = (element: unknown, site: unknown = null) => fill({ target: { kind: 'phone', phoneSessionId: PHONE_SESSION, generation: 0, element, site } });
    expect(SecretFill.safeParse(phone(null)).success).toBe(true);
    expect(SecretFill.safeParse(phone('')).success).toBe(false);
    expect(SecretFill.safeParse(phone('x'.repeat(201))).success).toBe(false);
    expect(SecretFill.safeParse(phone(null, 'file:///sdcard')).success).toBe(false);
  });

  it('answers with a status and the filled fields only', () => {
    const done = { type: 'secret.filled', requestId: REQUEST, status: 'filled', filled: ['password'] };
    expect(parseNodeMessage(JSON.stringify(done))).toEqual(done);
    expect(SecretFilled.safeParse({ ...done, status: 'signed in as someone' }).success).toBe(false);
    expect(SecretFilled.safeParse({ ...done, detail: 'the password was hunter2' }).success).toBe(false);
  });

  it('bounds a masked screenshot and a site session in the answer', () => {
    const done = { type: 'secret.filled', requestId: REQUEST, status: 'needs_person', filled: ['login'] };
    expect(SecretFilled.safeParse({ ...done, shot: 'iVBORw0KGgo=' }).success).toBe(true);
    expect(SecretFilled.safeParse({ ...done, shot: 'A'.repeat(FILL_SHOT_MAX + 4) }).success).toBe(false);
    expect(SecretFilled.safeParse({ ...done, shot: 'not base64!' }).success).toBe(false);
    const session = { cookies: [{ name: 'sid', value: 'v', domain: '.example.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [{ origin: 'https://example.com', localStorage: [{ name: 'k', value: 'v' }] }] };
    expect(SiteSession.safeParse(session).success).toBe(true);
    expect(SiteSession.safeParse({ ...session, cookies: Array.from({ length: 1001 }, () => session.cookies[0]) }).success).toBe(false);
  });

  it('keeps fills out of the numbered messages, so no outbox writes them to disk', () => {
    expect(NUMBERED).not.toContain('secret.filled');
  });

  it('reads the plain values only with a password of four characters or more and a base32 code secret', () => {
    const plain = { login: 'person@example.com', password: 'abcd', totp: { secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1' } };
    expect(FillPlain.parse(plain)).toEqual(plain);
    expect(FillPlain.safeParse({ ...plain, password: 'abc' }).success).toBe(false);
    expect(FillPlain.safeParse({ ...plain, totp: { ...plain.totp, secret: 'not base32 1' } }).success).toBe(false);
    expect(FillPlain.safeParse({ ...plain, totp: { ...plain.totp, digits: 5 } }).success).toBe(false);
    expect(FillPlain.safeParse({ ...plain, totp: null }).success).toBe(true);
  });

  it('lets a node say which targets it fills', () => {
    const hello = { type: 'hello', version: '1', loggedIn: true, running: [], live: [], fills: ['browser'] };
    expect(parseNodeMessage(JSON.stringify(hello))).toMatchObject({ fills: ['browser'] });
    expect(parseNodeMessage(JSON.stringify({ ...hello, fills: ['laptop'] }))).toBeNull();
  });
});
