/* What a release brings that no check covers, one item each, as Hornhoof finds it. The server alone writes it on the approval
   card of the release, apart from the words of whoever asked, and people see it next to Approve in their own language: a
   release that brings any takes only the approval of a card that named exactly what it brings unchecked now. */
export type UncheckedItem =
  /* The commits between main at base and the release commit could not all be read. */
  | { kind: 'unread'; base: string; commit: string }
  /* The holder of turnkey work, whose own checks cover it, is off or removed. */
  | { kind: 'holder_off'; task: number }
  /* Work that is neither a checked candidate nor turnkey work its holder closed. */
  | { kind: 'no_candidate'; task: number }
  /* A checker of the candidate's commit is off, removed or its author, or passed no verdict on it. */
  | { kind: 'checker'; task: number; commit: string }
  /* The commits of a candidate could not all be read. */
  | { kind: 'task_unread'; task: number }
  /* Turnkey work closed before its report named the commit its holder checked and where its branch started. */
  | { kind: 'unpinned'; task: number }
  /* A merge, or a commit, of the release that no checked result brought. */
  | { kind: 'merge'; commit: string }
  | { kind: 'commit'; commit: string };

/* The item as agents and the release record read it. */
export function uncheckedLine(item: UncheckedItem): string {
  switch (item.kind) {
    case 'unread': return `The commits between main ${item.base} and ${item.commit} could not all be read.`;
    case 'holder_off': return `#${item.task}: the holder of this turnkey work, whose own checks cover it, is off or removed.`;
    case 'no_candidate': return `#${item.task} has no checked candidate and is no turnkey work its holder closed.`;
    case 'checker': return `#${item.task}: a checker of ${item.commit} is off, removed or its author, or passed no verdict on it.`;
    case 'task_unread': return `The commits of #${item.task} could not all be read.`;
    case 'unpinned': return `#${item.task} was closed before turnkey work named the commit its holder checked and where it started, so none of its commits counts as checked.`;
    case 'merge': return `${item.commit} is a merge made outside every checked candidate.`;
    case 'commit': return `${item.commit} came in with no accepted candidate.`;
  }
}

/* The items in one order, the same each time for the same list, as the card keeps them. */
export function sortedUnchecked(items: UncheckedItem[]): UncheckedItem[] {
  const lined = items.map(item => ({ item, line: uncheckedLine(item) }));
  return lined.sort((a, b) => (a.line < b.line ? -1 : a.line > b.line ? 1 : 0)).map(({ item }) => item);
}

/* The lines of the items, the same each time for the same list. */
export const uncheckedLines = (items: UncheckedItem[]): string[] => sortedUnchecked(items).map(uncheckedLine);

/* The lines of what a card keeps, none where it keeps no list. */
export const keptLines = (kept: UncheckedItem[] | null): string[] | null => (kept ? uncheckedLines(kept) : null);

/* A card names exactly what a release brings unchecked, by its lines: the same items, whatever order either was kept in. */
export const namesExactly = (kept: UncheckedItem[] | null, lines: string[]): boolean =>
  !!kept?.length && uncheckedLines(kept).join('\n') === [...lines].sort().join('\n');
