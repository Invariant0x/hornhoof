import { addPackTexts } from '../world/pack-text';

/* The words of the world engine and of every pack, a file per language: the engine's in world/pack-locales/ and each
   pack's in world-packs/<pack>/locales/, named by the language's id. A language is brought when it is, as one chunk. */
const files = import.meta.glob<{ default: Record<string, string> }>(['../world/pack-locales/??.ts', '../world/pack-locales/??-*.ts', './*/locales/??.ts', './*/locales/??-*.ts']);
const every = import.meta.glob<{ default: Record<string, string> }>(['../world/pack-locales/??.ts', '../world/pack-locales/??-*.ts', './*/locales/??.ts', './*/locales/??-*.ts'], { eager: true });

const languageOf = (path: string): string => path.replace(/^.*\/(.+)\.ts$/, '$1');

export async function loadPackTexts(language: string): Promise<void> {
  const own = Object.entries(files).filter(([path]) => languageOf(path) === language);
  for (const [, load] of own) addPackTexts(language, (await load()).default);
}

/* Every language at once, for the pages that show a pack's words in a language of their own choosing. */
export function loadEveryPackTexts(): void {
  for (const [path, module] of Object.entries(every)) addPackTexts(languageOf(path), module.default);
}
