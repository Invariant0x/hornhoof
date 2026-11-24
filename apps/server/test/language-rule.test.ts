import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOCALES, SOURCE_LOCALE, type LocaleInfo } from '@hornhoof/protocol';
import { inEveryLanguage, TRANSLATIONS, writtenIn } from './registry-languages.js';

/* English is the source of every text, and the languages that follow it are the ones the registry lists
   (CONTRIBUTING.md, "Adding a language"). The rule that every screen ships in English and Russian, a new string into
   both en.ts and ru.ts, stopped being true the day a language became a line of the registry and a file per text domain.
   It must not come back in a document a person reads, in a template an agent reads, or in a check. */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TEMPLATES = fileURLToPath(new URL('../../../templates', import.meta.url));

/* The documents that state the rule for a language. */
const DOCS = ['AGENTS.md', 'CONTRIBUTING.md', '.github/pull_request_template.md', 'docs/style-book.md', 'design-map.md', 'docs/assistant-api.md'] as const;

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const TEMPLATE_FILES = readdirSync(TEMPLATES, { recursive: true, encoding: 'utf8' })
  .filter(file => /\.(?:md|ya?ml)$/.test(file))
  .map(file => `templates/${file.replaceAll('\\', '/')}`)
  .sort();

/* The old rule in the words it was written in: the two languages named together, the files of the two, or "both
   languages". A language named alone is fine ("in Russian write "e" for the letter with two dots" is a rule of its own). */
const PAIR: readonly (readonly [name: string, pattern: RegExp])[] = [
  ['English and Russian', /\b(?:English|EN)\s*(?:and|or|\/|&|\+)\s*(?:Russian|RU)\b/i],
  ['Russian and English', /\b(?:Russian|RU)\s*(?:and|or|\/|&|\+)\s*(?:English|EN)\b/i],
  ['the Russian file beside the English one', /\bru\.ts\b/],
  ['both or two languages', /\b(?:both|two)\s+(?:of\s+the\s+)?languages\b/i],
  ['a fixed pair', /\b(?:pair|couple)\s+of\s+(?:languages|locales)\b|\ben\/ru\b/i],
];

export function pairRuleHits(text: string): string[] {
  return text.split('\n').flatMap((line, at) => PAIR.filter(([, pattern]) => pattern.test(line)).map(([name]) => `${at + 1}: ${name}: ${line.trim().slice(0, 100)}`));
}

describe('the rule for the languages of a screen', () => {
  it('has English as the source of the registry, and Russian is one language of it, not the other half of a pair', () => {
    expect(LOCALES[0]!.id).toBe(SOURCE_LOCALE);
    expect(SOURCE_LOCALE).toBe('en');
  });

  it('names no pair of languages in the documents of the repository', () => {
    const hits = DOCS.flatMap(path => pairRuleHits(read(path)).map(hit => `${path}:${hit}`));
    expect(hits).toEqual([]);
  });

  it('names no pair of languages in any skill, role, team, pipeline or text of the templates', () => {
    expect(TEMPLATE_FILES.length).toBeGreaterThan(200);
    const hits = TEMPLATE_FILES.flatMap(path => pairRuleHits(read(path)).map(hit => `${path}:${hit}`));
    expect(hits).toEqual([]);
  });

  it('says in the documents that every other language follows English as the registry lists them', () => {
    for (const path of ['AGENTS.md', 'CONTRIBUTING.md'] as const) {
      const text = read(path);
      expect(text, path).toMatch(/English is the source of every text/);
      expect(text, path).toContain('packages/protocol/src/locales.ts');
      expect(text, path).toMatch(/[Aa]dding a language/);
    }
    expect(read('.github/pull_request_template.md')).toMatch(/every other language of the registry/);
    expect(read('docs/style-book.md')).toMatch(/English is the source of every text/);
  });

  describe('the scan that keeps the pair out', () => {
    const old = [
      'Every screen ships in English and Russian.',
      'A new string goes into both `en.ts` and `ru.ts`.',
      'Every screen ships in every language the product ships (today English and Russian).',
      'screenshots in Russian and English at phone width',
      'New labels and errors go into both `apps/web/src/i18n/en.ts` and `ru.ts`.',
      'Browser acceptance: EN/RU, phone width.',
      'strings in en/ru and reduced motion',
      'Texts exist in both languages.',
      'A text in the two languages of the product.',
      'Built around the pair of languages the product has.',
    ];

    it.each(old)('finds the old rule in %j', line => {
      expect(pairRuleHits(line), line).not.toEqual([]);
    });

    it.each([
      'English is the source of every text; every other language the registry lists follows it.',
      'In Russian write the letter without the two dots.',
      'Writes marketing copy in natural Russian for the Russian-speaking market.',
      'A language is a file named `pt-BR.ts` and a line of the registry.',
      'The registry lists English, Russian and Hindi.',
      'Read the language you want and fall back to `en`.',
      'Use an en dash only where the style book says so.',
    ])('leaves %j alone', line => {
      expect(pairRuleHits(line), line).toEqual([]);
    });

    it('finds a pair put back into a file that was clean, and says which line', () => {
      const clean = read('AGENTS.md');
      expect(pairRuleHits(clean)).toEqual([]);
      const rule = clean.split('\n').findIndex(line => line.startsWith('* English is the source of every text.'));
      expect(rule).toBeGreaterThan(-1);
      const spoiled = clean.split('\n').map((line, at) => (at === rule ? '* Every screen ships in English and Russian.' : line)).join('\n');
      expect(pairRuleHits(spoiled)).toEqual([`${rule + 1}: English and Russian: * Every screen ships in English and Russian.`]);
    });
  });
});

/* The checks of a translation go over the registry, so a language added to it is checked by the line that adds it. */
describe('the registry checks of a translation', () => {
  const info = (script: string): LocaleInfo => ({ id: 'xx', name: 'xx', english: 'xx', script, dir: 'ltr' });

  it('go over every language of the registry after English, and over its words all together', () => {
    expect(TRANSLATIONS.map(language => language.id)).toEqual(LOCALES.map(language => language.id).filter(id => id !== SOURCE_LOCALE));
    expect(inEveryLanguage(Object.fromEntries(LOCALES.map(({ id }) => [id, `text-${id}`])))).toBe(LOCALES.map(({ id }) => `text-${id}`).join('\n'));
  });

  it('tell a text left in English, or in another script, from one written in the script of its language', () => {
    expect(writtenIn('Привет', info('Cyrl'))).toBe(true);
    expect(writtenIn('Hello', info('Cyrl'))).toBe(false);
    expect(writtenIn('नमस्ते', info('Deva'))).toBe(true);
    expect(writtenIn('Привет', info('Deva'))).toBe(false);
    expect(writtenIn('你好', info('Hans'))).toBe(true);
    expect(writtenIn('مرحبا', info('Arab'))).toBe(true);
    expect(writtenIn('Hola', info('Latn'))).toBe(true);
    expect(writtenIn('  ', info('Latn'))).toBe(false);
    expect(writtenIn(undefined, info('Cyrl'))).toBe(false);
  });

  it('know the script of every language of the registry, and refuse one they do not know instead of passing it', () => {
    for (const language of LOCALES) expect(() => writtenIn('x', language), language.id).not.toThrow();
    expect(() => writtenIn('x', info('Zzzz'))).toThrow(/does not know the script Zzzz/);
  });
});
