import { stripEscapes } from '../providers/process.js';
import type { TermProgram } from './programs.js';

/* Dim text is a suggestion, or a marker in Codex's history, rather than input a person typed. */
export function withoutDim(screen: string): string {
  let dim = false;
  const text = screen.split(/(\x1b\[[0-9;]*m)/).map(part => {
    const codes = part.match(/^\x1b\[([0-9;]*)m$/);
    if (!codes) return dim ? part.replace(/[^\n]/g, '') : part;
    dim = dimAfter(codes[1]!, dim);
    return '';
  }).join('');
  return stripEscapes(text);
}

function dimAfter(codes: string, dim: boolean): boolean {
  /* RGB values can contain 0, 2 or 22 without changing the text's weight. */
  const weights = (codes || '0').replace(/(?:38|48|58);(?:2;\d+;\d+;\d+|5;\d+)/g, '').split(';').filter(Boolean).map(Number);
  for (const code of weights) {
    if (code === 0 || code === 22) dim = false;
    if (code === 2) dim = true;
  }
  return dim;
}

/* Kimi Code's input is a box of its own, with `>` on its first row and the rest of a draft on the rows under it. Its welcome
   is a box too, without the `>`. */
function boxedInput(screen: string): string | null {
  const box = [...screen.matchAll(/^[ \t]*╭─[^\n]*\n[ \t]*│[ \t]*>[ \t]?([^\n]*(?:\n[ \t]*│[^\n]*)*)\n[ \t]*╰─[^\n]*$/gm)].at(-1);
  if (!box) return null;
  const rows = box[1]!.split('\n').map((row, i) => (i ? row.replace(/^[ \t]*│/, '') : row).replace(/│?[ \t]*$/, '').trim());
  return rows.join('\n').trim();
}

/* The closing rule belongs to the next box too when history puts two boxes together. */
export function agyPrompt(screen: string): { input: string; footer: string } | null {
  screen = withoutDim(screen);
  const boxes = [...screen.matchAll(/^[ \t]*[─━═]{2,}[ \t]*\n[ \t]*>[ \t]?([\s\S]*?)(?=\n[ \t]*[─━═]{2,}[ \t]*$)/gm)];
  const box = boxes.at(-1);
  if (!box) return null;
  const footer = screen.slice(box.index! + box[0].length).split('\n')[2] ?? '';
  return { input: box[1]!.trim(), footer: footer.trim() };
}

function promptedInput(kind: 'claude' | 'codex', screen: string, shown: string): string | null {
  const marker = kind === 'claude' ? '❯' : '›';
  const prompt = [...screen.matchAll(new RegExp(`^[ \\t]*${marker}[ \\t]?(.*)$`, 'gm'))].at(-1);
  if (!prompt) return null;
  const rest = screen.slice(prompt.index + prompt[0].length);
  if (kind === 'codex') return codexInput(prompt[1]!, rest, shown);
  /* An unfinished box may hide the rest of a person's draft. Wait for its closing rule before typing. */
  const above = screen.slice(0, prompt.index).trimEnd();
  if (/(?:^|\n)[ \t]*[─━═]{2,}[ \t]*$/.test(above)) return framedInput(prompt[1]!, rest);
  return inputRows(prompt[1]!, rest);
}

const inputRows = (first: string, below: string): string => `${first}${below.split(/\n[ \t]*[─━═╰└]/, 1)[0]!}`.replace(/[ \t]+$/gm, '').trim();

/* Codex draws its footer last, under an empty row, in whatever words and style. A person's draft can hold empty rows too, so
   only the last empty row of what the screen shows ends the input. That row and what is under it prove nothing by themselves:
   they may be the rest of a draft whose first rows are empty, on a screen with no footer. Nor does a bare prompt, whose rows may
   not be drawn yet or may not fit. So an input is empty only when Codex says so, with the dim placeholder it shows on its
   prompt's row while nothing is typed. Otherwise nobody can tell, and the words stay out. */
function codexInput(first: string, rest: string, shown: string): string | null {
  const rows = rest.split('\n');
  const seen = shown.split('\n').slice(-rows.length);
  const last = seen.findLastIndex(row => row.trim());
  const empty = seen.slice(0, last + 1).findLastIndex(row => !row.trim());
  const input = inputRows(first, rows.slice(0, empty < 0 ? last + 1 : empty).join('\n'));
  const proven = input || seen[0]!.replace(/^[ \t]*›/, '').trim();
  return proven ? input : null;
}

function framedInput(first: string, rest: string): string | null {
  const end = rest.search(/\n[ \t]*[─━═]{2,}/);
  return end < 0 ? null : `${first}${rest.slice(0, end)}`.trim();
}

/* Only the current input counts; earlier prompts belong to the conversation above it. */
export function inputOf(kind: TermProgram['kind'], screen: string): string | null {
  if (kind === 'kimi') return boxedInput(stripEscapes(screen));
  if (kind === 'antigravity') return agyPrompt(screen)?.input ?? null;
  return promptedInput(kind, withoutDim(screen), stripEscapes(screen));
}

/* The program waits at its prompt with nothing typed. */
export function atEmptyPrompt(kind: TermProgram['kind'], screen: string): boolean {
  return inputOf(kind, screen) === '';
}
