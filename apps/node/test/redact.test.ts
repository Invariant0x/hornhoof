import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetExact, holdExact, redact, secretForms } from '../src/redact.js';

describe('redact', () => {
  it('hides a token, its base64 form and every copy', () => {
    const token = 'sk-ant-oat01-abcdefghijklmnop';
    const b64 = Buffer.from(token).toString('base64');
    const text = `key=${token} again ${token} encoded ${b64}`;
    expect(redact(text, [token])).toBe('key=[hidden] again [hidden] encoded [hidden]');
  });

  it('leaves short values alone', () => {
    expect(redact('the word true stays', ['true', ''])).toBe('the word true stays');
  });
});

describe('exact values held for a time', () => {
  afterEach(() => {
    forgetExact();
    vi.useRealTimers();
  });

  it('hides a short password and a six-digit code until they expire, then leaves the code alone', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-01-01T00:00:00Z') });
    holdExact(['pw4x'], Number.POSITIVE_INFINITY);
    holdExact(['081804'], Date.now() + 600_000);
    expect(redact('code 081804 for pw4x', [])).toBe('code [hidden] for [hidden]');
    vi.setSystemTime(new Date('2030-01-01T00:10:01Z'));
    expect(redact('code 081804 for pw4x', [])).toBe('code 081804 for [hidden]');
  });

  it('never holds a value under four characters', () => {
    holdExact(['abc', ''], Number.POSITIVE_INFINITY);
    expect(redact('abc stays', [])).toBe('abc stays');
  });

  it('hides held values in the end of a stream as it does long secrets', () => {
    holdExact(['081804'], Number.POSITIVE_INFINITY);
    expect(secretForms([])).toContain('081804');
  });
});
