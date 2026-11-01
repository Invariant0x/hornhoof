import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_LOG_BYTES, type NodeMessage, type ServerMessage, type TestError } from '@hornhoof/protocol';
import { ensurePasswd, prepareFolder, type JobUser } from './isolation.js';
import { stripEscapes } from './providers/process.js';
import { redact } from './redact.js';
import { gitEnv } from './workspace.js';

type TestRun = Extract<ServerMessage, { type: 'tests.run' }>;
export type TestsDone = Extract<NodeMessage, { type: 'tests.done' }>;

/* Programs asked to end at a stop or at the time limit get this long before they are killed. */
const KILL_AFTER_MS = 5_000;
/* How long one git command may take, within the run's own time. */
const GIT_TIMEOUT_MS = 5 * 60_000;
/* How long the output may keep coming after the command ended. */
const DRAIN_MS = 2_000;

type Options = {
  /* The node's data folder: each part runs in tests/<part> inside it. */
  dir: string;
  /* The test runs' own user on a node that runs as root, which reaches neither the node's keys nor the agents' folders. */
  user: JobUser | null;
  /* Values the log never shows, such as the node's key. */
  hidden: string[];
  signal?: AbortSignal;
  proc?: string;
};

/* What a command prints, at most TEST_LOG_BYTES of it: its first quarter and its end, where a runner sums up. */
class Output {
  private head: Buffer[] = [];
  private headSize = 0;
  private tail: Buffer[] = [];
  private tailSize = 0;
  private left = 0;
  private readonly headMax: number;
  private readonly tailMax: number;

  constructor(max = TEST_LOG_BYTES - 200) {
    this.headMax = Math.floor(max / 4);
    this.tailMax = max - this.headMax;
  }

  add(chunk: Buffer): void {
    if (this.headSize < this.headMax) {
      const take = chunk.subarray(0, this.headMax - this.headSize);
      this.head.push(take);
      this.headSize += take.length;
      chunk = chunk.subarray(take.length);
    }
    if (!chunk.length) return;
    this.tail.push(chunk);
    this.tailSize += chunk.length;
    while (this.tailSize > this.tailMax) {
      const first = this.tail[0]!;
      const over = this.tailSize - this.tailMax;
      const cut = Math.min(first.length, over);
      if (cut === first.length) this.tail.shift();
      else this.tail[0] = first.subarray(cut);
      this.tailSize -= cut;
      this.left += cut;
    }
  }

  line(text: string): void {
    this.add(Buffer.from(`${text}\n`));
  }

  text(): string {
    if (!this.left) return Buffer.concat([...this.head, ...this.tail]).toString('utf8');
    return `${Buffer.concat(this.head).toString('utf8')}\n[${this.left} bytes left out]\n${Buffer.concat(this.tail).toString('utf8')}`;
  }
}

type Ended = { code: number | null; signal: NodeJS.Signals | null; stopped: 'timeout' | 'cancelled' | null };

const killGroup = (pid: number | undefined, signal: NodeJS.Signals) => {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    /* Already gone. */
  }
};

/* Runs one program in a process group of its own, so a stop or the time limit ends everything it started. */
function runIn(bin: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; user: JobUser | null; deadline: number; signal?: AbortSignal; out: Output }): Promise<Ended> {
  return new Promise(resolve => {
    const child = spawn(bin, args, { cwd: o.cwd, env: o.env, uid: o.user?.uid, gid: o.user?.gid, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stopped: Ended['stopped'] = null;
    let hard: NodeJS.Timeout | undefined;
    const stop = (why: 'timeout' | 'cancelled') => {
      if (stopped) return;
      stopped = why;
      killGroup(child.pid, 'SIGTERM');
      hard = setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_AFTER_MS);
    };
    const timer = setTimeout(() => stop('timeout'), Math.max(0, o.deadline - Date.now()));
    const abort = () => stop('cancelled');
    if (o.signal?.aborted) abort();
    else o.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (c: Buffer) => o.out.add(c));
    child.stderr.on('data', (c: Buffer) => o.out.add(c));
    let ended: Ended | null = null;
    const finish = () => {
      if (!ended) return;
      clearTimeout(timer);
      clearTimeout(hard);
      o.signal?.removeEventListener('abort', abort);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(ended);
    };
    child.on('error', err => {
      o.out.line(err.message);
      ended = { code: null, signal: null, stopped };
      finish();
    });
    child.on('exit', (code, signal) => {
      /* What it left running in its group ends with it, so its pipes close. */
      killGroup(child.pid, 'SIGKILL');
      ended = { code, signal, stopped };
      const drained = setTimeout(finish, DRAIN_MS);
      child.on('close', () => {
        clearTimeout(drained);
        finish();
      });
    });
  });
}

