import type { Failure, TaskWorkspaceBinding, VerifiedWorkspace, WorkspaceProblem } from '@hornhoof/protocol';
import { restoreTaskCheckpoint, type RestoreResult } from './handoff-restore.js';
import { problemOf, type HandoffCode, type RemoteRepo } from './handoff-wip.js';
import type { JobUser } from './isolation.js';
import { captureIsSealed, captureTaskCheckpoint, type CheckpointResult } from './task-checkpoint.js';

/* What the owners of the wire call on the node: the private lease of a task's source, a capture, a restore and what a failed turn means for them.
   Secrets and callbacks stay in this memory: neither reaches a message, the journal or a checkpoint. No clock lives here: when to retry or hand over is the server's. */

export interface HandoffSource {
  jobId: string; workspaceId: string; assignmentEpoch: number; programInstanceId: string; knownSecrets: readonly string[];
  readTaskRecords: () => Promise<string | null>; readLastTest: () => Promise<string | null>;
  quiesceEndedTurn: (programInstanceId: string) => Promise<boolean>;
}
export interface CaptureRequest {
  handoffId: string; captureId: string; captureSequence: number; taskNumber: number; fromJobId: string; binding: TaskWorkspaceBinding;
  owner: JobUser; repo: RemoteRepo; baseSha?: string; declaredOutputs?: readonly string[]; signal?: AbortSignal;
}
export interface RestoreRequest {
  binding: TaskWorkspaceBinding; baseSha: string; checkpointSha: string; contentDigest: string; owner: JobUser; repo: RemoteRepo; secrets: readonly string[]; signal?: AbortSignal;
}
export interface HandoffRuntime {
  registerHandoffSource(source: HandoffSource): void;
  forgetHandoffSource(workspaceId: string): void;
  captureHandoff(request: CaptureRequest): Promise<CheckpointResult>;
  restoreHandoff(request: RestoreRequest): Promise<RestoreResult>;
}
export interface HandoffRuntimeOptions { resolveTaskWorkspace: (binding: TaskWorkspaceBinding) => Promise<VerifiedWorkspace | WorkspaceProblem>; journalRoot: string }

interface Lease { latest: HandoffSource; secrets: Set<string>; jobs: Set<string> }

const refused = (code: HandoffCode, retryable = false): CheckpointResult => ({ ok: false, problem: { phase: 'capture', code, retryable } });
const orNothing = async (read: () => Promise<string | null>): Promise<string | null> => {
  try { return await read(); } catch { return null; }
};
const stopped = async (source: HandoffSource): Promise<boolean> => {
  try { return await source.quiesceEndedTurn(source.programInstanceId); } catch { return false; }
};

export function createHandoffRuntime(options: HandoffRuntimeOptions): HandoffRuntime {
  const leases = new Map<string, Lease>();
  const { journalRoot } = options;

  function registerHandoffSource(source: HandoffSource): void {
    const lease = leases.get(source.workspaceId), epoch = lease?.latest.assignmentEpoch ?? -1;
    if (source.assignmentEpoch < epoch) return;
    const same = lease && source.assignmentEpoch === epoch;
    leases.set(source.workspaceId, { latest: source, secrets: new Set([...(same ? lease.secrets : []), ...source.knownSecrets]), jobs: new Set([...(same ? lease.jobs : []), source.jobId]) });
  }
  const capture = (request: CaptureRequest, secrets: readonly string[], lastTests: string | null, conversationTail: string | null): Promise<CheckpointResult> =>
    captureTaskCheckpoint({ handoffId: request.handoffId, captureId: request.captureId, captureSequence: request.captureSequence, taskId: request.binding.taskId, taskNumber: request.taskNumber,
      resolveWorkspace: () => options.resolveTaskWorkspace(request.binding), owner: request.owner, repo: request.repo, journalRoot, secrets, lastTests, conversationTail,
      ...(request.baseSha === undefined ? {} : { baseSha: request.baseSha }), ...(request.declaredOutputs === undefined ? {} : { declaredOutputs: request.declaredOutputs }), ...(request.signal === undefined ? {} : { signal: request.signal }) });

  async function captureHandoff(request: CaptureRequest): Promise<CheckpointResult> {
    /* A sealed attempt reads nothing, so it needs no lease: a restarted node still answers a lost acknowledgement with the same commit. */
    if (captureIsSealed(journalRoot, request.handoffId, request.captureId)) return capture(request, [...(leases.get(request.binding.workspaceId)?.secrets ?? [])], null, null);
    const lease = leases.get(request.binding.workspaceId);
    if (!lease || !lease.jobs.has(request.fromJobId)) return refused('source_context_lost');
    if (lease.latest.assignmentEpoch !== request.binding.assignmentEpoch) return refused('stale_epoch');
    if (!(await stopped(lease.latest))) return refused('source_not_quiescent', true);
    const lastTests = await orNothing(lease.latest.readLastTest), records = await orNothing(lease.latest.readTaskRecords);
    return capture(request, [...lease.secrets], lastTests, records);
  }
  async function restoreHandoff(request: RestoreRequest): Promise<RestoreResult> {
    try {
      return await restoreTaskCheckpoint({ taskId: request.binding.taskId, baseSha: request.baseSha, checkpointSha: request.checkpointSha, contentDigest: request.contentDigest,
        resolveWorkspace: () => options.resolveTaskWorkspace(request.binding), owner: request.owner, repo: request.repo, journalRoot, secrets: [...request.secrets, request.repo.token].filter(Boolean),
        ...(request.signal === undefined ? {} : { signal: request.signal }) });
    } catch (error) { return { ok: false, problem: problemOf(error, 'restore') }; }
  }
  return { registerHandoffSource, forgetHandoffSource: workspaceId => { leases.delete(workspaceId); }, captureHandoff, restoreHandoff };
}

/* What a failed turn means for a handover, from the program's own typed failure of this turn and nothing else: an exit code or a screen says none of it.
   The server keeps the episode: the same session again while it is short, a handover when it lasts; a limit or a denied model hands over at once. */
export type TurnCause = 'temporary_overload' | 'usage_limit' | 'model_access_denied' | 'other';

/* The words begin the provider's own report, after its code at most. The same words deeper in come from a tool, a file or a quote. */
const MODEL_ACCESS = /^(?:[\w.-]+(?: \d{3})?: )?Unable to verify model access\b/;

export function turnCause(failure: Failure | null | undefined): TurnCause {
  if (failure?.kind === 'overloaded') return 'temporary_overload';
  if (failure?.kind === 'usage_limit') return 'usage_limit';
  return failure?.kind === 'unknown' && MODEL_ACCESS.test(failure.text) ? 'model_access_denied' : 'other';
}
