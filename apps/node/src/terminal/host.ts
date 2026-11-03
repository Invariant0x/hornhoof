import { execFile, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { TERM_CHUNK, type AgentEvent, type Limits, type NodeMessage, type ServerMessage } from '@hornhoof/protocol';
import { LOST_END_MS } from '@hornhoof/protocol/map';
import { agyRules } from '../providers/antigravity.js';
import { claudeEvents, claudeInterrupted } from '../providers/claude.js';
import { contentText } from '../providers/events.js';
import { agentFs, ownFs, type AgentFs } from '../agent-fs.js';
import { asAgent, type JobUser } from '../isolation.js';
import { kimiContextSize } from '../providers/kimi.js';
import { jobDone, tidy, type RunInput, type RunResult } from '../runner.js';
import { claudePlugins } from '../skills.js';
import { plainOutput, signalName, type ProgramOutput } from '../program-exit.js';
import { redact } from '../redact.js';
import { Bridge, type AgentUrls } from './bridge.js';
import { inputOf } from './input.js';
import { procOwner, type OwnerFactory, type Ownership, type Panes } from './peer.js';
import { StreamMask } from './mask.js';
import { ProgramWatch, READY, REPORT_MS, type Pending } from './program-state.js';
import { acceptClaudeDialogs, agyTranscript, claudeTranscript, findKimiWire, findRollout, prepareAgy, prepareKimi, rolloutFiles, type LaunchSpec, type TermProgram } from './programs.js';
import { CALLS, type Calls } from './tool-calls.js';
import { agySteps, claudeStatusContext, claudeStatusLimits, codexRollout, kimiWire, LineTail, type WireNews } from './transcripts.js';
import { envFile, type Tmux } from './tmux.js';

/* An agent's turn in its terminal: which program, where it keeps its sign-in, and what the runner hands every program. */
export type TermJob = { key: string; program: TermProgram; bin: string; home: string; signedOut: RegExp; input: RunInput };

type Msg<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;
type Deferred<T> = { promise: Promise<T>; resolve(v: T): void; settled: boolean };

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => (resolve = r));
  const d: Deferred<T> = {
    promise,
    resolve: v => {
      d.settled = true;
      resolve(v);
    },
    settled: false,
  };
  return d;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const pasteWait = (text: string) => Math.min(3000, 300 + text.length / 20);

function exitError(output: string | null, signedOut: RegExp | null, fallback: JobError): JobError {
  return output && signedOut?.test(output) ? 'not_logged_in' : fallback;
}

/* A turn running now: one Hornhoof sent, or one a person typed, whose events the host sends itself. A typed turn keeps
   what happened until Hornhoof answers its turn.open (early), and how it ended if it ended before that (over). */
type Turn = {
  jobId: string | null;
  onEvent(e: AgentEvent): void;
  typed: boolean;
  seq: number;
  signal?: AbortSignal;
  ref?: string;
  early?: AgentEvent[] | null;
  over?: { message: string; error: JobError; sessionId: string | null; output: string; programOutput?: ProgramOutput } | null;
  toolToken?: string;
  opened?: Deferred<void>;
  /* A turn that only starts the program, until the program has its tools. A person who types meanwhile takes its place. */
  starting?: boolean;
  observed?: ObservedProgram;
};
type JobError = RunResult['error'];
type LiveWords = { turn: Turn; text: string; deadline: number };

type Agent = {
  key: string;
  name: string;
  program: TermProgram | null;
  signedOut: RegExp | null;
  home: string;
  workDir: string;
  /* What the running program was started with; a turn that needs anything else starts it again. */
  hash: string | null;
  sessionId: string | null;
  /* Sessions a person cleared in the running program: a turn asking for one goes on in the session that replaced it. */
  cleared: Set<string>;
  tail: LineTail | null;
  /* The Codex session logs there were when the program started a new session: its own log is none of them. */
  oldLogs: Set<string> | null;
  startedAt: number;
  started: Deferred<void> | null;
  ended: Deferred<string> | null;
  turn: Turn | null;
  busy: boolean;
  /* The program took the prompt Hornhoof typed: its prompt hook ran or its log says the turn started. */
  took?: boolean;
  /* The prompt Hornhoof typed, until the program's prompt hook says what it got. */
  typing?: string | null;
  limits: Limits | null;
  /* How full the context is as Hornhoof last heard it, and how many tokens Kimi's model takes in it. */
  contextUsed: number | null;
  contextSize: number | null;
  viewers: number;
  /* Its program runs and showed its prompt; until then its views show a loader. */
  up: boolean;
  /* Reads the log and looks at the program while it runs. */
  watch: NodeJS.Timeout | null;
  /* Words Hornhoof types into running turns, one after another. */
  saying: Promise<unknown>;
  inputUnknown?: boolean;
  /* Hornhoof's turns, one after another. */
  queue: Promise<unknown>;
  /* Escape from a cancelled typed turn must finish before another prompt goes in. */
  cancelling?: Promise<void>;
  /* Typed turns Hornhoof has not answered yet, oldest first. */
  unopened: Turn[];
  /* A person stopped the running turn with Escape. */
  stopped: boolean;
  /* Why the program said the running turn failed. */
  failure: string | null;
  /* The turn's last line of text, to tell when its answer reached the log. */
  lastText: string | null;
  /* Kimi's running step has text already, so its next part goes on the same message. */
  stepSaid: boolean;
  /* A typed turn that ended and waits for the rest of its log. */
  settling: Promise<void> | null;
  /* The program was started for a person and nothing was said in it yet: its new session has no log to resume. */
  fresh: boolean;
  /* While a start turn waits for the program's tools: what people type meanwhile reaches Hornhoof after it, in order. */
  starting: Promise<unknown> | null;
  /* What a new Kimi or Antigravity session was told from before, kept by the session's id once the program names it. */
  keep: string | null;
  /* Reads Antigravity's transcript, pairing its calls with their results. */
  agyRead: ReturnType<typeof agySteps> | null;
  /* The final planner response has no tools; earlier text is not the answer a stop waits for. */
  agyAnswered: boolean;
  /* Interruption notices already on screen when this turn started belong to older turns. */
  interruptions: number;
  /* The running turn's tool calls the program began and did not end yet, by id, oldest first. */
  calls: Map<string, Pending>;
};

type Size = { cols: number; rows: number };
/* shown: the size its tmux client is to have; applied: the size it was last given; tty: that client's terminal, once
   found. */
type View = {
  child: ChildProcess;
  key: string;
  write: boolean;
  mask: StreamMask;
  decoder: StringDecoder;
  pending: string;
  timer: NodeJS.Timeout | null;
  quiet: NodeJS.Timeout | null;
  shown: Size;
  applied: Size;
  tty: string | null;
  out(text: string): void;
};

const sameSize = (a: Size, b: Size) => a.cols === b.cols && a.rows === b.rows;
/* Erases a window's screen below a session of so many rows, and puts the cursor back where it was. */
const eraseBelow = (rows: number) => `\u001b7\u001b[${rows + 1};1H\u001b[J\u001b8`;
/* Sets a terminal's size: stty names the terminal with -f on macOS and -F elsewhere. */
const stty = (tty: string, size: Size) =>
  new Promise<void>(resolve => execFile('stty', [process.platform === 'darwin' ? '-f' : '-F', tty, 'cols', String(size.cols), 'rows', String(size.rows)], () => resolve()));

