import { execFile, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { TERM_CHUNK, type AgentEvent, type Limits, type NodeMessage, type ServerMessage } from '@hornhoof/protocol';
import { claudeEvents } from '../providers/claude.js';
import { redact } from '../redact.js';
import { tidy, type RunInput, type RunResult } from '../runner.js';
import { Bridge } from './bridge.js';
import { StreamMask } from './mask.js';
import { acceptClaudeDialogs, claudeTranscript, findRollout, type TermProgram } from './programs.js';
import { claudeStatusLimits, codexRollout, LineTail } from './transcripts.js';
import { envFile, type Tmux } from './tmux.js';

/* An agent's turn in its terminal: which program, where it keeps its sign-in, and what the runner hands every program. */
export type TermJob = { key: string; program: TermProgram; bin: string; home: string; signedOut: RegExp; input: RunInput };

type Msg<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;
type Deferred<T> = { promise: Promise<T>; resolve(v: T): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => (resolve = r));
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/* A turn running now: one Hornhoof sent, or one a person typed, whose events the host sends itself. */
type Turn = { jobId: string | null; onEvent(e: AgentEvent): void; typed: boolean; seq: number };

type Agent = {
  key: string;
  name: string;
  program: TermProgram | null;
  home: string;
  workDir: string;
  /* What the running program was started with; a turn that needs anything else starts it again. */
  hash: string | null;
  sessionId: string | null;
  tail: LineTail | null;
  startedAt: number;
  started: Deferred<void> | null;
  ended: Deferred<string> | null;
  turn: Turn | null;
  busy: boolean;
  limits: Limits | null;
  viewers: number;
  idle: NodeJS.Timeout | null;
  poll: NodeJS.Timeout | null;
  opening: Deferred<{ jobId: string; token: string } | null> | null;
};

type View = { child: ChildProcess; key: string; write: boolean; mask: StreamMask; decoder: StringDecoder; pending: string; timer: NodeJS.Timeout | null; quiet: NodeJS.Timeout | null };

type Options = {
  tmux: Tmux;
  hornhoof: string;
  send(m: NodeMessage): void;
  /* Values that never reach a screen people watch. */
  secrets(): string[];
  readyMs?: number;
  pollMs?: number;
  /* A program idle this long with nobody watching ends; its next turn resumes the session. */
  idleMs?: number;
  cols?: number;
  rows?: number;
};

const WAITING = 'This agent starts with its next turn.';
const STOP_WAIT_MS = 5000;

const hashOf = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
/* The turn's own address and token for pictures change every turn; the bridge serves them instead. */
const lasting = (env: Record<string, string> = {}) => Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('HH_ATTACH_')));

/* Runs agents in their tmux sessions on this node and shows those sessions to the people watching. */
export class TerminalHost {
  private readonly agents = new Map<string, Agent>();
  private readonly views = new Map<string, View>();
  private readonly bridge: Bridge;
  private readonly readyMs: number;
  private readonly pollMs: number;
  private readonly idleMs: number;
  private readonly cols: number;
  private readonly rows: number;

  constructor(private readonly opts: Options) {
    this.bridge = new Bridge(opts.hornhoof, (key, event, body) => this.hook(key, event, body));
    this.readyMs = opts.readyMs ?? 45_000;
    this.pollMs = opts.pollMs ?? 500;
    this.idleMs = opts.idleMs ?? 10 * 60_000;
    this.cols = opts.cols ?? 160;
    this.rows = opts.rows ?? 48;
  }

  start(): Promise<void> {
    return this.bridge.start();
  }

  async stop(): Promise<void> {
    for (const view of this.views.values()) view.child.kill();
    for (const a of this.agents.values()) {
      if (a.idle) clearTimeout(a.idle);
      if (a.poll) clearInterval(a.poll);
    }
    this.bridge.stop();
    await this.opts.tmux.stopAll();
  }

  screen(key: string): Promise<string> {
    return this.opts.tmux.screen(this.agent(key).name);
  }

