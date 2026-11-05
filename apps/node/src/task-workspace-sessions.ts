import type { ProviderId } from '@hornhoof/protocol';
import { dirname } from 'node:path';
import type { NodeRef, TaskWorkspaceBinding, VerifiedWorkspace } from './task-workspaces.js';

export interface TaskWorkspaceSessionContext {
  workspace: VerifiedWorkspace;
  provider: ProviderId;
  subscriptionId: string;
  instructionsIdentity: string;
  modelIdentity: string;
  mode: 'continuation' | 'handover';
}
export interface TaskWorkspaceSessionRecord {
  binding: TaskWorkspaceBinding;
  contextPath: string;
  provider: ProviderId;
  subscriptionId: string;
  instructionsIdentity: string;
  modelIdentity: string;
  nativeSessionId: string | null;
}
export type TaskWorkspaceSessionSelection = { kind: 'resume'; sessionId: string }
  | { kind: 'fresh'; reason: 'missing' | 'cleared' | 'incompatible' | 'ambiguous' | 'handover' };

function sameNode(a: NodeRef, b: NodeRef): boolean {
  return a.kind === b.kind && (a.kind === 'builtin' || (b.kind === 'node' && a.nodeId === b.nodeId));
}
function sameBinding(a: TaskWorkspaceBinding, b: TaskWorkspaceBinding): boolean {
  const fields = ['workspaceId', 'taskId', 'agentId', 'assignmentEpoch', 'bindingVersion', 'repositoryId', 'taskBranch', 'baseSha'] as const;
  return fields.every(key => a[key] === b[key]) && sameNode(a.nodeId, b.nodeId);
}
function compatible(context: TaskWorkspaceSessionContext, saved: TaskWorkspaceSessionRecord): boolean {
  return [context.subscriptionId, context.instructionsIdentity, context.modelIdentity].every(value => value.length > 0)
    && sameBinding(context.workspace.binding, saved.binding)
    && dirname(context.workspace.realPath) === saved.contextPath
    && context.provider === saved.provider && context.subscriptionId === saved.subscriptionId
    && context.instructionsIdentity === saved.instructionsIdentity && context.modelIdentity === saved.modelIdentity;
}
function nativeSelection(sessionId: string | null): TaskWorkspaceSessionSelection {
  if (sessionId === null) return { kind: 'fresh', reason: 'cleared' };
  if (!sessionId || sessionId.length > 4096 || /[\u0000-\u001f\u007f]/.test(sessionId)) return { kind: 'fresh', reason: 'incompatible' };
  return { kind: 'resume', sessionId };
}

/* Pure matching only: the caller supplies freshly verified registry data and private node records. */
export function selectTaskWorkspaceSession(context: TaskWorkspaceSessionContext, records: readonly TaskWorkspaceSessionRecord[]): TaskWorkspaceSessionSelection {
  if (context.mode === 'handover') return { kind: 'fresh', reason: 'handover' };
  const matches = records.filter(saved => compatible(context, saved));
  if (matches.length === 0) return { kind: 'fresh', reason: records.length === 0 ? 'missing' : 'incompatible' };
  if (matches.length !== 1) return { kind: 'fresh', reason: 'ambiguous' };
  return nativeSelection(matches[0]!.nativeSessionId);
}
