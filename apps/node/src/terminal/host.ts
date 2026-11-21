import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cut, isProgramOwnPrompt, isTerminalReport, NEXT_TURN_WORDS, typesWords, UNHEARD_MS, type AgentEvent, type Failure, type Limits, type NodeMessage, type ServerMessage, type TurnTokens } from '@hornhoof/protocol';
import type { ToolPrivacy, ToolPrivacyPolicy } from '@hornhoof/protocol';
import type { OperatorDelivery, OperatorInputLine, OperatorQuestion, OperatorServerMessage } from '@hornhoof/protocol/program-operator';
import { agyRules, COLORS_NOT_TAKEN, colorsNotTaken, pastColors, SETUP_NEEDED } from '../providers/antigravity.js';
import { toldPlace } from '../program-folder.js';
import { claudeEvents, claudeInterrupted } from '../providers/claude.js';
import type { ProgramRetry } from '@hornhoof/protocol/map';
import { contentText, isRecord } from '../providers/events.js';
import { agentFs, ownFs, type AgentFs } from '../agent-fs.js';
import { asAgent, type JobUser } from '../isolation.js';
import { kimiContextSize } from '../providers/kimi.js';
import { machineLoad, programWorkers, type MachineLoad } from '../load.js';
import { jobDone, ProgramNotStarted, tidy, type RunInput, type RunResult } from '../runner.js';
import { TurnTally } from '../turn-tokens.js';
import { plainOutput, signalName, type ProgramOutput } from '../program-exit.js';
import { redact } from '../redact.js';
import { Bridge, type AgentUrls, type OpensCheck, type Outside } from './bridge.js';
import { atEmptyPrompt, inputOf, withoutDim } from './input.js';
import { eraseKeys, flat, holdsFoldedPaste, isOwnLeft, leftRef, LeftInputs, type OwnLeft } from './left-input.js';
import { ViewSessions } from './views.js';
import { SessionPrivacy } from './privacy.js';
import { procOwner, type OwnerFactory, type Ownership, type Panes } from './peer.js';
import { ProgramWatch, READY, REPORT_MS, completionText, programState, type Pending } from './program-state.js';
import type { LaunchSpec, TermProgram } from './programs.js';
import { agyTranscript, prepareAgy } from '../providers/antigravity-terminal.js';
import { acceptClaudeDialogs, claudeToolsFile, claudeTranscript, writeClaudeTools } from '../providers/claude-terminal.js';
import { findRollout, rolloutFiles } from '../providers/codex-terminal.js';
import { findKimiWire, prepareKimi } from '../providers/kimi-terminal.js';
import { FAILURE, failure } from './failures.js';
import { TurnEnds, hookCalls, claudeEnd, stopIsLate, type TurnEnd } from './turn-signals.js';
import { busy, enterPending, hasSettled, idleRefusal, RETIRED, stale, type IdleEvidence, type RetireResult } from './program-retire.js';
import { claudeWordReceipt, restartRefusal, resumeCommand, TurnWords, type RestartEvidence, type WordReceipt } from './program-restart.js';
import { CALLS } from './tool-calls.js';
import { agyError, agySteps, claudeStatusContext, claudeStatusLimits, codexRollout, kimiWire, LineTail, type WireNews } from './transcripts.js';
import type { RecordingCursor } from './recordings.js';
import { envFile, type Tmux } from './tmux.js';
import { holdsWords, LostWords } from './lost-words.js';
import { inputShown, OperatorRuntime, type OperatorOptions } from './operator-runtime.js';
import { ownThought } from './operator-activity.js';
import type { ProgramFacts } from './program-access.js';
import type { OperatorProgram } from './operator-control.js';
import { operatorQuestion } from './operator-question.js';

/* An agent's turn in its terminal: which program, where it keeps its sign-in, and what the runner hands every program.
   freshPrompt: an assistant's whole conversation, which the turn types in place of its prompt into a session that starts
   anew; sent: the prompt Hornhoof sent when the turn types other words, which its delivery stays of. */
export type TermJob = { key: string; program: TermProgram; bin: string; home: string; signedOut: RegExp; input: RunInput; version?: () => Promise<string | null>; operatorDelivery?: OperatorDelivery; operatorSourceDelivery?: OperatorDelivery; freshPrompt?: string; sent?: string };

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
  privacy?: ToolPrivacy;
  jobId: string | null;
  onEvent(e: AgentEvent): void;
  typed: boolean;
  seq: number;
  signal?: AbortSignal;
  ref?: string;
  early?: AgentEvent[] | null;
  over?: { message: string; error: JobError; sessionId: string | null; output: string; programOutput?: ProgramOutput; failure?: Failure; tokens: TurnTokens | null } | null;
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
  /* Hornhoof called the turn off: its program got its Escape, and nothing that comes later stops it again. */
  calledOff?: boolean;
};
type JobError = RunResult['error'];
/* What the end of a turn Hornhoof gave tells as Hornhoof calls it off. */
export type CalledOff = { sessionId: string | null; tokens: TurnTokens | null };
type LiveWords = { turn: Turn; program: TermProgram; text: string; deadline: number; reason?: string; operatorDelivery?: OperatorDelivery };
type TakenWords = { jobId: string | null; text: string; operatorDelivery?: OperatorDelivery };

type Agent = {
  key: string;
  name: string;
  program: TermProgram | null;
  signedOut: RegExp | null;
  home: string;
  /* The folder the program works in. */
  workDir: string;
  /* The folder of Hornhoof's own files for it: the same one unless its turn belongs to a task. */
  contextDir: string;
  /* What the running program was started with; a turn that needs anything else starts it again. */
  hash: string | null;
  sessionId: string | null;
  /* Sessions a person cleared in the running program: a turn asking for one goes on in the session that replaced it. */
  cleared: Set<string>;
  /* Sessions the agent was in and left, in any program: what they still say is not about the turn that runs now. */
  left: Set<string>;
  /* The session a person's clear began, until a turn types an assistant's whole conversation into it. */
  blank: string | null;
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
  /* Its program runs and showed its prompt; until then its views show a loader. */
  up: boolean;
  /* Its program sleeps until the next turn, its pane kept with what it printed; its views show that. */
  asleep: boolean;
  /* Reads the log and looks at the program while it runs. */
  watch: NodeJS.Timeout | null;
  /* Words Hornhoof types into running turns, one after another. */
  saying: Promise<unknown>;
  waitingWords: TurnWords[];
  retainedAssignments?: { jobId: string; text: string; words: TurnWords }[];
  /* When a person last typed words at the terminal, and when Hornhoof last typed a prompt there. */
  typedAt?: number | null;
  pastedAt?: number;
  /* The prompt of a turn that ended as its program never took it: Hornhoof repeats those words itself. */
  ownLeft?: OwnLeft | null;
  /* A copy of a prompt the program took, typed again while it was on its way in: none of it is to go. */
  ownCopy?: OwnLeft | null;
  /* This turn's prompt has not gone in yet: what the program takes meanwhile is a person's. */
  promptWaits?: boolean;
  /* A person sent words meanwhile that the program has not finished answering. */
  personWords?: boolean;
  originalTaken?: { jobId: string; text: string; operatorDelivery?: OperatorDelivery };
  /* The owner's last Enter in a running turn, as Hornhoof tells of it: a prompt the program queues from it, or takes right
     after that turn, opens a turn of theirs. It counts until shortly after that turn ended. */
  pressed?: { jobId: string; at: number; until: number | null } | null;
  /* Words Claude took out of its queue in a turn that seemed to run, with nothing from it since. */
  unanswered?: TakenWords | null;
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
  /* Words were steered into Kimi's running turn and it has not taken them into it: Kimi 2.6.3 ends that turn for them and
     goes on with them in one of its own, which is still the same Hornhoof turn. */
  steered?: boolean;
  /* Turns Kimi ended at such a split, whose stop hook may still come: that stop ends no Hornhoof turn. */
  splitStops?: number;
  /* Kimi ended a turn at a split and has not started the one it goes on in yet. */
  splitWaits?: boolean;
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
  /* What the running turn used, as its program's log tells it. */
  tally: TurnTally;
  /* The final planner response has no tools; earlier text is not the answer a stop waits for. */
  agyAnswered: boolean;
  /* Diagnostics visible before this invocation cannot classify its failure. */
  agyCursor: RecordingCursor | null;
  /* Recording position before this turn: an older completion must never answer a new prompt. */
  completionStart: Promise<RecordingCursor | null> | null;
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
  /* This start of the program, new with each. */
  instance: string | null;
  /* Hornhoof's turns sent here and not over yet. */
  queuedTurns: number;
  /* The last turn Hornhoof sent here, and the turns people typed since. */
  sinceRun: Set<string>;
  /* The agent left this node's plan after this turn: the program goes once it is idle, unless a turn comes here again. */
  leaving: string | null;
  tryingToLeave: boolean;
  tryingToSleep: boolean;
};


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
  /* Asks Hornhoof over the node's own link what an agent's program sent its tools with no turn running, and for a step
     for a check command it runs then. */
  toolsOutside?: Outside;
  checkStep?: OpensCheck;
  /* How long a program started with nothing to type gets to connect to its tools. */
  toolsMs?: number;
  /* How long the host waits for the program to take a prompt before it presses Enter again. */
  enterWaitMs?: number;
  /* How long after a person's last key their words in the input stay untouched, for they may still be writing. */
  typingQuietMs?: number;
  /* How long the host waits for Hornhoof to say it keeps words left in the input, before it tells them again. */
  keptWaitMs?: number;
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
  /* The machine the programs share, and the environment the node runs with, which they inherit. */
  machine?: () => Pick<MachineLoad, 'cpus' | 'memTotal'>;
  env?: NodeJS.ProcessEnv;
};

