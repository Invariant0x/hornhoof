import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { totpCode, totpCodesAround } from '../src/secret-fill/totp.js';
import { SecretValue } from '../src/secret-fill/values.js';

/* RFC 6238, appendix B: the seeds are the ASCII digits, 20, 32 and 64 bytes long, in base32 here. */
const SHA1 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const SHA256 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA';
const SHA512 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA';

describe('one-time codes by RFC 6238 on a controlled clock', () => {
  it.each([
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ])('at %i s gives the RFC codes', (seconds, sha1, sha256, sha512) => {
    const at = seconds * 1000;
    expect(totpCode({ secret: SHA1, digits: 8, period: 30, algorithm: 'SHA1' }, at)).toBe(sha1);
    expect(totpCode({ secret: SHA256, digits: 8, period: 30, algorithm: 'SHA256' }, at)).toBe(sha256);
    expect(totpCode({ secret: SHA512, digits: 8, period: 30, algorithm: 'SHA512' }, at)).toBe(sha512);
  });

  it('keeps the last six digits for a six-digit code, with leading zeros', () => {
    expect(totpCode({ secret: SHA1, digits: 6, period: 30, algorithm: 'SHA1' }, 1111111109_000)).toBe('081804');
  });

  it('gives the codes of the period before, the current one and the one after', () => {
    const totp = { secret: SHA1, digits: 8, period: 30, algorithm: 'SHA1' } as const;
    expect(totpCodesAround(totp, 1111111111_000)).toEqual([totpCode(totp, 1111111081_000), '14050471', totpCode(totp, 1111111141_000)]);
  });

  it('refuses a secret that is not base32', () => {
    expect(() => totpCode({ secret: 'GEZ1', digits: 6, period: 30, algorithm: 'SHA1' }, 0)).toThrow();
  });
});

describe('a secret value', () => {
  it('shows as hidden in every way it can be printed and gives the value only to a callback', () => {
    const value = new SecretValue('marker-pw-71c9');
    expect(String(value)).toBe('[hidden]');
    expect(`${value}`).toBe('[hidden]');
    expect(JSON.stringify({ value })).toBe('{"value":"[hidden]"}');
    expect(inspect(value)).toBe('[hidden]');
    expect(inspect({ nested: value }, { depth: 5 })).not.toContain('marker');
    expect(Object.keys(value)).toEqual([]);
    expect(value.reveal(plain => plain.length)).toBe(14);
  });
});
