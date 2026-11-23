import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_JOB_TIMEOUT_MS, cut, lastBytes, repoFolder, type Account, type AgentEvent, type Failure, type JobError, type Limits, type ModelOption, type NodeMessage, type ServerMessage, type TurnTokens } from '@hornhoof/protocol';
import { ToolPrivacy, type PrivateValues } from '@hornhoof/protocol';
import type { SigninStep } from '@hornhoof/protocol/signin';
import { agentFs, ownFs, type AgentFs } from './agent-fs.js';
import { ensureRepoBrowser, writeBrowserError } from './browser.js';
import { packageStoreEnv } from './disk/store.js';
import type { JobUser } from './isolation.js';
import { redact } from './redact.js';
import { withModel } from './turn-tokens.js';
import { plainOutput, programEnded, signalName, type ProgramOutput } from './program-exit.js';
import { placeSkills } from './skills.js';
import { programFor } from './providers/index.js';
import { readSessions, rememberSession } from './state.js';
import { removeClosedCopies } from './task-copies.js';
import type { Worktree } from './tests.js';
import { headOf, prepareRepo, type Git } from './workspace.js';

export type RunInput = {
  /* The agent whose turn this is, from its workspace; a test job has none. */
  agentKey?: string | null;
  /* Hornhoof's job this turn runs, which the node tells what the turn's program does. */
  jobId?: string | null;
  prompt: string;
  sessionId: string | null;
  model: string | null;
  /* How hard the model thinks, as its program names it; none leaves it at the program's default. */
  effort?: string | null;
  /* How full Claude Code's context gets before it compacts the conversation; none leaves it at the program's own. */
  compactWindow?: number | null;
  /* The folder of Hornhoof's own files for this turn: what it tells the program, and what it keeps. */
  workDir: string;
  secret: string | null;
  timeoutMs: number;
  /* Aborted when the job is called off, for example when Hornhoof removes the subscription. */
  signal?: AbortSignal;
  /* Standing instructions for the agent, and Hornhoof's MCP server with the job's token. */
  instructions: string | null;
  /* What the agent should know from before, when its program starts a new session. */
  context?: string | null;
  tools: { url: string; token: string } | null;
  /* Each thing the agent does, as the program reports it while it runs. */
  onEvent?: (event: AgentEvent) => void;
  /* More environment for the program, such as git access to the agent's repository for this turn. */
  env?: Record<string, string>;
};
/* tokens: what the turn used, as its program reported it; none when it reports nothing. unstarted: the turn ended before its
   program started. */
export type RunResult = { ok: boolean; sessionId: string | null; result: string; output: string; error: JobError | null; limits: Limits | null; programOutput?: ProgramOutput; failure?: Failure; wordsWaiting?: boolean; tokens?: TurnTokens | null; privateValues?: PrivateValues; unstarted?: boolean };

/* What kept an adapter from launching the turn's program at all, so the turn ended before its program started. */
export class ProgramNotStarted extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}
/* step: where a sign-in is after its code, for the running node to pass on, when the program shows it. */
export type LoginIo = { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; urlFile: string; step?: (step: SigninStep) => void };

/* One agent program (Claude Code, Codex, Kimi) as the node drives it. */
export interface ProviderAdapter {
  install(): Promise<void>;
  loggedIn(): Promise<boolean>;
  login(io: LoginIo): Promise<void>;
  /* Whether the signed-in program waits for a first setup only the plan's owner may pass, such as accepting its terms,
     and that setup on the owner's own terminal, as the sign-in. */
  setupNeeded?(): Promise<boolean>;
  setup?(io: LoginIo): Promise<void>;
  run(input: RunInput): Promise<RunResult>;
  /* One call in the program's mode that answers once and exits, in a session it keeps nowhere: what a one-shot call runs.
     A program without such a mode has none, and its one-shot calls end at once saying so. */
  oneCall?(input: RunInput): Promise<RunResult>;
  /* Values that must never leave the node, such as the tokens in the program's credentials file. */
  secrets(): Promise<string[]>;
  /* The models the program can run, when it can tell. Hornhoof falls back to what it knows for the provider. */
  models?(): Promise<ModelOption[]>;
  /* The plan's limits now, asked without a turn, or null when the program cannot tell at the moment. */
  limits?(): Promise<Limits | null>;
  /* Which account and plan of its maker the program is signed in to, or null when it cannot tell. */
  account?(): Promise<Account | null>;
  /* On the built-in node, the user a key's program runs as and its home: the folder is handed to that user first,
     and the node's own git work in it runs as that user too. */
  /* mkdir: how a node that runs as root makes an agent's folders as the agents' own user; fs: its other file work there.
     Without fs, a job of such a user does it through a helper of that user for the job. */
  owner?: { user: JobUser | null; home: string; prepare(path: string): void; mkdir?(path: string): Promise<void>; fs?: AgentFs };
}

