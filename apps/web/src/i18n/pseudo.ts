import { localeInfo, type PseudoLocaleId } from '@hornhoof/protocol';
import type { Messages } from './en';

/* The languages that exist for tests (the registry of the protocol names them) made from English: a stretched text, for
   a layout that must hold any length, and a mirrored one, for a layout that must turn. Each text is marked, so one that
   reaches the screen without passing through the files shows plain. */
const VOWELS = /[aeiouy]/gi;
const GROWTH = 1.4;

/* Each word grows by doubling its vowels; a short word with few of them takes filler words after, until the text is 40% longer. */
function stretched(text: string): string {
  const target = Math.ceil(text.length * GROWTH);
  let out = text.replace(/[A-Za-z]{3,}/g, word => word.replace(VOWELS, vowel => vowel + vowel));
  while (out.length + 2 < target) out += ' ~ aaa';
  return `⟦${out}⟧`;
}

const mirrored = (text: string): string => `‫${text}‬`;

function transform(value: unknown, change: (text: string) => string): unknown {
  if (typeof value === 'string') return change(value);
  if (typeof value === 'function') {
    return (...args: unknown[]) => {
      const said = (value as (...a: unknown[]) => unknown)(...args);
      return typeof said === 'string' ? change(said) : said;
    };
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, transform(inner, change)]));
  return value;
}

export function pseudoMessages(id: PseudoLocaleId, base: Messages): Messages {
  return transform(base, localeInfo(id)?.dir === 'rtl' ? mirrored : stretched) as Messages;
}
