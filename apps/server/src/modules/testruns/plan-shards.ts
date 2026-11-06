import type { TestExecution } from '@hornhoof/protocol';

export type SuiteShard = { suiteId: string; index: number; count: number };
export type SelectedPart = { selections: TestExecution['selection'][] };

/* Internal plan data only. The runner must bind these coordinates to its pinned part;
   they do not extend TestExecution V1 or authorize execution on a node. */
export function withSuiteShards<T extends SelectedPart>(parts: T[]): (T & { suiteShards: SuiteShard[] })[] {
  void parts;
  throw new Error('Suite-local shard coordinates are not implemented.');
}
