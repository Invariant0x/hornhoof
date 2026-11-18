import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { constants, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrivateValues } from '@hornhoof/protocol';
import type { JobUser } from '../isolation.js';
import { agentEnv, RESET_AGENT_ENV } from '../agent-env.js';
import { withProgramExit, type ProgramExit } from '../program-exit.js';
import { KEEP_BYTES, stripEscapes } from '../providers/process.js';
import { recorded, recordedAfter, recordingCursor, Recordings, type ExitSnapshot, type RecordingCursor } from './recordings.js';
import { PrivateStreamMask } from './mask.js';

/* How agent sessions look and behave: no tmux bar, the wheel scrolls, the size is the smallest window's of the people
   watching (the node gives them all that size), colours pass through, and a finished program leaves its last screen. */
const OPTIONS: string[][] = [
  ['status', 'off'],
  ['mouse', 'on'],
  ['focus-events', 'on'],
  ['window-size', 'smallest'],
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
  ['bind-key', '-n', 'WheelUpPane', 'if-shell', '-F', '#{||:#{alternate_on},#{||:#{pane_in_mode},#{mouse_any_flag}}}', 'send-keys -M', 'copy-mode -e'],
];

export type Launch = { cwd: string; command: string[]; cols: number; rows: number; envFile?: string; outputDir?: string };
export type Client = { pid: number; tty: string; session: string; cols: number; rows: number };

type Options = {
  /* The tmux server's socket name, so agent sessions never mix with anyone else's tmux. */
  socket?: string;
  /* The env tmux and every program in it start from: never the node's own, which holds its key. */
  env: NodeJS.ProcessEnv;
  user?: JobUser | null;
  /* Persistent node-owned metadata, kept on the same volume as the agent workspaces. */
  recordingsDir?: string;
  flushTimeoutMs?: number;
};

/* Writes the env a program starts with into a file only its owner reads; the program's shell reads it and removes it, so the
   values never show on a command line. */
export function envFile(dir: string, env: Record<string, string>): string {
  const file = join(dir, `.hh-env-${randomBytes(8).toString('hex')}`);
  writeFileSync(file, Object.entries(env).map(([k, v]) => `${k}=${quote(v)}\n`).join(''), { mode: 0o600 });
  return file;
}

