import { describe, expect, it } from 'vitest';
import { isLinkName, linkNameOf, randomLinkName } from '../src/link.js';

describe('linkNameOf', () => {
  it('writes a Russian name in Latin letters, lowercase, with single hyphens between words', () => {
    expect(linkNameOf('Рога и копыта')).toBe('roga-i-kopyta');
    expect(linkNameOf('Щука, Жук & Юла')).toBe('schuka-zhuk-yula');
    expect(linkNameOf('Объявления Хабаровска')).toBe('obyavleniya-habarovska');
    expect(linkNameOf('\u0401лка')).toBe('yolka');
  });

  it('keeps Latin letters and digits and turns everything else into one hyphen', () => {
    expect(linkNameOf('  Acme  Corp. 2 ')).toBe('acme-corp-2');
    expect(linkNameOf('Café Zürich')).toBe('cafe-zurich');
    expect(linkNameOf('--Hornhoof--')).toBe('hornhoof');
    expect(linkNameOf('!!!')).toBe('');
    expect(linkNameOf('公司')).toBe('');
  });

  it('stops at 63 characters, without a hyphen at the end', () => {
    const name = linkNameOf(`${'a'.repeat(62)} b`);
    expect(name).toBe('a'.repeat(62));
    expect(linkNameOf('Очень длинное название компании, которое не помещается в одну строку адреса')).toHaveLength(63);
    expect(isLinkName(linkNameOf('Очень длинное название компании, которое не помещается в одну строку адреса'))).toBe(true);
  });
});

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
