import { LOCALES } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { en } from '../src/locales/en.js';
import { saying, wordLanguages, wordsFor } from '../src/locales/index.js';

/* Every path of a language's words with what it is, the arrays by their length. */
function shape(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return [`${path}:array:${value.length}`];
  if (typeof value === 'object' && value !== null) return Object.entries(value).flatMap(([key, inner]) => shape(inner, path ? `${path}.${key}` : key));
  return [`${path}:${typeof value}`];
}

describe("the server's own words, a file per language", () => {
  it('speak every language of the registry', () => {
    expect(wordLanguages().sort()).toEqual(LOCALES.map(locale => locale.id).sort());
  });

  it('give every language every text English has, of the same kind, and none it lacks', () => {
    const english = shape(en);
    for (const { id } of LOCALES) expect({ id, shape: shape(wordsFor(id)) }).toEqual({ id, shape: english });
  });

  it('keep each text with something in it, in every language', () => {
    for (const { id } of LOCALES) {
      const text = JSON.stringify(wordsFor(id), (_key, value: unknown) => (typeof value === 'function' ? String((value as (...a: string[]) => unknown)('X', 'Y', 'Z')) : value));
      expect(text, id).not.toMatch(/:\s*""/);
    }
  });

  it('read English where a language has no words, and say a line in each language the server has', () => {
    expect(wordsFor('xx')).toBe(en);
    const lines = saying(words => words.notices.afterTurn('42'));
    expect(lines.en).toBe('after turn 42');
    expect(Object.keys(lines).sort()).toEqual(LOCALES.map(locale => locale.id).sort());
    expect(lines.ru).toBe('после хода 42');
  });
});
