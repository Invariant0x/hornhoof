import type { TestUnit } from '@hornhoof/protocol';
import type { ImpactChange, ImpactEnvironment, ImpactGraph, ImpactSelection } from './test-impact.js';

export interface ReplayCommit { commit: string; parent: string; changes: ImpactChange[] }
export interface FullComparator { commit: string; run: number; part: number; status: 'passed' | 'failed'; inventory: TestUnit[]; failedUnits: TestUnit[] }
export type ReplayComparison = { status: 'unavailable'; reason: string } | { status: 'observed'; run: number; part: number; missed: TestUnit[] };
export interface ImpactReplayRow {
  commit: string; parent: string; changed: string[]; selectedCount: number; totalCount: number; widthPercent: number;
  selection: ImpactSelection; comparison: ReplayComparison;
}
export interface ImpactReplay { version: 1; candidate: string; scope: 'historical-diffs-at-candidate'; status: 'recorded' | 'blocked' | 'observed-misses'; rows: ImpactReplayRow[] }
export interface ImpactReplayInput {
  candidate: string; commits: ReplayCommit[]; environment: ImpactEnvironment; comparator?: FullComparator;
  collect: (changes: ImpactChange[]) => Promise<ImpactGraph[]>;
}

export function parseImpactDiff(raw: Uint8Array): ImpactChange[] {
  void raw;
  throw new Error('impact_diff_not_implemented');
}

export async function replayImpactChanges(input: ImpactReplayInput): Promise<ImpactReplay> {
  return { version: 1, candidate: input.candidate, scope: 'historical-diffs-at-candidate', status: 'blocked', rows: [] };
}