const FROM_ENV_FILE = `${RESET_AGENT_ENV}; set -a; . "$0"; set +a; rm -f "$0"; exec "$@"`;
const FROM_MACHINE = `${RESET_AGENT_ENV}; exec "$@"`;
const WAIT_FOR_CAPTURE = 'IFS= read -r ready; exec "$@"';
/* Shows a screen kept in a file, which goes with it. */
const SHOW_FILE = 'cat "$0"; rm -f "$0"';
const CAPTURE = fileURLToPath(new URL('../../hh-capture.cjs', import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const integer = (value: string | undefined): number | null => value && /^-?\d+$/.test(value) ? Number(value) : null;
/* tmux 3.6 names the signal ("kill") where older versions give its number. */
const signalOf = (value: string | undefined): NodeJS.Signals | number | null => {
  const name = `SIG${(value ?? '').toUpperCase()}`;
  return integer(value) || (value && name in constants.signals ? (name as NodeJS.Signals) : null);
};
const endedAt = (value: string | undefined, observed: string): string => {
  const time = value ? new Date(Number(value) * 1000) : new Date(observed);
  return Number.isNaN(time.getTime()) ? observed : time.toISOString();
};

/* The node's tmux: one server, one session per agent. */
export class Tmux {
  readonly socket: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly user: JobUser | null;
  private readonly recordings: Recordings;
  private readonly masks = new Map<string, PrivateValues>();
  private readonly flushTimeoutMs: number;

  constructor({ socket = 'hh', env, user = null, recordingsDir = join(env.HOME ?? homedir(), '.hh-recordings'), flushTimeoutMs = 5000 }: Options) {
    this.socket = socket;
    this.env = { LANG: 'C.UTF-8', ...agentEnv(env) };
    this.user = user;
    this.recordings = new Recordings(recordingsDir, socket, user);
    this.flushTimeoutMs = flushTimeoutMs;
  }

  /* Where a session's settings and output go: the node's own folder, not the agent's. */
  scratch(): string {
    return this.recordings.privateDir();
  }

  outputValues(name: string): PrivateValues {
    let values = this.masks.get(name);
    if (!values) this.masks.set(name, values = new PrivateValues());
    return values;
  }

  maskRecording(name: string): Promise<void> {
    return this.recordings.mask(name, this.outputValues(name).forms());
  }

  /* The arguments that reach this server; viewers attach with them too. */
  base(): string[] {
    return ['-u', '-f', '/dev/null', '-L', this.socket];
  }

  run(args: string[], input?: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile('tmux', [...this.base(), ...args], { env: this.env, uid: this.user?.uid, gid: this.user?.gid, maxBuffer: 8 * 1024 * 1024, signal }, (err, stdout, stderr) =>
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
    const argv = file ? ['sh', '-c', FROM_ENV_FILE, file, ...command] : ['sh', '-c', FROM_MACHINE, 'hh-program', ...command];
    const has = await this.has(name);
    if (has) await this.ended(name);
    /* tmux starts the program on an empty screen: what the last one showed goes above it first, with what it printed before. */
    if (has) await this.screenAbove(name);
    /* The program starts only after its recorder is listening, including programs that exit immediately. */
    const recording = outputDir;
    const gated = recording ? ['sh', '-c', WAIT_FOR_CAPTURE, 'hh-start', ...argv] : argv;
    const start = has
      ? ['respawn-pane', '-k', '-c', cwd, '-t', name, ...gated]
      : ['new-session', '-d', '-s', name, '-x', String(cols), '-y', String(rows), '-c', cwd, ...gated];
    /* One command line, so the options hold before a program that ends at once could close the server. */
    const options = OPTIONS.flatMap(([option, value]) => ['set-option', '-g', option!, value!, ';']);
    /* A command that fails ends the line, so the keys come after the program has started. */
    const keys = KEYS.flatMap(c => [';', ...c]);
    await this.run(['start-server', ';', ...options, 'set-option', '-g', 'terminal-features', 'xterm-256color:RGB', ';', ...start, ...keys]);
    await this.clearRecording(name);
    if (recording) {
      await this.capture(name, outputDir);
      await this.maskRecording(name);
      await this.keys(name, 'Enter');
    }
  }

  /* Restarts a silent recorder once while the pane still waits on read before running the program. */
  private async capture(name: string, dir: string): Promise<void> {
    if (await this.startRecorder(name, dir)) return;
    await this.clearRecording(name);
    if (await this.startRecorder(name, dir)) return;
    await this.clearRecording(name);
    throw new Error('The terminal output recorder did not start.');
  }

  private async startRecorder(name: string, dir: string): Promise<boolean> {
    const recording = this.recordings.create(name, dir, true);
    const command = [process.execPath, CAPTURE, recording.file, recording.ready, recording.flush, String(KEEP_BYTES), this.socket, name, recording.position, recording.control!].map(quote).join(' ');
    await this.run(['pipe-pane', '-t', name, `exec ${command}`]);
    return this.recordings.wait(recording, 'ready', 5000);
  }

  private async clearRecording(name: string): Promise<void> {
    await this.stopRecording(name);
    this.recordings.remove(name);
  }

  /* Read before a pane can be respawned or removed. Keep the first observation time on tmux versions without one. */
  async ended(name: string): Promise<string | null> {
    return (await this.exitSnapshot(name))?.output ?? null;
  }

  exitSnapshot(name: string): Promise<ExitSnapshot | null> {
    return this.recordings.snapshot(name, () => this.readEnd(name));
  }

  /* Local evidence while a program runs, including stderr its next screen redraw erased. */
  programOutput(name: string, after?: RecordingCursor): string | null {
    const recording = this.recordings.get(name);
    return recording ? after ? recordedAfter(recording, after) : recorded(recording.file) : null;
  }

  async programCursor(name: string): Promise<RecordingCursor | null> {
    const recording = this.recordings.get(name);
    if (!recording) return null;
    for (const deadline = Date.now() + 1000;; await new Promise(resolve => setTimeout(resolve, 10))) {
      const cursor = recordingCursor(recording);
      if (cursor || Date.now() >= deadline) return cursor;
    }
  }

  private async readEnd(name: string): Promise<ExitSnapshot | null> {
    const exit = await this.paneExit(name);
    if (!exit) return null;
    const recording = this.recordings.get(name);
    const snapshot = recording ? await this.recordings.finish(recording, this.flushTimeoutMs) : null;
    const complete = snapshot?.complete ?? !recording;
    const text = snapshot?.output ?? this.maskedScreen(name, await this.screen(name));
    return { ...withProgramExit(text, exit, complete), complete };
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
      const number = signalOf(signal);
      /* EOF can mark the pane dead before tmux reaps the process and fills in its native status. */
      if (code !== null || number !== null || Date.now() >= deadline) return { code, signal: number, at: endedAt(time, observed) };
      /* Some tmux builds leave a zombie until another child exits. Let tmux reap it before reading its status again. */
      await this.run(['run-shell', 'true']).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  /* Pastes text the way a terminal does, bracketed when the program asked for it, so a long prompt arrives as one paste. A paste
     into a pane whose program ended kills tmux 3.3a with every session it holds, so the server looks and pastes in one step, and
     a program that ended gets nothing. */
  async paste(name: string, text: string): Promise<void> {
    const buffer = `hh-${randomBytes(6).toString('hex')}`;
    /* Embedded terminal controls must not end the paste or become keystrokes. Keep only newline and tab. */
    const clean = text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
    await this.run(['load-buffer', '-b', buffer, '-'], clean);
    await this.run(['if-shell', '-F', '-t', name, '#{pane_dead}', `delete-buffer -b ${buffer}`, `paste-buffer -p -d -b ${buffer} -t ${quote(name)}`]);
  }

  async keys(name: string, ...keys: string[]): Promise<void> {
    await this.run(['send-keys', '-t', name, ...keys]);
  }

  /* The screen as text with the lines above it, wrapped lines joined: the newest tmux moves a dead pane's text up there. */
  async screen(name: string, history = 200, styled = false): Promise<string> {
    return this.run(['capture-pane', '-p', ...(styled ? ['-e'] : []), '-J', '-S', String(-history), '-t', name]).catch(() => '');
  }

  async clients(): Promise<Client[]> {
    const out = await this.run(['list-clients', '-F', '#{client_pid} #{client_tty} #{session_name} #{client_width} #{client_height}']).catch(() => '');
    return out
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [pid, tty, session, cols, rows] = line.split(' ');
        return { pid: Number(pid), tty: tty ?? '', session: session ?? '', cols: Number(cols), rows: Number(rows) };
      });
  }

  /* The agents whose programs run in this server's sessions, one session each; none when the server runs none. */
  async livePrograms(): Promise<string[]> {
    const panes = await this.run(['list-panes', '-a', '-F', '#{session_name} #{pane_dead}']).catch(() => '');
    return panes.split('\n').flatMap(line => /^a-(\S+) 0$/.exec(line)?.slice(1) ?? []);
  }

  /* The program's process in the session's pane, or null when it ended. */
  async programPid(name: string): Promise<number | null> {
    if (!(await this.alive(name))) return null;
    const pid = Number((await this.run(['display-message', '-p', '-t', name, '#{pane_pid}']).catch(() => '')).trim());
    return pid > 0 ? pid : null;
  }

  /* Ends the program in the session and keeps its pane, with all the program printed, for a person to scroll back through:
     the next program starts in that pane. tmux ends it as it ends a session's, and the pane shows again what it showed last. */
  async stop(name: string): Promise<void> {
    if (!(await this.has(name))) return;
    await this.stopRecording(name);
    await this.showInPane(name, await this.shown(name));
    this.recordings.remove(name);
  }

  private async stopRecording(name: string): Promise<void> {
    if (this.recordings.get(name)) await this.run(['pipe-pane', '-t', name]).catch(() => {});
  }

  /* Moves what the pane shows into its history, ending the program there if one runs. */
  private async screenAbove(name: string): Promise<void> {
    await this.stopRecording(name);
    const shown = await this.shown(name);
    if (!shown) return;
    const rows = Number((await this.run(['display-message', '-p', '-t', name, '#{pane_height}']).catch(() => '')).trim()) || 0;
    await this.showInPane(name, `${shown}${'\n'.repeat(rows)}`);
  }

  /* What the pane shows, in its colours, without the line tmux puts under a program that ended. */
  private async shown(name: string): Promise<string> {
    const lines = (await this.run(['capture-pane', '-p', '-e', '-t', name]).catch(() => '')).split('\n').filter(line => !/^Pane is dead/.test(stripEscapes(line)));
    while (lines.length && !stripEscapes(lines.at(-1)!).trim()) lines.pop();
    return lines.length ? this.maskedScreen(name, `${lines.join('\n')}\x1b[0m`) : '';
  }

  maskedScreen(name: string, text: string): string {
    const mask = new PrivateStreamMask(() => this.outputValues(name).forms());
    return mask.push(text) + mask.end();
  }

  /* The pane shows these words in place of its program, which tmux ends as it ends a session's, and keeps them once shown. */
  private async showInPane(name: string, words: string): Promise<void> {
    const file = join(this.scratch(), `.hh-screen-${randomBytes(8).toString('hex')}`);
    writeFileSync(file, words, { mode: 0o600 });
    await this.run(['respawn-pane', '-k', '-t', name, 'sh', '-c', SHOW_FILE, file]).catch(error => {
      rmSync(file, { force: true });
      throw error;
    });
    while (await this.alive(name)) await new Promise(resolve => setTimeout(resolve, 10));
  }

  async kill(name: string): Promise<void> {
    await this.ended(name);
    const removed = await this.removeSession(name);
    this.recordings.remove(name);
    if (removed) this.masks.delete(name);
  }

  private async removeSession(name: string): Promise<boolean> {
    try { await this.run(['kill-session', '-t', `=${name}`]); return true; }
    catch { return !(await this.has(name)); }
  }

  async stopAll(): Promise<void> {
    for (const recording of this.recordings.all()) await this.ended(recording.name);
    await this.run(['kill-server']).catch(() => {});
    for (const recording of this.recordings.all()) this.recordings.remove(recording.name);
    this.masks.clear();
  }

  /* The terminal the node's own process runs in, attached to the session: the person who ran the install command sees the
     program's screen and answers it. It lets go when the session ends. */
  attachHere(name: string) {
    return spawn('tmux', [...this.base(), 'attach', '-t', `=${name}`], { env: { ...this.env, TERM: process.env.TERM ?? 'xterm-256color' }, uid: this.user?.uid, gid: this.user?.gid, stdio: 'inherit' });
  }

  /* Has tmux draw a client's whole screen again. */
  async repaint(tty: string): Promise<void> {
    await this.run(['refresh-client', '-t', tty]).catch(() => '');
  }

  /* A viewer: a terminal of its own size attached to the session, read-only unless the person may type. Its client stays on
     the normal screen of the browser's terminal, where lines that scroll off stay as its history: an alternate screen
     keeps none. */
  attach(name: string, cols: number, rows: number, write: boolean) {
    const inner = `stty cols ${cols} rows ${rows}; exec tmux ${this.base().join(' ')} set-option -s 'terminal-overrides[9]' 'xterm-256color:smcup@:rmcup@:csr@' \\; attach${write ? '' : ' -r'} -t '=${name}'`;
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
