import { act, render, screen, waitFor } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LOCALES, PSEUDO_LOCALES, SOURCE_LOCALE } from '@hornhoof/protocol';
import { detectLanguage, LanguageProvider, LANGUAGES, loadMessages, missingKeysOf, plural, useLanguage, useT, type Language } from '../src/i18n';
import { en } from '../src/i18n/en';
import { keyPaths, withFallback } from '../src/i18n/fallback';
import { pseudoMessages } from '../src/i18n/pseudo';

const source = (name: string) => readFileSync(resolve(process.cwd(), 'src/i18n', name), 'utf8');

afterEach(() => {
  localStorage.removeItem('hh-lang');
  document.documentElement.lang = '';
  document.documentElement.dir = '';
  vi.unstubAllGlobals();
});

describe('the languages of the product', () => {
  it('are the registry, each named in its own words, with English first as the source', () => {
    expect(LANGUAGES).toEqual(LOCALES.map(({ id, name }) => ({ id, name })));
    expect(LANGUAGES[0]!.id).toBe(SOURCE_LOCALE);
  });

  it('give every registered language every text English has, and no text English lacks', async () => {
    for (const { id } of LANGUAGES) {
      await loadMessages(id);
      expect({ id, missing: missingKeysOf(id).missing }).toEqual({ id, missing: [] });
      expect({ id, extra: missingKeysOf(id).extra }).toEqual({ id, extra: [] });
    }
  });

  it('keep each text the kind it is in English: a sentence, or a phrase that takes values, and never empty', async () => {
    const english = keyPaths(en);
    for (const { id } of LANGUAGES) {
      const own = await loadMessages(id);
      const kinds = Object.fromEntries(keyPaths(own).map(([path, kind]) => [path, kind]));
      const wrong = english.filter(([path, kind]) => kinds[path] !== kind).map(([path]) => path);
      expect({ id, wrong }).toEqual({ id, wrong: [] });
    }
  });
});

describe('the words that wait for a language', () => {
  it('a text a language lacks reads in English, and the path is told', () => {
    const lacking: string[] = [];
    const base = { a: 'Save', nested: { b: 'Cancel', c: (n: number) => `${n} files` }, d: 'Keep' };
    const own = { a: 'Sauvegarder', nested: { c: (n: number) => `${n} fichiers` }, extra: 'unknown' };
    const merged = withFallback(base, own, path => lacking.push(path));
    expect(merged.a).toBe('Sauvegarder');
    expect(merged.nested.b).toBe('Cancel');
    expect(merged.nested.c(2)).toBe('2 fichiers');
    expect(merged.d).toBe('Keep');
    expect(lacking.sort()).toEqual(['d', 'nested.b']);
    expect(Object.keys(merged)).toEqual(['a', 'nested', 'd']);
  });

  it('tells the kind of every text, so a function that became a sentence is found', () => {
    expect(keyPaths({ a: 'x', b: { c: () => 'y' } })).toEqual([['a', 'string'], ['b.c', 'function']]);
  });
});

describe('plural forms by Intl for every category a language has', () => {
  const six = { zero: 'zero', one: 'one', two: 'two', few: 'few', many: 'many', other: 'other' };

  it('picks Russian one, few, many and other', () => {
    expect([1, 2, 5, 11, 21, 22, 1.5].map(n => plural('ru', n, six))).toEqual(['one', 'few', 'many', 'many', 'one', 'few', 'other']);
  });

  it('picks all six forms of a language that has six, through the mirrored test language', () => {
    expect([0, 1, 2, 3, 11, 100].map(n => plural('ar-XB', n, six))).toEqual(['zero', 'one', 'two', 'few', 'many', 'other']);
    expect(new Intl.PluralRules('ar-XB').resolvedOptions().pluralCategories.slice().sort()).toEqual(['few', 'many', 'one', 'other', 'two', 'zero']);
  });

  it('uses English one and other, and reads other where a language has a form the words do not give', () => {
    expect([0, 1, 2].map(n => plural('en', n, { one: 'file', other: 'files' }))).toEqual(['files', 'file', 'files']);
    expect(plural('ru', 5, { one: 'файл', other: 'файла' })).toBe('файла');
  });

  it('hand-makes no rule of a language', () => {
    expect(source('plural.ts')).not.toMatch(/%\s*10|'ru'|'en'|"ru"|"en"/);
  });
});

describe('the language a person gets', () => {
  it('is the saved choice, else the first browser language the product speaks, else English', () => {
    expect(detectLanguage(null, ['ru-RU', 'en'])).toBe('ru');
    expect(detectLanguage(null, ['de-DE'])).toBe('en');
    expect(detectLanguage('en', ['ru'])).toBe('en');
    expect(detectLanguage('xx', ['ru'])).toBe('ru');
  });

  it('takes a test language only where tests are allowed', () => {
    expect(detectLanguage('en-XL', ['ru'])).toBe('ru');
    expect(detectLanguage('en-XL', ['ru'], true)).toBe('en-XL');
    expect(detectLanguage('ar-XB', [], true)).toBe('ar-XB');
  });
});

function Probe() {
  const t = useT();
  const { language, setLanguage, dir } = useLanguage();
  return (
    <div>
      <p data-testid="title">{t.language.title}</p>
      <p data-testid="language">{language}</p>
      <p data-testid="dir">{dir}</p>
      {LANGUAGES.map(choice => <button key={choice.id} type="button" onClick={() => setLanguage(choice.id)}>{choice.name}</button>)}
      <button type="button" onClick={() => setLanguage('ar-XB' as Language)}>mirrored</button>
    </div>
  );
}

