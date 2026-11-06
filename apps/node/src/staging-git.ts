export interface StagingPreparationRequest {
  batchId: string; trialId: string; turn: number; baseSha: string; createdAt: string;
  heads: { submissionId: string; headSha: string }[];
}
export interface StagingGitOptions { input?: string; env?: Record<string, string>; signal?: AbortSignal }
export interface StagingGitContext {
  git: (args: string[], options?: StagingGitOptions) => Promise<{ code: number | null; stdout: string }>;
  identity: { name: string; email: string }; signal: AbortSignal;
}
export type StagingPreparationResult = { status: 'prepared'; ref: string; commitSha: string; treeSha: string; members: string[] }
  | { status: 'conflict'; submissionId: string } | { status: 'unavailable' };

/* The caller owns the private bare repository and authenticated Git executor. Never runs project code. */
export async function prepareStagingCandidate(request: StagingPreparationRequest, context: StagingGitContext): Promise<StagingPreparationResult> {
  void request; void context;
  return { status: 'unavailable' };
}
