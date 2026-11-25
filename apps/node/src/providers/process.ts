import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, constants, fchownSync, fstatSync, lchownSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isRootUser, type JobUser } from '../isolation.js';
import type { LoginIo } from '../runner.js';
import type { ProgramExit } from '../program-exit.js';
import { agentEnv } from '../agent-env.js';

/* Output kept in memory per run. The tail sent to Hornhoof is cut from the end of it. */
export const KEEP_BYTES = 256 * 1024;
const KILL_GRACE_MS = 2000;

/* Inherit operating-system settings, then apply only the account and program settings Hornhoof chose. */
export function childEnv(tools: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = agentEnv(process.env);
  env.PATH = `${tools}/bin:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`;
  env.PLAYWRIGHT_BROWSERS_PATH = join(dirname(tools), 'browsers');
  env.PLAYWRIGHT_SKIP_BROWSER_GC = '1';
  return { ...env, ...extra };
}

export type Finished = ProgramExit & { output: string; timedOut: boolean };

type SpawnOptions = {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
  /* The built-in node runs each key's program as that key's user. */
  user?: JobUser | null;
  /* What the program reads on its standard input, which then ends. Without it, the program reads nothing. */
  input?: string;
};

/* A program reads a pipe when it has input, and nothing otherwise. */
const stdinFor = (input: string | undefined) => (input === undefined ? 'ignore' : 'pipe');

/* Gives a program its input and ends it. A program that ends before it read all of it only ends the writing: its exit
   tells how it went. */
function feed(child: ChildProcess, input: string | undefined): void {
  if (!child.stdin) return;
  child.stdin.on('error', () => {});
  child.stdin.end(input);
}

/* Runs a program, reads stdout line by line and stops the whole process group at the timeout or when the signal aborts. */
export function runProgram({ bin, args, env, cwd, timeoutMs, signal, onLine, user, input }: SpawnOptions): Promise<Finished> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { env, cwd, stdio: [stdinFor(input), 'pipe', 'pipe'], detached: true, uid: user?.uid, gid: user?.gid });
    } catch (err) {
      /* A program that cannot start as its user ends at once, as one that cannot be found does. */
      return resolve({ code: null, signal: null, at: new Date().toISOString(), output: err instanceof Error ? err.message : String(err), timedOut: false });
    }
    feed(child, input);
    let output = '';
    let partial = '';
    let timedOut = false;
    /* A line the reader cannot take is left out; it never ends the node with all its runs. */
    const take = (line: string) => {
      try {
        onLine?.(line);
      } catch {
        /* Left out. */
      }
    };
    const keep = (chunk: string) => {
      output += chunk;
      if (output.length > KEEP_BYTES) output = output.slice(-KEEP_BYTES);
    };
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      keep(chunk);
      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) take(line);
    });
    child.stderr!.setEncoding('utf8').on('data', keep);
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, sig);
      } catch {
        /* Already gone. */
      }
    };
    const stop = () => {
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref();
    };
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs) : undefined;
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
    const finish = (res: Finished) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve(res);
    };
    child.on('error', err => finish({ code: null, signal: null, at: new Date().toISOString(), output: `${output}\n${err.message}`, timedOut }));
    child.on('close', (code, signal) => {
      if (partial) take(partial);
      finish({ code, signal, at: new Date().toISOString(), output, timedOut });
    });
  });
}

/* True when the program exits 0, for "am I signed in" checks. They run as the agents' user, as the program may write
   into their home. */
export async function exitsCleanly(bin: string, args: string[], env: NodeJS.ProcessEnv, user: JobUser | null = null): Promise<boolean> {
  const done = await runProgram({ bin, args, env, timeoutMs: 30_000, user });
  return done.code === 0;
}

const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]/g;
const HYPERLINK = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

export const stripEscapes = (text: string): string => text.replace(ESCAPES, '');

