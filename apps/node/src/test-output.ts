export type ReadOutputFile =
  | { path: string; status: 'read'; bytes: Buffer; size: number; sha256: string }
  | { path: string; status: 'refused'; reason: 'output_unavailable' | 'output_too_large' };

// Reads diagnostic bytes only; content checks, authorization and upload belong to the runner lifecycle.
export async function readOutputFiles(_folder: string, _paths: readonly string[], _ownerUid: number): Promise<ReadOutputFile[]> {
  throw new Error('Test output reads are not implemented.');
}
