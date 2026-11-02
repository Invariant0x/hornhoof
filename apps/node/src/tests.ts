import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, chownSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { MAX_RUN_FILES, RUN_FILE_BYTES, TEST_LOG_BYTES, type NodeMessage, type ServerMessage, type TestError } from '@hornhoof/protocol';
import { ensurePasswd, FIRST_UID, prepareFolder, type JobUser } from './isolation.js';
import { stripEscapes } from './providers/process.js';
import { redact } from './redact.js';
import { gitEnv } from './workspace.js';

type TestRun = Extract<ServerMessage, { type: 'tests.run' }>;
export type TestsDone = Extract<NodeMessage, { type: 'tests.done' }>;

/* Programs asked to end at a stop or at the time limit get this long before they are killed. */
const KILL_AFTER_MS = 5_000;
/* How long one git command may take, within the run's own time. */
const GIT_TIMEOUT_MS = 5 * 60_000;
/* What a part of work made may still go on the task this long after its time is up: Hornhoof waits two minutes past it
   for the part's end. */
const PUT_GRACE_MS = 60_000;
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
  cpus?: number;
  env?: NodeJS.ProcessEnv;
  /* The task's files of a part of work, in and out. */
  files?: PartFiles;
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
/* Where every user may write, so what a part leaves there outlives its folder. */
const SHARED = ['/tmp', '/var/tmp', '/dev/shm'];

/* Removes what a user left in these folders and in the folders inside them every user may write to, so the next part,
   of whatever department, finds none of it. A link goes, never what it points to. */
export function clearShared(uid: number, places: string[]): void {
  const sweep = (folder: string) => {
    let names: string[] = [];
    try {
      names = readdirSync(folder);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(folder, name);
      try {
        const st = lstatSync(path);
        if (st.uid === uid) rmSync(path, { recursive: true, force: true });
        else if (st.isDirectory() && (st.mode & 0o002) !== 0) sweep(path);
      } catch {
        /* Gone meanwhile. */
      }
    }
  };
  for (const place of places) sweep(place);
}

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

/* The task's files a part of work takes in, through Hornhoof with the node's key, and the files it puts on the task. */
/* signal: gives up on the request, and on its body, when the part is stopped or its time is up. */
export type PartFiles = {
  get(partId: string, name: string, signal?: AbortSignal): Promise<Buffer>;
  put(partId: string, name: string, bytes: Buffer, signal?: AbortSignal): Promise<void>;
};

/* A part's files through Hornhoof, with the node's key: Hornhoof hands out only the task files the part names, and only
   to the node that runs it. */
export function partFiles(server: string, key: string): PartFiles {
  const at = (partId: string, name: string) => `${server}/api/parts/${encodeURIComponent(partId)}/files/${encodeURIComponent(name)}`;
  const headers = { authorization: `Bearer ${key}` };
  const refused = async (res: Response) => {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    return new Error(`Hornhoof answered ${res.status}${body?.error?.message ? `: ${body.error.message}` : '.'}`);
  };
  return {
    async get(partId, name, signal) {
      const res = await fetch(at(partId, name), { headers, signal });
      if (!res.ok) throw await refused(res);
      return Buffer.from(await res.arrayBuffer());
    },
    async put(partId, name, bytes, signal) {
      const res = await fetch(at(partId, name), { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: new Uint8Array(bytes), signal });
      if (!res.ok) throw await refused(res);
    },
  };
}

/* The files a part of work left in its output folder that go on the task: plain files only, made by the part's own user
   when it has one, at most MAX_RUN_FILES of them, each at most RUN_FILE_BYTES. Opened without following a link, so a
   link to the node's key never leaves the machine. */
