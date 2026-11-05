import { execFile, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { TERM_CHUNK, UNHEARD_MS, type AgentEvent, type Failure, type Limits, type NodeMessage, type ServerMessage } from '@hornhoof/protocol';
import type { OperatorDelivery, OperatorQuestion, OperatorServerMessage } from '@hornhoof/protocol/program-operator';
import { agyRules, COLORS_NOT_TAKEN, colorsNotTaken, pastColors, SETUP_NEEDED } from '../providers/antigravity.js';
import { claudeEvents, claudeInterrupted } from '../providers/claude.js';
import type { ProgramRetry } from '@hornhoof/protocol/map';
import { contentText, isRecord } from '../providers/events.js';
import { agentFs, ownFs, type AgentFs } from '../agent-fs.js';
import { asAgent, type JobUser } from '../isolation.js';
import { kimiContextSize } from '../providers/kimi.js';
import { jobDone, tidy, type RunInput, type RunResult } from '../runner.js';
import { claudePlugins } from '../skills.js';
import { plainOutput, signalName, type ProgramOutput } from '../program-exit.js';
import { redact } from '../redact.js';
import { Bridge, type AgentUrls } from './bridge.js';
import { atEmptyPrompt, inputOf, withoutDim } from './input.js';
import { procOwner, type OwnerFactory, type Ownership, type Panes } from './peer.js';
import { StreamMask } from './mask.js';
import { ProgramWatch, READY, REPORT_MS, programState, type Pending } from './program-state.js';
import { acceptClaudeDialogs, agyTranscript, claudeTranscript, findKimiWire, findRollout, prepareAgy, prepareKimi, rolloutFiles, type LaunchSpec, type TermProgram } from './programs.js';
import { FAILURE, failure } from './failures.js';
import { TurnEnds, hookCalls, claudeEnd, type TurnEnd } from './turn-signals.js';
import { claudeWordReceipt, restartRefusal, resumeCommand, TurnWords, type RestartEvidence, type WordReceipt } from './program-restart.js';
import { CALLS } from './tool-calls.js';
import { agyError, agySteps, claudeStatusContext, claudeStatusLimits, codexRollout, kimiWire, LineTail, type WireNews } from './transcripts.js';
import type { RecordingCursor } from './recordings.js';
import { envFile, type Tmux } from './tmux.js';
import { LostWords } from './lost-words.js';
import { OperatorRuntime, type OperatorOptions } from './operator-runtime.js';
import { ownThought } from './operator-activity.js';
import type { OperatorProgram } from './operator-control.js';
import { operatorQuestion } from './operator-question.js';

/* An agent's turn in its terminal: which program, where it keeps its sign-in, and what the runner hands every program. */
export type TermJob = { key: string; program: TermProgram; bin: string; home: string; signedOut: RegExp; input: RunInput; version?: () => Promise<string | null>; operatorDelivery?: OperatorDelivery; operatorSourceDelivery?: OperatorDelivery };

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

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
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
  over?: { message: string; error: JobError; sessionId: string | null; output: string; programOutput?: ProgramOutput; failure?: Failure } | null;
  toolToken?: string;
  opened?: Deferred<void>;
  /* A turn that only starts the program, until the program has its tools. A person who types meanwhile takes its place. */
  starting?: boolean;
  observed?: ObservedProgram;
  restarted?: boolean;
  words: TurnWords;
  ending?: TurnEnd;
  sourceDelivery?: OperatorDelivery;
  operatorInstance?: string;
  ownActivity?: boolean;
};
type JobError = RunResult['error'];
type LiveWords = { turn: Turn; program: TermProgram; text: string; deadline: number; reason?: string; operatorDelivery?: OperatorDelivery };
type TakenWords = { jobId: string | null; text: string; operatorDelivery?: OperatorDelivery };

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
  draining: boolean;
  /* The Codex session logs there were when the program started a new session: its own log is none of them. */
  oldLogs: Set<string> | null;
  startedAt: number;
  started: Deferred<void> | null;
  ended: Deferred<string> | null;
  turn: Turn | null;
  busy: boolean;
  /* The program took the prompt Hornhoof typed: its prompt hook ran or its log says the turn started. */
  took?: boolean;
  /* A person typed into the program since Hornhoof's words went in: its input is theirs from then on. */
  ownerTyped?: boolean;
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
  waitingWords: TurnWords[];
  retainedAssignments?: { jobId: string; text: string; words: TurnWords }[];
  originalTaken?: { jobId: string; text: string; operatorDelivery?: OperatorDelivery };
  /* Claude's queue, in the order its log enqueued the words. */
  enqueuedWords: string[];
  /* Reports waiting words even when no later log line or Enter comes. */
  unheardTimers: Map<TurnWords, NodeJS.Timeout>;
  dequeued: boolean;
  /* Hornhoof's turns, one after another. */
  queue: Promise<unknown>;
  /* Escape from a cancelled typed turn must finish before another prompt goes in. */
  cancelling?: Promise<void>;
  /* Typed turns Hornhoof has not answered yet, oldest first. */
  unopened: Turn[];
  /* A person stopped the running turn with Escape. */
  stopped: boolean;
  /* Why the program said the running turn failed. */
  failure: Failure | null;
  /* The turn's last line of text, to tell when its answer reached the log. */
  lastText: string | null;
  /* Kimi's running step has text already, so its next part goes on the same message. */
  stepSaid: boolean;
  /* A typed turn that ended and waits for the rest of its log. */
  settling: Promise<unknown> | null;
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
  /* Diagnostics visible before this invocation cannot classify its failure. */
  agyCursor: RecordingCursor | null;
  /* Interruption notices already on screen when this turn started belong to older turns. */
  interruptions: number;
  /* The running turn's tool calls the program began and did not end yet, by id, oldest first. */
  calls: Map<string, Pending>;
  closedCalls: Set<string>;
  question: Pending | null;
  operatorQuestion?: OperatorQuestion | null;
  ends: TurnEnds;
  signAt: number;
  retry: ProgramRetry | null;
  programTurnId: string | undefined;
  apiError: Failure | null;
  restarting: boolean;
  launch: { job: TermJob; spec: LaunchSpec } | null;
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
  operator?: OperatorOptions;
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
  /* How long a program shows an empty input and no change at all before words it did not record count as lost. */
  wordsQuietMs?: number;
  /* How often the host observes the program and reports its state again when nothing changed. */
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
/* A stop hook can precede the program's last log lines; the turn waits this long for them. */
const SETTLE_MS = 3000;
/* How long the plan's limits may take to come after a turn of a program that does not log them. */
const LIMITS_WAIT_MS = 10_000;
/* How long a Claude Code that said it started may take to show its input box. */
const INPUT_WAIT_MS = 10_000;
/* How often the host looks at what the program of a running turn does, besides each time it begins or ends a tool. */
const LOOK_MS = 5000;
/* How long agy's list of slash commands takes to catch up with a command's name before the Enter that runs it. */
const SLASH_MS = 500;
/* How long a program that just showed its prompt takes before it reads what is typed. */
const PROMPT_SETTLE_MS = 500;
/* What the options leave out: how long the host waits for what, and the terminal's size. */
const DEFAULTS = { readyMs: 120_000, pollMs: 500, openMs: 8000, toolsMs: 15_000, enterWaitMs: 4000, wordsQuietMs: 15_000, reportMs: REPORT_MS, cols: 160, rows: 48 };
/* The options given, without those set to nothing. */
const defined = (opts: Options): Partial<Options> => Object.fromEntries(Object.entries(opts).filter(([, value]) => value !== undefined));
/* When the host last looked at the program, and the tool it ran then. */
type Look = { at: number; call: Pending | null; retry?: ProgramRetry | null };
type ObservedProgram = { watch: ProgramWatch; look: Look };
/* A program may change how a prompt's lines and spaces look, not its words. */
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
const heardWords = (receipt: WordReceipt) => receipt.state === 'queued' || receipt.state === 'taken';

const interruptionCount = (screen: string) => [...screen.matchAll(/Interrupted · What should Antigravity CLI do instead\?/g)].length;

const hashOf = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
/* What the running program was started with; a turn that needs anything else starts it again. A plan signed in to another
   account in Hornhoof reaches a running Claude Code only when it starts again, which it does between turns, in the same
   session. */
