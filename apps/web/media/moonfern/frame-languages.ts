import { LANGUAGES, type Language, type Messages } from '../../src/i18n';

export const FRAME_SIZES = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];
export const FRAME_THEMES = ['cyberpunk', 'light'] as const;

const RTL = new Set(['ar', 'dv', 'fa', 'he', 'ku', 'ps', 'sd', 'ug', 'ur', 'yi']);

/* Rank only shipped languages, by the translated words actually displayed in the scene. */
export async function frameLanguages(words: (t: Messages) => string[]): Promise<{ id: Language; t: Messages }[]> {
  const ranked = await Promise.all(LANGUAGES.map(async ({ id }) => {
    const dictionary = await import(`../../src/i18n/${id}.ts`) as Record<Language, Messages>;
    const t = dictionary[id];
    return { id, t, length: words(t).join('').length };
  }));
  ranked.sort((a, b) => a.length - b.length);
  const picked = [ranked[0]!, ranked.at(-1)!, ranked.find(({ id }) => RTL.has(id.split('-')[0]!))];
  return [...new Map(picked.flatMap(item => item ? [[item.id, item] as const] : [])).values()];
}