  private agent(key: string): Agent {
    let a = this.agents.get(key);
    if (!a) {
      a = { key, name: `a-${key}`, program: null, home: '', workDir: '', hash: null, sessionId: null, tail: null, startedAt: 0, started: null, ended: null, turn: null, busy: false, limits: null, viewers: 0, idle: null, poll: null, opening: null };
      this.agents.set(key, a);
    }
    return a;
  }

  async run(job: TermJob): Promise<RunResult> {
    const { input, program } = job;
    const a = this.agent(job.key);
    if (a.idle) clearTimeout(a.idle);
    const fail = async (error: RunResult['error'], output?: string): Promise<RunResult> => ({ ok: false, sessionId: a.sessionId, result: '', output: output ?? (await this.screen(job.key)), error, limits: a.limits });
    const deadline = Date.now() + input.timeoutMs;
    /* A turn a person typed may still run; Hornhoof's turn goes in after it. */
    while (a.busy && Date.now() < deadline) await sleep(this.pollMs);

    mkdirSync(input.workDir, { recursive: true });
    const urls = this.bridge.agent(job.key);
    let instructionsFile: string | null = null;
    if (input.instructions && program.kind === 'claude') {
      instructionsFile = join(input.workDir, '.hh-instructions.md');
      writeFileSync(instructionsFile, input.instructions + '\n', { mode: 0o600 });
    }
    if (input.instructions && program.kind === 'codex') writeFileSync(join(input.workDir, 'AGENTS.md'), input.instructions + '\n', { mode: 0o600 });
    const spec = program.launch({ bin: job.bin, home: job.home, workDir: input.workDir, sessionId: input.sessionId, model: input.model, instructionsFile, urls });
    const hash = hashOf({ kind: program.kind, bin: job.bin, model: input.model, instructions: input.instructions, env: lasting(input.env) });
    const goesOn = input.sessionId !== null && input.sessionId === a.sessionId && a.hash === hash && (await this.opts.tmux.alive(a.name));

    this.bridge.setToken(job.key, input.tools?.token ?? null);
    a.turn = { jobId: null, onEvent: input.onEvent ?? (() => {}), typed: false, seq: 0 };
    a.ended = deferred();
    try {
      if (!goesOn) {
        if (program.kind === 'claude') acceptClaudeDialogs(job.home, input.workDir);
        Object.assign(a, { program, home: job.home, workDir: input.workDir, hash, sessionId: spec.sessionId, startedAt: Date.now(), started: deferred<void>() });
        a.tail = this.tailFor(a);
        const env = { ...lasting(input.env), ...spec.env };
        await this.opts.tmux.launch(a.name, { cwd: input.workDir, command: spec.command, cols: this.cols, rows: this.rows, envFile: envFile(input.workDir, env) });
        if (!(await this.ready(a, job))) {
          const screen = await this.screen(job.key);
          return await fail(job.signedOut.test(screen) ? 'not_logged_in' : 'agent_failed', screen);
        }
      }
      await this.opts.tmux.paste(a.name, input.prompt);
      await sleep(Math.min(3000, 300 + input.prompt.length / 20));
      await this.opts.tmux.keys(a.name, 'Enter');
      a.busy = true;

      for (;;) {
        this.drain(a);
        const message = await Promise.race([a.ended.promise, sleep(this.pollMs).then(() => null)]);
        if (message !== null) {
          this.drain(a);
          return { ok: true, sessionId: a.sessionId, result: message, output: '', error: null, limits: a.limits };
        }
        if (input.signal?.aborted) {
          await this.opts.tmux.keys(a.name, 'Escape');
          await Promise.race([a.ended.promise, sleep(STOP_WAIT_MS)]);
          return await fail('cancelled');
        }
        if (!(await this.opts.tmux.alive(a.name))) {
          a.busy = false;
          const screen = await this.screen(job.key);
          return await fail(job.signedOut.test(screen) ? 'not_logged_in' : 'agent_failed', screen);
        }
        if (Date.now() > deadline) {
          await this.opts.tmux.keys(a.name, 'Escape');
          return await fail('timeout');
        }
      }
    } finally {
      this.bridge.setToken(job.key, null);
      a.turn = null;
      a.ended = null;
      this.restLater(a);
    }
  }

