import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as locales from '../src/locales.js';
import * as protocol from '../src/index.js';

const source = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

/* A registry as it will look with the languages of stage B, to prove the matching without any language named in code. */
const TWELVE: readonly locales.LocaleInfo[] = [
  { id: 'en', name: 'English', english: 'English', script: 'Latn', dir: 'ltr' },
  { id: 'ru', name: 'Русский', english: 'Russian', script: 'Cyrl', dir: 'ltr' },
  { id: 'zh-Hans', name: '简体中文', english: 'Simplified Chinese', script: 'Hans', dir: 'ltr' },
  { id: 'es', name: 'Español', english: 'Spanish', script: 'Latn', dir: 'ltr' },
  { id: 'hi', name: 'हिन्दी', english: 'Hindi', script: 'Deva', dir: 'ltr' },
  { id: 'ar', name: 'العربية', english: 'Arabic', script: 'Arab', dir: 'rtl' },
  { id: 'pt-BR', name: 'Português (Brasil)', english: 'Brazilian Portuguese', script: 'Latn', dir: 'ltr' },
  { id: 'fr', name: 'Français', english: 'French', script: 'Latn', dir: 'ltr' },
];

describe('the registry of languages', () => {
  it('is a subpath of its own that imports nothing, and the same lists from the main entry', () => {
    expect(JSON.parse(source('package.json')).exports['./locales']).toEqual({ types: './dist/locales.d.ts', default: './dist/locales.js' });
    expect(source('src/locales.ts')).not.toMatch(/^\s*import\b/m);
    expect(protocol.LOCALES).toBe(locales.LOCALES);
    expect(protocol.matchLocale).toBe(locales.matchLocale);
  });

  it('ships English as the source and every language with a name in its own words, a script and a direction', () => {
    expect(locales.SOURCE_LOCALE).toBe('en');
    expect(locales.LOCALES[0]!.id).toBe(locales.SOURCE_LOCALE);
    for (const info of locales.LOCALES) {
      expect(info.name.trim()).not.toBe('');
      expect(info.english.trim()).not.toBe('');
      expect(['ltr', 'rtl']).toContain(info.dir);
      expect(info.script).toMatch(/^[A-Z][a-z]{3}$/);
      expect(() => new Intl.PluralRules(info.id)).not.toThrow();
      expect(Intl.DateTimeFormat.supportedLocalesOf(info.id)).toEqual([info.id]);
    }
    expect(new Set(locales.LOCALES.map(info => info.id)).size).toBe(locales.LOCALES.length);
  });

  it('keeps the pseudo-languages of the tests apart from the shipped ones', () => {
    for (const pseudo of locales.PSEUDO_LOCALES) {
      expect(locales.isLocaleId(pseudo.id)).toBe(false);
      expect(locales.isPseudoLocaleId(pseudo.id)).toBe(true);
      expect(locales.LOCALES.map(info => info.id)).not.toContain(pseudo.id);
    }
    expect(locales.PSEUDO_LOCALES.map(pseudo => pseudo.dir).sort()).toEqual(['ltr', 'rtl']);
    expect(locales.localeInfo('en-XL')?.dir).toBe('ltr');
    expect(locales.localeInfo('ar-XB')?.dir).toBe('rtl');
    expect(locales.localeInfo('xx')).toBeUndefined();
  });

  it('knows the direction of a language from the registry', () => {
    expect(locales.directionOf('en')).toBe('ltr');
    expect(locales.directionOf('ar-XB')).toBe('rtl');
    expect(locales.directionOf('unknown')).toBe('ltr');
    expect(locales.directionOf('ar', TWELVE)).toBe('rtl');
  });
});

describe('the language a browser asks for', () => {
  it('follows the first language the product speaks, English when none', () => {
    expect(locales.matchLocale(['ru-RU', 'en'])).toBe('ru');
    expect(locales.matchLocale(['de-DE'])).toBe('en');
    expect(locales.matchLocale([])).toBe('en');
    expect(locales.matchLocale(['xx-YY', 'RU'])).toBe('ru');
  });

  it('matches by language and script through the registry alone', () => {
    const match = (...asked: string[]) => locales.matchLocale(asked, TWELVE);
    expect(match('zh-CN')).toBe('zh-Hans');
    expect(match('zh-Hans-SG')).toBe('zh-Hans');
    expect(match('zh-TW')).toBe('zh-Hans');
    expect(match('pt-PT')).toBe('pt-BR');
    expect(match('pt')).toBe('pt-BR');
    expect(match('es-MX')).toBe('es');
    expect(match('hi-IN')).toBe('hi');
    expect(match('ar-EG', 'en')).toBe('ar');
    expect(match('de', 'fr-CA')).toBe('fr');
    expect(match('ja')).toBe('en');
    expect(match('invalid tag!', 'ru')).toBe('ru');
  });
});

describe('Accept-Language', () => {
  it('lists the languages by the weights the visitor gave, never the ones refused', () => {
    expect(locales.parseAcceptLanguage('ru-RU,ru;q=0.9,en;q=0.8')).toEqual(['ru-RU', 'ru', 'en']);
    expect(locales.parseAcceptLanguage('en;q=0.5, ru;q=0.9, de;q=0')).toEqual(['ru', 'en']);
    expect(locales.parseAcceptLanguage('*, fr')).toEqual(['fr']);
    expect(locales.parseAcceptLanguage(undefined)).toEqual([]);
    expect(locales.parseAcceptLanguage('')).toEqual([]);
  });

  it('chooses the language of a header', () => {
    expect(locales.localeOfHeader('de-DE,de;q=0.9,ru;q=0.5')).toBe('ru');
    expect(locales.localeOfHeader('fr;q=0.9, ar;q=0.8', TWELVE)).toBe('fr');
    expect(locales.localeOfHeader(undefined)).toBe('en');
  });
});

describe('a text per language', () => {
  const texts = { en: 'Hello', ru: 'Привет' } as const;

  it('reads a language, else English', () => {
    expect(locales.say(texts, 'ru')).toBe('Привет');
    expect(locales.say(texts, 'en')).toBe('Hello');
    expect(locales.say({ en: 'Hello' }, 'ru')).toBe('Hello');
    expect(locales.say(texts, 'zh-Hans')).toBe('Hello');
  });
});
