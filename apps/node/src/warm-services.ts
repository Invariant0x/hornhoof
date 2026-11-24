import type { JobUser } from './isolation.js';

export type WarmPiece = { env: Record<string, string>; drop(): Promise<void> };
export type WarmOptions = { root: string; user: JobUser | null; sweepMs?: number; readyMs?: number };

/* RED stub for #2091: the tests come first. */
export class WarmServices {
  constructor(readonly options: WarmOptions) {}
  async start(): Promise<void> { throw new Error('not yet'); }
  async pieceFor(_cwd: string, _command: readonly string[], _owner: string, _signal: AbortSignal): Promise<WarmPiece | null> { throw new Error('not yet'); }
  async sweep(): Promise<number> { throw new Error('not yet'); }
  async close(_how: { stopServices: boolean }): Promise<void> {}
}