  /* Claude Code says it started through its hook; Codex is ready once its prompt shows. */
  private async ready(a: Agent, job: TermJob): Promise<boolean> {
    const end = Date.now() + this.readyMs;
    while (Date.now() < end) {
      if (!(await this.opts.tmux.alive(a.name))) return false;
      if (job.program.kind === 'claude') {
        if (await Promise.race([a.started!.promise.then(() => true), sleep(this.pollMs).then(() => false)])) return true;
      } else {
        const screen = await this.screen(a.key);
        if (/OpenAI Codex/.test(screen) && /›/.test(screen)) {
          await sleep(500);
          return true;
        }
        await sleep(this.pollMs);
      }
      if (job.signedOut.test(await this.screen(a.key))) return false;
    }
    return false;
  }

  private tailFor(a: Agent): LineTail | null {
    /* The program names its folder by the real path, without links. */
    if (a.program?.kind === 'claude' && a.sessionId) return new LineTail(claudeTranscript(a.home, realpathSync(a.workDir), a.sessionId), { fromEnd: true });
    if (a.program?.kind === 'codex' && a.sessionId) {
      const found = findRollout(a.home, a.workDir, 0, a.sessionId);
      return found ? new LineTail(found.file, { fromEnd: true }) : null;
    }
    return null;
  }

  /* What the program wrote to its log since last time: events for the turn, Codex's limits, session and turn end. */
  private drain(a: Agent): void {
    if (!a.tail && a.program?.kind === 'codex') {
      const found = findRollout(a.home, a.workDir, a.startedAt - 2000);
      if (found) {
        a.sessionId = found.sessionId;
        a.tail = new LineTail(found.file);
      }
    }
    for (const line of a.tail?.read() ?? []) {
      let data: unknown;
      try {
        data = JSON.parse(line);
      } catch {
        continue;
      }
      if (a.program?.kind === 'claude') {
        for (const e of claudeEvents(data)) this.emit(a, e);
        continue;
      }
      const news = codexRollout(data);
      for (const e of news.events) this.emit(a, e);
      if (news.limits) a.limits = news.limits;
      if (news.session) a.sessionId = news.session.id;
      if (news.started) a.busy = true;
      if (news.ended) {
        a.busy = false;
        if (a.turn?.typed) this.finishTyped(a, news.ended.message);
        else a.ended?.resolve(news.ended.message);
      }
    }
  }

  private emit(a: Agent, event: AgentEvent): void {
    const turn = a.turn;
    if (!turn) return;
    if (!turn.typed) return turn.onEvent(event);
    if (turn.jobId) this.opts.send({ type: 'job.event', jobId: turn.jobId, seq: turn.seq++, event: tidy(event, this.opts.secrets()) });
  }

  private async hook(key: string, event: string, body: unknown): Promise<void> {
    const a = this.agents.get(key);
    if (!a) return;
    const data = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    switch (event) {
      case 'start':
        a.started?.resolve();
        return;
      case 'status': {
        const limits = claudeStatusLimits(data);
        if (limits) a.limits = limits;
        return;
      }
      case 'prompt':
        a.busy = true;
        if (!a.turn) await this.openTyped(a, String(data.prompt ?? ''));
        return;
      case 'stop': {
        this.drain(a);
        a.busy = false;
        if (typeof data.session_id === 'string') a.sessionId = data.session_id;
        const message = String(data.last_assistant_message ?? '');
        if (a.turn?.typed) this.finishTyped(a, message);
        else a.ended?.resolve(message);
        return;
      }
    }
  }

  /* A person typed while no turn ran: Hornhoof opens one, so the agent has its tools and the turn shows like any other. */
  private async openTyped(a: Agent, text: string): Promise<void> {
    if (a.idle) clearTimeout(a.idle);
    a.opening = deferred();
    this.opts.send({ type: 'turn.open', agentKey: a.key, text: text.slice(0, 100_000) });
    const got = await Promise.race([a.opening.promise, sleep(8000).then(() => null)]);
    a.opening = null;
    if (!got) return;
    a.turn = { jobId: got.jobId, onEvent: () => {}, typed: true, seq: 0 };
    this.bridge.setToken(a.key, got.token);
    a.poll = setInterval(() => this.drain(a), this.pollMs);
  }

