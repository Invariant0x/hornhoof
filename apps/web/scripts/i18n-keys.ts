import { writeFileSync } from 'node:fs';
import { CONTEXT, SAMPLES } from '../src/i18n/context';
import { en } from '../src/i18n/en';

/* The key list to hand to a translator: every text of the product's screens by its path in the order of en.ts, with what it
   is, the English as it reads (a phrase that takes values shows them as {1}, {2}, ... in the order it is given them), a
   note where the meaning is ambiguous, and with --language <id> the words that language has now, empty where it has none.

     npx tsx apps/web/scripts/i18n-keys.ts [--language ru] [--out keys.json]

   The paths and their order stay as they are in en.ts, so a list handed out stays valid until a text is added or removed. */
export type Entry = { key: string; kind: 'text' | 'phrase'; english: string; context?: string; translation?: string };

/* A list of texts is a group too: its paths end in the position of each. */
const isGroup = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const holes = (arity: number): string[] => Array.from({ length: arity }, (_, at) => `{${at + 1}}`);

/* A phrase is read with its values stood for by holes, so its words show where each one goes. */
const read = (value: unknown, key: string): { kind: Entry['kind']; text: string } | null => {
  if (typeof value === 'string') return { kind: 'text', text: value };
  if (typeof value === 'function') {
    const make = value as (...values: string[]) => unknown;
    try {
      const text = (make as (...values: unknown[]) => unknown)(...(SAMPLES[key] ?? holes(Math.max(make.length, 1))));
      return typeof text === 'string' ? { kind: 'phrase', text } : null;
    } catch {
      return null;
    }
  }
  return null;
};

function walk(value: unknown, own: unknown, path: string[], out: Entry[], withTranslation: boolean): void {
  if (isGroup(value)) {
    for (const [key, inner] of Object.entries(value)) walk(inner, isGroup(own) ? own[key] : undefined, [...path, key], out, withTranslation);
    return;
  }
  const key = path.join('.');
  const english = read(value, key);
  if (!english) return;
  const entry: Entry = { key, kind: english.kind, english: english.text };
  if (CONTEXT[key]) entry.context = CONTEXT[key];
  if (withTranslation) entry.translation = read(own, key)?.text ?? '';
  out.push(entry);
}

export function keyList(own?: unknown): Entry[] {
  const out: Entry[] = [];
  walk(en, own, [], out, own !== undefined);
  return out;
}

const arg = (name: string): string | undefined => process.argv[process.argv.indexOf(name) + 1];

if (process.argv[1]?.endsWith('i18n-keys.ts')) {
  const language = process.argv.includes('--language') ? arg('--language') : undefined;
  const own = language ? ((await import(`../src/i18n/${language}.ts`)) as { default: unknown }).default : undefined;
  const text = `${JSON.stringify(keyList(own), null, 2)}\n`;
  if (process.argv.includes('--out')) writeFileSync(arg('--out')!, text);
  else process.stdout.write(text);
}