/* The last https link a login prints, with colors removed. A terminal hyperlink counts by its target, whatever its text says. */
export function lastUrl(text: string): string | null {
  const found = stripEscapes(text.replace(HYPERLINK, ' $1 ')).match(/https:\/\/[^\s"'<>]+/g);
  return found ? found[found.length - 1]! : null;
}

/* Runs a login program with the person's terminal: their typing goes in, its output comes back, and the link is saved for the installer to open. */
export function interactiveLogin(bin: string, args: string[], env: NodeJS.ProcessEnv, io: LoginIo, user: JobUser | null = null): Promise<void> {
  return new Promise((resolve, reject) => {
    /* The sign-in is written as the agents' user, who read it. */
    const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'], uid: user?.uid, gid: user?.gid });
    let seen = '';
    const echo = (chunk: Buffer) => {
      io.output.write(chunk);
      seen = (seen + chunk.toString('utf8')).slice(-8192);
      const url = lastUrl(seen);
      if (url) writeFileSync(io.urlFile, url + '\n');
    };
    child.stdout.on('data', echo);
    child.stderr.on('data', echo);
    io.input.pipe(child.stdin);
    child.on('error', reject);
    child.on('close', code => {
      io.input.unpipe(child.stdin);
      if (code === 0) resolve();
      else reject(new Error(`Sign-in ended with code ${code}.`));
    });
  });
}

/* Asks for a key without showing it on screen. */
export function askHidden(io: LoginIo, question: string): Promise<string> {
  return new Promise(resolve => {
    io.output.write(question);
    const input = io.input as NodeJS.ReadStream;
    const raw = typeof input.setRawMode === 'function' && input.isTTY;
    if (raw) input.setRawMode(true);
    let typed = '';
    const onData = (chunk: Buffer | string) => {
      for (const ch of chunk.toString()) {
        if (ch === '\r' || ch === '\n') {
          input.off('data', onData);
          if (raw) input.setRawMode(false);
          io.output.write('\n');
          resolve(typed.trim());
          return;
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f') typed = typed.slice(0, -1);
        else typed += ch;
      }
    };
    input.on('data', onData);
    input.resume();
  });
}

/* The first line that comes in, trimmed; what came before the end when no line ends. */
export function firstLine(input: NodeJS.ReadableStream): Promise<string> {
  return new Promise(resolve => {
    let text = '';
    const finish = () => {
      input.off('data', onData);
      input.off('end', finish);
      input.pause();
      resolve(text.split('\n')[0]!.trim());
    };
    const onData = (chunk: Buffer | string) => {
      text += chunk.toString();
      if (text.includes('\n')) finish();
    };
    input.on('data', onData);
    input.on('end', finish);
    input.resume();
  });
}

/* A file only the program's user may read, such as a config that carries a token. The folder is the agent's, so whatever it left at the path goes first and nothing is followed. */
export function writePrivate(path: string, content: string, user: JobUser | null): void {
  rmSync(path, { force: true });
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, content);
    if (user) fchownSync(fd, user.uid, user.gid);
  } finally {
    closeSync(fd);
  }
}

/* A file in an agent's home, read by the node: null for a link or a second name an agent could have put there to a file
   only the node reads, such as its key, and for anything that is not a plain file. */
export function readPrivate(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    return st.isFile() && st.nlink === 1 ? readFileSync(fd, 'utf8') : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

/* A folder in the agent's own folder that its program's user may use. The node may run as root there, where the agent
   could leave a link: it hands over a real folder only, and never what a link points to (lstat and lchown). */
export function agentDir(path: string, user: JobUser | null): string {
  mkdirSync(path, { recursive: true });
  if (!user) return path;
  if (!lstatSync(path).isDirectory()) throw new Error(`${path} is not a folder.`);
  lchownSync(path, user.uid, user.gid);
  return path;
}

/* String values long enough to be tokens, from a credentials file the agent program keeps. */
export function tokensIn(path: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
  const found: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string' && v.length >= 20) found.push(v);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(data);
  return found;
}

/* A fresh 0700 folder in the system's sticky temporary directory belongs only to the installer (root on a root node).
   Never use the inherited HOME, TMPDIR, PATH or npm settings for a privileged installation. */
export async function withTrustedInstall<T>(work: (env: NodeJS.ProcessEnv, cwd: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync('/tmp/hh-install-');
  try {
    writeFileSync(join(home, '.npmrc'), '');
    writeFileSync(join(home, 'global.npmrc'), '');
    writeFileSync(join(home, 'package.json'), '{}');
    const path = '/usr/local/bin:/usr/bin:/bin';
    const env: NodeJS.ProcessEnv = {
      PATH: isRootUser() ? path : process.env.PATH || path,
      HOME: home, TMPDIR: home, LANG: 'C.UTF-8',
      NPM_CONFIG_USERCONFIG: join(home, '.npmrc'),
      NPM_CONFIG_GLOBALCONFIG: join(home, 'global.npmrc'),
      NPM_CONFIG_CACHE: join(home, 'cache'),
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
      NPM_CONFIG_WORKSPACES: 'false',
    };
    return await work(env, home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export function runInstaller(options: Pick<SpawnOptions, 'bin' | 'args' | 'timeoutMs'>): Promise<Finished> {
  return withTrustedInstall((env, cwd) => runProgram({ ...options, env, cwd }));
}

/* npm moves the program's folder aside under a name that never changes while it puts the new one in, and removes it at
   the end. An installation cut off half way, when the machine slept or shut down, leaves it there, and every later one
   ends with ENOTEMPTY when npm moves the program aside again. A node's installations of a program never overlap, so one
   found before npm starts is such a leftover. */
function clearSetAside(tools: string, pkg: string): void {
  const dir = join(tools, 'lib', 'node_modules', dirname(pkg));
  const aside = new RegExp(`^\\.${basename(pkg).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[A-Za-z0-9]{8}$`);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) if (aside.test(name)) rmSync(join(dir, name), { recursive: true, force: true });
}

/* Installs an agent program into tools with npm; a failure carries the last lines npm printed. */
export async function installPackage(tools: string, pkg: string): Promise<void> {
  clearSetAside(tools, pkg);
  const done = await runInstaller({ bin: 'npm', args: ['install', '-g', '--prefix', tools, `${pkg}@latest`], timeoutMs: 10 * 60_000 });
  if (done.code === 0) return;
  const last = stripEscapes(done.output).trim().split('\n').slice(-5).join('\n');
  throw new Error(done.timedOut ? 'npm did not finish within 10 minutes.' : last || `npm ended with code ${done.code}.`);
}

/* The thinking levels a program lists for a model, as Hornhoof can pass them on, and its default when it is one of them. */
export function withEfforts(levels: unknown[], fallback: unknown): { efforts?: string[]; defaultEffort?: string } {
  const efforts = levels.filter((l): l is string => typeof l === 'string' && /^[a-z]{1,16}$/.test(l)).slice(0, 8);
  if (!efforts.length) return {};
  return typeof fallback === 'string' && efforts.includes(fallback) ? { efforts, defaultEffort: fallback } : { efforts };
}
