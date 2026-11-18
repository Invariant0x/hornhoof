import type { PhoneElement, PhoneTypingCheck } from '@hornhoof/protocol';
import { parsePhoneTree } from './capture.js';

const CHUNK = 48;
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
/* end: where the rest of the text starts after this step, in code points of the text as the agent sent it. */
export type TextStep = ({ kind: 'text'; text: string } | { kind: 'enter'; count: number }) & { end: number };

/* Lines in chunks of at most 48 code points that never split a character a person sees as one, such as 👋🏽.
   Each \r\n, \r or \n is one Enter. */
export function phoneTextSteps(text: string): TextStep[] {
  const steps: TextStep[] = [];
  let end = 0;
  for (const part of text.match(/[\r\n]+|[^\r\n]+/g) ?? []) {
    if (/^[\r\n]/.test(part)) {
      const breaks = part.match(/\r\n|\r|\n/g)!;
      for (let at = 0; at < breaks.length; at += CHUNK) {
        const run = breaks.slice(at, at + CHUNK);
        end += run.join('').length;
        steps.push({ kind: 'enter', count: run.length, end });
      }
      continue;
    }
    let chunk: string[] = [];
    const flush = () => {
      end += chunk.length;
      steps.push({ kind: 'text', text: chunk.join(''), end });
      chunk = [];
    };
    for (const { segment } of graphemes.segment(part)) {
      const points = [...segment];
      if (chunk.length && chunk.length + points.length > CHUNK) flush();
      chunk.push(...points);
    }
    flush();
  }
  return steps;
}

/* The field holds \n for every \r\n or \r. origin maps each code point of the normalized text back to the text as sent. */
function normalized(text: string): { points: string[]; origin: number[] } {
  const sent = [...text];
  const points: string[] = [];
  const origin: number[] = [];
  for (let at = 0; at < sent.length; at++) {
    origin.push(at);
    points.push(sent[at] === '\r' ? '\n' : sent[at]!);
    if (sent[at] === '\r' && sent[at + 1] === '\n') at++;
  }
  origin.push(sent.length);
  return { points, origin };
}

function focusedField(tree: string): PhoneElement | undefined {
  try {
    const fields = parsePhoneTree(tree).filter(element => element.focused && element.editable);
    if (fields.length === 1 && !fields[0]!.password && fields[0]!.text.length < 4096) return fields[0];
  } catch { /* The device did not give a readable tree. */ }
  return undefined;
}

function sameField(before: PhoneElement, after: PhoneElement): boolean {
  if (before.package !== after.package || before.class !== after.class || before.resource !== after.resource) return false;
  return Boolean(before.resource) || (before.bounds[0] === after.bounds[0] && before.bounds[1] === after.bounds[1]);
}

function matchingEdge(before: string[], after: string[]): number {
  let count = 0;
  while (count < before.length && before[count] === after[count]) count++;
  return count;
}

function missingText(wanted: string[], observed: string[], origin: number[]): PhoneTypingCheck | undefined {
  let at = 0;
  const missing: { start: number; count: number }[] = [];
  for (const [start, point] of wanted.entries()) {
    if (observed[at] === point) {
      at++;
      continue;
    }
    const previous = missing.at(-1);
    if (previous && previous.start + previous.count === start) previous.count++;
    else missing.push({ start, count: 1 });
  }
  if (at !== observed.length) return { kind: 'typing_mismatch' };
  if (missing.length) return { kind: 'typing_dropped', missing: missing.map(({ start, count }) => ({ start: origin[start]!, count: origin[start + count]! - origin[start]! })) };
  return undefined;
}

/* The tree does not expose a caret or selection. Strip the unchanged edges and compare only the changed text. */
export function checkPhoneText(before: string, after: string, input: string): PhoneTypingCheck | undefined {
  const field = focusedField(before);
  const readback = focusedField(after);
  if (!field || !readback?.text || !sameField(field, readback)) return { kind: 'typing_unverified' };
  const initial = normalized(field.text).points;
  const observed = normalized(readback.text).points;
  const { points: wanted, origin } = normalized(input);
  if (field.text === readback.text) return { kind: 'typing_unverified' };
  if (observed.join('') === wanted.join('')) return undefined;

  const prefix = matchingEdge(initial, observed);
  const suffix = matchingEdge(initial.toReversed(), observed.toReversed());
  // An empty field reports its hint as its text. The hint is gone after typing, so compare with the whole field.
  if (prefix + suffix < initial.length) return missingText(wanted, observed, origin);
  const added = observed.length - initial.length;
  if (added === wanted.length) {
    // Repeated text can leave several possible insertion positions.
    for (let start = initial.length - suffix; start <= prefix; start++) {
      if (wanted.every((point, index) => point === observed[start + index])) return undefined;
    }
  }
  const tail = Math.min(suffix, initial.length - prefix, observed.length - prefix);
  return missingText(wanted, observed.slice(prefix, observed.length - tail), origin);
}
