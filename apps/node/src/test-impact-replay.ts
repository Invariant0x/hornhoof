import type { TestUnit } from '@hornhoof/protocol';
import type { ImpactChange, ImpactEnvironment, ImpactGraph, ImpactSelection } from './test-impact.js';
import { selectAffectedTests } from './test-impact.js';

interface ReplayCommit { commit: string; parent: string; changes: ImpactChange[] }
export interface FullComparator { commit: string; run: number; part: number; status: 'passed' | 'failed'; inventory: TestUnit[]; failedUnits: TestUnit[] }
type ReplayComparison = { status: 'unavailable'; reason: string } | { status: 'observed'; run: number; part: number; missed: TestUnit[] };
interface ImpactReplayRow {
  commit: string; parent: string; changed: string[]; selectedCount: number; totalCount: number; widthPercent: number;
  selection: ImpactSelection; comparison: ReplayComparison;
}
export interface ImpactReplay { version: 1; candidate: string; scope: 'historical-diffs-at-candidate'; status: 'recorded' | 'blocked' | 'observed-misses'; rows: ImpactReplayRow[] }
export interface ImpactReplayInput {
  candidate: string; commits: ReplayCommit[]; environment: ImpactEnvironment; comparator?: FullComparator;
  collect: (changes: ImpactChange[]) => Promise<ImpactGraph[]>;
}

const identity = (unit: TestUnit): string => `${unit.suiteId}\0${unit.file}\0${unit.selectionUnit}`;
const pinned = (sha: string): boolean => /^[a-f0-9]{40}$/.test(sha);
function field(parts: string[]): string {
  const value = parts.shift();
  if (!value) throw new Error('impact_diff_invalid');
  return value;
}
function record(parts: string[]): ImpactChange {
  const status = field(parts), path = field(parts);
  const simple = new Map<string, ImpactChange['kind']>([['M', 'modified'], ['A', 'added'], ['D', 'deleted']]);
  const kind = simple.get(status);
  if (kind) return { kind, path };
  if (/^[RC]\d{1,3}$/.test(status)) return { kind: 'renamed', previousPath: path, path: field(parts) };
  throw new Error('impact_diff_invalid');
}

/* git diff --name-status -z. No shell quoting or line splitting is involved. */
export function parseImpactDiff(raw: Uint8Array): ImpactChange[] {
  if (!raw.length) return [];
  const parts = new TextDecoder('utf-8', { fatal: true }).decode(raw).split('\0');
  if (parts.pop() !== '') throw new Error('impact_diff_invalid');
  const changes: ImpactChange[] = [];
  while (parts.length) changes.push(record(parts));
  return changes;
}
function validateInput(input: ImpactReplayInput): void {
  if (!pinned(input.candidate) || input.commits.length !== 10 || new Set(input.commits.map(commit => commit.commit)).size !== 10) throw new Error('impact_replay_input_invalid');
  if (input.commits.some(commit => !pinned(commit.commit) || !pinned(commit.parent))) throw new Error('impact_replay_input_invalid');
}
function sameInventory(expected: TestUnit[], actual: TestUnit[]): boolean {
  const wanted = new Set(expected.map(identity)), found = new Set(actual.map(identity));
  return wanted.size === found.size && [...wanted].every(key => found.has(key));
}
function validReceipt(receipt: FullComparator, input: ImpactReplayInput): boolean {
  if (!new Set(['passed', 'failed']).has(receipt.status)) return false;
  if (receipt.commit !== input.candidate || !Number.isInteger(receipt.run) || !Number.isInteger(receipt.part)) return false;
  if (receipt.run < 1 || receipt.part < 1 || !sameInventory(input.environment.inventory, receipt.inventory)) return false;
  if ((receipt.status === 'passed') !== (receipt.failedUnits.length === 0)) return false;
  const all = new Set(input.environment.inventory.map(identity));
  return receipt.failedUnits.every(unit => all.has(identity(unit)));
}
function compare(input: ImpactReplayInput, selection: ImpactSelection): ReplayComparison {
  const receipt = input.comparator;
  if (!receipt) return { status: 'unavailable', reason: 'full_comparator_missing' };
  if (!validReceipt(receipt, input)) return { status: 'unavailable', reason: 'full_comparator_invalid' };
  const selected = new Set(selection.units.map(identity));
  return { status: 'observed', run: receipt.run, part: receipt.part, missed: structuredClone(receipt.failedUnits.filter(unit => !selected.has(identity(unit)))) };
}
async function replayRow(input: ImpactReplayInput, commit: ReplayCommit): Promise<ImpactReplayRow> {
  let graphs: ImpactGraph[];
  try { graphs = await input.collect(commit.changes); } catch { graphs = []; }
  const selection = selectAffectedTests({ environment: input.environment, changes: commit.changes, graphs });
  const totalCount = new Set(input.environment.inventory.map(identity)).size;
  const selectedCount = selection.units.length;
  const changed = [...new Set(commit.changes.flatMap(change => change.previousPath === undefined ? [change.path] : [change.previousPath, change.path]))].sort();
  return { commit: commit.commit, parent: commit.parent, changed, selectedCount, totalCount, widthPercent: totalCount ? Math.round(selectedCount / totalCount * 10000) / 100 : 0,
    selection, comparison: compare(input, selection) };
}
function reportStatus(rows: ImpactReplayRow[]): ImpactReplay['status'] {
  if (rows.some(row => row.selection.status === 'blocked')) return 'blocked';
  if (rows.some(row => row.comparison.status === 'observed' && row.comparison.missed.length)) return 'observed-misses';
  return 'recorded';
}

/* Collection widths at one candidate are not ten historical execution results. */
export async function replayImpactChanges(input: ImpactReplayInput): Promise<ImpactReplay> {
  validateInput(input);
  const rows: ImpactReplayRow[] = [];
  for (const commit of input.commits) rows.push(await replayRow(input, commit));
  return { version: 1, candidate: input.candidate, scope: 'historical-diffs-at-candidate', status: reportStatus(rows), rows };
}
