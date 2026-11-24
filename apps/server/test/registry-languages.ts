import { LOCALES, SOURCE_LOCALE, type LocaleInfo } from '@hornhoof/protocol';

/* The languages a check goes over: the ones the registry lists (the section "Adding a language" of the contributor
   guide), English the source of them all. A check that names two languages stays true only while there are two; one
   that asks the registry is checked for a new language by the line that adds it. No module-level test hooks: a server
   outside vitest may import it. */

/* Every language of the registry after the source, which a translation is checked against. */
export const TRANSLATIONS: readonly LocaleInfo[] = LOCALES.filter(locale => locale.id !== SOURCE_LOCALE);

/* The letters of each script a language of the registry is written in, by its ISO 15924 code. */
const LETTERS: Readonly<Record<string, RegExp>> = {
  Arab: /\p{Script=Arabic}/u,
  Beng: /\p{Script=Bengali}/u,
  Cyrl: /\p{Script=Cyrillic}/u,
  Deva: /\p{Script=Devanagari}/u,
  Grek: /\p{Script=Greek}/u,
  Hans: /\p{Script=Han}/u,
  Hant: /\p{Script=Han}/u,
  Hebr: /\p{Script=Hebrew}/u,
  Jpan: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  Kore: /\p{Script=Hangul}/u,
  Thai: /\p{Script=Thai}/u,
};

/* Whether a text of a language has a letter of its script, so a text left in English in a file of Russian or Hindi shows.
   A Latin script cannot be told from English, so it passes: its words are read by the screens' own tests. */
export function writtenIn(text: string | undefined, language: LocaleInfo): boolean {
  if (language.script === 'Latn') return typeof text === 'string' && text.trim() !== '';
  const letters = LETTERS[language.script];
  if (!letters) throw new Error(`registry-languages.ts does not know the script ${language.script} of ${language.id}: add its letters to LETTERS.`);
  return typeof text === 'string' && letters.test(text);
}

/* The text of each given piece in every language of the registry, as one string, for a rule every language must keep. */
export const inEveryLanguage = (...pieces: readonly Readonly<Record<string, string | undefined>>[]): string =>
  pieces.flatMap(piece => LOCALES.map(({ id }) => piece[id] ?? '')).join('\n');
