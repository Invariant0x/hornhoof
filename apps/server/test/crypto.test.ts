import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { decryptSecret, encryptSecret } from '../src/crypto/secrets.js';
import { hashToken, newToken, signedBody, signedToken } from '../src/crypto/tokens.js';

const KEY = Buffer.alloc(32, 3);

describe('passwords', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(stored.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('wrong horse battery', stored)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same password')).not.toBe(await hashPassword('same password'));
  });

  it('rejects a malformed stored hash', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
  });
});

describe('secrets', () => {
  it('round trips a secret', () => {
    const enc = encryptSecret('sk-ant-test-1234', KEY);
    expect(enc.startsWith('v1.')).toBe(true);
    expect(enc).not.toContain('sk-ant');
    expect(decryptSecret(enc, KEY)).toBe('sk-ant-test-1234');
  });

  it('fails on tampered data', () => {
    const parts = encryptSecret('sk-ant-test-1234', KEY).split('.');
    const data = Buffer.from(parts[3]!, 'base64');
    data[0] = data[0]! ^ 1;
    parts[3] = data.toString('base64');
    expect(() => decryptSecret(parts.join('.'), KEY)).toThrow();
  });

  it('fails with another key', () => {
    expect(() => decryptSecret(encryptSecret('secret', KEY), Buffer.alloc(32, 4))).toThrow();
  });
});

describe('tokens', () => {
  it('makes long random tokens and stable hashes', () => {
    const t = newToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(t);
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs a body for one purpose as base64url JSON and the HMAC of the purpose and it, and reads back only that', () => {
    const payload = Buffer.from('{"f":1}').toString('base64url');
    const token = signedToken(KEY, 'purpose one', { f: 1 });
    expect(token).toBe(`${payload}.${createHmac('sha256', KEY).update(`purpose one\n${payload}`).digest('base64url')}`);
    expect(signedBody(KEY, 'purpose one', token)).toEqual({ f: 1 });
    for (const [key, purpose, given] of [[Buffer.alloc(32, 4), 'purpose one', token], [KEY, 'purpose two', token], [KEY, 'purpose one', `${token}x`], [KEY, 'purpose one', `${token}.x`], [KEY, 'purpose one', 'x']] as const) {
      expect(signedBody(key, purpose, given)).toBeNull();
    }
  });
});