type Options = {
  tmux: Tmux;
  hornhoof: string;
  send(m: NodeMessage): void;
  /* Values that never reach a screen people watch. */
  secrets(): string[];
  log?(message: string): void;
  /* A session a person started by typing, kept with its folder so Hornhoof's next turn can go on with it. */
  remember?(sessionId: string, workDir: string): void;
  /* How long a program may take to show its prompt. Kimi Code takes most of a minute on a busy machine. */
  readyMs?: number;
  pollMs?: number;
  /* How long a typed turn waits for Hornhoof to open it. */
  openMs?: number;
  /* How long a program started with nothing to type gets to connect to its tools. */
  toolsMs?: number;
  /* How long the host waits for the program to take a prompt before it presses Enter again. */
  enterWaitMs?: number;
  /* How long a program may wait for what to type in a turn of Hornhoof's it never said ended, before the host ends the
     turn; how often the host looks at what it does, and tells Hornhoof again what it does when nothing changed. */
  lostMs?: number;
  lookMs?: number;
  reportMs?: number;
  cols?: number;
  rows?: number;
  /* Where Linux tells which process holds a connection, so the bridge takes tool calls only from the agent's own program. */
  proc?: string;
  owner?: OwnerFactory;
  /* On a node that runs as root, the user the agents' programs run as, and how the node does file work in their folders. */
  user?: JobUser | null;
  fs?: AgentFs;
  /* Claude Code plugins loaded for each session, such as superpowers from the image; that copy by default. */
  plugins?: string[];
};

const WAITING = 'This agent starts with its next turn.';
const STOP_WAIT_MS = 5000;
/* How often the host presses Enter again for a prompt the program did not take. */
const ENTER_TRIES = 3;
/* What a typed turn keeps at most while Hornhoof has not answered it. */
const EARLY_MAX = 1000;
/* Claude Code can say a turn ended before its answer is in the session log; the turn waits this long for it. */
const SETTLE_MS = 3000;
/* How long the plan's limits may take to come after a turn of a program that does not log them. */
const LIMITS_WAIT_MS = 3000;
/* How long a Claude Code that said it started may take to show its input box. */
const INPUT_WAIT_MS = 10_000;
/* How often the host looks at what the program of a running turn does, besides each time it begins or ends a tool. */
const LOOK_MS = 5000;
/* What the options leave out: how long the host waits for what, and the terminal's size. */
const DEFAULTS = { readyMs: 120_000, pollMs: 500, openMs: 8000, toolsMs: 15_000, enterWaitMs: 4000, lostMs: LOST_END_MS, reportMs: REPORT_MS, cols: 160, rows: 48 };
/* The options given, without those set to nothing. */
const defined = (opts: Options): Partial<Options> => Object.fromEntries(Object.entries(opts).filter(([, value]) => value !== undefined));
/* When the host last looked at the program, and the tool it ran then. */
type Look = { at: number; call: Pending | null };
type ObservedProgram = { watch: ProgramWatch; look: Look };
/* A program may change how a prompt's lines and spaces look, not its words. */
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

const interruptionCount = (screen: string) => [...screen.matchAll(/Interrupted · What should Antigravity CLI do instead\?/g)].length;

const hashOf = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
/* What the running program was started with; a turn that needs anything else starts it again. A plan signed in to another
   account in Hornhoof reaches a running Claude Code only when it starts again, which it does between turns, in the same
   session. */
function launchHash({ program, bin, input }: TermJob, spec: LaunchSpec): string {
  const signedAs = spec.env.CLAUDE_CODE_OAUTH_TOKEN ? hashOf(spec.env.CLAUDE_CODE_OAUTH_TOKEN) : null;
  return hashOf({ kind: program.kind, bin, model: input.model, effort: input.effort ?? null, compactWindow: input.compactWindow ?? null, instructions: input.instructions, env: lasting(input.env), signedAs });
}
/* An agent's state as its program starts for a turn. Kimi Code and Antigravity name a new session only once it starts,
   and what it was told from before is kept by that name. */
function startedState({ program, home, input }: TermJob, spec: LaunchSpec): Partial<Agent> {
  const namesLater = (program.kind === 'kimi' || program.kind === 'antigravity') && !input.sessionId;
  return {
    program, home, workDir: input.workDir, sessionId: spec.sessionId, cleared: new Set(), startedAt: Date.now(), started: deferred<void>(), fresh: false,
    oldLogs: program.kind === 'codex' && !spec.sessionId ? rolloutFiles(home) : null,
    keep: namesLater ? (input.context ?? null) : null,
    contextSize: program.kind === 'kimi' ? kimiWindow(home, input.model) : null,
  };
}
/* What a session was told from before it started, kept in the agent's folder by the session's id. */
const contextFile = (workDir: string, sessionId: string) => (/^[\w-]+$/.test(sessionId) ? join(workDir, '.hh-context', `${sessionId}.md`) : null);

async function keepContext(fs: AgentFs, workDir: string, sessionId: string, context: string): Promise<void> {
  const file = contextFile(workDir, sessionId);
  if (!file) return;
  await fs.mkdir(dirname(file));
  await fs.write(file, context);
}

async function keptContext(fs: AgentFs, workDir: string, sessionId: string): Promise<string | null> {
  const file = contextFile(workDir, sessionId);
  return file ? fs.read(file).catch(() => null) : null;
}

/* The turn's own address and token for pictures change every turn; the bridge serves them instead. */
const lasting = (env: Record<string, string> = {}) => Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('HH_ATTACH_')));

/* Runs agents in their tmux sessions on this node and shows those sessions to the people watching. */
export class TerminalHost {
  private readonly agents = new Map<string, Agent>();
  private readonly views = new Map<string, View>();
  private readonly bridge: Bridge;
  private readonly fs: AgentFs;
  private readonly plugins: string[];
  private readonly readyMs: number;
  private readonly pollMs: number;
  private readonly openMs: number;
  private readonly toolsMs: number;
  private readonly enterWaitMs: number;
  private readonly lostMs: number;
  private readonly lookMs: number;
  private readonly reportMs: number;
  /* Views being opened, and those Hornhoof closed meanwhile. */
  private readonly viewsOpening = new Set<string>();
  private readonly viewsClosed = new Set<string>();
  /* Windows opening one agent wait for the same session to be created. */
  private readonly sessionsOpening = new Map<string, Promise<void>>();
  /* The size each view's window asks for, from the moment Hornhoof opens it: a resize that comes while it still opens
     counts too, since Hornhoof says the view is ready as it asks for it. */
  private readonly wanted = new Map<string, { key: string; size: Size }>();
  private readonly cols: number;
  private readonly rows: number;

  constructor(private readonly opts: Options) {
    const owner = ownership(opts, key => this.panes(key));
    this.bridge = new Bridge(opts.hornhoof, (key, event, body) => this.hook(key, event, body), owner.owns, {
      capture: owner.capture, rejected: (key, event, reason) => this.hookRejected(key, event, reason),
    });
    this.fs = opts.fs ?? (opts.user ? agentFs(opts.user) : ownFs);
    this.plugins = opts.plugins ?? claudePlugins();
    const set = { ...DEFAULTS, ...defined(opts) };
    this.readyMs = set.readyMs;
    this.pollMs = set.pollMs;
    this.openMs = set.openMs;
    this.toolsMs = set.toolsMs;
    this.enterWaitMs = set.enterWaitMs;
    this.lostMs = set.lostMs;
    this.lookMs = opts.lookMs ?? Math.min(this.lostMs / 4, LOOK_MS);
    this.reportMs = set.reportMs;
    this.cols = set.cols;
    this.rows = set.rows;
  }