type JobRun = Extract<ServerMessage, { type: 'job.run' }>;
type JobDone = Extract<NodeMessage, { type: 'job.done' }>;
type JobRepo = NonNullable<NonNullable<JobRun['workspace']>['repo']>;

const failed = (output: string, error: JobError): RunResult => ({ ok: false, sessionId: null, result: '', output, error, limits: null });

/* Both dispatched and typed turns use the same redaction and tail boundary. */
export function jobDone(jobId: string, res: RunResult, secrets: string[]): JobDone {
  const program = res.programOutput;
  const mask = (text: string) => redact(res.privateValues?.text(text) ?? text, secrets);
  /* A terminal inserts carriage returns; hide both the raw and normalized forms before any line is removed. */
  const text = program ? mask(plainOutput(mask(program.text))) : mask(res.output);
  const output = program ? programEnded(text, program, program.complete) : text;
  return {
    type: 'job.done', jobId, ok: res.ok, sessionId: res.sessionId,
    result: mask(res.result), tail: lastBytes(output), error: res.error, tokens: res.tokens ?? null,
    ...(res.wordsWaiting ? { wordsWaiting: true } : {}),
    ...(res.unstarted && res.error !== 'cancelled' ? { unstarted: true as const } : {}),
    ...(res.failure ? { failure: { ...res.failure, text: mask(res.failure.text).slice(0, 2000) } } : {}),
    ...(program ? { exit: { code: program.code, signal: signalName(program.signal) } } : {}),
  };
}

/* The adapter stops its own program at the timeout and says which session it was in, so the next turn goes on in it.
   This only makes sure the job always ends, a while after that. */
function withTimeout(run: Promise<RunResult>, ms: number): Promise<RunResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<RunResult>(done => {
    timer = setTimeout(() => done(failed(`The agent did not finish within ${Math.round(ms / 1000)} s.`, 'timeout')), Math.min(MAX_JOB_TIMEOUT_MS, ms + Math.min(30_000, ms / 10)));
  });
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const notStarted = (err: unknown): RunResult => ({ ...failed(message(err), 'agent_failed'), unstarted: true });

/* The folder of a one-shot call, which goes when the call ends. */
const callFolder = (dir: string, jobId: string) => join(dir, 'work', 'calls', jobId);

/* What a one-shot call ends with when its program runs no call that answers once and exits. */
export const noOneCall = (msg: Pick<JobRun, 'provider' | 'api'>) =>
  `${programFor(msg.provider, msg.api).name} has no mode that runs one call and exits, so it takes no one-shot calls. Start them on a subscription whose program has one.`;

/* An agent's turn works in the agent's own folder; a session this node saved in another folder cannot go on there, so
   the turn starts a new one. Other jobs work in the folder of the session they resume, or a new one. Only sessions this
   node saved count: one from another machine, or from before a fresh volume, is not here to resume, so the turn starts a new one. */
function workDirFor(msg: JobRun, dir: string): { workDir: string; sessionId: string | null } {
  /* A one-shot call goes on from nothing, in a folder of its own. */
  if (msg.call) return { workDir: callFolder(dir, msg.jobId), sessionId: null };
  const saved = msg.sessionId ? readSessions(dir) : {};
  const known = msg.sessionId && Object.hasOwn(saved, msg.sessionId) ? saved[msg.sessionId] : undefined;
  if (msg.workspace) {
    const workDir = join(dir, 'work', 'agents', msg.workspace.key);
    return { workDir, sessionId: known === workDir ? msg.sessionId : null };
  }
  return typeof known === 'string' ? { workDir: known, sessionId: msg.sessionId } : { workDir: join(dir, 'work', msg.jobId), sessionId: null };
}

