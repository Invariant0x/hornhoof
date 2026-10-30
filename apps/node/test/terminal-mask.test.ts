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
});
