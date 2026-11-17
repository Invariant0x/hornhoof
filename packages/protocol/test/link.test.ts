import { describe, expect, it } from 'vitest';
import { isLinkName, randomLinkName } from '../src/link.js';

describe('isLinkName', () => {
  it('takes 1 to 63 lowercase letters, digits and single hyphens, with no hyphen at either end', () => {
    for (const ok of ['a', 'acme', 'roga-i-kopyta', '5y32cnxttxtucl3hhwbnzq4q', 'a'.repeat(63)]) expect(isLinkName(ok), ok).toBe(true);
    for (const bad of ['', '-acme', 'acme-', 'Acme', 'acme corp', 'acme.corp', 'а', 'a'.repeat(64), 'xn--acme', 'acme--corp']) expect(isLinkName(bad), bad).toBe(false);
  });
});

describe('randomLinkName', () => {
  it('is long, random and a valid name', () => {
    const names = new Set(Array.from({ length: 20 }, () => randomLinkName()));
    expect(names.size).toBe(20);
    for (const name of names) {
      expect(name).toMatch(/^[a-z0-9]{24}$/);
      expect(isLinkName(name)).toBe(true);
    }
  });
});
