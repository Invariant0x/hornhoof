import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobUser } from '../isolation.js';
import { programEnded, type ProgramExit } from '../program-exit.js';
import { KEEP_BYTES, writePrivate } from '../providers/process.js';

/* How agent sessions look and behave: no tmux bar, the wheel scrolls, the size follows the person who looks last, colours
   pass through, and a finished program leaves its last screen. */
const OPTIONS: string[][] = [
  ['status', 'off'],
  ['mouse', 'on'],
  ['focus-events', 'on'],
  ['window-size', 'latest'],
  ['escape-time', '0'],
  ['history-limit', '50000'],
  ['default-terminal', 'tmux-256color'],
  ['remain-on-exit', 'on'],
];

/* People watch through tmux clients, and tmux keys could take one to another agent's session, open its menus or run its
   commands. They get none: no prefix, so the prefix table is out of reach, and no keys without it but the wheel, which
   scrolls the history as it does by default. */
const KEYS: string[][] = [
  ['set-option', '-g', 'prefix', 'None'],
  ['set-option', '-g', 'prefix2', 'None'],
  ['unbind-key', '-a', '-T', 'root'],
  ['bind-key', '-n', 'WheelUpPane', 'if-shell', '-F', '#{||:#{alternate_on},#{pane_in_mode},#{mouse_any_flag}}', 'send-keys -M', 'copy-mode -e'],
];

export type Launch = { cwd: string; command: string[]; cols: number; rows: number; envFile?: string; outputDir?: string };
export type Client = { pid: number; tty: string; session: string };

type Options = {
  /* The tmux server's socket name, so agent sessions never mix with anyone else's tmux. */
  socket?: string;
  /* The env tmux and every program in it start from: never the node's own, which holds its key. */
  env: NodeJS.ProcessEnv;
  user?: JobUser | null;
};

/* Writes the env a program starts with into a file only its owner reads; the program's shell reads it and removes it, so the
   values never show on a command line. */
export function envFile(dir: string, env: Record<string, string>): string {
  const file = join(dir, `.hh-env-${randomBytes(8).toString('hex')}`);
  writeFileSync(file, Object.entries(env).map(([k, v]) => `${k}=${quote(v)}\n`).join(''), { mode: 0o600 });
  return file;
}

