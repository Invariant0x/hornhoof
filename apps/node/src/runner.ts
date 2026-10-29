import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TAIL_BYTES, type JobError, type Limits, type NodeMessage, type ServerMessage } from '@hornhoof/protocol';
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
};

/* Always ends with a job.done, whatever breaks on the way. */
export async function runJob(adapter: ProviderAdapter, msg: JobRun, dir: string, { hidden = [], signal }: RunOptions = {}): Promise<JobDone> {
  /* Programs refresh their tokens during a run, so the values from before and after are both hidden. */
  const before = await adapter.secrets().catch(() => []);
  let res: RunResult;
  try {
    const workDir = workDirFor(msg, dir);
    mkdirSync(workDir, { recursive: true });
    const input = { prompt: msg.prompt, sessionId: msg.sessionId, model: msg.model, workDir, secret: msg.secret, timeoutMs: msg.timeoutMs, signal };
    res = await withTimeout(adapter.run(input).catch((err: unknown) => failed(message(err), 'agent_failed')), msg.timeoutMs);
    if (res.sessionId) rememberSession(dir, res.sessionId, workDir);
  } catch (err) {
    res = failed(message(err), 'agent_failed');
  }
  const after = await adapter.secrets().catch(() => []);
  const secrets = [...before, ...after, ...hidden, ...(msg.secret ? [msg.secret] : [])];
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