/* Every program of the test runs' user that outlived its group: one part runs on a node at a time. */
function killUser(uid: number, proc: string): void {
  let pids: string[] = [];
  try {
    pids = readdirSync(proc).filter(p => /^\d+$/.test(p));
  } catch {
    return;
  }
  for (const pid of pids) {
    try {
      const status = readFileSync(join(proc, pid, 'status'), 'utf8');
      if (/^Uid:\s+(\d+)/m.exec(status)?.[1] === String(uid)) process.kill(Number(pid), 'SIGKILL');
    } catch {
      /* Gone meanwhile. */
    }
  }
}

function remove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* A folder the command made read-only. */
    execFileSync('chmod', ['-R', 'u+w', path], { stdio: 'ignore' });
    rmSync(path, { recursive: true, force: true });
  }
}

const within = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

/* The branch named after the task: task-<n> itself, or the only one that starts with task-<n>-. */
export function taskBranch(heads: string, task: number): { branch: string } | { problem: string } {
  const names = heads.split('\n').flatMap(line => /\trefs\/heads\/(\S+)$/.exec(line.trim())?.slice(1) ?? []);
  const own = `task-${task}`;
  if (names.includes(own)) return { branch: own };
  const mine = names.filter(n => n.startsWith(`${own}-`)).sort();
  if (mine.length === 1) return { branch: mine[0]! };
  if (mine.length) return { problem: `Several branches belong to task ${task}: ${mine.join(', ')}. Name the one to test.` };
  return { problem: `The repository has no branch ${own} or ${own}-... Push the task's branch, or name the branch to test.` };
}

/* One part of a test run, which always ends with a tests.done: the branch is cloned into a fresh folder, the command runs
   there within the time with a home and a temporary folder of its own, and the folder goes, whatever happened. */
export async function runTests(msg: TestRun, { dir, user, hidden, signal, proc = '/proc' }: Options): Promise<TestsDone> {
  const deadline = Date.now() + msg.timeoutMs;
  const root = join(dir, 'tests', msg.partId);
  const repo = join(root, 'repo');
  const out = new Output();
  let commit: string | null = null;
  let exitCode: number | null = null;
  let error: TestError | null = null;
  const stoppedBy = (ended: Ended): TestError | null => {
    if (ended.stopped === 'timeout') out.line(`The tests did not finish within ${within(msg.timeoutMs)}.`);
    if (ended.stopped === 'cancelled') out.line('Stopped.');
    return ended.stopped;
  };
  try {
    mkdirSync(join(dir, 'tests'), { recursive: true });
    remove(root);
    for (const sub of ['', 'home', 'tmp']) prepareFolder(join(root, sub), user);
    if (user) ensurePasswd(user, join(dir, 'tests'));
    const base = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), LANG: 'C.UTF-8' };
    /* Git reads no settings but its own here, and gets the token only through the helper, for the repository's host. */
    const git = (args: string[], cwd: string, into = out) =>
      runIn('git', args, { cwd, env: { ...base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...gitEnv(msg.repo) }, user, deadline: Math.min(deadline, Date.now() + GIT_TIMEOUT_MS), signal, out: into });

    let branch = msg.branch;
    if (!branch) {
      const heads = new Output();
      const listed = await git(['ls-remote', '--heads', '--', msg.repo.url], root, heads);
      error = stoppedBy(listed);
      if (!error && listed.code !== 0) {
        out.line(heads.text());
        error = 'clone_failed';
      }
      if (!error) {
        const found = taskBranch(heads.text(), msg.task);
        if ('problem' in found) {
          out.line(found.problem);
          error = 'clone_failed';
        } else branch = found.branch;
      }
    }
    if (!error && branch) {
      out.line(`$ git clone --branch ${branch} ${msg.repo.url}`);
      const cloned = await git(['clone', '--quiet', '--depth', '1', '--branch', branch, '--', msg.repo.url, repo], root);
      error = stoppedBy(cloned) ?? (cloned.code === 0 ? null : 'clone_failed');
    }
    if (!error) {
      const head = new Output();
      await git(['rev-parse', 'HEAD'], repo, head);
      commit = /^[0-9a-f]{40,64}$/.exec(head.text().trim())?.[0] ?? null;
      if (commit) out.line(`At ${commit}.`);
      out.line(`$ ${msg.command}`);
      const env = { ...base, CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0', HH_TEST_PART: String(msg.part), HH_TEST_PARTS: String(msg.parts) };
      const ran = await runIn('/bin/bash', ['-c', msg.command], { cwd: repo, env, user, deadline, signal, out });
      error = stoppedBy(ran);
      if (!error) {
        exitCode = ran.code;
        if (ran.signal) out.line(`The command was ended by ${ran.signal}.`);
        if (ran.code !== 0) error = 'failed';
      }
    }
  } catch (err) {
    out.line(err instanceof Error ? err.message : String(err));
    error ??= 'failed';
  } finally {
    if (user) killUser(user.uid, proc);
    try {
      remove(root);
    } catch (err) {
      out.line(`The run's folder could not be removed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const secrets = [...hidden, ...(msg.repo.token ? [msg.repo.token] : [])];
  return { type: 'tests.done', partId: msg.partId, ok: error === null && exitCode === 0, exitCode, error, commit, log: redact(stripEscapes(out.text()), secrets) };
}
