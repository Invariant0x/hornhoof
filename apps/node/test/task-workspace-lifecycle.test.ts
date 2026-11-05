import { describe, expect, it, vi } from 'vitest';
import type { TaskWorkspaceBinding, VerifiedWorkspace, WorkspaceProblem } from '@hornhoof/protocol';
import { retireRegisteredWorkspace, type RetireIdleWorkspace, type RetireResult, type WorkspaceRetirementContext, type WorkspaceRetirementInput } from '../src/task-workspace-lifecycle.js';

/* Unit doubles for the agreed contract only. There is no actual TerminalHost provider in these tests. */
function fixture() {
  const binding: TaskWorkspaceBinding = {
    workspaceId: '00000000-0000-4000-8000-000000000001', taskId: '00000000-0000-4000-8000-000000000002',
    agentId: '00000000-0000-4000-8000-000000000003', nodeId: { kind: 'builtin' },
    assignmentEpoch: 0, bindingVersion: 1, repositoryId: '00000000-0000-4000-8000-000000000004',
    taskBranch: 'task-00000000-0000-4000-8000-000000000002', baseSha: 'a'.repeat(40),
  };
  const workspace: VerifiedWorkspace = { binding: structuredClone(binding), realPath: '/fixture/context/app', ownerUid: 20000,
    gitCommonDir: '/fixture/source/app/.git', sourceHeadSha: 'b'.repeat(40) };
  const input: WorkspaceRetirementInput = { binding, expectedInstance: 'opaque:old-instance', expectedJobId: '00000000-0000-4000-8000-000000000005' };
  const resolve = vi.fn<(binding: TaskWorkspaceBinding) => Promise<VerifiedWorkspace | WorkspaceProblem>>().mockImplementation(async () => structuredClone(workspace));
  const retire = vi.fn<(request: RetireIdleWorkspace) => Promise<RetireResult>>().mockResolvedValue({ status: 'retired', instanceGone: true });
  const context: WorkspaceRetirementContext = { registry: { resolveTaskWorkspace: resolve }, provider: { retireIdleWorkspace: retire, instanceOf: () => 'opaque:replacement-instance' } };
  return { context, input, workspace, resolve, retire };
}
const expectedRequest: RetireIdleWorkspace = {
  agentKey: '00000000-0000-4000-8000-000000000003', expectedInstance: 'opaque:old-instance',
  expectedJobId: '00000000-0000-4000-8000-000000000005', workspaceId: '00000000-0000-4000-8000-000000000001', bindingVersion: 1,
};

