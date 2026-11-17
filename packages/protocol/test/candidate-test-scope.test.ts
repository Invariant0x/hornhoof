import { describe, expect, it } from 'vitest';
import { MutationSelection, mutationResultMatches, mutationSelectionMatches } from '../src/test-environment.js';

const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40);

function selection() {
  return MutationSelection.parse({ version: 1, status: 'ready', baseCommit: BASE, commit: HEAD, problems: [], excluded: [], selected: [
    { file: 'src/pure.ts', name: 'price', startLine: 1, endLine: 1, lines: [1], tests: ['spec/a.ts'], reason: 'changed_pure_function' },
  ] });
}

describe('one actual passing mutation result for every assigned source', () => {
  it('accepts an exact passing source result without modifying either selection', () => {
    const expected = selection(), actual = structuredClone(expected), before = structuredClone(expected);
    expect(mutationResultMatches(expected, { selection: actual, files: [{ file: 'src/pure.ts', status: 'passed' }] }, ['src/pure.ts'])).toBe(true);
    expect(expected).toEqual(before);
    expect(actual).toEqual(before);
  });

  it.each(['missing', 'duplicate', 'failed', 'foreign'] as const)('refuses a %s source outcome', problem => {
    const expected = selection(), files: { file: string; status: 'passed' | 'failed' }[] = [{ file: 'src/pure.ts', status: 'passed' }];
    if (problem === 'missing') files.length = 0;
    if (problem === 'duplicate') files.push(files[0]!);
    if (problem === 'failed') files[0]!.status = 'failed';
    if (problem === 'foreign') files[0]!.file = 'src/other.ts';
    expect(mutationResultMatches(expected, { selection: expected, files }, ['src/pure.ts'])).toBe(false);
  });

  it.each(['base', 'head', 'blocked', 'function', 'excluded'] as const)('refuses a different %s selection', problem => {
    const expected = selection(), actual = structuredClone(expected);
    if (problem === 'base') actual.baseCommit = HEAD;
    if (problem === 'head') actual.commit = BASE;
    if (problem === 'blocked') actual.status = 'blocked';
    if (problem === 'function') actual.selected[0]!.name = 'anotherFunction';
    if (problem === 'excluded') actual.excluded.push({ file: 'src/pure.ts', reason: 'purity_unproven' });
    expect(mutationSelectionMatches(expected, actual, ['src/pure.ts'])).toBe(false);
  });
});
