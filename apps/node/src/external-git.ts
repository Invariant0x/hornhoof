import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';
import { canonicalJson, ExternalGitIntent, type ExternalConsumer, type ExternalGitOutcome } from '@hornhoof/protocol';
import { z } from 'zod';
import type { JobUser } from './isolation.js';
import { GitCredentialMask, gitEnv, gitPreparationFailure } from './workspace.js';

/* The node's side of hh-git: one typed push or fetch of the agent's current job, run by the node so that what reaches the
   server is what the node saw of its own child. No command line comes in and no secret goes out. Hornhoof's server decides
   whether and when an attempt may run; nothing here retries by itself. With no port the wire is off: the shim is told
   so and runs plain git. */

const REAL_GIT = '/usr/bin/git';
const HELD_BYTES = 8 * 1024 * 1024;
const STDERR_TAIL = 8192;
const KEPT_RECEIPTS = 32;
const EXIT_GRACE_MS = 2000;
const STOP_GRACE_MS = 5000;
const READ_MS = 60_000;
const BRANCH_PREFIX = 'refs/heads/';
const SEEMS_DONE = 'the remote already has this commit on the branch, so nothing more was sent.';

const Commit = z.string().regex(/^[a-f0-9]{40}$/);
const Flags = z.array(z.enum(['--quiet', '--verbose', '--progress', '--no-progress', '--porcelain', '--no-verify', '--no-tags'])).max(8);
const Folder = z.string().min(1).max(4096).refine(value => value.startsWith('/') && !value.includes('\0'));
const Name = z.string().max(1024).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
const GitRequest = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('push'), cwd: Folder, remote: Name, sourceSha: Commit, destinationRef: z.string().max(1024).startsWith(BRANCH_PREFIX), upstreamBranch: Name.nullable(), flags: Flags }),
  z.strictObject({ kind: z.literal('fetch'), cwd: Folder, remote: Name, refspec: z.string().max(2100).regex(/^[A-Za-z0-9][A-Za-z0-9._/:-]*$/), flags: Flags }),
]);
type GitRequest = z.infer<typeof GitRequest>;
type PushRequest = Extract<GitRequest, { kind: 'push' }>;
type ChildOutcome = Extract<ExternalGitOutcome, { kind: 'child' }>;

export type GitOperationState = 'ready' | 'executing' | 'deferred' | 'outcome_unknown' | 'satisfied' | 'failed_permanent' | 'cancelled';
/* An attempt exists only when the server admits one. */
export type GitGrant =
  | { generation: number; disposition: 'execute'; attemptId: string }
  | { generation: number; disposition: 'wait'; attemptId?: null; nextAttemptAt?: string | null }
  | { generation: number; disposition: 'terminal'; attemptId?: null; state: GitOperationState };
export type GitRegistration = GitGrant & { operationId: string };
export type GitRecord = { operationId: string; generation: number; attemptId: string; outcome: ExternalGitOutcome; settled: boolean; receiptDigest: string; observedHead?: string | null };
export type GitRecordReply = { accepted: boolean; state: GitOperationState; releaseRevision?: number; nextAttemptAt?: string | null };

/* The contract agreed for #558 and #559, not a compiled transport yet: the real server sides this from its own checks. */
export type GitOperationPort = {
  register(input: { operationId: string; intentDigest: string; intent: ExternalGitIntent; consumer: ExternalConsumer }): Promise<GitRegistration>;
  record(input: GitRecord): Promise<GitRecordReply>;
  ready(operationId: string, signal: AbortSignal): Promise<GitGrant>;
  cancel(input: { operationId: string; generation: number }): Promise<void>;
};

/* From the server's assignment of this job. Neither id is worked out here: an address or a path is not an assignment. */
export type GitJob = { jobId: string; repositoryId: string; workspaceBinding: string; url: string; token(): string | null; user: JobUser | null; home: string | null };
export type GitMarker = { operationId: string; generation: number; state: GitOperationState };
type Kill = (pid: number | undefined, signal: NodeJS.Signals) => void;
export type GitAdapterOptions = { port: GitOperationPort | null; git?: string; heldBytes?: number; keptReceipts?: number; exitGraceMs?: number; stopGraceMs?: number; kill?: Kill };