/* The agent's files as its program's user has them, for the time this work takes. */
async function withOwnFs<T>(adapter: ProviderAdapter, work: (own: AgentFs) => Promise<T>): Promise<T> {
  const own = adapter.owner?.fs ?? (adapter.owner?.user ? agentFs(adapter.owner.user) : ownFs);
  try {
    return await work(own);
  } finally {
    if (own !== adapter.owner?.fs) own.stop();
  }
}

/* Gets the folders of a turn ready and its skills in place, in the folder its program works in. */
async function readyFolders(adapter: ProviderAdapter, { provider, skills }: JobRun, workDir: string): Promise<void> {
  if (!skills) return;
  await withOwnFs(adapter, own => placeSkills(own, workDir, provider, skills));
}

type TurnPlace = Pick<RunInput, 'workDir'> & { sessionId: string | null; context: string | null };

async function readyWorkDir({ owner }: ProviderAdapter, workDir: string): Promise<void> {
  if (owner?.mkdir) await owner.mkdir(workDir);
  else mkdirSync(workDir, { recursive: true });
  owner?.prepare(workDir);
}

/* Where a turn runs and what it goes on from, in folders ready for it. */
async function placeOfTurn(adapter: ProviderAdapter, msg: JobRun, dir: string): Promise<TurnPlace> {
  const { workDir, sessionId } = workDirFor(msg, dir);
  await readyWorkDir(adapter, workDir);
  await readyFolders(adapter, msg, workDir);
  return { workDir, sessionId, context: msg.context ?? null };
}

type RunOptions = {
  /* More values to hide, such as the node's own key. */
  hidden?: string[];
  signal?: AbortSignal;
  /* Where agents reach Hornhoof's tools: <server>/mcp. */
  toolsUrl?: string;
  onEvent?: (event: AgentEvent) => void;
  /* Runs git; tests pass a fake. */
  git?: Git;
  /* Node preparation, such as a shared program installation, finishes before the program's timeout starts. */
  beforeRun?: () => Promise<void>;
  /* The turn runs in a live program that people watch: only its own end or a stop ends it, never a time limit. */
  untimed?: boolean;
  /* Ensures the repository lockfile's Playwright browsers are ready and launchable before the turn starts. */
  prepareRepoBrowser?: (repoDir: string, verifyUser: JobUser | null) => Promise<void>;
  /* Puts the prepared dependencies of a worktree's commit in it. It says in one line what it put there, or nothing when
     there was nothing to put, and throws what kept it from that. None: the agent installs them itself. */
  dependencies?: (worktree: Worktree, signal?: AbortSignal) => Promise<string | null>;
  /* How long the program waits for them at most, whatever holds them. */
  dependenciesMs?: number;
  /* The node's log, which says which worktrees of closed tasks went before the turn and why one stays. */
  log?: (line: string) => void;
};

