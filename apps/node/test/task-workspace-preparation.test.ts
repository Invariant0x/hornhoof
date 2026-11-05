import { describe, expect, it, vi } from 'vitest';
import type { TaskWorkspaceBinding, TaskWorkspaceSpec, VerifiedWorkspace, WorkspaceProblem } from '@hornhoof/protocol';
import { prepareTaskWorkspace, type TaskWorkspacePreparationContext, type TaskWorkspacePreparationInput, type TaskWorkspaceRegistration } from '../src/task-workspaces.js';

/* Admission and registry doubles isolate this gate. Actual A authority is not implemented by these tests. */
function fixture() {
  const binding: TaskWorkspaceBinding = { workspaceId: '00000000-0000-4000-8000-000000000001',
    taskId: '00000000-0000-4000-8000-000000000002', agentId: '00000000-0000-4000-8000-000000000003',
    nodeId: { kind: 'builtin' }, assignmentEpoch: 0, bindingVersion: 1,
    repositoryId: '00000000-0000-4000-8000-000000000004', taskBranch: 'task-00000000-0000-4000-8000-000000000002', baseSha: 'a'.repeat(40) };
  const input: TaskWorkspacePreparationInput = { jobId: '00000000-0000-4000-8000-000000000005', binding,
    repo: { url: 'https://example.test/team/app.git', branch: 'main', token: 'fixture-only-token' }, owner: { uid: 20000, gid: 20000 } };
  const spec: TaskWorkspaceSpec = { version: 1, binding: structuredClone(binding), baseRef: 'turn-8',
    areas: ['apps/node'], requiredIntegrations: [{ kind: 'turn', ref: 'turn-8' }, { kind: 'main', ref: 'main' }] };
  const workspace: VerifiedWorkspace = { binding: structuredClone(binding), realPath: '/fixture/task/app', ownerUid: 20000,
    gitCommonDir: '/fixture/source/app/.git', sourceHeadSha: 'b'.repeat(40) };
  const admit = vi.fn<NonNullable<TaskWorkspacePreparationContext['resolveAdmittedWorkspace']>>().mockResolvedValue(spec);
  const register = vi.fn<(input: unknown) => Promise<VerifiedWorkspace | WorkspaceProblem>>().mockResolvedValue(workspace);
  const resolve = vi.fn<(binding: TaskWorkspaceBinding) => Promise<VerifiedWorkspace | WorkspaceProblem>>().mockResolvedValue(workspace);
  const controller = new AbortController();
  const context: TaskWorkspacePreparationContext = { signal: controller.signal,
    resolveAdmittedWorkspace: admit, registry: { registerTaskWorkspace: register, resolveTaskWorkspace: resolve } };
  return { input, spec, workspace, admit, register, resolve, controller, context };
}

