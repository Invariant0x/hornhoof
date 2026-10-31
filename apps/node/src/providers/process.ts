import { spawn } from 'node:child_process';
import { closeSync, constants, fchownSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { JobUser } from '../isolation.js';
import type { LoginIo } from '../runner.js';
import type { ProgramExit } from '../program-exit.js';

/* Output kept in memory per run. The tail sent to Hornhoof is cut from the end of it. */
const KEEP_BYTES = 256 * 1024;
const KILL_GRACE_MS = 2000;

/* The node's own key and settings never reach the agent, which runs whatever its prompt asks. */
export function childEnv(tools: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (k !== 'NODE_KEY' && !k.startsWith('HORNHOOF_')) env[k] = v;
  env.PATH = `${tools}/bin:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`;
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
};

/* Runs a program with no input, reads stdout line by line and stops the whole process group at the timeout or when the signal aborts. */
export function runProgram({ bin, args, env, cwd, timeoutMs, signal, onLine, user }: SpawnOptions): Promise<Finished> {
  return new Promise(resolve => {
    const child = spawn(bin, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true, uid: user?.uid, gid: user?.gid });
    let output = '';
    let partial = '';
    let timedOut = false;
    const keep = (chunk: string) => {
      output += chunk;
      if (output.length > KEEP_BYTES) output = output.slice(-KEEP_BYTES);
    };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      keep(chunk);
      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) onLine?.(line);
    });
    child.stderr.setEncoding('utf8').on('data', keep);
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
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
    const finish = (res: Finished) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve(res);
    };
    child.on('error', err => finish({ code: null, signal: null, at: new Date().toISOString(), output: `${output}\n${err.message}`, timedOut }));
    child.on('close', (code, signal) => {
      if (partial) onLine?.(partial);
      finish({ code, signal, at: new Date().toISOString(), output, timedOut });
    });
  });
}

/* True when the program exits 0, for "am I signed in" checks. */
export async function exitsCleanly(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  const done = await runProgram({ bin, args, env, timeoutMs: 30_000 });
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
export function interactiveLogin(bin: string, args: string[], env: NodeJS.ProcessEnv, io: LoginIo): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
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

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
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

/* Installs an agent program into tools with npm; a failure carries the last lines npm printed. */
export async function installPackage(tools: string, pkg: string): Promise<void> {
  const done = await runProgram({ bin: 'npm', args: ['install', '-g', '--prefix', tools, pkg], env: childEnv(tools, {}), timeoutMs: 10 * 60_000 });
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