type Chunk = { type: 'stdout' | 'stderr'; data: Buffer };
type Exit = { code: number | null; signal: string | null };
type ChildSpec = { binary: string; args: string[]; job: GitJob; signal: AbortSignal; limit: number; exitGraceMs: number; stopGraceMs: number; kill: Kill };
type Attempt = { chunks: Chunk[]; shortened: boolean; outcome: ChildOutcome; settled: boolean; ok: boolean; exit: Exit };
type Operation = {
  key: string; job: GitJob; request: GitRequest; operationId: string; generation: number; endpoint: string; consumer: ExternalConsumer;
  ended: AbortController; signal: AbortSignal; res: ServerResponse; last: Attempt | null; waited: boolean; state: 'running' | 'waiting';
};

type Admitted = { request: GitRequest; job: GitJob; intent: ExternalGitIntent };

/* A repository's settings can run commands, so git of an agent's folder never runs as root. */
const runsAsRoot = (job: GitJob): boolean => (job.user?.uid ?? process.getuid?.()) === 0;
const digest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
const decode = (attempt: Attempt, type: Chunk['type']): string => Buffer.concat(attempt.chunks.filter(chunk => chunk.type === type).map(chunk => chunk.data)).toString('utf8');
const encodedText = (text: string): string => Buffer.from(text).toString('base64');

const fullRef = (name: string): string => (name === 'HEAD' || name.startsWith('refs/') ? name : `${BRANCH_PREFIX}${name}`);

/* What a fetch asks for, without asking the remote. Its literal spelling stays what runs on every attempt. */
export function fetchTarget(refspec: string): Extract<ExternalGitIntent, { kind: 'git_fetch' }>['target'] {
  const [source = '', destination] = refspec.split(/:(.*)/s);
  if (Commit.safeParse(source).success && destination === undefined) return { kind: 'commit', commitSha: source };
  return { kind: 'refspec', sourceRef: fullRef(source), ...(destination === undefined ? {} : { destinationRef: fullRef(destination) }) };
}

function intentFor(request: GitRequest, repositoryId: string): ExternalGitIntent | null {
  const asked = request.kind === 'push'
    ? { kind: 'git_push', repositoryId, sourceSha: request.sourceSha, destinationRef: request.destinationRef }
    : { kind: 'git_fetch', repositoryId, target: fetchTarget(request.refspec) };
  const parsed = ExternalGitIntent.safeParse(asked);
  return parsed.success ? parsed.data : null;
}