describe('the page in a language', () => {
  it('opens in the browser language when nothing is saved, and names its language and direction on the root', async () => {
    vi.stubGlobal('navigator', { ...navigator, languages: ['ru-RU', 'en'], language: 'ru-RU' });
    render(<LanguageProvider><Probe /></LanguageProvider>);
    expect(await screen.findByTestId('language')).toHaveTextContent('ru');
    expect(screen.getByTestId('title')).toHaveTextContent(await loadMessages('ru').then(t => t.language.title));
    expect(document.documentElement.lang).toBe('ru');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('keeps a saved choice over the browser, and saves a new one', async () => {
    localStorage.setItem('hh-lang', 'en');
    vi.stubGlobal('navigator', { ...navigator, languages: ['ru'], language: 'ru' });
    render(<LanguageProvider><Probe /></LanguageProvider>);
    expect(screen.getByTestId('language')).toHaveTextContent('en');
    const russian = LANGUAGES.find(choice => choice.id === 'ru')!;
    act(() => screen.getByRole('button', { name: russian.name }).click());
    await waitFor(() => expect(screen.getByTestId('language')).toHaveTextContent('ru'));
    expect(localStorage.getItem('hh-lang')).toBe('ru');
    expect(document.documentElement.lang).toBe('ru');
  });

  it('reads a right-to-left language right to left, on the root and for what a widget needs', async () => {
    localStorage.setItem('hh-lang', 'ar-XB');
    render(<LanguageProvider pseudo><Probe /></LanguageProvider>);
    expect(await screen.findByTestId('dir')).toHaveTextContent('rtl');
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
    expect(document.documentElement.lang).toBe('ar-XB');
    act(() => screen.getByRole('button', { name: 'English' }).click());
    await waitFor(() => expect(document.documentElement.dir).toBe('ltr'));
  });

  it('does not take a test language from the saved choice outside a test build', async () => {
    localStorage.setItem('hh-lang', 'ar-XB');
    render(<LanguageProvider><Probe /></LanguageProvider>);
    expect(await screen.findByTestId('language')).not.toHaveTextContent('ar-XB');
  });
});

describe('loading only the language a person speaks', () => {
  it('keeps every other language out of the first load, and brings a language when it is asked for', async () => {
    expect(source('index.tsx')).not.toMatch(/from '\.\/(?!en'|plural'|fallback'|format')[a-z][a-zA-Z-]*'/);
    expect(source('index.tsx')).not.toMatch(/from '\.\/ru'/);
    vi.resetModules();
    const fresh = await import('../src/i18n');
    expect(fresh.cachedMessages('ru')).toBeUndefined();
    const ru = await fresh.loadMessages('ru');
    expect(fresh.cachedMessages('ru')).toBe(ru);
    expect(ru.language.title).not.toBe(en.language.title);
  });

  it('reads English where a chunk does not load, rather than showing nothing', async () => {
    vi.resetModules();
    vi.doMock('../src/i18n/load', () => ({ loadLocale: async () => { throw new Error('offline'); } }));
    onTestFinished(() => void vi.doUnmock('../src/i18n/load'));
    const fresh = await import('../src/i18n');
    expect(await fresh.loadMessages('ru')).toBe(fresh.cachedMessages('en'));
  });
});

describe('languages made for tests', () => {
  it('stretch every text by 40% and mark it, so a text that skips the files shows plain', () => {
    const long = pseudoMessages('en-XL', en);
    expect(long.language.title).toMatch(/^⟦.*⟧$/);
    expect(long.language.title.length).toBeGreaterThanOrEqual(Math.ceil(en.language.title.length * 1.4));
    expect(long.errors.codes.internal.length).toBeGreaterThanOrEqual(Math.ceil(en.errors.codes.internal.length * 1.4));
    expect(long.phones.waiting(3)).toMatch(/3/);
  });

  it('mirror: the same text between bidirectional marks', () => {
    const mirrored = pseudoMessages('ar-XB', en);
    expect(mirrored.language.title).toBe(`‫${en.language.title}‬`);
  });

  it('are never shipped, and are all the registry names', () => {
    for (const pseudo of PSEUDO_LOCALES) expect(LANGUAGES.map(choice => choice.id)).not.toContain(pseudo.id);
  });
});

describe('the script of a language', () => {
  it('is named on the root, and a script that is not the product\'s own brings its font file', async () => {
    localStorage.setItem('hh-lang', 'ar-XB');
    render(<LanguageProvider pseudo><Probe /></LanguageProvider>);
    await waitFor(() => expect(document.documentElement.dataset.script).toBe('Arab'));
    act(() => screen.getByRole('button', { name: 'English' }).click());
    await waitFor(() => expect(document.documentElement.dataset.script).toBe('Latn'));
  });

  it('has a font file for every script of the registry that is neither Latin nor Cyrillic', () => {
    const own = new Set(['Latn', 'Cyrl']);
    const scripts = [...LOCALES, ...PSEUDO_LOCALES].map(locale => locale.script).filter(script => !own.has(script));
    const files = readdirSync(resolve(process.cwd(), 'src/fonts/scripts'));
    for (const script of new Set(scripts)) expect(files, script).toContain(`${script}.css`);
  });
});
