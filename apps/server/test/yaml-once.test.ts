import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { readsOf } from './yaml-once.js';

/* Every server built in a test reads the same role and skill templates, so a file parses each text once (yaml-once.ts). */
describe('YAML a test file reads more than once', () => {
  it('is parsed once and given back the same', () => {
    const text = 'id: dev\ntitle: { en: Developer, ru: Разработчик }\nskills: [a, b]\n';
    const before = readsOf(text);
    const first = parse(text) as Record<string, unknown>;
    const second = parse(text) as Record<string, unknown>;
    expect(readsOf(text) - before).toBe(1);
    expect(second).toEqual({ id: 'dev', title: { en: 'Developer', ru: 'Разработчик' }, skills: ['a', 'b'] });
    expect(second).toEqual(first);
  });

  it('gives each reader a copy of its own, so what one test changes the next does not see', () => {
    const text = 'skills: [a]\n';
    const first = parse(text) as { skills: string[] };
    first.skills.push('b');
    expect(parse(text)).toEqual({ skills: ['a'] });
    expect(parse(text)).not.toBe(parse(text));
  });

  it('still refuses a text that is no YAML, every time it is read', () => {
    const text = 'id: [unclosed\n';
    expect(() => parse(text)).toThrow();
    expect(() => parse(text)).toThrow();
  });

  it('reads a text with options as YAML itself would', () => {
    expect(parse('a: 1', { mapAsMap: true })).toEqual(new Map([['a', 1]]));
    expect(parse('a: 1', (key, value) => (key === 'a' ? 2 : value))).toEqual({ a: 2 });
  });
});