const WAITING = 'This agent starts with its next turn.';
const TOOLS_LOST = "could not reach Hornhoof's tools when its program connected, so the program starts again in its session.";
const STOP_WAIT_MS = 5000;
/* Why a program that was to sleep or close stays, or stays watched: it began a turn of its own meanwhile. */
const TURN_BEGAN = 'it began a turn of its own';
/* How many Enter waits live words give Hornhoof's own prompt to be taken before they go in. */
const ENTER_TRIES = 3;
/* What a typed turn keeps at most while Hornhoof has not answered it. */
const EARLY_MAX = 1000;
/* A stop hook can precede the program's last log lines; the turn waits this long for them. */
const SETTLE_MS = 3000;
/* How long the plan's limits may take to come after a turn of a program that does not log them. */
const LIMITS_WAIT_MS = 10_000;
/* How long a Claude Code that said it started may take to show its input box. */
const INPUT_WAIT_MS = 10_000;
/* How many times the host tries to empty an input before the turn's watch takes over. */
const ERASE_ROUNDS = 3;
/* How often the host looks at what the program of a running turn does, besides each time it begins or ends a tool. */
const LOOK_MS = 5000;
/* How long agy's list of slash commands takes to catch up with a command's name before the Enter that runs it. */
const SLASH_MS = 500;
/* How long a program that just showed its prompt takes before it reads what is typed. */
const PROMPT_SETTLE_MS = 500;
/* What the options leave out: how long the host waits for what, and the terminal's size. */
const DEFAULTS = { readyMs: 120_000, pollMs: 500, openMs: 8000, toolsMs: 15_000, enterWaitMs: 4000, typingQuietMs: 15_000, keptWaitMs: 10_000, wordsQuietMs: 15_000, reportMs: REPORT_MS, cols: 160, rows: 48 };
/* The options given, without those set to nothing. */
const defined = (opts: Options): Partial<Options> => Object.fromEntries(Object.entries(opts).filter(([, value]) => value !== undefined));
const withSession = (m: NodeMessage, session: string | null): NodeMessage => (m.type === 'job.program' && session ? { ...m, session } : m);
/* When the host last looked at the program, and the tool it ran then. */
type Look = { at: number; call: Pending | null; retry?: ProgramRetry | null };
type ObservedProgram = { watch: ProgramWatch; look: Look };
/* A program may change how a prompt's lines and spaces look, not its words. */
/* The prompt Hornhoof typed, whole or the part of it a program got. */
const typedPrompt = (prompt: string, typed: string) => flat(typed).includes(flat(prompt)) || flat(prompt).includes(flat(typed));
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
    program, home, workDir: input.workDir, contextDir: input.workDir, sessionId: spec.sessionId, cleared: new Set(), startedAt: Date.now(), started: deferred<void>(), fresh: false,
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
/* agy waits at its prompt, which may still hold words. */
const agyAtPrompt = (screen: string): boolean => READY.antigravity(screen) && inputOf('antigravity', screen) !== null;
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
  /* A plain screen hash would let a viewer guess masked values. Bind the keyed proof to this agent and program too,
     so another program's chosen output cannot serve as a verifier. The key never leaves this host. */
  private readonly completionKey = randomBytes(32);
  private readonly operator: OperatorRuntime | null;
  private readonly operatorTimer: NodeJS.Timeout | null;
  private readonly agents = new Map<string, Agent>();
  private readonly viewSessions: ViewSessions;
  private readonly privacy: SessionPrivacy;
  private readonly bridge: Bridge;
  private readonly fs: AgentFs;
  private readonly readyMs: number;
  private readonly pollMs: number;
  private readonly openMs: number;
  private readonly toolsMs: number;
  private readonly enterWaitMs: number;
  private readonly typingQuietMs: number;
  private readonly leftInputs: LeftInputs;
  private readonly wordsQuietMs: number;
  private readonly lookMs: number;
  private readonly reportMs: number;
  private readonly remembered = new Set<string>();
  /* Windows opening one agent wait for the same session to be created. */
  private readonly sessionsOpening = new Map<string, Promise<void>>();
  /* The last launch into each agent's session, which the next one waits for. */
  private readonly launches = new Map<string, Promise<unknown>>();
  private readonly limitsStops = new Set<AbortController>();
  private readonly cols: number;
  private readonly rows: number;

  constructor(private readonly opts: Options) {
    const owner = ownership(opts, (key, signal) => this.panes(key, signal));
    this.bridge = new Bridge(opts.hornhoof, (key, event, body) => this.hook(key, event, body), owner.owns, {
      capture: owner.capture, rejected: (key, event, reason) => this.hookRejected(key, event, reason), unowned: (key, event) => this.unownedHook(key, event),
      ownerRejected: (key, event, reason) => this.logHookRejection(key, event, reason),
      ownerReported: (key, event, reason) => this.reportHookRejection(key, event, reason),
      refused: (key, method, reason) => this.log(`Hornhoof's tools refused ${method} of agent ${key}: ${reason}.`),
      outside: opts.toolsOutside, opening: key => this.openingTurn(key), checkStep: opts.checkStep,
      sensitive: (key, name, input, answer, policy) => this.sensitiveTool(key, name, input, answer, policy),
    });
    this.fs = opts.fs ?? (opts.user ? agentFs(opts.user) : ownFs);
    const set = { ...DEFAULTS, ...defined(opts) };
    this.readyMs = set.readyMs;
    this.pollMs = set.pollMs;
    this.openMs = set.openMs;
    this.privacy = new SessionPrivacy(opts.tmux, message => this.log(message));
    this.viewSessions = new ViewSessions(opts, {
      openMs: this.openMs,
      agent: key => this.agent(key),
      ensureSession: (key, starts) => this.ensureSession(this.agent(key), starts),
      typed: (key, input, write) => this.ownerTyped(key, input, write),
    });
    this.toolsMs = set.toolsMs;
    this.enterWaitMs = set.enterWaitMs;
    this.typingQuietMs = set.typingQuietMs;
    this.leftInputs = new LeftInputs(frame => opts.send(frame), set.keptWaitMs);
    this.wordsQuietMs = set.wordsQuietMs;
    this.lookMs = opts.lookMs ?? LOOK_MS;
    this.reportMs = set.reportMs;
    this.cols = set.cols;
    this.rows = set.rows;
    this.operator = this.operatorFor(opts);
    this.operatorTimer = this.operatorTicks();
  }

  private async sensitiveTool(key: string, name: string, input: unknown, answer?: unknown, policy?: ToolPrivacyPolicy): Promise<void> {
    const agent = this.agents.get(key);
    if (!agent) return;
    await this.privacy.tool(agent.name, activeTurn(agent), name, input, answer, policy);
  }

  private operatorFor(opts: Options): OperatorRuntime | null {
    return opts.operator ? new OperatorRuntime(opts.operator, {
      current: key => this.operatorState(key), capture: key => this.operatorPane(key), inputLine: (key, cells) => this.operatorInputLine(key, cells), recovery: key => this.operatorRecovery(key), secrets: opts.secrets,
      facts: key => this.programFacts(key), press: (key, keys) => this.opts.tmux.keys(this.agents.get(key)!.name, ...keys), paste: (key, text) => this.opts.tmux.paste(this.agents.get(key)!.name, text),
    }) : null;
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
    return { runningTool: [...a.calls.values()].some(call => call.name !== 'AskUserQuestion'), retrying: Boolean(a.retry || a.restarting), wait };
  }

  private async operatorRecovery(key: string): Promise<{ alive: boolean; input: string | null; own: boolean; busy: boolean }> {
    const a = this.agents.get(key);
    if (!a?.program || !(await this.opts.tmux.alive(a.name))) return { alive: false, input: null, own: false, busy: false };
    const input = inputOf(a.program.kind, await this.opts.tmux.screen(a.name, 0, true));
    return { alive: true, input, own: Boolean(input) && this.ownWordsOnly(a, input!), busy: a.busy };
  }

  /* What the orchestrator and Operations see of an agent's program besides its screen: the turn, whether it works and on what,
     its question, what its input holds and whether Hornhoof's words wait to go in. */
  private async programFacts(key: string): Promise<ProgramFacts | null> {
    const a = this.agents.get(key);
    if (!a?.program || !a.instance || !(await this.opts.tmux.alive(a.name))) return null;
    this.drain(a);
    const turn = a.turn, instance = a.instance;
    const screen = await this.opts.tmux.screen(a.name, 0, true);
    const input = inputOf(a.program.kind, screen);
    const completion = await this.screenCompleted(a, screen);
    if (a.turn !== turn || a.instance !== instance) return null;
    return this.observedFacts(key, a, input, completion);
  }

  private observedFacts(key: string, a: Agent, input: string | null, completion: string | null): ProgramFacts {
    return { ...this.programIdentity(key, a), working: a.busy && !completion, ...(completion ? { completion } : {}), ...programAsks(a), input: inputShown(input, input !== null && this.ownWordsOnly(a, input)), undelivered: wordsUndelivered(a) };
  }

  private async screenCompleted(a: Agent, screen: string): Promise<string | null> {
    const program = a.program;
    if (!program || this.completionBlocked(a)) return null;
    const output = await this.completionOutput(a, program.kind);
    if (a.program !== program || this.completionBlocked(a)) return null;
    if (output === null) return null;
    const text = completionText(program.kind, screen, output);
    return text ? createHmac('sha256', this.completionKey).update(JSON.stringify([a.key, a.instance, text])).digest('hex') : null;
  }

  private async completionOutput(a: Agent, kind: TermProgram['kind']): Promise<string | null> {
    if (kind !== 'kimi') return '';
    const start = a.completionStart, cursor = await start;
    if (!cursor || a.completionStart !== start) return null;
    return this.opts.tmux.programOutput(a.name, cursor);
  }

  private completionBlocked(a: Agent): boolean {
    return !a.took || a.typing != null || Boolean(a.calls.size || a.question || a.operatorQuestion || a.retry || a.restarting);
  }

  /* The program by the identity the server knows it by, so that a look binds the input to the program it showed. */
  private programIdentity(key: string, a: Agent): Pick<ProgramFacts, 'jobId' | 'instance'> {
    return { jobId: a.turn?.jobId ?? null, instance: this.operator!.identity(key)?.instance ?? a.instance! };
  }

  /* The input holds nothing but Hornhoof's own words that never went, and nobody pressed a key since they went in. */
  private ownWordsOnly(a: Agent, input: string): boolean {
    return !this.stillTyping(a) && isOwnLeft(untakenOwn(a), a.typedAt, input);
  }

  private async operatorPane(key: string): Promise<{ cols: number; rows: number; cells: string }> {
    const a = this.agents.get(key); if (!a) throw new Error('The agent program is absent.');
    const [size, cells] = await Promise.all([this.opts.tmux.run(['display-message', '-p', '-t', a.name, '#{pane_width} #{pane_height}']), this.opts.tmux.screen(a.name, 0, true)]);
    const [cols, rows] = size.trim().split(/\s+/).map(Number);
    if (!cols || !rows) throw new Error('The existing pane size is unknown.');
    return { cols, rows, cells: this.opts.tmux.maskedScreen(a.name, cells) };
  }

  private operatorInputLine(key: string, cells: string): OperatorInputLine {
    const kind = this.agents.get(key)?.program?.kind;
    const input = kind ? inputOf(kind, cells) : null;
    if (input === null) return 'unknown';
    return input ? 'text' : 'empty';
  }

  private inputLane<T>(a: Agent, run: () => Promise<T>): Promise<T> { return this.operator?.serial(a.key, run) ?? run(); }

  /* What an agent's session runs changes one launch at a time. A window that opened the waiting screen as a turn started the
     program found no session, then replaced the program that had started meanwhile: the program went on outside its pane,
     where no hook of its own could prove it was the agent's any more. */
  private launching<T>(a: Agent, launch: () => Promise<T>): Promise<T> {
    const next = (this.launches.get(a.key) ?? Promise.resolve()).then(launch);
    this.launches.set(a.key, next.catch(() => {}));
    return next;
  }

  private intentional(a: Agent, why: Parameters<OperatorRuntime['intentional']>[1]): void { this.operator?.intentional(a.key, why); }

  private operatorEnabled(a: Agent): boolean { return Boolean(this.operator?.enabled(a.key)); }

  /* A start the node could not prove came from the program, as when a busy node checks its caller after the caller gave up,
     still says the program started: Hornhoof's prompt then waits only for its input to show, and nothing it carries is
     taken. Otherwise no turn would ever type into that program. */
  private unownedHook(key: string, event: string): void {
    if (event === 'start') this.agents.get(key)?.started?.resolve();
  }

  private hookRejected(key: string | null, event: string, reason: string): void {
    this.logHookRejection(key, event, reason);
    this.reportHookRejection(key, event, reason);
  }

  private logHookRejection(key: string | null, event: string, reason: string): void {
    (this.opts.log ?? console.log)(`Hook ${event} rejected: ${reason}${key ? ` (agent ${key})` : ''}`);
  }

  private reportHookRejection(key: string | null, event: string, reason: string): void {
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
  private async panes(key: string, signal?: AbortSignal): Promise<number[]> {
    signal?.throwIfAborted();
    const command = ['list-panes', '-s', '-t', `=${this.agent(key).name}`, '-F', '#{pane_pid}'];
    const lookup = () => this.opts.tmux.run(command, undefined, signal);
    const out = await lookup().catch(() => {
      signal?.throwIfAborted();
      return lookup();
    });
    return out.split('\n').filter(line => /^\d+$/.test(line)).map(Number);
  }

  async screen(key: string): Promise<string> {
    const agent = this.agent(key);
    return this.opts.tmux.maskedScreen(agent.name, await this.opts.tmux.screen(agent.name));
  }

  private agent(key: string): Agent {
    let a = this.agents.get(key);
    if (!a) {
      a = { key, name: `a-${key}`, program: null, signedOut: null, home: '', workDir: '', contextDir: '', hash: null, sessionId: null, cleared: new Set(), left: new Set(), blank: null, tail: null, draining: false, oldLogs: null, startedAt: 0, started: null, ended: null, turn: null, busy: false, limits: null, contextUsed: null, contextSize: null, up: false, watch: null, saying: Promise.resolve(), waitingWords: [], enqueuedWords: [], unheardTimers: new Map(), dequeued: false, queue: Promise.resolve(), unopened: [], stopped: false, failure: null, lastText: null, stepSaid: false, settling: null, fresh: false, starting: null, keep: null, agyRead: null, tally: new TurnTally(), agyAnswered: false, agyCursor: null, completionStart: null, interruptions: 0, calls: new Map(), closedCalls: new Set(), question: null, ends: new TurnEnds(), signAt: 0, retry: null, apiError: null, restarting: false, launch: null, programTurnId: undefined, instance: null, queuedTurns: 0, sinceRun: new Set(), leaving: null, tryingToLeave: false, asleep: false, tryingToSleep: false };
      this.agents.set(key, a);
    }
    return a;
  }

  /* Hornhoof's turns for one agent run one after another. */
  run(job: TermJob): Promise<RunResult> {
    const a = this.agent(job.key);
    this.turnComes(a, job);
    const result = a.queue.then(() => this.turnIn(a, job)).finally(() => { a.queuedTurns--; });
    a.queue = result.catch(() => {});
    return result;
  }

  /* A turn sent here means the agent works here: the program it left, if it did, stays. */
  private turnComes(a: Agent, { input: { jobId } }: TermJob): void {
    a.queuedTurns++;
    a.leaving = null;
    a.sinceRun = new Set(jobId ? [jobId] : []);
  }

  private async turnIn(a: Agent, job: TermJob): Promise<RunResult> {
    /* Clear words left in the input by a failed live delivery before this turn pastes its prompt. */
    await a.saying;
    const { input } = job;
    /* A turn a person typed may still run, or wait for the rest of its log; Hornhoof's turn goes in after it, or into it
       once the time Hornhoof gave this turn is over. Nothing stops the program: only its own end or a person does. */
    await this.waitForTurn(a, job);
    if (input.signal?.aborted) return this.failedTurn(a, job, 'cancelled');
    a.signedOut = job.signedOut;
    const launch = await this.launchFor(a, job).catch((err: unknown) => { throw new ProgramNotStarted(err); });
    if (input.signal?.aborted) return this.failedTurn(a, job, 'cancelled');
    this.toolsLost(a, job);
    const goesOn = await this.goesOn(a, job, launch.hash);
    if (!goesOn && (await this.asksPerson(a))) return this.leftAsking(a, job);
    const typed = this.wordsOf(a, job, goesOn);
    a.launch = { job: typed, spec: launch.spec };
    return this.turnOn(a, typed, launch, goesOn);
  }

  /* An assistant's program sends its whole conversation along with its words. The turn types the conversation in their
     place into a session that starts anew: a new one the program starts, or the one a person's clear began, which keeps
     waiting for it through turns that bring none. */
  private wordsOf(a: Agent, job: TermJob, goesOn: boolean): TermJob {
    const { input, freshPrompt } = job;
    if (!freshPrompt || !input.prompt) return job;
    const session = goesOn ? a.sessionId : input.sessionId;
    if (input.sessionId !== null && (session === null || session !== a.blank)) return job;
    a.blank = null;
    return { ...job, input: { ...input, prompt: freshPrompt }, sent: input.prompt };
  }

  /* A program turned away as it connected to its tools has none for the rest of its session, so it starts again in that
     session for this turn, which says so. */
  private toolsLost(a: Agent, job: TermJob): void {
    if (!connectsAtStart(job) || !this.bridge.toolsRefusedSince(job.key, a.startedAt)) return;
    a.hash = null;
    this.log(`Agent ${job.key} (${job.program.kind}) ${TOOLS_LOST}`);
    job.input.onEvent?.({ kind: 'text', text: `This agent ${TOOLS_LOST}` });
  }

  /* How this turn would start its program, in folders ready for it. */
  private async launchFor(a: Agent, job: TermJob): Promise<TurnLaunch> {
    const { input, program } = job;
    await this.fs.mkdir(input.workDir);
    const urls = this.bridge.agent(job.key);
    const instructions = await this.writeInstructions(job);
    const spec = program.launch({ bin: job.bin, home: job.home, workDir: input.workDir, sessionId: input.sessionId, model: input.model, effort: input.effort, compactWindow: input.compactWindow, ...instructions, urls });
    return { spec, urls, hash: await this.versionedHash(a, job, spec) };
  }

  private async turnOn(a: Agent, job: TermJob, launch: TurnLaunch, goesOn: boolean): Promise<RunResult> {
    /* A program started with nothing to type gets its tools before its turn ends, while Hornhoof still answers for them.
       Kimi Code connects to its tools only once it has a session, which a new one gets with the first message, and
       Antigravity only once it takes a message or opens its MCP panel. */
    const tools = initialToolsNeeded(job, goesOn) ? this.bridge.listed(job.key, this.toolsMs) : null;
    const { turn, starting } = this.opensTurn(a, job, goesOn, tools);
    try {
      const failed = goesOn ? null : await this.startAnew(a, job, launch);
      if (failed) return failed;
      const done = await this.runRequested(a, job, turn, tools, goesOn, a.ended!);
      if (!goesOn && !tools && done.ok) await this.toolsConnected(a, job);
      return { ...done, privateValues: turn.privacy?.values };
    } finally {
      this.closesTurn(a, job, turn, starting);
    }
  }

  /* Claude Code and Codex connect to their tools on their own time after they start, and one that connects with no turn
     open gets an error and no tools for the rest of its session. So the turn that started one and typed its prompt ends
     once the program has listed its tools, or once toolsMs have passed after the program's own end of the turn. A program
     gone or a turn stopped meanwhile waits no longer. */
  private async toolsConnected(a: Agent, job: TermJob): Promise<void> {
    if (!connectsAtStart(job)) return;
    const over = this.bridge.listed(job.key, this.toolsMs, a.startedAt).then(() => true);
    while (!job.input.signal?.aborted && (await this.opts.tmux.alive(a.name))) {
      if (await Promise.race([over, sleep(this.pollMs).then(() => false)])) return;
    }
  }

  private opensTurn(a: Agent, job: TermJob, goesOn: boolean, tools: Promise<unknown> | null): { turn: Turn; starting: Promise<unknown> | null } {
    const { input } = job;
    /* What is left in the log from before belongs to no turn. */
    this.drain(a);
    a.lastText = null;
    a.stepSaid = false;
    this.beginTurn(a);
    this.operatorBegins(a, job, goesOn);
    this.bridge.setToken(job.key, input.tools?.token ?? null);
    const starting = input.prompt ? null : (tools ?? Promise.resolve());
    const turn = requestedTurn(job, this.requestedWords(a, job), starting !== null);
    turn.privacy = this.privacy.fresh(a.name);
    if (starting) a.starting = starting;
    a.turn = turn;
    a.ended = deferred();
    a.stopped = false;
    a.failure = null;
    return { turn, starting };
  }

  private operatorBegins(a: Agent, { input, operatorDelivery, operatorSourceDelivery, sent }: TermJob, goesOn: boolean): void {
    this.operator?.begin(a.key, input.jobId ?? null, operatorDelivery, sent ?? input.prompt, goesOn, operatorSourceDelivery);
    input.signal?.addEventListener('abort', () => this.operator?.intentional(a.key, 'cancelled'), { once: true });
  }

  private closesTurn(a: Agent, job: TermJob, turn: Turn, starting: Promise<unknown> | null): void {
    this.endWords(a, turn);
    this.retainAssignment(a, job, turn.words);
    a.typing = null;
    if (starting && a.starting === starting) a.starting = null;
    if (a.turn === turn) {
      this.bridge.setToken(job.key, null);
      a.turn = null;
      a.ended = null;
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
    const missing = await this.toolsMissing(a, job);
    if (missing) return missing;
    if (job.program.kind === 'kimi') a.completionStart = this.opts.tmux.programCursor(a.name).catch(() => null);
    return (await this.typePrompt(a, job, job.input.prompt)) ?? this.turnEnd(a, job, ended, turn);
  }

  /* agy 1.4.12 connects to the MCP servers of its folder only once it takes its first input or opens its /mcp panel, and
     the turn whose input made it connect works without their tools. So an agy that has not listed
     Hornhoof's tools through the bridge since it started opens that panel before Hornhoof's prompt goes in, whether this
     turn started it or a person's window did. A turn whose agy lists none there, or does not come back to its prompt,
     ends saying so. */
  private async toolsMissing(a: Agent, job: TermJob): Promise<RunResult | null> {
    if (!needsTools(job) || this.bridge.listedSince(job.key, a.startedAt)) return null;
    await this.freeInput(a, job);
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
    /* Words still in its input stay for the next turn to keep: a program started anew would lose them. */
    if (missed && !(missed === 'waits' && (await this.readInput(a)))) a.hash = null;
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
    for (const end = Date.now() + this.toolsMs; !signal?.aborted && (await this.opts.tmux.alive(a.name)); await sleep(this.pollMs)) {
      const late = Date.now() >= end;
      if (shows(await this.opts.tmux.screen(a.name, 0, true))) {
        await sleep(settleMs);
        return true;
      }
      if (late) return false;
    }
    return false;
  }

  private async waitForTurn(a: Agent, job: TermJob): Promise<void> {
    return job.program.kind === 'antigravity' ? this.waitForAgyTurn(a, job) : this.waitTimedTurn(a, job);
  }

  /* While the program works on something of its own or of a person's, Hornhoof hears what it does under this turn's job. A
     look that is slow to come back holds no wait: its end, deadline and stop still decide when the turn goes in. */
  private async waitTimedTurn(a: Agent, job: TermJob): Promise<void> {
    const deadline = Date.now() + job.input.timeoutMs;
    const { watch, look } = this.observeProgram(a, job.input.jobId);
    for (this.drain(a); a.busy && !job.input.signal?.aborted && Date.now() < deadline; this.drain(a)) {
      await Promise.race([this.reportProgram(a, watch, look), sleep(this.pollMs)]);
      await sleep(this.pollMs);
    }
    await a.settling;
    await a.cancelling;
  }

  private async waitForAgyTurn(a: Agent, job: TermJob): Promise<void> {
    const { watch, look } = this.observeProgram(a, job.input.jobId);
    this.drain(a);
    while (a.busy && !job.input.signal?.aborted) {
      if (!(await this.opts.tmux.alive(a.name))) break;
      await this.reportProgram(a, watch, look);
      await sleep(this.pollMs);
      this.drain(a);
    }
    await a.settling;
    await a.cancelling;
  }

  /* What the agent is told before its turn. The conversation from before reaches a program that starts now; it is not part
     of its instructions' hash. Claude Code keeps only what was said in its log, so what a new session was told from before
     goes with it to every resume. So it does for Kimi Code, which may read AGENTS.md afresh for a session it resumes. */
  private async toldOf({ program, input }: TermJob): Promise<string> {
    const kept = program.kind !== 'codex' && input.sessionId ? await keptContext(this.fs, input.workDir, input.sessionId) : null;
    const context = kept && input.context && !kept.includes(input.context) ? `${kept}\n\n${input.context}` : (kept ?? input.context);
    return [input.instructions, context].filter(Boolean).join('\n\n');
  }

  /* Claude Code reads what it is told from the file it starts with, which this returns. Codex, Kimi Code and Antigravity
     read a file of their folder for it, each its own in a task's folder, agy only its start. */
  private async writeInstructions(job: TermJob): Promise<{ instructionsFile: string | null; instructionsBytes?: number }> {
    const told = await this.toldOf(job);
    const whole = join(job.input.workDir, '.hh-instructions.md');
    if (!told) return { instructionsFile: null };
    if (job.program.kind === 'claude') {
      await this.fs.write(whole, told + '\n');
      return { instructionsFile: whole };
    }
    const place = toldPlace(job.program.kind, job.input);
    const { rules, whole: all } = job.program.kind === 'antigravity' ? agyRules(told, whole, Buffer.byteLength(place.head)) : { rules: told, whole: null };
    if (all) await this.fs.write(whole, all + '\n');
    await this.fs.mkdir(dirname(place.file));
    const instructions = place.head + rules + '\n';
    await this.fs.write(place.file, instructions);
    return { instructionsFile: null, instructionsBytes: Buffer.byteLength(instructions) };
  }

  /* The program runs as this turn would start it, in the session it asks for. A new session asked for goes on in a program
     started for a person that nothing was said in yet. A continuation of words a program took has nothing to type, so nothing to
     start a program for, whatever session its owner's words moved it to meanwhile. */
  private async goesOn(a: Agent, { input: { sessionId }, operatorSourceDelivery }: TermJob, hash: string): Promise<boolean> {
    const sameSession = sessionId === null ? a.fresh : sessionId === a.sessionId || a.cleared.has(sessionId);
    return (sameSession || Boolean(this.operator?.sourceRecorded(operatorSourceDelivery))) && a.hash === hash && (await this.opts.tmux.alive(a.name));
  }

  /* The program that goes takes its input with it, so it goes only once that holds nothing of anyone's. */
  private async startAnew(a: Agent, job: TermJob, { spec, hash, urls }: TurnLaunch): Promise<RunResult | null> {
    const free = !typedSinceStart(a) || !(await this.opts.tmux.alive(a.name)) || (await this.freeOfPerson(a, job));
    return free ? this.startProgram(a, job, spec, hash, urls) : this.inputNotFree(a, job);
  }

  /* A question goes with its program, so one that asks a person while it works stays for them to answer. A question of a
     program that is done with its turn was left behind. */
  private async asksPerson(a: Agent): Promise<boolean> {
    return Boolean(a.question && a.busy) && (await this.opts.tmux.alive(a.name));
  }

  private leftAsking(a: Agent, job: TermJob): Promise<RunResult> {
    a.failure = failure('unknown', 'The program is asking a person, so Hornhoof did not start it anew.', true);
    return this.failedTurn(a, job, 'agent_failed');
  }

  /* Its input holds nothing of anyone's, and what a person sent while this turn waited got its answer from the program it
     went to. Another word may then be there. A prompt typed before that answer would wait in the program's queue, and the
     program would take it when the person's words seem answered and no turn runs: as words of a person's own. */
  private freeOfPerson(a: Agent, job: TermJob): Promise<boolean> {
    return this.whilePromptWaits(a, async () => {
      for (;;) {
        if (!(await this.inputFree(a, job))) return false;
        if (!a.personWords || !a.busy || job.input.signal?.aborted) return true;
        await this.waitForTurn(a, job);
      }
    });
  }

  /* Starts the program for the turn. One that never shows it is ready ends the turn with its screen, which says why. */
  private async startProgram(a: Agent, job: TermJob, spec: LaunchSpec, hash: string, urls: AgentUrls): Promise<RunResult | null> {
    this.programIs(a, false);
    try {
      await this.prepareLaunch(a, job, spec, hash, urls);
      await this.launchAttempt(a, job, spec);
    } catch (err) {
      /* Nothing of the program ran: the turn ends before it started. */
      throw new ProgramNotStarted(err);
    }
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
    if (a.sessionId) a.left.add(a.sessionId);
    Object.assign(a, { ...startedState(job, spec), hash, instance: randomUUID() });
    if (job.program.kind === 'claude' && !job.input.sessionId) await this.keepNew(job.input, spec.sessionId);
    a.tail = this.tailFor(a);
  }

  private async launchAttempt(a: Agent, job: TermJob, spec: LaunchSpec): Promise<void> {
    const env = { ...(await this.testShare(a)), ...lasting(job.input.env), ...spec.env };
    const scratch = this.opts.tmux.scratch();
    this.operator?.launch(a.key, 'attempt');
    try {
      await this.inputLane(a, () => this.launching(a, () => this.opts.tmux.launch(a.name, { cwd: job.input.workDir, command: this.asAgent(spec.command), cols: this.cols, rows: this.rows, envFile: envFile(scratch, env), outputDir: scratch })));
      this.operator?.launch(a.key, 'started');
    } catch (error) {
      this.operator?.launch(a.key, 'failed');
      this.operator?.exited(a.key, { code: null, signal: null });
      throw error;
    }
  }

  /* The Vitest workers of the program's share of the machine among the programs that run on the node, itself among them,
     for its tests and its helpers' tests. Workers the machine's own settings give stay. */
  private async testShare(a: Agent): Promise<Record<string, string>> {
    if ((this.opts.env ?? process.env).VITEST_MAX_WORKERS?.trim()) return {};
    const others = (await this.opts.tmux.livePrograms()).filter(key => key !== a.key);
    return { VITEST_MAX_WORKERS: String(programWorkers((this.opts.machine ?? machineLoad)(), others.length + 1)) };
  }

  private async failedStart(a: Agent, job: TermJob): Promise<RunResult> {
    if (job.input.signal?.aborted) return this.failedTurn(a, job, 'cancelled');
    const screen = await this.screen(job.key);
    /* Its screen says why, which the loader would hide. */
    this.viewSessions.program(a.key);
    const shown = await this.shownNow(a);
    await this.whyNotReady(a, job, shown);
    return await this.failedTurn(a, job, !this.operator?.failure(a.key) && job.signedOut.test(shown) ? 'not_logged_in' : 'agent_failed', screen);
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
     Antigravity, reaches its tools a moment before Hornhoof opens their turn. Claude Code or Codex may still connect
     after a turn called off as it started them, and the next turn opens soon after. */
  private async prepare({ key, home, program, input }: TermJob, urls: AgentUrls): Promise<void> {
    if (program.kind === 'claude') await acceptClaudeDialogs(home, input.workDir, this.fs);
    if (program.kind === 'claude') await writeClaudeTools(input.workDir, urls.mcpUrl, this.fs);
    if (program.kind === 'kimi') await prepareKimi(home, input.workDir, urls.mcpUrl, this.fs);
    if (program.kind === 'antigravity') await prepareAgy(input.workDir, urls.mcpUrl, this.fs);
    this.bridge.waitForTurns(key, program.kind === 'kimi' || program.kind === 'antigravity' ? this.openMs + 2000 : this.toolsMs);
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
    return job.operatorDelivery && this.operatorEnabled(a) ? this.typeOperatorPrompt(a, job, prompt) : this.typeUnmanagedPrompt(a, job, prompt);
  }

  private typeUnmanagedPrompt(a: Agent, job: TermJob, prompt: string): Promise<RunResult | null> {
    return job.program.kind === 'antigravity' ? this.typeAgyPrompt(a, job, prompt) : this.typePlainPrompt(a, job, prompt);
  }

  private async typePlainPrompt(a: Agent, job: TermJob, prompt: string): Promise<RunResult | null> {
    a.fresh = false;
    a.took = false;
    a.typing = prompt;
    if (typedSinceStart(a) && !(await this.freeOfPerson(a, job))) return this.inputNotFree(a, job);
    a.ownerTyped = false;
    await this.opts.tmux.paste(a.name, prompt);
    await sleep(pasteWait(prompt));
    await this.opts.tmux.keys(a.name, 'Enter');
    /* On a busy machine the program can take the prompt, and even end its turn, before the key is back: it then said so
       itself, and its turn's end must not be taken back. */
    if (!a.took) a.busy = true;
    const lost = new LostWords(prompt, { enterMs: this.enterWaitMs, quietMs: this.wordsQuietMs }, Date.now());
    for (const end = Date.now() + this.readyMs; !(await this.tookPrompt(a, job.input.signal)); await this.pressPlainAgain(a, job, prompt, lost)) {
      if (Date.now() < end) continue;
      this.drain(a);
      if (a.took) break;
      a.busy = false;
      /* Its input still holds the prompt, so the next turn starts the program anew, resuming the session. */
      a.hash = null;
      const why = `The program did not take Hornhoof's prompt within ${Math.round(this.readyMs / 1000)} s.`;
      a.failure = failure('unknown', why, true);
      return await this.failedTurn(a, job, 'agent_failed', `${why}\n\n${await this.screen(job.key)}`);
    }
    return null;
  }

  /* With no receipt the words may be gone or still in the input, and an Enter does no harm: it goes every time, and the words
     again once the program lost them. */
  private async pressPlainAgain(a: Agent, job: TermJob, prompt: string, lost: LostWords): Promise<void> {
    const gone = !a.ownerTyped && lost.step(job.program.kind, await this.opts.tmux.screen(a.name, 0, true), Date.now()) === 'type';
    if (gone) { await this.opts.tmux.paste(a.name, prompt); await sleep(pasteWait(prompt)); }
    await this.opts.tmux.keys(a.name, 'Enter');
  }

  /* agy queues input as another turn. Wait for its idle footer before pasting, keep the prompt until invocation 0,
     and report throughout the wait. A busy program has no delivery deadline and is never interrupted. */
  private async typeAgyPrompt(a: Agent, job: TermJob, prompt: string): Promise<RunResult | null> {
    a.fresh = false;
    a.took = false;
    a.typing = prompt;
    a.turn!.observed = this.observeProgram(a, job.input.jobId);
    const failed = await this.whilePromptWaits(a, () => this.pasteAgyPrompt(a, job, prompt));
    return failed ?? this.waitAgyReceipt(a, job, prompt);
  }

  private async waitAgyInput(a: Agent, job: TermJob): Promise<RunResult | null> {
    for (;;) {
      const failed = await this.agyDeliveryStopped(a, job);
      if (failed) return failed;
      if (this.agyReceiptTaken(a) || agyAtPrompt(await this.opts.tmux.screen(a.name, 0, true))) return null;
      await sleep(this.pollMs);
    }
  }

  private async pasteAgyPrompt(a: Agent, job: TermJob, prompt: string): Promise<RunResult | null> {
    let pasted = false;
    while (!pasted) {
      const failed = await this.waitAgyInput(a, job);
      if (failed) return failed;
      await this.keepLeftInput(a, job);
      await this.personHeard(a, job);
      pasted = await this.inputLane(a, () => this.pasteAgyAssignment(a, job, prompt));
      if (!pasted) await sleep(this.pollMs);
    }
    return null;
  }

  private async pasteAgyAssignment(a: Agent, job: TermJob, prompt: string): Promise<boolean> {
    const screen = await this.opts.tmux.screen(a.name, 0, true);
    this.drain(a);
    if (job.input.signal?.aborted) return false;
    if (this.operator?.inheritSource(a.key, job.operatorSourceDelivery) || this.agyReceiptTaken(a)) return true;
    return agyAtPrompt(screen) && (await this.inputCleared(a, job, inputOf('antigravity', screen)!)) && this.submitAgyAssignment(a, job, prompt);
  }

  private async submitAgyAssignment(a: Agent, job: TermJob, prompt: string): Promise<boolean> {
    this.drain(a);
    if (job.input.signal?.aborted) return false;
    return this.agyReceiptTaken(a) || this.submitOperatorAssignment(a, job, prompt);
  }

  private agyReceiptTaken(a: Agent): boolean {
    return Boolean(a.took || a.turn?.ending || this.operator?.recorded(a.key));
  }

  private async agyDeliveryStopped(a: Agent, job: TermJob): Promise<RunResult | null> {
    this.drain(a);
    if (job.input.signal?.aborted) return this.failedTurn(a, job, 'cancelled');
    const observed = a.turn!.observed!;
    if (!(await this.opts.tmux.alive(a.name))) return this.programGone(a, job, observed.watch);
    await this.reportProgram(a, observed.watch, observed.look);
    if (this.operator?.inheritSource(a.key, job.operatorSourceDelivery) && !a.busy) return this.failedTurn(a, job, 'cancelled');
    return this.operatorReceiptFailure(a, job);
  }

  private async waitAgyReceipt(a: Agent, job: TermJob, prompt: string): Promise<RunResult | null> {
    let enteredAt = Date.now();
    while (!this.agyReceiptTaken(a)) {
      const failed = await this.agyDeliveryStopped(a, job);
      if (failed) return failed;
      if (Date.now() - enteredAt >= this.enterWaitMs) {
        await this.inputLane(a, () => this.retryAgyEnter(a, prompt, job.input.signal));
        enteredAt = Date.now();
      }
      await sleep(this.pollMs);
    }
    return null;
  }

  private async retryAgyEnter(a: Agent, prompt: string, signal?: AbortSignal): Promise<void> {
    const turn = a.turn;
    const screen = await this.opts.tmux.screen(a.name, 0, true);
    this.drain(a);
    if (signal?.aborted || a.turn !== turn) return;
    /* Retry only the exact prompt still visible at idle, never a queued message or a person's draft. */
    if (!this.agyReceiptTaken(a) && READY.antigravity(screen) && flat(inputOf('antigravity', screen) ?? '') === flat(prompt)) await this.opts.tmux.keys(a.name, 'Enter');
  }

  private async typeOperatorPrompt(a: Agent, job: TermJob, prompt: string): Promise<RunResult | null> {
    if (this.operator?.inheritSource(a.key, job.operatorSourceDelivery)) return a.busy ? null : this.failedTurn(a, job, 'cancelled');
    if (this.operator?.recorded(a.key)) return null;
    return job.program.kind === 'antigravity' ? this.typeAgyPrompt(a, job, prompt) : this.deliverOperatorPrompt(a, job, prompt);
  }

  private async deliverOperatorPrompt(a: Agent, job: TermJob, prompt: string): Promise<RunResult | null> {
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

  private pasteOperatorPrompt(a: Agent, job: TermJob, prompt: string): Promise<RunResult | null> {
    return this.whilePromptWaits(a, () => this.pasteWhenInputFree(a, job, prompt));
  }

  private async pasteWhenInputFree(a: Agent, job: TermJob, prompt: string): Promise<RunResult | null> {
    let pasted = false;
    while (this.operatorPastePending(a, pasted)) {
      if (!(await this.ready(a, job))) {
        await this.whyNotReady(a, job, await this.shownNow(a));
        return this.failedTurn(a, job, job.input.signal?.aborted ? 'cancelled' : 'agent_failed');
      }
      await this.keepLeftInput(a, job);
      await this.personHeard(a, job);
      pasted = await this.inputLane(a, () => this.pasteOperatorAssignment(a, job, prompt));
      if (!pasted) await sleep(this.pollMs);
    }
    return null;
  }

  private async pasteOperatorAssignment(a: Agent, job: TermJob, prompt: string): Promise<boolean> {
    const screen = await this.opts.tmux.screen(a.name, 0, true);
    this.drain(a);
    if (this.operator?.inheritSource(a.key, job.operatorSourceDelivery)) return false;
    const input = inputOf(job.program.kind, screen);
    if (!this.operatorMayType(a, job) || input === null || !(await this.inputCleared(a, job, input))) return false;
    this.drain(a);
    return this.operatorMayType(a, job) && this.submitOperatorAssignment(a, job, prompt);
  }

  private async submitOperatorAssignment(a: Agent, job: TermJob, prompt: string): Promise<boolean> {
    this.operator?.typed(a.key);
    a.pastedAt = Date.now();
    /* On a busy machine the program can tell of the prompt before the key is back. */
    a.promptWaits = false;
    await this.opts.tmux.paste(a.name, prompt);
    await sleep(pasteWait(prompt));
    if (!job.input.signal?.aborted) await this.opts.tmux.keys(a.name, 'Enter');
    return true;
  }

  private operatorMayType(a: Agent, job: TermJob): boolean {
    return !job.input.signal?.aborted && !a.took && !this.operator?.recorded(a.key);
  }

  private stillTyping(a: Agent): boolean {
    return Date.now() - (a.typedAt ?? -Infinity) < this.typingQuietMs;
  }

  /* Words someone left go to Hornhoof before they leave the input. Not in the input lane, as the owner's keys go through it.
     A paste the program folded is not on its screen to keep, so it stays, and the turn's watch tells of it. */
  private async keepLeftInput(a: Agent, job: TermJob): Promise<void> {
    const input = await this.readInput(a);
    if (!input || !this.leftByOthers(a, input)) return;
    const jobId = job.input.jobId ?? null;
    const whole = await this.wholeInput(a, input);
    const text = cut(redact(this.opts.tmux.outputValues(a.name).text(whole), this.secretsOf(job)), 100_000);
    await this.leftInputs.keep({ agentKey: a.key, jobId, text, typed: (a.typedAt ?? -Infinity) > (a.pastedAt ?? -Infinity), ref: leftRef(jobId, input) });
  }

  private leftByOthers(a: Agent, input: string): boolean {
    return !this.stillTyping(a) && !this.ownInInput(a, input) && !holdsFoldedPaste(input);
  }

  /* What the input holds is Hornhoof's own words: a prompt never taken, or a copy of one taken. */
  private ownInInput(a: Agent, input: string): boolean {
    return isOwnLeft(a.ownLeft, a.typedAt, input) || isOwnLeft(a.ownCopy, a.typedAt, input);
  }

  private secretsOf(job: TermJob): string[] {
    return [...this.opts.secrets(), ...(job.input.tools?.token ? [job.input.tools.token] : [])];
  }

  /* Words too long for the screen go on above it. */
  private async wholeInput(a: Agent, input: string): Promise<string> {
    const whole = inputOf(a.program!.kind, await this.opts.tmux.screen(a.name, 5000, true));
    return whole && flat(whole).includes(flat(input)) ? whole : input;
  }

  /* An input that holds nothing, or only what is safe elsewhere, which then goes. It takes no Escape, which stops a program. */
  private async inputCleared(a: Agent, job: TermJob, input: string): Promise<boolean> {
    if (!input) return true;
    const own = isOwnLeft(a.ownLeft, a.typedAt, input), copy = isOwnLeft(a.ownCopy, a.typedAt, input);
    if (this.stillTyping(a) || !(own || copy || this.leftInputs.isKept(leftRef(job.input.jobId ?? null, input)))) return false;
    if (!(await this.eraseLeft(a))) return false;
    if (own) this.forgetOwnLeft(a);
    if (copy) a.ownCopy = null;
    return true;
  }

  private async eraseLeft(a: Agent): Promise<boolean> {
    for (let round = 0; round < ERASE_ROUNDS; round++) {
      const input = await this.readInput(a);
      if (!input) return input === '';
      /* The cursor may stand inside the words: the first keys then leave what follows it. */
      await this.opts.tmux.keys(a.name, ...(round ? ['C-k'] : []), ...eraseKeys(input));
      await sleep(this.pollMs);
    }
    return (await this.readInput(a)) === '';
  }

  private forgetOwnLeft(a: Agent): void {
    const jobId = a.ownLeft?.jobId;
    a.ownLeft = null;
    a.retainedAssignments = a.retainedAssignments?.filter(retained => retained.jobId !== jobId);
  }

  /* For a path with no watch to tell of words it cannot move: they are kept and gone in the time a program has to get
     ready, as a person may still be writing them, or the turn ends saying so. */
  private freeInput(a: Agent, job: TermJob): Promise<boolean> {
    return this.whilePromptWaits(a, () => this.inputFree(a, job));
  }

  private async inputFree(a: Agent, job: TermJob): Promise<boolean> {
    for (const end = Date.now() + this.readyMs; !job.input.signal?.aborted; await sleep(this.pollMs)) {
      await this.keepLeftInput(a, job);
      const input = await this.readInput(a);
      if (!input) return this.personHeard(a, job);
      if (await this.inputLane(a, () => this.inputCleared(a, job, input))) return true;
      if (Date.now() >= end) return false;
    }
    return false;
  }

  /* Whether the input may go with its program as it is: it holds nothing of a person's, or only what Hornhoof says it has. */
  private async inputMayGo(a: Agent, job: TermJob): Promise<boolean> {
    if (!typedSinceStart(a)) return true;
    await this.keepLeftInput(a, job);
    const input = await this.readInput(a);
    return !input || this.ownInInput(a, input) || this.leftInputs.isKept(leftRef(job.input.jobId ?? null, input));
  }

  private async whilePromptWaits<T>(a: Agent, work: () => Promise<T>): Promise<T> {
    a.promptWaits = true;
    try {
      return await work();
    } finally {
      a.promptWaits = false;
    }
  }

  /* An Enter pressed in this turn is told of before the prompt it may have sent is. The turn's own prompt goes in after. */
  private async personHeard(a: Agent, job: TermJob): Promise<true> {
    for (const end = Date.now() + this.enterWaitMs; a.pressed && a.pressed.jobId === job.input.jobId && Date.now() < end; await sleep(this.pollMs)) this.drain(a);
    return true;
  }

  /* Whether a prompt the program tells of is what a person sent while this turn's prompt waited. A busy machine can tell
     of it once that prompt began to go in: it is still theirs when it is not that prompt and came of their Enter in this
     turn, told of by no channel yet or by another one first. What it is decides, not when the node hears of it. */
  private personsPrompt(a: Agent, prompt?: string): boolean {
    if (a.promptWaits) return true;
    return prompt !== undefined && a.typing != null && !a.took && this.personPressed(a) && !typedPrompt(prompt, a.typing);
  }

  private personPressed(a: Agent): boolean {
    return Boolean(a.personWords) || (a.pressed != null && a.pressed.jobId === a.turn?.jobId);
  }

  /* What a person sent while this turn's prompt waited to go in is theirs, in this turn as Hornhoof knows from their Enter.
     It does not take the prompt's place, and its end does not end the turn. */
  private personSent(a: Agent): void {
    a.personWords = true;
    a.pressed = null;
    a.busy = true;
    /* This turn's prompt has not gone in: what took was true of is the turn before. */
    a.took = false;
  }

  private endsNoTurn(a: Agent): boolean {
    return a.restarting || this.personWordsAnswered(a);
  }

  /* However the answer to a person's words ends, a stop of their own or a failure too, it is theirs: the turn's prompt goes
     in after it. */
  private personWordsAnswered(a: Agent): boolean {
    if (!a.personWords || a.took) return false;
    a.personWords = false;
    a.unanswered = null;
    a.busy = false;
    return true;
  }

  private inputNotFree(a: Agent, job: TermJob): Promise<RunResult> {
    a.busy = false;
    a.failure = failure('unknown', "The program's input holds words Hornhoof could not keep, so it typed nothing into them.", true);
    return this.failedTurn(a, job, job.input.signal?.aborted ? 'cancelled' : 'agent_failed');
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
    this.ownCopyLeft(a, job, prompt, lost);
    return null;
  }

  /* A busy program can take the words and say so only after it stood still long enough for them to go in again. That copy
     stays in its input, where the next words would wait on it: it is Hornhoof's own, so it goes before they do. It is no
     words that never went, which whoever looks at the program would send. */
  private ownCopyLeft(a: Agent, job: TermJob, prompt: string, lost: LostWords): void {
    if (lost.typedAgain && !a.ownerTyped && !job.input.signal?.aborted) a.ownCopy = { text: prompt, jobId: job.input.jobId ?? null, at: a.pastedAt ?? -Infinity };
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
    if (why) {
      a.failure = failure('unknown', `Program operator recovery ended: ${why}.`, false);
      if (this.operator?.unrecordedEnded(a.key)) a.ownLeft = { text: job.input.prompt, jobId: job.input.jobId ?? null, at: a.pastedAt ?? -Infinity };
      return this.failedTurn(a, job, 'agent_failed');
    }
    if (!(await this.opts.tmux.alive(a.name))) return this.failedTurn(a, job, 'agent_failed');
    return null;
  }

  /* Waits for the turn to end: the program says so, a person stops it, or the program is gone. */
  private async turnEnd(a: Agent, job: TermJob, ended: Deferred<string>, turn: Turn): Promise<RunResult> {
    const { watch, look } = this.requestedObservation(a, turn, job);
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

  private requestedObservation(a: Agent, turn: Turn, job: TermJob): ObservedProgram {
    return turn.observed ?? this.observeProgram(a, job.input.jobId);
  }

  /* Both entry paths report the same program state. */
  private observeProgram(a: Agent, jobId: string | null | undefined): ObservedProgram {
    const values = this.opts.tmux.outputValues(a.name);
    return { watch: new ProgramWatch(jobId, m => this.opts.send(withSession(m, this.sessionToTell(a))), this.reportMs, this.opts.secrets, values), look: { at: Date.now(), call: null } };
  }

  /* After a restart Hornhoof asks the node to go on in the session it heard of, and a node goes on only in one it remembers:
     a turn its restart cut never told it by ending. A session with no log yet has nothing to go on from, so the turn starts
     a new one. */
  private sessionToTell(a: Agent): string | null {
    if (a.sessionId && !this.remembered.has(a.sessionId) && this.hasLog(a)) {
      this.remembered.add(a.sessionId);
      this.opts.remember?.(a.sessionId, a.workDir);
    }
    return a.sessionId;
  }

  private hasLog(a: Agent): boolean {
    try {
      const file = this.transcriptFile(a);
      return file !== null && existsSync(file);
    } catch {
      return false;
    }
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
    if (job.input.tools && this.bridge.toolsRefusedSince(a.key, a.startedAt)) return await this.withoutTools(a, job);
    const output = await this.screen(job.key);
    return { ok: true, sessionId: a.sessionId, result: message, output, error: null, limits: a.limits, tokens: a.tally.tokens() };
  }

  /* A program that connects to its tools only after the short turn that started it ended is turned away, as no turn answers
     for them then, and goes without them for the rest of its session. Its turns end saying so, not as turns that left
     their task where it was, and the next one starts it anew, to connect while that turn runs. */
  private withoutTools(a: Agent, job: TermJob): Promise<RunResult> {
    a.hash = null;
    a.failure = failure('tools', "The program has no Hornhoof tools in this session: it connected to them between turns, when no turn could answer for them. The next turn starts it anew.");
    return this.failedTurn(a, job, 'agent_failed');
  }

  private async stopTurn(a: Agent, job: TermJob, ended: Deferred<string>): Promise<RunResult> {
    this.intentional(a, 'cancelled');
    if (!a.turn?.calledOff) await this.inputLane(a, () => this.opts.tmux.keys(a.name, 'Escape'));
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
    /* tmux keeps the last lines of a dead pane on its screen, and what this run printed is in its recording. */
    return await this.failedTurn(a, job, job.signedOut.test(await this.shownNow(a)) ? 'not_logged_in' : 'agent_failed', screen);
  }

  /* Reports the program's own state when its call changes or a report is due, else every lookMs. The screen is diagnostic. */
  private async reportProgram(a: Agent, watch: ProgramWatch, look: Look): Promise<void> {
    const turn = a.turn;
    const now = Date.now();
    const call = this.pendingCall(a);
    if (call === look.call && a.retry === look.retry && now - look.at < this.lookMs && !watch.due(now)) return;
    Object.assign(look, { at: now, call, retry: a.retry });
    /* A session gone since the last look shows no screen; whoever waits on this turn hears it is gone. */
    const screen = await this.opts.tmux.screen(a.name, 0, true).catch(() => null);
    if (screen === null || a.turn !== turn) return;
    watch.look(now, screen, call, this.programRunning(a), a.signAt, a.retry);
    if (this.atInterruption(a, screen)) this.interrupted(a);
    this.agyFailed(a);
  }

  /* agy's turn is under way from when its prompt is on the way, whether agy still works on other words or is about to take it:
     Hornhoof would take idle for a program that stands still. */
  private programRunning(a: Agent): boolean {
    if (a.program?.kind === 'antigravity' && a.typing != null) return true;
    return Boolean(a.took && a.busy);
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
    this.reportGone(watch, ended, this.opts.tmux.maskedScreen(a.name, screen), a.signAt);
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
    return { ok: false, sessionId: a.sessionId, result: '', output: details, programOutput: ended?.programOutput, error: classified, ...failedDetail(error, detail, Boolean(ended), details), limits: a.limits, tokens: a.tally.tokens() };
  }

  /* While its program runs the host reads the agent's log and reports typed turns, ending them if the program is gone.
     Hornhoof's own turns look after themselves. */
  private watch(a: Agent): void {
    if (a.watch) return;
    let looking = false;
    a.watch = setInterval(() => {
      if (looking) return;
      looking = true;
      void this.look(a).then(() => this.leaveIfIdle(a)).then(() => this.sleepIfIdle(a)).finally(() => (looking = false));
    }, this.pollMs);
    a.watch.unref();
  }

  private unwatch(a: Agent): void {
    if (a.watch) clearInterval(a.watch);
    a.watch = null;
  }

  private async look(a: Agent): Promise<void> {
    /* A program that sleeps did not end: nothing of it is left to tell, unless a turn opened as it slept, as one its hook
       told of late does. That turn has no program, and ends as one whose program is gone. */
    if (a.restarting || (a.asleep && !a.turn)) return;
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

  /* A program at its prompt with nothing typed, or with only Hornhoof's own words that never went, waits for them: the words
     that go on erase those and go in once. A person's words keep it waiting for them. */
  private async ownerRecoveryReady(a: Agent): Promise<void> {
    const input = inputOf(a.program!.kind, await this.opts.tmux.screen(a.name, 0, true));
    const ready = input === '' || (input !== null && this.ownWordsOnly(a, input));
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
    if (a.turn === turn) this.reportGone(turn.observed!.watch, ended?.programOutput, this.opts.tmux.maskedScreen(a.name, screen), a.signAt);
    return ended;
  }

  /* A person cleared the conversation in Claude Code, which goes on in a new session with a log of its own; or Kimi Code
     named its session, whose log the host finds once Kimi writes it; or Antigravity named its conversation. */
  private follow(a: Agent, sessionId: string): void {
    if (!sessionId || sessionId === a.sessionId) return;
    if (a.sessionId) a.blank = sessionId;
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
    a.left.add(a.sessionId);
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
    if (a.keep) void keepContext(this.fs, a.contextDir, sessionId, a.keep).catch(() => {});
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

  /* The turn ended in the program, and the host only reads the rest of its log. */
  private overIn(a: Agent): boolean {
    return Boolean(a.turn?.ending);
  }

  /* An interruption in the log ends the running turn, or the answer to a person's words sent while its prompt waited. */
  private stopCounts(a: Agent): boolean {
    return this.stoppable(a) || Boolean(a.personWords && !a.took);
  }

  /* A stop in the log counts for the running turn once its prompt went in: one logged before is the last turn's. */
  private stoppable(a: Agent): boolean {
    return Boolean(a.turn && (a.turn.typed || (a.busy && a.took)));
  }

  private beginTurn(a: Agent): void {
    a.completionStart = a.program?.kind === 'kimi' ? this.opts.tmux.programCursor(a.name).catch(() => null) : null;
    this.clearQuestion(a);
    a.tally.begin();
    a.personWords = false;
    a.ends.begin();
    a.programTurnId = undefined;
    a.calls.clear();
    a.closedCalls.clear();
    a.question = null;
    a.retry = null;
    a.failure = a.apiError = null;
    a.stopped = false;
    a.pressed = null;
    a.unanswered = null;
    a.steered = a.splitWaits = false;
    a.splitStops = 0;
    /* The quiet of a turn counts from its start until the program gives its own sign. */
    a.signAt = Date.now();
  }

  private interrupted(a: Agent, id?: string): void {
    this.endTurn(a, { status: 'stopped', message: '' }, id);
  }

  private turnFailed(a: Agent, reason: string, detail?: Failure, id?: string): void {
    this.endTurn(a, { status: 'failed', message: '', failure: detail ?? failure('unknown', reason) }, id);
  }

  private endTurn(a: Agent, end: TurnEnd, id?: string, blocked = false): void {
    if (this.endsNoTurn(a)) return;
    const decision = a.ends.end(end.status, this.stoppable(a) || Boolean(blocked && a.turn), id);
    if (decision.conflict) this.logDisagreement(a);
    /* A turn the program ran of its own, with no Hornhoof turn, is over: the program is free for the next one. */
    if (!decision.accept && !a.turn) a.busy = false;
    if (!decision.accept) return;
    const unanswered = end.status === 'stopped' ? null : a.unanswered;
    a.unanswered = null;
    this.acceptedEnd(a, a.turn!, end);
    if (unanswered) this.openUnanswered(a, unanswered);
  }

  private openUnanswered(a: Agent, words: TakenWords): void {
    a.originalTaken = { jobId: words.jobId!, text: words.text, operatorDelivery: words.operatorDelivery };
    void this.openTyped(a, words.text, true);
  }

  /* An end is accepted only of a running turn: `stoppable` asks for one. */
  private acceptedEnd(a: Agent, turn: Turn, end: TurnEnd): void {
    this.clearQuestion(a);
    this.intentional(a, end.status === 'stopped' ? 'cancelled' : 'completed');
    this.endWords(a, turn);
    this.notBusyAfter(a, end);
    turn.ending = end;
    if (!turn.typed) return a.ended?.resolve(end.message);
    this.settleTyped(a, end, turn);
  }

  private notBusyAfter(a: Agent, end: TurnEnd): void {
    if (a.pressed) a.pressed.until ??= Date.now() + UNHEARD_MS;
    a.busy = false;
    a.retry = null;
    a.calls.clear();
    a.question = null;
    a.stopped = end.status === 'stopped';
    a.failure = end.failure ?? null;
  }

  private settleTyped(a: Agent, end: TurnEnd, turn: Turn): void {
    const error = endedError(a.stopped, end.failure, a.signedOut);
    const settling = this.settle(a, end.message);
    a.settling = settling;
    void settling.finally(() => { if (a.settling === settling) a.settling = null; });
    void settling.then(async () => {
      const screen = await this.screen(a.key);
      this.finishTyped(a, end.message, error, end.failure ? `${screen}\n\n${end.failure.text}` : screen, undefined, turn);
    });
  }

  private operatorStarted(a: Agent): void { this.operator?.started(a.key); }

  /* prompt: what the program says it took, where its log says. */
  private tookTurn(a: Agent, id?: string, prompt?: string): void {
    if (this.personsPrompt(a, prompt)) return this.personSent(a);
    this.operatorStarted(a);
    const first = !a.took;
    a.busy = a.took = true;
    a.ends.started(id);
    if (id !== undefined) a.programTurnId = id;
    if (first) a.turn?.words.clear();
  }

  /* Whether within enterWaitMs the program took the prompt Hornhoof typed, ended its turn or ended itself, or the turn
     was called off: the turn goes on from there without another Enter. */
  /* It looks once more after its time is up: a slow look on a busy machine may have lasted while the program took the words. */
  private async tookPrompt(a: Agent, signal?: AbortSignal): Promise<boolean> {
    let ended = false;
    void a.ended?.promise.then(() => (ended = true));
    for (const end = Date.now() + this.enterWaitMs; ; await sleep(this.pollMs)) {
      const late = Date.now() >= end;
      this.drain(a);
      if (a.took || ended || signal?.aborted || !(await this.opts.tmux.alive(a.name))) return true;
      if (late) return false;
    }
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
    if (job.operatorDelivery && this.operator?.enabled(a.key)) return (await this.inputBox(a, input => input !== null)) || null;
    await this.inputShows(a);
    return true;
  }

  private async signedOutBeforeReady(a: Agent, job: TermJob): Promise<boolean> {
    return !job.operatorDelivery && job.signedOut.test(await this.shownNow(a));
  }

  /* What the program shows now, without the lines above its screen: started again in its pane, it has what its last run
     printed there, as Claude Code and Codex stay on the main screen for a person to scroll back through. */
  private shownNow(a: Agent): Promise<string> {
    return this.opts.tmux.screen(a.name, 0);
  }

  /* Whether the prompt shows, or null while the program is still on its way to it. Kimi shows its prompt also when it is
     not signed in, with a word to sign in; agy may first ask for its first-run setup. */
  private async promptShows(a: Agent, job: TermJob, kind: keyof typeof READY, colors: { at: number }): Promise<boolean | null> {
    const screen = await this.shownNow(a);
    if (kimiSignedOut(job, kind, screen)) return false;
    if (READY[kind](screen) || (await this.codexWaits(a, kind))) {
      await sleep(PROMPT_SETTLE_MS);
      return true;
    }
    if (kind === 'antigravity' && (await this.agyFirstRun(a, colors))) return false;
    await sleep(this.pollMs);
    return null;
  }

  /* A long session takes Codex's banner off the top of its screen: its empty prompt still shows, and only the styles tell that
     from a suggestion in it. A turn it still runs was waited for before this. */
  private async codexWaits(a: Agent, kind: keyof typeof READY): Promise<boolean> {
    return kind === 'codex' && atEmptyPrompt(kind, await this.opts.tmux.screen(a.name, 0, true));
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
  private async inputBox(a: Agent, shows: (input: string | null) => boolean = input => input === ''): Promise<boolean> {
    for (const end = Date.now() + INPUT_WAIT_MS; Date.now() < end && (await this.opts.tmux.alive(a.name)); await sleep(this.pollMs)) {
      if (shows(inputOf('claude', await this.opts.tmux.screen(a.name, 0, true)))) return true;
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
    const file = join(a.contextDir, '.hh-messages', `${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
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
        a.tally.claudeLine(data);
        if (wentOn(raw)) a.unanswered = null;
        this.dequeuedPrompt(a, raw);
        if (claudeInterrupted(data) && this.stopCounts(a)) this.interrupted(a);
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
      a.tally.codexLine(data);
      const news = codexRollout(data);
      if (news.typed !== undefined) this.codexTyped(a, news.typed);
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

  private codexTyped(a: Agent, text: string): void {
    if (!a.turn || a.turn.starting || this.overIn(a)) void this.openTyped(a, text, true);
    else a.pressed = null;
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
    if (receipt && !this.knownClaudeWord(a, receipt) && receipt.state === 'queued') this.ownerQueued(a, receipt.text);
  }

  private knownClaudeWord(a: Agent, receipt: NonNullable<ReturnType<typeof claudeWordReceipt>>): boolean {
    return [...waitingWords(a)].some(words => this.receiveClaudeWord(words, receipt));
  }

  /* Words the program queued that Hornhoof did not type, right after the owner's Enter, are what the owner typed. */
  private ownerQueued(a: Agent, text: string): void {
    const pressed = this.pressedFor(a, text);
    if (!pressed) return;
    a.pressed = null;
    const words = a.turn?.words ?? new TurnWords([], { word: this.wordReceipt(a) });
    words.addTyped(text, pressed.jobId);
    if (!a.turn) words.end(Date.now());
    if (!a.waitingWords.includes(words)) a.waitingWords.push(words);
  }

  /* The owner's Enter a prompt Hornhoof does not know may come from, if it is no news of the program's own. Claude logs what
     it queues, so there only one just pressed counts. */
  private pressedFor(a: Agent, text: string): NonNullable<Agent['pressed']> | null {
    const pressed = a.pressed;
    if (!pressed || isProgramOwnPrompt(text)) return null;
    const now = Date.now();
    if (pressed.until !== null && now >= pressed.until) return null;
    return a.program?.kind === 'claude' && now - pressed.at >= UNHEARD_MS ? null : pressed;
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
    if (this.joinsOwnWords(a, text)) return;
    if (!a.turn || !a.busy || this.overIn(a)) { void this.openTyped(a, text, true); return; }
    this.dequeuedInTurn(a, text);
  }

  /* Claude starts a turn by itself for a notice of its own, a background command that ended, just as Hornhoof's words go
     in: they join that turn. The notice is no person's, so it opens no turn of a person's, and the turn stays the one whose
     words they are, for them to be taken in. */
  private joinsOwnWords(a: Agent, text: string): boolean {
    return isProgramOwnPrompt(text) && Boolean(a.turn && !a.turn.typed && !this.overIn(a) && a.turn.words.originalPending());
  }

  /* Claude took what it queued in a turn that seems to run. That turn may have ended already, with its Stop refused and its
     end still to come in the log: if that end is the next thing it tells of, the words are a request of their own. */
  private dequeuedInTurn(a: Agent, text: string): void {
    for (const words of a.waitingWords) {
      const queued = words.isQueued(text) ? words.takeQueued(text) : null;
      if (queued) a.unanswered = queued;
      if (queued || words.taken(text)) return;
    }
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
    if (news.steer) a.steered = news.steer === 'queued' && Boolean(a.turn) && !this.overIn(a);
    if (news.started) a.splitWaits = false;
    if (news.started) this.tookTurn(a, undefined, news.prompt);
    if (news.aborted) this.interrupted(a);
    else if (news.failed !== undefined) this.endTurn(a, { status: 'failed', message: '', failure: isRecord(raw.error) ? FAILURE.kimi(raw.error) : failure('unknown', news.failed) }, undefined, news.blocked);
    else if (news.ended && !this.kimiSplit(a)) this.endTurn(a, { status: 'done', message: a.lastText ?? '' });
  }

  /* Kimi 2.6.3 ends a turn that words were steered into and goes on with them at once, in a turn of its own: the Hornhoof
     turn runs on through it with its job and tool token, and its end is that turn's end. An older Kimi leaves the words
     waiting for a next turn instead: a turn it does not go on from within SETTLE_MS ends as it would have. */
  private kimiSplit(a: Agent): boolean {
    const turn = a.turn;
    if (!a.steered || !turn || this.overIn(a)) return false;
    a.steered = false;
    a.splitWaits = true;
    a.splitStops = (a.splitStops ?? 0) + 1;
    setTimeout(() => this.splitNotGoneOn(a, turn), SETTLE_MS);
    return true;
  }

  private splitNotGoneOn(a: Agent, turn: Turn): void {
    this.drain(a);
    if (a.turn !== turn || !a.splitWaits) return;
    a.splitWaits = false;
    this.endTurn(a, { status: 'done', message: a.lastText ?? '' });
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

  /* Kimi's answer is complete only at turn.ended on its wire, or the turn went on past a split there. A missing wire end
     does not hold its hook forever. */
  private async settleWire(a: Agent, turn: Turn | null): Promise<void> {
    for (const end = Date.now() + SETTLE_MS; a.turn === turn && turn && !turn.ending && !a.splitStops && Date.now() < end; await sleep(100)) this.drain(a);
  }

  /* The stop is of a turn Kimi ended at a split: whether the Hornhoof turn goes on is the split's to say. */
  private splitStop(a: Agent): boolean {
    if (!a.splitStops) return false;
    a.splitStops--;
    return true;
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
    event = this.privacy.event(a.name, turn, event, name => this.bridge.toolPolicy(a.key, name));
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
    const question = operatorQuestion(data, [...this.opts.secrets(), ...this.opts.tmux.outputValues(a.name).forms()], a.operatorQuestion);
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
    return this.hooks.get(event)?.(a, data);
  }

  private readonly hooks = new Map<string, Hook>([
    ...TOOL_HOOKS.map((event): [string, Hook] => [event, (a, data) => this.operatorToolHook(a, event, data)]),
    ['interrupt', (a, data) => this.interruptHook(a, data)],
    ['end', (a, data) => this.endHook(a, data)],
    ['start', (a, data) => this.startHook(a, data)],
    ['status', (a, data) => this.statusHook(a, data)],
    ['queued', (a, data) => this.queuedHook(a, data)],
    ['prompt', (a, data) => this.promptHook(a, data)],
    ['invocation', (a, data) => this.invocation(a, data)],
    ['stop', (a, data) => this.stoppedHook(a, data)],
  ]);

  private interruptHook(a: Agent, data: Record<string, unknown>): void {
    this.drain(a);
    this.interrupted(a, typeof data.turn_id === 'string' ? data.turn_id : undefined);
  }

  private async endHook(a: Agent, data: Record<string, unknown>): Promise<void> {
    this.drain(a);
    const cleared = data.reason === 'clear';
    if (cleared) this.sessionCleared(a);
    if (await this.opts.tmux.alive(a.name)) {
      if (cleared && this.stoppable(a)) this.interrupted(a);
      return;
    }
    if (this.stoppable(a)) this.turnFailed(a, 'The program session ended during the turn.', failure('crash', 'The program session ended during the turn.'));
    this.programEnded(a);
  }

  private sessionCleared(a: Agent): void {
    this.reportUnheard(a, true, 'the program cleared its session');
    a.enqueuedWords = [];
    a.dequeued = false;
  }

  /* Claude Code starts with the id the host gave it; Kimi Code names a new session here. */
  private startHook(a: Agent, data: Record<string, unknown>): void {
    if (typeof data.session_id === 'string' && (a.sessionId || a.program?.kind === 'kimi')) this.follow(a, data.session_id);
    a.started?.resolve();
  }

  private statusHook(a: Agent, data: Record<string, unknown>): void {
    const limits = claudeStatusLimits(data);
    if (limits) a.limits = limits;
    const used = claudeStatusContext(data);
    if (used !== null) this.context(a, used);
  }

  private async promptHook(a: Agent, data: Record<string, unknown>): Promise<string | void> {
    const prompt = typeof data.prompt === 'string' ? data.prompt : contentText(data.prompt);
    if (this.personsPrompt(a, prompt)) return this.personSent(a);
    const retained = this.takeRetainedAssignment(a, prompt);
    /* Claude's transcript confirms queued words after this hook returns. */
    return queuedInClaude(a, this.overIn(a)) ? undefined : this.promptTaken(a, prompt, retained);
  }

  private async promptTaken(a: Agent, prompt: string, retained: boolean): Promise<string | void> {
    const first = !a.took || a.typing != null;
    if (first && !retained) a.turn?.words.taken(prompt);
    a.took = true;
    /* Kimi Code hands the prompt as parts of a message. */
    const notice = await this.promptGot(a, prompt);
    await this.prompted(a, prompt);
    if (first) a.turn?.words.clear();
    return notice;
  }

  private stoppedHook(a: Agent, data: Record<string, unknown>): Promise<void> {
    /* agy's Stop ends an execution; fullyIdle distinguishes the conversation's end from more work. */
    return this.agyContinues(a, data) ? Promise.resolve() : this.finalStoppedHook(a, data);
  }

  private agyContinues(a: Agent, data: Record<string, unknown>): boolean {
    if (a.program?.kind !== 'antigravity' || data.fullyIdle !== false) return false;
    a.agyAnswered = false;
    return true;
  }

  private async finalStoppedHook(a: Agent, data: Record<string, unknown>): Promise<void> {
    this.drain(a);
    const id = typeof data.turn_id === 'string' ? data.turn_id : undefined;
    if (stopIsLate({ promptIn: this.stoppable(a), answersPerson: Boolean(a.personWords), from: data.session_id, session: a.sessionId, left: a.left })) return this.lateStop(a, data, id);
    if (typeof data.session_id === 'string') this.follow(a, data.session_id);
    if (data.stopped === true) return this.interrupted(a, id);
    const detail = this.stopFailure(a, data);
    if (detail) return this.turnFailed(a, detail.text, detail, id);
    await this.successfulStop(a, data, id);
  }

  private logDisagreement(a: Agent): void {
    this.log(`Agent ${a.key} (${a.program?.kind}): turn end channels disagree. The first end was kept.`);
  }

  /* The turn this stop tells of is over, so the session and the turn that run now are not its to change. All it can still
     show is that the two channels disagree on how that turn ended. */
  private lateStop(a: Agent, data: Record<string, unknown>, id: string | undefined): void {
    const status = data.stopped === true ? 'stopped' : this.stopFailure(a, data) ? 'failed' : 'done';
    if (a.ends.end(status, false, id).conflict) this.logDisagreement(a);
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
      if (this.splitStop(a) || !this.stopIsCurrent(a, turn)) return;
    }
    this.completeStop(a, data, id);
  }

  private completeStop(a: Agent, data: Record<string, unknown>, id: string | undefined): void {
    if (a.program?.kind === 'antigravity') return this.agyStopped(a);
    /* Codex stays in its turn after this hook, for as long as a busy machine makes it. Words that come before task_complete in its
       log go into that same turn with no task_started to tell they were taken, and they would be given again. That line ends it. */
    if (a.program?.kind === 'codex') return;
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
      a.agyAnswered = false;
      a.busy = true;
      return;
    }
    if (a.promptWaits) return this.personSent(a);
    const prompt = String(data.lastUserInput ?? '');
    this.takeInvocationWords(a, prompt);
    await this.prompted(a, prompt);
  }

  private takeInvocationWords(a: Agent, prompt: string): void {
    const retained = this.takeRetainedAssignment(a, prompt);
    if (a.typing !== null && !retained) a.turn?.words.taken(prompt);
    a.typing = null;
  }

  private queuedHook(a: Agent, data: Record<string, unknown>): void {
    const text = contentText(data.prompt ?? data.input);
    if (!a.turn?.words.queued(text, 'hook')) this.ownerQueued(a, text);
  }

  private async prompted(a: Agent, prompt: string): Promise<void> {
    /* It works from here on, while what follows reads where it stands: whoever looks meanwhile must not take it for idle. */
    a.busy = a.took = true;
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
    else a.pressed = null;
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
    const taken = this.typedInTurn(a, this.takeTypedWords(a, text), fromLog);
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
    const turn: Turn = { privacy: this.privacy.fresh(a.name), jobId: null, onEvent: () => {}, typed: true, seq: 0, words: new TurnWords([], { word: this.wordReceipt(a) }), ref: randomUUID(), early: [], over: null, opened: deferred(), sourceDelivery, operatorInstance: this.operator?.identity(a.key)?.instance };
    turn.observed = this.observeProgram(a, null);
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
    this.opts.send(typedOpen(a.key, turn.privacy!.values.text(text), turn.ref, queuedFrom));
    await answered();
  }

  /* The turn a person's words are opening for the agent now: a tool call its program makes meanwhile waits for it as long
     as the turn itself does, and goes with its token. */
  private openingTurn(key: string): Promise<unknown> | null {
    const a = this.agents.get(key);
    const turn = a?.turn;
    if (!turn?.opened || !a!.unopened.includes(turn)) return null;
    return Promise.race([turn.opened.promise, sleep(this.openMs)]);
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

  /* Words Hornhoof does not know, which the owner's Enter in a turn sent: the node names that turn for Hornhoof to check. A
     prompt read from Claude's log needs a receipt of its queue. */
  private typedInTurn(a: Agent, taken: TakenWords, fromLog: boolean): TakenWords {
    if (taken.jobId || (fromLog && a.program?.kind === 'claude')) return taken;
    const pressed = this.pressedFor(a, taken.text);
    if (!pressed) return taken;
    a.pressed = null;
    return { ...taken, jobId: pressed.jobId };
  }

  /* Hornhoof keeps words left in an input: they may leave it now. */
  inputKept(m: Msg<'agent.input_kept'>): void {
    this.leftInputs.kept(m.ref);
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
    if (!turn.jobId) return this.notOpened(a, turn);
    /* It ended before Hornhoof named it. */
    if (turn.over) {
      this.typedDone(turn, turn.over.message, turn.over.error, turn.over.sessionId, turn.over.output, turn.over.programOutput, turn.over.failure, turn.over.tokens);
    }
  }

  private bindTyped(a: Agent, turn: Turn, m: Msg<'turn.opened'>, early: AgentEvent[]): void {
    if (m.jobId && m.toolToken) {
      turn.jobId = m.jobId;
      a.sinceRun.add(m.jobId);
      this.bindOperatorTurn(a, turn, m.jobId);
      turn.words.bind(m.jobId);
      turn.toolToken = m.toolToken;
      turn.observed!.watch.bind(m.jobId, Date.now());
      if (a.turn === turn) this.bridge.setToken(a.key, m.toolToken);
      for (const e of early) this.typedEvent(turn, e);
    }
  }

  /* Hornhoof opened no job for what the program took, as for a turn Kimi started of its own: nothing of it has a job to tell
     or tools to call. It is no Hornhoof turn, and the program works on it until its own end; Hornhoof's next turn waits for
     that and tells meanwhile what the program does. */
  private notOpened(a: Agent, turn: Turn): void {
    if (a.turn !== turn) return;
    this.endWords(a, turn);
    a.turn = null;
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
    const tokens = a.tally.tokens();
    if (turn.early) turn.over = { message, error, sessionId: a.sessionId, output, programOutput, failure: detail, tokens };
    else this.typedDone(turn, message, error, a.sessionId, output, programOutput, detail, tokens);
  }

  private typedDone(turn: Turn, message: string, error: JobError, sessionId: string | null, output: string, programOutput?: ProgramOutput, failure?: Failure, tokens: TurnTokens | null = null): void {
    if (!turn.jobId) return;
    const result = error === 'cancelled' ? 'Stopped.' : error ? '' : message;
    this.opts.send(jobDone(turn.jobId, { ok: !error, sessionId, result, output, programOutput, failure, error, limits: null, tokens, privateValues: turn.privacy?.values, ...(turn.words.waitingForTurn(Date.now()) ? { wordsWaiting: true } : {}) }, [...this.opts.secrets(), ...(turn.toolToken ? [turn.toolToken] : [])]));
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
    /* Antigravity queues typed words as a separate turn, so these wait for Hornhoof's next turn. Hornhoof sends none. */
    if (NEXT_TURN_WORDS.includes(words.program.kind)) {
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

  private async restartProgram(a: Agent, { job, spec }: NonNullable<Agent['launch']>, turn: Turn, jobId: string, note: string): Promise<{ ok: boolean; reason: string | null }> {
    await a.saying;
    if (!(await this.inputMayGo(a, { ...job, input: { ...job.input, jobId } }))) return { ok: false, reason: "The program's input holds words Hornhoof could not keep." };
    this.drain(a);
    const changed = restartRefusal(restartEvidence(a), jobId, Date.now());
    if (changed) return { ok: false, reason: changed };
    turn.restarted = true;
    a.restarting = true;
    if (a.turn !== turn || !a.busy) return { ok: false, reason: 'The turn ended before the restart.' };
    await this.resumeSession(a, job, spec, jobId);
    await this.replayWords(a, turn, note);
    this.log(`Agent ${a.key} (${a.program?.kind}): restarted program in session ${a.sessionId} for job ${jobId}.`);
    return { ok: true, reason: null };
  }

  private beginProgramRestart(a: Agent, jobId: string): void {
    const operator = this.operator;
    if (!operator) return;
    operator.intentional(a.key, 'restart');
    operator.exited(a.key, { code: null, signal: null });
    operator.begin(a.key, jobId, undefined, '', false);
    operator.launch(a.key, 'attempt');
  }

  /* Keeps the exact environment of the original launch while resuming its known session. */
  private async resumeSession(a: Agent, job: TermJob, spec: LaunchSpec, jobId: string): Promise<void> {
    const command = resumeCommand(job.program.kind, spec.command, a.sessionId!);
    if (job.program.kind === 'claude') await writeClaudeTools(job.input.workDir, this.bridge.agent(job.key).mcpUrl, this.fs);
    a.started = deferred();
    a.instance = randomUUID();
    a.oldLogs = null;
    a.tail = this.tailFor(a);
    const scratch = this.opts.tmux.scratch();
    this.beginProgramRestart(a, jobId);
    const env = { ...(await this.testShare(a)), ...lasting(job.input.env), ...spec.env };
    await this.inputLane(a, () => this.launching(a, () => this.opts.tmux.launch(a.name, { cwd: a.workDir, command: this.asAgent(command), cols: this.cols, rows: this.rows, envFile: envFile(scratch, env), outputDir: scratch })));
    this.operator?.launch(a.key, 'started');
    if (!(await this.ready(a, { ...job, operatorDelivery: undefined }))) throw new Error('The restarted program did not become ready.');
    this.programIs(a, true);
    a.tail = this.tailFor(a);
    a.enqueuedWords = [];
    a.ends.begin();
    a.retry = null;
  }

  private async replayWords(a: Agent, turn: Turn, note: string): Promise<void> {
    const text = [note, ...turn.words.pending()].filter(Boolean).join('\n\n');
    turn.words.replay(text);
    a.took = false;
    a.typing = text;
    await this.inputLane(a, () => this.opts.tmux.paste(a.name, text));
    const pastedAt = Date.now();
    a.pastedAt = pastedAt;
    await sleep(pasteWait(text));
    a.restarting = false;
    await this.inputLane(a, () => this.opts.tmux.keys(a.name, 'Enter'));
    void this.enterUntilTaken(a, turn, text, pastedAt).catch(() => {});
  }

  /* A program that just started again can miss the Enter, as at its first start and more so on a busy machine: Enter again
     while its input still holds these words, nothing shows it took them and nobody pressed a key since they went in. */
  private async enterUntilTaken(a: Agent, turn: Turn, text: string, pastedAt: number): Promise<void> {
    for (const end = Date.now() + this.readyMs; Date.now() < end;) {
      await sleep(this.enterWaitMs);
      if (!await this.inputLane(a, () => this.enterWaitingWords(a, turn, text, pastedAt))) return;
    }
  }

  /* Capture and Enter share the input lane. A person's key can arrive while the capture waits, so check again after it. */
  private async enterWaitingWords(a: Agent, turn: Turn, text: string, pastedAt: number): Promise<boolean> {
    const input = await this.readInput(a);
    this.drain(a);
    if (a.turn !== turn || a.took || a.restarting || (a.typedAt ?? -Infinity) > pastedAt || !input || !holdsWords(input, text)) return false;
    await this.opts.tmux.keys(a.name, 'Enter');
    return true;
  }

  private async eraseInput(a: Agent, receipt: WordReceipt): Promise<void> {
    if (receipt.shown === undefined) return;
    if (!(await this.opts.tmux.alive(a.name))) return;
    const shown = receipt.shown ?? receipt.text.trim();
    if (!shown || await this.readInput(a) !== shown) return;
    await this.opts.tmux.keys(a.name, ...eraseKeys(receipt.text));
  }

  async restart(key: string, jobId: string, note: string): Promise<{ ok: boolean; reason: string | null }> {
    const a = this.agents.get(key);
    if (a && !a.restarting) this.drain(a);
    const reason = restartRefusal(restartEvidence(a), jobId, Date.now());
    if (reason) return { ok: false, reason };
    if (!canRestart(a)) return { ok: false, reason: 'The program launch is not available.' };
    try {
      return await this.restartProgram(a, a.launch, a.turn, jobId, note);
    } catch (error) {
      return { ok: false, reason: errorWords(error) };
    } finally {
      a.restarting = false;
    }
  }

  /* The agent moved to another plan: its program here goes once it is idle, and first if it is already. A turn sent here before it
     goes keeps it, and word of a turn before the last it was sent has come too late to mean this program. */
  async release(key: string, jobId: string): Promise<void> {
    const a = this.agents.get(key);
    if (!a) return;
    a.leaving = jobId;
    this.watch(a);
    await this.leaveIfIdle(a);
  }

  private async leaveIfIdle(a: Agent): Promise<void> {
    const jobId = a.leaving;
    if (!jobId || a.tryingToLeave) return;
    a.tryingToLeave = true;
    try {
      const left = await this.closeIdle(a, () => true, () => a.sinceRun.has(jobId));
      this.afterLeaving(a, jobId, left);
    } finally {
      a.tryingToLeave = false;
    }
  }

  private afterLeaving(a: Agent, jobId: string, left: RetireResult): void {
    if (left.status === 'busy' || a.leaving !== jobId) return;
    a.leaving = null;
    this.log(`Agent ${a.key}: ${left.status === 'retired' ? 'closed the program of a plan it left' : 'kept its program, which ran a later turn'}.`);
  }

  /* A program sleeps once nothing waits for it: no turn runs or comes, its input is empty, and nobody has its terminal open,
     who would see it go. The next turn starts it again in its session. */
  private async sleepIfIdle(a: Agent): Promise<void> {
    if (!a.up || a.turn || a.queuedTurns || a.busy || a.leaving || a.tryingToLeave || a.tryingToSleep || this.viewed(a.key)) return;
    a.tryingToSleep = true;
    try {
      const instance = a.instance;
      await this.closeIdle(a, () => a.instance === instance, () => true, () => this.keptAwake(a));
    } finally {
      a.tryingToSleep = false;
    }
  }

  /* Why a program that is idle stays up all the same, or null. */
  private keptAwake(a: Agent): string | null {
    if (this.viewed(a.key)) return 'someone has its terminal open';
    return this.operator?.recovering(a.key) ? 'a person is asked to look at it' : null;
  }

  /* Someone has the agent's terminal open, or is opening it. */
  private viewed(key: string): boolean {
    return this.viewSessions.watched(key);
  }

  /* Checks first, so that a program at work answers at once and not after its turn. Then in the line of Hornhoof's turns: one sent
     meanwhile comes after this has answered. A program that sleeps goes as one that is closed, and keeps its pane and session. */
  private async closeIdle(a: Agent, same: () => boolean, last: () => boolean, sleeps?: () => string | null): Promise<RetireResult> {
    try {
      const refused = await this.closeRefusal(a, same, last, sleeps);
      if (refused) return refused;
      const closing = a.queue.then(() => this.closeInLine(a, same, last, sleeps));
      a.queue = closing.catch(() => {});
      return await closing;
    } catch {
      return busy('the program could not be closed');
    }
  }

  private async closeInLine(a: Agent, same: () => boolean, last: () => boolean, sleeps?: () => string | null): Promise<RetireResult> {
    const refused = await this.closeRefusal(a, same, last, sleeps);
    if (refused) return refused;
    if (!(await (sleeps ? this.inputEmpty(a) : this.inputGoes(a)))) return busy('its input holds words Hornhoof does not have');
    return this.inputLane(a, async () => (await this.closeRefusal(a, same, last, sleeps)) ?? (sleeps ? this.sleepProgram(a) : this.closeProgram(a)));
  }

  private async closeRefusal(a: Agent, same: () => boolean, last: () => boolean, sleeps?: () => string | null): Promise<RetireResult | null> {
    if (!same()) return stale('another program runs now');
    const why = idleRefusal(await this.idleEvidence(a)) ?? sleeps?.();
    if (why) return busy(why);
    return last() ? null : stale('a later turn ran');
  }

  /* A program that sleeps would take what its input holds with it, so it sleeps only with nothing there, nor what it cannot read. */
  private async inputEmpty(a: Agent): Promise<boolean> {
    return (await this.readInput(a)) === '';
  }

  /* Writers first: what else it reads, it reads as it stands when the answer goes out. */
  private async idleEvidence(a: Agent): Promise<IdleEvidence> {
    const writers = !(await this.writersSettled(a));
    return {
      turn: Boolean(a.turn), queuedTurns: a.queuedTurns, unopened: a.unopened.length, busy: a.busy, starting: Boolean(a.starting), restarting: a.restarting,
      typing: a.typing != null, promptWaits: Boolean(a.promptWaits), personWords: Boolean(a.personWords), calls: a.calls.size, waitingWords: a.waitingWords.length,
      stillTyping: this.stillTyping(a), enterPending: enterPending(a.pressed), unanswered: Boolean(a.unanswered), writers,
    };
  }

  private async writersSettled(a: Agent): Promise<boolean> {
    const settled = await Promise.all([a.saying, a.settling, a.cancelling].map(writer => hasSettled(Promise.resolve(writer))));
    return settled.every(Boolean);
  }

  /* An input may go only with nothing in it of anyone's. A program that ended has none to read. */
  private async inputGoes(a: Agent): Promise<boolean> {
    if (!a.launch || !(await this.opts.tmux.alive(a.name))) return true;
    return this.inputMayGo(a, a.launch.job);
  }

  /* What the program logged since the node last looked can begin a turn of its own, as the words Codex held and takes once
     its turn is over: that turn keeps it. */
  private turnBegins(a: Agent): boolean {
    this.drain(a);
    return Boolean(a.turn || a.busy);
  }

  /* Gone only when tmux says so: until then it still counts as there. A turn the program began as tmux ended it is the
     watch's to end, as one whose program is gone. */
  private async closeProgram(a: Agent): Promise<RetireResult> {
    if (this.turnBegins(a)) return busy(TURN_BEGAN);
    this.intentional(a, 'completed');
    await this.opts.tmux.kill(a.name);
    if (await this.opts.tmux.has(a.name)) return busy('its session is still there');
    this.operator?.exited(a.key, { code: null, signal: null });
    await this.forgetTools(a);
    if (this.turnBegins(a)) return busy(TURN_BEGAN);
    this.unwatch(a);
    this.programIs(a, false);
    Object.assign(a, { hash: null, instance: null, launch: null, sessionId: null, fresh: false, started: null });
    return RETIRED;
  }

  /* The program sleeps: it ends, and its pane stays with what it printed for people to scroll back through. Its session stays
     the agent's, which Hornhoof gives the next turn to start it again in. The node keeps its place in the program's log:
     read again from its start, the log's turns would seem to run still, and the next turn would wait for them to end. */
  private async sleepProgram(a: Agent): Promise<RetireResult> {
    if (this.turnBegins(a)) return busy(TURN_BEGAN);
    this.intentional(a, 'completed');
    await this.opts.tmux.stop(a.name);
    if (await this.opts.tmux.alive(a.name)) return busy('its program still runs');
    this.operator?.exited(a.key, { code: null, signal: null });
    await this.forgetTools(a);
    if (this.turnBegins(a)) return busy(TURN_BEGAN);
    this.unwatch(a);
    this.programAsleep(a);
    Object.assign(a, { hash: null, instance: null, launch: null, fresh: false, started: null });
    return RETIRED;
  }

  /* The file of its tools' address goes with the program that read it; the next start writes it again. */
  private async forgetTools(a: Agent): Promise<void> {
    if (a.program?.kind === 'claude' && a.workDir) await this.fs.remove(claudeToolsFile(a.workDir)).catch(() => {});
  }

  /* Hornhoof calls off a turn: the program stops as on Escape, and the turn ends as stopped. A turn a person typed tells
     its end here. One Hornhoof gave waits for no end signal any more, and its node tells its end. A turn called off once,
     or one this host does not hold, has nothing left to stop. */
  async cancel(jobId: string): Promise<void> {
    const a = this.holding(jobId);
    if (!a) return;
    this.intentional(a, 'cancelled');
    if (a.turn!.typed) this.finishTyped(a, '', 'cancelled');
    else this.callOff(a, a.turn!);
    /* A session that is gone took its program with it; the turn ends all the same. */
    a.cancelling = this.inputLane(a, () => this.opts.tmux.keys(a.name, 'Escape')).catch(() => {});
    await a.cancelling;
    a.busy = false;
  }

  /* What the end of a turn Hornhoof gave tells as Hornhoof calls it off now: none for a turn a person typed, which tells
     its own, or one this host does not hold. */
  calledOffEnd(jobId: string): CalledOff | null {
    const a = this.holding(jobId);
    return a && !a.turn!.typed ? { sessionId: a.sessionId, tokens: a.tally.tokens() } : null;
  }

  private holding(jobId: string): Agent | undefined {
    return [...this.agents.values()].find(x => x.turn?.jobId === jobId && !x.turn.calledOff);
  }

  /* Its run waits for nothing more: it ends as stopped, whatever the program says or leaves unsaid. */
  private callOff(a: Agent, turn: Turn): void {
    turn.calledOff = true;
    a.stopped = true;
    a.ended?.resolve('');
  }

  /* The agent's views hear when its program comes up or goes. */
  private programIs(a: Agent, up: boolean): void {
    if (a.up === up && !a.asleep) return;
    a.up = up;
    a.asleep = false;
    this.viewSessions.program(a.key, up);
  }

  private programAsleep(a: Agent): void {
    a.up = false;
    a.asleep = true;
    this.viewSessions.program(a.key, false, true);
  }

  /* A program that ended keeps its last screen on show, which says why; the loader is for a program that starts. */
  private programEnded(a: Agent): void {
    if (a.restarting) return;
    this.reportUnheard(a, true);
    a.up = false;
    this.viewSessions.program(a.key);
  }

  private ensureSession(a: Agent, starts: boolean): Promise<void> {
    const opening = this.sessionsOpening.get(a.key);
    if (opening) return opening;
    const created = this.createSession(a, starts).finally(() => this.sessionsOpening.delete(a.key));
    this.sessionsOpening.set(a.key, created);
    return created;
  }

  /* Only a session that is not there yet gets the waiting screen: one a program started in meanwhile keeps its program. */
  private createSession(a: Agent, starts: boolean): Promise<void> {
    return this.launching(a, () => this.waitingScreen(a, starts));
  }

  private async waitingScreen(a: Agent, starts: boolean): Promise<void> {
    if (await this.opts.tmux.has(a.name)) return;
    /* The window shows a loader over the empty session while the program starts. */
    const waiting = starts ? '' : `printf '\\n  %s\\n' '${WAITING}'; `;
    await this.opts.tmux.launch(a.name, { cwd: '/', command: this.asAgent(['sh', '-c', `${waiting}exec sleep 2147483647`]), ...this.viewSessions.fitted(a.key) });
    /* The waiting screen is no program of the agent's: the next turn starts one in its place. A turn that runs now is
       starting its own. */
    if (!a.turn) Object.assign(a, { hash: null, instance: null, binding: null });
  }

  /* What a person's terminal answers by itself goes to tmux, which asked for it, and is nobody's key: a program waits on no
     person because someone opened its view or came back to the window. */
  private ownerTyped(key: string, { data, pressedIn }: Msg<'term.input'>, write: (data: string) => void): void {
    if (!isTerminalReport(data)) this.operator?.ownerInput(key);
    const a = this.agents.get(key);
    if (a) this.ownerKeys(a, write, data, pressedIn);
  }

  private ownerKeys(a: Agent, write: (data: string) => void, data: string, pressedIn?: string): void {
    if (pressedIn) a.pressed = { jobId: pressedIn, at: Date.now(), until: a.turn && !this.overIn(a) ? null : Date.now() + UNHEARD_MS };
    if (typesWords(data)) a.typedAt = Date.now();
    a.ownerTyped ||= !isTerminalReport(data);
    void this.inputLane(a, async () => { write(data); });
  }

  /* Views belong to one connection to Hornhoof; after it came back, people open them again. */
  closeViews(): void {
    this.viewSessions.closeAll();
  }

  open(m: Msg<'term.open'>): Promise<void> {
    return this.viewSessions.open(m);
  }

  input(m: Msg<'term.input'>): void {
    this.viewSessions.input(m);
  }

  resize(m: Msg<'term.resize'>): Promise<void> {
    return this.viewSessions.resize(m);
  }

  close(m: Msg<'term.close'>): void {
    this.viewSessions.close(m);
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

/* How a turn would start its program. */
type TurnLaunch = { spec: LaunchSpec; urls: AgentUrls; hash: string };

/* What a program that just started shows after its prompt is its own, not words anybody left. */
const typedSinceStart = (a: Agent): boolean => (a.typedAt ?? -Infinity) >= a.startedAt;

/* Whether a program with Hornhoof's tools connects to them as it starts. A new Kimi session connects with its first
   message, and Antigravity once it takes a message or opens its MCP panel. */
function connectsAtStart({ program, input }: TermJob): boolean {
  const lazy = (program.kind === 'kimi' && !input.sessionId) || program.kind === 'antigravity';
  return Boolean(input.tools) && !lazy;
}

function initialToolsNeeded(job: TermJob, goesOn: boolean): boolean {
  return !goesOn && !job.input.prompt && connectsAtStart(job);
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

/* The tool the program runs and the question it asks, if any. */
function programAsks(a: Agent): Pick<ProgramFacts, 'tool' | 'question'> {
  return { tool: [...a.calls.values()][0]?.name ?? null, question: a.operatorQuestion ?? null };
}

/* Hornhoof's words wait to go in: they stand unsent in the input, are typed and not taken yet, or wait for the turn. */
function wordsUndelivered(a: Agent): boolean {
  return Boolean(a.ownLeft) || (a.typing != null && !a.took) || Boolean(a.turn?.words.pending().length);
}

/* Hornhoof's words that already went into the input and have not been taken, in the running turn or left from the last. */
function untakenOwn(a: Agent): OwnLeft | null | undefined {
  return pastedAndUntaken(a) ? { text: a.typing!, jobId: null, at: a.pastedAt! } : a.ownLeft;
}

function pastedAndUntaken(a: Agent): boolean {
  return a.typing != null && !a.promptWaits && !a.took;
}

function hasOwnThought(a: Agent, line: Record<string, unknown>): boolean {
  return Boolean(a.program && activeTurn(a) && ownThought(a.program.kind, line, a.programTurnId));
}

/* Claude tells of a step of its turn, or of its queue again: words it took before that were part of the turn. */
const wentOn = (line: Record<string, unknown>): boolean => line.type === 'assistant' || (line.type === 'queue-operation' && line.operation !== 'dequeue');

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

type Hook = (a: Agent, data: Record<string, unknown>) => Promise<string | void> | void;
const TOOL_HOOKS = ['tool', 'tooldone', 'toolfail', 'ask'];

function requestedTurn({ input }: TermJob, words: TurnWords, starting: boolean): Turn {
  return { jobId: input.jobId ?? null, toolToken: input.tools?.token, words, onEvent: input.onEvent ?? (() => {}), typed: false, seq: 0, signal: input.signal, ...(starting ? { starting: true } : {}) };
}

/* Words Claude Code queued while it works on a turn that goes on. */
function queuedInClaude(a: Agent, over: boolean): boolean {
  return a.program?.kind === 'claude' && Boolean(a.busy && a.took) && !over && a.typing == null;
}

function canRestart(a: Agent | undefined): a is Agent & { launch: NonNullable<Agent['launch']>; turn: Turn } {
  return Boolean(a?.launch && a.turn && !a.restarting);
}

const errorWords = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 300);

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