const DEPENDENCIES_MS = 10 * 60_000;
const span = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`);

/* The dependencies of the worktree's commit go in place before its program starts, as its user's own files, so the agent's
   first check finds them there. What keeps them away only leaves the agent to install them, and one line says so. */
async function placeDependencies(adapter: ProviderAdapter, msg: JobRun, place: TurnPlace, { dependencies, dependenciesMs = DEPENDENCIES_MS, git, signal }: Pick<RunOptions, 'dependencies' | 'dependenciesMs' | 'git' | 'signal'>): Promise<string | null> {
  const repo = msg.workspace?.repo, repositoryScope = msg.workspace?.repositoryScope, user = adapter.owner?.user;
  if (!dependencies || !repo || !repositoryScope || !user) return null;
  const checkout = join(place.workDir, repoFolder(repo.url));
  const without = (why: string) => `The program starts without the shared dependencies, so it may install them itself: ${why}`;
  const limit = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(dependenciesMs)]);
  const placing = withOwnFs(adapter, async fs => {
    const commitSha = await headOf(checkout, { user, home: adapter.owner?.home ?? null }, git);
    if (!commitSha) return without('the commit of its worktree could not be read.');
    return dependencies({ id: msg.jobId, checkout, commitSha, repo: { url: repo.url, token: repo.token }, repositoryScope, owner: user, fs }, limit).catch((err: unknown) => {
      signal?.throwIfAborted();
      /* A failed build tells its whole output elsewhere; the feed keeps its first line. */
      return without(message(err).split('\n').map(line => line.trim()).find(Boolean) ?? 'no reason was given.');
    });
  });
  /* Whatever holds them, the program waits no longer, and a stopped turn ends here. The work is told to stop as well, and
     tidies up by itself after the program has started. */
  placing.catch(() => {});
  let stop = () => {};
  const gaveUp = new Promise<string>((resolve, reject) => {
    stop = () => (signal?.aborted ? reject(signal.reason) : resolve(without(`they did not come within ${span(dependenciesMs)}.`)));
  });
  if (limit.aborted) stop();
  else limit.addEventListener('abort', stop, { once: true });
  try {
    return await Promise.race([placing, gaveUp]);
  } finally {
    limit.removeEventListener('abort', stop);
  }
}

/* The repository a turn works in, with its lockfile's browser. A browser that cannot start is told in browser-error, and the
   turn goes on. */
async function openRepo(repo: JobRepo, workDir: string, owner: { user: JobUser | null; home: string | null }, dir: string, git: Git | undefined, prepareRepoBrowser: NonNullable<RunOptions['prepareRepoBrowser']>): Promise<Record<string, string>> {
  const env = await prepareRepo(workDir, repo, owner, git);
  await prepareRepoBrowser(join(workDir, repoFolder(repo.url)), owner.user).catch((err: unknown) =>
    writeBrowserError(dir, message(err).replace(/^Playwright browsers could not start:\s*/, '')),
  );
  return env;
}

/* The agent's worktrees of closed tasks go before its turn starts, so their dependencies do not fill the machine's disk.
   What stays, and why, goes to the node's log; nothing of it keeps the turn from starting. */
async function removeCopies(adapter: ProviderAdapter, msg: JobRun, workDir: string, git: Git | undefined, log: (line: string) => void): Promise<void> {
  const repo = msg.workspace?.repo, tasks = msg.workspace?.tasks;
  if (!repo || !tasks) return;
  const owner = { user: adapter.owner?.user ?? null, home: adapter.owner?.home ?? null };
  const lines = await removeClosedCopies(join(workDir, repoFolder(repo.url)), workDir, tasks, owner, git).catch((err: unknown) => [`The worktrees of closed tasks stay this turn: ${message(err)}`]);
  for (const line of lines) log(line);
}

/* An event as people may see it: no secrets, and within the sizes the protocol allows. */
export function tidy(event: AgentEvent, secrets: string[]): AgentEvent {
  const clean = (text: string, max: number) => cut(redact(text, secrets), max);
  switch (event.kind) {
    case 'text':
      return { kind: 'text', text: clean(event.text, 8000) };
    case 'tool':
      return { kind: 'tool', name: clean(event.name, 100), input: clean(event.input, 300), ...(event.sensitive ? { sensitive: true } : {}) };
    case 'tool_result':
      return { kind: 'tool_result', ok: event.ok, summary: clean(event.summary, 500) };
    case 'todo':
      return { kind: 'todo', items: event.items.slice(0, 20).map(i => ({ text: clean(i.text, 200), state: i.state })) };
  }
}

/* Always ends with a job.done, whatever breaks on the way. */
export async function runJob(adapter: ProviderAdapter, msg: JobRun, dir: string, { hidden = [], signal, toolsUrl, onEvent, git, beforeRun = async () => {}, untimed = false, prepareRepoBrowser = (repoDir, verifyUser) => ensureRepoBrowser(dir, repoDir, verifyUser), dependencies, dependenciesMs, log = console.log }: RunOptions = {}): Promise<JobDone> {
  /* Programs refresh their tokens during a run, so the values from before, during and after are all hidden. */
  const before = await adapter.secrets().catch(() => []);
  const repo = msg.workspace?.repo ?? null;
  const given = [...hidden, ...(msg.secret ? [msg.secret] : []), ...(msg.toolToken ? [msg.toolToken] : []), ...(repo?.token ? [repo.token] : [])];
  const tools = msg.toolToken && toolsUrl ? { url: toolsUrl, token: msg.toolToken } : null;
  /* A live event goes out hidden against what the program holds by then, and the events keep their order. */
  const known = new Set([...before, ...given]);
  const privacy = new ToolPrivacy();
  let live = Promise.resolve();
  const emit = (event: AgentEvent) => {
    live = live
      .then(async () => {
        for (const s of await adapter.secrets().catch(() => [])) known.add(s);
        onEvent?.(tidy(privacy.event(event), [...known]));
      })
      .catch(() => {});
  };
  let res: RunResult;
  /* Whether the turn got as far as asking its program to run. */
  let started = false;
  const call = msg.call ? adapter.oneCall?.bind(adapter) ?? null : undefined;
  if (call === null) return jobDone(msg.jobId, failed(noOneCall(msg), 'agent_failed'), [...known]);
  try {
    const place = await placeOfTurn(adapter, msg, dir);
    const repoEnv = repo ? await openRepo(repo, place.workDir, { user: adapter.owner?.user ?? null, home: adapter.owner?.home ?? null }, dir, git, prepareRepoBrowser) : undefined;
    await removeCopies(adapter, msg, place.workDir, git, log);
    const placed = await placeDependencies(adapter, msg, place, { dependencies, dependenciesMs, git, signal });
    if (placed) emit({ kind: 'text', text: placed });
    /* hh-attach sends the turn's pictures with its token. The name has no KEY, SECRET or TOKEN in it, so Codex passes it on. */
    const attachEnv = tools ? { HH_ATTACH_URL: tools.url.replace(/\/mcp$/, '/api/attachments'), HH_ATTACH_PASS: tools.token } : undefined;
    const rawStoreEnv = msg.workspace ? packageStoreEnv(dir, { user: adapter.owner?.user ?? null, home: adapter.owner?.home ?? null }, process.env) : undefined;
    const storeEnv = rawStoreEnv && Object.keys(rawStoreEnv).length > 0 ? rawStoreEnv : undefined;
    const env = storeEnv || repoEnv || attachEnv ? { ...storeEnv, ...repoEnv, ...attachEnv } : undefined;
    const input: RunInput = {
      agentKey: call ? null : (msg.workspace?.key ?? null),
      jobId: msg.jobId,
      prompt: msg.prompt,
      model: msg.model,
      effort: msg.effort ?? null,
      compactWindow: msg.compactWindow ?? null,
      ...place,
      secret: msg.secret,
      timeoutMs: msg.timeoutMs,
      signal,
      instructions: msg.instructions,
      tools,
      onEvent: emit,
      ...(env ? { env } : {}),
    };
    await beforeRun();
    started = true;
    const run = (call ? call(input) : adapter.run(input)).catch((err: unknown) => err instanceof ProgramNotStarted ? notStarted(err) : failed(message(err), 'agent_failed'));
    res = await (msg.timeoutMs === 0 || (untimed && !call) ? run : withTimeout(run, msg.timeoutMs));
    if (res.sessionId && !call) rememberSession(dir, res.sessionId, place.workDir);
  } catch (err) {
    res = started ? failed(message(err), 'agent_failed') : notStarted(err);
  }
  /* A call leaves nothing behind: what it was to keep went out in its answer, or in commits it pushed. */
  if (call) await withOwnFs(adapter, own => own.remove(callFolder(dir, msg.jobId))).catch(() => {});
  await live;
  /* A job Hornhoof called off ends as cancelled, whatever the stopped program said. */
  if (signal?.aborted) res = { ...res, ok: false, result: 'Stopped.', error: 'cancelled' };
  /* Everything the program held at any point of the run, so a token it had only in between is hidden too. */
  for (const s of await adapter.secrets().catch(() => [])) known.add(s);
  return jobDone(msg.jobId, { ...res, privateValues: res.privateValues ?? privacy.values, tokens: withModel(res.tokens, msg.model) }, [...known]);
}
