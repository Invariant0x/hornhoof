import { z } from 'zod';

/* The managed workspace contract is independent of legacy 64-digit test commits. */
export const WorkspaceCommitSha = z.string().regex(/^[0-9a-f]{40}$/);
export type WorkspaceCommitSha = z.infer<typeof WorkspaceCommitSha>;

export const NodeRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('builtin') }).strict(),
  z.object({ kind: z.literal('node'), nodeId: z.uuid() }).strict(),
]);
export type NodeRef = z.infer<typeof NodeRef>;

/* A literal Git branch/ref name, never a revision expression or a shell command. */
const WorkspaceRef = z.string().min(1).max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9/._-]*$/)
  .refine(literalRef, 'Not a literal Git ref.');

function literalRef(value: string): boolean {
  return !/(?:\.\.|\/\/|\/$|\.$|(?:^|\/)\.|\.lock(?:\/|$))/.test(value);
}

export const TaskWorkspaceBinding = z.object({
  workspaceId: z.uuid(), taskId: z.uuid(), agentId: z.uuid(), nodeId: NodeRef,
  assignmentEpoch: z.number().int().min(0), bindingVersion: z.number().int().min(1),
  repositoryId: z.uuid(), taskBranch: WorkspaceRef, baseSha: WorkspaceCommitSha,
}).strict();
export type TaskWorkspaceBinding = z.infer<typeof TaskWorkspaceBinding>;

/* Root is explicit; other claims are literal path prefixes, never shell globs. */
export const RepoRelativeArea = z.string().min(1)
  .regex(/^[^\\\u0000-\u001f\u007f:*?\[\]]+$/)
  .refine(relativeArea, 'Not a repository-relative area.');
function relativeArea(value: string): boolean {
  return value === '.' || value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}
export type RepoRelativeArea = z.infer<typeof RepoRelativeArea>;

export const IntegrationTarget = z.object({ kind: z.enum(['turn', 'main']), ref: WorkspaceRef }).strict();
export type IntegrationTarget = z.infer<typeof IntegrationTarget>;
export const TaskWorkspaceSpec = z.object({
  version: z.literal(1), binding: TaskWorkspaceBinding, baseRef: WorkspaceRef,
  areas: z.array(RepoRelativeArea).min(1), requiredIntegrations: z.array(IntegrationTarget).min(1),
}).strict();
export type TaskWorkspaceSpec = z.infer<typeof TaskWorkspaceSpec>;

export const WorkspaceProblemCode = z.enum([
  'workspace_missing', 'workspace_ambiguous', 'wrong_repository', 'wrong_owner', 'wrong_branch',
  'base_unavailable', 'binding_stale', 'branch_conflict', 'author_wip_limit', 'area_conflict',
  'turn_branch_red', 'turn_health_unknown', 'integration_plan_missing', 'writer_active',
  'writer_tracking_unavailable', 'workspace_switch_unavailable', 'merge_proof_missing',
  'publication_unproven', 'unmerged_commits', 'uncommitted_files', 'unknown_untracked',
  'unknown_ignored', 'remove_failed', 'node_offline',
]);
export type WorkspaceProblemCode = z.infer<typeof WorkspaceProblemCode>;
export const WorkspaceProblem = z.object({ code: WorkspaceProblemCode, retryable: z.boolean() }).strict();
export type WorkspaceProblem = z.infer<typeof WorkspaceProblem>;

/* Node-local resolver output, never accepted as path authority from the wire. */
export interface VerifiedWorkspace {
  binding: TaskWorkspaceBinding;
  realPath: string;
  ownerUid: number;
  gitCommonDir: string;
  sourceHeadSha: WorkspaceCommitSha;
}
