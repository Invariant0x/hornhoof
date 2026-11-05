import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { VerifiedWorkspace } from '@hornhoof/protocol';
import type { CheckpointInput } from '../src/task-checkpoint.js';

export const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
export const TASK_ID = id(434);
export const WIP_REF = `refs/heads/wip/task-${TASK_ID}`;

const GIT_ENV = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).trim();
}
export function gitInput(cwd: string, input: string | Buffer, ...args: string[]): string {
  return execFileSync('/usr/bin/git', args, { cwd, env: GIT_ENV, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 }).trim();
}

export interface Stand {
  root: string; remote: string; source: string; journal: string; baseSha: string;
  write(path: string, text: string | Buffer): void;
  commit(message: string): string;
  workspace(): VerifiedWorkspace;
  input(more?: Partial<CheckpointInput>): CheckpointInput;
  close(): void;
}

/* Local Git only: a bare remote standing for the product's repository, and a clone at a registered base. */
export function makeStand(): Stand {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hh-handoff-')));
  const remote = join(root, 'remote.git'), source = join(root, 'source'), journal = join(root, 'journal');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
  git(root, 'clone', '--quiet', remote, source);
  const write = (path: string, text: string | Buffer) => {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), text);
  };
  const commit = (message: string) => {
    git(source, 'add', '-A');
    git(source, 'commit', '--quiet', '--allow-empty', '-m', message);
    return git(source, 'rev-parse', 'HEAD');
  };
  write('src/keep.ts', 'export const keep = 1;\n');
  write('src/changed.ts', 'export const changed = 1;\n');
  write('src/gone.ts', 'export const gone = 1;\n');
  write('src/moved.ts', 'export const moved = 1;\n');
  const baseSha = commit('Base of the project');
  git(source, 'checkout', '--quiet', '-B', 'main');
  git(source, 'push', '--quiet', 'origin', 'main');
  git(source, 'checkout', '--quiet', '-b', 'task-1');
  const workspace = (): VerifiedWorkspace => ({
    binding: { workspaceId: id(1), taskId: TASK_ID, agentId: id(2), nodeId: { kind: 'builtin' }, assignmentEpoch: 3, bindingVersion: 1, repositoryId: id(3), taskBranch: 'task-1', baseSha },
    realPath: source, ownerUid: process.getuid!(), gitCommonDir: join(source, '.git'), sourceHeadSha: git(source, 'rev-parse', 'HEAD'),
  });
  const input = (more: Partial<CheckpointInput> = {}): CheckpointInput => ({
    handoffId: id(10), captureId: id(11), captureSequence: 1, taskId: TASK_ID, taskNumber: 434,
    resolveWorkspace: async () => workspace(), owner: { uid: process.getuid!(), gid: process.getgid!() },
    repo: { url: remote, token: '' }, journalRoot: journal, secrets: [],
    lastTests: 'npm test passed at some commit\n', conversationTail: 'the last words of the source\n', ...more,
  });
  return { root, remote, source, journal, baseSha, write, commit, workspace, input, close: () => rmSync(root, { recursive: true, force: true }) };
}

export interface WipObject { sha: string; type: string; body: string }
/* Everything a clone of the WIP branch receives, read with plain Git and nothing of the code under test. */
export function closure(remote: string, ref = WIP_REF): WipObject[] {
  return git(remote, 'rev-list', '--objects', ref).split('\n').map(line => {
    const sha = line.slice(0, 40), type = git(remote, 'cat-file', '-t', sha);
    return { sha, type, body: git(remote, 'cat-file', '-p', sha) };
  });
}
export const wipFile = (remote: string, path: string, ref = WIP_REF) => git(remote, 'cat-file', 'blob', `${ref}:${path}`);
export const wipPaths = (remote: string, ref = WIP_REF) => git(remote, 'ls-tree', '-r', '--name-only', ref).split('\n');
export interface ReadManifest {
  version: number; handoffId: string; captureId: string; captureSequence: number; taskId: string; taskNumber: number; epoch: number;
  baseSha: string; sourceHeadSha: string; previousCheckpointSha: string | null; sanitizerVersion: string; requiresRepair: boolean;
  files: { id: string; path: string; action: string; mode: string | null; contentSha256: string | null; status: string }[];
  context: { diffStat: string; lastTests: string; conversationTail: string };
}
export const wipManifest = (remote: string, ref = WIP_REF): ReadManifest => JSON.parse(wipFile(remote, 'meta/manifest.json', ref)) as ReadManifest;
