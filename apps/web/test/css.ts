/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/* The stylesheet as rules, for what jsdom cannot lay out: which declarations a selector gets, outside any @media or @container, or
   inside one. A rule's selectors are split at the commas between them, not those inside :has() or :is(). Vitest hands
   CSS to tests empty, so the file is read as it is, from the app's folder the tests run in. */
const css = readFileSync(resolve(process.cwd(), 'src/theme.css'), 'utf8');

export type Rule = { media: string | null; selectors: string[]; decls: Record<string, string> };

function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  throw new Error('theme.css: a brace is not closed');
}

/* Splits at the separators that are not inside parentheses. */
function split(text: string, at: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (text[i] === at && depth === 0) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts.map(p => p.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

export function parse(text: string, media: string | null): Rule[] {
  const rules: Rule[] = [];
  let at = 0;
  for (let open = text.indexOf('{', at); open >= 0; open = text.indexOf('{', at)) {
    const prelude = text.slice(at, open).split(';').pop()!.trim();
    const close = closing(text, open);
    const body = text.slice(open + 1, close);
    if (/^@(media|container)\b/.test(prelude)) rules.push(...parse(body, prelude.replace(/^@(media|container)\s*/, '')));
    else if (!prelude.startsWith('@'))
      rules.push({
        media,
        selectors: split(prelude, ','),
        decls: Object.fromEntries(split(body, ';').map(d => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()])),
      });
    at = close + 1;
  }
  return rules;
}

export const RULES = parse(css.replace(/\/\*[\s\S]*?\*\//g, ''), null);

/* Every rule that names this selector, in the stylesheet's order. */
export const rulesFor = (selector: string) => RULES.filter(r => r.selectors.includes(selector));

/* What the selector gets for a property at one @media or @container, or outside any: the last rule wins, as in the cascade. */
export function decl(selector: string, property: string, media: string | null = null): string | undefined {
  return rulesFor(selector)
    .filter(r => r.media === media && property in r.decls)
    .map(r => r.decls[property])
    .pop();
}

export const px = (value: string | undefined) => {
  const m = /^(-?[\d.]+)px$/.exec(value ?? '');
  if (!m) throw new Error(`not a length in px: ${value}`);
  return Number(m[1]);
};
