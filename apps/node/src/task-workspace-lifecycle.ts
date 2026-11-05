import { z } from 'zod';
import { TaskWorkspaceBinding as Binding, type TaskWorkspaceBinding, type VerifiedWorkspace, type WorkspaceProblem } from '@hornhoof/protocol';
import type { TaskWorkspaceRegistry } from './task-workspaces.js';

/* Consumer of the agreed 418 draft. This interface does not provide a host or advertise capability. */
export interface RetireIdleWorkspace {
  agentKey: string;
  expectedInstance: string;
  expectedJobId: string;
  workspaceId: string;
  bindingVersion: number;
}
export type RetireResult = { status: 'retired'; instanceGone: true }
  | { status: 'busy' | 'stale' | 'unsupported'; instanceGone: false; reason: string };
export interface WorkspaceRetirementProvider {
  retireIdleWorkspace(request: RetireIdleWorkspace): Promise<RetireResult>;
  instanceOf(agentKey: string): string | null;
}
export interface WorkspaceRetirementInput {
  binding: TaskWorkspaceBinding;
  expectedInstance: string;
  expectedJobId: string;
}
export interface WorkspaceRetirementContext {
  registry: Pick<TaskWorkspaceRegistry, 'resolveTaskWorkspace'>;
  provider?: WorkspaceRetirementProvider | null;
}
export interface WorkspaceRetirementObservation {
  kind: 'retired';
  request: RetireIdleWorkspace;
  workspace: VerifiedWorkspace;
}

const HostReply: z.ZodType<RetireResult> = z.discriminatedUnion('status', [
  z.object({ status: z.literal('retired'), instanceGone: z.literal(true) }).strict(),
  z.object({ status: z.enum(['busy', 'stale', 'unsupported']), instanceGone: z.literal(false), reason: z.string() }).strict(),
]);
function unavailable(retryable = false): WorkspaceProblem {
  return { code: 'workspace_switch_unavailable', retryable };
}
function retirementProblem(reply: unknown): WorkspaceProblem | null {
  const parsed = HostReply.safeParse(reply);
  if (!parsed.success) return unavailable();
  switch (parsed.data.status) {
    case 'retired': return null;
    case 'busy': return { code: 'writer_active', retryable: true };
    case 'stale': return { code: 'binding_stale', retryable: false };
    case 'unsupported': return unavailable();
  }
}
function matchesBinding(actual: TaskWorkspaceBinding, expected: TaskWorkspaceBinding): boolean {
  const parsed = Binding.safeParse(actual);
  return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(expected);
}
async function resolveMatching(registry: WorkspaceRetirementContext['registry'], binding: TaskWorkspaceBinding): Promise<VerifiedWorkspace | WorkspaceProblem> {
  const workspace = await registry.resolveTaskWorkspace(binding);
  if ('code' in workspace) return { code: workspace.code, retryable: workspace.retryable };
  if (!matchesBinding(workspace.binding, binding)) return { code: 'binding_stale', retryable: false };
  return { binding: structuredClone(workspace.binding), realPath: workspace.realPath, ownerUid: workspace.ownerUid,
    gitCommonDir: workspace.gitCommonDir, sourceHeadSha: workspace.sourceHeadSha };
}
function sameNamespace(a: VerifiedWorkspace, b: VerifiedWorkspace): boolean {
  return a.realPath === b.realPath && a.ownerUid === b.ownerUid && a.gitCommonDir === b.gitCommonDir;
}
async function observeRetirement(registry: WorkspaceRetirementContext['registry'], provider: WorkspaceRetirementProvider, binding: TaskWorkspaceBinding, request: RetireIdleWorkspace): Promise<WorkspaceRetirementObservation | WorkspaceProblem> {
  const before = await resolveMatching(registry, binding);
  if ('code' in before) return before;
  const problem = retirementProblem(await provider.retireIdleWorkspace(request));
  if (problem) return problem;
  const after = await resolveMatching(registry, binding);
  if ('code' in after) return after;
  if (!sameNamespace(before, after)) return { code: 'workspace_ambiguous', retryable: false };
  return { kind: 'retired', request, workspace: after };
}

/* A physical observation only, never a durable quiescence ACK or permission to launch or remove data. */
export async function retireRegisteredWorkspace(context: WorkspaceRetirementContext, input: WorkspaceRetirementInput): Promise<WorkspaceRetirementObservation | WorkspaceProblem> {
  if (!context.provider) return unavailable();
  const binding = Binding.safeParse(input.binding);
  if (!binding.success) return { code: 'binding_stale', retryable: false };
  const request: RetireIdleWorkspace = Object.freeze({ agentKey: binding.data.agentId,
    expectedInstance: input.expectedInstance, expectedJobId: input.expectedJobId,
    workspaceId: binding.data.workspaceId, bindingVersion: binding.data.bindingVersion });
  try { return await observeRetirement(context.registry, context.provider, binding.data, request); }
  catch { return unavailable(true); }
}
