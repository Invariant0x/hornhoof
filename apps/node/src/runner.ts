import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cut, lastBytes, repoFolder, type Account, type AgentEvent, type Failure, type JobError, type Limits, type ModelOption, type NodeMessage, type ProviderId, type ServerMessage } from '@hornhoof/protocol';
import { agentFs, ownFs, type AgentFs } from './agent-fs.js';
import { ensureRepoBrowser, writeBrowserError } from './browser.js';
import type { JobUser } from './isolation.js';
import { redact } from './redact.js';
import { plainOutput, programEnded, signalName, type ProgramOutput } from './program-exit.js';
import { carrySession, CARRIES, freshStart, programDirOf, readyProgramFolder } from './program-folder.js';
import { placeSkills, skillPaths, superpowersIn } from './skills.js';
import { readSessions, rememberSession } from './state.js';
import type { Worktree } from './tests.js';
import { headOf, prepareRepo, type Git } from './workspace.js';

/* The task's folder a turn runs in, from the node itself once it admitted and prepared it, and never from a message. The
   worktree stands right inside the task's context folder. binding: what retiring its program goes by. catchUp: what a session
   that starts anew there knows of the task, short and of this task alone. */
export type ProgramBinding = { workspaceId: string; bindingVersion: number };
export type ProgramWorkspace = { programDir: string; binding: ProgramBinding; catchUp?: string | null };

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
  /* The task's worktree the program works in, when its turn belongs to a task; it works in workDir otherwise. */
  programDir?: string;
  /* What ties the program to its task, kept from when it starts. */
  workspaceBinding?: ProgramBinding;
  secret: string | null;
  timeoutMs: number;
  /* Aborted when the job is called off, for example when Hornhoof removes the subscription. */
  signal?: AbortSignal;
  /* Standing instructions for the agent, and Hornhoof's MCP server with the job's token. */
  instructions: string | null;
  /* What the agent should know from before, when its program starts a new session. */
  context?: string | null;
  /* Where the agent works, for a program that starts on a turn that types nothing. */
  guidance?: string | null;
  tools: { url: string; token: string } | null;
  /* Each thing the agent does, as the program reports it while it runs. */
  onEvent?: (event: AgentEvent) => void;
  /* More environment for the program, such as git access to the agent's repository for this turn. */
  env?: Record<string, string>;
};
export type RunResult = { ok: boolean; sessionId: string | null; result: string; output: string; error: JobError | null; limits: Limits | null; programOutput?: ProgramOutput; failure?: Failure; wordsWaiting?: boolean };
export type LoginIo = { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; urlFile: string };

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
  /* A terminal inserts carriage returns; hide both the raw and normalized forms before any line is removed. */
  const text = program ? redact(plainOutput(redact(program.text, secrets)), secrets) : res.output;
  const output = program ? programEnded(text, program, program.complete) : text;
  return {
    type: 'job.done', jobId, ok: res.ok, sessionId: res.sessionId,
    result: redact(res.result, secrets), tail: lastBytes(redact(output, secrets)), error: res.error,
    ...(res.wordsWaiting ? { wordsWaiting: true } : {}),
    ...(res.failure ? { failure: { ...res.failure, text: redact(res.failure.text, secrets).slice(0, 2000) } } : {}),
    ...(program ? { exit: { code: program.code, signal: signalName(program.signal) } } : {}),
  };
}

/* The adapter stops its own program at the timeout and says which session it was in, so the next turn goes on in it.
   This only makes sure the job always ends, a while after that. */
function withTimeout(run: Promise<RunResult>, ms: number): Promise<RunResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<RunResult>(done => {
    timer = setTimeout(() => done(failed(`The agent did not finish within ${Math.round(ms / 1000)} s.`, 'timeout')), ms + Math.min(30_000, ms / 10));
  });
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/* An agent's turn works in the agent's own folder; a session this node saved in another folder cannot go on there, so
   the turn starts a new one. Other jobs work in the folder of the session they resume, or a new one. Only sessions this
   node saved count: one from another machine, or from before a fresh volume, is not here to resume, so the turn starts a new one. */
