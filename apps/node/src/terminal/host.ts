import { execFile, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { TERM_CHUNK, type AgentEvent, type Limits, type NodeMessage, type ServerMessage } from '@hornhoof/protocol';
import { claudeEvents, claudeInterrupted } from '../providers/claude.js';
import { contentText } from '../providers/events.js';
import { redact } from '../redact.js';
import { tidy, type RunInput, type RunResult } from '../runner.js';
import { Bridge } from './bridge.js';
import { StreamMask } from './mask.js';
import { acceptClaudeDialogs, claudeTranscript, findKimiWire, findRollout, prepareKimi, type TermProgram } from './programs.js';
import { claudeStatusLimits, codexRollout, kimiWire, LineTail, type WireNews } from './transcripts.js';
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

/* A turn running now: one Hornhoof sent, or one a person typed, whose events the host sends itself. A typed turn keeps
   what happened until Hornhoof answers its turn.open (early), and how it ended if it ended before that (over). */
type Turn = {
  jobId: string | null;
  onEvent(e: AgentEvent): void;
  typed: boolean;
  seq: number;
  deadline: number;
  ref?: string;
  early?: AgentEvent[] | null;
  over?: { message: string; error: JobError; sessionId: string | null } | null;
  opened?: Deferred<void>;
  /* A turn that only starts the program, until the program has its tools. A person who types meanwhile takes its place. */
  starting?: boolean;
};
type JobError = RunResult['error'];

type Agent = {
  key: string;
  name: string;
  program: TermProgram | null;
  home: string;
  workDir: string;
  /* What the running program was started with; a turn that needs anything else starts it again. */
  hash: string | null;
  sessionId: string | null;
  /* Sessions a person cleared in the running program: a turn asking for one goes on in the session that replaced it. */
  cleared: Set<string>;
  tail: LineTail | null;
  startedAt: number;
  started: Deferred<void> | null;
  ended: Deferred<string> | null;
  turn: Turn | null;
  busy: boolean;
  limits: Limits | null;
  viewers: number;
  idle: NodeJS.Timeout | null;
  /* Reads the log and looks at the program while it runs. */
  watch: NodeJS.Timeout | null;
  /* Hornhoof's turns, one after another. */
  queue: Promise<unknown>;
  /* Typed turns Hornhoof has not answered yet, oldest first. */
  unopened: Turn[];
  /* A person stopped the running turn with Escape. */
  stopped: boolean;
  /* Why the program said the running turn failed. */
  failure: string | null;
  /* The turn's last line of text, to tell when its answer reached the log. */
  lastText: string | null;
  /* A typed turn that ended and waits for the rest of its log. */
  settling: Promise<void> | null;
  /* The program was started for a person and nothing was said in it yet: its new session has no log to resume. */
  fresh: boolean;
  /* While a start turn waits for the program's tools: what people type meanwhile reaches Hornhoof after it, in order. */
  starting: Promise<unknown> | null;
  /* What a new Kimi session was told from before, kept by the session's id once Kimi names it. */
  keep: string | null;
};

type View = { child: ChildProcess; key: string; write: boolean; mask: StreamMask; decoder: StringDecoder; pending: string; timer: NodeJS.Timeout | null; quiet: NodeJS.Timeout | null };

type Options = {
  tmux: Tmux;
  hornhoof: string;
  send(m: NodeMessage): void;
  /* Values that never reach a screen people watch. */
  secrets(): string[];
  /* A session a person started by typing, kept with its folder so Hornhoof's next turn can go on with it. */
  remember?(sessionId: string, workDir: string): void;
  readyMs?: number;
  pollMs?: number;
  /* A program idle this long with nobody watching ends; its next turn resumes the session. */
  idleMs?: number;
  /* How long a typed turn waits for Hornhoof to open it, and how long it may run. */
  openMs?: number;
  typedMs?: number;
  /* How long a program started with nothing to type gets to connect to its tools. */
  toolsMs?: number;
  cols?: number;
  rows?: number;
};

const WAITING = 'This agent starts with its next turn.';
const STARTING = 'Starting this agent...';
const STOP_WAIT_MS = 5000;
/* What a typed turn keeps at most while Hornhoof has not answered it. */
const EARLY_MAX = 1000;
/* Claude Code can say a turn ended before its answer is in the session log; the turn waits this long for it. */
const SETTLE_MS = 3000;
/* How long the plan's limits may take to come after a turn of a program that does not log them. */
const LIMITS_WAIT_MS = 3000;
/* A program is ready for its first prompt once its screen shows this; Claude Code says so through its hook instead. */
const READY: Record<'codex' | 'kimi', (screen: string) => boolean> = {
  codex: screen => /OpenAI Codex/.test(screen) && /›/.test(screen),
  /* The footer under Kimi's prompt, with how full its context is. */
  kimi: screen => /context: \d+%/.test(screen),
};

const hashOf = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
/* What a session was told from before it started, kept in the agent's folder by the session's id. */
const contextFile = (workDir: string, sessionId: string) => (/^[\w-]+$/.test(sessionId) ? join(workDir, '.hh-context', `${sessionId}.md`) : null);

function keepContext(workDir: string, sessionId: string, context: string): void {
  const file = contextFile(workDir, sessionId);
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, context, { mode: 0o600 });
}

