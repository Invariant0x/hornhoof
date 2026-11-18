import type { PhoneElement, PhoneTypingIssue } from '@hornhoof/protocol';
import { parsePhoneTree } from './capture.js';

const CHUNK = 48;
type TextStep = { kind: 'text'; text: string } | { kind: 'enter'; count: number };

const normalize = (text: string): string => text.replace(/\r\n?/g, '\n');

export function phoneTextSteps(text: string): TextStep[] {
  const steps: TextStep[] = [];
  for (const part of normalize(text).match(/\n+|[^\n]+/g) ?? []) {
    const points = [...part];
    for (let at = 0; at < points.length; at += CHUNK) {
      const chunk = points.slice(at, at + CHUNK);
      steps.push(part.startsWith('\n') ? { kind: 'enter', count: chunk.length } : { kind: 'text', text: chunk.join('') });
    }
  }
  return steps;
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

function missingText(wanted: string[], observed: string[]): PhoneTypingIssue | undefined {
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
  if (missing.length) return { kind: 'typing_dropped', missing };
  return undefined;
}

/* The tree does not expose a caret or selection. Strip the unchanged edges and compare only the changed text. */
export function checkPhoneText(before: string, after: string, input: string): PhoneTypingIssue | undefined {
  const field = focusedField(before);
  const readback = focusedField(after);
  if (!field || !readback?.text || !sameField(field, readback)) return { kind: 'typing_unverified' };
  const initial = [...normalize(field.text)];
  const observed = [...normalize(readback.text)];
  const wanted = [...normalize(input)];
  if (field.text === readback.text) return { kind: 'typing_unverified' };
  if (observed.join('') === wanted.join('')) return undefined;

  const prefix = matchingEdge(initial, observed);
  const suffix = matchingEdge(initial.toReversed(), observed.toReversed());
  // An empty field reports its hint as its text. The hint is gone after typing, so compare with the whole field.
  if (prefix + suffix < initial.length) return missingText(wanted, observed);
  const added = observed.length - initial.length;
  if (added === wanted.length) {
    // Repeated text can leave several possible insertion positions.
    for (let start = initial.length - suffix; start <= prefix; start++) {
      if (wanted.every((point, index) => point === observed[start + index])) return undefined;
    }
  }
  const tail = Math.min(suffix, initial.length - prefix, observed.length - prefix);
  return missingText(wanted, observed.slice(prefix, observed.length - tail));
}
