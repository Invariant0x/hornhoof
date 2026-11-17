import { join } from 'node:path';
import { repoFolder, type AuthorCheckDone, type AuthorCheckRequest } from '@hornhoof/protocol';
import type { ProgramServerMessage } from '@hornhoof/protocol/program-operator';
import { userFor, type JobUser } from './isolation.js';
import { authorCheckoutRefusal, runAuthorCheck, type AuthorCheckPorts, type AuthorCheckout } from './author-check.js';
import { currentCheckLease, withCheckSlot } from './check-queue.js';
import { runProgram } from './providers/process.js';

export type AuthorCommand = (program: string, args: string[], options: { cwd: string; user: JobUser | null; env: NodeJS.ProcessEnv; signal?: AbortSignal }) => Promise<{ exitCode: number | null; output: string }>;
type Options = { dir: string; home: string; user: JobUser | null; signal?: AbortSignal };

const command: AuthorCommand = async (program, args, options) => {
  if ((options.user?.uid ?? process.getuid?.()) === 0) throw new Error('Author checks require an agent user.');
  /* The shell changes directory after dropping privileges; no agent command or environment enters it. */
  const result = await runProgram({ bin: '/bin/bash', args: ['-c', 'cd -- "$1" || exit; shift; exec "$@"', 'author-check', options.cwd, program, ...args],
    env: options.env, user: options.user, signal: options.signal, timeoutMs: 30 * 60_000 });
  return { exitCode: result.timedOut ? null : result.code, output: result.output };
};

type Run = (program: string, args: string[], cwd: string, cleanup?: boolean) => ReturnType<AuthorCommand>;

async function inspectCheckout(run: Run, cwd: string, request: AuthorCheckRequest): Promise<AuthorCheckout> {
  const git = async (args: string[]) => {
    const result = await run('/usr/bin/git', args, cwd);
    if (result.exitCode !== 0) throw new Error('The author checkout cannot be read.');
    return result.output.trim();
  };
  if (await git(['rev-parse', '--show-toplevel']) !== cwd) throw new Error('The repository path is not canonical.');
  const repoUrl = await git(['remote', 'get-url', 'origin']);
  const commit = await git(['rev-parse', 'HEAD']);
  const clean = (await git(['status', '--porcelain=v1', '--untracked-files=normal'])) === '';
  const ancestor = await run('/usr/bin/git', ['merge-base', '--is-ancestor', request.baseCommit, request.commit], cwd);
  return { repoUrl, commit, clean, baseCommit: ancestor.exitCode === 0 ? request.baseCommit : null };
}

type ExecutorOptions = { dir: string; builtin: unknown; terminal?: { user?: JobUser | null }; credUser: JobUser | null; home: string; emit(result: AuthorCheckDone): void };

function executionOwner(options: ExecutorOptions, request: AuthorCheckRequest): Pick<Options, 'user' | 'home'> {
  if (options.builtin) return { user: userFor(options.dir, `agent:${request.agentId}`), home: join(options.dir, 'agents', request.agentId) };
  return { user: options.terminal?.user ?? options.credUser, home: options.home };
}

/* Runs independently of the socket handler, so queued checks can still receive their lease replies. */
export class AuthorCheckExecutor {
  private readonly active = new Map<string, { stop: AbortController; jobId: string }>();
  private readonly completed = new Set<string>();
  constructor(private readonly options: ExecutorOptions) {}

  consume(message: ProgramServerMessage): message is AuthorCheckRequest {
    if (message.type !== 'author_check.run') return false;
    if (this.active.has(message.requestId) || this.completed.has(message.requestId)) return true;
    const stop = new AbortController();
    this.active.set(message.requestId, { stop, jobId: message.jobId });
    const startedAt = new Date().toISOString();
    void withCheckSlot(signal => runAuthorCheck(message, createAuthorCheckPorts(message, { dir: this.options.dir, ...executionOwner(this.options, message), signal })),
      { signal: stop.signal, agentId: message.agentId, jobId: message.jobId, label: 'check:author' })
      .then(result => this.options.emit(result)).catch(() => this.options.emit({ ...message, type: 'author_check.done', exitCode: null, crap: { kind: 'unknown' }, reason: 'unavailable', startedAt, finishedAt: new Date().toISOString() }))
      .finally(() => { this.active.delete(message.requestId); this.completed.add(message.requestId); });
    return true;
  }

  stop(jobId?: string): void {
    for (const check of this.active.values()) if (!jobId || check.jobId === jobId) check.stop.abort();
  }
}

export function createAuthorCheckPorts(request: AuthorCheckRequest, options: Options, invoke: AuthorCommand = command): AuthorCheckPorts {
  const root = join(options.dir, 'work', 'agents', request.agentId);
  const source = join(root, repoFolder(request.repoUrl)), checked = join(root, `author-check-${request.requestId}`);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: options.home, GIT_TERMINAL_PROMPT: '0',
    ...(currentCheckLease() ? { HH_CHECK_SLOT: currentCheckLease() } : {}) };
  const run: Run = (program, args, cwd, cleanup) => invoke(program, args, { cwd, env, user: options.user, signal: cleanup ? undefined : options.signal });
  let created = false;
  return {
    inspect: place => inspectCheckout(run, place === 'source' ? source : checked, request),
    execute: async () => {
      const added = await run('/usr/bin/git', ['worktree', 'add', '--detach', '--', checked, request.commit], source);
      if (added.exitCode !== 0) throw new Error('The pinned worktree could not be created.');
      created = true;
      if (authorCheckoutRefusal(await inspectCheckout(run, checked, request), request)) throw new Error('The pinned worktree does not match.');
      return run(process.execPath, ['scripts/author-check.mjs', '--sha', request.commit, '--base', request.baseCommit], checked);
    },
    finish: async () => {
      if (created) await run('/usr/bin/git', ['worktree', 'remove', '--force', '--', checked], source, true);
    }, now: () => new Date(),
  };
}