function keptContext(workDir: string, sessionId: string): string | null {
  const file = contextFile(workDir, sessionId);
  try {
    return file ? readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

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
  private readonly openMs: number;
  private readonly typedMs: number;
  private readonly toolsMs: number;
  /* Views being opened, and those Hornhoof closed meanwhile. */
  private readonly viewsOpening = new Set<string>();
  private readonly viewsClosed = new Set<string>();
  private readonly cols: number;
  private readonly rows: number;

  constructor(private readonly opts: Options) {
    this.bridge = new Bridge(opts.hornhoof, (key, event, body) => this.hook(key, event, body));
    this.readyMs = opts.readyMs ?? 45_000;
    this.pollMs = opts.pollMs ?? 500;
    this.idleMs = opts.idleMs ?? 10 * 60_000;
    this.openMs = opts.openMs ?? 8000;
    this.typedMs = opts.typedMs ?? 60 * 60_000;
    this.toolsMs = opts.toolsMs ?? 15_000;
    this.cols = opts.cols ?? 160;
    this.rows = opts.rows ?? 48;
  }

  start(): Promise<void> {
    return this.bridge.start();
  }

  async stop(): Promise<void> {
    this.closeViews();
    for (const a of this.agents.values()) {
      if (a.idle) clearTimeout(a.idle);
      if (a.watch) clearInterval(a.watch);
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
      a = { key, name: `a-${key}`, program: null, home: '', workDir: '', hash: null, sessionId: null, cleared: new Set(), tail: null, startedAt: 0, started: null, ended: null, turn: null, busy: false, limits: null, viewers: 0, idle: null, watch: null, queue: Promise.resolve(), unopened: [], stopped: false, failure: null, lastText: null, settling: null, fresh: false, starting: null, keep: null };
      this.agents.set(key, a);
    }
    return a;
  }

  /* Hornhoof's turns for one agent run one after another. */
  run(job: TermJob): Promise<RunResult> {
    const a = this.agent(job.key);
    const result = a.queue.then(() => this.turnIn(a, job));
    a.queue = result.catch(() => {});
    return result;
  }

  private async turnIn(a: Agent, job: TermJob): Promise<RunResult> {
    const { input, program } = job;
    if (a.idle) clearTimeout(a.idle);
    const fail = async (error: RunResult['error'], output?: string): Promise<RunResult> => ({ ok: false, sessionId: a.sessionId, result: '', output: output ?? (await this.screen(job.key)), error, limits: a.limits });
    const deadline = Date.now() + input.timeoutMs;
    /* A turn a person typed may still run, or wait for the rest of its log; Hornhoof's turn goes in after it. */
    for (this.drain(a); a.busy && Date.now() < deadline; this.drain(a)) await sleep(this.pollMs);
    await a.settling;

    mkdirSync(input.workDir, { recursive: true });
    const urls = this.bridge.agent(job.key);
    let instructionsFile: string | null = null;
    /* The conversation from before reaches a program that starts now; it is not part of its instructions' hash. Claude Code
       keeps only what was said in its log, so what a new session was told from before goes with it to every resume. So it
       does for Kimi Code, which may read AGENTS.md afresh for a session it resumes. */
    const kept = program.kind !== 'codex' && input.sessionId ? keptContext(input.workDir, input.sessionId) : null;
    const context = kept && input.context && !kept.includes(input.context) ? `${kept}\n\n${input.context}` : (kept ?? input.context);
    const told = [input.instructions, context, input.guidance].filter(Boolean).join('\n\n');
    if (told && program.kind === 'claude') {
      instructionsFile = join(input.workDir, '.hh-instructions.md');
      writeFileSync(instructionsFile, told + '\n', { mode: 0o600 });
    }
    /* Codex and Kimi Code read AGENTS.md in the folder they start in. */
    if (told && program.kind !== 'claude') writeFileSync(join(input.workDir, 'AGENTS.md'), told + '\n', { mode: 0o600 });
    const spec = program.launch({ bin: job.bin, home: job.home, workDir: input.workDir, sessionId: input.sessionId, model: input.model, instructionsFile, urls });
    const hash = hashOf({ kind: program.kind, bin: job.bin, model: input.model, instructions: input.instructions, env: lasting(input.env) });
    /* A new session asked for goes on in a program started for a person that nothing was said in yet. */
    const sameSession = input.sessionId === null ? a.fresh : input.sessionId === a.sessionId || a.cleared.has(input.sessionId);
    const goesOn = sameSession && a.hash === hash && (await this.opts.tmux.alive(a.name));
    /* A program started with nothing to type gets its tools before its turn ends, while Hornhoof still answers for them.
       Kimi Code connects to its tools only once it has a session, which a new one gets with the first message. */
    const lazy = program.kind === 'kimi' && !input.sessionId;
    const tools = !goesOn && !input.prompt && input.tools && !lazy ? this.bridge.listed(job.key, this.toolsMs) : null;

    /* What is left in the log from before belongs to no turn. */
    this.drain(a);
    a.lastText = null;
    this.bridge.setToken(job.key, input.tools?.token ?? null);
    const starting = input.prompt ? null : (tools ?? Promise.resolve());
    const turn: Turn = { jobId: null, onEvent: input.onEvent ?? (() => {}), typed: false, seq: 0, deadline, ...(starting ? { starting: true } : {}) };
    if (starting) a.starting = starting;
    a.turn = turn;
    a.ended = deferred();
    a.stopped = false;
    a.failure = null;
    try {
      if (!goesOn) {
        if (program.kind === 'claude') acceptClaudeDialogs(job.home, input.workDir);
        if (program.kind === 'kimi') prepareKimi(job.home, input.workDir, urls.mcpUrl);
        /* A person's first message into a new Kimi session reaches its tools a moment before Hornhoof opens their turn. */
        this.bridge.waitForTurns(job.key, program.kind === 'kimi' ? this.openMs + 2000 : 0);
        Object.assign(a, { program, home: job.home, workDir: input.workDir, hash, sessionId: spec.sessionId, cleared: new Set(), startedAt: Date.now(), started: deferred<void>(), fresh: false, keep: lazy ? (input.context ?? null) : null });
        if (program.kind === 'claude' && !input.sessionId && input.context && spec.sessionId) keepContext(input.workDir, spec.sessionId, input.context);
        a.tail = this.tailFor(a);
        const env = { ...lasting(input.env), ...spec.env };
        await this.opts.tmux.launch(a.name, { cwd: input.workDir, command: spec.command, cols: this.cols, rows: this.rows, envFile: envFile(input.workDir, env) });
        this.watch(a);
        if (!(await this.ready(a, job))) {
          const screen = await this.screen(job.key);
          return await fail(job.signedOut.test(screen) ? 'not_logged_in' : 'agent_failed', screen);
        }
      }
      /* Nothing to type: the turn only starts the program for the person who opened its window. */
      if (!input.prompt) {
        await tools;
        /* A person typed meanwhile: the program goes on with their turn, and the session is theirs to name. */
        if (a.turn !== turn) return { ok: true, sessionId: null, result: '', output: '', error: null, limits: a.limits };
        if (!goesOn) a.fresh = input.sessionId === null;
        return { ok: true, sessionId: a.fresh ? null : a.sessionId, result: '', output: '', error: null, limits: a.limits };
      }
      a.fresh = false;
      await this.opts.tmux.paste(a.name, input.prompt);
      await sleep(Math.min(3000, 300 + input.prompt.length / 20));
      await this.opts.tmux.keys(a.name, 'Enter');
      a.busy = true;

      for (;;) {
        this.drain(a);
        const message = await Promise.race([a.ended.promise, sleep(this.pollMs).then(() => null)]);
        if (message !== null) {
          if (a.stopped) {
            a.busy = false;
            return await fail('cancelled');
          }
          if (a.failure !== null) {
            const output = `${a.failure}\n\n${await this.screen(job.key)}`;
            return await fail(job.signedOut.test(a.failure) ? 'not_logged_in' : 'agent_failed', output);
          }
          await this.settle(a, message);
          await this.planLimits(a);
          return { ok: true, sessionId: a.sessionId, result: message, output: '', error: null, limits: a.limits };
        }
        /* A program stopped with Escape does not say its turn ended: it waits for the next prompt. */
        if (input.signal?.aborted) {
          await this.opts.tmux.keys(a.name, 'Escape');
          await Promise.race([a.ended.promise, sleep(STOP_WAIT_MS)]);
          a.busy = false;
          return await fail('cancelled');
        }
        if (!(await this.opts.tmux.alive(a.name))) {
          a.busy = false;
          const screen = await this.screen(job.key);
          return await fail(job.signedOut.test(screen) ? 'not_logged_in' : 'agent_failed', screen);
        }
        if (Date.now() > deadline) {
          await this.opts.tmux.keys(a.name, 'Escape');
          a.busy = false;
          return await fail('timeout');
        }
      }
    } finally {
      if (starting && a.starting === starting) a.starting = null;
      if (a.turn === turn) {
        this.bridge.setToken(job.key, null);
        a.turn = null;
        a.ended = null;
      }
      this.restLater(a);
    }
  }

  /* While its program runs the host reads the agent's log, where a turn a person typed into Codex shows, and ends a typed
     turn whose program ended or that ran too long. Hornhoof's own turns look after themselves. */
  private watch(a: Agent): void {
    if (a.watch) return;
    let looking = false;
    a.watch = setInterval(() => {
      if (looking) return;
      looking = true;
      void this.look(a).finally(() => (looking = false));
    }, this.pollMs);
    a.watch.unref();
  }

  private async look(a: Agent): Promise<void> {
    this.drain(a);
    if (a.turn && !a.turn.typed) return;
    const alive = await this.opts.tmux.alive(a.name);
    if (a.turn && !a.turn.typed) return;
    if (!alive) {
      a.busy = false;
      this.finishTyped(a, '', 'agent_failed');
      if (a.watch) clearInterval(a.watch);
      a.watch = null;
      return;
    }
    if (a.turn?.typed && Date.now() > a.turn.deadline) {
      await this.opts.tmux.keys(a.name, 'Escape');
      a.busy = false;
      this.finishTyped(a, '', 'timeout');
    }
  }

  /* A person cleared the conversation in Claude Code, which goes on in a new session with a log of its own; or Kimi Code
     named its session, whose log the host finds once Kimi writes it. */
  private follow(a: Agent, sessionId: string): void {
    if (sessionId === a.sessionId) return;
    if (a.sessionId) a.cleared.add(a.sessionId);
    a.sessionId = sessionId;
    if (a.program?.kind === 'claude') a.tail = new LineTail(claudeTranscript(a.home, realpathSync(a.workDir), sessionId));
    if (a.program?.kind === 'kimi') {
      a.tail = null;
      if (a.keep) keepContext(a.workDir, sessionId, a.keep);
      a.keep = null;
    }
  }

  /* Programs that do not log their plan's limits are asked after a turn, for a while. */
  private async planLimits(a: Agent): Promise<void> {
    if (!a.program?.limits) return;
    const limits = await Promise.race([a.program.limits(a.home).catch(() => null), sleep(LIMITS_WAIT_MS).then(() => null)]);
    if (limits) a.limits = limits;
  }

  /* A stop in the log counts for the running turn once its prompt went in: one logged before is the last turn's. */
  private stoppable(a: Agent): boolean {
    return Boolean(a.turn && (a.turn.typed || a.busy));
  }

  /* A person stopped the running turn with Escape. */
  private interrupted(a: Agent): void {
    a.busy = false;
    if (a.turn?.typed) return this.finishTyped(a, '', 'cancelled');
    a.stopped = true;
    a.ended?.resolve('');
  }

  /* Claude Code says it started through its hook; Codex and Kimi Code are ready once their prompt shows. Kimi shows its
     prompt also when it is not signed in, with a word to sign in. */
  private async ready(a: Agent, job: TermJob): Promise<boolean> {
    const end = Date.now() + this.readyMs;
    while (Date.now() < end) {
      if (!(await this.opts.tmux.alive(a.name))) return false;
      const kind = job.program.kind;
      if (kind === 'claude') {
        if (await Promise.race([a.started!.promise.then(() => true), sleep(this.pollMs).then(() => false)])) return true;
      } else {
        const screen = await this.screen(a.key);
        if (kind === 'kimi' && job.signedOut.test(screen)) return false;
        if (READY[kind](screen)) {
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
    const wire = a.program?.kind === 'kimi' && a.sessionId ? findKimiWire(a.home, a.sessionId) : null;
    return wire ? new LineTail(wire, { fromEnd: true }) : null;
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
    /* Kimi named a session it started now; its log comes once it writes it. */
    if (!a.tail && a.program?.kind === 'kimi' && a.sessionId) {
      const wire = findKimiWire(a.home, a.sessionId);
      if (wire) a.tail = new LineTail(wire);
    }
    for (const line of a.tail?.read() ?? []) {
      let data: unknown;
      try {
        data = JSON.parse(line);
      } catch {
        continue;
      }
      if (a.program?.kind === 'claude') {
        if (this.stoppable(a) && claudeInterrupted(data)) this.interrupted(a);
        for (const e of claudeEvents(data)) this.emit(a, e);
        continue;
      }
      if (a.program?.kind === 'kimi') {
        this.kimiNews(a, kimiWire(data));
        continue;
      }
      const news = codexRollout(data);
      if (news.typed !== undefined && (!a.turn || a.turn.starting)) void this.openTyped(a, news.typed, true);
      for (const e of news.events) this.emit(a, e);
      if (news.limits) a.limits = news.limits;
      if (news.session) a.sessionId = news.session.id;
      if (news.started) a.busy = true;
      /* A stop logged before the running turn's prompt went in belongs to the last turn. */
      if (news.aborted && !this.stoppable(a)) continue;
      if (news.ended || news.aborted) {
        const message = news.ended?.message ?? '';
        a.busy = false;
        if (news.aborted) this.interrupted(a);
        else if (a.turn?.typed) this.finishTyped(a, message);
        else if (a.turn) a.ended?.resolve(message);
      }
    }
  }

  /* Kimi Code logs a turn's end without its answer, which is the turn's last text. A person's turn reaches Hornhoof
     through Kimi's prompt hook, as in Claude Code. */
  private kimiNews(a: Agent, news: WireNews): void {
    for (const e of news.events) this.emit(a, e);
    if (news.started) a.busy = true;
    if (!(news.ended || news.aborted || news.failed !== undefined)) return;
    /* An end logged before the running turn's prompt went in belongs to the last turn. With no turn, the program is free. */
    if (!this.stoppable(a)) {
      if (!a.turn) a.busy = false;
      return;
    }
    a.busy = false;
    if (news.aborted) return this.interrupted(a);
    const message = a.lastText ?? '';
    if (a.turn?.typed) return this.finishTyped(a, news.failed === undefined ? message : '', news.failed === undefined ? null : 'agent_failed');
    if (news.failed !== undefined) a.failure = news.failed;
    a.ended?.resolve(news.failed === undefined ? message : '');
  }

  /* Reads the log until the turn's answer is in it. */
  private async settle(a: Agent, message: string): Promise<void> {
    const answer = message.trim();
    for (const end = Date.now() + SETTLE_MS; ; await sleep(100)) {
      this.drain(a);
      if (a.program?.kind !== 'claude' || !answer || a.lastText?.trim() === answer || Date.now() > end) return;
    }
  }

  private emit(a: Agent, event: AgentEvent): void {
    const turn = a.turn;
    if (!turn) return;
    if (event.kind === 'text') a.lastText = event.text;
    if (!turn.typed) return turn.onEvent(event);
    this.typedEvent(turn, event);
  }

  private typedEvent(turn: Turn, event: AgentEvent): void {
    if (turn.early) {
      if (turn.early.length < EARLY_MAX) turn.early.push(event);
      return;
    }
    if (turn.jobId) this.opts.send({ type: 'job.event', jobId: turn.jobId, seq: turn.seq++, event: tidy(event, this.opts.secrets()) });
  }

  private async hook(key: string, event: string, body: unknown): Promise<void> {
    const a = this.agents.get(key);
    if (!a) return;
    const data = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    switch (event) {
      case 'start':
        /* Claude Code starts with the id the host gave it; Kimi Code names a new session here. */
        if (typeof data.session_id === 'string' && (a.sessionId || a.program?.kind === 'kimi')) this.follow(a, data.session_id);
        a.started?.resolve();
        return;
      case 'status': {
        const limits = claudeStatusLimits(data);
        if (limits) a.limits = limits;
        return;
      }
      case 'prompt':
        await a.settling;
        a.busy = true;
        /* Kimi Code hands the prompt as parts of a message. */
        if (!a.turn || a.turn.starting) await this.openTyped(a, typeof data.prompt === 'string' ? data.prompt : contentText(data.prompt));
        return;
      case 'stop': {
        this.drain(a);
        a.busy = false;
        if (typeof data.session_id === 'string') this.follow(a, data.session_id);
        const message = String(data.last_assistant_message ?? '');
        const turn = a.turn;
        /* The hook answers first: the program may write the rest of its log only after. */
        if (turn?.typed) {
          a.settling = this.settle(a, message)
            .then(() => {
              if (a.turn === turn) this.finishTyped(a, message);
            })
            .finally(() => (a.settling = null));
        } else a.ended?.resolve(message);
        return;
      }
    }
  }

  /* A person typed while no turn ran, or while the program started: the turn starts at once and Hornhoof opens a job for
     it, so the agent has its tools and the turn shows like any other. Claude Code waits in its hook for Hornhoof's answer,
     for a while; Codex goes on, and what it does waits in the turn. fromLog: the typing was read from the log, which is
     being read now. */
  private async openTyped(a: Agent, text: string, fromLog = false): Promise<void> {
    const start = a.starting;
    if (a.idle) clearTimeout(a.idle);
    a.fresh = false;
    if (!fromLog) this.drain(a);
    a.lastText = null;
    const turn: Turn = { jobId: null, onEvent: () => {}, typed: true, seq: 0, deadline: Date.now() + this.typedMs, ref: randomUUID(), early: [], over: null, opened: deferred() };
    a.turn = turn;
    a.unopened.push(turn);
    this.watch(a);
    const answered = () => Promise.race([turn.opened!.promise, sleep(this.openMs)]);
    if (start) {
      /* The start turn's token gets the program its tools first; Hornhoof then ends that turn for this one. Turns typed
         meanwhile go one by one, each once Hornhoof answered the last, whose end goes out with that answer when it is
         over: Hornhoof opens a typed turn only while none runs. */
      const next = start.then(answered);
      a.starting = next;
      void next.then(() => {
        if (a.starting === next) a.starting = null;
      });
      await start;
    }
    this.opts.send({ type: 'turn.open', agentKey: a.key, text: text.slice(0, 100_000), ref: turn.ref });
    await answered();
  }

  /* Hornhoof's answer to turn.open, found by its ref; a Hornhoof from before refs answers in order. A typed turn gets its
     job and tool token, and what it did or how it ended so far goes out. An answer no typed turn waits for ends its job. */
  opened(m: Msg<'turn.opened'>): void {
    const a = this.agents.get(m.agentKey);
    const at = a ? (m.ref ? a.unopened.findIndex(t => t.ref === m.ref) : a.unopened.length ? 0 : -1) : -1;
    const turn = at >= 0 ? a!.unopened.splice(at, 1)[0]! : null;
    if (!a || !turn) {
      if (m.jobId) this.opts.send({ type: 'job.done', jobId: m.jobId, ok: false, sessionId: a?.sessionId ?? null, result: 'Stopped.', tail: '', error: 'cancelled' });
      return;
    }
    const early = turn.early ?? [];
    turn.early = null;
    if (m.jobId && m.toolToken) {
      turn.jobId = m.jobId;
      if (a.turn === turn) this.bridge.setToken(a.key, m.toolToken);
      for (const e of early) this.typedEvent(turn, e);
    }
    turn.opened?.resolve();
    if (turn.over) this.typedDone(turn, turn.over.message, turn.over.error, turn.over.sessionId);
  }

  private finishTyped(a: Agent, message: string, error: JobError = null): void {
    const turn = a.turn;
    if (!turn?.typed) return;
    a.turn = null;
    if (a.sessionId) this.opts.remember?.(a.sessionId, a.workDir);
    this.bridge.setToken(a.key, null);
    /* Hornhoof hears the limits with the next turn it runs. */
    void this.planLimits(a);
    /* Hornhoof has not answered yet: the end goes out with its answer. */
    if (turn.early) turn.over = { message, error, sessionId: a.sessionId };
    else this.typedDone(turn, message, error, a.sessionId);
    this.restLater(a);
  }

  private typedDone(turn: Turn, message: string, error: JobError, sessionId: string | null): void {
    if (!turn.jobId) return;
    const result = error === 'cancelled' ? 'Stopped.' : error ? '' : redact(message, this.opts.secrets());
    this.opts.send({ type: 'job.done', jobId: turn.jobId, ok: !error, sessionId, result, tail: '', error });
  }

  /* Turns people typed that run now: they count as running when the node says hello again. */
  typedJobs(): string[] {
    return [...this.agents.values()].flatMap(a => (a.turn?.typed && a.turn.jobId ? [a.turn.jobId] : []));
  }

  /* Hornhoof calls off a turn a person typed: the program stops as on Escape, and the turn ends as stopped. */
  async cancel(jobId: string): Promise<void> {
    const a = [...this.agents.values()].find(x => x.turn?.typed && x.turn.jobId === jobId);
    if (!a) return;
    await this.opts.tmux.keys(a.name, 'Escape');
    a.busy = false;
    this.finishTyped(a, '', 'cancelled');
  }

  /* Views belong to one connection to Hornhoof; after it came back, people open them again. */
  closeViews(): void {
    for (const view of this.views.values()) view.child.kill();
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
    this.viewsOpening.add(m.termId);
    /* Someone who may type gets the program at once, to talk to it; watchers see it once it has a turn. */
    const starts = m.write && !a.turn && !(a.hash && (await this.opts.tmux.alive(a.name)));
    try {
      if (!(await this.opts.tmux.has(a.name))) {
        await this.opts.tmux.launch(a.name, { cwd: '/', command: ['sh', '-c', `printf '\\n  %s\\n' '${starts ? STARTING : WAITING}'; exec sleep 2147483647`], cols: m.cols, rows: m.rows });
        /* The waiting screen is no program of the agent's: the next turn starts one in its place. A turn that runs now is
           starting its own. */
        if (!a.turn) a.hash = null;
      }
    } finally {
      this.viewsOpening.delete(m.termId);
    }
    if (this.viewsClosed.delete(m.termId)) return;
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
    if (starts) this.opts.send({ type: 'agent.start', agentKey: m.agentKey });
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
    const view = this.views.get(m.termId);
    if (view) view.child.kill();
    else if (this.viewsOpening.has(m.termId)) this.viewsClosed.add(m.termId);
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