export async function putOutputs(msg: TestRun, folder: string, user: JobUser | null, files: PartFiles, out: Output, signal: AbortSignal): Promise<void> {
  /* Something else in its place, such as a link to another folder: then nothing goes. */
  const own = lstatSync(folder);
  if (!own.isDirectory() || (user && own.uid !== user.uid)) {
    out.line("The output folder is no longer the part's own, so nothing goes on the task.");
    return;
  }
  const names = readdirSync(folder).sort();
  if (!names.length) return;
  const put: string[] = [];
  const left: string[] = [];
  for (const name of names) {
    if (put.length >= MAX_RUN_FILES) {
      left.push(name);
      continue;
    }
    let fd: number | null = null;
    try {
      /* A named pipe opens without waiting for a writer, and is left out as no plain file. */
      fd = openSync(join(folder, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = fstatSync(fd);
      if (!st.isFile() || (user && st.uid !== user.uid) || st.size > RUN_FILE_BYTES) {
        left.push(name);
        continue;
      }
      await files.put(msg.partId, name, readFileSync(fd), signal);
      put.push(name);
    } catch (err) {
      if (signal.aborted) {
        out.line(`Stopped before ${name} went on the task.`);
        break;
      }
      if (fd === null) left.push(name);
      else out.line(`${name} could not go on the task: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
  if (put.length) out.line(`Put on the task: ${put.join(', ')}.`);
  if (left.length) out.line(`Only plain files up to ${RUN_FILE_BYTES / 1024 / 1024} MB go on the task, ${MAX_RUN_FILES} at most; left out: ${left.join(', ')}.`);
}

/* A part's folders: its own, which stays the node's so its user cannot put anything else in place of the rest, and the
   ones inside it that its user writes in. */
export function partFolders(root: string, msg: TestRun): { own: string; user: string[] } {
  const subs = ['home', 'tmp', ...(msg.kind === 'work' ? ['out', msg.repo ? 'in' : 'work'] : []), ...(msg.repo ? ['repo'] : [])];
  return { own: root, user: subs.map(sub => join(root, sub)) };
}

const vitestWorkers = (cpus = availableParallelism(), env: NodeJS.ProcessEnv = process.env) =>
  env.VITEST_MAX_WORKERS?.trim() || String(Math.max(1, Math.floor(cpus / 2)));

function commandEnv(base: NodeJS.ProcessEnv, msg: TestRun, inbox: string, outbox: string, workers: string): NodeJS.ProcessEnv {
  const parts = { HH_PART: String(msg.part), HH_PARTS: String(msg.parts) };
  if (msg.kind === 'work') return { ...base, NO_COLOR: '1', ...parts, HH_IN: inbox, HH_OUT: outbox };
  return { ...base, CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0', VITEST_MAX_WORKERS: workers, ...parts, HH_TEST_PART: String(msg.part), HH_TEST_PARTS: String(msg.parts) };
}

/* One part of a run, which always ends with a tests.done: the branch, if there is one, is cloned into a fresh folder,
   a part of work gets the task's files it names, the command runs within the time with a home and a temporary folder
   of its own, what a part of work leaves in its output folder goes on the task, and the folder goes, whatever
   happened. */
export async function runTests(msg: TestRun, { dir, user, hidden, signal, proc = '/proc', cpus, env: hostEnv, files }: Options): Promise<TestsDone> {
  const deadline = Date.now() + msg.timeoutMs;
  const work = msg.kind === 'work';
  const root = join(dir, 'tests', msg.partId);
  /* Where the command runs: the clone, or for work without a repository an empty folder that holds the task's files. */
  const repo = join(root, msg.repo ? 'repo' : 'work');
  const inbox = msg.repo ? join(root, 'in') : repo;
  const outbox = join(root, 'out');
  const out = new Output();
  /* Ends a wait on Hornhoof when the part is stopped or this moment passes. */
  const until = (end: number) => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.max(0, end - Date.now()))]);
  let commit: string | null = null;
  let exitCode: number | null = null;
  let error: TestError | null = null;
  let ran = false;
  const stoppedBy = (ended: Ended): TestError | null => {
    if (ended.stopped === 'timeout') out.line(`The ${work ? 'command' : 'tests'} did not finish within ${within(msg.timeoutMs)}.`);
    if (ended.stopped === 'cancelled') out.line('Stopped.');
    return ended.stopped;
  };
  try {
    mkdirSync(join(dir, 'tests'), { recursive: true });
    remove(root);
    const folders = partFolders(root, msg);
    prepareFolder(folders.own, null);
    chmodSync(folders.own, 0o755);
    for (const folder of folders.user) prepareFolder(folder, user);
    if (user) ensurePasswd(user, join(dir, 'tests'));
    const base = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), LANG: 'C.UTF-8' };
    const source = msg.repo;
    /* Git reads no settings but its own here, and gets the token only through the helper, for the repository's host. */
    const git = (args: string[], cwd: string, into = out) =>
      runIn('git', args, { cwd, env: { ...base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...gitEnv(source!) }, user, deadline: Math.min(deadline, Date.now() + GIT_TIMEOUT_MS), signal, out: into });

    let branch = msg.branch;
    if (!source && !work) {
      out.line('A test run needs a repository.');
      error = 'clone_failed';
    }
    if (source && !branch && !work) {
      const heads = new Output();
      const listed = await git(['ls-remote', '--heads', '--', source.url], root, heads);
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
    if (!error && source) {
      if (!branch) {
        out.line('Name the branch to clone.');
        error = 'clone_failed';
      } else {
        out.line(`$ git clone --branch ${branch} ${source.url}`);
        const cloned = await git(['clone', '--quiet', '--depth', '1', '--branch', branch, '--', source.url, repo], root);
        error = stoppedBy(cloned) ?? (cloned.code === 0 ? null : 'clone_failed');
      }
    }
    if (!error && source) {
      const head = new Output();
      await git(['rev-parse', 'HEAD'], repo, head);
      commit = /^[0-9a-f]{40,64}$/.exec(head.text().trim())?.[0] ?? null;
      if (commit) out.line(`At ${commit}.`);
    }
    if (!error && work && msg.files?.length) {
      for (const name of msg.files) {
        try {
          if (!files) throw new Error('This node has no way to fetch task files.');
          const path = join(inbox, name);
          writeFileSync(path, await files.get(msg.partId, name, until(deadline)), { mode: 0o600, flag: 'wx' });
          if (user) chownSync(path, user.uid, user.gid);
        } catch (err) {
          if (signal?.aborted) {
            out.line('Stopped.');
            error = 'cancelled';
          } else if (Date.now() >= deadline) {
            out.line(`The task's files did not come within ${within(msg.timeoutMs)}.`);
            error = 'timeout';
          } else {
            out.line(`The task's file ${name} could not be fetched: ${err instanceof Error ? err.message : String(err)}`);
            error = 'files_failed';
          }
          break;
        }
      }
      if (!error) out.line(`Fetched from the task: ${msg.files.join(', ')}.`);
    }
    if (!error) {
      out.line(`$ ${msg.command}`);
      const env = commandEnv(base, msg, inbox, outbox, vitestWorkers(cpus, hostEnv));
      const ended = await runIn('/bin/bash', ['-c', msg.command], { cwd: repo, env, user, deadline, signal, out });
      ran = true;
      error = stoppedBy(ended);
      if (!error) {
        exitCode = ended.code;
        if (ended.signal) out.line(`The command was ended by ${ended.signal}.`);
        if (ended.code !== 0) error = 'failed';
      }
    }
  } catch (err) {
    out.line(err instanceof Error ? err.message : String(err));
    error ??= 'failed';
  } finally {
    if (user) killUser(user.uid, proc);
    /* Only a user of the node's own, never the node's or a person's. */
    if (user && user.uid >= FIRST_UID) clearShared(user.uid, SHARED);
    try {
      if (work && ran && files && error !== 'cancelled') await putOutputs(msg, outbox, user, files, out, until(deadline + PUT_GRACE_MS));
    } catch (err) {
      out.line(`The output folder could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      remove(root);
    } catch (err) {
      out.line(`The run's folder could not be removed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const secrets = [...hidden, ...(msg.repo?.token ? [msg.repo.token] : [])];
  return { type: 'tests.done', partId: msg.partId, ok: error === null && exitCode === 0, exitCode, error, commit, log: redact(stripEscapes(out.text()), secrets) };
}
