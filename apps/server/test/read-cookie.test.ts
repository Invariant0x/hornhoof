import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkRead, READ_MS, readPerson, signRead } from '../src/auth/read-cookie.js';

const SECRET = randomBytes(32);
const PERSON = '0d0c3b0e-58a4-4c6e-9d5c-0f3f6a1b2c3d';
const HASH = 'scrypt$one';
const NOW = Date.parse('2026-11-12T14:05:00.000Z');

describe('the cookie of a sign-in on a machine that only reads', () => {
  it('signs and checks', () => {
    const value = signRead(PERSON, HASH, NOW + READ_MS, SECRET);
    expect(readPerson(value)).toBe(PERSON);
    expect(checkRead(value, HASH, SECRET, NOW)).toBe(true);
    expect(checkRead(value, HASH, SECRET, NOW + READ_MS - 1)).toBe(true);
    expect(checkRead(value, HASH, SECRET, NOW + READ_MS)).toBe(false);
    const [person, until, mac] = value.split('.') as [string, string, string];
    /* Anything changed, another secret, or a person with no password: nobody. */
    expect(checkRead(['1d0c3b0e-58a4-4c6e-9d5c-0f3f6a1b2c3d', until, mac].join('.'), HASH, SECRET, NOW)).toBe(false);
    expect(checkRead([person, String(Number(until) + 1), mac].join('.'), HASH, SECRET, NOW)).toBe(false);
    expect(checkRead([person, until, `${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`].join('.'), HASH, SECRET, NOW)).toBe(false);
    expect(checkRead(value, HASH, randomBytes(32), NOW)).toBe(false);
    /* One mark has one spelling: the same bytes written another way are not the cookie that was given. */
    expect(Buffer.from(`${mac}=`, 'base64url').equals(Buffer.from(mac, 'base64url'))).toBe(true);
    expect(checkRead([person, until, `${mac}=`].join('.'), HASH, SECRET, NOW)).toBe(false);
    expect(checkRead(value, null, SECRET, NOW)).toBe(false);
    for (const odd of [undefined, '', 'a.b', `${person}.soon.${mac}`, `not-a-person.${until}.${mac}`, `${value}.more`]) {
      expect(checkRead(odd, HASH, SECRET, NOW), String(odd)).toBe(false);
    }
    expect([readPerson(undefined), readPerson('a.b.c'), readPerson(`${person}.x.${mac}`)]).toEqual([null, null, null]);
  });

  it('ends with a new password', () => {
    const value = signRead(PERSON, HASH, NOW + READ_MS, SECRET);
    expect(checkRead(value, 'scrypt$two', SECRET, NOW)).toBe(false);
  });
});
