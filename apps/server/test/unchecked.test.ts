import { describe, expect, it } from 'vitest';
import { keptLines, namesExactly, sortedUnchecked, uncheckedLine, uncheckedLines, type UncheckedItem } from '../src/modules/tasks/unchecked.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);

describe('what a release brings that no check covers', () => {
  it.each([
    [{ kind: 'unread', base: A, commit: B }, `The commits between main ${A} and ${B} could not all be read.`],
    [{ kind: 'holder_off', task: 7 }, '#7: the holder of this turnkey work, whose own checks cover it, is off or removed.'],
    [{ kind: 'no_candidate', task: 7 }, '#7 has no checked candidate and is no turnkey work its holder closed.'],
    [{ kind: 'checker', task: 7, commit: C }, `#7: a checker of ${C} is off, removed or its author, or passed no verdict on it.`],
    [{ kind: 'task_unread', task: 7 }, 'The commits of #7 could not all be read.'],
    [{ kind: 'unpinned', task: 7 }, '#7 was closed before turnkey work named the commit its holder checked and where it started, so none of its commits counts as checked.'],
    [{ kind: 'merge', commit: A }, `${A} is a merge made outside every checked candidate.`],
    [{ kind: 'commit', commit: A }, `${A} came in with no accepted candidate.`],
  ] as [UncheckedItem, string][])('says %o to agents and on the release record as it said before', (item, line) => {
    expect(uncheckedLine(item)).toBe(line);
  });

  it('keeps the same list in one order whatever order it was found in', () => {
    const items: UncheckedItem[] = [{ kind: 'merge', commit: C }, { kind: 'commit', commit: B }, { kind: 'task_unread', task: 3 }];
    expect(sortedUnchecked(items)).toEqual(sortedUnchecked([...items].reverse()));
    expect(uncheckedLines(items)).toEqual([...items.map(uncheckedLine)].sort());
  });

  it('takes a card as naming exactly what a release brings only for the same items, none missing or added', () => {
    const items: UncheckedItem[] = [{ kind: 'commit', commit: B }, { kind: 'holder_off', task: 3 }];
    const lines = uncheckedLines(items);
    expect(namesExactly([...items].reverse(), lines)).toBe(true);
    expect(namesExactly(items.slice(1), lines)).toBe(false);
    expect(namesExactly([...items, { kind: 'commit', commit: C }], lines)).toBe(false);
    expect(namesExactly(null, lines)).toBe(false);
    expect(namesExactly([], [])).toBe(false);
  });

  it('gives the lines of what a card keeps, and none for a card that keeps no list', () => {
    const items: UncheckedItem[] = [{ kind: 'merge', commit: C }, { kind: 'commit', commit: B }];
    expect(keptLines(items)).toEqual(uncheckedLines(items));
    expect(keptLines(null)).toBeNull();
  });
});
