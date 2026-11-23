/* The languages Hornhoof speaks, in one place, for the browser and the server alike. A language is a line here and files
   named by its id next to each text domain; no code anywhere branches on a language. The registry imports nothing, so a
   page that needs only the list loads only this file.

   id: a BCP 47 tag, as Intl takes it, and the name of the language's files (hi.ts, pt-BR.ts, zh-Hans.ts).
   name: the language in its own words, as the picker shows it.
   english: its name in English, for a sentence that tells a program which language to write in.
   script: the ISO 15924 code of the script it is written in, which picks its fonts.
   dir: the direction it reads in, which the page mirrors.
   format: the tag whose habits dates, times and numbers follow when they differ from the language's own: English is
   written day first with a 24-hour clock here, which no tag of plain "en" does. */
export type Direction = 'ltr' | 'rtl';
export type LocaleInfo = { id: string; name: string; english: string; script: string; dir: Direction; format?: string };

/* English comes first: it is the source every other language is a translation of, and the one a missing text falls back to. */
export const LOCALES = [
  { id: 'en', name: 'English', english: 'English', script: 'Latn', dir: 'ltr', format: 'en-GB' },
  { id: 'ru', name: 'Русский', english: 'Russian', script: 'Cyrl', dir: 'ltr', format: 'ru-RU' },
] as const satisfies readonly LocaleInfo[];

export type LocaleId = (typeof LOCALES)[number]['id'];
export const SOURCE_LOCALE: LocaleId = 'en';
/* The server writes its own words in the source language; a person who reads another gets them from the files instead. */
export const isSourceLocale = (id: string): boolean => id === SOURCE_LOCALE;

/* Languages that exist for tests alone: a text 40% longer than English, and the same text mirrored. They are never
   offered to a person and never count as a shipped language. */
export const PSEUDO_LOCALES = [
  { id: 'en-XL', name: 'English, long', english: 'English, long', script: 'Latn', dir: 'ltr' },
  { id: 'ar-XB', name: 'English, mirrored', english: 'English, mirrored', script: 'Arab', dir: 'rtl' },
] as const satisfies readonly LocaleInfo[];

export type PseudoLocaleId = (typeof PSEUDO_LOCALES)[number]['id'];

const ids = (list: readonly LocaleInfo[]): ReadonlySet<string> => new Set(list.map(info => info.id));
const SHIPPED = ids(LOCALES);
const PSEUDO = ids(PSEUDO_LOCALES);

export const isLocaleId = (value: unknown): value is LocaleId => typeof value === 'string' && SHIPPED.has(value);
export const isPseudoLocaleId = (value: unknown): value is PseudoLocaleId => typeof value === 'string' && PSEUDO.has(value);

/* What the registry says of a language, shipped or pseudo. */
export function localeInfo(id: string, registry: readonly LocaleInfo[] = [...LOCALES, ...PSEUDO_LOCALES]): LocaleInfo | undefined {
  return registry.find(info => info.id === id);
}

/* The tag Intl takes to write a date, a time or a number in a language. */
export const formatTagOf = (id: string, registry?: readonly LocaleInfo[]): string => localeInfo(id, registry)?.format ?? id;

export const directionOf = (id: string, registry?: readonly LocaleInfo[]): Direction => localeInfo(id, registry)?.dir ?? 'ltr';

const canonical = (tag: string): string | undefined => {
  try {
    return Intl.getCanonicalLocales(tag)[0];
  } catch {
    return undefined;
  }
};

/* The language of a tag, and the script it is written in unless the tag says otherwise: zh-CN is Han, simplified. */
function languageAndScript(tag: string): { language: string; script: string | undefined } | undefined {
  const tidy = canonical(tag);
  if (!tidy) return undefined;
  const locale = new Intl.Locale(tidy);
  return { language: locale.language, script: locale.script ?? locale.maximize().script };
}

/* The language of the registry that best answers what a person asked for, the first they asked that it can: the very
   tag, else the same language in the same script, else the same language in another script, else the next they asked.
   English when it speaks none of them. */
export function matchLocale(preferred: readonly string[]): LocaleId;
export function matchLocale(preferred: readonly string[], registry: readonly LocaleInfo[]): string;
export function matchLocale(preferred: readonly string[], registry: readonly LocaleInfo[] = LOCALES): string {
  const known = registry.map(info => ({ info, ...languageAndScript(info.id) }));
  for (const tag of preferred) {
    const tidy = canonical(tag);
    const asked = tidy ? languageAndScript(tidy) : undefined;
    if (!tidy || !asked) continue;
    const same = known.filter(entry => entry.language === asked.language);
    const hit = known.find(entry => entry.info.id.toLowerCase() === tidy.toLowerCase()) ?? same.find(entry => entry.script === asked.script) ?? same[0];
    if (hit) return hit.info.id;
  }
  return SOURCE_LOCALE;
}

/* The languages of an Accept-Language header, by the weights the visitor gave: none they refused, none that stand for any. */
export function parseAcceptLanguage(header: string | undefined): string[] {
  return String(header ?? '')
    .split(',')
    .map((part, order) => {
      const [tag = '', ...params] = part.trim().split(';');
      const weight = params.map(param => /^\s*q\s*=\s*([\d.]+)\s*$/i.exec(param)?.[1]).find(Boolean);
      return { tag: tag.trim(), weight: weight === undefined ? 1 : Number(weight), order };
    })
    .filter(entry => entry.tag !== '' && entry.tag !== '*' && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.order - b.order)
    .map(entry => entry.tag);
}

export function localeOfHeader(header: string | undefined): LocaleId;
export function localeOfHeader(header: string | undefined, registry: readonly LocaleInfo[]): string;
export function localeOfHeader(header: string | undefined, registry: readonly LocaleInfo[] = LOCALES): string {
  return matchLocale(parseAcceptLanguage(header), registry);
}

/* A text in as many languages as it has been written in; English is always there, and is what a missing one reads as. */
export type Texts = { readonly en: string } & { readonly [id: string]: string | undefined };

export const say = (texts: Texts, language: string): string => texts[language] ?? texts[SOURCE_LOCALE];

/* The same for a text that may be missing altogether. */
export const sayIf = (texts: Texts | null | undefined, language: string): string | undefined => (texts ? say(texts, language) : undefined);
