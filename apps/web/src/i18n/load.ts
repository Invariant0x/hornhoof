import { isPseudoLocaleId } from '@hornhoof/protocol';
import type { Messages } from './en';
import { extraPaths, withFallback } from './fallback';
import type { Language } from './plural';
import { pseudoMessages } from './pseudo';

/* A language's files: one named by its id next to this one (ru.ts, hi.ts, pt-BR.ts), taken by name, so a new language
   is a new file and a line in the registry of the protocol. The page brings them one language at a time. */
const files = import.meta.glob<{ default: unknown }>(['./??.ts', './??-*.ts']);

/* The fonts of a script, brought only when a language written in it is on: Latin and Cyrillic are the product's own fonts
   and have no file; every other script has one in fonts/scripts/ named by its ISO 15924 code. */
const scriptFiles = import.meta.glob<unknown>('../fonts/scripts/*.css');

export async function loadScriptFonts(script: string): Promise<void> {
  await scriptFiles[`../fonts/scripts/${script}.css`]?.();
}

export type Loaded = { messages: Messages; missing: string[]; extra: string[] };

/* A language laid over English, with what it lacks told, so a text not translated yet shows in English and the one who
   builds the page sees which it is. */
export async function loadLocale(id: Language, base: Messages): Promise<Loaded> {
  if (isPseudoLocaleId(id)) return { messages: pseudoMessages(id, base), missing: [], extra: [] };
  const file = files[`./${id}.ts`];
  if (!file) throw new Error(`There is no file for the language ${id}.`);
  const own = (await file()).default;
  const missing: string[] = [];
  const messages = withFallback(base, own, path => missing.push(path));
  const extra = extraPaths(base, own);
  if (import.meta.env.DEV && (missing.length || extra.length)) {
    console.warn(`The ${id} language lacks ${missing.length} texts, read in English${missing.length ? `: ${missing.slice(0, 20).join(', ')}` : ''}; it holds ${extra.length} English has not.`);
  }
  return { messages, missing, extra };
}