describe('registered workspace retirement consumer, unit provenance', () => {
  it('fails closed with no provider instead of inventing a retired observation', async () => {
    const { context, input } = fixture(); delete context.provider;
    expect(await retireRegisteredWorkspace(context, input)).toEqual({ code: 'workspace_switch_unavailable', retryable: false });
  });

  it('observes only the exact captured source tuple with registry checks before and after', async () => {
    const { context, input, workspace, retire, resolve } = fixture();
    expect(await retireRegisteredWorkspace(context, input)).toEqual({ kind: 'retired', request: expectedRequest, workspace });
    expect(retire).toHaveBeenCalledExactlyOnceWith(expectedRequest);
    expect(resolve.mock.calls).toEqual([[input.binding], [input.binding]]);
  });

  it.each([
    ['busy', { code: 'writer_active', retryable: true }],
    ['stale', { code: 'binding_stale', retryable: false }],
    ['unsupported', { code: 'workspace_switch_unavailable', retryable: false }],
  ] as const)('maps %s to a safe problem without exposing the host reason', async (status, expected) => {
    const { context, input, retire } = fixture();
    retire.mockResolvedValue({ status, instanceGone: false, reason: 'private host diagnostic' });
    expect(await retireRegisteredWorkspace(context, input)).toEqual(expected);
    expect(retire).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 'retired', instanceGone: false }, { status: 'retired' },
    { status: 'busy', instanceGone: true }, { status: 'stale', instanceGone: true },
    { status: 'unsupported', instanceGone: true }, { status: 'unknown', instanceGone: false },
  ])('rejects contradictory or unsupported host evidence (%#)', async reply => {
    const { context, input, retire } = fixture(); retire.mockResolvedValue(reply as unknown as RetireResult);
    expect(await retireRegisteredWorkspace(context, input)).toEqual({ code: 'workspace_switch_unavailable', retryable: false });
  });

  it('rejects a noncanonical binding before calling the host', async () => {
    const { context, input, retire } = fixture(); Object.assign(input.binding, { version: 1 });
    expect(await retireRegisteredWorkspace(context, input)).toEqual({ code: 'binding_stale', retryable: false });
    expect(retire).not.toHaveBeenCalled();
  });

  it.each([
    { code: 'workspace_missing', retryable: false }, { code: 'wrong_owner', retryable: false },
    { code: 'writer_active', retryable: true },
  ] satisfies WorkspaceProblem[])('preserves a registry refusal without calling the host (%#)', async problem => {
    const { context, input, resolve, retire } = fixture(); resolve.mockResolvedValue(problem);
    expect(await retireRegisteredWorkspace(context, input)).toEqual(problem);
    expect(retire).not.toHaveBeenCalled();
  });

  it('refuses a registry result from a different binding generation', async () => {
    const { context, input, workspace, resolve, retire } = fixture();
    resolve.mockResolvedValue({ ...workspace, binding: { ...workspace.binding, assignmentEpoch: 1 } });
    expect(await retireRegisteredWorkspace(context, input)).toEqual({ code: 'binding_stale', retryable: false });
    expect(retire).not.toHaveBeenCalled();
  });

  it('refuses a changed binding after the host finishes', async () => {
    const { context, input, workspace, resolve } = fixture();
    resolve.mockResolvedValueOnce(workspace).mockResolvedValueOnce({ ...workspace, binding: { ...workspace.binding, bindingVersion: 2 } });
    expect(await retireRegisteredWorkspace(context, input)).toEqual({ code: 'binding_stale', retryable: false });
  });

  it.each([
    { realPath: '/fixture/replacement/app' }, { ownerUid: 20001 }, { gitCommonDir: '/fixture/replacement/.git' },
  ])('refuses changed verified namespace identity after the host finishes (%#)', async changed => {
    const { context, input, workspace, resolve } = fixture();
    resolve.mockResolvedValueOnce(workspace).mockResolvedValueOnce({ ...workspace, ...changed });
    expect(await retireRegisteredWorkspace(context, input)).toEqual({ code: 'workspace_ambiguous', retryable: false });
  });

  it('allows retained unpublished HEAD changes without claiming clean or quiescent evidence', async () => {
    const { context, input, workspace, resolve } = fixture(), latest = { ...workspace, sourceHeadSha: 'c'.repeat(40) };
    resolve.mockResolvedValueOnce(workspace).mockResolvedValueOnce(latest);
    expect(await retireRegisteredWorkspace(context, input)).toEqual({ kind: 'retired', request: expectedRequest, workspace: latest });
  });

  it('never replaces the captured source instance with a newer current instance during replay', async () => {
    const { context, input, retire } = fixture();
    await retireRegisteredWorkspace(context, input); await retireRegisteredWorkspace(context, input);
    expect(retire.mock.calls).toEqual([[expectedRequest], [expectedRequest]]);
  });

  it('returns busy without automatic retry or launching another operation', async () => {
    const { context, input, retire } = fixture();
    retire.mockResolvedValueOnce({ status: 'busy', instanceGone: false, reason: 'healthy turn' }).mockResolvedValueOnce({ status: 'retired', instanceGone: true });
    expect(await retireRegisteredWorkspace(context, input)).toEqual({ code: 'writer_active', retryable: true });
    expect(retire).toHaveBeenCalledTimes(1);
  });

  it('keeps the request immutable across asynchronous caller mutation', async () => {
    const { context, input, retire } = fixture();
    let entered!: () => void, finish!: () => void;
    const called = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
    retire.mockImplementation(async () => { entered(); await gate; return { status: 'retired', instanceGone: true }; });
    const pending = retireRegisteredWorkspace(context, input);
    await Promise.race([called, pending.then(() => { throw new Error('The provider boundary was never reached.'); })]);
    input.binding.bindingVersion = 7; input.expectedInstance = 'opaque:new-instance'; input.expectedJobId = '00000000-0000-4000-8000-000000000099';
    finish();
    expect(await pending).toMatchObject({ kind: 'retired', request: expectedRequest });
    expect(retire).toHaveBeenCalledExactlyOnceWith(expectedRequest);
  });

  it.each(['registry', 'host', 'post-registry'] as const)('fails closed on unexpected %s rejection without exposing it', async source => {
    const { context, input, workspace, resolve, retire } = fixture(), error = new Error('private unexpected diagnostic');
    if (source === 'registry') resolve.mockRejectedValue(error);
    else if (source === 'host') retire.mockRejectedValue(error);
    else resolve.mockResolvedValueOnce(workspace).mockRejectedValueOnce(error);
    expect(await retireRegisteredWorkspace(context, input)).toEqual({ code: 'workspace_switch_unavailable', retryable: true });
  });
});
