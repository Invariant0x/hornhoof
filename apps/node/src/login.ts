import type { ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { TERM_CHUNK, type NodeMessage, type ServerMessage } from '@hornhoof/protocol';
import { SIGNIN_ERRORS } from '@hornhoof/protocol/signin';
import { ownFs, type AgentFs } from './agent-fs.js';
import { applyCredential, takeLease } from './credentials.js';
import { asAgent, type JobUser } from './isolation.js';
import { lastWords, plainOutput } from './program-exit.js';
import { exitsCleanly } from './providers/process.js';
import { HIDDEN, hideKeyLike, redact } from './redact.js';
import { parentOf } from './terminal/views.js';
import { StreamMask } from './terminal/mask.js';
import { envFile, type Tmux } from './terminal/tmux.js';

/* The agent key Hornhoof opens the sign-in terminal with. Agents' keys are ids, so no agent has it. */
export const LOGIN_KEY = 'login';
const SESSION = 'login';

/* What a node needs to run its plan's sign-in: the program, a tmux server of its own, apart from the agents', and the
   env the program starts from. */
export type LoginSetup = { provider: 'claude' | 'codex'; bin: string; tmux: Tmux; env: NodeJS.ProcessEnv; user?: JobUser | null; fs?: AgentFs };

/* The sign-in each program has for a machine with no browser. Claude Code's setup-token prints a token that lasts a year,
   which every machine of the plan can use; Codex signs in with a device code. */
export const LOGIN_ARGS: Record<LoginSetup['provider'], string[]> = { claude: ['setup-token'], codex: ['login', '--device-auth'] };

const TOKEN_START = 'sk-ant-oat01-';
const TOKEN_LINE = /^[A-Za-z0-9_-]+$/;

/* The last long token in what setup-token printed. A narrow screen wraps it, so lines of token letters alone that follow
   it are its rest. */
export function tokenIn(text: string): string | null {
  const lines = plainOutput(text).split('\n').map(l => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lines[i]!.lastIndexOf(TOKEN_START);
    if (at < 0) continue;
    let token = /^sk-ant-oat01-[A-Za-z0-9_-]*/.exec(lines[i]!.slice(at))![0];
    if (at + token.length === lines[i]!.length) for (let j = i + 1; j < lines.length && TOKEN_LINE.test(lines[j]!); j++) token += lines[j];
    return token.length >= TOKEN_START.length + 20 ? token : null;
  }
  return null;
}

/* Hides everything from the first start of a token on: a token wraps on a narrow screen, so its rest cannot be told
   from other text, and setup-token prints nothing worth seeing after it. A piece at the end that could be the start
   waits for the next piece. */
export class CutAtToken {
  private held = '';
  private cut = false;

  push(chunk: string): string {
    if (this.cut) return '';
    const text = this.held + chunk;
    this.held = '';
    const at = text.indexOf(TOKEN_START);
    if (at >= 0) {
      this.cut = true;
      return text.slice(0, at) + HIDDEN;
    }
    let keep = 0;
    for (let n = Math.min(TOKEN_START.length - 1, text.length); n > 0; n--) {
      if (text.endsWith(TOKEN_START.slice(0, n))) {
        keep = n;
        break;
      }
    }
    this.held = text.slice(text.length - keep);
    return text.slice(0, text.length - keep);
  }
}

/* How a sign-in's program ended, with its last lines through the node's masks, for the machine's output. Once a token's
   start is among them, none go. */
function endedEarly(code: number | null, text: string, secrets: string[]): string {
  const plain = plainOutput(text);
  const last = plain.includes(TOKEN_START) ? [] : plain.split('\n').map(l => hideKeyLike(redact(l.trim(), secrets))).filter(Boolean).slice(-6);
  return `The sign-in program ended with code ${code ?? 'unknown'}${last.length ? `: ${last.join(' | ')}` : '.'}`;
}

type Msg<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;
type View = { child: ChildProcess; write: boolean };

type Options = {
  setup: LoginSetup;
  /* The node's folder and the plan's home, where the sign-in it gets is kept. */
  dir: string;
  home: string;
  send(m: NodeMessage): void;
  /* Values that never reach a screen people watch. */
  secrets(): string[];
  /* After a sign-in was kept: what the screens hide and whether the program is signed in, said at once. */
  signedIn(): Promise<void>;
  /* Installs the program when it is missing, before its sign-in starts. */
  install?: () => Promise<void>;
  /* The machine's own output, for how a sign-in's program ended when it ended with an error. */
  log?: (line: string) => void;
  pollMs?: number;
};

const { stopped: STOPPED, unfinished: UNFINISHED, notTaken: NOT_TAKEN, broke: BROKE, noProgram: NO_PROGRAM } = SIGNIN_ERRORS;
/* The sign-in's window is never narrower: Claude Code wraps its token at the window's width, and the start of a token is
   how the node finds it to cut it from what the owner sees. */
const MIN_COLS = 80;
const MIN_ROWS = 10;

/* One sign-in at a time, in a tmux session the plan's owner watches and types into. It runs in a folder of its own, so
   the sign-in the plan has stays until the new one is complete. */
export class LoginTerminal {
  private readonly views = new Map<string, View>();
  private readonly fs: AgentFs;
  private readonly user: JobUser | null;
  private readonly pollMs: number;
  /* Counts sign-ins, so one that was stopped or replaced does nothing when its program ends. */
  private run = 0;
  /* A sign-in was asked for and has not ended yet. */
  private active = false;
  private watch: NodeJS.Timeout | null = null;
  private looking = false;
  /* Starts, stops and ends go one after another, so none of them ends the session another one just started. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: Options) {
    this.fs = opts.setup.fs ?? ownFs;
    this.user = opts.setup.user ?? null;
    this.pollMs = opts.pollMs ?? 250;
  }

  private get tmux(): Tmux {
    return this.opts.setup.tmux;
  }

  /* Where the program signs in: inside the plan's home, which the agents' user owns. */
  private get scratch(): string {
    return join(this.opts.home, '.hh-login');
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work);
    this.chain = next.catch(() => {});
    return next;
  }

  /* What a sign-in left before the node started: its session and its folder. */
  async clear(): Promise<void> {
    await this.tmux.stopAll();
    await this.fs.remove(this.scratch).catch(() => {});
  }

  /* Every sign-in runs in an empty folder, so a fresh one needs nothing more: the browser picks the account. A second
     start replaces the running sign-in. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- every sign-in already starts in an empty folder
  start(_fresh: boolean): Promise<void> {
    const run = ++this.run;
    this.active = true;
    return this.serial(() => this.begin(run));
  }

  stop(): Promise<void> {
    if (!this.active) return Promise.resolve();
    const run = ++this.run;
    return this.serial(() => this.finish(run, STOPPED));
  }

  /* The node stops: the sign-in goes with it, and nothing of it stays. */
  shutdown(): Promise<void> {
    this.run++;
    this.active = false;
    this.stopWatch();
    this.closeViews();
    return this.serial(() => this.clear());
  }

  private async begin(run: number): Promise<void> {
    this.stopWatch();
    await this.end();
    if (run !== this.run) return;
    if (!(await this.installed(run)) || run !== this.run) return;
    try {
      await this.fs.mkdir(this.scratch);
      const { provider, bin, env } = this.opts.setup;
      const homeVar = provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
      const programEnv = Object.fromEntries(Object.entries({ ...env, HOME: this.scratch, [homeVar]: this.scratch }).filter((e): e is [string, string] => typeof e[1] === 'string'));
      const command = [bin, ...LOGIN_ARGS[provider]];
      const scratch = this.tmux.scratch();
      await this.tmux.launch(SESSION, { cwd: this.scratch, command: this.user ? asAgent(command, this.user) : command, cols: 200, rows: 50, envFile: envFile(scratch, programEnv), outputDir: scratch });
    } catch {
      return this.finish(run, BROKE);
    }
    this.watch = setInterval(() => void this.look(run), this.pollMs);
    this.watch.unref();
  }

  /* The plan's program, installed when it is missing; false once the sign-in ended because it could not be. */
  private async installed(run: number): Promise<boolean> {
    try {
      await this.opts.install?.();
      return true;
    } catch {
      await this.finish(run, NO_PROGRAM);
      return false;
    }
  }

  private stopWatch(): void {
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
  }

  private async look(run: number): Promise<void> {
    if (this.looking || run !== this.run) return;
    this.looking = true;
    try {
      if (await this.tmux.alive(SESSION)) return;
      this.stopWatch();
      await this.serial(() => this.ended(run));
    } finally {
      this.looking = false;
    }
  }

  /* The program ended: what it gave is kept if it is a sign-in its program takes. */
  private async ended(run: number): Promise<void> {
    let error: string | null = null;
    /* A program that ended early: its code and the last line it said, which the owner reads instead of the plain words. */
    let early: { code: number | null; line: string | null } | null = null;
    try {
      const snapshot = await this.tmux.exitSnapshot(SESSION);
      const screen = await this.tmux.screen(SESSION, 2000);
      if (run !== this.run) return;
      const code = snapshot?.programOutput?.code ?? null;
      if (code !== 0) {
        const text = snapshot?.programOutput?.text || screen;
        this.opts.log?.(endedEarly(code, text, this.opts.secrets()));
        early = { code, line: plainOutput(text).includes(TOKEN_START) ? null : lastWords(text, this.opts.secrets()) };
      }
      error = code !== 0 ? UNFINISHED : await this.keep(run, snapshot?.programOutput?.text ?? '', screen);
    } catch {
      error = BROKE;
    }
    if (run !== this.run) return;
    /* A sign-in kept is done: a stop that comes now has nothing left to stop. */
    if (error === null) this.active = false;
    await this.finish(run, error, early);
  }

  /* Takes the new sign-in into the plan's home; the words of what went wrong, or null. One stopped while its program
     checks it keeps nothing. */
  private async keep(run: number, output: string, screen: string): Promise<string | null> {
    const { provider, bin, env } = this.opts.setup;
    const { dir, home } = this.opts;
    const programEnv = { ...env, HOME: this.scratch };
    if (provider === 'claude') {
      const token = tokenIn(output) ?? tokenIn(screen);
      if (!token) return UNFINISHED;
      if (!(await exitsCleanly(bin, ['auth', 'status'], { ...programEnv, CLAUDE_CONFIG_DIR: this.scratch, CLAUDE_CODE_OAUTH_TOKEN: token }, this.user))) return NOT_TAKEN;
      if (run !== this.run) return STOPPED;
      applyCredential(dir, home, 'claude_token', new TextEncoder().encode(token), this.user);
      return null;
    }
    if (!(await exitsCleanly(bin, ['login', 'status'], { ...programEnv, CODEX_HOME: this.scratch }, this.user))) return NOT_TAKEN;
    /* Read as the agents' user, who could have put a link there. */
    const auth = await this.fs.read(join(this.scratch, 'auth.json'));
    if (auth === null) return NOT_TAKEN;
    if (run !== this.run) return STOPPED;
    /* The machine that signed in holds the plan's Codex sign-in, which Codex renews. */
    takeLease(dir);
    applyCredential(dir, home, 'codex_auth', new TextEncoder().encode(auth), this.user);
    return null;
  }

  private async finish(run: number, error: string | null, early: { code: number | null; line: string | null } | null = null): Promise<void> {
    this.stopWatch();
    await this.end();
    if (run !== this.run) return;
    this.active = false;
    if (error === null) await this.opts.signedIn().catch(() => {});
    this.opts.send({ type: 'login.done', ok: error === null, error, ...(early ?? {}) });
  }

  /* The session, its views and its folder go. */
  private async end(): Promise<void> {
    this.closeViews();
    await this.tmux.kill(SESSION).catch(() => {});
    await this.fs.remove(this.scratch).catch(() => {});
  }

  owns(termId: string): boolean {
    return this.views.has(termId);
  }

  async open(m: Msg<'term.open'>): Promise<void> {
    if (!this.active || !(await this.tmux.alive(SESSION))) return void this.opts.send({ type: 'term.exit', termId: m.termId });
    const child = this.tmux.attach(SESSION, Math.max(m.cols, MIN_COLS), Math.max(m.rows, MIN_ROWS), m.write);
    this.views.set(m.termId, { child, write: m.write });
    const cut = new CutAtToken();
    const mask = new StreamMask(this.opts.secrets);
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let timer: NodeJS.Timeout | null = null;
    let quiet: NodeJS.Timeout | null = null;
    const flush = () => {
      timer = null;
      while (pending) {
        this.opts.send({ type: 'term.data', termId: m.termId, data: pending.slice(0, 2 * TERM_CHUNK) });
        pending = pending.slice(2 * TERM_CHUNK);
      }
    };
    const out = (text: string) => {
      if (!text) return;
      pending += text;
      timer ??= setTimeout(flush, 16);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      out(mask.push(cut.push(decoder.write(chunk))));
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(() => out(mask.flush()), 60);
    });
    child.on('exit', () => {
      if (quiet) clearTimeout(quiet);
      out(mask.flush());
      if (timer) clearTimeout(timer);
      flush();
      this.views.delete(m.termId);
      this.opts.send({ type: 'term.exit', termId: m.termId });
    });
  }

  input(m: Msg<'term.input'>): void {
    const view = this.views.get(m.termId);
    if (view?.write) view.child.stdin?.write(m.data);
  }

  async resize(m: Msg<'term.resize'>): Promise<void> {
    const view = this.views.get(m.termId);
    if (!view?.child.pid) return;
    for (const client of await this.tmux.clients()) {
      if ((await parentOf(client.pid)) !== view.child.pid) continue;
      execFile('stty', [process.platform === 'darwin' ? '-f' : '-F', client.tty, 'cols', String(Math.max(m.cols, MIN_COLS)), 'rows', String(Math.max(m.rows, MIN_ROWS))], () => {});
      return;
    }
  }

  close(m: Msg<'term.close'>): void {
    this.views.get(m.termId)?.child.kill();
  }

  closeViews(): void {
    for (const view of this.views.values()) view.child.kill();
  }
}