  opened(m: Msg<'turn.opened'>): void {
    this.agents.get(m.agentKey)?.opening?.resolve(m.jobId && m.toolToken ? { jobId: m.jobId, token: m.toolToken } : null);
  }

  private finishTyped(a: Agent, message: string): void {
    const turn = a.turn;
    if (a.poll) clearInterval(a.poll);
    a.poll = null;
    a.turn = null;
    this.bridge.setToken(a.key, null);
    if (turn?.jobId) this.opts.send({ type: 'job.done', jobId: turn.jobId, ok: true, sessionId: a.sessionId, result: redact(message, this.opts.secrets()), tail: '', error: null });
    this.restLater(a);
  }

  /* Ends a program nobody needs for a while; the pane keeps its last screen and the next turn resumes the session. */
  private restLater(a: Agent): void {
    if (a.idle) clearTimeout(a.idle);
    a.idle = setTimeout(async () => {
      if (a.turn || a.busy || a.viewers > 0) return;
      const pid = await this.opts.tmux.programPid(a.name);
      if (pid) process.kill(pid, 'SIGTERM');
    }, this.idleMs);
    a.idle.unref();
  }

  async open(m: Msg<'term.open'>): Promise<void> {
    const a = this.agent(m.agentKey);
    if (!(await this.opts.tmux.has(a.name))) {
      await this.opts.tmux.launch(a.name, { cwd: '/', command: ['sh', '-c', `printf '\\n  %s\\n' '${WAITING}'; exec sleep 2147483647`], cols: m.cols, rows: m.rows });
    }
    const child = this.opts.tmux.attach(a.name, m.cols, m.rows, m.write);
    const view: View = { child, key: m.agentKey, write: m.write, mask: new StreamMask(this.opts.secrets), decoder: new StringDecoder('utf8'), pending: '', timer: null, quiet: null };
    this.views.set(m.termId, view);
    a.viewers++;
    if (a.idle) clearTimeout(a.idle);
    const flush = () => {
      view.timer = null;
      while (view.pending) {
        this.opts.send({ type: 'term.data', termId: m.termId, data: view.pending.slice(0, 2 * TERM_CHUNK) });
        view.pending = view.pending.slice(2 * TERM_CHUNK);
      }
    };
    const out = (text: string) => {
      if (!text) return;
      view.pending += text;
      view.timer ??= setTimeout(flush, 16);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      out(view.mask.push(view.decoder.write(chunk)));
      if (view.quiet) clearTimeout(view.quiet);
      view.quiet = setTimeout(() => out(view.mask.flush()), 60);
    });
    child.on('exit', () => {
      if (view.quiet) clearTimeout(view.quiet);
      out(view.mask.flush());
      if (view.timer) clearTimeout(view.timer);
      flush();
      this.views.delete(m.termId);
      a.viewers = Math.max(0, a.viewers - 1);
      this.opts.send({ type: 'term.exit', termId: m.termId });
      this.restLater(a);
    });
  }

  input(m: Msg<'term.input'>): void {
    const view = this.views.get(m.termId);
    if (view?.write) view.child.stdin?.write(m.data);
  }

  async resize(m: Msg<'term.resize'>): Promise<void> {
    const view = this.views.get(m.termId);
    if (!view?.child.pid) return;
    for (const client of await this.opts.tmux.clients()) {
      if ((await parentOf(client.pid)) !== view.child.pid) continue;
      execFile('stty', [process.platform === 'darwin' ? '-f' : '-F', client.tty, 'cols', String(m.cols), 'rows', String(m.rows)], () => {});
      return;
    }
  }

  close(m: Msg<'term.close'>): void {
    this.views.get(m.termId)?.child.kill();
  }
}

/* The process that started a given one: from /proc on Linux, from ps elsewhere. */
async function parentOf(pid: number): Promise<number | null> {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch {
    return new Promise(resolve => execFile('ps', ['-o', 'ppid=', '-p', String(pid)], (err, out) => resolve(err ? null : Number(out.trim()))));
  }
}
