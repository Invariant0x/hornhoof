import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, chownSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { mutationResultMatches, CheckSlotQueue, KeptFiles, TestExecution, parseTestEnvironment, supportsTestProfile, validateEnvironmentDescription, type HarnessSynced, type Command, type EnvironmentDescription, type EnvironmentProblem, type FileOutcome, type InputDigest, type RepositoryScope, type RuntimeCapability, type TestEnvironmentReceipt, type TestEnvironmentV1, COMMIT_SHA, MAX_RUN_FILES, ownBranch, RUN_FILE_BYTES, TEST_LOG_BYTES, type NodeMessage, type ServerMessage, type TestError } from '@hornhoof/protocol';
import { browserEnv, ensureRepoBrowser, playwrightVersionIn } from './browser.js';
import { ensurePasswd, FIRST_UID, prepareFolder, userFor, type JobUser } from './isolation.js';
import { stripEscapes } from './providers/process.js';
import { redact } from './redact.js';
import { chown as fsChown, copyFile as fsCopyFile, mkdir as fsMkdir, mkdtemp as fsMkdtemp, readFile as fsReadFile, rmdir as fsRmdir, stat as fsStat, writeFile as fsWriteFile } from 'node:fs/promises';
import type { AgentFs } from './agent-fs.js';
import { privateCacheRoot, pruneCache, readReady, restoreCache, type CacheContext, type CacheEntry } from './test-cache.js';
import { EnvironmentFailure, MANIFEST, buildSharedTestInvocation, buildTestInvocation, sharedVitestCommand, harnessPlatform, harnessVersion, openEnvironment, prepareDependencies, prepareEnvironment, preparationInputDigest, readTestEnvironment, safeCheckoutPath, setupEnv, type BuilderSetup, type PreparationBuilder, type PreparationContext, type PreparedDependencies, type SharedMember } from './test-environment.js';
import { harnessShare, type HarnessRemote } from './test-harness.js';
import { checkoutCommit } from './test-mirror.js';
import { machineLoad, WORKER_BYTES } from './load.js';
import { collectKept, parseFailedTests, parseFileReport, parseMutationReport, readJobFile, REPORT_BYTES, restoreKept, type FailedTest } from './test-report.js';
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
  /* The node's data folder: each part runs in runs/<part> inside it. */
  dir: string;
  /* The test runs' own user on a node that runs as root, which reaches neither the node's keys nor the agents' folders. */
  user: JobUser | null;
  /* Values the log never shows, such as the node's key. */
  hidden: string[];
  signal?: AbortSignal;
  proc?: string;
  cpus?: number;
  /* The machine's load average over the last minute and the memory a new program can get, in bytes, when a part starts. */
  load?: number;
  memFree?: number;
  env?: NodeJS.ProcessEnv;
  /* The task's files of a part of work, in and out. */
  files?: PartFiles;
  /* Ensures the repository lockfile's Playwright browsers are ready and launchable before the check runs. */
  prepareRepoBrowser?: (repoDir: string) => Promise<void>;
  /* Where a harness unit this machine lacks comes from. None: what a part needs is built here. */
  harness?: HarnessRemote;
  /* The machine's programs as it found them when it started, so a part need not ask them again. */
  runtimes?: RuntimeCapability[] | undefined;
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

/* What a part's commands get of the machine: its programs, its browsers and the grammars its quality tools parse with, which
   the image keeps in place so that they fetch nothing. Nothing else of the node's own environment. */
const MACHINE_TOOLS = ['TREE_SITTER_LANGUAGE_PACK_CACHE_DIR'];
function partBase(root: string, dir: string): Record<string, string> {
  const tools = Object.fromEntries(MACHINE_TOOLS.flatMap(key => (process.env[key] ? [[key, process.env[key]]] : [])));
  return { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), LANG: 'C.UTF-8', ...browserEnv(dir), ...tools };
}

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

/* Where a node runs its parts. crapper, dryer and mutator take a file for a test when any folder on its absolute path is
   called test, tests, spec or the like, so under such a folder they find no source in a part and still exit 0: none on the
   way here may have such a name. quality/test_part_paths.py checks the tools against this path in the image. */
const partsFolder = (dir: string) => join(dir, 'runs');

/* Nothing runs yet when a node starts, and older nodes ran their parts in tests/. A part or a harness sync sent again gets a new
   id and a part's log never lived in its folder, so what a restart left is of no use, and the next product's builder could read it. */
