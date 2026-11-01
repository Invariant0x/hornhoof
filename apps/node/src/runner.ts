import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cut, lastBytes, type AgentEvent, type JobError, type Limits, type ModelOption, type NodeMessage, type ServerMessage } from '@hornhoof/protocol';
import type { JobUser } from './isolation.js';
import { redact } from './redact.js';
import { plainOutput, programEnded, type ProgramOutput } from './program-exit.js';
import { readSessions, rememberSession } from './state.js';
import { prepareRepo, type Git } from './workspace.js';

export type RunInput = {
  /* The agent whose turn this is, from its workspace; a test job has none. */
  agentKey?: string | null;
  prompt: string;
  sessionId: string | null;
  model: string | null;
  /* How hard the model thinks, as its program names it; none leaves it at the program's default. */
  effort?: string | null;
  /* How full Claude Code's context gets before it compacts the conversation; none leaves it at the program's own. */
  compactWindow?: number | null;
  workDir: string;
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
export type RunResult = { ok: boolean; sessionId: string | null; result: string; output: string; error: JobError | null; limits: Limits | null; programOutput?: ProgramOutput };
export type LoginIo = { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; urlFile: string };

/* One agent program (Claude Code, Codex, Kimi) as the node drives it. */
export interface ProviderAdapter {
  install(): Promise<void>;
  loggedIn(): Promise<boolean>;
  login(io: LoginIo): Promise<void>;
  run(input: RunInput): Promise<RunResult>;
  /* Values that must never leave the node, such as the tokens in the program's credentials file. */
  secrets(): Promise<string[]>;
  /* The models the program can run, when it can tell. Hornhoof falls back to what it knows for the provider. */
  models?(): Promise<ModelOption[]>;
  /* The plan's limits now, asked without a turn, or null when the program cannot tell at the moment. */
  limits?(): Promise<Limits | null>;
  /* On the built-in node, the user a key's program runs as and its home: the folder is handed to that user first,
     and the node's own git work in it runs as that user too. */
  /* mkdir: how a node that runs as root makes an agent's folders as the agents' own user. */
  owner?: { user: JobUser | null; home: string; prepare(path: string): void; mkdir?(path: string): Promise<void> };
}

type JobRun = Extract<ServerMessage, { type: 'job.run' }>;
type JobDone = Extract<NodeMessage, { type: 'job.done' }>;

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
function workDirFor(msg: JobRun, dir: string): { workDir: string; sessionId: string | null } {
  const saved = msg.sessionId ? readSessions(dir) : {};
  const known = msg.sessionId && Object.hasOwn(saved, msg.sessionId) ? saved[msg.sessionId] : undefined;
  if (msg.workspace) {
    const workDir = join(dir, 'work', 'agents', msg.workspace.key);
    return { workDir, sessionId: known === workDir ? msg.sessionId : null };
  }
  return typeof known === 'string' ? { workDir: known, sessionId: msg.sessionId } : { workDir: join(dir, 'work', msg.jobId), sessionId: null };
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
  /* The turn runs in a live program that people watch: only its own end or a stop ends it, never a time limit. */
  untimed?: boolean;
};

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
export async function runJob(adapter: ProviderAdapter, msg: JobRun, dir: string, { hidden = [], signal, toolsUrl, onEvent, git, untimed = false }: RunOptions = {}): Promise<JobDone> {
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
    const { workDir, sessionId } = workDirFor(msg, dir);
    if (adapter.owner?.mkdir) await adapter.owner.mkdir(workDir);
    else mkdirSync(workDir, { recursive: true });
    adapter.owner?.prepare(workDir);
    const repoEnv = repo ? await prepareRepo(workDir, repo, { user: adapter.owner?.user ?? null, home: adapter.owner?.home ?? null }, git) : undefined;
    /* hh-attach sends the turn's pictures with its token. The name has no KEY, SECRET or TOKEN in it, so Codex passes it on. */
    const attachEnv = tools ? { HH_ATTACH_URL: tools.url.replace(/\/mcp$/, '/api/attachments'), HH_ATTACH_PASS: tools.token } : undefined;
    const env = repoEnv || attachEnv ? { ...repoEnv, ...attachEnv } : undefined;
    const input: RunInput = {
      agentKey: msg.workspace?.key ?? null,
      prompt: msg.prompt,
      sessionId,
      model: msg.model,
      effort: msg.effort ?? null,
      compactWindow: msg.compactWindow ?? null,
      workDir,
      secret: msg.secret,
      timeoutMs: msg.timeoutMs,
      signal,
      instructions: msg.instructions,
      context: msg.context ?? null,
      guidance: msg.guidance ?? null,
      tools,
      onEvent: emit,
      ...(env ? { env } : {}),
    };
    const run = adapter.run(input).catch((err: unknown) => failed(message(err), 'agent_failed'));
    res = await (untimed ? run : withTimeout(run, msg.timeoutMs));
    if (res.sessionId) rememberSession(dir, res.sessionId, workDir);
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
