import { describe, expect, it } from 'vitest';
import { StreamMask } from '../src/terminal/mask.js';

const SECRET = 'tok-1234567890abcdef';

describe('hiding secrets on a live screen', () => {
  it('hides a secret the screen sends in two pieces', () => {
    const mask = new StreamMask(() => [SECRET]);
    const out = mask.push('abc tok-12345') + mask.push('67890abcdef end') + mask.flush();
    expect(out).toBe('abc [hidden] end');
  });

  it('sends plain text at once, and holds only what could start a secret', () => {
    const mask = new StreamMask(() => [SECRET]);
    expect(mask.push('hello ')).toBe('hello ');
    expect(mask.push('see tok-')).toBe('see ');
    expect(mask.push('x')).toBe('tok-x');
  });

  it('gives back what it held when the screen goes quiet', () => {
    const mask = new StreamMask(() => [SECRET]);
    expect(mask.push('the end tok')).toBe('the end ');
    expect(mask.flush()).toBe('tok');
  });

  it('hides a secret the agent printed in base64', () => {
    const mask = new StreamMask(() => [SECRET]);
    expect(mask.push(`key ${Buffer.from(SECRET).toString('base64')} ok`) + mask.flush()).toBe('key [hidden] ok');
  });

  it('hides a long start of a secret when the screen goes quiet on it', () => {
    const mask = new StreamMask(() => [SECRET]);
    expect(mask.push('key tok-1234567')).toBe('key ');
    expect(mask.flush()).toBe('[hidden]');
  });

  it('hides the rest of a secret whose short start went out on a quiet screen', () => {
    const mask = new StreamMask(() => [SECRET]);
    expect(mask.push('see tok-') + mask.flush()).toBe('see tok-');
    expect(mask.push('1234567890abcdef end') + mask.flush()).toBe('[hidden] end');
  });

  it('keeps a secret hidden when it comes one quiet piece at a time, as an answer streams', () => {
    const mask = new StreamMask(() => [SECRET]);
    const out = [...SECRET].map(c => mask.push(c) + mask.flush()).join('');
    expect(out.replaceAll('[hidden]', '')).toBe('tok-123');
  });

  it('forgets a start that the screen did not go on with', () => {
    const mask = new StreamMask(() => [SECRET]);
    expect(mask.push('tok') + mask.flush()).toBe('tok');
    expect(mask.push('en ok') + mask.flush()).toBe('en ok');
  });
});