const FROM_ENV_FILE = 'set -a; . "$0"; set +a; rm -f "$0"; exec "$@"';
const WAIT_FOR_CAPTURE = 'IFS= read -r ready; exec "$@"';
const CAPTURE = fileURLToPath(new URL('../../hh-capture.cjs', import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
type Recording = { file: string; ready: string; ended: Promise<string | null> | null };

/* Even a damaged or replaced recording cannot make the host read an unbounded file or follow a link. */
function recorded(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const bytes = Math.min(stat.size, KEEP_BYTES);
    const buffer = Buffer.alloc(bytes);
    return buffer.subarray(0, readSync(fd, buffer, 0, bytes, stat.size - bytes)).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const integer = (value: string | undefined): number | null => value && /^-?\d+$/.test(value) ? Number(value) : null;
const endedAt = (value: string | undefined, observed: string): string => {
  const time = value ? new Date(Number(value) * 1000) : new Date(observed);
  return Number.isNaN(time.getTime()) ? observed : time.toISOString();
};

/* The node's tmux: one server, one session per agent. */
export class Tmux {
  readonly socket: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly user: JobUser | null;
  private readonly recordings = new Map<string, Recording>();

  constructor({ socket = 'hh', env, user = null }: Options) {
    this.socket = socket;
    this.env = { LANG: 'C.UTF-8', ...withoutNodeSecrets(env) };
    this.user = user;
  }

  /* The arguments that reach this server; viewers attach with them too. */
  base(): string[] {
    return ['-u', '-f', '/dev/null', '-L', this.socket];
  }

  run(args: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile('tmux', [...this.base(), ...args], { env: this.env, uid: this.user?.uid, gid: this.user?.gid, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
        err ? reject(new Error(String(stderr || err.message).trim())) : resolve(stdout),
      );
      if (input !== undefined) child.stdin?.end(input);
    });
  }

  async has(name: string): Promise<boolean> {
    return this.run(['has-session', '-t', `=${name}`]).then(
      () => true,
      () => false,
    );
  }

  /* A live program in the session's pane; false when the program ended or there is no such session. */
  async alive(name: string): Promise<boolean> {
    const dead = await this.run(['display-message', '-p', '-t', name, '#{pane_dead}']).catch(() => '1');
    return dead.trim() === '0';
  }

  /* Starts the program in a new session, or in place of whatever the session ran before. */
  async launch(name: string, { cwd, command, cols, rows, envFile: file, outputDir }: Launch): Promise<void> {
    const argv = file ? ['sh', '-c', FROM_ENV_FILE, file, ...command] : command;
    const has = await this.has(name);
    if (has) await this.ended(name);
    /* The program starts only after its recorder is listening, including programs that exit immediately. */
    const gated = outputDir ? ['sh', '-c', WAIT_FOR_CAPTURE, 'hh-start', ...argv] : argv;
    const start = has
      ? ['respawn-pane', '-k', '-c', cwd, '-t', name, ...gated]
      : ['new-session', '-d', '-s', name, '-x', String(cols), '-y', String(rows), '-c', cwd, ...gated];
    /* One command line, so the options hold before a program that ends at once could close the server. */
    const options = OPTIONS.flatMap(([option, value]) => ['set-option', '-g', option!, value!, ';']);
    /* A command that fails ends the line, so the keys come after the program has started. */
    const keys = KEYS.flatMap(c => [';', ...c]);
    await this.run(['start-server', ';', ...options, 'set-option', '-g', 'terminal-features', 'xterm-256color:RGB', ';', ...start, ...keys]);
    if (this.recordings.has(name)) await this.run(['pipe-pane', '-t', name]).catch(() => {});
    this.removeRecording(name);
    if (outputDir) {
      await this.capture(name, outputDir);
      await this.keys(name, 'Enter');
    }
  }

  private async capture(name: string, dir: string): Promise<void> {
    const file = join(dir, `.hh-output-${randomBytes(8).toString('hex')}.log`);
    const ready = `${file}.ready`;
    writePrivate(file, '', this.user);
    writePrivate(ready, '', this.user);
    this.recordings.set(name, { file, ready, ended: null });
    const command = [process.execPath, CAPTURE, file, ready, String(KEEP_BYTES), this.socket, name].map(quote).join(' ');
    await this.run(['pipe-pane', '-t', name, `exec ${command}`]);
    for (const end = Date.now() + 5000; recorded(ready) !== 'ready';) {
      if (Date.now() >= end) throw new Error('The terminal output recorder did not start.');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  /* Read before a pane can be respawned or removed. Keep the first observation time on tmux versions without one. */
  async ended(name: string): Promise<string | null> {
    const recording = this.recordings.get(name);
    if (recording?.ended) return recording.ended;
    const reading = this.readEnd(name);
    if (recording) recording.ended = reading;
    const output = await reading;
    if (recording && output === null) recording.ended = null;
    return output;
  }

  private async readEnd(name: string): Promise<string | null> {
    const exit = await this.paneExit(name);
    if (!exit) return null;
    const file = this.recordings.get(name)?.file;
    const output = (file ? recorded(file) : null) ?? await this.screen(name);
    return programEnded(output, exit);
  }

  private async paneExit(name: string): Promise<ProgramExit | null> {
    let observed: string | undefined;
    const deadline = Date.now() + 5000;
    for (;;) {
      const row = await this.run(['display-message', '-p', '-t', name, '#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}|#{pane_dead_time}']).catch(() => '');
      const [dead, status, signal, time] = row.trim().split('|');
      if (dead !== '1') return null;
      observed ??= new Date().toISOString();
      const code = integer(status);
      const number = integer(signal) || null;
      /* EOF can mark the pane dead before tmux reaps the process and fills in its native status. */
      if (code !== null || number !== null || Date.now() >= deadline) return { code, signal: number, at: endedAt(time, observed) };
      /* Some tmux builds leave a zombie until another child exits. Let tmux reap it before reading its status again. */
      await this.run(['run-shell', 'true']).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  private removeRecording(name: string): void {
    const recording = this.recordings.get(name);
    if (!recording) return;
    this.recordings.delete(name);
    rmSync(recording.file, { force: true });
    rmSync(recording.ready, { force: true });
  }

  /* Pastes text the way a terminal does, bracketed when the program asked for it, so a long prompt arrives as one paste. */
  async paste(name: string, text: string): Promise<void> {
    const buffer = `hh-${randomBytes(6).toString('hex')}`;
    await this.run(['load-buffer', '-b', buffer, '-'], text);
    await this.run(['paste-buffer', '-p', '-d', '-b', buffer, '-t', name]);
  }

  async keys(name: string, ...keys: string[]): Promise<void> {
    await this.run(['send-keys', '-t', name, ...keys]);
  }

  /* The screen as text with the lines above it, wrapped lines joined: the newest tmux moves a dead pane's text up there. */
  async screen(name: string, history = 200): Promise<string> {
    return this.run(['capture-pane', '-p', '-J', '-S', String(-history), '-t', name]).catch(() => '');
  }

  async clients(): Promise<Client[]> {
    const out = await this.run(['list-clients', '-F', '#{client_pid} #{client_tty} #{session_name}']).catch(() => '');
    return out
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [pid, tty, session] = line.split(' ');
        return { pid: Number(pid), tty: tty ?? '', session: session ?? '' };
      });
  }

  /* The program's process in the session's pane, or null when it ended. */
  async programPid(name: string): Promise<number | null> {
    if (!(await this.alive(name))) return null;
    const pid = Number((await this.run(['display-message', '-p', '-t', name, '#{pane_pid}']).catch(() => '')).trim());
    return pid > 0 ? pid : null;
  }

  async kill(name: string): Promise<void> {
    await this.ended(name);
    await this.run(['kill-session', '-t', `=${name}`]).catch(() => {});
    this.removeRecording(name);
  }

  async stopAll(): Promise<void> {
    for (const name of this.recordings.keys()) await this.ended(name);
    await this.run(['kill-server']).catch(() => {});
    for (const name of this.recordings.keys()) this.removeRecording(name);
  }

  /* A viewer: a terminal of its own size attached to the session, read-only unless the person may type. */
  attach(name: string, cols: number, rows: number, write: boolean) {
    const inner = `stty cols ${cols} rows ${rows}; exec tmux ${this.base().join(' ')} attach${write ? '' : ' -r'} -t '=${name}'`;
    /* script gives tmux a terminal without native modules. macOS has the BSD one, which needs a terminal of its own, so
       there Python's pty does it; nodes run on Linux. */
    const [bin, args] = process.platform === 'darwin' ? ['python3', ['-c', 'import pty,sys; pty.spawn(sys.argv[1:])', 'sh', '-c', inner]] : ['script', ['-qfec', inner, '/dev/null']];
    return spawn(bin, args, {
      env: { ...this.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      uid: this.user?.uid,
      gid: this.user?.gid,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
}

function withoutNodeSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (k !== 'NODE_KEY' && !k.startsWith('HORNHOOF_')) out[k] = v;
  return out;
}
