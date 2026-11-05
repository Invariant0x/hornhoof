import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { inspectWorkspaceGit, type WorkspaceGitIdentityInput } from '../src/task-workspace-git.js';

let root: string, input: WorkspaceGitIdentityInput;
function git(cwd: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', env: {
    PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  } }).trim();
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hh-workspace-git-'));
  const sourcePath = join(root, 'source'), realPath = join(root, 'tree'); mkdirSync(sourcePath);
  git(sourcePath, 'init', '--quiet', '-b', 'main');
  git(sourcePath, 'config', 'user.name', 'Fixture'); git(sourcePath, 'config', 'user.email', 'fixture@example.test');
  writeFileSync(join(sourcePath, 'file'), 'fixture bytes'); git(sourcePath, 'add', 'file'); git(sourcePath, 'commit', '--quiet', '-m', 'Initial');
  git(sourcePath, 'remote', 'add', 'origin', 'https://example.test/fixture');
  const baseSha = git(sourcePath, 'rev-parse', 'HEAD');
  git(sourcePath, 'worktree', 'add', '--quiet', '-b', 'task-fixture', realPath, baseSha);
  input = { sourcePath, realPath, gitCommonDir: join(sourcePath, '.git'), repositoryUrl: 'https://example.test/fixture', taskBranch: 'task-fixture', baseSha,
    owner: { uid: process.getuid!(), gid: process.getgid!() } };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('refuses a missing commit without fetching or writing objects from a local promisor', async () => {
  const upstream = join(root, 'upstream.git'); git(root, 'clone', '--quiet', '--bare', input.sourcePath, upstream);
  git(input.sourcePath, 'remote', 'add', 'fixture-cache', upstream);
  git(input.sourcePath, 'config', 'remote.fixture-cache.promisor', 'true');
  const object = join(input.gitCommonDir, 'objects', input.baseSha.slice(0, 2), input.baseSha.slice(2));
  renameSync(object, join(root, 'preserved-object'));
  const before = readdirSync(join(input.gitCommonDir, 'objects'), { recursive: true }).sort();
  await expect(inspectWorkspaceGit(input)).rejects.toMatchObject({ code: 'wrong_repository' });
  expect(existsSync(object)).toBe(false);
  expect(readdirSync(join(input.gitCommonDir, 'objects'), { recursive: true }).sort()).toEqual(before);
});

it.each(['replace', 'graft'])('uses actual commit ancestry rather than local %s history', async mode => {
  const tree = git(input.sourcePath, 'rev-parse', 'HEAD^{tree}');
  const unrelated = git(input.sourcePath, 'commit-tree', tree, '-m', 'Unrelated root');
  git(input.sourcePath, 'update-ref', 'refs/heads/task-fixture', unrelated);
  if (mode === 'replace') git(input.sourcePath, 'replace', '--graft', unrelated, input.baseSha);
  else writeFileSync(join(input.gitCommonDir, 'info', 'grafts'), `${unrelated} ${input.baseSha}\n`);
  await expect(inspectWorkspaceGit(input)).rejects.toMatchObject({ code: 'base_unavailable' });
  expect(git(input.realPath, 'rev-parse', 'HEAD')).toBe(unrelated);
});
