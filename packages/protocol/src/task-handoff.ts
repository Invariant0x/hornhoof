import { z } from 'zod';
import { TaskWorkspaceBinding, WorkspaceCommitSha } from './task-workspace.js';

const Id = z.uuid();
const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const Time = z.iso.datetime();
const Base = z.strictObject({ version: z.literal(1), handoffId: Id, taskId: Id, binding: TaskWorkspaceBinding });
const CaptureBase = Base.extend({ captureId: Id });

export const HandoffMessage = z.discriminatedUnion('type', [
  CaptureBase.extend({
    type: z.literal('task.handoff.saved'),
    baseSha: WorkspaceCommitSha,
    checkpointSha: WorkspaceCommitSha,
    sanitizerVersion: z.string().min(1).max(40),
    contentDigest: Digest,
    redactedFiles: z.number().int().nonnegative(),
    omittedFiles: z.number().int().nonnegative(),
    requiresRepair: z.boolean(),
    quiescent: z.literal(true),
  }).strict(),
  CaptureBase.extend({
    type: z.literal('task.handoff.problem'),
    phase: z.enum(['detected', 'waiting_reset', 'capturing', 'checkpoint_ready', 'waiting_capacity', 'reserving', 'assigned', 'restoring', 'running', 'complete', 'waiting_source', 'waiting_for_workspace', 'waiting_provider', 'export_failed', 'waiting_repair', 'resume_requested', 'restore_failed']),
    code: z.enum(['workspace_missing', 'workspace_ambiguous', 'source_context_lost', 'source_not_quiescent', 'stale_epoch', 'ref_conflict', 'unsafe_required_payload', 'export_too_large', 'scan_failed', 'network_unavailable', 'target_unavailable', 'restore_failed', 'unsupported_required_output', 'deadline', 'cancelled']),
    retryable: z.boolean(),
  }).strict(),
  Base.extend({ type: z.literal('task.handoff.reserved'), reservationId: Id, expiresAt: Time }).strict(),
  Base.extend({ type: z.literal('task.handoff.restored'), jobId: Id, workspaceId: Id, restoredTreeDigest: Digest, readyForPrompt: z.literal(true) }).strict(),
  Base.extend({ type: z.literal('task.handoff.prompt_accepted'), captureId: Id.nullable(), jobId: Id, workspaceId: Id, acceptedAt: Time }).strict(),
  Base.extend({ type: z.literal('task.handoff.source_ready'), cancelId: Id, workspaceId: Id, captureStopped: z.literal(true) }).strict(),
]);
export type HandoffMessage = z.infer<typeof HandoffMessage>;

export const HandoffControlMessage = z.discriminatedUnion('type', [
  Base.extend({ type: z.literal('task.handoff.capture'), fromJobId: Id, workspaceId: Id, repositoryId: Id, expectedWipSha: WorkspaceCommitSha.nullable(), deadline: Time }).strict(),
  Base.extend({ type: z.literal('task.handoff.offer'), candidateAgentId: Id, repositoryId: Id, baseSha: WorkspaceCommitSha, checkpointSha: WorkspaceCommitSha, deadline: Time }).strict(),
  Base.extend({ type: z.literal('task.handoff.resume_source'), cancelId: Id, workspaceId: Id }).strict(),
  Base.extend({ type: z.literal('task.handoff.release'), reservationId: Id, reason: z.enum(['stale', 'cancelled', 'expired']) }).strict(),
]);
export type HandoffControlMessage = z.infer<typeof HandoffControlMessage>;

export const HandoffAssignment = CaptureBase.extend({ reservationId: Id, baseSha: WorkspaceCommitSha, checkpointSha: WorkspaceCommitSha }).strict();
export type HandoffAssignment = z.infer<typeof HandoffAssignment>;

export const ResetSource = z.enum(['provider', 'probe']);
export type ResetSource = z.infer<typeof ResetSource>;
