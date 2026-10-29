import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TAIL_BYTES, type JobError, type Limits, type NodeMessage, type ServerMessage } from '@hornhoof/protocol';
import { redact } from './redact.js';
import { readSessions, rememberSession } from './state.js';

export type RunInput = { prompt: string; sessionId: string | null; model: string | null; workDir: string; secret: string | null; timeoutMs: number };
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

export async function runJob(adapter: ProviderAdapter, msg: JobRun, dir: string): Promise<JobDone> {
  const workDir = (msg.sessionId && readSessions(dir)[msg.sessionId]) || join(dir, 'work', msg.jobId);
  mkdirSync(workDir, { recursive: true });
  const input = { prompt: msg.prompt, sessionId: msg.sessionId, model: msg.model, workDir, secret: msg.secret, timeoutMs: msg.timeoutMs };
  const res = await withTimeout(
    adapter.run(input).catch((err: unknown) => failed(err instanceof Error ? err.message : String(err), 'agent_failed')),
    msg.timeoutMs,
  );
  if (res.sessionId) rememberSession(dir, res.sessionId, workDir);
  const secrets = [...(await adapter.secrets().catch(() => [])), ...(msg.secret ? [msg.secret] : [])];
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