function workDirFor(msg: JobRun, dir: string, programDir: string | null, carries: ReadonlySet<ProviderId>): { workDir: string; sessionId: string | null } {
  const saved = msg.sessionId ? readSessions(dir) : {};
  const known = msg.sessionId && Object.hasOwn(saved, msg.sessionId) ? saved[msg.sessionId] : undefined;
  if (programDir) return { workDir: dirname(programDir), sessionId: sessionInTask(msg, programDir, known, carries) };
  if (msg.workspace) {
    const workDir = join(dir, 'work', 'agents', msg.workspace.key);
    return { workDir, sessionId: known === workDir ? msg.sessionId : null };
  }
  return typeof known === 'string' ? { workDir: known, sessionId: msg.sessionId } : { workDir: join(dir, 'work', msg.jobId), sessionId: null };
}

/* A session goes on in the task's folder it was saved in. From another folder only a program proven to take it along keeps it. */
function sessionInTask(msg: JobRun, programDir: string, known: string | undefined, carries: ReadonlySet<ProviderId>): string | null {
  if (known === programDir) return msg.sessionId;
  return known && carrySession(msg.provider, carries) === 'carried' ? msg.sessionId : null;
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
async function readyFolders(adapter: ProviderAdapter, { provider, skills }: JobRun, workDir: string, programDir: string | null, superpowers: string | null): Promise<void> {
  if (!skills && !programDir) return;
  await withOwnFs(adapter, async own => {
    if (programDir) await readyProgramFolder(own, provider, workDir, programDir, skills ? skillPaths(provider, skills, superpowers) : []);
    if (skills) await placeSkills(own, programDir ?? workDir, provider, skills, superpowers);
  });
}

type TurnPlace = Pick<RunInput, 'workDir' | 'programDir' | 'workspaceBinding'> & { sessionId: string | null; context: string | null };

async function readyWorkDir({ owner }: ProviderAdapter, workDir: string): Promise<void> {
  if (owner?.mkdir) await owner.mkdir(workDir);
  else mkdirSync(workDir, { recursive: true });
  owner?.prepare(workDir);
}

/* A session the program loses with its folder is told of, and what it may know from before goes with the new one. */
const anewInTask = (inTask: ProgramWorkspace | undefined, known: string | null, sessionId: string | null) => (inTask && known && !sessionId ? freshStart(inTask.catchUp) : null);

/* Where a turn runs and what it goes on from, in folders ready for it. */
async function placeOfTurn(adapter: ProviderAdapter, msg: JobRun, dir: string, emit: (event: AgentEvent) => void, { workspace, carries, superpowers }: { workspace: ProgramWorkspace | undefined; carries: ReadonlySet<ProviderId>; superpowers: string | null }): Promise<TurnPlace> {
  const inTask = msg.workspace ? workspace : undefined;
  const programDir = inTask?.programDir ?? null;
  const { workDir, sessionId } = workDirFor(msg, dir, programDir, carries);
  await readyWorkDir(adapter, workDir);
  await readyFolders(adapter, msg, workDir, programDir, superpowers);
  const anew = anewInTask(inTask, msg.sessionId, sessionId);
  if (anew) emit({ kind: 'text', text: anew.note });
  return { workDir, sessionId, context: anew?.context ?? msg.context ?? null, ...(inTask && { programDir: inTask.programDir, workspaceBinding: inTask.binding }) };
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
  /* The superpowers copy whose skills a program without its plugin gets; the image's by default. */
  superpowers?: string | null;
  /* Ensures the repository lockfile's Playwright browsers are ready and launchable before the turn starts. */
  prepareRepoBrowser?: (repoDir: string, verifyUser: JobUser | null) => Promise<void>;
  /* The task's folder this turn runs in. */
  workspace?: ProgramWorkspace;
  /* The programs that take a session along into a task's folder; those a live check proved by default. */
  carries?: ReadonlySet<ProviderId>;
  /* Puts the prepared dependencies of a worktree's commit in it. It says in one line what it put there, or nothing when
     there was nothing to put, and throws what kept it from that. None: the agent installs them itself. */
  dependencies?: (worktree: Worktree, signal?: AbortSignal) => Promise<string | null>;
  /* How long the program waits for them at most, whatever holds them. */
  dependenciesMs?: number;
};

const DEPENDENCIES_MS = 10 * 60_000;
const span = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`);

/* The dependencies of the worktree's commit go in place before its program starts, as its user's own files, so the agent's
   first check finds them there. What keeps them away only leaves the agent to install them, and one line says so. */
async function placeDependencies(adapter: ProviderAdapter, msg: JobRun, place: TurnPlace, { dependencies, dependenciesMs = DEPENDENCIES_MS, git, signal }: Pick<RunOptions, 'dependencies' | 'dependenciesMs' | 'git' | 'signal'>): Promise<string | null> {
  const repo = msg.workspace?.repo, repositoryScope = msg.workspace?.repositoryScope, user = adapter.owner?.user;
  if (!dependencies || !repo || !repositoryScope || !user) return null;
  const checkout = place.programDir ?? join(place.workDir, repoFolder(repo.url));
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

/* An event as people may see it: no secrets, and within the sizes the protocol allows. */
export function tidy(event: AgentEvent, secrets: string[]): AgentEvent {
  const clean = (text: string, max: number) => cut(redact(text, secrets), max);
  switch (event.kind) {
    case 'text':
      return { kind: 'text', text: clean(event.text, 8000) };
    case 'tool':
      return { kind: 'tool', name: clean(event.name, 100), input: clean(event.input, 300) };
    case 'tool_result':
      return { kind: 'tool_result', ok: event.ok, summary: clean(event.summary, 500) };
    case 'todo':
      return { kind: 'todo', items: event.items.slice(0, 20).map(i => ({ text: clean(i.text, 200), state: i.state })) };
  }
}

/* Always ends with a job.done, whatever breaks on the way. */
export async function runJob(adapter: ProviderAdapter, msg: JobRun, dir: string, { hidden = [], signal, toolsUrl, onEvent, git, beforeRun = async () => {}, untimed = false, superpowers = superpowersIn(), prepareRepoBrowser = (repoDir, verifyUser) => ensureRepoBrowser(dir, repoDir, verifyUser), workspace, carries = CARRIES, dependencies, dependenciesMs }: RunOptions = {}): Promise<JobDone> {
  /* Programs refresh their tokens during a run, so the values from before, during and after are all hidden. */
  const before = await adapter.secrets().catch(() => []);
  const repo = msg.workspace?.repo ?? null;
  const given = [...hidden, ...(msg.secret ? [msg.secret] : []), ...(msg.toolToken ? [msg.toolToken] : []), ...(repo?.token ? [repo.token] : [])];
  const tools = msg.toolToken && toolsUrl ? { url: toolsUrl, token: msg.toolToken } : null;
  /* A live event goes out hidden against what the program holds by then, and the events keep their order. */
  const known = new Set([...before, ...given]);
  let live = Promise.resolve();
  const emit = (event: AgentEvent) => {
    live = live
      .then(async () => {
        for (const s of await adapter.secrets().catch(() => [])) known.add(s);
        onEvent?.(tidy(event, [...known]));
      })
      .catch(() => {});
  };
  let res: RunResult;
  try {
    const place = await placeOfTurn(adapter, msg, dir, emit, { workspace, carries, superpowers });
    const repoEnv = repo ? await openRepo(repo, place.workDir, { user: adapter.owner?.user ?? null, home: adapter.owner?.home ?? null }, dir, git, prepareRepoBrowser) : undefined;
    const placed = await placeDependencies(adapter, msg, place, { dependencies, dependenciesMs, git, signal });
    if (placed) emit({ kind: 'text', text: placed });
    /* hh-attach sends the turn's pictures with its token. The name has no KEY, SECRET or TOKEN in it, so Codex passes it on. */
    const attachEnv = tools ? { HH_ATTACH_URL: tools.url.replace(/\/mcp$/, '/api/attachments'), HH_ATTACH_PASS: tools.token } : undefined;
    const env = repoEnv || attachEnv ? { ...repoEnv, ...attachEnv } : undefined;
    const input: RunInput = {
      agentKey: msg.workspace?.key ?? null,
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
      guidance: msg.guidance ?? null,
      tools,
      onEvent: emit,
      ...(env ? { env } : {}),
    };
    await beforeRun();
    const run = adapter.run(input).catch((err: unknown) => failed(message(err), 'agent_failed'));
    res = await (untimed ? run : withTimeout(run, msg.timeoutMs));
    if (res.sessionId) rememberSession(dir, res.sessionId, programDirOf(place));
  } catch (err) {
    res = failed(message(err), 'agent_failed');
  }
  await live;
  /* A job Hornhoof called off ends as cancelled, whatever the stopped program said. */
  if (signal?.aborted) res = { ...res, ok: false, result: 'Stopped.', error: 'cancelled' };
  /* Everything the program held at any point of the run, so a token it had only in between is hidden too. */
  for (const s of await adapter.secrets().catch(() => [])) known.add(s);
  return jobDone(msg.jobId, res, [...known]);
}
