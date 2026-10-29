export type Language = 'en' | 'ru';

export type PluralForms = { one: string; few?: string; many?: string; other: string };

const rules = new Map<Language, Intl.PluralRules>();

/* The word form for a count, by the language's own plural rules. */
export function plural(language: Language, n: number, forms: PluralForms): string {
  let rule = rules.get(language);
  if (!rule) rules.set(language, (rule = new Intl.PluralRules(language)));
  const form = rule.select(n);
  return (form === 'one' || form === 'few' || form === 'many' ? forms[form] : undefined) ?? forms.other;
}
