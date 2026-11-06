import type { TestExecution } from '@hornhoof/protocol';

export type SuiteShard = { suiteId: string; index: number; count: number };
export type SelectedPart = { selections: TestExecution['selection'][] };

function suiteIds(part: SelectedPart): string[] {
  if (!part.selections.length) throw new Error('Each part needs nonempty selections.');
  const ids = part.selections.map(selection => {
    if (selection.kind !== 'suite') throw new Error('Shard coordinates require a suite selection.');
    if (!selection.files.length) throw new Error('A suite needs nonempty files.');
    return selection.suiteId;
  });
  if (new Set(ids).size !== ids.length) throw new Error('A part contains duplicate suite selections.');
  return ids;
}

/* Internal plan data only. The runner must bind these coordinates to its pinned part;
   they do not extend TestExecution V1 or authorize execution on a node. */
export function withSuiteShards<T extends SelectedPart>(parts: T[]): (T & { suiteShards: SuiteShard[] })[] {
  if (!parts.length) throw new Error('A shard plan must be nonempty.');
  const ids = parts.map(suiteIds), counts = new Map<string, number>(), ordinals = new Map<string, number>();
  for (const id of ids.flat()) counts.set(id, (counts.get(id) ?? 0) + 1);
  return parts.map((part, index) => ({ ...part, suiteShards: ids[index]!.map(suiteId => {
    const index = (ordinals.get(suiteId) ?? 0) + 1;
    ordinals.set(suiteId, index);
    return { suiteId, index, count: counts.get(suiteId)! };
  }) }));
}
