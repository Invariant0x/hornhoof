import type { LocaleId, PseudoLocaleId } from '@hornhoof/protocol';

/* A language the product ships, as the registry lists it. */
export type ShippedLanguage = LocaleId;
/* The language a page holds: a shipped one or, in a build for tests, one of the languages made for tests. */
export type Language = ShippedLanguage | PseudoLocaleId;

/* A phrase's forms by the categories of Intl.PluralRules: a language has the ones it needs (English one and other,
   Russian one, few, many and other, Arabic all six), and the words give those; other is read where a form is not given. */
export type PluralForms = { other: string; zero?: string; one?: string; two?: string; few?: string; many?: string };

const rules = new Map<Language, Intl.PluralRules>();

/* The word form for a count, by the language's own plural rules. */
export function plural(language: Language, n: number, forms: PluralForms): string {
  let rule = rules.get(language);
  if (!rule) rules.set(language, (rule = new Intl.PluralRules(language)));
  return forms[rule.select(n)] ?? forms.other;
}
