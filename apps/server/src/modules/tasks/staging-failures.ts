import type { StagingFailureTest } from './staging-split.js';

export interface StagingFailureLog {
  adapter: 'vitest' | 'pytest'; suiteId: string; root: string; files: string[]; log: string;
}

/* Text compatibility only. The caller must bind the complete log to authenticated native run/part/pin evidence. */
export function parseStagingFailureTests(input: StagingFailureLog): StagingFailureTest[] | null {
  void input;
  return null;
}
