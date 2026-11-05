import { describe, expect, it } from 'vitest';
import type { TaskWorkspaceBinding, VerifiedWorkspace } from '../src/task-workspaces.js';
import { selectTaskWorkspaceSession, type TaskWorkspaceSessionContext, type TaskWorkspaceSessionRecord } from '../src/task-workspace-sessions.js';

const binding: TaskWorkspaceBinding = {
  workspaceId: '00000000-0000-4000-8000-000000000001', taskId: '00000000-0000-4000-8000-000000000002',
  agentId: '00000000-0000-4000-8000-000000000003', nodeId: { kind: 'node', nodeId: '00000000-0000-4000-8000-000000000004' },
  assignmentEpoch: 0, bindingVersion: 1, repositoryId: '00000000-0000-4000-8000-000000000005',
  taskBranch: 'task-00000000-0000-4000-8000-000000000002', baseSha: 'a'.repeat(40),
};
const workspace: VerifiedWorkspace = { binding, realPath: '/node/work/agents/a/task-workspaces/w/app', ownerUid: 1000,
  gitCommonDir: '/node/work/agents/a/repositories/r/app/.git', sourceHeadSha: 'b'.repeat(40) };
const request: TaskWorkspaceSessionContext = { workspace, provider: 'codex', subscriptionId: '00000000-0000-4000-8000-000000000006',
  instructionsIdentity: 'instructions-v1', modelIdentity: 'model-v1', mode: 'continuation' };
const saved: TaskWorkspaceSessionRecord = { binding: structuredClone(binding), contextPath: '/node/work/agents/a/task-workspaces/w',
  provider: 'codex', subscriptionId: request.subscriptionId, instructionsIdentity: 'instructions-v1', modelIdentity: 'model-v1', nativeSessionId: 'task-a-session' };

describe('task workspace native session matching', () => {
  it('resumes the task session even when another task has the latest agent session', () => {
    const other = { ...saved, binding: { ...binding, workspaceId: '00000000-0000-4000-8000-000000000099' }, nativeSessionId: 'task-b-session' };
    expect(selectTaskWorkspaceSession(request, [saved, other])).toEqual({ kind: 'resume', sessionId: 'task-a-session' });
    expect(selectTaskWorkspaceSession(request, [other, saved])).toEqual({ kind: 'resume', sessionId: 'task-a-session' });
  });

  it('keeps continuation after temporary overload in the same native session', () => {
    expect(selectTaskWorkspaceSession(request, [saved])).toEqual({ kind: 'resume', sessionId: 'task-a-session' });
  });

  it('starts fresh at every handover destination even if a compatible record exists', () => {
    expect(selectTaskWorkspaceSession({ ...request, mode: 'handover' }, [saved])).toEqual({ kind: 'fresh', reason: 'handover' });
  });

  it('starts visibly fresh when the task session is missing', () => {
    expect(selectTaskWorkspaceSession(request, [])).toEqual({ kind: 'fresh', reason: 'missing' });
  });

  it('keeps a cleared session fresh instead of finding another task session', () => {
    expect(selectTaskWorkspaceSession(request, [{ ...saved, nativeSessionId: null }])).toEqual({ kind: 'fresh', reason: 'cleared' });
  });

  it.each([
    ['workspace', { workspaceId: '00000000-0000-4000-8000-000000000099' }],
    ['task', { taskId: '00000000-0000-4000-8000-000000000099' }],
    ['agent', { agentId: '00000000-0000-4000-8000-000000000099' }],
    ['repository', { repositoryId: '00000000-0000-4000-8000-000000000099' }],
    ['epoch', { assignmentEpoch: 1 }], ['binding generation', { bindingVersion: 2 }],
    ['branch', { taskBranch: 'other-task' }], ['base', { baseSha: 'c'.repeat(40) }],
    ['node identity', { nodeId: { kind: 'node', nodeId: '00000000-0000-4000-8000-000000000099' } }],
    ['node kind', { nodeId: { kind: 'builtin' } }],
  ] satisfies [string, Partial<TaskWorkspaceBinding>][])('never resumes across a changed %s', (_name, changed) => {
    expect(selectTaskWorkspaceSession(request, [{ ...saved, binding: { ...binding, ...changed } }])).toEqual({ kind: 'fresh', reason: 'incompatible' });
  });

  it.each([
    ['context root', { contextPath: '/node/work/agents/a/task-workspaces/other' }],
    ['provider', { provider: 'claude' }],
    ['subscription', { subscriptionId: '00000000-0000-4000-8000-000000000099' }],
    ['instructions', { instructionsIdentity: 'instructions-v2' }],
    ['model', { modelIdentity: 'model-v2' }],
  ] satisfies [string, Partial<TaskWorkspaceSessionRecord>][])('starts visibly fresh after a changed %s', (_name, changed) => {
    expect(selectTaskWorkspaceSession(request, [{ ...saved, ...changed }])).toEqual({ kind: 'fresh', reason: 'incompatible' });
  });

  it('refuses ambiguous matching records without choosing one by array order', () => {
    const other = { ...saved, nativeSessionId: 'other-session' };
    expect(selectTaskWorkspaceSession(request, [saved, other])).toEqual({ kind: 'fresh', reason: 'ambiguous' });
    expect(selectTaskWorkspaceSession(request, [other, saved])).toEqual({ kind: 'fresh', reason: 'ambiguous' });
  });

  it.each(['', 'line\nbreak', 'nul\u0000byte', 'x'.repeat(4097)])('never supplies an unusable native session ID to the provider (%#)', nativeSessionId => {
    expect(selectTaskWorkspaceSession(request, [{ ...saved, nativeSessionId }])).toEqual({ kind: 'fresh', reason: 'incompatible' });
  });

  it('matches the built-in node without inventing a physical node UUID', () => {
    const builtin = { ...binding, nodeId: { kind: 'builtin' as const } };
    expect(selectTaskWorkspaceSession({ ...request, workspace: { ...workspace, binding: builtin } }, [{ ...saved, binding: builtin }]))
      .toEqual({ kind: 'resume', sessionId: 'task-a-session' });
  });

  it('does not alter the verified workspace or saved native session records', () => {
    const before = structuredClone({ request, saved }); selectTaskWorkspaceSession(request, [saved]);
    expect({ request, saved }).toEqual(before);
  });

  it('keeps the same session while the registered task accumulates unpublished commits', () => {
    expect(selectTaskWorkspaceSession({ ...request, workspace: { ...workspace, sourceHeadSha: 'c'.repeat(40) } }, [saved]))
      .toEqual({ kind: 'resume', sessionId: 'task-a-session' });
  });

  it.each(['subscriptionId', 'instructionsIdentity', 'modelIdentity'] as const)('requires a known %s before reusing a session', key => {
    expect(selectTaskWorkspaceSession({ ...request, [key]: '' }, [{ ...saved, [key]: '' }])).toEqual({ kind: 'fresh', reason: 'incompatible' });
  });
});