describe('admission-first retained workspace preparation, unit provenance', () => {
  it('fails closed without an admitted source before touching registry or Git', async () => {
    const { input, context, register, resolve } = fixture(); delete context.resolveAdmittedWorkspace;
    expect(await prepareTaskWorkspace(input, context)).toEqual({ code: 'integration_plan_missing', retryable: true });
    expect(register).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
  });

  it('uses only the admitted exact job/binding and token-free trusted registration', async () => {
    const { input, context, admit, register, workspace } = fixture();
    expect(await prepareTaskWorkspace(input, context)).toEqual(workspace);
    expect(admit).toHaveBeenCalledExactlyOnceWith({ jobId: input.jobId, binding: input.binding });
    expect(register).toHaveBeenCalledExactlyOnceWith({ binding: input.binding,
      repositoryUrl: 'https://example.test/team/app', owner: { uid: 20000, gid: 20000 } });
    expect(admit.mock.invocationCallOrder[0]).toBeLessThan(register.mock.invocationCallOrder[0]!);
  });

  it.each([
    { code: 'area_conflict', retryable: true }, { code: 'author_wip_limit', retryable: true },
    { code: 'turn_health_unknown', retryable: true }, { code: 'binding_stale', retryable: false },
    { code: 'node_offline', retryable: true },
  ] satisfies WorkspaceProblem[])('preserves an actual domain refusal instead of inventing a missing plan (%#)', async refusal => {
    const { input, context, admit, register } = fixture(); admit.mockResolvedValue(refusal);
    expect(await prepareTaskWorkspace(input, context)).toEqual(refusal);
    expect(register).not.toHaveBeenCalled();
  });

  it.each([null, undefined])('refuses a missing registered plan (%#)', async absent => {
    const { input, context, admit, register } = fixture(); admit.mockResolvedValue(absent as unknown as TaskWorkspaceSpec);
    expect(await prepareTaskWorkspace(input, context)).toEqual({ code: 'integration_plan_missing', retryable: true });
    expect(register).not.toHaveBeenCalled();
  });

  it.each([
    { workspaceId: '00000000-0000-4000-8000-000000000099' }, { taskId: '00000000-0000-4000-8000-000000000099' },
    { agentId: '00000000-0000-4000-8000-000000000099' }, { nodeId: { kind: 'node', nodeId: '00000000-0000-4000-8000-000000000099' } },
    { assignmentEpoch: 1 }, { bindingVersion: 2 }, { repositoryId: '00000000-0000-4000-8000-000000000099' },
    { taskBranch: 'task-other' }, { baseSha: 'c'.repeat(40) },
  ] satisfies Partial<TaskWorkspaceBinding>[])('rejects any admitted binding mismatch before side effects (%#)', async changed => {
    const { input, context, admit, register, spec } = fixture();
    admit.mockResolvedValue({ ...spec, binding: { ...spec.binding, ...changed } });
    expect(await prepareTaskWorkspace(input, context)).toEqual({ code: 'binding_stale', retryable: false });
    expect(register).not.toHaveBeenCalled();
  });

  it.each([
    { version: 2 }, { areas: [] }, { areas: ['../other'] }, { requiredIntegrations: [] },
    { baseRef: 'main~1' }, { unexpected: 'private data' }, { code: 'unknown', retryable: true },
  ])('rejects noncanonical admitted data before side effects (%#)', async changed => {
    const { input, context, admit, register, spec } = fixture();
    admit.mockResolvedValue({ ...spec, ...changed } as unknown as TaskWorkspaceSpec);
    expect(await prepareTaskWorkspace(input, context)).toEqual({ code: 'binding_stale', retryable: false });
    expect(register).not.toHaveBeenCalled();
  });

  it.each(['binding', 'job'] as const)('rejects invalid %s before calling admission', async source => {
    const { input, context, admit, register } = fixture();
    if (source === 'binding') Object.assign(input.binding, { spec: 'not binding' }); else input.jobId = '../not-a-job';
    expect(await prepareTaskWorkspace(input, context)).toEqual({ code: 'binding_stale', retryable: false });
    expect(admit).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled();
  });

  it('rejects invalid local owner configuration before admission or Git', async () => {
    const { input, context, admit, register } = fixture(); input.owner.uid = 0;
    expect(await prepareTaskWorkspace(input, context)).toEqual({ code: 'wrong_owner', retryable: false });
    expect(admit).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled();
  });

  it('rejects invalid repository identity without exposing it', async () => {
    const { input, context, register } = fixture(); input.repo.url = 'file:///private/source';
    expect(await prepareTaskWorkspace(input, context)).toEqual({ code: 'wrong_repository', retryable: false });
    expect(register).not.toHaveBeenCalled();
  });

  it('does not attach authority to caller objects mutated while admission awaits', async () => {
    const { input, context, admit, register, spec, workspace } = fixture();
    admit.mockImplementation(async query => {
      query.binding.bindingVersion = 2; input.binding.bindingVersion = 3;
      input.repo.url = 'https://example.test/wrong/app'; input.owner.uid = 20001;
      return spec;
    });
    expect(await prepareTaskWorkspace(input, context)).toEqual(workspace);
    const registration = register.mock.calls[0]![0] as TaskWorkspaceRegistration;
    expect(registration.binding.bindingVersion).toBe(1); expect(registration.owner).toEqual({ uid: 20000, gid: 20000 });
    expect(registration.repositoryUrl).toBe('https://example.test/team/app');
  });

  it.each([
    { code: 'workspace_missing', retryable: false }, { code: 'wrong_repository', retryable: false }, { code: 'writer_active', retryable: true },
  ] satisfies WorkspaceProblem[])('preserves a registry refusal and retains the existing state (%#)', async refusal => {
    const { input, context, register } = fixture(); register.mockResolvedValue(refusal);
    expect(await prepareTaskWorkspace(input, context)).toEqual(refusal);
  });

  it('rejects a registered result that changed binding generation', async () => {
    const { input, context, register, workspace } = fixture();
    register.mockResolvedValue({ ...workspace, binding: { ...workspace.binding, assignmentEpoch: 2 } });
    expect(await prepareTaskWorkspace(input, context)).toEqual({ code: 'binding_stale', retryable: false });
  });

  it('rejects a registered result with a different owner', async () => {
    const { input, context, register, workspace } = fixture(); register.mockResolvedValue({ ...workspace, ownerUid: 20001 });
    expect(await prepareTaskWorkspace(input, context)).toEqual({ code: 'wrong_owner', retryable: false });
  });

  it('rejects an already aborted call without starting a dependency', async () => {
    const { input, context, controller, admit, register } = fixture(), reason = new Error('cancel fixture'); controller.abort(reason);
    await expect(prepareTaskWorkspace(input, context)).rejects.toBe(reason);
    expect(admit).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled();
  });

  it.each(['admission', 'registry'] as const)('waits for %s settlement then rejects cancellation with the original reason', async boundary => {
    const { input, context, controller, admit, register, spec, workspace } = fixture();
    let entered!: () => void, finish!: () => void, settled = false, finished = false;
    const called = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
    const pause = async () => { entered(); await gate; settled = true; };
    if (boundary === 'admission') admit.mockImplementation(async () => { await pause(); return spec; });
    else register.mockImplementation(async () => { await pause(); return workspace; });
    const pending = prepareTaskWorkspace(input, context);
    await Promise.race([called, pending.then(() => { throw new Error('The dependency boundary was never reached.'); })]);
    void pending.then(() => { finished = true; }, () => { finished = true; });
    const reason = new Error('cancel fixture'); controller.abort(reason); await Promise.resolve();
    expect(finished).toBe(false); expect(settled).toBe(false); finish();
    await expect(pending).rejects.toBe(reason); expect(settled).toBe(true);
    if (boundary === 'admission') expect(register).not.toHaveBeenCalled();
  });

  it.each(['admission', 'registry'] as const)('sanitizes unexpected %s failures without inventing authority', async boundary => {
    const { input, context, admit, register } = fixture(), failure = new Error('private diagnostic');
    if (boundary === 'admission') admit.mockRejectedValue(failure); else register.mockRejectedValue(failure);
    expect(await prepareTaskWorkspace(input, context)).toEqual({ code: 'workspace_switch_unavailable', retryable: true });
  });
});
