import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiFailure } from '../api';
import { en, type Messages } from './en';
import type { Language } from './plural';
import { ru } from './ru';

export { plural, type Language, type PluralForms } from './plural';
export type { Messages } from './en';

export const LANGUAGES: { id: Language; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'ru', name: 'Русский' },
];

const DICTIONARIES: Record<Language, Messages> = { en, ru };
const KEY = 'hh-lang';

const isLanguage = (v: string | null | undefined): v is Language => v === 'en' || v === 'ru';

/* The saved choice wins; otherwise the first browser language we speak, otherwise English. */
export function detectLanguage(saved: string | null, preferred: readonly string[]): Language {
  if (isLanguage(saved)) return saved;
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0];
    if (isLanguage(base)) return base;
  }
  return 'en';
}

function savedLanguage(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

type LanguageState = { language: Language; setLanguage: (l: Language) => void; t: Messages };

/* English without a provider, so a component renders on its own in tests. */
const LanguageContext = createContext<LanguageState>({ language: 'en', setLanguage: () => {}, t: en });

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setState] = useState<Language>(() => detectLanguage(savedLanguage(), navigator.languages ?? [navigator.language]));

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback((next: Language) => {
    setState(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* Not saved, but applied for this visit. */
    }
  }, []);

  const value = useMemo(() => ({ language, setLanguage, t: DICTIONARIES[language] }), [language, setLanguage]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export const useT = (): Messages => useContext(LanguageContext).t;

export function useLanguage(): { language: Language; setLanguage: (l: Language) => void } {
  const { language, setLanguage } = useContext(LanguageContext);
  return { language, setLanguage };
}

/* A known reason reads in the chosen language. Otherwise English shows the server's own words when it gave any, and the
   rest say what kind of error it was. */
export function errorText(t: Messages, err: unknown): string {
  if (!(err instanceof ApiFailure)) return t.errors.codes.internal;
  const reasons: Record<string, unknown> = t.errors;
  if (err.reason && err.reason !== 'codes' && typeof reasons[err.reason] === 'string') return reasons[err.reason] as string;
  if (t === en && err.message) return err.message;
  const codes: Record<string, string> = t.errors.codes;
  return codes[err.code] ?? t.errors.codes.internal;
}

/* A typed name as typed; a template department without one by its template's name in the person's language. */
export function deptLabel(t: Messages, d: { name: string | null; templateKey: keyof Messages['templates'] | null }): string {
  return d.name ?? (d.templateKey ? t.templates[d.templateKey].name : '');
}
