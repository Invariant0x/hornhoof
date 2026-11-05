import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHandoffRuntime } from '../src/handoff-runtime.js';
import { createTaskWorkspaceRegistry, type TaskWorkspaceBinding } from '../src/task-workspaces.js';

const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const nodeId = { kind: 'node' as const, nodeId: id(1) };
const owner = { uid: process.getuid!(), gid: process.getgid!() };
const realUid = owner.uid;
const nodeOwner = { uid: 0, gid: 0 };

/* Git and the files stay real. Only the registry's own folder is modeled as the root node's, as the registry refuses a node sharing its agents' user. */
const played = vi.hoisted(() => ({ root: null as string | null }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const owned = (path: string) => played.root !== null && (path === played.root || path.startsWith(`${played.root}/task-workspace-registry`));
  const asRoot = <T extends { uid: number; gid: number } | undefined>(value: T, path: string): T => (value && owned(path) ? Object.assign(value, { uid: 0, gid: 0 }) : value);
  return { ...fs,
    lstatSync: new Proxy(fs.lstatSync, { apply: (target, receiver, args) => asRoot(Reflect.apply(target, receiver, args) as ReturnType<typeof fs.statSync>, String(args[0])) }),
    fstatSync: new Proxy(fs.fstatSync, { apply: (target, receiver, args) => asRoot(Reflect.apply(target, receiver, args) as ReturnType<typeof fs.statSync>, fs.readlinkSync(`/proc/self/fd/${String(args[0])}`)) }),
  };
});

let root: string;
function git(cwd: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' },
  }).trim();
}
const asNode = async <T>(work: () => Promise<T>): Promise<T> => {
  const spy = vi.spyOn(process, 'getuid').mockReturnValue(nodeOwner.uid);
  try { return await work(); } finally { spy.mockRestore(); }
};
const REPOSITORY = 'https://example.test/one/app.git';

/* The layout the node makes: an agent's clone of the repository and a linked tree for one task. */
function clone(remote: string, agent: number, workspace: number, epoch: number): TaskWorkspaceBinding & { tree: string } {
  const agentId = id(agent), repositoryId = id(20), workspaceId = id(workspace), taskId = id(40);
  const source = join(root, 'work', 'agents', agentId, 'repositories', repositoryId, 'app'), context = join(root, 'work', 'agents', agentId, 'task-workspaces', workspaceId), tree = join(context, 'app');
  mkdirSync(join(source, '..'), { recursive: true });
  mkdirSync(context, { recursive: true });
  git(root, 'clone', '--quiet', '--branch', 'main', remote, source);
  git(source, 'remote', 'set-url', 'origin', REPOSITORY);
  const baseSha = git(source, 'rev-parse', 'HEAD');
  const taskBranch = `task-${taskId}-${agent}`;
  git(source, 'worktree', 'add', '--quiet', '-b', taskBranch, tree, baseSha);
  return { workspaceId, taskId, agentId, nodeId, assignmentEpoch: epoch, bindingVersion: 1, repositoryId, taskBranch, baseSha, tree };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hh-handoff-stitch-')));
  played.root = root;
});
afterEach(() => {
  played.root = null;
  rmSync(root, { recursive: true, force: true });
});

describe('the checkpoint on the real workspace registry', () => {
  it('goes from a registered linked tree to another registered tree through real resolves and real Git', async () => {
    const remote = join(root, 'remote.git'), seed = join(root, 'seed');
    git(root, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
    git(root, 'clone', '--quiet', remote, seed);
    mkdirSync(join(seed, 'src'));
    writeFileSync(join(seed, 'src/app.ts'), 'export const app = 1;\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '--quiet', '-m', 'Base');
    git(seed, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');

    const registry = await asNode(async () => createTaskWorkspaceRegistry({ nodeDataDir: root, nodeId, nodeOwner }));
    const { tree: sourceTree, ...sourceBinding } = clone(remote, 10, 30, 3);
    const { tree: targetTree, ...targetBinding } = clone(remote, 11, 31, 4);
    for (const binding of [sourceBinding, targetBinding]) {
      expect(await asNode(() => registry.registerTaskWorkspace({ binding, repositoryUrl: REPOSITORY, owner }))).toMatchObject({ binding, ownerUid: realUid });
    }
    writeFileSync(join(sourceTree, 'src/app.ts'), 'export const app = 2;\n');
    writeFileSync(join(sourceTree, 'src/new.ts'), 'export const fresh = 1;\n');

    const resolveTaskWorkspace = (binding: TaskWorkspaceBinding) => asNode(() => registry.resolveTaskWorkspace(binding));
    const repo = { url: remote, token: '' }, journalRoot = join(root, 'journal');
    const runtime = createHandoffRuntime({ resolveTaskWorkspace, journalRoot });
    runtime.registerHandoffSource({ jobId: id(100), workspaceId: sourceBinding.workspaceId, assignmentEpoch: 3, programInstanceId: id(101), knownSecrets: [],
      readTaskRecords: async () => 'records\n', readLastTest: async () => null, quiesceEndedTurn: async () => true });
    const saved = await runtime.captureHandoff({ handoffId: id(50), captureId: id(51), captureSequence: 1, taskNumber: 434, fromJobId: id(100), binding: sourceBinding, owner, repo });
    if (!saved.ok) throw new Error(`Capture refused: ${JSON.stringify(saved.problem)}`);
    expect(saved.receipt).toMatchObject({ baseSha: sourceBinding.baseSha, requiresRepair: false, omittedFiles: 0, quiescent: true });

    const restored = await runtime.restoreHandoff({ binding: targetBinding, baseSha: saved.receipt.baseSha, checkpointSha: saved.receipt.checkpointSha, contentDigest: saved.receipt.contentDigest, owner, repo, secrets: [] });
    if (!restored.ok) throw new Error(`Restore refused: ${JSON.stringify(restored.problem)}`);
    expect(restored.receipt).toMatchObject({ epoch: 4, readyForPrompt: true, contextDir: join(targetTree, '..', 'handoff', id(51)) });
    expect(readFileSync(join(targetTree, 'src/app.ts'), 'utf8')).toBe('export const app = 2;\n');
    expect(readFileSync(join(targetTree, 'src/new.ts'), 'utf8')).toBe('export const fresh = 1;\n');
    expect(await asNode(() => registry.resolveTaskWorkspace(targetBinding))).toMatchObject({ sourceHeadSha: targetBinding.baseSha });
    expect(git(targetTree, 'status', '--porcelain').split('\n').map(line => line.trim())).toEqual(['M src/app.ts', '?? src/new.ts']);
  });
});