function parseRequest(body: Buffer): GitRequest | null {
  try {
    const parsed = GitRequest.safeParse(JSON.parse(body.toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function attemptArgs(request: GitRequest): string[] {
  return request.kind === 'push'
    ? ['push', ...request.flags, request.remote, `${request.sourceSha}:${request.destinationRef}`]
    : ['fetch', ...request.flags, request.remote, request.refspec];
}

const MARKER = /^hornhoof-git: operation=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) generation=([1-9][0-9]{0,8}) state=(ready|executing|deferred|outcome_unknown|satisfied|failed_permanent|cancelled)$/;

/* Telemetry only: the same line can come from any command. GitAdapter.proves is what answers whether it is true. */
export function parseGitMarker(line: string): GitMarker | null {
  const found = MARKER.exec(line);
  return found ? { operationId: found[1]!, generation: Number(found[2]), state: found[3] as GitOperationState } : null;
}

/* The newest output of a child within its bound, in the order it came, until Hornhoof knows whether to show it. */
class HeldOutput {
  readonly chunks: Chunk[] = [];
  shortened = false;
  private bytes = 0;

  constructor(private readonly limit: number) {}

  add(type: Chunk['type'], data: Buffer): void {
    this.chunks.push({ type, data });
    this.bytes += data.length;
    while (this.bytes > this.limit && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift()!.data.length;
      this.shortened = true;
    }
  }
}

/* The end of what a child said on stderr, with the credential gone before anything is cut. */
class StderrTail {
  private text = '';
  private truncated = false;
  private readonly mask: GitCredentialMask;

  constructor(private readonly secret: string) { this.mask = new GitCredentialMask([secret]); }

  add(data: Buffer): void { this.keep(this.mask.push(data.toString('utf8'))); }

  private keep(more: string): void {
    const joined = this.text + more;
    this.truncated ||= joined.length > STDERR_TAIL;
    this.text = joined.slice(-STDERR_TAIL);
  }

  outcome(exit: Exit, osCode: string | null): ChildOutcome {
    this.keep(this.mask.flush());
    return gitPreparationFailure({ kind: 'child', exitCode: exit.code, signal: exit.signal, osCode, stderr: this.text, stderrTruncated: this.truncated }, true, [this.secret]).outcome;
  }
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  try { if (pid) process.kill(-pid, signal); } catch { /* Already gone. */ }
}

function childEnv(job: GitJob, secret: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: job.home ?? process.env.HOME ?? '/', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HH_GIT_NESTED: '1', ...gitEnv({ url: job.url, token: secret }) };
}

function attemptOf(held: HeldOutput, tail: StderrTail, exit: Exit, osCode: string | null, settled: boolean): Attempt {
  return { chunks: held.chunks, shortened: held.shortened, outcome: tail.outcome(exit, osCode), settled, ok: exit.code === 0 && exit.signal === null && osCode === null, exit: osCode ? { code: 127, signal: null } : exit };
}

const NOT_ENDED: Exit = { code: null, signal: null };
const osCodeOf = (error: NodeJS.ErrnoException): string => String(error.code ?? 'UNKNOWN').slice(0, 64);

function stopChild(spec: ChildSpec, pid: number | undefined, later: (ms: number, work: () => void) => void, giveUp: () => void): void {
  spec.kill(pid, 'SIGTERM');
  later(spec.stopGraceMs, () => {
    spec.kill(pid, 'SIGKILL');
    later(spec.stopGraceMs, giveUp);
  });
}

function settleChild(child: ChildProcessByStdio<null, Readable, Readable>, spec: ChildSpec, held: HeldOutput, tail: StderrTail): Promise<Attempt> {
  const { signal } = spec;
  child.stdout.on('data', (data: Buffer) => held.add('stdout', data));
  child.stderr.on('data', (data: Buffer) => { held.add('stderr', data); tail.add(data); });
  return new Promise(resolve => {
    const timers: NodeJS.Timeout[] = [];
    const later = (ms: number, work: () => void) => { timers.push(setTimeout(work, ms)); };
    const finish = (exit: Exit, osCode: string | null, settled: boolean) => {
      for (const timer of timers) clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      resolve(attemptOf(held, tail, exit, osCode, settled));
    };
    const stop = () => stopChild(spec, child.pid, later, () => finish(NOT_ENDED, null, false));
    signal.addEventListener('abort', stop, { once: true });
    child.once('error', (error: NodeJS.ErrnoException) => finish(NOT_ENDED, osCodeOf(error), true));
    /* A daemon git left behind can hold the pipes for hours; the child itself has ended. */
    child.once('exit', (code, exitSignal) => later(spec.exitGraceMs, () => finish({ code, signal: exitSignal }, null, true)));
    child.once('close', (code, exitSignal) => finish({ code, signal: exitSignal }, null, true));
    if (signal.aborted) stop();
  });
}

/* A child the node owns. The credential is looked up for this run alone. Settled means it was seen to end; a child that
   will not end even after a kill stays unsettled, which never admits a new writer. */
function runChild(spec: ChildSpec): Promise<Attempt> {
  const secret = spec.job.token() ?? '';
  const held = new HeldOutput(spec.limit), tail = new StderrTail(secret);
  try {
    const child = spawn(spec.binary, spec.args, { cwd: '/', uid: spec.job.user?.uid, gid: spec.job.user?.gid, env: childEnv(spec.job, secret), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return settleChild(child, spec, held, tail);
  } catch (error) {
    return Promise.resolve(attemptOf(held, tail, NOT_ENDED, osCodeOf(error as NodeJS.ErrnoException), true));
  }
}

function send(res: ServerResponse, frame: object): Promise<void> {
  if (res.destroyed || res.writableEnded || res.write(`${JSON.stringify(frame)}\n`)) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { res.removeListener('drain', done); res.removeListener('close', done); resolve(); };
    res.once('drain', done);
    res.once('close', done);
  });
}

const sendError = (res: ServerResponse, text: string): Promise<void> => send(res, { type: 'stderr', data: encodedText(text) });

async function release(res: ServerResponse, attempt: Attempt): Promise<void> {
  if (attempt.shortened) await send(res, { type: 'progress', text: 'output shortened: only the end of it was kept.' });
  for (const chunk of attempt.chunks) await send(res, { type: chunk.type, data: chunk.data.toString('base64') });
}

/* A settled unknown with a readable target is the author's to see. Only an unread target can still become known. */
function waitReason(reply: GitRecordReply, attempt: Attempt, observedHead: string | null | undefined): 'deferred' | 'unknown' | null {
  if (!reply.accepted) return null;
  if (reply.state === 'deferred') return 'deferred';
  return reply.state === 'outcome_unknown' && observedHead === undefined && !attempt.ok ? 'unknown' : null;
}

export class GitAdapter {
  private readonly jobs = new Map<string, GitJob>();
  private readonly active = new Map<string, Set<Operation>>();
  private readonly receipts = new Map<string, GitMarker[]>();

  constructor(private readonly options: GitAdapterOptions) {}

  /* The job the agent runs now. A different job ends what the one before was waiting for. */
  bind(key: string, job: GitJob): void {
    if (this.jobs.get(key)?.jobId !== job.jobId) this.forget(key);
    this.jobs.set(key, job);
  }

  unbind(key: string): void {
    this.forget(key);
    this.jobs.delete(key);
  }

  stop(): void {
    for (const key of [...this.jobs.keys()]) this.unbind(key);
  }

  private forget(key: string): void {
    for (const operation of this.active.get(key) ?? []) operation.ended.abort();
    this.receipts.delete(key);
  }

  /* What the node itself is doing for this agent now. Nothing a command prints can add to it. */
  operations(key: string): Array<{ operationId: string; state: Operation['state'] }> {
    return [...(this.active.get(key) ?? [])].map(({ operationId, state }) => ({ operationId, state }));
  }

  proves(key: string, marker: GitMarker): boolean {
    return (this.receipts.get(key) ?? []).some(known => known.operationId === marker.operationId && known.generation === marker.generation && known.state === marker.state);
  }

  async serve(key: string, body: Buffer, signal: AbortSignal, res: ServerResponse): Promise<void> {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.flushHeaders();
    const opened = await this.open(key, body, signal, res);
    if ('reason' in opened) await send(res, { type: 'unmanaged', reason: opened.reason });
    else await send(res, { type: 'exit', ...(await this.follow(opened.operation, opened.first)) });
    res.end();
  }

  /* What can be turned down without running anything. */
  private admit(key: string, body: Buffer): { reason: string } | Admitted {
    if (!this.options.port) return { reason: 'adapter_off' };
    const request = parseRequest(body), job = this.jobs.get(key);
    if (!request) return { reason: 'invalid_request' };
    if (!job) return { reason: 'no_current_job' };
    if (runsAsRoot(job)) return { reason: 'no_agent_user' };
    const intent = intentFor(request, job.repositoryId);
    return intent ? { request, job, intent } : { reason: 'invalid_request' };
  }

  private async open(key: string, body: Buffer, signal: AbortSignal, res: ServerResponse): Promise<{ reason: string } | { operation: Operation; first: GitRegistration }> {
    const admitted = this.admit(key, body);
    if ('reason' in admitted) return admitted;
    const { request, job, intent } = admitted;
    const endpoint = await this.endpoint(request, job, signal);
    if (endpoint !== job.url) return { reason: 'foreign_endpoint' };
    const operationId = randomUUID(), consumer: ExternalConsumer = { kind: 'agent_job', jobId: job.jobId, workspaceBinding: job.workspaceBinding };
    try {
      const first = await this.options.port!.register({ operationId, intentDigest: digest(intent), intent, consumer });
      const ended = new AbortController();
      return { first, operation: { key, job, request, operationId, generation: first.generation, endpoint, consumer, ended, signal: AbortSignal.any([signal, ended.signal]), res, last: null, waited: false, state: 'running' } };
    } catch {
      return { reason: 'port_unavailable' };
    }
  }

  private child(request: GitRequest, job: GitJob, signal: AbortSignal, args: string[], limit = STDERR_TAIL * 8): Promise<Attempt> {
    const { git = REAL_GIT, exitGraceMs = EXIT_GRACE_MS, stopGraceMs = STOP_GRACE_MS, kill = killGroup } = this.options;
    return runChild({ binary: git, args: ['-C', request.cwd, ...args], job, signal, limit, exitGraceMs, stopGraceMs, kill });
  }

  private async read(request: GitRequest, job: GitJob, signal: AbortSignal, args: string[]): Promise<string | null> {
    const done = await this.child(request, job, AbortSignal.any([signal, AbortSignal.timeout(READ_MS)]), args);
    return done.ok ? decode(done, 'stdout').trim() : null;
  }

  private endpoint(request: GitRequest, job: GitJob, signal: AbortSignal): Promise<string | null> {
    return this.read(request, job, signal, ['remote', 'get-url', ...(request.kind === 'push' ? ['--push'] : []), '--all', request.remote]);
  }

  private async follow(operation: Operation, first: GitGrant): Promise<Exit> {
    const known = this.active.get(operation.key) ?? new Set<Operation>();
    this.active.set(operation.key, known);
    known.add(operation);
    try {
      return await this.drive(operation, first);
    } catch {
      return await this.stopped(operation);
    } finally {
      known.delete(operation);
      if (!known.size && this.active.get(operation.key) === known) this.active.delete(operation.key);
    }
  }

  private async drive(operation: Operation, first: GitGrant): Promise<Exit> {
    let grant = first;
    for (;;) {
      operation.generation = grant.generation;
      if (grant.disposition === 'terminal') return await this.ended(operation, grant.state);
      if (grant.disposition === 'execute') {
        const exit = await this.execute(operation, grant);
        if (exit) return exit;
      } else await this.waiting(operation, 'deferred', grant.nextAttemptAt ?? null);
      operation.state = 'waiting';
      grant = await this.options.port!.ready(operation.operationId, operation.signal);
    }
  }

  private async execute(operation: Operation, grant: Extract<GitGrant, { disposition: 'execute' }>): Promise<Exit | null> {
    operation.signal.throwIfAborted();
    /* Another job would have ended this operation, so this is the same job with what it holds now. */
    operation.job = this.jobs.get(operation.key) ?? operation.job;
    const previous = operation.last;
    if (previous) {
      if (await this.endpoint(operation.request, operation.job, operation.signal) !== operation.endpoint) return await this.remoteChanged(operation);
      const already = await this.alreadyThere(operation);
      if (already) return await this.judge(operation, await this.report(operation, grant, previous, already), previous, already);
    }
    operation.state = 'running';
    const attempt = await this.child(operation.request, operation.job, operation.signal, attemptArgs(operation.request), this.options.heldBytes ?? HELD_BYTES);
    operation.last = attempt;
    const observedHead = await this.observe(operation, attempt);
    const reply = await this.report(operation, grant, attempt, observedHead);
    operation.signal.throwIfAborted();
    return await this.judge(operation, reply, attempt, observedHead);
  }

  /* Before a push goes out again: the commit may have reached the branch when the answer to the last attempt got lost. */
  private async alreadyThere(operation: Operation): Promise<string | null> {
    if (operation.request.kind !== 'push') return null;
    const head = await this.exactRef(operation, operation.request);
    return head === operation.request.sourceSha ? head : null;
  }

  private async exactRef(operation: Operation, request: PushRequest): Promise<string | null | undefined> {
    const listed = await this.read(request, operation.job, operation.signal, ['ls-remote', request.remote, request.destinationRef]);
    if (listed === null) return undefined;
    /* ls-remote matches the end of a name too, so another ref can end the same way. */
    const exact = listed.split('\n').map(line => line.split('\t')).find(([, ref]) => ref === request.destinationRef);
    return exact?.[0] ?? null;
  }

  private async fetched(operation: Operation): Promise<string | undefined> {
    return (await this.read(operation.request, operation.job, operation.signal, ['rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}'])) ?? undefined;
  }

  private async observe(operation: Operation, attempt: Attempt): Promise<string | null | undefined> {
    if (operation.signal.aborted) return undefined;
    if (operation.request.kind === 'fetch') return attempt.ok ? await this.fetched(operation) : undefined;
    return attempt.ok ? undefined : await this.exactRef(operation, operation.request);
  }

  private async report(operation: Operation, grant: Extract<GitGrant, { disposition: 'execute' }>, attempt: Attempt, observedHead: string | null | undefined): Promise<GitRecordReply> {
    const { operationId, generation, consumer, key } = operation;
    const receiptDigest = digest({ agent: key, operationId, generation, attemptId: grant.attemptId, consumer, outcome: attempt.outcome, settled: attempt.settled, observed: observedHead === undefined ? 'unread' : observedHead });
    try {
      return await this.options.port!.record({ operationId, generation, attemptId: grant.attemptId, outcome: attempt.outcome, settled: attempt.settled, receiptDigest, ...(observedHead === undefined ? {} : { observedHead }) });
    } catch {
      return { accepted: false, state: 'outcome_unknown' };
    }
  }

  private async judge(operation: Operation, reply: GitRecordReply, attempt: Attempt, observedHead: string | null | undefined): Promise<Exit | null> {
    const why = waitReason(reply, attempt, observedHead);
    if (!why) return await this.conclude(operation, reply.accepted ? reply.state : 'outcome_unknown', attempt, reply.accepted);
    await this.waiting(operation, why, reply.nextAttemptAt ?? null);
    return null;
  }

  private async waiting(operation: Operation, why: 'deferred' | 'unknown', next: string | null): Promise<void> {
    operation.waited = true;
    const opening = why === 'unknown' ? 'the result of this push is not known yet because the remote branch could not be read.' : 'the remote Git service refused or did not answer.';
    const when = next ? ` Next check: ${next}.` : '';
    await send(operation.res, { type: 'progress', text: `${opening} This command keeps waiting and finishes by itself; there is nothing to do and nothing to investigate.${when}` });
  }

  private async conclude(operation: Operation, state: GitOperationState, attempt: Attempt, accepted: boolean): Promise<Exit> {
    const satisfied = state === 'satisfied';
    if (accepted) this.remember(operation, state);
    if (satisfied && !attempt.ok) await send(operation.res, { type: 'progress', text: SEEMS_DONE });
    else await release(operation.res, attempt);
    if (satisfied) await this.track(operation);
    if (operation.waited || !satisfied || !attempt.ok) await this.mark(operation, state);
    return satisfied ? { code: 0, signal: null } : attempt.exit;
  }

  /* git push -u cannot set this up for a fixed commit, so it follows here, with the words git prints for it. */
  private async track(operation: Operation): Promise<void> {
    const { request } = operation;
    if (request.kind !== 'push' || !request.upstreamBranch) return;
    const quiet = request.flags.includes('--quiet') ? ['--quiet'] : [];
    const tracking = `${request.remote}/${request.destinationRef.slice(BRANCH_PREFIX.length)}`;
    const done = await this.child(request, operation.job, operation.signal, ['branch', ...quiet, `--set-upstream-to=${tracking}`, request.upstreamBranch]);
    await release(operation.res, done);
  }

  private remember(operation: Operation, state: GitOperationState): void {
    const kept = this.receipts.get(operation.key) ?? [];
    kept.push({ operationId: operation.operationId, generation: operation.generation, state });
    this.receipts.set(operation.key, kept.slice(-(this.options.keptReceipts ?? KEPT_RECEIPTS)));
  }

  private mark(operation: Operation, state: GitOperationState): Promise<void> {
    return send(operation.res, { type: 'marker', operationId: operation.operationId, generation: operation.generation, state });
  }

  private async ended(operation: Operation, state: GitOperationState): Promise<Exit> {
    if (operation.last) return await this.conclude(operation, state, operation.last, true);
    this.remember(operation, state);
    const satisfied = state === 'satisfied';
    if (!satisfied) await sendError(operation.res, 'fatal: Hornhoof ended this git operation without running it.\n');
    await this.mark(operation, state);
    return { code: satisfied ? 0 : 1, signal: null };
  }

  private async cancelled(operation: Operation): Promise<void> {
    await this.options.port!.cancel({ operationId: operation.operationId, generation: operation.generation }).catch(() => {});
  }

  private async remoteChanged(operation: Operation): Promise<Exit> {
    await this.cancelled(operation);
    await sendError(operation.res, 'fatal: the remote changed while this git command was waiting, so nothing more was sent.\n');
    return { code: 128, signal: null };
  }

  private async stopped(operation: Operation): Promise<Exit> {
    await this.cancelled(operation);
    const why = operation.ended.signal.aborted ? 'the turn ended while this git command was waiting' : 'Hornhoof stopped waiting for this git command';
    await sendError(operation.res, `fatal: ${why}, so nothing more was sent.\n`);
    return { code: 128, signal: null };
  }
}
