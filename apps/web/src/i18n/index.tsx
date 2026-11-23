import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isLocaleId, isPseudoLocaleId, LOCALES, localeInfo, matchLocale, SOURCE_LOCALE, type Direction } from '@hornhoof/protocol';
import { ApiFailure } from '../api';
import { en, type Messages } from './en';
import type { Language, ShippedLanguage } from './plural';

export { plural, type Language, type ShippedLanguage, type PluralForms } from './plural';
export type { Messages } from './en';

/* Every language the product ships, each named in its own words, as the registry of the protocol lists them. A language
   is a line there and a file here named by its id: nothing in the code names one. */
export const LANGUAGES: { id: ShippedLanguage; name: string }[] = LOCALES.map(({ id, name }) => ({ id, name }));
const KEY = 'hh-lang';

/* The saved choice wins; otherwise the first browser language we speak, otherwise English. A test language, which only a
   build for tests allows, is taken from the saved choice alone. */
export function detectLanguage(saved: string | null, preferred: readonly string[], pseudo = false): Language {
  if (isLocaleId(saved) || (pseudo && isPseudoLocaleId(saved))) return saved;
  return matchLocale(preferred);
}

function savedLanguage(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/* The dictionaries brought so far. English is the source of every other, in the first load, and the one a text a language
   lacks reads as. */
const brought = new Map<Language, Messages>([['en', en]]);
const lacking = new Map<Language, { missing: string[]; extra: string[] }>();
const arriving = new Map<Language, Promise<Messages>>();

export const cachedMessages = (id: Language): Messages | undefined => brought.get(id);

/* The texts a language lacks, which read as English, and the ones it holds that English does not. */
export const missingKeysOf = (id: Language): { missing: string[]; extra: string[] } => lacking.get(id) ?? { missing: [], extra: [] };

/* A language's own files, brought when it is first asked for, so the page loads the one it speaks and no other. Where they
   do not come the page reads in English, and asks again the next time. */
export function loadMessages(id: Language): Promise<Messages> {
  const known = brought.get(id);
  if (known) return Promise.resolve(known);
  let coming = arriving.get(id);
  if (!coming) {
    coming = import('./load')
      .then(({ loadLocale }) => loadLocale(id, en))
      .then(loaded => {
        brought.set(id, loaded.messages);
        lacking.set(id, { missing: loaded.missing, extra: loaded.extra });
        return loaded.messages;
      })
      .catch((error: unknown) => {
        console.warn(`The ${id} language did not load; the page reads in English.`, error);
        return en;
      })
      .finally(() => arriving.delete(id));
    arriving.set(id, coming);
  }
  return coming;
}

/* Every registered language at once, for a test that reads several. */
export const preloadLanguages = (): Promise<Messages[]> => Promise.all(LANGUAGES.map(({ id }) => loadMessages(id)));

type LanguageState = { language: Language; setLanguage: (l: Language) => void; t: Messages; dir: Direction };

/* English without a provider, so a component renders on its own in tests. */
const LanguageContext = createContext<LanguageState>({ language: 'en', setLanguage: () => {}, t: en, dir: 'ltr' });

type Shown = { wanted: Language; language: Language; t: Messages };

/* The page in a person's language: the one they chose, else the one their browser asks for, else English. The page waits
   for the language's files rather than show another language first; it names the language and its direction on its root. */
export function LanguageProvider({ children, pseudo = false }: { children: ReactNode; pseudo?: boolean }) {
  const [wanted, setWanted] = useState<Language>(() => detectLanguage(savedLanguage(), navigator.languages ?? [navigator.language], pseudo));
  const [shown, setShown] = useState<Shown | null>(() => {
    const t = brought.get(wanted);
    return t ? { wanted, language: wanted, t } : null;
  });

  useEffect(() => {
    if (shown?.wanted === wanted) return;
    let current = true;
    void loadMessages(wanted).then(t => {
      if (current) setShown({ wanted, language: t === en ? SOURCE_LOCALE : wanted, t });
    });
    return () => {
      current = false;
    };
  }, [wanted, shown?.wanted]);

  const language = shown?.language ?? wanted;
  const dir = localeInfo(language)?.dir ?? 'ltr';
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = dir;
  }, [language, dir]);

  const setLanguage = useCallback((next: Language) => {
    setWanted(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* Not saved, but applied for this visit. */
    }
  }, []);

  const value = useMemo(() => (shown ? { language: shown.language, setLanguage, t: shown.t, dir } : null), [shown, setLanguage, dir]);
  return value ? <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider> : null;
}

export const useT = (): Messages => useContext(LanguageContext).t;

/* The first of the characters no words hold, each marking the place of one value in a phrase. */
const SLOT = 0xe000;

/* A phrase of the dictionary with elements in its places: its words, as a language writes them, decide where each value
   stands. The caller isolates a value that must read its own way, and the phrase whole in its own direction. */
export function Phrase({ words, values }: { words: (...values: string[]) => string; values: readonly ReactNode[] }) {
  const text = words(...values.map((_, i) => String.fromCharCode(SLOT + i)));
  return <>{text.split(/([\ue000-\uf8ff])/).map((part, i) => (i % 2 ? <Fragment key={i}>{values[part.charCodeAt(0) - SLOT]}</Fragment> : part))}</>;
}

export function useLanguage(): { language: Language; setLanguage: (l: Language) => void; dir: Direction } {
  const { language, setLanguage, dir } = useContext(LanguageContext);
  return { language, setLanguage, dir };
}

/* A known reason reads in the chosen language; one whose words name a machine takes its name from what the server gave
   with the reason. Otherwise English shows the server's own words when it gave any, and the rest say what kind of
   error it was. */
export function errorText(t: Messages, err: unknown): string {
  if (!(err instanceof ApiFailure)) return t.errors.codes.internal;
  const reasons: Record<string, unknown> = t.errors;
  const known = err.reason && err.reason !== 'codes' ? reasons[err.reason] : undefined;
  if (typeof known === 'string') return known;
  const host = err.details?.host;
  if (typeof known === 'function' && typeof host === 'string' && host) return (known as (host: string) => string)(host);
  if (t === en && err.message) return err.message;
  const codes: Record<string, string> = t.errors.codes;
  return codes[err.code] ?? t.errors.codes.internal;
}

/* How a restore ended. The server writes its own line in English, so that is shown in English alone, as with a failure
   it names no reason for; any other language says what the last step tells. */
export function restoreEnded(t: Messages, status: { state: 'running' | 'done' | 'failed'; step: keyof Messages['backups']['steps']; line: string }): string {
  if (t === en && status.line) return status.line;
  return status.state === 'done' ? t.backups.done : t.backups.failedAt(t.backups.steps[status.step]);
}

/* A typed name as typed; a template department without one by its template's name in the person's language. */
export function deptLabel(t: Messages, d: { name: string | null; templateKey: keyof Messages['templates'] | null }): string {
  return d.name ?? (d.templateKey ? t.templates[d.templateKey].name : '');
}
