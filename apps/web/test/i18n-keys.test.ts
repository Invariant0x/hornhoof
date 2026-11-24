import { describe, expect, it } from 'vitest';
import { keyList } from '../scripts/i18n-keys';
import { CONTEXT, SAMPLES } from '../src/i18n/context';
import { en } from '../src/i18n/en';
import { keyPaths } from '../src/i18n/fallback';
import ru from '../src/i18n/ru';

/* The key list a translator is handed: every text of the screens by a path that stays, a note where the meaning is
   ambiguous, and the words a language has so far. */
describe('the key list for a translator', () => {
  const list = keyList();

  it('holds every text of English once, by its path, in the order of en.ts', () => {
    const own = new Set(list.map(entry => entry.key));
    expect(own.size).toBe(list.length);
    const missing = keyPaths(en).filter(([path, kind]) => kind !== 'other' && !own.has(path)).map(([path]) => path);
    expect(missing).toEqual([]);
    expect(list[0]!.key).toBe(keyPaths(en)[0]![0]);
  });

  it('reads every phrase with values: none shows as empty, undefined or not a number', () => {
    const bad = list.filter(entry => entry.english.trim() === '' || /undefined|NaN|\[object/.test(entry.english)).map(entry => entry.key);
    expect(bad).toEqual([]);
  });

  it('names only texts that exist in a note or a sample, and writes each note as a plain sentence', () => {
    const own = new Set(list.map(entry => entry.key));
    expect(Object.keys(CONTEXT).filter(key => !own.has(key))).toEqual([]);
    expect(Object.keys(SAMPLES).filter(key => !own.has(key))).toEqual([]);
    for (const [key, note] of Object.entries(CONTEXT)) {
      expect(note.trim().length, key).toBeGreaterThan(10);
      expect(note, key).not.toMatch(/—/);
    }
    expect(list.filter(entry => entry.context).length).toBe(Object.keys(CONTEXT).length);
  });

  it('carries the words of a language beside the English, empty where it has none', () => {
    const russian = keyList(ru);
    expect(russian.length).toBe(list.length);
    expect(russian.filter(entry => entry.translation === '').map(entry => entry.key)).toEqual([]);
    expect(keyList({}).every(entry => entry.translation === '')).toBe(true);
  });
});
