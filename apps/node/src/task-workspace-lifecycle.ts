import type { TaskWorkspaceBinding, VerifiedWorkspace, WorkspaceProblem } from '@hornhoof/protocol';
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

/* A physical observation only, never a durable quiescence ACK or permission to launch or remove data. */
export async function retireRegisteredWorkspace(context: WorkspaceRetirementContext, input: WorkspaceRetirementInput): Promise<WorkspaceRetirementObservation | WorkspaceProblem> {
  void context; void input;
  return { code: 'workspace_switch_unavailable', retryable: false };
}