  private hookRejected(key: string | null, event: string, reason: string): void {
    (this.opts.log ?? console.log)(`Hook ${event} rejected: ${reason}${key ? ` (agent ${key})` : ''}`);
    if (key) this.opts.send({ type: 'agent.hook_rejected', agentKey: key, event, reason });
  }

  start(): Promise<void> {
    return this.bridge.start();
  }

  async stop(): Promise<void> {
    this.closeViews();
    for (const a of this.agents.values()) this.unwatch(a);
    this.bridge.stop();
    this.fs.stop();
    await this.opts.tmux.stopAll();
  }

  private asAgent(argv: string[]): string[] {
    return this.opts.user ? asAgent(argv, this.opts.user) : argv;
  }

  /* The processes an agent's session starts its program in. */
  private async panes(key: string): Promise<number[]> {
    const out = await this.opts.tmux.run(['list-panes', '-s', '-t', `=${this.agent(key).name}`, '-F', '#{pane_pid}']).catch(() => '');
    return out.split('\n').filter(line => /^\d+$/.test(line)).map(Number);
  }

  screen(key: string): Promise<string> {
    return this.opts.tmux.screen(this.agent(key).name);
  }

  private agent(key: string): Agent {
    let a = this.agents.get(key);
    if (!a) {
      a = { key, name: `a-${key}`, program: null, signedOut: null, home: '', workDir: '', hash: null, sessionId: null, cleared: new Set(), tail: null, oldLogs: null, startedAt: 0, started: null, ended: null, turn: null, busy: false, limits: null, contextUsed: null, contextSize: null, viewers: 0, up: false, watch: null, saying: Promise.resolve(), queue: Promise.resolve(), unopened: [], stopped: false, failure: null, lastText: null, stepSaid: false, settling: null, fresh: false, starting: null, keep: null, agyRead: null, agyAnswered: false, interruptions: 0, calls: new Map() };
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
    /* Clear words left in the input by a failed live delivery before this turn pastes its prompt. */
    await a.saying;
    const { input, program } = job;
    /* A turn a person typed may still run, or wait for the rest of its log; Hornhoof's turn goes in after it, or into it
       once the time Hornhoof gave this turn is over. Nothing stops the program: only its own end or a person does. */
    await this.waitForTurn(a, job);
    if (input.signal?.aborted) return this.failedTurn(a, job, 'cancelled');
    a.signedOut = job.signedOut;

    await this.fs.mkdir(input.workDir);
    const urls = this.bridge.agent(job.key);
    const instructionsFile = await this.writeInstructions(job);
    const spec = program.launch({ bin: job.bin, home: job.home, workDir: input.workDir, sessionId: input.sessionId, model: input.model, effort: input.effort, compactWindow: input.compactWindow, instructionsFile, urls, plugins: this.plugins });
    const hash = launchHash(job, spec);
    const goesOn = await this.goesOn(a, input.sessionId, hash);
    /* A program started with nothing to type gets its tools before its turn ends, while Hornhoof still answers for them.
       Kimi Code connects to its tools only once it has a session, which a new one gets with the first message, and
       Antigravity only while it answers a message. */
    const lazy = (program.kind === 'kimi' && !input.sessionId) || program.kind === 'antigravity';
    const tools = !goesOn && !input.prompt && input.tools && !lazy ? this.bridge.listed(job.key, this.toolsMs) : null;

    /* What is left in the log from before belongs to no turn. */
    this.drain(a);
    a.lastText = null;
    a.stepSaid = false;
    a.calls.clear();
    this.bridge.setToken(job.key, input.tools?.token ?? null);
    const starting = input.prompt ? null : (tools ?? Promise.resolve());
    const turn: Turn = { jobId: null, onEvent: input.onEvent ?? (() => {}), typed: false, seq: 0, signal: input.signal, ...(starting ? { starting: true } : {}) };
    if (starting) a.starting = starting;
    a.turn = turn;
    a.ended = deferred();
    a.stopped = false;
    a.failure = null;
    try {
      const failed = goesOn ? null : await this.startProgram(a, job, spec, hash, urls);
      if (failed) return failed;
      /* Nothing to type: the turn only starts the program for the person who opened its window. */
      if (!input.prompt) return await this.started(a, turn, tools, goesOn ? null : input.sessionId === null);
      return (await this.typePrompt(a, job, input.prompt)) ?? (await this.turnEnd(a, job, a.ended));
    } finally {
      a.typing = null;
      if (starting && a.starting === starting) a.starting = null;
      if (a.turn === turn) {
        this.bridge.setToken(job.key, null);
        a.turn = null;
        a.ended = null;
      }
    }
  }

  private async waitForTurn(a: Agent, job: TermJob): Promise<void> {
    const deadline = Date.now() + job.input.timeoutMs;
    for (this.drain(a); a.busy && !job.input.signal?.aborted && Date.now() < deadline; this.drain(a)) await sleep(this.pollMs);
    await a.settling;
    await a.cancelling;
  }

  /* What the agent is told before its turn. The conversation from before reaches a program that starts now; it is not part
     of its instructions' hash. Claude Code keeps only what was said in its log, so what a new session was told from before
     goes with it to every resume. So it does for Kimi Code, which may read AGENTS.md afresh for a session it resumes. */
  private async toldOf({ program, input }: TermJob): Promise<string> {
    const kept = program.kind !== 'codex' && input.sessionId ? await keptContext(this.fs, input.workDir, input.sessionId) : null;
    const context = kept && input.context && !kept.includes(input.context) ? `${kept}\n\n${input.context}` : (kept ?? input.context);
    return [input.instructions, context, input.guidance].filter(Boolean).join('\n\n');
  }

  /* Claude Code reads what it is told from the file it starts with, which this returns. Codex, Kimi Code and Antigravity
     read AGENTS.md in the folder they start in, agy only its start. */
  private async writeInstructions(job: TermJob): Promise<string | null> {
    const told = await this.toldOf(job);
    const file = join(job.input.workDir, '.hh-instructions.md');
    if (!told) return null;
    if (job.program.kind === 'claude') {
      await this.fs.write(file, told + '\n');
      return file;
    }
    const { rules, whole } = job.program.kind === 'antigravity' ? agyRules(told, file) : { rules: told, whole: null };
    if (whole) await this.fs.write(file, whole + '\n');
    await this.fs.write(join(job.input.workDir, 'AGENTS.md'), rules + '\n');
    return null;
  }

  /* The program runs as this turn would start it, in the session it asks for. A new session asked for goes on in a program
     started for a person that nothing was said in yet. */
  private async goesOn(a: Agent, sessionId: string | null, hash: string): Promise<boolean> {
    const sameSession = sessionId === null ? a.fresh : sessionId === a.sessionId || a.cleared.has(sessionId);
    return sameSession && a.hash === hash && (await this.opts.tmux.alive(a.name));
  }

  /* Starts the program for the turn. One that never shows it is ready ends the turn with its screen, which says why. */
  private async startProgram(a: Agent, job: TermJob, spec: LaunchSpec, hash: string, urls: AgentUrls): Promise<RunResult | null> {
    const { input } = job;
    this.programIs(a, false);
    await this.prepare(job, urls);
    Object.assign(a, { ...startedState(job, spec), hash });
    if (job.program.kind === 'claude' && !input.sessionId) await this.keepNew(input, spec.sessionId);
    a.tail = this.tailFor(a);
    const env = { ...lasting(input.env), ...spec.env };
    const scratch = this.opts.tmux.scratch();
    await this.opts.tmux.launch(a.name, { cwd: input.workDir, command: this.asAgent(spec.command), cols: this.cols, rows: this.rows, envFile: envFile(scratch, env), outputDir: scratch });
    this.watch(a);
    if (await this.ready(a, job)) {
      this.programIs(a, true);
      return null;
    }
    const screen = await this.screen(job.key);
    /* Its screen says why, which the loader would hide. */
    this.showViews(a);
    return await this.failedTurn(a, job, job.signedOut.test(screen) ? 'not_logged_in' : 'agent_failed', screen);
  }

  /* What each program needs in its folders before it starts. A person's first message into a new Kimi session, or into
     Antigravity, reaches its tools a moment before Hornhoof opens their turn. */
  private async prepare({ key, home, program, input }: TermJob, urls: AgentUrls): Promise<void> {
    if (program.kind === 'claude') await acceptClaudeDialogs(home, input.workDir, this.fs);
    if (program.kind === 'kimi') await prepareKimi(home, input.workDir, urls.mcpUrl, this.fs);
    if (program.kind === 'antigravity') await prepareAgy(input.workDir, urls.mcpUrl, this.fs);
    this.bridge.waitForTurns(key, program.kind === 'kimi' || program.kind === 'antigravity' ? this.openMs + 2000 : 0);
  }

  /* What a new Claude Code session was told from before goes with it to every resume. */
  private async keepNew(input: RunInput, sessionId: string | null): Promise<void> {
    if (input.context && sessionId) await keepContext(this.fs, input.workDir, sessionId, input.context);
  }

  /* A turn with nothing to type ends once the program has its tools. A person who typed meanwhile goes on with their turn,
     and the session is theirs to name. fresh: whether a program started now waits for a new session. */
  private async started(a: Agent, turn: Turn, tools: Promise<unknown> | null, fresh: boolean | null): Promise<RunResult> {
    await tools;
    if (a.turn !== turn) return { ok: true, sessionId: null, result: '', output: '', error: null, limits: a.limits };
    if (fresh !== null) a.fresh = fresh;
    return { ok: true, sessionId: a.fresh ? null : a.sessionId, result: '', output: '', error: null, limits: a.limits };
  }

  /* Types Hornhoof's prompt. A program that just started, or that still loads a long session it resumed, can miss the
     Enter and keep the prompt in its input: Enter again until it takes it. An Enter into an empty input does nothing. One
     that never takes it ends the turn with its screen, which says why, rather than leave the turn waiting for nothing. */
  private async typePrompt(a: Agent, job: TermJob, prompt: string): Promise<RunResult | null> {
    a.fresh = false;
    a.took = false;
    a.typing = prompt;
    await this.opts.tmux.paste(a.name, prompt);
    await sleep(pasteWait(prompt));
    await this.opts.tmux.keys(a.name, 'Enter');
    /* On a busy machine the program can take the prompt, and even end its turn, before the key is back: it then said so
       itself, and its turn's end must not be taken back. */
    if (!a.took) a.busy = true;
    for (const end = Date.now() + this.readyMs; !(await this.tookPrompt(a, job.input.signal)); await this.opts.tmux.keys(a.name, 'Enter')) {
      if (Date.now() < end) continue;
      a.busy = false;
      /* Its input still holds the prompt, so the next turn starts the program anew, resuming the session. */
      a.hash = null;
      return await this.failedTurn(a, job, 'agent_failed', `The program did not take Hornhoof's prompt within ${Math.round(this.readyMs / 1000)} s.\n\n${await this.screen(job.key)}`);
    }
    return null;
  }

  /* Waits for the turn to end: the program says so, a person stops it, the program is gone, or it waits for what to type
     in a turn whose end was lost on the way. */
  private async turnEnd(a: Agent, job: TermJob, ended: Deferred<string>): Promise<RunResult> {
    const { watch, look } = this.observeProgram(a, job.input.jobId);
    for (;;) {
      this.drain(a);
      const message = await Promise.race([ended.promise, sleep(this.pollMs).then(() => null)]);
      if (message !== null) return await this.saidEnded(a, job, message);
      /* A program stopped with Escape does not say its turn ended: it waits for the next prompt. */
      if (job.input.signal?.aborted) return await this.stopTurn(a, job, ended);
      if (!(await this.opts.tmux.alive(a.name))) return await this.programGone(a, job, watch);
      if (await this.lostEnd(a, watch, look)) this.endUnsaid(a);
    }
  }

  /* Both entry paths follow the same program state and lost-end clock. Every opened turn has a running program. */
  private observeProgram(a: Agent, jobId: string | null | undefined): ObservedProgram {
    return { watch: new ProgramWatch(jobId, a.program!.kind, m => this.opts.send(m), this.reportMs, () => this.opts.secrets()), look: { at: Date.now(), call: null } };
  }

  /* The program said the turn ended: stopped by a person, failed, or with its answer, which the turn waits to read. */
  private async saidEnded(a: Agent, job: TermJob, message: string): Promise<RunResult> {
    if (a.stopped) {
      a.busy = false;
      return await this.failedTurn(a, job, 'cancelled');
    }
    if (a.failure !== null) {
      const output = `${a.failure}\n\n${await this.screen(job.key)}`;
      return await this.failedTurn(a, job, job.signedOut.test(a.failure) ? 'not_logged_in' : 'agent_failed', output);
    }
    await this.settle(a, message);
    await this.planLimits(a);
    /* A turn that ended with no answer keeps its screen, which says why, as when the provider refused the work. */
    const output = message.trim() ? '' : await this.screen(job.key);
    return { ok: true, sessionId: a.sessionId, result: message, output, error: null, limits: a.limits };
  }

  private async stopTurn(a: Agent, job: TermJob, ended: Deferred<string>): Promise<RunResult> {
    await this.opts.tmux.keys(a.name, 'Escape');
    await Promise.race([ended.promise, sleep(STOP_WAIT_MS)]);
    a.busy = false;
    return await this.failedTurn(a, job, 'cancelled');
  }

  private async programGone(a: Agent, job: TermJob, watch: ProgramWatch): Promise<RunResult> {
    a.busy = false;
    this.programEnded(a);
    const screen = await this.screen(job.key);
    await this.toldGone(a, watch, screen);
    return await this.failedTurn(a, job, job.signedOut.test(screen) ? 'not_logged_in' : 'agent_failed', screen);
  }

  /* Looks at what the program does, at once when it began or ended a tool or Hornhoof is due to hear again, else every
     lookMs, and tells Hornhoof. True once it waited for what to type for lostMs of Hornhoof's turn: the word that the turn
     ended was lost on the way. */
  private async lostEnd(a: Agent, watch: ProgramWatch, look: Look): Promise<boolean> {
    const turn = a.turn;
    const now = Date.now();
    const call = a.calls.values().next().value ?? null;
    if (call === look.call && now - look.at < this.lookMs && !watch.due(now)) return false;
    Object.assign(look, { at: now, call });
    const screen = await this.opts.tmux.screen(a.name, 0, true);
    if (a.turn !== turn) return false;
    const state = watch.look(now, screen, call, Boolean(a.took && a.busy));
    if (this.atInterruption(a, screen, state)) {
      this.interrupted(a);
      return false;
    }
    return watch.idleFor(now) >= this.lostMs;
  }

  private atInterruption(a: Agent, screen: string, state: string): boolean {
    if (a.program?.kind !== 'antigravity' || state !== 'idle') return false;
    return this.stoppable(a) && interruptionCount(screen) > a.interruptions;
  }

  /* Hornhoof hears that the turn's program is gone, how it ended and what it showed last, without the secrets. */
  private async toldGone(a: Agent, watch: ProgramWatch, screen: string): Promise<void> {
    const ended = (await this.opts.tmux.exitSnapshot(a.name))?.programOutput;
    this.reportGone(watch, ended, screen);
  }

  private reportGone(watch: ProgramWatch, ended: ProgramOutput | undefined, screen: string): void {
    const secrets = this.opts.secrets();
    watch.gone(Date.now(), ended ? { code: ended.code, signal: signalName(ended.signal) } : null, redact(plainOutput(redact(screen, secrets)), secrets));
  }

  /* The turn ends as the program would have said it ended, with its last answer; nothing reaches the program, which waits
     for its next turn. */
  private endUnsaid(a: Agent): void {
    this.log(`Agent ${a.key} (${a.program?.kind}): end seen without hook. The program waited for what to type ${Math.round(this.lostMs / 1000)} s into Hornhoof's turn, which ends with its last answer.`);
    a.busy = false;
    const message = a.lastText ?? '';
    this.finishTyped(a, message);
    a.ended?.resolve(message);
  }

  private async failedTurn(a: Agent, job: TermJob, error: RunResult['error'], output?: string): Promise<RunResult> {
    const ended = error === 'agent_failed' || error === 'not_logged_in' ? await this.opts.tmux.exitSnapshot(a.name) : null;
    const details = ended?.output ?? output ?? await this.screen(job.key);
    return { ok: false, sessionId: a.sessionId, result: '', output: details, programOutput: ended?.programOutput, error: exitError(ended?.output ?? null, job.signedOut, error), limits: a.limits };
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

  private unwatch(a: Agent): void {
    if (a.watch) clearInterval(a.watch);
    a.watch = null;
  }

  private async look(a: Agent): Promise<void> {
    this.drain(a);
    const turn = a.turn;
    if (turn && !turn.typed) return;
    const alive = await this.opts.tmux.alive(a.name);
    if (a.turn !== turn) return;
    if (alive) return this.lookTyped(a, turn);
    /* What the program logged before it ended, as words a person typed into Codex, comes first. */
    this.drain(a);
    await this.endedTyped(a);
  }

  private async lookTyped(a: Agent, turn: Turn | null): Promise<void> {
    const observed = turn?.observed;
    if (!observed) return;
    const lost = await this.lostEnd(a, observed.watch, observed.look);
    if (lost && a.turn === turn) this.endUnsaid(a);
  }

  private async endedTyped(a: Agent): Promise<void> {
    const turn = a.turn;
    const ended = turn?.typed ? await this.typedExit(a, turn) : null;
    if (a.turn !== turn) return;
    a.busy = false;
    this.programEnded(a);
    this.finishTyped(a, '', exitError(ended?.output ?? null, a.signedOut, 'agent_failed'), ended?.output ?? '', ended?.programOutput);
    this.unwatch(a);
  }

  private async typedExit(a: Agent, turn: Turn) {
    const ended = await this.opts.tmux.exitSnapshot(a.name);
    const screen = ended?.output ?? await this.screen(a.key);
    if (a.turn === turn) this.reportGone(turn.observed!.watch, ended?.programOutput, screen);
    return ended;
  }

  /* A person cleared the conversation in Claude Code, which goes on in a new session with a log of its own; or Kimi Code
     named its session, whose log the host finds once Kimi writes it; or Antigravity named its conversation. */
  private follow(a: Agent, sessionId: string): void {
    if (!sessionId || sessionId === a.sessionId) return;
    if (a.sessionId) a.cleared.add(a.sessionId);
    a.sessionId = sessionId;
    if (a.program?.kind === 'claude') a.tail = new LineTail(claudeTranscript(a.home, realpathSync(a.workDir), sessionId));
    if (a.program?.kind === 'kimi' || a.program?.kind === 'antigravity') {
      if (a.program.kind === 'kimi') a.tail = null;
      else {
        const file = agyTranscript(a.home, sessionId);
        a.agyRead = agySteps();
        a.tail = file ? new LineTail(file) : null;
      }
      if (a.keep) void keepContext(this.fs, a.workDir, sessionId, a.keep).catch(() => {});
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
  /* Hornhoof's turn ended in the program, and the host only reads the rest of its log. */
  private overIn(a: Agent): boolean {
    return Boolean(a.turn && !a.turn.typed && !a.turn.starting && a.ended?.settled);
  }

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

  /* Whether within enterWaitMs the program took the prompt Hornhoof typed, ended its turn or ended itself, or the turn
     was called off: the turn goes on from there without another Enter. */
  private async tookPrompt(a: Agent, signal?: AbortSignal): Promise<boolean> {
    let ended = false;
    void a.ended?.promise.then(() => (ended = true));
    for (const end = Date.now() + this.enterWaitMs; Date.now() < end; await sleep(this.pollMs)) {
      this.drain(a);
      if (a.took || ended || signal?.aborted || !(await this.opts.tmux.alive(a.name))) return true;
    }
    return false;
  }

  /* Claude Code says it started through its hook; the others are ready once their prompt shows. Kimi shows its prompt
     also when it is not signed in, with a word to sign in. */
  private async ready(a: Agent, job: TermJob): Promise<boolean> {
    const end = Date.now() + this.readyMs;
    while (Date.now() < end) {
      if (!(await this.opts.tmux.alive(a.name))) return false;
      const kind = job.program.kind;
      if (kind === 'claude') {
        if (await Promise.race([a.started!.promise.then(() => true), sleep(this.pollMs).then(() => false)])) {
          await this.inputShows(a);
          return true;
        }
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

  /* Claude Code can say it started before its input box is up, and loses what is typed into it until then. Hornhoof's
     prompt goes in once the box shows, empty; a screen that never shows one goes on after a while, as before. */
  private async inputShows(a: Agent): Promise<void> {
    if (a.program?.kind !== 'claude' || (await this.inputBox(a))) return;
    /* A program that ended says why on its screen, which the turn shows. */
    if (await this.opts.tmux.alive(a.name)) this.log(`Agent ${a.key} (claude): no empty input box showed within ${INPUT_WAIT_MS / 1000} s of its start. The prompt goes in all the same.`);
  }

  /* Whether Claude Code's input box shows, empty, within INPUT_WAIT_MS while the program runs. */
  private async inputBox(a: Agent): Promise<boolean> {
    for (const end = Date.now() + INPUT_WAIT_MS; Date.now() < end && (await this.opts.tmux.alive(a.name)); await sleep(this.pollMs)) {
      if (inputOf('claude', await this.opts.tmux.screen(a.name, 0, true)) === '') return true;
    }
    return false;
  }

  private log(message: string): void {
    (this.opts.log ?? console.log)(message);
  }

  /* The program's prompt hook said what it got of the prompt Hornhoof typed. Got less, the agent finds the whole of it in
     a file of its folder, and the hook's answer, which the program adds to the prompt, says where. */
  private async promptGot(a: Agent, got: string): Promise<string> {
    const typed = a.typing;
    a.typing = null;
    if (typed == null || flat(got).includes(flat(typed))) return '';
    const file = join(a.workDir, '.hh-messages', `${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    await this.fs.mkdir(dirname(file));
    await this.fs.write(file, typed);
    this.log(`Agent ${a.key} (${a.program?.kind}): the program got ${got.length} of the ${typed.length} characters Hornhoof typed. The whole text is in ${file}.`);
    return `Hornhoof: this message reached you cut short, ${got.length} of its ${typed.length} characters. The whole message is in ${file}. Read it there before you go on.`;
  }

  private tailFor(a: Agent): LineTail | null {
    /* The program names its folder by the real path, without links. */
    if (a.program?.kind === 'claude' && a.sessionId) return new LineTail(claudeTranscript(a.home, realpathSync(a.workDir), a.sessionId), { fromEnd: true });
    if (a.program?.kind === 'codex' && a.sessionId) {
      const found = findRollout(a.home, a.workDir, 0, a.sessionId);
      return found ? new LineTail(found.file, { fromEnd: true }) : null;
    }
    if (a.program?.kind === 'antigravity') {
      a.agyRead = agySteps();
      const file = a.sessionId ? agyTranscript(a.home, a.sessionId) : null;
      return file ? new LineTail(file, { fromEnd: true }) : null;
    }
    const wire = a.program?.kind === 'kimi' && a.sessionId ? findKimiWire(a.home, a.sessionId) : null;
    return wire ? new LineTail(wire, { fromEnd: true }) : null;
  }

  /* What the program wrote to its log since last time: events for the turn, Codex's limits, session and turn end. */
  private drain(a: Agent): void {
    if (!a.tail && a.program?.kind === 'codex') {
      const found = findRollout(a.home, a.workDir, a.startedAt - 2000, null, a.oldLogs ?? undefined);
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
      if (a.program?.kind === 'antigravity') {
        this.agyNews(a, data);
        continue;
      }
      this.called(a, data);
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
      if (news.typed !== undefined && (!a.turn || a.turn.starting || this.overIn(a))) void this.openTyped(a, news.typed, true);
      for (const e of news.events) this.emit(a, e);
      if (news.limits) a.limits = news.limits;
      if (news.context !== undefined) this.context(a, news.context);
      if (news.session) a.sessionId = news.session.id;
      if (news.started) a.busy = a.took = true;
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

  /* Tool calls a line of the program's log began and ended, for what it does now. */
  private called(a: Agent, line: unknown): void {
    const kind = a.program?.kind;
    if (kind && kind !== 'antigravity') this.recordCalls(a, CALLS[kind](line));
  }

  private recordCalls(a: Agent, calls: Calls): void {
    for (const id of calls.ended) a.calls.delete(id);
    for (const { id, name } of calls.began) if (!a.calls.has(id)) a.calls.set(id, { name, at: Date.now() });
  }

  private agyNews(a: Agent, data: unknown): void {
    const news = a.agyRead?.(data);
    if (!news) return;
    this.recordCalls(a, news);
    if (news.answered !== undefined) a.agyAnswered = news.answered;
    for (const e of news.events) this.emit(a, e);
  }

  /* Kimi Code logs a turn's end without its answer, which is the text of its last step that said anything, in parts. A
     person's turn reaches Hornhoof through Kimi's prompt hook, as in Claude Code. */
  private kimiNews(a: Agent, news: WireNews): void {
    if (news.step) a.stepSaid = false;
    if (news.model) a.contextSize = kimiWindow(a.home, news.model);
    if (news.tokens !== undefined && a.contextSize) this.context(a, Math.min(1, news.tokens / a.contextSize));
    for (const e of news.events) {
      const before = a.lastText;
      this.emit(a, e);
      if (e.kind !== 'text') continue;
      if (a.stepSaid) a.lastText = (before ?? '') + e.text;
      a.stepSaid = true;
    }
    if (news.started) a.busy = a.took = true;
    if (!(news.ended || news.aborted || news.failed !== undefined)) return;
    /* An end logged before the running turn's prompt went in belongs to the last turn, but a blocked prompt is the running
       turn's own: it never starts. With no turn, the program is free. */
    if (!this.stoppable(a) && !(news.blocked && a.turn)) {
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

  /* Reads the log until the turn's answer is in it. A null message means agy's stop carries no answer to match. */
  private async settle(a: Agent, message: string | null): Promise<string> {
    for (const end = Date.now() + SETTLE_MS; ; await sleep(100)) {
      this.drain(a);
      if (this.answerRead(a, message) || Date.now() > end) return message ?? a.lastText ?? '';
    }
  }

  private answerRead(a: Agent, message: string | null): boolean {
    if (message === null) return a.agyAnswered;
    const answer = message.trim();
    return a.program?.kind !== 'claude' || !answer || a.lastText?.trim() === answer;
  }

  /* Hornhoof hears how full the context is once it moved by a percent or more, for the bar on the map. */
  private context(a: Agent, used: number): void {
    if (a.contextUsed !== null && Math.abs(used - a.contextUsed) < 0.01) return;
    a.contextUsed = used;
    this.opts.send({ type: 'agent.context', agentKey: a.key, used });
  }

  private emit(a: Agent, event: AgentEvent): void {
    const turn = activeTurn(a);
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

  private async hook(key: string, event: string, body: unknown): Promise<string | void> {
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
        const used = claudeStatusContext(data);
        if (used !== null) this.context(a, used);
        return;
      }
      case 'prompt': {
        a.took = true;
        /* Kimi Code hands the prompt as parts of a message. */
        const prompt = typeof data.prompt === 'string' ? data.prompt : contentText(data.prompt);
        const notice = await this.promptGot(a, prompt);
        await this.prompted(a, prompt);
        return notice;
      }
      case 'invocation':
        await this.invocation(a, data);
        return;
      case 'stop':
        this.stoppedHook(a, data);
        return;
    }
  }

  private async invocation(a: Agent, data: Record<string, unknown>): Promise<void> {
    if (a.program?.kind !== 'antigravity') return;
    if (typeof data.conversationId === 'string') this.follow(a, data.conversationId);
    if (data.invocationNum !== 0) {
      a.busy = true;
      return;
    }
    a.typing = null;
    await this.prompted(a, String(data.lastUserInput ?? ''));
  }

  private async prompted(a: Agent, prompt: string): Promise<void> {
    a.took = true;
    await a.settling;
    if (a.program?.kind === 'antigravity') {
      a.agyAnswered = false;
      a.interruptions = interruptionCount(await this.opts.tmux.screen(a.name, 0, true));
    }
    a.busy = true;
    /* A message queued in the program starts its own turn after the previous one ends. */
    if (!a.turn || a.turn.starting || this.overIn(a)) await this.openTyped(a, prompt);
  }

  private stoppedHook(a: Agent, data: Record<string, unknown>): void {
    this.drain(a);
    a.busy = false;
    if (typeof data.session_id === 'string') this.follow(a, data.session_id);
    const failed = typeof data.error === 'string' && data.error ? data.error : null;
    const message = failed !== null ? '' : a.program?.kind === 'antigravity' ? null : String(data.last_assistant_message ?? '');
    const turn = a.turn;
    /* The hook answers first: the program may write the rest of its log only after. */
    if (turn?.typed || message === null) {
      a.settling = this.settle(a, message)
        .then(answer => {
          if (a.turn === turn) this.endHook(a, answer, failed);
        })
        .finally(() => (a.settling = null));
    } else this.endHook(a, message, failed);
  }

  private endHook(a: Agent, message: string, failed: string | null): void {
    if (a.turn?.typed) return this.finishTyped(a, message, failed === null ? null : 'agent_failed', failed ?? '');
    if (failed !== null) a.failure = failed;
    a.ended?.resolve(message);
  }

  /* A person typed while no turn ran, or while the program started: the turn starts at once and Hornhoof opens a job for
     it, so the agent has its tools and the turn shows like any other. Claude Code waits in its hook for Hornhoof's answer,
     for a while; Codex goes on, and what it does waits in the turn. fromLog: the typing was read from the log, which is
     being read now. */
  private async openTyped(a: Agent, text: string, fromLog = false): Promise<void> {
    const start = a.starting;
    a.fresh = false;
    if (!fromLog) this.drain(a);
    a.lastText = null;
    a.stepSaid = false;
    const turn: Turn = { jobId: null, onEvent: () => {}, typed: true, seq: 0, ref: randomUUID(), early: [], over: null, opened: deferred() };
    turn.observed = this.observeProgram(a, null);
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
    this.bindTyped(a, turn, m, early);
    turn.opened?.resolve();
    if (turn.over) this.typedDone(turn, turn.over.message, turn.over.error, turn.over.sessionId, turn.over.output, turn.over.programOutput);
  }

  private bindTyped(a: Agent, turn: Turn, m: Msg<'turn.opened'>, early: AgentEvent[]): void {
    if (m.jobId && m.toolToken) {
      turn.jobId = m.jobId;
      turn.toolToken = m.toolToken;
      turn.observed!.watch.bind(m.jobId, Date.now());
      if (a.turn === turn) this.bridge.setToken(a.key, m.toolToken);
      for (const e of early) this.typedEvent(turn, e);
    }
  }

  private finishTyped(a: Agent, message: string, error: JobError = null, output = '', programOutput?: ProgramOutput): void {
    const turn = a.turn;
    if (!turn?.typed) return;
    a.turn = null;
    if (a.sessionId) this.opts.remember?.(a.sessionId, a.workDir);
    this.bridge.setToken(a.key, null);
    /* Hornhoof hears the limits with the next turn it runs. */
    void this.planLimits(a);
    /* Hornhoof has not answered yet: the end goes out with its answer. */
    if (turn.early) turn.over = { message, error, sessionId: a.sessionId, output, programOutput };
    else this.typedDone(turn, message, error, a.sessionId, output, programOutput);
  }

  private typedDone(turn: Turn, message: string, error: JobError, sessionId: string | null, output: string, programOutput?: ProgramOutput): void {
    if (!turn.jobId) return;
    const result = error === 'cancelled' ? 'Stopped.' : error ? '' : message;
    this.opts.send(jobDone(turn.jobId, { ok: !error, sessionId, result, output, programOutput, error, limits: null }, [...this.opts.secrets(), ...(turn.toolToken ? [turn.toolToken] : [])]));
  }

  /* Turns people typed that run now: they count as running when the node says hello again. */
  typedJobs(): string[] {
    return [...this.agents.values()].flatMap(a => (a.turn?.typed && a.turn.jobId ? [a.turn.jobId] : []));
  }

  /* Words for the agent while its turn runs, typed into the program as a person types: Claude Code, Codex and Kimi Code
     take them into the turn at its next step. False when no turn runs or the program takes none, so Hornhoof gives them
     the next turn instead. */
  say(key: string, text: string, within = Infinity): Promise<boolean> {
    const a = this.agents.get(key);
    if (!a?.turn) return Promise.resolve(false);
    const words = { turn: a.turn, text, deadline: Date.now() + within };
    const said = a.saying.then(() => this.sayIn(a, words));
    a.saying = said.catch(() => {});
    return said;
  }

  private async sayIn(a: Agent, words: LiveWords): Promise<boolean> {
    /* Antigravity queues typed words as a separate turn, so these wait for Hornhoof's next turn. */
    if (a.program?.kind === 'antigravity') return false;
    await this.waitToSay(a, words);
    const input = await this.readInput(a);
    if (input || !(await this.canSay(a, words))) return false;
    const wait = pasteWait(words.text);
    if (Date.now() + wait >= words.deadline) return false;
    let went = false;
    try {
      await this.opts.tmux.paste(a.name, words.text);
      await sleep(wait);
      if (!(await this.canSay(a, words))) return false;
      await this.opts.tmux.keys(a.name, 'Enter');
      went = input === null || await this.tookWords(a, words);
      return went;
    } catch {
      return false;
    } finally {
      if (!went) await this.discardWords(a, words);
    }
  }

  private async waitToSay(a: Agent, words: LiveWords): Promise<void> {
    /* Hornhoof's own prompt goes in first, or the words would join it in the program's input. */
    const end = Math.min(words.deadline, Date.now() + ENTER_TRIES * this.enterWaitMs);
    while (a.turn === words.turn && !words.turn.typed && !a.took && Date.now() < end) {
      this.drain(a);
      await sleep(this.pollMs);
    }
  }

  private wordsMayGoIn(a: Agent, words: LiveWords): boolean {
    this.drain(a);
    /* A turn that ended in the program takes no words: typed then, they would start a turn nobody waits for. */
    return activeTurn(a) === words.turn && !words.turn.starting && (words.turn.typed || Boolean(a.took)) && a.busy && !this.overIn(a) && Date.now() < words.deadline;
  }

  private async canSay(a: Agent, words: LiveWords): Promise<boolean> {
    return this.wordsMayGoIn(a, words) && (await this.opts.tmux.alive(a.name)) && this.wordsMayGoIn(a, words);
  }

  private async readInput(a: Agent): Promise<string | null> {
    const screen = await this.opts.tmux.screen(a.name, 0, true);
    const input = a.program ? inputOf(a.program.kind, screen) : null;
    if (input === null && !a.inputUnknown) {
      a.inputUnknown = true;
      this.log(`Agent ${a.key} (${a.program?.kind}): input could not be found. Live words will use paste and Enter.`);
    }
    return input;
  }

  private async tookWords(a: Agent, words: LiveWords): Promise<boolean> {
    const end = Math.min(words.deadline, Date.now() + this.enterWaitMs);
    while (Date.now() < end) {
      const input = await this.readInput(a);
      if (input === null) return true;
      if (!(await this.canSay(a, words))) return false;
      if (!input) return true;
      await sleep(this.pollMs);
    }
    return false;
  }

  private async discardWords(a: Agent, words: LiveWords): Promise<void> {
    /* A missed Enter must not leave words for a later turn to submit. Start afresh on the next turn as well. */
    a.hash = null;
    if (a.turn && a.turn !== words.turn) return;
    const erase = words.text.split('\n').flatMap((_, i) => i ? ['BSpace', 'C-u'] : ['C-u']);
    await this.opts.tmux.keys(a.name, ...erase).catch(() => {});
  }

  /* Hornhoof calls off a turn a person typed: the program stops as on Escape, and the turn ends as stopped. */
  async cancel(jobId: string): Promise<void> {
    const a = [...this.agents.values()].find(x => x.turn?.typed && x.turn.jobId === jobId);
    if (!a) return;
    this.finishTyped(a, '', 'cancelled');
    /* A session that is gone took its program with it; the turn ends all the same. */
    a.cancelling = this.opts.tmux.keys(a.name, 'Escape').catch(() => {});
    await a.cancelling;
    a.busy = false;
  }

  /* The agent's views hear when its program comes up or goes. */
  private programIs(a: Agent, up: boolean): void {
    if (a.up === up) return;
    a.up = up;
    this.showViews(a, up);
  }

  /* A program that ended keeps its last screen on show, which says why; the loader is for a program that starts. */
  private programEnded(a: Agent): void {
    a.up = false;
    this.showViews(a);
  }

  private showViews(a: Agent, running = true): void {
    for (const [termId, view] of this.views) if (view.key === a.key) this.opts.send({ type: 'term.program', termId, running });
  }

  /* Views belong to one connection to Hornhoof; after it came back, people open them again. */
  closeViews(): void {
    for (const view of this.views.values()) view.child.kill();
  }

  async open(m: Msg<'term.open'>): Promise<void> {
    try {
      await this.openView(m);
    } catch (err) {
      /* A view that did not open keeps no size. */
      await this.forget(m.termId, m.agentKey);
      throw err;
    }
  }

  /* The others may have got smaller for a view that is gone. */
  private forget(termId: string, key: string): Promise<void> {
    this.wanted.delete(termId);
    return this.fit(key);
  }

  private ensureSession(a: Agent, starts: boolean): Promise<void> {
    const opening = this.sessionsOpening.get(a.key);
    if (opening) return opening;
    const created = this.createSession(a, starts).finally(() => this.sessionsOpening.delete(a.key));
    this.sessionsOpening.set(a.key, created);
    return created;
  }

  private async createSession(a: Agent, starts: boolean): Promise<void> {
    if (await this.opts.tmux.has(a.name)) return;
    /* The window shows a loader over the empty session while the program starts. */
    const waiting = starts ? '' : `printf '\\n  %s\\n' '${WAITING}'; `;
    await this.opts.tmux.launch(a.name, { cwd: '/', command: this.asAgent(['sh', '-c', `${waiting}exec sleep 2147483647`]), ...this.fitted(a.key) });
    /* The waiting screen is no program of the agent's: the next turn starts one in its place. A turn that runs now is
       starting its own. */
    if (!a.turn) a.hash = null;
  }

  private async openView(m: Msg<'term.open'>): Promise<void> {
    const a = this.agent(m.agentKey);
    this.viewsOpening.add(m.termId);
    this.wanted.set(m.termId, { key: m.agentKey, size: { cols: m.cols, rows: m.rows } });
    /* Someone who may type gets the program at once, to talk to it; watchers see it once it has a turn. */
    const starts = m.write && !a.turn && !(a.hash && (await this.opts.tmux.alive(a.name)));
    try {
      await this.ensureSession(a, starts);
      /* The others get smaller first, if this window is: a client bigger than the session gets rows of dots. */
      await this.fit(m.agentKey);
    } finally {
      this.viewsOpening.delete(m.termId);
    }
    if (this.viewsClosed.delete(m.termId)) return this.forget(m.termId, m.agentKey);
    const shown = this.fitted(m.agentKey);
    const child = this.opts.tmux.attach(a.name, shown.cols, shown.rows, m.write);
    const view: View = { child, key: m.agentKey, write: m.write, mask: new StreamMask(this.opts.secrets), decoder: new StringDecoder('utf8'), pending: '', timer: null, quiet: null, shown, applied: shown, tty: null, out: () => {} };
    this.views.set(m.termId, view);
    a.viewers++;
    /* A watcher of an agent that sleeps sees the waiting screen; anyone else, a loader until the program is up. */
    if (starts || a.turn || a.up) this.opts.send({ type: 'term.program', termId: m.termId, running: a.up && !starts });
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
    view.out = out;
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
      this.wanted.delete(m.termId);
      a.viewers = Math.max(0, a.viewers - 1);
      this.opts.send({ type: 'term.exit', termId: m.termId });
      void this.fit(m.agentKey);
    });
    if (starts) this.opts.send({ type: 'agent.start', agentKey: m.agentKey });
    /* A resize that came while it opened, or a window smaller than the others', sizes every view of the session. */
    await this.fit(m.agentKey);
  }

  input(m: Msg<'term.input'>): void {
    const view = this.views.get(m.termId);
    if (view?.write) view.child.stdin?.write(m.data);
  }

  async resize(m: Msg<'term.resize'>): Promise<void> {
    const wanted = this.wanted.get(m.termId);
    if (!wanted) return;
    wanted.size = { cols: m.cols, rows: m.rows };
    await this.fit(wanted.key);
  }

  /* One session runs one program at one size. People watching it in windows of different sizes are tmux clients of
     different sizes, and tmux fills what a bigger client has beyond the window with rows of dots. So every view of a
     session gets the size of the smallest window among them: all of it shows in each, and a bigger window keeps empty
     room below and to the right. */
  private fitted(key: string): Size {
    const size = { cols: Infinity, rows: Infinity };
    for (const w of this.wanted.values()) {
      if (w.key !== key) continue;
      size.cols = Math.min(size.cols, w.size.cols);
      size.rows = Math.min(size.rows, w.size.rows);
    }
    return size;
  }

  private async fit(key: string): Promise<void> {
    const size = this.fitted(key);
    const changed = [...this.views].filter(([termId, view]) => view.key === key && this.wanted.has(termId) && !sameSize(view.shown, size));
    await Promise.all(changed.map(([termId, view]) => this.sizeView(termId, view, size)));
  }

  private async sizeView(termId: string, view: View, size: Size): Promise<void> {
    view.shown = size;
    const tty = await this.ttyOf(termId, view);
    if (!tty) return;
    await this.applyNewest(tty, view);
    const last = view.shown;
    await this.clientSized(tty, last);
    if (view.shown === last) this.eraseBelowSession(termId, view, last);
  }

  /* Sizes on their way do not wait for each other. One that lands after a newer one would leave the terminal at the older
     size, so whichever ends last gives it the newest size again. */
  private async applyNewest(tty: string, view: View): Promise<void> {
    while (!sameSize(view.applied, view.shown)) {
      const size = view.shown;
      await stty(tty, size);
      view.applied = size;
    }
  }

  /* The terminal tells its client, which tells tmux; a session sized before then would still be sized for the old one. */
  private async clientSized(tty: string, size: Size): Promise<void> {
    for (const end = Date.now() + this.openMs; Date.now() < end; await new Promise(r => setTimeout(r, 20))) {
      const client = (await this.opts.tmux.clients()).find(c => c.tty === tty);
      if (!client || sameSize(client, size)) return;
    }
  }

  /* tmux redraws a client that got smaller only within its new size; what the window showed below stays unless erased. */
  private eraseBelowSession(termId: string, view: View, size: Size): void {
    const own = this.wanted.get(termId)?.size;
    if (own && size.rows < own.rows) view.out(eraseBelow(size.rows));
  }

  /* The terminal of a view's tmux client. A client attaches a moment after its view opens, so a size that comes before
     waits for it. */
  private async ttyOf(termId: string, view: View): Promise<string | null> {
    for (const end = Date.now() + this.openMs; !view.tty && this.views.get(termId) === view && Date.now() < end; await new Promise(r => setTimeout(r, 50))) {
      for (const client of await this.opts.tmux.clients()) if ((await parentOf(client.pid)) === view.child.pid) view.tty = client.tty;
    }
    return view.tty;
  }

  close(m: Msg<'term.close'>): void {
    const view = this.views.get(m.termId);
    if (view) {
      view.child.kill();
      /* Its viewer process takes a while to end; the others get their size back at once. */
      void this.forget(m.termId, view.key);
    } else if (this.viewsOpening.has(m.termId)) this.viewsClosed.add(m.termId);
  }
}

/* The process that started a given one: from /proc on Linux, from ps elsewhere. */
export async function parentOf(pid: number): Promise<number | null> {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch {
    return new Promise(resolve => execFile('ps', ['-o', 'ppid=', '-p', String(pid)], (err, out) => resolve(err ? null : Number(out.trim()))));
  }
}

function ownership(options: Options, panes: Panes): Ownership {
  if (options.owner) return options.owner(panes);
  return options.proc ? procOwner(options.proc)(panes) : { owns: null };
}

/* A cancelled turn can still wait for Escape and its final session, but takes no more input or events. */
function activeTurn(a: Agent): Turn | null {
  return a.turn?.signal?.aborted ? null : a.turn;
}

/* How many tokens the model Kimi starts with takes in its context, from its settings. */
function kimiWindow(home: string, model: string | null): number | null {
  try {
    return kimiContextSize(readFileSync(join(home, 'config.toml'), 'utf8'), model);
  } catch {
    return null;
  }
}
