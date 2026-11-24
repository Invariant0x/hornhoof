import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCALES, SOURCE_LOCALE } from '@hornhoof/protocol';
import { packText, packTextKeys, text } from '../src/world/pack-text';
import { loadEveryPackTexts } from '../src/world-packs/pack-text-load';

const SRC = resolve(process.cwd(), 'src');
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? files(resolve(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [resolve(dir, entry.name)] : []));

/* The English texts given through text() in the source of one folder, so a text built only when it runs is counted. */
const GIVEN = (...dirs: string[]): Set<string> =>
  new Set(
    dirs
      .flatMap(dir => files(resolve(SRC, dir)))
      .filter(file => !file.endsWith('pack-text.ts') && !file.includes('locales') && !file.includes('pack-locales'))
      .flatMap(file => [...readFileSync(file, 'utf8').matchAll(/\btext\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*\)/g)])
      .map(match => (match[1] ?? match[2]!).replace(/\\(.)/g, '$1')),
  );

/* A pack's words are in its own folder, the engine's in its own: no pack's word reaches the engine. */
const PLACES = [
  { name: 'the engine', given: GIVEN('world'), folder: 'world/pack-locales' },
  ...readdirSync(resolve(SRC, 'world-packs'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(resolve(SRC, 'world-packs', entry.name, 'locales')))
    .map(entry => ({ name: `the ${entry.name} pack`, given: GIVEN(`world-packs/${entry.name}`), folder: `world-packs/${entry.name}/locales` })),
];

const FILES = import.meta.glob<{ default: Record<string, string> }>(['../src/world/pack-locales/*.ts', '../src/world-packs/*/locales/*.ts'], { eager: true });
const fileOf = (folder: string, id: string): Record<string, string> => {
  const file = FILES[`../src/${folder}/${id}.ts`];
  if (!file) throw new Error(`${folder} has no file for ${id}`);
  return file.default;
};

describe('the words of the world engine and its packs, a file per language', () => {
  it('give the engine and the packs their texts through text(), and some of them', () => {
    expect(PLACES.length).toBeGreaterThanOrEqual(4);
    expect(PLACES.every(place => place.given.size > 0)).toBe(true);
  });

  for (const { id } of LOCALES.filter(locale => locale.id !== SOURCE_LOCALE)) {
    it.each(PLACES.map(place => [place.name, place] as const))(`${id}: %s has every text it gives, and none it no longer gives`, (_name, place) => {
      const own = fileOf(place.folder, id);
      expect({ missing: [...place.given].filter(key => !(key in own)) }).toEqual({ missing: [] });
      expect({ orphans: Object.keys(own).filter(key => !place.given.has(key)) }).toEqual({ orphans: [] });
      expect({ empty: Object.entries(own).filter(([, value]) => !value.trim()).map(([key]) => key) }).toEqual({ empty: [] });
    });
  }

  it('read a text in the language asked, and in English where a language has no file or no word', () => {
    loadEveryPackTexts();
    const key = text('Reed hut');
    expect(packText(key, 'ru')).not.toBe(key);
    expect(packText(key, SOURCE_LOCALE)).toBe(key);
    expect(packText(key, 'xx')).toBe(key);
    expect(packText('A text no file has', 'ru')).toBe('A text no file has');
    expect(packTextKeys()).toContain(key);
  });

  it('give the static map viewer every text of its English file in every language of the registry', () => {
    const viewer = import.meta.glob<{ default: Record<string, string> }>('../src/world-packs/viewer-locales/*.ts', { eager: true });
    const english = Object.keys(viewer['../src/world-packs/viewer-locales/en.ts']!.default).sort();
    for (const { id } of LOCALES) {
      const own = viewer[`../src/world-packs/viewer-locales/${id}.ts`]?.default;
      expect(own, `viewer-locales/${id}.ts`).toBeDefined();
      expect(Object.keys(own!).sort()).toEqual(english);
      expect(Object.values(own!).filter(text => !text.trim())).toEqual([]);
    }
  });
});
