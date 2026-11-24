/* The words of a world pack. A pack gives its English words through text(): they read as they are and are the key of the
   same words in every other language, which stand in a file named by the language's id in world/pack-locales/. A text a
   language lacks reads in English. */
const known = new Set<string>();

export function text(english: string): string {
  known.add(english);
  return english;
}

/* Every text the packs loaded so far have given, for a check that each language has them all. */
export const packTextKeys = (): string[] => [...known];

const bank = new Map<string, Record<string, string>>();

/* The words of one more file of a language: the engine's, or a pack's. */
export const addPackTexts = (language: string, texts: Readonly<Record<string, string>>): void => void bank.set(language, { ...bank.get(language), ...texts });

/* A pack's text in a language. */
export const packText = (english: string, language: string): string => bank.get(language)?.[english] ?? english;
