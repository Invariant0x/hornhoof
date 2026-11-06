import type { ImpactEnvironment } from './test-impact.js';
import type { FullComparator, ImpactReplay } from './test-impact-replay.js';

export interface ImpactReplayRequest { environment: ImpactEnvironment; projectSuites: Record<string, string[]>; comparator?: FullComparator }
export async function runImpactReplay(root: string, request: ImpactReplayRequest): Promise<ImpactReplay> {
  void root; void request;
  return { version: 1, candidate: '', scope: 'historical-diffs-at-candidate', status: 'blocked', rows: [] };
}
export const replayExitCode = (report: ImpactReplay): number => report.status === 'blocked' ? 3 : report.status === 'observed-misses' ? 2 : 0;