const noVersion = async (): Promise<null> => null;
async function launchHash({ program, bin, input, version = noVersion }: TermJob, spec: LaunchSpec): Promise<string> {
  const signedAs = spec.env.CLAUDE_CODE_OAUTH_TOKEN ? hashOf(spec.env.CLAUDE_CODE_OAUTH_TOKEN) : null;
  return hashOf({ kind: program.kind, bin, version: await version(), model: input.model, effort: input.effort ?? null, compactWindow: input.compactWindow ?? null, instructions: input.instructions, env: lasting(input.env), signedAs });
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
    enqueuedWords: [],
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
/* A Hornhoof turn into Antigravity needs agy to have listed Hornhoof's tools before its prompt goes in. */
const needsTools = ({ program, input }: TermJob): boolean => program.kind === 'antigravity' && Boolean(input.tools && input.prompt);
/* agy waits at its prompt with nothing typed, on the screen as it is now rather than in the lines above it. */
const agyWaits = (screen: string): boolean => READY.antigravity(screen) && atEmptyPrompt('antigravity', screen);
/* agy shows /mcp typed on its input line, and nothing after it but dim suggestions, wherever it lists its commands. */
const mcpTyped = (screen: string): boolean => /^[ \t]*>[ \t]?\/mcp[ \t]*$/m.test(withoutDim(screen));
/* What the node waits for agy to do with its MCP panel, in order: wait at its empty prompt, show the command typed, list
   Hornhoof's tools in the panel, wait at its empty prompt again once the panel closes. A turn says where agy stopped. */
type PanelStep = 'waits' | 'typed' | 'listed' | 'back';
const PANEL_STOPPED: Record<PanelStep, (seconds: number) => Failure> = {
  waits: () => failure('unknown', 'Antigravity CLI did not wait at its empty prompt, so the node did not open its MCP panel.', true),
  typed: seconds => failure('unknown', `Antigravity CLI did not show /mcp in its input within ${seconds} s, so the node did not open its MCP panel.`, true),
  listed: seconds => failure('tools', `Antigravity CLI did not list Hornhoof's tools within ${seconds} s of opening its MCP panel.`),
  back: seconds => failure('unknown', `Antigravity CLI did not show its empty prompt again within ${seconds} s of closing its MCP panel.`, true),
};
/* Resolves false once the turn is stopped, and never for a turn nobody can stop. */
const stopped = (signal?: AbortSignal): Promise<false> =>
  new Promise(resolve => (signal?.aborted ? resolve(false) : signal?.addEventListener('abort', () => resolve(false), { once: true })));

/* Runs agents in their tmux sessions on this node and shows those sessions to the people watching. */
export class TerminalHost {
  private readonly operator: OperatorRuntime | null;
  private readonly operatorTimer: NodeJS.Timeout | null;
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
  private readonly wordsQuietMs: number;
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
  private readonly limitsStops = new Set<AbortController>();
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
    this.wordsQuietMs = set.wordsQuietMs;
    this.lookMs = opts.lookMs ?? LOOK_MS;
    this.reportMs = set.reportMs;
    this.cols = set.cols;
    this.rows = set.rows;
    this.operator = this.operatorFor(opts);
    this.operatorTimer = this.operatorTicks();
  }

  private operatorFor(opts: Options): OperatorRuntime | null {
    return opts.operator ? new OperatorRuntime(opts.operator, { current: key => this.operatorState(key), capture: key => this.operatorPane(key), press: (key, value) => this.opts.tmux.keys(this.agents.get(key)!.name, value), recovery: key => this.operatorRecovery(key), secrets: opts.secrets }) : null;
  }

  private operatorTicks(): NodeJS.Timeout | null {
    if (!this.operator) return null;
    const timer = setInterval(() => this.operatorTick(), 1000);
    timer.unref();
    return timer;
  }

  operatorTick(): void { this.operator?.tick(); }
  operatorReplay(): void { this.operator?.replay(); }
  async operatorMessage(frame: OperatorServerMessage): Promise<void> { await this.operator?.message(frame); }

  private operatorState(key: string): Omit<OperatorProgram, 'agentKey' | 'jobId' | 'instance' | 'generation'> | null {
    const a = this.agents.get(key); if (!a) return null;
    this.drain(a);
    const wait = a.operatorQuestion ? { id: a.operatorQuestion.id, kind: a.operatorQuestion.kind } : null;
    return { agentProgram: Boolean(a.program && a.hash), alive: true, pasted: false, turnStarted: a.took === true, active: false, runningTool: [...a.calls.values()].some(call => call.name !== 'AskUserQuestion'), retrying: Boolean(a.retry || a.restarting), wait };
  }

  private async operatorRecovery(key: string): Promise<{ alive: boolean; input: string | null; busy: boolean }> {
    const a = this.agents.get(key);
    if (!a?.program || !(await this.opts.tmux.alive(a.name))) return { alive: false, input: null, busy: false };
    return { alive: true, input: inputOf(a.program.kind, await this.opts.tmux.screen(a.name, 0, true)), busy: a.busy };
  }

  private async operatorPane(key: string): Promise<{ cols: number; rows: number; cells: string }> {
    const a = this.agents.get(key); if (!a) throw new Error('The agent program is absent.');
    const [size, cells] = await Promise.all([this.opts.tmux.run(['display-message', '-p', '-t', a.name, '#{pane_width} #{pane_height}']), this.opts.tmux.screen(a.name, 0, true)]);
    const [cols, rows] = size.trim().split(/\s+/).map(Number);
    if (!cols || !rows) throw new Error('The existing pane size is unknown.');
    return { cols, rows, cells };
  }

  private inputLane<T>(a: Agent, run: () => Promise<T>): Promise<T> { return this.operator?.serial(a.key, run) ?? run(); }

  private intentional(a: Agent, why: Parameters<OperatorRuntime['intentional']>[1]): void { this.operator?.intentional(a.key, why); }

  private operatorEnabled(a: Agent): boolean { return Boolean(this.operator?.enabled(a.key)); }

  private hookRejected(key: string | null, event: string, reason: string): void {
    (this.opts.log ?? console.log)(`Hook ${event} rejected: ${reason}${key ? ` (agent ${key})` : ''}`);
    if (key) this.opts.send({ type: 'agent.hook_rejected', agentKey: key, event, reason });
  }

  start(): Promise<void> {
    return this.bridge.start();
  }

  private stopReading(): void {
    if (this.operatorTimer) clearInterval(this.operatorTimer);
    for (const stop of this.limitsStops) stop.abort();
    this.limitsStops.clear();
  }

  private stopWatching(a: Agent): void {
    this.intentional(a, 'update');
    this.reportUnheard(a, true, 'the node is stopping');
    for (const timer of a.unheardTimers.values()) clearTimeout(timer);
    a.unheardTimers.clear();
    this.unwatch(a);
  }

  async stop(): Promise<void> {
    this.stopReading();
    this.closeViews();
    for (const a of this.agents.values()) this.stopWatching(a);
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
      a = { key, name: `a-${key}`, program: null, signedOut: null, home: '', workDir: '', hash: null, sessionId: null, cleared: new Set(), tail: null, draining: false, oldLogs: null, startedAt: 0, started: null, ended: null, turn: null, busy: false, limits: null, contextUsed: null, contextSize: null, viewers: 0, up: false, watch: null, saying: Promise.resolve(), waitingWords: [], enqueuedWords: [], unheardTimers: new Map(), dequeued: false, queue: Promise.resolve(), unopened: [], stopped: false, failure: null, lastText: null, stepSaid: false, settling: null, fresh: false, starting: null, keep: null, agyRead: null, agyAnswered: false, agyCursor: null, interruptions: 0, calls: new Map(), closedCalls: new Set(), question: null, ends: new TurnEnds(), signAt: 0, retry: null, apiError: null, restarting: false, launch: null, programTurnId: undefined };
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
    const hash = await this.versionedHash(a, job, spec);
    if (input.signal?.aborted) return this.failedTurn(a, job, 'cancelled');
    const goesOn = await this.goesOn(a, input.sessionId, hash);
    a.launch = { job, spec };
    /* A program started with nothing to type gets its tools before its turn ends, while Hornhoof still answers for them.
       Kimi Code connects to its tools only once it has a session, which a new one gets with the first message, and
       Antigravity only once it takes a message or opens its MCP panel. */
    const tools = initialToolsNeeded(job, goesOn) ? this.bridge.listed(job.key, this.toolsMs) : null;

    /* What is left in the log from before belongs to no turn. */
    this.drain(a);
    a.lastText = null;
    a.stepSaid = false;
    this.beginTurn(a);
    this.operator?.begin(a.key, input.jobId ?? null, job.operatorDelivery, input.prompt, goesOn, job.operatorSourceDelivery);
    input.signal?.addEventListener('abort', () => this.operator?.intentional(a.key, 'cancelled'), { once: true });
    this.bridge.setToken(job.key, input.tools?.token ?? null);
    const starting = input.prompt ? null : (tools ?? Promise.resolve());
    const words = this.requestedWords(a, job);
    const turn: Turn = { jobId: input.jobId ?? null, toolToken: input.tools?.token, words, onEvent: input.onEvent ?? (() => {}), typed: false, seq: 0, signal: input.signal, ...(starting ? { starting: true } : {}) };
    if (starting) a.starting = starting;
    a.turn = turn;
    a.ended = deferred();
    a.stopped = false;
    a.failure = null;
    try {
      const failed = goesOn ? null : await this.startProgram(a, job, spec, hash, urls);
      if (failed) return failed;
      return await this.runRequested(a, job, turn, tools, goesOn, a.ended);
    } finally {
      this.endWords(a, turn);
      this.retainAssignment(a, job, words);
      a.typing = null;
      if (starting && a.starting === starting) a.starting = null;
      if (a.turn === turn) {
        this.bridge.setToken(job.key, null);
        a.turn = null;
        a.ended = null;
      }
    }
  }

  private requestedWords(a: Agent, job: TermJob): TurnWords {
    return new TurnWords(job.input.prompt ? [job.input.prompt] : [], {
      preserveOriginal: Boolean(job.operatorDelivery),
      original: phase => this.originalReceipt(a, job, phase),
      word: this.wordReceipt(a),
    });
  }

  private wordReceipt(a: Agent) {
    return (word: WordReceipt, phase: 'queued' | 'taken' | 'not_taken') => this.operator?.receipt(a.key, word.operatorDelivery, phase);
  }

  private originalReceipt(a: Agent, { input, operatorDelivery }: TermJob, phase: 'queued' | 'taken'): void {
    this.operator?.receipt(a.key, operatorDelivery, phase);
    if (phase === 'taken' && input.jobId && assignmentOutlastsTurn(a)) a.originalTaken = { jobId: input.jobId, text: input.prompt, operatorDelivery };
  }

  private retainAssignment(a: Agent, { input, operatorDelivery }: TermJob, words: TurnWords): void {
    if (operatorDelivery && input.jobId && words.originalPending() && !input.signal?.aborted) (a.retainedAssignments ??= []).push({ jobId: input.jobId, text: input.prompt, words });
  }

  private async versionedHash(a: Agent, job: TermJob, spec: LaunchSpec): Promise<string> {
    let hash = await launchHash(job, spec);
    /* A person may start a turn while npm runs, including when the installed version stays the same. */
    while (job.version && a.busy && !job.input.signal?.aborted) {
      await this.waitForTurn(a, job);
      hash = await launchHash(job, spec);
    }
    return hash;
  }

  private async runRequested(a: Agent, job: TermJob, turn: Turn, tools: Promise<unknown> | null, goesOn: boolean, ended: Deferred<string>): Promise<RunResult> {
    /* Nothing to type: the turn only starts the program for the person who opened its window. */
    if (!job.input.prompt) return this.started(a, turn, tools, goesOn ? null : job.input.sessionId === null);
    return (await this.toolsMissing(a, job)) ?? (await this.typePrompt(a, job, job.input.prompt)) ?? this.turnEnd(a, job, ended, turn);
  }

  /* agy 1.4.12 connects to the MCP servers of its folder only once it takes its first input or opens its /mcp panel, and
     the turn whose input made it connect works without their tools (seen on a-host, #226). So an agy that has not listed
     Hornhoof's tools through the bridge since it started opens that panel before Hornhoof's prompt goes in, whether this
     turn started it or a person's window did. A turn whose agy lists none there, or does not come back to its prompt,
     ends saying so. */
  private async toolsMissing(a: Agent, job: TermJob): Promise<RunResult | null> {
    if (!needsTools(job) || this.bridge.listedSince(job.key, a.startedAt)) return null;
    const failed = await this.agyTools(a, job.key, job.input.signal);
    if (job.input.signal?.aborted) return await this.failedTurn(a, job, 'cancelled');
    if (!failed) return null;
    a.failure = failed;
    return await this.failedTurn(a, job, 'agent_failed');
  }

  /* Gets agy Hornhoof's tools through its MCP panel: what went wrong, or null. One that did not end with the tools listed
     and agy at its empty prompt starts anew for the next turn, as a panel still up or a person's words in its input
     would take the next prompt. A turn stopped meanwhile goes no further. */
  private async agyTools(a: Agent, key: string, signal?: AbortSignal): Promise<Failure | null> {
    if (signal?.aborted) return null;
    const missed = await this.mcpPanel(a, key, signal);
    if (missed) a.hash = null;
    if (!(await this.opts.tmux.alive(a.name))) return failure('crash', "The program exited before it took Hornhoof's prompt.");
    return missed ? PANEL_STOPPED[missed](Math.round(this.toolsMs / 1000)) : null;
  }

  /* Opens agy's MCP panel, which calls no model, from its empty prompt, waits for agy to list Hornhoof's tools there,
     closes the panel with Escape and waits for agy's empty prompt. The step agy did not get to, or null. Nothing goes into
     words a person left in its input. */
  private async mcpPanel(a: Agent, key: string, signal?: AbortSignal): Promise<PanelStep | null> {
    if (!agyWaits(await this.opts.tmux.screen(a.name, 0, true))) return 'waits';
    /* A program gone meanwhile takes no keys; the turn says it is gone. */
    const press = (...keys: string[]) => this.opts.tmux.keys(a.name, ...keys).catch(() => {});
    await press('-l', '/mcp');
    const missed = await this.panelListed(a, key, press, signal);
    await press('Escape');
    if (missed) return missed;
    return (await this.agyShows(a, agyWaits, signal, PROMPT_SETTLE_MS)) ? null : 'back';
  }

  /* Runs the /mcp typed once agy shows it, as an Enter before then could run another command of its list or send the words
     to the model, and waits for agy to list Hornhoof's tools: the step agy did not get to, or null. A turn stopped
     meanwhile presses no Enter. */
  private async panelListed(a: Agent, key: string, press: (...keys: string[]) => Promise<void>, signal?: AbortSignal): Promise<'typed' | 'listed' | null> {
    if (!(await this.agyShows(a, mcpTyped, signal))) return 'typed';
    await sleep(SLASH_MS);
    if (signal?.aborted) return 'typed';
    await press('Enter');
    return (await Promise.race([this.bridge.listed(key, this.toolsMs, a.startedAt), stopped(signal)])) ? null : 'listed';
  }

  /* Whether agy's screen as it is now, with its styles, shows what is asked within toolsMs, then waits settleMs; false once
     the turn is stopped or the program is gone. Dim words there are a suggestion, not input. */
  private async agyShows(a: Agent, shows: (screen: string) => boolean, signal?: AbortSignal, settleMs = 0): Promise<boolean> {
    for (const end = Date.now() + this.toolsMs; Date.now() < end && !signal?.aborted && (await this.opts.tmux.alive(a.name)); await sleep(this.pollMs)) {
      if (!shows(await this.opts.tmux.screen(a.name, 0, true))) continue;
      await sleep(settleMs);
      return true;
    }
    return false;
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
    this.programIs(a, false);
    await this.prepareLaunch(a, job, spec, hash, urls);
    await this.launchAttempt(a, job, spec);
    /* The program starts as its launch ends, once the one before it is gone: what it does counts from then. */
    a.startedAt = Date.now();
    this.watch(a);
    if (await this.ready(a, job)) {
      this.programIs(a, true);
      return null;
    }
    return this.failedStart(a, job);
  }

  private async prepareLaunch(a: Agent, job: TermJob, spec: LaunchSpec, hash: string, urls: AgentUrls): Promise<void> {
    await this.prepare(job, urls);
    Object.assign(a, { ...startedState(job, spec), hash });
    if (job.program.kind === 'claude' && !job.input.sessionId) await this.keepNew(job.input, spec.sessionId);
    a.tail = this.tailFor(a);
  }

  private async launchAttempt(a: Agent, job: TermJob, spec: LaunchSpec): Promise<void> {
    const env = { ...lasting(job.input.env), ...spec.env };
    const scratch = this.opts.tmux.scratch();
    this.operator?.launch(a.key, 'attempt');
    try {
      await this.inputLane(a, () => this.opts.tmux.launch(a.name, { cwd: job.input.workDir, command: this.asAgent(spec.command), cols: this.cols, rows: this.rows, envFile: envFile(scratch, env), outputDir: scratch }));
      this.operator?.launch(a.key, 'started');
    } catch (error) {
      this.operator?.launch(a.key, 'failed');
      this.operator?.exited(a.key, { code: null, signal: null });
      throw error;
    }
  }

  private async failedStart(a: Agent, job: TermJob): Promise<RunResult> {
    if (job.input.signal?.aborted) return this.failedTurn(a, job, 'cancelled');
    const screen = await this.screen(job.key);
    /* Its screen says why, which the loader would hide. */
    this.showViews(a);
    await this.whyNotReady(a, job, screen);
    return await this.failedTurn(a, job, !this.operator?.failure(a.key) && job.signedOut.test(screen) ? 'not_logged_in' : 'agent_failed', screen);
  }

  /* A program still there that never showed its prompt fails its turn saying so in short, for the retry to say; its screen
     goes with the turn's output. One that met a failure, ended or is signed out says that instead. */
  private operatorEnded(a: Agent): Failure | null {
    return this.operator?.failure(a.key) ? failure('unknown', `Program operator recovery ended: ${this.operator.failureDetail(a.key)}.`, false) : null;
  }

  private async knowsWhyNotReady(a: Agent, job: TermJob, screen: string): Promise<boolean> {
    return Boolean(a.failure) || job.signedOut.test(screen) || !(await this.opts.tmux.alive(a.name));
  }

  private async whyNotReady(a: Agent, job: TermJob, screen: string): Promise<void> {
    const ended = this.operatorEnded(a);
    if (ended) { a.failure = ended; return; }
    if (await this.knowsWhyNotReady(a, job, screen)) return;
    a.failure = failure('unknown', `The program did not show its prompt within ${Math.round(this.readyMs / 1000)} s.`, true);
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
  private typePrompt(a: Agent, job: TermJob, prompt: string): Promise<RunResult | null> {
    return job.operatorDelivery && this.operatorEnabled(a) ? this.typeOperatorPrompt(a, job, prompt) : this.typePlainPrompt(a, job, prompt);
  }

  private async typePlainPrompt(a: Agent, job: TermJob, prompt: string): Promise<RunResult | null> {
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
      const why = `The program did not take Hornhoof's prompt within ${Math.round(this.readyMs / 1000)} s.`;
      a.failure = failure('unknown', why, true);
      return await this.failedTurn(a, job, 'agent_failed', `${why}\n\n${await this.screen(job.key)}`);
    }
    return null;
  }

  private async typeOperatorPrompt(a: Agent, job: TermJob, prompt: string): Promise<RunResult | null> {
    if (this.operator?.inheritSource(a.key, job.operatorSourceDelivery)) return a.busy ? null : this.failedTurn(a, job, 'cancelled');
    if (this.operator?.recorded(a.key)) return null;
    a.fresh = false; a.took = false; a.typing = prompt; a.ownerTyped = false;
    const failed = await this.pasteOperatorPrompt(a, job, prompt);
    return failed ?? this.waitOperatorReceipt(a, job, prompt);
  }

  private operatorPending(a: Agent): boolean {
    return !this.operator?.recorded(a.key) && !a.ended?.settled;
  }

  private operatorPastePending(a: Agent, pasted: boolean): boolean {
    return !pasted && this.operatorPending(a);
  }

  private async pasteOperatorPrompt(a: Agent, job: TermJob, prompt: string): Promise<RunResult | null> {
    let pasted = false;
    while (this.operatorPastePending(a, pasted)) {
      if (!(await this.ready(a, job))) {
        await this.whyNotReady(a, job, await this.screen(a.key));
        return this.failedTurn(a, job, job.input.signal?.aborted ? 'cancelled' : 'agent_failed');
      }
      pasted = await this.inputLane(a, () => this.pasteOperatorAssignment(a, job, prompt));
    }
    return null;
  }

  private async pasteOperatorAssignment(a: Agent, job: TermJob, prompt: string): Promise<boolean> {
    const screen = await this.opts.tmux.screen(a.name, 0, true);
    this.drain(a);
    if (this.operator?.inheritSource(a.key, job.operatorSourceDelivery)) return false;
    if (!this.operatorInputProven(a, job, screen)) return false;
    return this.submitOperatorAssignment(a, job, prompt);
  }

  private async submitOperatorAssignment(a: Agent, job: TermJob, prompt: string): Promise<boolean> {
    this.operator?.pasted(a.key);
    await this.opts.tmux.paste(a.name, prompt);
    await sleep(pasteWait(prompt));
    if (!job.input.signal?.aborted) await this.opts.tmux.keys(a.name, 'Enter');
    return true;
  }

  private operatorInputProven(a: Agent, job: TermJob, screen: string): boolean {
    return !job.input.signal?.aborted && !a.took && !this.operator?.recorded(a.key) && inputOf(job.program.kind, screen) === '';
  }

  private async waitOperatorReceipt(a: Agent, job: TermJob, prompt: string): Promise<RunResult | null> {
    const lost = new LostWords(prompt, { enterMs: this.enterWaitMs, quietMs: this.wordsQuietMs }, Date.now());
    while (this.operatorPending(a)) {
      this.drain(a); this.operatorTick();
      if (job.input.signal?.aborted) return this.failedTurn(a, job, 'cancelled');
      const failed = await this.operatorReceiptFailure(a, job);
      if (failed) return failed;
      await this.inputLane(a, () => this.repeatLostWords(a, job, prompt, lost));
      await sleep(this.pollMs);
    }
    return null;
  }

  /* A program can miss the Enter or lose the words, more so as it starts or resumes a long session: the same turn tries again,
     as long as nothing shows the program took them and nobody else is at its input. */
  private async repeatLostWords(a: Agent, job: TermJob, prompt: string, lost: LostWords): Promise<void> {
    if (a.ownerTyped || a.took || job.input.signal?.aborted || !this.operator?.wordsWaiting(a.key)) return;
    const step = lost.step(job.program.kind, await this.opts.tmux.screen(a.name, 0, true), Date.now());
    if (step === 'enter') await this.opts.tmux.keys(a.name, 'Enter');
    if (step === 'type') await this.submitOperatorAssignment(a, job, prompt);
  }

  private async operatorReceiptFailure(a: Agent, job: TermJob): Promise<RunResult | null> {
    const why = this.operator?.failureDetail(a.key);
    if (why) { a.failure = failure('unknown', `Program operator recovery ended: ${why}.`, false); return this.failedTurn(a, job, 'agent_failed'); }
    if (!(await this.opts.tmux.alive(a.name))) return this.failedTurn(a, job, 'agent_failed');
    return null;
  }

  /* Waits for the turn to end: the program says so, a person stops it, or the program is gone. */
  private async turnEnd(a: Agent, job: TermJob, ended: Deferred<string>, turn: Turn): Promise<RunResult> {
    const { watch, look } = this.observeProgram(job.input.jobId);
    for (;;) {
      this.drain(a);
      const message = await Promise.race([ended.promise, sleep(this.pollMs).then(() => null)]);
      if (message !== null) {
        const result = await this.saidEnded(a, job, message, turn.ending);
        return { ...result, ...(turn.words.waitingForTurn(Date.now()) ? { wordsWaiting: true } : {}) };
      }
      /* A program stopped with Escape does not say its turn ended: it waits for the next prompt. */
      if (job.input.signal?.aborted) return await this.stopTurn(a, job, ended);
      if (a.restarting) continue;
      if (!(await this.opts.tmux.alive(a.name))) return await this.programGone(a, job, watch);
      await Promise.race([this.reportProgram(a, watch, look), ended.promise]);
    }
  }

  /* Both entry paths report the same program state. */
  private observeProgram(jobId: string | null | undefined): ObservedProgram {
    return { watch: new ProgramWatch(jobId, m => this.opts.send(m), this.reportMs, () => this.opts.secrets()), look: { at: Date.now(), call: null } };
  }

  /* The program said the turn ended: stopped by a person, failed, or with its answer, which the turn waits to read. */
  private async saidEnded(a: Agent, job: TermJob, message: string, end?: TurnEnd): Promise<RunResult> {
    const detail = end ? end.failure ?? null : a.failure;
    if (end ? end.status === 'stopped' : a.stopped) {
      return await this.failedTurn(a, job, 'cancelled');
    }
    if (detail !== null) {
      const output = `${await this.screen(job.key)}\n\n${detail.text}`;
      return await this.failedTurn(a, job, detail.kind === 'auth' || job.signedOut.test(detail.text) ? 'not_logged_in' : 'agent_failed', output, detail);
    }
    await this.settle(a, message);
    await this.planLimits(a);
    /* A turn that ended with no answer keeps its screen, which says why, as when the provider refused the work. */
    const output = message.trim() ? '' : await this.screen(job.key);
    return { ok: true, sessionId: a.sessionId, result: message, output, error: null, limits: a.limits };
  }

  private async stopTurn(a: Agent, job: TermJob, ended: Deferred<string>): Promise<RunResult> {
    this.intentional(a, 'cancelled');
    await this.inputLane(a, () => this.opts.tmux.keys(a.name, 'Escape'));
    await Promise.race([ended.promise, sleep(STOP_WAIT_MS)]);
    a.busy = false;
    return await this.failedTurn(a, job, 'cancelled');
  }

  private async programGone(a: Agent, job: TermJob, watch: ProgramWatch): Promise<RunResult> {
    a.busy = false;
    a.failure = failure('crash', 'The program exited during the turn.');
    this.programEnded(a);
    const screen = await this.screen(job.key);
    await this.toldGone(a, watch, screen);
    return await this.failedTurn(a, job, job.signedOut.test(screen) ? 'not_logged_in' : 'agent_failed', screen);
  }

  /* Reports the program's own state when its call changes or a report is due, else every lookMs. The screen is diagnostic. */
  private async reportProgram(a: Agent, watch: ProgramWatch, look: Look): Promise<void> {
    const turn = a.turn;
    const now = Date.now();
    const call = this.pendingCall(a);
    if (call === look.call && a.retry === look.retry && now - look.at < this.lookMs && !watch.due(now)) return;
    Object.assign(look, { at: now, call, retry: a.retry });
    const screen = await this.opts.tmux.screen(a.name, 0, true);
    if (a.turn !== turn) return;
    watch.look(now, screen, call, Boolean(a.took && a.busy), a.signAt, a.retry);
    if (this.atInterruption(a, screen)) this.interrupted(a);
    this.agyFailed(a);
  }

  private pendingCall(a: Agent): Pending | null {
    return a.question ?? a.calls.values().next().value ?? null;
  }

  private agyOutput(a: Agent): string {
    return a.agyCursor ? plainOutput(this.opts.tmux.programOutput(a.name, a.agyCursor) ?? '') : '';
  }

  private agyFailed(a: Agent): void {
    if (a.program?.kind !== 'antigravity' || !this.stoppable(a)) return;
    const raw = agyError(this.agyOutput(a), undefined);
    if (!raw) return;
    a.signAt = Date.now();
    const detail = FAILURE.antigravity(raw);
    this.turnFailed(a, detail.text, detail);
  }

  private atInterruption(a: Agent, screen: string): boolean {
    if (a.program?.kind !== 'antigravity') return false;
    return this.stoppable(a) && interruptionCount(screen) > a.interruptions;
  }

  /* Hornhoof hears that the turn's program is gone, how it ended and what it showed last, without the secrets. */
  private async toldGone(a: Agent, watch: ProgramWatch, screen: string): Promise<void> {
    const ended = (await this.opts.tmux.exitSnapshot(a.name))?.programOutput;
    this.reportGone(watch, ended, screen, a.signAt);
  }

  private reportGone(watch: ProgramWatch, ended: ProgramOutput | undefined, screen: string, signAt: number): void {
    const secrets = this.opts.secrets();
    watch.gone(Date.now(), ended ? { code: ended.code, signal: signalName(ended.signal) } : null, redact(plainOutput(redact(screen, secrets)), secrets), signAt);
  }

  private async failedTurn(a: Agent, job: TermJob, error: RunResult['error'], output?: string, detail = a.failure): Promise<RunResult> {
    const ended = error === 'agent_failed' || error === 'not_logged_in' ? await this.opts.tmux.exitSnapshot(a.name) : null;
    if (ended && this.operator?.enabled(a.key)) this.operator.exited(a.key, programExitStatus(ended.programOutput));
    const details = ended?.output ?? output ?? await this.screen(job.key);
    const classified = failedError(error, detail, Boolean(this.operator?.failure(a.key)), ended?.output ?? null, job.signedOut);
    return { ok: false, sessionId: a.sessionId, result: '', output: details, programOutput: ended?.programOutput, error: classified, ...failedDetail(error, detail, Boolean(ended), details), limits: a.limits };
  }

  /* While its program runs the host reads the agent's log and reports typed turns, ending them if the program is gone.
     Hornhoof's own turns look after themselves. */
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
    if (a.restarting) return;
    this.drain(a);
    const turn = a.turn;
    if (managedTurn(turn)) return;
    const alive = await this.opts.tmux.alive(a.name);
    if (a.turn !== turn) return;
    if (alive) return this.lookAlive(a, turn);
    /* What the program logged before it ended, as words a person typed into Codex, comes first. */
    this.drain(a);
    await this.endedTyped(a);
  }

  private async lookAlive(a: Agent, turn: Turn | null): Promise<void> {
    if (!turn && a.program && this.operator?.recovering(a.key)) await this.ownerRecoveryReady(a);
    await this.lookTyped(a, turn);
  }

  private async ownerRecoveryReady(a: Agent): Promise<void> {
    const ready = atEmptyPrompt(a.program!.kind, await this.opts.tmux.screen(a.name, 0, true));
    if (ready) a.fresh = true;
    this.operator!.recoveryReady(a.key, ready);
  }

  private async lookTyped(a: Agent, turn: Turn | null): Promise<void> {
    const observed = turn?.observed;
    if (!observed) return;
    await this.reportProgram(a, observed.watch, observed.look);
  }

  private async endedTyped(a: Agent): Promise<void> {
    const turn = a.turn;
    const ended = turn?.typed ? await this.typedExit(a, turn) : null;
    if (a.turn !== turn) return;
    a.busy = false;
    this.programEnded(a);
    if (!turn?.ending) {
      a.failure = failure('crash', 'The program exited during the turn.');
      this.finishTyped(a, '', exitError(ended?.output ?? null, a.signedOut, 'agent_failed'), ended?.output ?? '', ended?.programOutput);
    }
    this.unwatch(a);
  }

  private async typedExit(a: Agent, turn: Turn) {
    const ended = await this.opts.tmux.exitSnapshot(a.name);
    const screen = ended?.output ?? await this.screen(a.key);
    if (a.turn === turn) this.reportGone(turn.observed!.watch, ended?.programOutput, screen, a.signAt);
    return ended;
  }

  /* A person cleared the conversation in Claude Code, which goes on in a new session with a log of its own; or Kimi Code
     named its session, whose log the host finds once Kimi writes it; or Antigravity named its conversation. */
  private follow(a: Agent, sessionId: string): void {
    if (!sessionId || sessionId === a.sessionId) return;
    this.leaveSession(a);
    a.sessionId = sessionId;
    a.enqueuedWords = [];
    a.dequeued = false;
    this.followSessionLog(a, sessionId);
  }

  private leaveSession(a: Agent): void {
    if (!a.sessionId) return;
    this.drain(a);
    this.reportUnheard(a, true, 'the program changed its session');
    a.cleared.add(a.sessionId);
  }

  private followSessionLog(a: Agent, sessionId: string): void {
    switch (a.program?.kind) {
      case 'claude':
        a.tail = new LineTail(claudeTranscript(a.home, realpathSync(a.workDir), sessionId));
        return;
      case 'kimi':
        a.tail = null;
        this.keepNamedContext(a, sessionId);
        return;
      case 'antigravity': {
        const file = agyTranscript(a.home, sessionId);
        a.agyRead = agySteps();
        a.tail = file ? new LineTail(file) : null;
        this.keepNamedContext(a, sessionId);
        return;
      }
      case 'codex':
      case undefined:
        return;
    }
  }

  private keepNamedContext(a: Agent, sessionId: string): void {
    if (a.keep) void keepContext(this.fs, a.workDir, sessionId, a.keep).catch(() => {});
    a.keep = null;
  }

  /* Programs that do not log their plan's limits are asked after a turn, for a while. */
  private async planLimits(a: Agent): Promise<void> {
    if (!a.program?.limits) return;
    const limits = await this.readLimits(a, a.program.limits);
    if (limits) a.limits = limits;
  }

  private async readLimits(a: Agent, read: NonNullable<TermProgram['limits']>) {
    const stop = new AbortController();
    this.limitsStops.add(stop);
    try {
      return await Promise.race([
        read(a.home, { bin: a.launch?.job.bin, user: this.opts.user, signal: stop.signal }).catch(() => null),
        sleep(LIMITS_WAIT_MS),
      ]);
    } finally {
      stop.abort();
      this.limitsStops.delete(stop);
    }
  }

  /* A stop in the log counts for the running turn once its prompt went in: one logged before is the last turn's. */
  /* The turn ended in the program, and the host only reads the rest of its log. */
  private overIn(a: Agent): boolean {
    return Boolean(a.turn?.ending);
  }

  private stoppable(a: Agent): boolean {
    return Boolean(a.turn && (a.turn.typed || (a.busy && a.took)));
  }

  private beginTurn(a: Agent): void {
    this.clearQuestion(a);
    a.ends.begin();
    a.programTurnId = undefined;
    a.calls.clear();
    a.closedCalls.clear();
    a.question = null;
    a.retry = null;
    a.failure = a.apiError = null;
    a.stopped = false;
  }

  private interrupted(a: Agent, id?: string): void {
    this.endTurn(a, { status: 'stopped', message: '' }, id);
  }

  private turnFailed(a: Agent, reason: string, detail?: Failure, id?: string): void {
    this.endTurn(a, { status: 'failed', message: '', failure: detail ?? failure('unknown', reason) }, id);
  }

  private endTurn(a: Agent, end: TurnEnd, id?: string, blocked = false): void {
    if (a.restarting) return;
    const decision = a.ends.end(end.status, this.stoppable(a) || Boolean(blocked && a.turn), id);
    if (decision.conflict) this.log(`Agent ${a.key} (${a.program?.kind}): turn end channels disagree. The first end was kept.`);
    if (!decision.accept) return;
    this.clearQuestion(a);
    this.operator?.intentional(a.key, end.status === 'stopped' ? 'cancelled' : 'completed');
    if (a.turn) this.endWords(a, a.turn);
    a.busy = false;
    a.retry = null;
    a.calls.clear();
    a.question = null;
    a.stopped = end.status === 'stopped';
    a.failure = end.failure ?? null;
    const turn = a.turn;
    if (turn) turn.ending = end;
    if (!turn?.typed) return a.ended?.resolve(end.message);
    const error = endedError(a.stopped, end.failure, a.signedOut);
    const settling = this.settle(a, end.message);
    a.settling = settling;
    void settling.finally(() => { if (a.settling === settling) a.settling = null; });
    void settling.then(() => {
      this.finishTyped(a, end.message, error, end.failure?.text ?? '', undefined, turn);
    });
  }

  private operatorStarted(a: Agent): void { this.operator?.started(a.key); }

  private tookTurn(a: Agent, id?: string): void {
    this.operatorStarted(a);
    const first = !a.took;
    a.busy = a.took = true;
    a.ends.started(id);
    if (id !== undefined) a.programTurnId = id;
    if (first) a.turn?.words.clear();
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

  /* Claude Code says it started through its hook; the others are ready once their prompt shows. */
  private async ready(a: Agent, job: TermJob): Promise<boolean> {
    const end = Date.now() + this.readyMs;
    const colors = { at: -Infinity };
    while (this.waitingReady(a, job, end)) {
      this.operatorTick();
      if (await this.readyStopped(a, job)) return false;
      const shown = await this.readyPrompt(a, job, colors);
      if (shown !== null) return shown;
      if (await this.signedOutBeforeReady(a, job)) return false;
    }
    return false;
  }

  private waitingReady(a: Agent, job: TermJob, end: number): boolean {
    return job.operatorDelivery && this.operator?.enabled(a.key) ? !this.operator.failure(a.key) : Date.now() < end;
  }

  private async readyStopped(a: Agent, job: TermJob): Promise<boolean> {
    return Boolean(job.input.signal?.aborted) || !(await this.opts.tmux.alive(a.name));
  }

  private async readyPrompt(a: Agent, job: TermJob, colors: { at: number }): Promise<boolean | null> {
    return job.program.kind === 'claude' ? this.claudeReady(a, job) : this.promptShows(a, job, job.program.kind, colors);
  }

  private async claudeReady(a: Agent, job: TermJob): Promise<boolean | null> {
    if (!(await Promise.race([a.started!.promise.then(() => true), sleep(this.pollMs).then(() => false)]))) return null;
    if (job.operatorDelivery && this.operator?.enabled(a.key)) return (await this.inputBox(a)) || null;
    await this.inputShows(a);
    return true;
  }

  private async signedOutBeforeReady(a: Agent, job: TermJob): Promise<boolean> {
    return !job.operatorDelivery && job.signedOut.test(await this.screen(a.key));
  }

  /* Whether the prompt shows, or null while the program is still on its way to it. Kimi shows its prompt also when it is
     not signed in, with a word to sign in; agy may first ask for its first-run setup. */
  private async promptShows(a: Agent, job: TermJob, kind: keyof typeof READY, colors: { at: number }): Promise<boolean | null> {
    const screen = await this.screen(a.key);
    if (kimiSignedOut(job, kind, screen)) return false;
    if (READY[kind](screen)) {
      await sleep(PROMPT_SETTLE_MS);
      return true;
    }
    if (kind === 'antigravity' && (await this.agyFirstRun(a, colors))) return false;
    await sleep(this.pollMs);
    return null;
  }

  /* agy's first-run setup: the node takes the colors agy offers first, once, and goes on. Its terms are the plan owner's
     alone to accept, so the node presses nothing on them: the turn ends saying why, and the next start runs agy anew rather
     than typing into them. An agy that did not take the colors ends the turn too, to be started anew. True when the turn
     ends. */
  private async agyFirstRun(a: Agent, colors: { at: number }): Promise<boolean> {
    const step = await this.inputLane(a, async () => pastColors(await this.opts.tmux.screen(a.name, 0), () => this.opts.tmux.keys(a.name, 'Enter'), colors));
    const stuck = colorsNotTaken(step, colors);
    if (!stopsAtSetup(step, stuck) || this.operatorEnabled(a)) return false;
    a.failure = stuck ? failure('unknown', COLORS_NOT_TAKEN, true) : failure('setup', SETUP_NEEDED, false);
    a.hash = null;
    return true;
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
    if (a.program?.kind === 'antigravity') a.agyRead = agySteps();
    const file = this.transcriptFile(a);
    return file ? new LineTail(file, { fromEnd: true }) : null;
  }

  private transcriptFile(a: Agent): string | null {
    if (!a.program || !a.sessionId) return null;
    /* The program names its folder by the real path, without links. */
    switch (a.program.kind) {
      case 'claude': return claudeTranscript(a.home, realpathSync(a.workDir), a.sessionId);
      case 'codex': return findRollout(a.home, a.workDir, 0, a.sessionId)?.file ?? null;
      case 'antigravity': return agyTranscript(a.home, a.sessionId);
      case 'kimi': return findKimiWire(a.home, a.sessionId);
    }
  }

  /* What the program wrote to its log since last time: events for the turn, Codex's limits, session and turn end. */
  private drain(a: Agent): void {
    if (a.restarting || a.draining) return;
    a.draining = true;
    try {
      this.readLog(a);
    } finally {
      a.draining = false;
    }
    this.reportUnheard(a);
  }

  private readLog(a: Agent): void {
    this.findCodexTail(a);
    this.findKimiTail(a);
    for (const line of a.tail?.read() ?? []) {
      a.signAt = Date.now();
      let data: unknown;
      try {
        data = JSON.parse(line);
      } catch {
        continue;
      }
      const raw = isRecord(data) ? data : {};
      this.receivedWords(a, raw);
      if (hasOwnThought(a, raw)) this.ownActivity(a);
      if (a.program?.kind === 'antigravity') {
        this.agyNews(a, data);
        continue;
      }
      this.called(a, data);
      if (a.program?.kind === 'claude') {
        this.dequeuedPrompt(a, raw);
        if (this.stoppable(a) && claudeInterrupted(data)) this.interrupted(a);
        if (this.stoppable(a) && raw.type === 'assistant' && raw.isApiErrorMessage === true) {
          const text = isRecord(raw.message) ? contentText(raw.message.content) : '';
          a.apiError = FAILURE.claude({ error: raw.error, last_assistant_message: text });
        }
        for (const e of claudeEvents(data)) this.emit(a, e);
        const end = claudeEnd(data, a.lastText, a.apiError);
        if (end) this.endTurn(a, end);
        continue;
      }
      if (a.program?.kind === 'kimi') {
        this.kimiNews(a, kimiWire(data), raw);
        continue;
      }
      const news = codexRollout(data);
      if (news.typed !== undefined && (!a.turn || a.turn.starting || this.overIn(a))) void this.openTyped(a, news.typed, true);
      for (const e of news.events) this.emit(a, e);
      if (news.limits) a.limits = news.limits;
      if (news.context !== undefined) this.context(a, news.context);
      if (news.session) a.sessionId = news.session.id;
      const payload = isRecord(raw.payload) ? raw.payload : {};
      const id = typeof payload.turn_id === 'string' ? payload.turn_id : undefined;
      if (news.started) this.tookTurn(a, id);
      if (news.failed !== undefined) this.turnFailed(a, news.failed.text, news.failed, id);
      else if (news.aborted) this.interrupted(a, id);
      else if (news.ended) this.endTurn(a, { status: 'done', message: news.ended.message }, id);
    }
  }

  private findCodexTail(a: Agent): void {
    if (a.tail || a.program?.kind !== 'codex') return;
    const found = findRollout(a.home, a.workDir, a.startedAt - 2000, null, a.oldLogs ?? undefined);
    if (!found) return;
    a.sessionId = found.sessionId;
    a.tail = new LineTail(found.file);
  }

  /* Kimi named a session it started now; its log comes once it writes it. */
  private findKimiTail(a: Agent): void {
    if (a.tail || a.program?.kind !== 'kimi' || !a.sessionId) return;
    const wire = findKimiWire(a.home, a.sessionId);
    if (wire) a.tail = new LineTail(wire);
  }

  private receivedWords(a: Agent, line: Record<string, unknown>): void {
    this.observeRetainedAssignments(a, line);
    if (a.program?.kind === 'claude') {
      this.takeOperatorOriginal(a, line);
      this.claudeReceivedWords(a, line);
    } else if (a.program && !this.overIn(a)) {
      a.turn?.words.observe(a.program.kind, line, a.programTurnId);
    }
  }

  private takeOperatorOriginal(a: Agent, line: Record<string, unknown>): void {
    if (this.operator?.enabled(a.key) && line.type === 'user' && isRecord(line.message)) a.turn?.words.takeOriginal(contentText(line.message.content));
  }

  private claudeReceivedWords(a: Agent, line: Record<string, unknown>): void {
    const receipt = claudeWordReceipt(line, a.enqueuedWords);
    if (!receipt) return;
    for (const words of waitingWords(a)) {
      if (this.receiveClaudeWord(words, receipt)) break;
    }
  }

  private receiveClaudeWord(words: TurnWords, receipt: NonNullable<ReturnType<typeof claudeWordReceipt>>): boolean {
    if (receipt.state === 'queued') return words.queued(receipt.text, 'transcript');
    return receipt.state === 'taken' ? words.taken(receipt.text) : words.removed(receipt.text);
  }

  private observeRetainedAssignments(a: Agent, line: Record<string, unknown>): void {
    for (const retained of a.retainedAssignments ?? []) this.observeRetainedAssignment(a, retained.words, line);
    a.retainedAssignments = a.retainedAssignments?.filter(retained => retained.words.originalPending());
  }

  private observeRetainedAssignment(a: Agent, words: TurnWords, line: Record<string, unknown>): void {
    if (!a.program) return;
    if (a.program.kind === 'claude' && line.type === 'user' && isRecord(line.message)) words.takeOriginal(contentText(line.message.content));
    else words.observe(a.program.kind, line);
  }

  private takeRetainedAssignment(a: Agent, prompt: string): boolean {
    return a.retainedAssignments?.some(entry => entry.words.takeOriginal(prompt)) ?? false;
  }

  private dequeuedPrompt(a: Agent, line: Record<string, unknown>): void {
    if (line.type === 'queue-operation' && line.operation === 'dequeue') a.dequeued = true;
    if (!a.dequeued || line.type !== 'user' || !isRecord(line.message)) return;
    a.dequeued = false;
    const text = contentText(line.message.content);
    if (!text) return;
    this.dequeuedWords(a, text);
  }

  private dequeuedWords(a: Agent, text: string): void {
    if (!a.turn || !a.busy || this.overIn(a)) { void this.openTyped(a, text, true); return; }
    for (const words of a.waitingWords) if (words.taken(text)) break;
  }

  private reportUnheard(a: Agent, gone = false, reason = gone ? 'the program is no longer running' : 'the program did not take the words before the receipt wait ended'): void {
    for (const words of a.waitingWords) {
      const held = new Map(words.held().map(word => [word.text, word]));
      for (const { reason: entryReason, ...entry } of this.unheardWords(a, words, gone)) {
        if (!gone && held.has(entry.text)) this.discardHeld(a, words, held.get(entry.text)!);
        this.wordsNotDelivered(a.key, a.program?.kind, entryReason ?? reason);
        this.opts.send({ type: 'agent.unheard', agentKey: a.key, ...entry });
      }
    }
    a.waitingWords = a.waitingWords.filter(words => this.keepWords(a, words));
  }

  private unheardWords(a: Agent, words: TurnWords, gone: boolean) {
    return words.unheard(Date.now(), gone, !a.busy && !a.settling && !a.unopened.length);
  }

  private keepWords(a: Agent, words: TurnWords): boolean {
    if (!words.settled()) return true;
    for (const jobId of words.settledJobs()) this.opts.send({ type: 'agent.words_settled', agentKey: a.key, jobId });
    return false;
  }

  private discardHeld(a: Agent, words: TurnWords, receipt: WordReceipt): void {
    /* The next turn waits for saying, so its prompt cannot join input that Codex held without a receipt. */
    a.saying = a.saying.then(async () => {
      if (!a.turn || a.turn.words === words) await this.inputLane(a, () => this.eraseInput(a, receipt));
    }).catch(() => { this.log(`Agent ${a.key} (${a.program?.kind}): could not erase held live input.`); });
  }

  private endWords(a: Agent, turn: Turn): void {
    const words = turn.words;
    words.end(Date.now());
    if (!words.pending().length || a.unheardTimers.has(words)) return;
    const timer = setTimeout(() => {
      a.unheardTimers.delete(words);
      this.drain(a);
    }, UNHEARD_MS);
    timer.unref();
    a.unheardTimers.set(words, timer);
  }

  /* Tool calls a line of the program's log began and ended, for what it does now. */
  private called(a: Agent, line: unknown): void {
    const kind = a.program?.kind;
    const calls = kind && kind !== 'antigravity' ? CALLS[kind](line) : { began: [], ended: [] };
    this.mergeCalls(a, calls);
  }

  private mergeCalls(a: Agent, calls: ReturnType<typeof hookCalls>): void {
    if (calls.began.length || calls.ended.length) a.retry = null;
    for (const id of calls.ended) {
      if (!a.closedCalls.has(id)) this.ownActivity(a);
      a.calls.delete(id);
      a.closedCalls.add(id);
    }
    for (const { id, name } of calls.began) {
      if (!a.calls.has(id) && !a.closedCalls.has(id)) {
        this.ownActivity(a);
        a.calls.set(id, { name, at: Date.now() });
      }
    }
  }

  private clearQuestion(a: Agent): void {
    if (!a.operatorQuestion) return;
    a.operatorQuestion = null;
    a.question = null;
    this.operator?.question(a.key, null);
  }

  private ownActivity(a: Agent): void {
    if (a.turn) a.turn.ownActivity = true;
    this.clearQuestion(a);
    this.operator?.activity(a.key);
  }

  private agyNews(a: Agent, data: unknown): void {
    const news = a.agyRead?.(data);
    if (!news) return;
    this.mergeCalls(a, news);
    if (news.answered !== undefined) a.agyAnswered = news.answered;
    for (const e of news.events) this.emit(a, e);
  }

  /* Kimi Code logs a turn's end without its answer, which is the text of its last step that said anything, in parts. A
     person's turn reaches Hornhoof through Kimi's prompt hook, as in Claude Code. */
  private kimiNews(a: Agent, news: WireNews, raw: Record<string, unknown>): void {
    if (news.retry) {
      const { attempt, max, delayMs } = news.retry;
      a.retry = { attempt, max, nextAt: Math.ceil(Date.now() + delayMs) };
    }
    if (news.step || news.events.length) a.retry = null;
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
    if (news.started) this.tookTurn(a);
    if (news.aborted) this.interrupted(a);
    else if (news.failed !== undefined) this.endTurn(a, { status: 'failed', message: '', failure: isRecord(raw.error) ? FAILURE.kimi(raw.error) : failure('unknown', news.failed) }, undefined, news.blocked);
    else if (news.ended) this.endTurn(a, { status: 'done', message: a.lastText ?? '' });
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

  /* Kimi's answer is complete only at turn.ended on its wire. A missing wire end does not hold its hook forever. */
  private async settleWire(a: Agent, turn: Turn | null): Promise<void> {
    for (const end = Date.now() + SETTLE_MS; a.turn === turn && turn && !turn.ending && Date.now() < end; await sleep(100)) this.drain(a);
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
    if (event.kind === 'text') { this.ownActivity(a); a.lastText = event.text; a.retry = null; }
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

  private operatorToolHook(a: Agent, event: string, data: Record<string, unknown>): void {
    if (!this.stoppable(a)) return;
    this.drain(a);
    this.operator?.changed(a.key);
    this.mergeCalls(a, hookCalls(event, data));
    if (event === 'ask') return this.askedOperator(a, data);
    if ((event === 'tooldone' || event === 'toolfail') && a.question?.name === data.tool_name) this.clearQuestion(a);
  }

  private askedOperator(a: Agent, data: Record<string, unknown>): void {
    const question = operatorQuestion(data, this.opts.secrets(), a.operatorQuestion);
    if (question.id !== a.operatorQuestion?.id) this.ownActivity(a);
    a.operatorQuestion = question;
    a.question = { name: String(data.tool_name ?? 'Permission'), at: Date.now(), asking: true };
    this.operator?.question(a.key, a.operatorQuestion);
  }

  private async hook(key: string, event: string, body: unknown): Promise<string | void> {
    const a = this.agents.get(key);
    if (!a) return;
    if (event !== 'status') a.signAt = Date.now();
    const data = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    switch (event) {
      case 'tool':
      case 'tooldone':
      case 'toolfail':
      case 'ask':
        return this.operatorToolHook(a, event, data);
      case 'interrupt':
        this.drain(a);
        return this.interrupted(a, typeof data.turn_id === 'string' ? data.turn_id : undefined);
      case 'end':
        this.drain(a);
        if (data.reason === 'clear') {
          this.reportUnheard(a, true, 'the program cleared its session');
          a.enqueuedWords = [];
          a.dequeued = false;
        }
        if (await this.opts.tmux.alive(a.name)) {
          if (data.reason === 'clear' && this.stoppable(a)) this.interrupted(a);
          return;
        }
        if (this.stoppable(a)) this.turnFailed(a, 'The program session ended during the turn.', failure('crash', 'The program session ended during the turn.'));
        this.programEnded(a);
        return;
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
      case 'queued':
        a.turn?.words.queued(contentText(data.prompt ?? data.input), 'hook');
        return;
      case 'prompt': {
        const prompt = typeof data.prompt === 'string' ? data.prompt : contentText(data.prompt);
        const retained = this.takeRetainedAssignment(a, prompt);
        if (a.program?.kind === 'claude' && a.busy && a.took && !this.overIn(a) && a.typing == null) {
          /* Claude's transcript confirms queued words after this hook returns. */
          return;
        }
        const first = !a.took || a.typing != null;
        if (first && !retained) a.turn?.words.taken(prompt);
        a.took = true;
        /* Kimi Code hands the prompt as parts of a message. */
        const notice = await this.promptGot(a, prompt);
        await this.prompted(a, prompt);
        if (first) a.turn?.words.clear();
        return notice;
      }
      case 'invocation':
        await this.invocation(a, data);
        return;
      case 'stop':
        return this.stoppedHook(a, data);
    }
  }

  private async stoppedHook(a: Agent, data: Record<string, unknown>): Promise<void> {
    this.drain(a);
    if (typeof data.session_id === 'string') this.follow(a, data.session_id);
    const id = typeof data.turn_id === 'string' ? data.turn_id : undefined;
    if (data.stopped === true) return this.interrupted(a, id);
    const detail = this.stopFailure(a, data);
    if (detail) return this.turnFailed(a, detail.text, detail, id);
    await this.successfulStop(a, data, id);
  }

  private stopFailure(a: Agent, data: Record<string, unknown>): Failure | null {
    const failed = data.hook_event_name === 'StopFailure' || Boolean(data.error) || Boolean(data.error_type);
    if (!failed) return null;
    const raw = this.stopFailureData(a, data);
    return a.program ? FAILURE[a.program.kind](raw) : failure('unknown', String(data.error));
  }

  private stopFailureData(a: Agent, data: Record<string, unknown>): Record<string, unknown> {
    if (isRecord(data.agy_error)) return data.agy_error;
    return a.program?.kind === 'antigravity' ? agyError(this.agyOutput(a), data.error) ?? data : data;
  }

  private async successfulStop(a: Agent, data: Record<string, unknown>, id: string | undefined): Promise<void> {
    if (a.program?.kind === 'kimi') {
      const turn = a.turn;
      await this.settleWire(a, turn);
      if (!this.stopIsCurrent(a, turn)) return;
    }
    this.completeStop(a, data, id);
  }

  private completeStop(a: Agent, data: Record<string, unknown>, id: string | undefined): void {
    if (a.program?.kind === 'antigravity') return this.agyStopped(a);
    const message = a.program?.kind === 'kimi' ? a.lastText ?? '' : String(data.last_assistant_message ?? '');
    this.endTurn(a, { status: 'done', message }, id);
  }

  private stopIsCurrent(a: Agent, turn: Turn | null): boolean {
    return a.turn === turn && !turn?.ending;
  }

  private async invocation(a: Agent, data: Record<string, unknown>): Promise<void> {
    if (a.program?.kind !== 'antigravity') return;
    if (typeof data.conversationId === 'string') this.follow(a, data.conversationId);
    if (data.invocationNum !== 0) {
      a.busy = true;
      return;
    }
    const prompt = String(data.lastUserInput ?? '');
    this.takeInvocationWords(a, prompt);
    await this.prompted(a, prompt);
  }

  private takeInvocationWords(a: Agent, prompt: string): void {
    const retained = this.takeRetainedAssignment(a, prompt);
    if (a.typing !== null && !retained) a.turn?.words.taken(prompt);
    a.typing = null;
  }

  private async prompted(a: Agent, prompt: string): Promise<void> {
    a.took = true;
    await a.settling;
    if (a.program?.kind === 'antigravity') {
      a.agyAnswered = false;
      /* Invocation 0 waits here before agy dispatches the message, including during a recorder append or trim. */
      a.agyCursor = await this.opts.tmux.programCursor(a.name);
      a.interruptions = interruptionCount(await this.opts.tmux.screen(a.name, 0, true));
    }
    a.busy = true;
    /* A message queued in the program starts its own turn after the previous one ends. */
    if (!a.turn || a.turn.starting || this.overIn(a)) await this.openTyped(a, prompt);
    this.tookTurn(a);
  }

  private agyStopped(a: Agent): void {
    const turn = a.turn;
    /* Answer the hook before reading the rest: agy may append its final response only after the hook returns. */
    const settling = this.settle(a, null).then(message => {
      if (a.turn === turn) this.endTurn(a, { status: 'done', message });
    });
    a.settling = settling;
    void settling.finally(() => { if (a.settling === settling) a.settling = null; });
  }

  /* A person typed while no turn ran, or while the program started: the turn starts at once and Hornhoof opens a job for
     it, so the agent has its tools and the turn shows like any other. Claude Code waits in its hook for Hornhoof's answer,
     for a while; Codex goes on, and what it does waits in the turn. fromLog: the typing was read from the log, which is
     being read now. */
  private async openTyped(a: Agent, text: string, fromLog = false): Promise<void> {
    if (!fromLog) this.drain(a);
    const taken = this.takeTypedWords(a, text);
    const queuedFrom = taken.jobId;
    const sourceDelivery = taken.operatorDelivery;
    text = taken.text;
    const start = a.starting;
    a.fresh = false;
    a.lastText = null;
    a.stepSaid = false;
    const id = fromLog ? a.programTurnId : undefined;
    this.beginTurn(a);
    a.ends.started(id);
    a.programTurnId = id;
    const turn: Turn = { jobId: null, onEvent: () => {}, typed: true, seq: 0, words: new TurnWords([], { word: this.wordReceipt(a) }), ref: randomUUID(), early: [], over: null, opened: deferred(), sourceDelivery, operatorInstance: this.operator?.identity(a.key)?.instance };
    turn.observed = this.observeProgram(null);
    a.turn = turn;
    a.busy = a.took = true;
    this.operator?.suspend(a.key);
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
    this.opts.send(typedOpen(a.key, text, turn.ref, queuedFrom));
    await answered();
  }

  private takeTypedWords(a: Agent, text: string): TakenWords {
    const original = recordedOriginal(a, text);
    if (original) a.originalTaken = undefined;
    let taken: TakenWords = original ?? { jobId: null, text };
    for (const words of a.waitingWords) {
      if (taken.jobId) break;
      const queued = words.takeQueued(taken.text);
      /* Hornhoof finds its words by what it typed, not by how the program recorded them. */
      if (queued) { taken = queued; break; }
    }
    return taken;
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
    if (turn.over) this.typedDone(turn, turn.over.message, turn.over.error, turn.over.sessionId, turn.over.output, turn.over.programOutput, turn.over.failure);
  }

  private bindTyped(a: Agent, turn: Turn, m: Msg<'turn.opened'>, early: AgentEvent[]): void {
    if (m.jobId && m.toolToken) {
      turn.jobId = m.jobId;
      this.bindOperatorTurn(a, turn, m.jobId);
      turn.words.bind(m.jobId);
      turn.toolToken = m.toolToken;
      turn.observed!.watch.bind(m.jobId, Date.now());
      if (a.turn === turn) this.bridge.setToken(a.key, m.toolToken);
      for (const e of early) this.typedEvent(turn, e);
    }
  }

  private bindOperatorTurn(a: Agent, turn: Turn, jobId: string): void {
    if (a.turn === turn) {
      this.operator?.begin(a.key, jobId, undefined, '', true, turn.sourceDelivery);
      return;
    }
    if (!a.turn) this.operator?.suspend(a.key);
    if (turn.ownActivity && turn.sourceDelivery && turn.operatorInstance) this.operator?.sourceActivity(a.key, turn.operatorInstance, turn.sourceDelivery);
  }

  private finishTyped(a: Agent, message: string, error: JobError = null, output = '', programOutput?: ProgramOutput, turn = a.turn): void {
    if (!turn?.typed) return;
    this.endWords(a, turn);
    if (a.turn === turn) { a.turn = null; this.bridge.setToken(a.key, null); }
    if (a.sessionId) this.opts.remember?.(a.sessionId, a.workDir);
    /* Hornhoof hears the limits with the next turn it runs. */
    void this.planLimits(a);
    /* Hornhoof has not answered yet: the end goes out with its answer. */
    const detail = error && error !== 'cancelled' ? turn.ending?.failure ?? a.failure ?? failure('unknown', output) : undefined;
    if (turn.early) turn.over = { message, error, sessionId: a.sessionId, output, programOutput, failure: detail };
    else this.typedDone(turn, message, error, a.sessionId, output, programOutput, detail);
  }

  private typedDone(turn: Turn, message: string, error: JobError, sessionId: string | null, output: string, programOutput?: ProgramOutput, failure?: Failure): void {
    if (!turn.jobId) return;
    const result = error === 'cancelled' ? 'Stopped.' : error ? '' : message;
    this.opts.send(jobDone(turn.jobId, { ok: !error, sessionId, result, output, programOutput, failure, error, limits: null, ...(turn.words.waitingForTurn(Date.now()) ? { wordsWaiting: true } : {}) }, [...this.opts.secrets(), ...(turn.toolToken ? [turn.toolToken] : [])]));
  }

  /* Turns people typed that run now: they count as running when the node says hello again. */
  typedJobs(): string[] {
    return [...this.agents.values()].flatMap(a => (a.turn?.typed && a.turn.jobId ? [a.turn.jobId] : []));
  }

  /* Words for the agent while its turn runs, typed into the program as a person types: Claude Code, Codex and Kimi Code
     take them into the turn at its next step. False when no turn runs or the program takes none, so Hornhoof gives them
     the next turn instead. */
  say(key: string, text: string, within = Infinity, operatorDelivery?: OperatorDelivery): Promise<boolean> {
    const a = this.agents.get(key);
    if (!a?.turn) return Promise.resolve(this.wordsNotDelivered(key, a?.program?.kind, 'no turn is running'));
    if (!a.program) return Promise.resolve(this.wordsNotDelivered(key, undefined, 'the program is not known'));
    const words: LiveWords = { turn: a.turn, program: a.program, text, deadline: Date.now() + within, operatorDelivery };
    const said = a.saying.then(() => this.inputLane(a, async () => {
      const went = await this.sayIn(a, words).catch(() => false);
      return went || this.wordsNotDelivered(key, words.program.kind, words.reason);
    }));
    a.saying = said.catch(() => {});
    return said;
  }

  private wordsNotDelivered(key: string, kind: TermProgram['kind'] | 'unknown' = 'unknown', reason = 'terminal input failed'): false {
    this.log(`Agent ${key} (${kind}): live words were not delivered: ${reason}.`);
    return false;
  }

  private refuseWords(words: LiveWords, reason: string): false {
    words.reason = reason;
    return false;
  }

  private async sayIn(a: Agent, words: LiveWords): Promise<boolean> {
    const wait = await this.livePasteWait(a, words);
    if (wait === null) return false;
    return this.deliverWords(a, words, wait);
  }

  private async livePasteWait(a: Agent, words: LiveWords): Promise<number | null> {
    /* Antigravity queues typed words as a separate turn, so these wait for Hornhoof's next turn. */
    if (words.program.kind === 'antigravity') {
      this.refuseWords(words, 'this program takes live words as a separate turn');
      return null;
    }
    await this.waitToSay(a, words);
    if (!(await this.canSay(a, words))) return null;
    words.reason = 'could not read the input';
    const input = await this.liveInput(a, words);
    if (input === null) {
      this.refuseWords(words, 'the input could not be read');
      return null;
    }
    if (input !== '') {
      this.refuseWords(words, 'the input contains unsent words');
      return null;
    }
    if (!(await this.canSay(a, words))) return null;
    const wait = pasteWait(words.text);
    if (Date.now() + wait < words.deadline) return wait;
    this.refuseWords(words, 'there is not enough time to paste the words');
    return null;
  }

  private async deliverWords(a: Agent, words: LiveWords, wait: number): Promise<boolean> {
    let went = false;
    const receipt = this.liveReceipt(a, words);
    try {
      this.operator?.live(a.key, words.operatorDelivery, words.text);
      went = await this.typeLiveWords(a, words, receipt, wait);
      receipt.accepted = went;
      this.reportUnheard(a, !(await this.opts.tmux.alive(a.name).catch(() => true)));
      return went;
    } catch {
      this.drain(a);
      went = heardWords(receipt);
      receipt.accepted = went;
      return went;
    } finally {
      if (!went) await this.wordsNotTaken(a, words, receipt);
    }
  }

  private async wordsNotTaken(a: Agent, words: LiveWords, receipt: WordReceipt): Promise<void> {
    receipt.state = 'discarded';
    this.operator?.receipt(a.key, words.operatorDelivery, 'not_taken');
    await this.discardWords(a, words, receipt);
  }

  private liveReceipt(a: Agent, words: LiveWords): WordReceipt {
    const pending = words.turn.words;
    const receipt = pending.add(words.text, words.turn.jobId, words.operatorDelivery);
    if (!a.waitingWords.includes(pending)) a.waitingWords.push(pending);
    return receipt;
  }

  private async typeLiveWords(a: Agent, words: LiveWords, receipt: WordReceipt, wait: number): Promise<boolean> {
    words.reason = 'could not paste the words';
    await this.opts.tmux.paste(a.name, words.text);
    receipt.shown = null;
    await sleep(wait);
    receipt.shown = await this.readInput(a).catch(() => null);
    if (!(await this.canSay(a, words))) return false;
    const key = words.program.kind === 'kimi' ? 'C-s' : 'Enter';
    for (let attempt = 0; attempt < 2; attempt++) {
      words.reason = 'could not send the submit key';
      await this.opts.tmux.keys(a.name, key);
      words.reason = 'the program did not record a receipt after two submit keys';
      if (await this.waitForReceipt(a, words, receipt)) return true;
      if (!(await this.canSay(a, words))) break;
    }
    if (words.program.kind !== 'codex') return false;
    receipt.state = 'held';
    return true;
  }

  private async waitToSay(a: Agent, words: LiveWords): Promise<void> {
    /* Hornhoof's own prompt goes in first, or the words would join it in the program's input. */
    const end = Math.min(words.deadline, Date.now() + ENTER_TRIES * this.enterWaitMs);
    while (a.turn === words.turn && !words.turn.typed && !a.took && Date.now() < end) {
      this.drain(a);
      await sleep(this.pollMs);
    }
  }

  private wordsRefusal(a: Agent, words: LiveWords): string | null {
    this.drain(a);
    /* A turn that ended in the program takes no words: typed then, they would start a turn nobody waits for. */
    if (Date.now() >= words.deadline) return 'the delivery deadline passed';
    if (activeTurn(a) !== words.turn) return 'the receiving turn changed or ended';
    if (words.turn.starting) return 'the program is still starting';
    if (!words.turn.typed && !a.took) return 'the program has not taken the turn prompt';
    if (!a.busy || this.overIn(a)) return 'the receiving turn ended';
    return null;
  }

  private async canSay(a: Agent, words: LiveWords): Promise<boolean> {
    const before = this.wordsRefusal(a, words);
    if (before) return this.refuseWords(words, before);
    try {
      if (!(await this.opts.tmux.alive(a.name))) return this.refuseWords(words, 'the program is no longer running');
    } catch { return this.refuseWords(words, 'could not check whether the program is running'); }
    const after = this.wordsRefusal(a, words);
    return after ? this.refuseWords(words, after) : true;
  }

  /* Before typing only: keep a person's unsent words out of Hornhoof's live message. */
  private async readInput(a: Agent): Promise<string | null> {
    const screen = await this.opts.tmux.screen(a.name, 0, true);
    return a.program ? inputOf(a.program.kind, screen) : null;
  }

  private async liveInput(a: Agent, words: LiveWords): Promise<string | null> {
    const end = Math.min(words.deadline, Date.now() + this.enterWaitMs);
    for (;;) {
      const input = await this.readInput(a);
      if (input !== null || Date.now() >= end) return input;
      await sleep(this.pollMs);
    }
  }

  private async waitForReceipt(a: Agent, words: LiveWords, receipt: WordReceipt): Promise<boolean> {
    const end = Math.min(words.deadline, Date.now() + this.enterWaitMs);
    for (;;) {
      this.drain(a);
      if (heardWords(receipt)) return true;
      if (!(await this.canSay(a, words)) || Date.now() >= end) return false;
      await sleep(this.pollMs);
    }
  }

  private async discardWords(a: Agent, words: LiveWords, receipt: WordReceipt): Promise<void> {
    /* A missed Enter must not leave words for a later turn to submit. Keep the program and its conversation. */
    if (a.turn && a.turn !== words.turn) return;
    await this.eraseInput(a, receipt).catch(() => { words.reason += '; could not erase the typed input'; });
  }

  private async eraseInput(a: Agent, receipt: WordReceipt): Promise<void> {
    if (receipt.shown === undefined) return;
    if (!(await this.opts.tmux.alive(a.name))) return;
    const shown = receipt.shown ?? receipt.text.trim();
    if (!shown || await this.readInput(a) !== shown) return;
    const erase = receipt.text.split('\n').flatMap((_, i) => i ? ['BSpace', 'C-u'] : ['C-u']);
    await this.opts.tmux.keys(a.name, ...erase);
  }

  async restart(key: string, jobId: string, note: string): Promise<{ ok: boolean; reason: string | null }> {
    const a = this.agents.get(key);
    if (a && !a.restarting) this.drain(a);
    const turn = a?.turn;
    const reason = restartRefusal(restartEvidence(a), jobId, Date.now());
    if (reason) return { ok: false, reason };
    if (!a?.launch || !turn || a.restarting) return { ok: false, reason: 'The program launch is not available.' };
    try {
      await a.saying;
      this.drain(a);
      const changed = restartRefusal(restartEvidence(a), jobId, Date.now());
      if (changed) return { ok: false, reason: changed };
      turn.restarted = true;
      a.restarting = true;
      if (a.turn !== turn || !a.busy) return { ok: false, reason: 'The turn ended before the restart.' };
      const { job, spec } = a.launch;
      const command = resumeCommand(job.program.kind, spec.command, a.sessionId!);
      /* Keep the exact environment of the original launch while resuming its known session. */
      a.started = deferred();
      a.oldLogs = null;
      a.tail = this.tailFor(a);
      const scratch = this.opts.tmux.scratch();
      this.operator?.intentional(a.key, 'restart');
      this.operator?.exited(a.key, { code: null, signal: null });
      this.operator?.begin(a.key, jobId, undefined, '', false);
      this.operator?.launch(a.key, 'attempt');
      await this.inputLane(a, () => this.opts.tmux.launch(a.name, { cwd: a.workDir, command: this.asAgent(command), cols: this.cols, rows: this.rows, envFile: envFile(scratch, { ...lasting(job.input.env), ...spec.env }), outputDir: scratch }));
      this.operator?.launch(a.key, 'started');
      if (!(await this.ready(a, { ...job, operatorDelivery: undefined }))) throw new Error('The restarted program did not become ready.');
      this.programIs(a, true);
      a.tail = this.tailFor(a);
      a.enqueuedWords = [];
      a.ends.begin();
      a.retry = null;
      const text = [note, ...turn.words.pending()].filter(Boolean).join('\n\n');
      turn.words.replay(text);
      a.took = false;
      a.typing = text;
      await this.inputLane(a, () => this.opts.tmux.paste(a.name, text));
      await sleep(pasteWait(text));
      a.restarting = false;
      await this.inputLane(a, () => this.opts.tmux.keys(a.name, 'Enter'));
      this.log(`Agent ${key} (${a.program?.kind}): restarted program in session ${a.sessionId} for job ${jobId}.`);
      return { ok: true, reason: null };
    } catch (error) {
      return { ok: false, reason: String(error instanceof Error ? error.message : error).slice(0, 300) };
    } finally {
      a.restarting = false;
    }
  }

  /* Hornhoof calls off a turn a person typed: the program stops as on Escape, and the turn ends as stopped. */
  async cancel(jobId: string): Promise<void> {
    const a = [...this.agents.values()].find(x => x.turn?.typed && x.turn.jobId === jobId);
    if (!a) return;
    this.intentional(a, 'cancelled');
    this.finishTyped(a, '', 'cancelled');
    /* A session that is gone took its program with it; the turn ends all the same. */
    a.cancelling = this.inputLane(a, () => this.opts.tmux.keys(a.name, 'Escape')).catch(() => {});
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
    if (a.restarting) return;
    this.reportUnheard(a, true);
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
    if (view?.write) this.ownerTyped(view, m.data);
  }

  private ownerTyped(view: View, data: string): void {
    this.operator?.ownerInput(view.key);
    const a = this.agents.get(view.key);
    if (a) a.ownerTyped = true;
    if (a) void this.inputLane(a, async () => { view.child.stdin?.write(data); });
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

function initialToolsNeeded({ program, input }: TermJob, goesOn: boolean): boolean {
  const lazy = (program.kind === 'kimi' && !input.sessionId) || program.kind === 'antigravity';
  return !goesOn && !input.prompt && Boolean(input.tools) && !lazy;
}

function assignmentOutlastsTurn(a: Agent): boolean {
  return !a.turn || Boolean(a.turn.starting || a.turn.ending);
}

function failedError(error: JobError, detail: Failure | null, operatorFailure: boolean, output: string | null, signedOut: RegExp): JobError {
  if (error === 'cancelled') return exitError(output, signedOut, error);
  if (operatorFailure) return 'agent_failed';
  if (detail?.kind === 'auth') return 'not_logged_in';
  return exitError(output, signedOut, error);
}

function failedDetail(error: JobError, detail: Failure | null, exited: boolean, output: string): { failure?: Failure } {
  return error && error !== 'cancelled' ? { failure: detail ?? failure(exited ? 'crash' : 'unknown', output, true) } : {};
}

function managedTurn(turn: Turn | null): boolean {
  return Boolean(turn && !turn.typed);
}

function endedError(stopped: boolean, detail: Failure | undefined, signedOut: RegExp | null): JobError {
  if (stopped) return 'cancelled';
  if (!detail) return null;
  return detail.kind === 'auth' || signedOut?.test(detail.text) ? 'not_logged_in' : 'agent_failed';
}

/* A signed-out Kimi Code fails at once, unless the operator answers for this assignment. */
function kimiSignedOut(job: TermJob, kind: keyof typeof READY, screen: string): boolean {
  return !job.operatorDelivery && kind === 'kimi' && job.signedOut.test(screen);
}

function stopsAtSetup(step: Awaited<ReturnType<typeof pastColors>>, stuck: boolean): boolean {
  return step === 'terms' || stuck;
}

function hasOwnThought(a: Agent, line: Record<string, unknown>): boolean {
  return Boolean(a.program && activeTurn(a) && ownThought(a.program.kind, line, a.programTurnId));
}

function waitingWords(a: Agent): Set<TurnWords> {
  return new Set([...a.waitingWords, ...(a.turn ? [a.turn.words] : [])]);
}

function recordedOriginal(a: Agent, text: string): Agent['originalTaken'] | null {
  const original = a.originalTaken;
  return original && flat(original.text) === flat(text) ? original : null;
}

function restartEvidence(a: Agent | undefined): RestartEvidence | null {
  if (!a?.program || !a.turn) return null;
  return {
    jobId: a.turn.jobId, kind: a.program.kind,
    state: programState('', a.question ?? a.calls.values().next().value ?? null, Boolean(a.busy && a.took), a.retry),
    calls: a.calls.size, question: Boolean(a.question), signAt: a.signAt, sessionId: a.sessionId, restarted: Boolean(a.turn.restarted),
  };
}

function programExitStatus(output: ProgramOutput | undefined): { code: number | null; signal: string | null } {
  return { code: output?.code ?? null, signal: signalName(output?.signal ?? null) };
}

function typedOpen(agentKey: string, text: string, ref: Turn['ref'], queuedFrom: string | null): Extract<NodeMessage, { type: 'turn.open' }> {
  return { type: 'turn.open', agentKey, text: text.slice(0, 100_000), ref, ...(queuedFrom ? { queuedFrom } : {}) };
}

/* How many tokens the model Kimi starts with takes in its context, from its settings. */
function kimiWindow(home: string, model: string | null): number | null {
  try {
    return kimiContextSize(readFileSync(join(home, 'config.toml'), 'utf8'), model);
  } catch {
    return null;
  }
}