export function removeOldParts(dir: string, log: (line: string) => void): void {
  try {
    remove(join(dir, 'tests'));
    remove(partsFolder(dir));
  } catch (err) {
    log(`The old folder of test runs could not be removed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const within = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

/* The branch named after the task, among what ls-remote printed. */
function taskBranch(heads: string, task: number): { branch: string } | { problem: string } {
  return ownBranch(heads.split('\n').flatMap(line => /\trefs\/heads\/(\S+)$/.exec(line.trim())?.slice(1) ?? []), task);
}

/* How a part reaches its code: git on its machine, what ends its commands, and where the code goes. */
type Checkout = {
  msg: TestRun;
  url: string;
  git: (args: string[], cwd: string, into?: Output) => Promise<Ended>;
  stoppedBy: (ended: Ended) => TestError | null;
  root: string;
  repo: string;
  out: Output;
};

const afterGit = (c: Checkout, ended: Ended): TestError | null => c.stoppedBy(ended) ?? (ended.code === 0 ? null : 'clone_failed');

/* Exactly the commit Hornhoof pinned, whatever its branch points at by now. It is fetched by its name, so anything that
   holds it can serve it in the repository's place, such as a mirror on the machine. */
async function fetchCommit(c: Checkout, sha: string): Promise<TestError | null> {
  c.out.line(`$ git fetch ${c.url} ${sha}`);
  const steps = [['init', '--quiet'], ['remote', 'add', '--', 'origin', c.url], ['fetch', '--quiet', '--depth', '1', 'origin', sha], ['checkout', '--quiet', '--detach', 'FETCH_HEAD']];
  for (const args of steps) {
    const error = afterGit(c, await c.git(args, c.repo));
    if (error) return error;
  }
  return null;
}

/* The tip of a branch, for a part with no pinned commit: the one named, or for tests the task's own. */
async function cloneBranch(c: Checkout): Promise<TestError | null> {
  let branch = c.msg.branch;
  if (!branch && c.msg.kind !== 'work') {
    const heads = new Output();
    const listed = await c.git(['ls-remote', '--heads', '--', c.url], c.root, heads);
    const stopped = c.stoppedBy(listed);
    if (stopped) return stopped;
    if (listed.code !== 0) {
      c.out.line(heads.text());
      return 'clone_failed';
    }
    const found = taskBranch(heads.text(), c.msg.task);
    if ('problem' in found) {
      c.out.line(found.problem);
      return 'clone_failed';
    }
    branch = found.branch;
  }
  if (!branch) {
    c.out.line('Name the branch to clone.');
    return 'clone_failed';
  }
  c.out.line(`$ git clone --branch ${branch} ${c.url}`);
  return afterGit(c, await c.git(['clone', '--quiet', '--depth', '1', '--branch', branch, '--', c.url, c.repo], c.root));
}

/* A part that landed anywhere but on its pinned commit proves nothing about it, so its command never runs. */
function landedElsewhere(pinned: string | null | undefined, commit: string | null, out: Output): TestError | null {
  if (!pinned || commit === pinned) return null;
  out.line(`The checkout is at ${commit ?? 'no commit'}, not at the pinned commit ${pinned}.`);
  return 'clone_failed';
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

/* Vitest's workers: the cores and memory the machine has free when the part starts, one core left for Vitest itself,
   and never fewer than half the cores. */
function vitestWorkers(options: Pick<Options, 'cpus' | 'load' | 'memFree' | 'env'>): string {
  const preset = (options.env ?? process.env).VITEST_MAX_WORKERS?.trim();
  if (preset) return preset;
  const machine = options.load === undefined || options.memFree === undefined ? machineLoad() : null;
  const cpus = options.cpus ?? availableParallelism(), load = options.load ?? machine!.load, memFree = options.memFree ?? machine!.memFree;
  const free = Math.min(cpus - 1, Math.floor(cpus - load), Math.floor(memFree / WORKER_BYTES) - 1);
  return String(Math.max(1, Math.floor(cpus / 2), free));
}

function commandEnv(base: NodeJS.ProcessEnv, msg: TestRun, inbox: string, outbox: string, workers: string): NodeJS.ProcessEnv {
  const parts = { HH_PART: String(msg.part), HH_PARTS: String(msg.parts) };
  if (msg.kind === 'work') return { ...base, NO_COLOR: '1', ...parts, HH_IN: inbox, HH_OUT: outbox };
  return { ...base, CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0', VITEST_MAX_WORKERS: workers, ...parts, HH_TEST_PART: String(msg.part), HH_TEST_PARTS: String(msg.parts) };
}

/* One part of a run, which always ends with a tests.done: the commit Hornhoof pinned, or else the branch if there is one,
   comes into a fresh folder, a part of work gets the task's files it names, the command runs within the time with a home
   and a temporary folder of its own, what a part of work leaves in its output folder goes on the task, and the folder
   goes, whatever happened. */
export async function runTests(msg: TestRun, options: Options): Promise<TestsDone> {
  if (msg.environment) return runProductPart(msg, options);
  const { dir, user, hidden, signal, proc = '/proc', files, prepareRepoBrowser = repoDir => ensureRepoBrowser(dir, repoDir, user) } = options;
  const deadline = Date.now() + msg.timeoutMs;
  const work = msg.kind === 'work';
  const parts = partsFolder(dir);
  const root = join(parts, msg.partId);
  /* Where the command runs: the clone, or for work without a repository an empty folder that holds the task's files. */
  const repo = join(root, msg.repo ? 'repo' : 'work');
  const inbox = msg.repo ? join(root, 'in') : repo;
  const outbox = join(root, 'out');
  const out = new Output();
  /* Ends a wait on Hornhoof when the part is stopped or this moment passes. */
  const until = (end: number) => productSignal(signal, end);
  let commit: string | null = null;
  let exitCode: number | null = null;
  let error: TestError | null = null;
  let ran = false;
  const harnessEnv: Record<string, string> = {};
  const stoppedBy = (ended: Ended): TestError | null => {
    if (ended.stopped === 'timeout') out.line(`The ${work ? 'command' : 'tests'} did not finish within ${within(msg.timeoutMs)}.`);
    if (ended.stopped === 'cancelled') out.line('Stopped.');
    return ended.stopped;
  };
  try {
    mkdirSync(parts, { recursive: true });
    remove(root);
    const folders = partFolders(root, msg);
    prepareFolder(folders.own, null);
    chmodSync(folders.own, 0o755);
    for (const folder of folders.user) prepareFolder(folder, user);
    if (user) ensurePasswd(user, parts);
    const base = partBase(root, dir);
    const source = msg.repo;
    /* Git reads no settings but its own here, and gets the token only through the helper, for the repository's host. */
    const git = (args: string[], cwd: string, into = out) =>
      runIn('git', args, { cwd, env: { ...base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...gitEnv(source!) }, user, deadline: Math.min(deadline, Date.now() + GIT_TIMEOUT_MS), signal, out: into });

    if (!source && !work) {
      out.line('A test run needs a repository.');
      error = 'clone_failed';
    }
    if (source) {
      const checkout: Checkout = { msg, url: source.url, git, stoppedBy, root, repo, out };
      error = await checkoutForPart(checkout, { dir, user, signal, deadline });
    }
    if (!error && source) {
      const head = new Output();
      await git(['rev-parse', 'HEAD'], repo, head);
      commit = COMMIT_SHA.exec(head.text().trim())?.[0] ?? null;
      if (commit) out.line(`At ${commit}.`);
      error = landedElsewhere(msg.commitSha, commit, out);
      if (!error) {
        Object.assign(harnessEnv, await manualHarness(msg, options, { root, repo, out, base, deadline }));
        await prepareRepoBrowser(repo);
      }
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
      const env = { ...commandEnv(base, msg, inbox, outbox, vitestWorkers(options)), ...harnessEnv };
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
    if (user) await stopTestUser(user, proc);
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

async function checkoutForPart(checkout: Checkout, options: { dir: string; user: JobUser | null; signal?: AbortSignal; deadline: number }): Promise<TestError | null> {
  const { msg } = checkout;
  if (!msg.repositoryScope || !msg.commitSha || msg.commitSha.length !== 40) return msg.commitSha ? fetchCommit(checkout, msg.commitSha) : cloneBranch(checkout);
  remove(checkout.repo);
  await checkoutCommit(msg.repo!, msg.repositoryScope, msg.commitSha, checkout.repo, { cacheRoot: join(options.dir, 'cache'), deadline: options.deadline, signal: options.signal ?? new AbortController().signal, log: line => checkout.out.line(line) });
  prepareFolder(checkout.repo, options.user); return null;
}

/* The harness of a manual part's commit goes in place before its command, so the command starts with its dependencies there.
   A command may still install for itself, so what goes wrong here only costs it the head start, and at most this long. */
const MANUAL_HARNESS_MS = 10 * 60_000;
const SHARED_OK = (msg: TestRun, options: Options) => msg.kind !== 'work' && !!msg.repo && !!msg.repositoryScope && msg.commitSha?.length === 40 && !!options.harness;
async function manualHarness(msg: TestRun, options: Options, part: { root: string; repo: string; out: Output; base: Record<string, string>; deadline: number }): Promise<Record<string, string>> {
  if (!SHARED_OK(msg, options)) return {};
  const started = performance.now();
  try {
    const deadline = Math.min(part.deadline, Date.now() + MANUAL_HARNESS_MS), state: PreparationState = { ...productUser(options.user), ...part, deadline, signal: productSignal(options.signal, deadline), options };
    const context = preparationContext(state, '', productSecrets(msg, options.hidden));
    const description = await readTestEnvironment(msg.repo!, msg.repositoryScope!, msg.commitSha!, context);
    if (description.manifest.dependencies.cache === 'none') {
      part.out.line('The command starts without the prepared harness: this repository keeps no prepared dependencies.');
      return {};
    }
    const profiled = { ...context, profile: description.manifest.defaultProfile }, dependencies = await prepareDependencies(description, profiled);
    const { env } = await prepareEnvironment(description, dependencies, profiled, { serviceUnits: false, freshServices: false });
    part.out.line(`The harness is in place after ${within(performance.now() - started)}.`);
    return env;
  } catch (error) {
    options.signal?.throwIfAborted();
    part.out.line(`The command starts without the prepared harness: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

/* An agent's worktree gets the prepared dependencies of its commit before its program starts, so the agent's first check finds
   them there: the same unit a test run of that commit takes, from whichever machine built it, or built here once for all of
   them. The program may still install them itself, so what goes wrong here only costs it the head start, and at most this long. */
const WORKTREE_HARNESS_MS = MANUAL_HARNESS_MS;
/* Builds for worktrees run one at a time as a user of their own, so one never stops a part's build or another worktree's. */
const WORKTREE_BUILDER = 'worktree-builder';
const worktreeBuilds = new CheckSlotQueue(() => 1);
/* The agent's clone or worktree its program checks its change in, at the commit it stands at. fs: file work there as its owner. */
export type Worktree = {
  id: string; checkout: string; commitSha: string; repo: { url: string; token: string }; repositoryScope: RepositoryScope; owner: JobUser;
  fs: Pick<AgentFs, 'entry' | 'readPlain' | 'mkdir' | 'move' | 'remove'>;
};
/* slot: the machine's turn for heavy work, which a build waits for. limitMs: how long all of it may take. */
type WorktreeOptions = Pick<Options, 'dir' | 'hidden' | 'signal' | 'proc' | 'harness' | 'runtimes'> & {
  slot?: <T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>) => Promise<T>; limitMs?: number;
};

/* Whether the worktree holds any of them already: they may be the agent's own install, so they stay as they are. Whatever
   stands there counts, a link that leads nowhere too. */
async function holdsAny(tree: Worktree, paths: string[]): Promise<boolean> {
  for (const path of paths) if (await tree.fs.entry(join(tree.checkout, path))) return true;
  return false;
}
/* What the worktree's own manifest names, read as its owner and only from a plain file, so a worktree that holds its
   dependencies costs no fetch: 'none' when the repository keeps no manifest, null when what is there cannot be read here. */
async function ownManifest(tree: Worktree): Promise<TestEnvironmentV1 | 'none' | null> {
  try {
    const path = join(tree.checkout, MANIFEST), entry = await tree.fs.entry(path);
    if (!entry) return 'none';
    if (entry !== 'file') return null;
    const text = await tree.fs.readPlain(path);
    return text === null ? 'none' : parseTestEnvironment(text);
  } catch { return null; }
}

/* It says in one line what it put in place, or nothing when the worktree holds them already or the repository shares none.
   A repository without a manifest costs nothing here: no fetch, and no line. */
export async function worktreeHarness(tree: Worktree, options: WorktreeOptions): Promise<string | null> {
  const own = await ownManifest(tree);
  if (own === 'none' || (own && (own.dependencies.cache === 'none' || await holdsAny(tree, own.dependencies.paths)))) return null;
  const started = performance.now(), deadline = Date.now() + (options.limitMs ?? WORKTREE_HARNESS_MS), signal = productSignal(options.signal, deadline);
  const description = await readTestEnvironment(tree.repo, tree.repositoryScope, tree.commitSha, { cacheRoot: join(options.dir, 'cache'), deadline, signal, log: () => {}, ...(options.runtimes ? { runtimes: options.runtimes } : {}) });
  const { dependencies } = description.manifest;
  if (dependencies.cache === 'none' || await holdsAny(tree, dependencies.paths)) return null;
  await placeInWorktree(description, tree, options, deadline, signal);
  return `Dependencies in place from the shared harness after ${within(performance.now() - started)}.`;
}

/* Taking a ready build never waits for the machine's turn for heavy work; only a build here does. */
const BUILD_HERE = new Error('A build of the dependencies waits for the machine.');
const BUILT_ELSEWHERE = new Error('Another machine has the dependencies or builds them, so the machine is not held for them.');
/* The registry for a build in the machine's turn: when another machine built the unit or builds it by then, the turn goes
   back before anything is taken or waited for. Once the build here starts, its claim is renewed as it is. */
function forBuildHere(remote: HarnessRemote, elsewhere: AbortController): HarnessRemote {
  let building = false;
  return {
    ...remote,
    async claim(unit, signal) {
      const claim = await remote.claim(unit, signal);
      if (!building && (claim.state === 'ready' || claim.state === 'wait')) { elsewhere.abort(BUILT_ELSEWHERE); throw BUILT_ELSEWHERE; }
      building ||= claim.state === 'build';
      return claim;
    },
  };
}

/* They are built or taken in a folder of the node's own, which goes to the worktree's owner only once they are all there, and
   the owner moves each into the worktree: the node writes nothing where an agent's program could change what it writes into. */
async function placeInWorktree(description: EnvironmentDescription, tree: Worktree, options: WorktreeOptions, deadline: number, signal: AbortSignal): Promise<void> {
  const root = join(partsFolder(options.dir), `worktree-${tree.id}`), staging = join(root, 'tree'), hidden = productSecrets({ repo: tree.repo }, options.hidden);
  const state: PreparationState = { ...productUser(tree.owner), root, repo: join(root, 'repo'), out: new Output(), deadline, signal, options: { ...options, user: tree.owner }, builder: WORKTREE_BUILDER, base: partBase(root, options.dir) };
  /* Its owner's programs keep running meanwhile, so nothing here runs or stops anything as that user. A build takes the
     commit's own files, never the worktree's. taking: the pass without the machine's turn, which stops where a build here
     would start. elsewhere: the pass in it, which stops where another machine has the unit or builds it. */
  const contextFor = (phase: AbortSignal, { taking, elsewhere }: { taking?: AbortController; elsewhere?: AbortController } = {}): PreparationContext => {
    const stops = [taking, elsewhere].flatMap(stop => (stop ? [stop.signal] : [])), harness = elsewhere && options.harness && forBuildHere(options.harness, elsewhere);
    const base = preparationContext({ ...state, signal: stops.length ? AbortSignal.any([phase, ...stops]) : phase, ...(harness ? { options: { ...state.options, harness } } : {}) }, '', hidden);
    return {
      ...base, checkout: staging, run: async () => { throw new Error('Nothing runs in a worktree for its dependencies.'); }, quiesce: async () => {},
      builder: async (...args) => {
        /* Stopped before it fails, so the registry takes the claim back unjudged, for the build that follows. */
        if (taking) { taking.abort(BUILD_HERE); throw BUILD_HERE; }
        await checkoutCommit(tree.repo, tree.repositoryScope, tree.commitSha, state.repo, base); return base.builder(...args);
      },
    };
  };
  let handed: string[] | null = null;
  try {
    await privateCacheRoot(join(options.dir, 'cache')); remove(root); prepareFolder(root, null); chmodSync(root, 0o755);
    const { entry } = await takeOrBuild(description, signal, options, contextFor);
    const roots = entry ? (entry.ready ?? await readReady(entry, { cacheRoot: join(options.dir, 'cache'), deadline, signal, log: () => {} })).roots : [];
    await fsChown(staging, tree.owner.uid, tree.owner.gid); handed = roots;
    for (const path of roots) {
      await tree.fs.mkdir(dirname(join(tree.checkout, path)));
      await tree.fs.move(join(staging, path), join(tree.checkout, path));
    }
  } finally { await leaveWorktreeFolder(root, staging, handed && { tree, roots: handed }); }
}

/* First without the machine's turn: what this machine keeps, what another machine built, or the wait for the one building
   it. A build here gives the cache lock back and then takes the machine's turn, its own lane and the lock again, in the order
   a test part takes them. Where another machine has the unit or builds it by then, the turn goes back and it starts over,
   until the deadline. */
async function takeOrBuild(description: EnvironmentDescription, signal: AbortSignal, options: WorktreeOptions, contextFor: (phase: AbortSignal, stops?: { taking?: AbortController; elsewhere?: AbortController }) => PreparationContext): Promise<PreparedDependencies> {
  const slot = options.slot ?? ((granted, run) => run(granted));
  for (;;) {
    const taking = new AbortController();
    try { return await prepareDependencies(description, contextFor(signal, { taking }), { own: true }); }
    catch (error) { if (!taking.signal.aborted || signal.aborted) throw error; }
    const elsewhere = new AbortController();
    try { return await slot(signal, granted => worktreeBuilds.withSlot(() => prepareDependencies(description, contextFor(granted, { elsewhere }), { own: true }), { signal: granted })); }
    catch (error) { if (!elsewhere.signal.aborted || signal.aborted) throw error; }
  }
}

/* The node takes away only what no agent's program could reach. What it handed to the worktree's owner, the owner takes away;
   anything else it left there stays until the node starts again. */
async function leaveWorktreeFolder(root: string, staging: string, handed: { tree: Worktree; roots: string[] } | null): Promise<void> {
  if (handed) {
    for (const top of new Set(handed.roots.map(path => path.split('/')[0]!))) await handed.tree.fs.remove(join(staging, top)).catch(() => {});
    try { await fsRmdir(staging); } catch { remove(join(root, 'repo')); return; }
  }
  remove(root);
}

const productSignal = (signal: AbortSignal | undefined, deadline: number): AbortSignal => AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
/* index: the suite's place in the part; shared: its report is the one report of suites that ran as one command. */
type SuiteReport = { suiteId: string; selected: string[]; path: string; failed: boolean; index: number; shared?: true };
/* builder: the user its builds run as, when not the one of test runs. */
type PreparationState = {
  root: string; repo: string; out: Output; user: JobUser; nodeOwner: JobUser; deadline: number; signal: AbortSignal;
  base: Record<string, string>; options: Options; builder?: string;
};
type ProductState = PreparationState & { receipt: TestEnvironmentReceipt; exitCode: number | null; reports: SuiteReport[]; files: FileOutcome[]; failed: FailedTest[]; kept: KeptFiles };
type ProductOperation = { kind: 'suite'; suiteId: string; files: string[]; shard?: { index: number; count: number } } | { kind: 'command'; command: Command };
function environmentError(code: EnvironmentProblem['code'], detail: string): never { throw new EnvironmentFailure({ code, detail: `${code}: ${detail}` }); }
function productUser(user: JobUser | null): { user: JobUser; nodeOwner: JobUser } {
  const uid = process.getuid?.(), gid = process.getgid?.();
  if (!user || uid === undefined || gid === undefined || user.uid === 0 || user.uid === uid) environmentError('isolation_missing', 'Product preparation requires a distinct isolated job user.');
  return { user, nodeOwner: { uid, gid } };
}
async function timedPhase<T>(receipt: TestEnvironmentReceipt, phase: keyof TestEnvironmentReceipt['phases'], run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await run(); } finally { receipt.phases[phase] += performance.now() - start; }
}
async function stopTestUser(user: JobUser, proc = '/proc'): Promise<void> {
  killUser(user.uid, proc);
  while (productUserAlive(user.uid, proc)) {
    killUser(user.uid, proc);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const statusUser = (status: string): string | undefined => /^Uid:\s+(\d+)/m.exec(status)?.[1];
const liveUserStatus = (status: string, uid: number): boolean => statusUser(status) === String(uid) && !/^State:\s+Z/m.test(status);
function liveUserProcess(path: string, uid: number): boolean {
  try { return liveUserStatus(readFileSync(path, 'utf8'), uid); }
  catch { return false; }
}
function productUserAlive(uid: number, proc: string): boolean {
  return readdirSync(proc).some(name => /^\d+$/.test(name) && liveUserProcess(join(proc, name, 'status'), uid));
}
async function productCommand(state: PreparationState, checkout: string, user: JobUser, command: Command, env: Record<string, string>): Promise<void> {
  state.signal.throwIfAborted();
  if (Date.now() >= state.deadline) throw new DOMException('The product command deadline expired.', 'TimeoutError');
  state.out.line(`$ ${JSON.stringify([command.program, ...command.args])}`);
  const ended = await runIn(command.program, command.args, { cwd: await safeCheckoutPath(checkout, command.cwd), env, user, deadline: state.deadline, signal: state.signal, out: state.out });
  if (ended.stopped) throw new DOMException(`The product command was ${ended.stopped}.`, ended.stopped === 'timeout' ? 'TimeoutError' : 'AbortError');
  if (ended.code !== 0) throw new ProductCommandFailure(ended.code, ended.signal);
}
async function builderInputs(inputs: InputDigest[], source: string, target: string, context: CacheContext): Promise<void> {
  for (const input of inputs) {
    if (input.digest === null) continue;
    const full = await safeCheckoutPath(source, input.path);
    if (!(await fsStat(full)).isFile() || await preparationInputDigest(full, context) !== input.digest) environmentError('description_mismatch', 'A preparation input changed before its isolated build.');
    const destination = join(target, input.path); await fsMkdir(dirname(destination), { recursive: true });
    await fsCopyFile(full, destination);
  }
}
async function productBuilder(state: PreparationState, inputs: InputDigest[], dependencies: CacheEntry | null, setup: BuilderSetup, context: CacheContext): Promise<PreparationBuilder> {
  const user = userFor(state.options.dir, state.builder ?? 'product-test-builder');
  if (!user || user.uid === state.user.uid || user.uid === state.nodeOwner.uid || user.uid === 0) environmentError('isolation_missing', 'A distinct preparation builder user is unavailable.');
  const builders = join(state.root, 'builders'); await fsMkdir(builders, { recursive: true, mode: 0o755 });
  const root = await fsMkdtemp(join(builders, 'unit-'));
  const quiesce = () => stopTestUser(user, state.options.proc);
  try {
    await builderInputs(inputs, state.repo, root, context);
    /* The builder gets its folder first: what comes linked stays the node's and read-only. */
    for (const path of [root, join(root, '.home'), join(root, '.tmp')]) prepareFolder(path, user);
    if (dependencies) await restoreCache(dependencies, root, context, { link: setup.link, owner: user });
    ensurePasswd(user, partsFolder(state.options.dir));
    const env = { ...state.base, ...setupEnv(setup, root, state.base.PATH), HOME: join(root, '.home'), TMPDIR: join(root, '.tmp'), CI: 'true' };
    return { root, user, env, run: (command, extra = {}) => productCommand(state, root, user, command, { ...env, ...extra }), quiesce, close: () => closeBuilder(user, root, state.options.proc) };
  } catch (error) { await closeBuilder(user, root, state.options.proc); throw error; }
}
async function closeBuilder(user: JobUser, root: string, proc = '/proc'): Promise<void> {
  await stopTestUser(user, proc);
  if (user.uid >= FIRST_UID) clearShared(user.uid, SHARED);
  remove(root);
}
/* A unit that failed tells what the build said last. */
const BUILD_TAIL = 4000;
function preparationContext(state: PreparationState, profile: string, hidden: string[]): PreparationContext {
  const { harness } = state.options;
  const share: PreparationContext['share'] = harness && ((unit, description) => harnessShare(harness, { repositoryScope: description.repositoryScope, version: harnessVersion(description), unit, commitSha: description.commitSha, platform: harnessPlatform() }, { tail: () => redact(stripEscapes(state.out.text()), hidden).slice(-BUILD_TAIL) }));
  const context: PreparationContext = {
    cacheRoot: join(state.options.dir, 'cache'), checkout: state.repo, profile, attemptRoot: state.root, nodeOwner: state.nodeOwner, jobUser: state.user,
    deadline: state.deadline, signal: state.signal, env: state.base, log: line => state.out.line(line), registerSecrets: values => { hidden.push(...values); },
    builder: (inputs, dependencies, setup = { link: false, env: {}, bin: [] }) => productBuilder(state, inputs, dependencies, setup, context),
    run: (command, extra = {}) => productCommand(state, state.repo, state.user, command, { ...state.base, ...extra, CI: 'true' }),
    quiesce: () => stopTestUser(state.user, state.options.proc),
    ...(share ? { share } : {}), ...(state.options.runtimes ? { runtimes: state.options.runtimes } : {}),
  };
  return context;
}
function receiptFor(execution: TestExecution): TestEnvironmentReceipt {
  const { description } = execution.snapshot, { selection } = execution;
  const common = { commitSha: description.commitSha, manifestHash: description.manifestHash, runtimes: [], dependencies: { key: null, hit: false }, environments: [], phases: { checkoutMs: 0, dependenciesMs: 0, environmentMs: 0, servicesMs: 0, commandMs: 0, cleanupMs: 0 } };
  if (!('version' in selection)) return { ...common, version: 1, ...selection };
  return { ...common, version: 2, profile: execution.snapshot.profile, selection, outcomes: productOperations(execution).map((_, index) => ({ index, status: 'not-run', exitCode: null })) };
}
function productOperations(execution: TestExecution): ProductOperation[] {
  const { selection, snapshot } = execution;
  if (selection.kind === 'batch') return selection.selections;
  if (selection.kind !== 'prepare') return [];
  const preparation = snapshot.description.manifest.execution!.oncePreparation!;
  const suites: ProductOperation[] = preparation.suiteIds.map(suiteId => ({ kind: 'suite', suiteId, files: snapshot.description.inventory.filter(unit => unit.suiteId === suiteId).map(unit => unit.file) }));
  return [...suites, ...preparation.commands.map(command => ({ kind: 'command' as const, command }))];
}
async function productCheckout(msg: TestRun, state: ProductState, context: PreparationContext): Promise<EnvironmentDescription> {
  const expected = await productDescription(msg.environment!.snapshot.description);
  await checkoutCommit(msg.repo!, expected.repositoryScope, expected.commitSha, state.repo, context);
  const actual = await readTestEnvironment(msg.repo!, expected.repositoryScope, expected.commitSha, context);
  if (expected.manifestHash !== actual.manifestHash || JSON.stringify(expected.inputDigests) !== JSON.stringify(actual.inputDigests) || JSON.stringify(expected.inventory) !== JSON.stringify(actual.inventory)) environmentError('description_mismatch', 'The pinned checkout differs from the accepted environment snapshot.');
  if (!supportsTestProfile({ description: actual, profile: context.profile }, actual.runtimeCapabilities)) environmentError('runtime_missing', 'The node lacks a runtime required by this product profile.');
  state.receipt.runtimes = actual.runtimeCapabilities; return actual;
}
async function productSelection(msg: TestRun, state: ProductState, env: Record<string, string>): Promise<void> {
  const execution = TestExecution.parse(msg.environment), { selection } = execution;
  if ('version' in selection) return versionedProductSelection(execution, state, env);
  const suite = execution.snapshot.description.manifest.suites.find(suite => suite.id === selection.suiteId)!;
  if (selection.kind === 'final') {
    for (const command of suite.finalChecks!) await selectedProductCommand(state, command, env);
    return;
  }
  await productSuite(execution, { ...selection, kind: 'suite' }, state, env, 0);
}
async function productSuite(execution: TestExecution, operation: Extract<ProductOperation, { kind: 'suite' }>, state: ProductState, env: Record<string, string>, index: number): Promise<void> {
  const suite = execution.snapshot.description.manifest.suites.find(suite => suite.id === operation.suiteId)!;
  const filesPath = join(state.root, `selection-${index}.json`);
  const invocation = await buildTestInvocation(suite, operation.files, { checkout: state.repo, filesPath, shard: operation.shard ?? { index: 1, count: 1 }, snapshot: execution.snapshot });
  if (invocation.env.HH_TEST_FILES) chownSync(filesPath, state.user.uid, state.user.gid);
  if (invocation.env.HH_MUTATION_PLAN_FILE) chownSync(invocation.env.HH_MUTATION_PLAN_FILE, state.user.uid, state.user.gid);
  await productResets(execution, suite.id, state, env);
  const report: SuiteReport = { suiteId: suite.id, selected: operation.files, path: join(state.root, 'reports', `${index}.json`), failed: false, index };
  state.reports.push(report);
  try { await selectedProductCommand(state, invocation.command, { ...env, ...invocation.env, HH_TEST_REPORT: report.path }); }
  catch (error) { report.failed = true; throw error; }
}
type SuiteOperation = Extract<ProductOperation, { kind: 'suite' }>;
function sharedMember(execution: TestExecution, operation: ProductOperation): SharedMember | null {
  if (operation.kind !== 'suite') return null;
  const suite = execution.snapshot.description.manifest.suites.find(suite => suite.id === operation.suiteId)!;
  return { suite, files: operation.files, shard: operation.shard ?? { index: 1, count: 1 } };
}
/* The operations of a part as they run: Vitest suites that can share one command run together, where the first of them stands. */
function productRuns(execution: TestExecution, operations: ProductOperation[]): number[][] {
  const runs: number[][] = [], taken = new Set<number>();
  for (const [index, operation] of operations.entries()) {
    if (taken.has(index)) continue;
    const first = sharedMember(execution, operation), run = [index];
    for (const [other, next] of operations.entries()) {
      const member = other > index && !taken.has(other) ? sharedMember(execution, next) : null;
      if (first && member && sharedVitestCommand([first, member], execution.snapshot)) run.push(other);
    }
    for (const member of run) taken.add(member);
    runs.push(run);
  }
  return runs;
}
/* Suites that run as one command write one report, which each of them reads for its own files. */
async function productSharedSuites(execution: TestExecution, run: number[], operations: ProductOperation[], state: ProductState, env: Record<string, string>): Promise<void> {
  const members = run.map(index => sharedMember(execution, operations[index]!)!), filesPath = join(state.root, `selection-${run[0]}.json`);
  const invocation = await buildSharedTestInvocation(members, { checkout: state.repo, filesPath, snapshot: execution.snapshot });
  chownSync(filesPath, state.user.uid, state.user.gid);
  for (const member of members) await productResets(execution, member.suite.id, state, env);
  const path = join(state.root, 'reports', `${run[0]}.json`);
  const reports = run.map((index): SuiteReport => ({ suiteId: (operations[index] as SuiteOperation).suiteId, selected: (operations[index] as SuiteOperation).files, path, failed: false, index, shared: true }));
  state.reports.push(...reports);
  try { await selectedProductCommand(state, invocation.command, { ...env, ...invocation.env, HH_TEST_REPORT: path }); }
  catch (error) { for (const report of reports) report.failed = true; throw error; }
}
/* A shared command that failed says whose failure it was when its report names a failed file: a suite with none of them proved
   its files and passed. One that names none proves nothing of any of them. */
function settleSharedFailures(state: ProductState, said: { report: SuiteReport; text: string | null }[], checkout: string): void {
  const failedIn = (text: string | null, selected: string[]) => parseFileReport(text, { checkout, suiteId: '', selected, suiteFailed: false }).some(file => file.status === 'failed');
  for (const { report, text } of said) {
    if (!report.shared || !report.failed) continue;
    const together = said.filter(other => other.report.path === report.path).flatMap(other => other.report.selected);
    if (!failedIn(text, together) || failedIn(text, report.selected)) continue;
    report.failed = false;
    if (state.receipt.version === 2) state.receipt.outcomes[report.index] = { index: report.index, status: 'passed', exitCode: 0 };
  }
}
/* What a suite kept from its last run goes back before anything of this one runs. */
function restoreProductKept(msg: TestRun, execution: TestExecution, state: ProductState): void {
  const { suites } = execution.snapshot.description.manifest;
  for (const { suiteId, files } of msg.kept ?? []) restoreKept(state.repo, suites.find(suite => suite.id === suiteId)?.keep ?? [], files);
}
/* What each suite that ran leaves for its next run. */
function keptBySuites(execution: TestExecution, state: ProductState, checkout: string, restored: KeptFiles): KeptFiles {
  const ran = execution.snapshot.description.manifest.suites.filter(suite => suite.keep?.length && state.reports.some(report => report.suiteId === suite.id));
  return KeptFiles.safeParse(ran.flatMap(suite => {
    const files = collectKept(checkout, suite.keep!, state.user.uid, restored.find(kept => kept.suiteId === suite.id)?.files);
    return files.length ? [{ suiteId: suite.id, files }] : [];
  })).data ?? [];
}
function collectProductMutations(execution: TestExecution, state: ProductState): void {
  const scope = execution.snapshot.candidate?.mutation, policy = execution.snapshot.description.manifest.mutation;
  if (!scope || policy.status !== 'supported') return;
  const mutations = state.reports.flatMap(report => {
    const files = report.selected.filter(file => policy.sourcePaths.includes(file));
    if (report.failed || !files.length) return [];
    const result = parseMutationReport(readJobFile(report.path, state.user.uid, REPORT_BYTES));
    if (!result || !mutationResultMatches(scope.selection, result, files)) environmentError('description_mismatch', 'The mutation report is missing or differs from the assigned candidate functions or source outcomes.');
    return [{ suiteId: report.suiteId, ...result }];
  });
  if (mutations.length) state.receipt.mutations = mutations;
}
/* Read once the job's processes have stopped, so nothing changes under the reading. What cannot be read only means less is reused. */
function collectProductResults(execution: TestExecution, state: ProductState, restored: KeptFiles): void {
  try {
    const checkout = realpathSync(state.repo);
    const said = state.reports.map(report => ({ report, text: readJobFile(report.path, state.user.uid, REPORT_BYTES) }));
    settleSharedFailures(state, said, checkout);
    state.files = said.flatMap(({ report, text }) => parseFileReport(text, { checkout, suiteId: report.suiteId, selected: report.selected, suiteFailed: report.failed }));
    state.failed = said.flatMap(({ report, text }) => report.failed ? parseFailedTests(text, { checkout, selected: report.selected }) : []);
    state.kept = keptBySuites(execution, state, checkout, restored);
  } catch (error) { state.out.line(`The results of the part's test files could not be read: ${error instanceof Error ? error.message : String(error)}`); }
  collectProductMutations(execution, state);
}
function rememberProductFailure(error: unknown, firstFailure: ProductCommandFailure | undefined, state: ProductState): ProductCommandFailure | undefined {
  if (error instanceof ProductCommandFailure) firstFailure ??= error;
  state.exitCode = firstFailure?.exitCode ?? null;
  return firstFailure;
}
async function versionedProductSelection(execution: TestExecution, state: ProductState, env: Record<string, string>): Promise<void> {
  const receipt = state.receipt;
  if (receipt.version !== 2) environmentError('environment_invalid', 'Versioned execution requires a complete receipt.');
  const operations = productOperations(execution);
  let firstFailure: ProductCommandFailure | undefined;
  for (const run of productRuns(execution, operations)) {
    const operation = operations[run[0]!]!;
    try {
      if (run.length > 1) await productSharedSuites(execution, run, operations, state, env);
      else if (operation.kind === 'command') await selectedProductCommand(state, operation.command, env);
      else await productSuite(execution, operation, state, env, run[0]!);
      for (const index of run) receipt.outcomes[index] = { index, status: 'passed', exitCode: 0 };
    } catch (error) {
      for (const index of run) receipt.outcomes[index] = { index, status: 'failed', exitCode: error instanceof ProductCommandFailure ? error.exitCode : null };
      firstFailure = rememberProductFailure(error, firstFailure, state);
      if (!(error instanceof ProductCommandFailure) || execution.selection.kind === 'prepare') throw error;
    }
  }
  if (firstFailure) { state.exitCode = firstFailure.exitCode; throw firstFailure; }
}
/* Each program of a repository can pin a browser of its own, in its own folder. */
async function prepareBrowsers(description: EnvironmentDescription, repo: string, prepare: (folder: string) => Promise<void>): Promise<void> {
  await prepare(repo);
  for (const folder of new Set(description.manifest.suites.map(suite => join(repo, suite.root)))) {
    if (folder !== repo && playwrightVersionIn(folder)) await prepare(folder);
  }
}
async function executeProduct(msg: TestRun, state: ProductState, hidden: string[]): Promise<void> {
  const execution = TestExecution.parse(msg.environment), context = preparationContext(state, execution.snapshot.profile, hidden);
  let services: Awaited<ReturnType<typeof openEnvironment>> | undefined;
  try {
    const description = await timedPhase(state.receipt, 'checkoutMs', () => productCheckout(msg, state, context));
    restoreProductKept(msg, execution, state);
    /* The job user gets its checkout with what a suite kept, and before anything else is restored into it: a handover afterwards
       would reach through shared links into the files every part reads. */
    prepareFolder(state.repo, state.user);
    const dependencies = await timedPhase(state.receipt, 'dependenciesMs', () => prepareDependencies(description, context)); state.receipt.dependencies = dependencies.receipt;
    await timedPhase(state.receipt, 'servicesMs', () => prepareBrowsers(description, state.repo, state.options.prepareRepoBrowser ?? (folder => ensureRepoBrowser(state.options.dir, folder, state.user))));
    const prepared = await timedPhase(state.receipt, 'environmentMs', () => prepareEnvironment(description, dependencies, context)); state.receipt.environments = prepared.receipts;
    services = await timedPhase(state.receipt, 'servicesMs', () => openEnvironment(prepared, context));
    await timedPhase(state.receipt, 'commandMs', () => productSelection(msg, state, { ...state.base, ...services!.env, CI: 'true', NO_COLOR: '1', VITEST_MAX_WORKERS: vitestWorkers(state.options) }));
  } finally {
    await timedPhase(state.receipt, 'cleanupMs', async () => { try { await services?.close(); } finally { await stopTestUser(state.user, state.options.proc); } });
    collectProductResults(execution, state, msg.kept ?? []);
  }
}
function productFailure(error: unknown, signal: AbortSignal): TestError {
  if (signal.aborted) return signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? 'timeout' : 'cancelled';
  return error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'failed';
}
async function productState(msg: TestRun, options: Options, out: Output): Promise<ProductState> {
  const execution = TestExecution.parse(msg.environment), { description } = execution.snapshot, scope = msg.repositoryScope;
  if (msg.commitSha !== description.commitSha || !scope || scope.companyId !== description.repositoryScope.companyId || scope.repositoryOwnerId !== description.repositoryScope.repositoryOwnerId || scope.repoUrlHash !== description.repositoryScope.repoUrlHash) environmentError('description_mismatch', 'The assigned source differs from the pinned environment.');
  await productDescription(description);
  const identity = productUser(options.user), root = join(partsFolder(options.dir), msg.partId), deadline = Date.now() + msg.timeoutMs;
  return { ...identity, root, repo: join(root, 'repo'), out, deadline, signal: productSignal(options.signal, deadline), options, receipt: receiptFor(execution), exitCode: null, reports: [], files: [], failed: [], kept: [], base: partBase(root, options.dir) };
}
async function productFolders(state: PreparationState): Promise<void> {
  await privateCacheRoot(join(state.options.dir, 'cache')); remove(state.root); prepareFolder(state.root, null); chmodSync(state.root, 0o755);
  for (const path of ['home', 'tmp', 'reports']) prepareFolder(join(state.root, path), state.user);
  ensurePasswd(state.user, partsFolder(state.options.dir));
}
const productSecrets = (msg: Pick<TestRun, 'repo'>, hidden: string[]): string[] => [...hidden, ...(msg.repo?.token ? [msg.repo.token] : [])];
function failedProductSignal(state: ProductState | undefined, options: Options): AbortSignal { return state?.signal ?? options.signal ?? new AbortController().signal; }
async function leaveNothing(state: PreparationState): Promise<void> {
  await stopTestUser(state.user, state.options.proc);
  if (state.user.uid >= FIRST_UID) clearShared(state.user.uid, SHARED);
  remove(state.root);
}
async function cleanupProduct(state: ProductState | undefined, out: Output): Promise<TestError | null> {
  if (!state) return null;
  try {
    await timedPhase(state.receipt, 'cleanupMs', () => leaveNothing(state)); return null;
  } catch (error) { out.line(error instanceof Error ? error.message : String(error)); return 'failed'; }
}
/* How a part's files went and what its suites leave, when it has any of that to say. */
function partResults(state: ProductState | undefined): Pick<TestsDone, 'files' | 'kept'> {
  if (!state) return {};
  return { ...(state.files.length ? { files: state.files } : {}), ...(state.kept.length ? { kept: state.kept } : {}) };
}
function productDone(msg: TestRun, state: ProductState | undefined, error: TestError | null, out: Output, hidden: string[]): TestsDone {
  return { type: 'tests.done', partId: msg.partId, ok: error === null, exitCode: state?.exitCode ?? null, error, commit: state?.receipt.runtimes.length ? msg.commitSha! : null, log: redact(stripEscapes(out.text()), hidden), ...(state ? { environmentReceipt: state.receipt } : {}), ...partResults(state) };
}
/* The last lines of a part's log are what its agent reads of it, so they name the tests that failed and their errors, whatever the
   services said as they stopped. They go into the log before its secrets are hidden, like the rest of it. */
const FAILED_SHOWN = 10;
const FAILED_LINE = 150;
function sayFailedTests(out: Output, failed: FailedTest[]): void {
  if (!failed.length) return;
  out.line('Failed tests:');
  for (const test of failed.slice(0, FAILED_SHOWN)) {
    const line = `${test.file} > ${test.name}: ${test.message}`;
    out.line(line.length > FAILED_LINE ? `${line.slice(0, FAILED_LINE - 3)}...` : line);
  }
  if (failed.length > FAILED_SHOWN) out.line(`and ${failed.length - FAILED_SHOWN} more`);
}
async function runProductPart(msg: TestRun, options: Options): Promise<TestsDone> {
  const out = new Output(), hidden = productSecrets(msg, options.hidden);
  let error: TestError | null = null, state: ProductState | undefined;
  try { state = await productState(msg, options, out); await productFolders(state); await executeProduct(msg, state, hidden); }
  catch (failure) { out.line(failure instanceof Error ? failure.message : String(failure)); error = productFailure(failure, failedProductSignal(state, options)); }
  finally { error = await cleanupProduct(state, out) ?? error; }
  sayFailedTests(out, state?.failed ?? []);
  return productDone(msg, state, error, out, hidden);
}

async function productDescription(value: unknown): Promise<EnvironmentDescription> {
  try { return await validateEnvironmentDescription(value); } catch { return environmentError('description_mismatch', 'The pinned environment evidence is invalid.'); }
}

async function productResets(execution: TestExecution, suiteId: string, state: ProductState, env: Record<string, string>): Promise<void> {
  for (const reset of execution.snapshot.description.manifest.reset ?? []) {
    if (reset.scope === 'part' && reset.suiteIds.includes(suiteId) && reset.command) await productCommand(state, state.repo, state.user, reset.command, env);
  }
}

class ProductCommandFailure extends Error {
  constructor(readonly exitCode: number | null, signal: NodeJS.Signals | null) { super(`The product command failed with exit ${exitCode ?? signal}.`); }
}
async function selectedProductCommand(state: ProductState, command: Command, env: Record<string, string>): Promise<void> {
  state.exitCode = null;
  try { await productCommand(state, state.repo, state.user, command, env); state.exitCode = 0; }
  catch (error) { if (error instanceof ProductCommandFailure) state.exitCode = error.exitCode; throw error; }
}

type HarnessRequest = Extract<ServerMessage, { type: 'tests.harness' }>;
/* A machine gets a commit's harness ready within this. */
const SYNC_MS = 60 * 60_000;
/* How many trees of each kind a machine keeps for what it last used. */
const KEEP_DEPENDENCIES = 8;
const KEEP_ENVIRONMENTS = 64;
const syncedFile = (dir: string, version: string, fingerprint: string) => join(dir, 'cache', 'harness', `${createHash('sha256').update(`${version}:${fingerprint}`).digest('hex')}.json`);

async function alreadySynced(file: string, cacheRoot: string): Promise<string[] | null> {
  const keys = await fsReadFile(file, 'utf8').then(text => JSON.parse(text) as string[], () => null);
  if (!keys) return null;
  const stored = await Promise.all(keys.map(key => Promise.any(['dependencies', 'environments'].map(kind => fsStat(join(cacheRoot, kind, key, 'READY.json')))).then(() => true, () => false)));
  return stored.every(Boolean) ? keys : null;
}

/* Everything a run of this commit could need, on this machine: its dependencies, its browser, what each profile the machine can
   run prepares. All of it hits, or comes from another machine's build, or is built here for all of them. */
async function syncedHarness(msg: HarnessRequest, state: PreparationState, hidden: string[]): Promise<{ version: string; keys: string[] }> {
  const context = preparationContext(state, '', hidden), { dir, prepareRepoBrowser = repo => ensureRepoBrowser(dir, repo, state.user) } = state.options;
  const description = await readTestEnvironment(msg.repo, msg.repositoryScope, msg.commitSha, context).catch((error: unknown) => {
    if (error instanceof EnvironmentFailure) throw error;
    context.signal.throwIfAborted();
    throw new EnvironmentFailure({ code: 'commit_unavailable', detail: 'The machine could not read this commit of the repository.' });
  });
  const version = harnessVersion(description), { dependencies: wanted, profiles } = description.manifest;
  if (wanted.cache === 'none') return { version, keys: [] };
  const marker = syncedFile(dir, version, JSON.stringify(description.runtimeCapabilities)), known = await alreadySynced(marker, context.cacheRoot);
  if (known) return { version, keys: known };
  await checkoutCommit(msg.repo, msg.repositoryScope, msg.commitSha, state.repo, context);
  prepareFolder(state.repo, state.user);
  const dependencies = await prepareDependencies(description, context);
  await prepareBrowsers(description, state.repo, prepareRepoBrowser);
  const keys = new Set([dependencies.receipt.key]);
  for (const { id } of profiles.filter(profile => supportsTestProfile({ description, profile: profile.id }, description.runtimeCapabilities))) {
    const prepared = await prepareEnvironment(description, dependencies, { ...context, profile: id }, { freshServices: false });
    for (const receipt of prepared.receipts) keys.add(receipt.key);
  }
  const held = [...keys].filter((key): key is string => key !== null);
  await fsMkdir(dirname(marker), { recursive: true, mode: 0o700 });
  await fsWriteFile(marker, JSON.stringify(held), { mode: 0o600 });
  await pruneCache(join(context.cacheRoot, 'dependencies'), KEEP_DEPENDENCIES, context);
  await pruneCache(join(context.cacheRoot, 'environments'), KEEP_ENVIRONMENTS, context);
  return { version, keys: held };
}

function syncProblem(error: unknown, signal: AbortSignal, hidden: string[]): EnvironmentProblem {
  if (signal.aborted) return signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? { code: 'timeout', detail: 'The harness did not come ready in time.' } : { code: 'cancelled', detail: 'Getting the harness ready was stopped.' };
  if (error instanceof EnvironmentFailure) return error.problem;
  return { code: 'build_failed', detail: redact(error instanceof Error ? error.message : String(error), hidden).slice(-2000) || 'The harness could not be built.' };
}

/* What Hornhoof asks of every machine ahead of any run. The folder goes, whatever happened. */
export async function syncHarness(msg: HarnessRequest, options: Options): Promise<HarnessSynced> {
  const hidden = productSecrets(msg, options.hidden), out = new Output();
  const root = join(partsFolder(options.dir), `harness-${msg.requestId}`), deadline = Date.now() + SYNC_MS, signal = productSignal(options.signal, deadline);
  let state: PreparationState | undefined, result: HarnessSynced['result'];
  try {
    state = { ...productUser(options.user), root, repo: join(root, 'repo'), out, deadline, signal, options, base: partBase(root, options.dir) };
    await productFolders(state);
    result = { status: 'ready', ...await syncedHarness(msg, state, hidden) };
  } catch (error) { result = { status: 'error', problem: syncProblem(error, signal, hidden) }; }
  finally { if (state) await leaveNothing(state).catch(() => {}); }
  return { type: 'tests.harness.done', requestId: msg.requestId, commitSha: msg.commitSha, result };
}
