import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cut, TAIL_BYTES, type AgentEvent, type JobError, type Limits, type NodeMessage, type ServerMessage } from '@hornhoof/protocol';
import { redact } from './redact.js';
import { readSessions, rememberSession } from './state.js';

export type RunInput = {
  prompt: string;
  sessionId: string | null;
  model: string | null;
  workDir: string;
  secret: string | null;
  timeoutMs: number;
  /* Aborted when the job is called off, for example when Hornhoof removes the subscription. */
  signal?: AbortSignal;
  /* Standing instructions for the agent, and Hornhoof's MCP server with the job's token. */
  instructions: string | null;
  tools: { url: string; token: string } | null;
  /* Each thing the agent does, as the program reports it while it runs. */
  onEvent?: (event: AgentEvent) => void;
};
export type RunResult = { ok: boolean; sessionId: string | null; result: string; output: string; error: JobError | null; limits: Limits | null };
export type LoginIo = { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; urlFile: string };

/* One agent program (Claude Code, Codex, Kimi) as the node drives it. */
export interface ProviderAdapter {
  install(): Promise<void>;
  loggedIn(): Promise<boolean>;
  login(io: LoginIo): Promise<void>;
  run(input: RunInput): Promise<RunResult>;
  /* Values that must never leave the node, such as the tokens in the program's credentials file. */
  secrets(): Promise<string[]>;
}

type JobRun = Extract<ServerMessage, { type: 'job.run' }>;
type JobDone = Extract<NodeMessage, { type: 'job.done' }>;

const failed = (output: string, error: JobError): RunResult => ({ ok: false, sessionId: null, result: '', output, error, limits: null });

function lastBytes(text: string, bytes: number): string {
  const buf = Buffer.from(text);
  return buf.length <= bytes ? text : buf.subarray(buf.length - bytes).toString();
}

/* The adapter stops its own program at the timeout; this only makes sure the job always ends. */
function withTimeout(run: Promise<RunResult>, ms: number): Promise<RunResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<RunResult>(done => {
    timer = setTimeout(() => done(failed(`The agent did not finish within ${Math.round(ms / 1000)} s.`, 'timeout')), ms);
  });
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/* The folder a saved session works in, or a new one for this job. Only sessions this node saved count. */
function workDirFor(msg: JobRun, dir: string): string {
  const saved = msg.sessionId ? readSessions(dir) : {};
  const known = msg.sessionId && Object.hasOwn(saved, msg.sessionId) ? saved[msg.sessionId] : undefined;
  return typeof known === 'string' ? known : join(dir, 'work', msg.jobId);
}

type RunOptions = {
  /* More values to hide, such as the node's own key. */
  hidden?: string[];
  signal?: AbortSignal;
  /* Where agents reach Hornhoof's tools: <server>/mcp. */
  toolsUrl?: string;
  onEvent?: (event: AgentEvent) => void;
};

/* An event as people may see it: no secrets, and within the sizes the protocol allows. */
function tidy(event: AgentEvent, secrets: string[]): AgentEvent {
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
export async function runJob(adapter: ProviderAdapter, msg: JobRun, dir: string, { hidden = [], signal, toolsUrl, onEvent }: RunOptions = {}): Promise<JobDone> {
  /* Programs refresh their tokens during a run, so the values from before and after are both hidden. */
  const before = await adapter.secrets().catch(() => []);
  const given = [...hidden, ...(msg.secret ? [msg.secret] : []), ...(msg.toolToken ? [msg.toolToken] : [])];
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
    const workDir = workDirFor(msg, dir);
    mkdirSync(workDir, { recursive: true });
    const input: RunInput = {
      prompt: msg.prompt,
      sessionId: msg.sessionId,
      model: msg.model,
      workDir,
      secret: msg.secret,
      timeoutMs: msg.timeoutMs,
      signal,
      instructions: msg.instructions,
      tools,
      onEvent: emit,
    };
    res = await withTimeout(adapter.run(input).catch((err: unknown) => failed(message(err), 'agent_failed')), msg.timeoutMs);
    if (res.sessionId) rememberSession(dir, res.sessionId, workDir);
  } catch (err) {
    res = failed(message(err), 'agent_failed');
  }
  await live;
  /* A job Hornhoof called off ends as cancelled, whatever the stopped program said. */
  if (signal?.aborted) res = { ...res, ok: false, result: 'Stopped.', error: 'cancelled' };
  const after = await adapter.secrets().catch(() => []);
  const secrets = [...before, ...after, ...given];
  return {
    type: 'job.done',
    jobId: msg.jobId,
    ok: res.ok,
    sessionId: res.sessionId,
    result: redact(res.result, secrets),
    tail: lastBytes(redact(res.output, secrets), TAIL_BYTES),
    error: res.error,
  };
}
