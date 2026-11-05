import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';
import type { JobUser } from './isolation.js';
import type { WorkspaceProblem } from './task-workspaces.js';

export class WorkspaceFault extends Error {
  constructor(readonly code: WorkspaceProblem['code']) { super(code); }
}

export function repositoryIdentity(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new WorkspaceFault('wrong_repository'); }
  if (url.protocol !== 'https:' || url.search || url.hash) throw new WorkspaceFault('wrong_repository');
  url.username = ''; url.password = '';
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '');
  return url.href;
}

const readFile = promisify(execFile);
const READ_OPTIONS = ['--no-optional-locks', '--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'protocol.allow=never', '-c', 'credential.helper='];

/* No inherited Git configuration or repository program is executed by these identity reads. */
async function gitRead(cwd: string, owner: JobUser, args: string[], failure: WorkspaceProblem['code']): Promise<string> {
  try {
    const result = await readFile('/usr/bin/git', [...READ_OPTIONS, ...args], {
      cwd, uid: owner.uid, gid: owner.gid, timeout: 30_000, maxBuffer: 64 * 1024,
      env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
        GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: '/dev/null' },
    });
    return result.stdout.trim();
  } catch { throw new WorkspaceFault(failure); }
}

export interface WorkspaceGitIdentityInput {
  sourcePath: string; realPath: string; gitCommonDir: string;
  repositoryUrl: string; taskBranch: string; baseSha: string; owner: JobUser;
}

export async function inspectWorkspaceGit(input: WorkspaceGitIdentityInput): Promise<string> {
  const read = (cwd: string, args: string[], code: WorkspaceProblem['code'] = 'wrong_repository') => gitRead(cwd, input.owner, args, code);
  const origin = await read(input.sourcePath, ['config', '--no-includes', '--local', '--get', 'remote.origin.url']);
  if (repositoryIdentity(origin) !== input.repositoryUrl) throw new WorkspaceFault('wrong_repository');
  const common = await read(input.realPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!isAbsolute(common) || common !== input.gitCommonDir) throw new WorkspaceFault('wrong_repository');
  const top = await read(input.realPath, ['rev-parse', '--show-toplevel']);
  if (top !== input.realPath) throw new WorkspaceFault('workspace_ambiguous');
  const branch = await read(input.realPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 'wrong_branch');
  if (branch !== input.taskBranch) throw new WorkspaceFault('wrong_branch');
  const head = await read(input.realPath, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!/^[0-9a-f]{40}$/.test(head)) throw new WorkspaceFault('wrong_repository');
  await read(input.realPath, ['merge-base', '--is-ancestor', input.baseSha, head], 'base_unavailable');
  return head;
}
