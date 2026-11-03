import { stripEscapes } from '../providers/process.js';
import type { TermProgram } from './programs.js';

/* Dim text is a suggestion, or a marker in Codex's history, rather than input a person typed. */
function withoutDim(screen: string): string {
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

function boxedInput(screen: string): string | null {
  const rule = [...screen.matchAll(/^[ \t]*[─━═]{2,}[ \t]+input\b[^\n]*$/gm)].at(-1);
  if (!rule) return null;
  const below = screen.slice(rule.index + rule[0].length);
  const end = below.search(/^[ \t]*[─━═]{2,}[ \t]*$/m);
  return end < 0 ? null : below.slice(0, end).trim();
}

function promptedInput(kind: 'claude' | 'codex', screen: string): string | null {
  const marker = kind === 'claude' ? '❯' : '›';
  const prompt = [...screen.matchAll(new RegExp(`^[ \\t]*${marker}[ \\t]?(.*)$`, 'gm'))].at(-1);
  if (!prompt) return null;
  const below = screen.slice(prompt.index + prompt[0].length).split(/\n[ \t]*(?:\n|[─━═╰└])/, 1)[0]!;
  return `${prompt[1]}${below}`.trim();
}

/* Only the current input counts; earlier prompts belong to the conversation above it. */
export function inputOf(kind: TermProgram['kind'], screen: string): string | null {
  if (kind === 'kimi') return boxedInput(stripEscapes(screen));
  if (kind === 'antigravity') return null;
  return promptedInput(kind, withoutDim(screen));
}
