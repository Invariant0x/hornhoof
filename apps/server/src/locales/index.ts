import { LOCALES, SOURCE_LOCALE, type Texts } from '@hornhoof/protocol';
import { en, type ServerWords } from './en.js';

/* The server's own words in every language of the registry: a file named by the language's id next to this one, each
   with every text of en.ts. A language the registry lists whose file is missing speaks English and says so once, so a
   half-added language never takes the server down. */
const brought = new Map<string, ServerWords>([[SOURCE_LOCALE, en]]);
for (const { id } of LOCALES) {
  if (brought.has(id)) continue;
  try {
    brought.set(id, ((await import(`./${id}.js`)) as { default: ServerWords }).default);
  } catch (error) {
    console.warn(`The server has no words in ${id} yet and says them in English.`, error);
  }
}

/* The server's words in a language, English where it has none. */
export const wordsFor = (language: string): ServerWords => brought.get(language) ?? en;

/* The languages the server has files of. */
export const wordLanguages = (): string[] => [...brought.keys()];

/* A line in every language the server speaks, as a notice stores it for each reader to take their own. */
export function saying(make: (words: ServerWords) => string): Texts {
  const lines: Texts = { en: make(en) };
  for (const [id, words] of brought) if (id !== SOURCE_LOCALE) lines[id] = make(words);
  return lines;
}
