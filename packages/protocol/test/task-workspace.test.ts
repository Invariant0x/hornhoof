import { describe, expect, it } from 'vitest';
import * as protocol from '../src/index.js';

const taskId = '00000000-0000-4000-8000-000000000002';
const binding = {
  workspaceId: '00000000-0000-4000-8000-000000000001', taskId,
  agentId: '00000000-0000-4000-8000-000000000003', nodeId: { kind: 'builtin' },
  assignmentEpoch: 0, bindingVersion: 1, repositoryId: '00000000-0000-4000-8000-000000000004',
  taskBranch: `task-${taskId}`, baseSha: 'a'.repeat(40),
};
const spec = { version: 1, binding, baseRef: 'turn-8', areas: ['apps/node'], requiredIntegrations: [{ kind: 'turn', ref: 'turn-8' }] };

describe('the canonical task workspace binding', () => {
  it('accepts the frozen nine fields without spec metadata', () => {
    expect(protocol.TaskWorkspaceBinding.parse(binding)).toEqual(binding);
  });
  it('accepts a node identity as a separate tagged variant', () => {
    const value = { ...binding, nodeId: { kind: 'node', nodeId: '00000000-0000-4000-8000-000000000005' } };
    expect(protocol.TaskWorkspaceBinding.parse(value)).toEqual(value);
  });
  it.each(Object.keys(binding))('refuses a missing %s', key => {
    const value: Record<string, unknown> = { ...binding }; delete value[key];
    expect(protocol.TaskWorkspaceBinding.safeParse(value).success).toBe(false);
  });
  it.each([
    { version: 1 }, { areas: ['.'] }, { baseRef: 'main' }, { token: 'example' }, { cwd: '/work' },
    { taskId: '12' }, { workspaceId: 'not-a-uuid' }, { repositoryId: '' }, { agentId: null },
    { nodeId: { kind: 'builtin', nodeId: binding.agentId } }, { nodeId: { kind: 'node' } },
    { nodeId: { kind: 'node', nodeId: 'builtin' } }, { nodeId: { kind: 'external', nodeId: binding.agentId } },
    { assignmentEpoch: -1 }, { assignmentEpoch: 1.5 }, { bindingVersion: 0 },
    { baseSha: 'a'.repeat(64) }, { baseSha: 'A'.repeat(40) }, { baseSha: 'a'.repeat(39) },
    { taskBranch: '' }, { taskBranch: '../main' }, { taskBranch: 'task-x\nmain' }, { taskBranch: 'task-x.lock' },
  ])('refuses an invalid or extended binding %j', fields => {
    expect(protocol.TaskWorkspaceBinding.safeParse({ ...binding, ...fields }).success).toBe(false);
  });
});

describe('the separate task workspace spec', () => {
  it('accepts a turn plan with repository-relative prefix claims', () => {
    expect(protocol.TaskWorkspaceSpec.parse(spec)).toEqual(spec);
  });
  it('carries both main and turn targets for the separately authorized emergency lane', () => {
    const value = { ...spec, areas: ['.'], requiredIntegrations: [{ kind: 'main', ref: 'main' }, { kind: 'turn', ref: 'turn-8' }] };
    expect(protocol.TaskWorkspaceSpec.parse(value)).toEqual(value);
  });
  it.each([
    { version: 2 }, { requiredIntegrations: [] }, { requiredIntegrations: null },
    { requiredIntegrations: [{ kind: 'turn', branch: 'turn-8' }] },
    { requiredIntegrations: [{ kind: 'release', ref: 'main' }] },
    { requiredIntegrations: [{ kind: 'turn', ref: 'turn-8', receipt: true }] },
    { areas: [] }, { cwd: '/work' }, { binding: { ...binding, version: 1 } },
  ])('refuses missing policy or an alternate wire %j', fields => {
    expect(protocol.TaskWorkspaceSpec.safeParse({ ...spec, ...fields }).success).toBe(false);
  });
  it.each(['/tmp', '../a', 'a/../b', 'a//b', 'a/', './a', 'a\\b', 'C:/work', 'a\u0000b', 'a\u007fb', 'apps/**', 'apps/?', 'apps/[ab]', ''])('refuses unsafe or glob area %j', area => {
    expect(protocol.TaskWorkspaceSpec.safeParse({ ...spec, areas: [area] }).success).toBe(false);
  });
  it.each(['.', 'apps/node', 'packages/protocol/src/index.ts', 'src/café'])('accepts literal repository area %j', area => {
    expect(protocol.RepoRelativeArea.parse(area)).toBe(area);
  });
});

describe('safe workspace problems', () => {
  it('carries a closed code and retry policy without raw diagnostics', () => {
    expect(protocol.WorkspaceProblem.parse({ code: 'workspace_switch_unavailable', retryable: true }))
      .toEqual({ code: 'workspace_switch_unavailable', retryable: true });
  });
  it.each([{ code: 'anything', retryable: false }, { code: 'writer_active' }, { code: 'writer_active', retryable: true, path: '/private' }])('refuses %j', value => {
    expect(protocol.WorkspaceProblem.safeParse(value).success).toBe(false);
  });
});
