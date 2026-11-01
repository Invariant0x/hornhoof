import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type Phase = 'launch' | 'ready' | 'accept' | 'done';
export type Finish = 'ready_deadline' | 'ready_signed_out' | 'ready_pane_dead' | 'ready_query_failed' | 'ready_unknown' | 'accept_deadline' | 'wire_completed' | 'wire_failed' | 'pane_dead' | 'pane_query_failed' | 'pane_unknown' | 'cancelled' | 'start_only' | 'superseded' | 'host_exception' | 'runner_exception' | 'runner_result';
export type WaitResult = 'matched' | 'deadline' | 'signed_out' | 'pane_dead' | 'query_failed' | 'unknown' | 'accepted' | 'ended' | 'aborted' | 'completed' | 'failed';
export type Ack = 'hook' | 'wire.turn.prompt' | 'rollout.task_started' | 'ended' | 'aborted' | 'pane_dead' | 'query_failed' | 'unknown';
export type PaneObservation = { queryOk: boolean; paneDead: boolean | null; queryError: 'query_failed' | 'invalid_reply' | null };
export type WireObservation = { source: 'kimi_wire' | 'codex_rollout' | 'claude_transcript'; pathHash: string | null; sessionHash: string | null; sizeBefore: number | null; sizeAfter: number | null; recordType: 'turn.prompt' | 'turn.ended' | 'prompt.completed' | 'context.append_loop_event' | 'event_msg' | 'session_meta' | 'other' };
type PersistCode = 'ok' | 'not_saved' | 'unsafe_path' | 'unsupported_fs' | 'io_error' | 'partial_write' | 'conflict' | 'size_limit' | 'record_limit';
type Receipt = { durable: boolean; code: PersistCode; hash: string | null; seq: number };
type Wait = { startedAtUtc: string; endedAtUtc: string | null; budgetMs: number | null; result: WaitResult | null };

export const PHASE_BYTES = 16 * 1024;
export const PHASE_RECORDS = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const count = (n: number) => Number.isSafeInteger(n) && n >= 0 ? n : null;
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const validId = (value: string | null) => value && UUID.test(value) ? value : null;

/* Only hashes of native identities and paths cross the observation boundary. */
export function phaseHash(value: string | null | undefined): string | null {
  return value && value.length <= 4096 ? digest(value) : null;
}

export function sourceHash(url: string): string | null {
  try { return digest(readFileSync(new URL(url))); } catch { return null; }
}

function nodeVersion(): string | null {
  try {
    const data: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const version = data && typeof data === 'object' && 'version' in data ? data.version : null;
    return typeof version === 'string' && version.length <= 64 && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][\w.-]+)?$/.test(version) ? version : null;
  } catch { return null; }
}

const SOURCE = { producerHash: sourceHash(import.meta.url), nodeVersion: nodeVersion(), runtimeNodeVersion: process.version, cliVersion: null, cliVersionReason: 'not_observed' };

export type PhaseRecord = {
  trace: 'hh-terminal-phase-v1'; attemptId: string; jobId: string | null; agentKey: string | null; origin: 'queued' | 'typed';
  startedAtUtc: string; atUtc: string; monotonicMs: number; seq: number; previousHash: string | null;
  phase: Phase; event: 'launch' | 'wait_start' | 'wait_end' | 'finish' | 'bind' | 'completion'; finish: Finish | null; outcome: 'ok' | 'failed' | 'cancelled' | null;
  source: typeof SOURCE & { hostHash: string | null }; sessionHash: string | null;
  launch: { goesOn: boolean | null; sameSession: boolean | null; hashMatch: boolean | null };
  waits: { ready: Wait | null; accept: Wait | null; done: Wait | null };
  counts: { paste: number; enter: number }; ack: Ack | null; pane: (PaneObservation & { status: null; signal: null }) | null;
  wire: (WireObservation & { cursorBefore: null; cursorAfter: null; cursorReason: 'not_exposed'; nativeTurnHash: null; nativeTurnReason: 'not_exposed' }) | null;
  gaps: { jobId: 'not_bound' | 'invalid' | null; agentKey: 'invalid' | null; persistFailures: number; lastPersistFailure: PersistCode | null };
};

class StoreFailure extends Error {
  constructor(readonly code: PersistCode) { super('Terminal phase storage unavailable.'); }
}

function close(fd: number): void {
  try { closeSync(fd); } catch { /* The write result already says whether it was durable. */ }
}

function removeOwn(file: string): void {
  try { unlinkSync(file); } catch { /* Never remove another attempt or a pre-existing stage. */ }
}

function privateDirectory(fd: number, trace: boolean): void {
  const info = fstatSync(fd);
  const forbidden = trace ? 0o077 : 0o022;
  if (!info.isDirectory() || info.mode & forbidden || (process.getuid && info.uid !== process.getuid())) throw new StoreFailure('unsafe_path');
}

/* Descriptor paths pin both directories across a rename or a symlink replacement. */
function descriptorPath(fd: number): string {
  const base = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
  const path = join(base, String(fd));
  const pinned = fstatSync(fd);
  let found;
  try { found = statSync(path); } catch { throw new StoreFailure('unsupported_fs'); }
  if (found.ino !== pinned.ino || found.dev !== pinned.dev || !found.isDirectory()) throw new StoreFailure('unsupported_fs');
  return path;
}

function makeDirectory(parent: string): void {
  try { mkdirSync(join(parent, 'terminal-phase'), { mode: 0o700 }); }
  catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error; }
}

function writeAll(fd: number, bytes: Buffer): void {
  for (let offset = 0; offset < bytes.length;) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0 || written > bytes.length - offset) throw new StoreFailure('partial_write');
    offset += written;
  }
  if (fstatSync(fd).size !== bytes.length) throw new StoreFailure('partial_write');
}

function existingCopy(file: string, bytes: Buffer): void {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size !== bytes.length || info.mode & 0o077 || (process.getuid && info.uid !== process.getuid())) throw new StoreFailure('conflict');
    const found = Buffer.alloc(bytes.length + 1);
    const read = readSync(fd, found, 0, found.length, 0);
    if (read !== bytes.length || !found.subarray(0, read).equals(bytes)) throw new StoreFailure('conflict');
    fsyncSync(fd);
  } finally { close(fd); }
}

function linkOnce(stage: string, file: string, bytes: Buffer): void {
  try { linkSync(stage, file); }
  catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
    existingCopy(file, bytes);
  }
}

/* Immutable snapshots: a complete file is fsynced before its name becomes visible. No record is overwritten. */
export class PhaseStore {
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }

  begin(agentKey: string, jobId: string | null, origin: 'queued' | 'typed'): PhaseAttempt {
    return new PhaseAttempt(this, agentKey, jobId, origin);
  }

  persist(record: PhaseRecord): Receipt {
    const fds: number[] = [];
    let ownStage: string | null = null;
    try {
      if (!UUID.test(record.attemptId) || record.seq < 1 || record.seq > PHASE_RECORDS) throw new StoreFailure('record_limit');
      const bytes = Buffer.from(JSON.stringify(record) + '\n');
      if (bytes.length > PHASE_BYTES) throw new StoreFailure('size_limit');
      const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
      const root = openSync(this.root, flags); fds.push(root);
      privateDirectory(root, false);
      const parent = descriptorPath(root);
      makeDirectory(parent);
      const dir = openSync(join(parent, 'terminal-phase'), flags); fds.push(dir);
      privateDirectory(dir, true);
      fsyncSync(root);
      const path = descriptorPath(dir);
      const stage = join(path, `.${record.attemptId}-${record.seq}-${randomBytes(8).toString('hex')}.tmp`);
      const fd = openSync(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); fds.push(fd);
      ownStage = stage;
      writeAll(fd, bytes);
      fsyncSync(fd);
      const file = join(path, `${record.attemptId}-${String(record.seq).padStart(4, '0')}.json`);
      linkOnce(stage, file, bytes);
      fsyncSync(dir);
      unlinkSync(stage); ownStage = null;
      fsyncSync(dir);
      return { durable: true, code: 'ok', hash: digest(bytes), seq: record.seq };
    } catch (error) {
      return { durable: false, code: error instanceof StoreFailure ? error.code : 'io_error', hash: null, seq: record.seq };
    } finally {
      if (ownStage) removeOwn(ownStage);
      for (const fd of fds.reverse()) close(fd);
    }
  }

  toJSON(): { kind: string } { return { kind: 'terminal-phase-store' }; }
}

/* One object per attempt; callbacks retain this object rather than looking up another job by agent. */
export class PhaseAttempt {
  private readonly started = process.hrtime.bigint();
  private readonly record: PhaseRecord;
  private saved: Receipt = { durable: false, code: 'not_saved', hash: null, seq: 0 };

  constructor(readonly store: PhaseStore, agentKey: string, jobId: string | null, origin: 'queued' | 'typed') {
    const utc = new Date().toISOString();
    this.record = {
      trace: 'hh-terminal-phase-v1', attemptId: randomUUID(), jobId: validId(jobId), agentKey: validId(agentKey), origin,
      startedAtUtc: utc, atUtc: utc, monotonicMs: 0, seq: 0, previousHash: null, phase: 'launch', event: 'launch', finish: null, outcome: null,
      source: { ...SOURCE, hostHash: null }, sessionHash: null, launch: { goesOn: null, sameSession: null, hashMatch: null },
      waits: { ready: null, accept: null, done: null }, counts: { paste: 0, enter: 0 }, ack: null, pane: null, wire: null,
      gaps: { jobId: jobId === null ? 'not_bound' : validId(jobId) ? null : 'invalid', agentKey: validId(agentKey) ? null : 'invalid', persistFailures: 0, lastPersistFailure: null },
    };
  }

  launch(sessionId: string | null, hostHash: string | null, flags: PhaseRecord['launch']): void {
    if (this.record.seq || this.record.finish) return;
    this.record.sessionHash = phaseHash(sessionId);
    this.record.source.hostHash = hostHash && DIGEST.test(hostHash) ? hostHash : null;
    this.record.launch = { goesOn: flags.goesOn, sameSession: flags.sameSession, hashMatch: flags.hashMatch };
    this.save('launch');
  }

  session(sessionId: string | null): void { if (!this.record.finish) this.record.sessionHash = phaseHash(sessionId); }

  matchesJob(jobId: string | undefined): boolean { return this.record.jobId !== null && this.record.jobId === validId(jobId ?? null); }

  paneOutcome(): 'pane_dead' | 'query_failed' | 'unknown' {
    if (this.record.pane?.queryOk === false) return 'query_failed';
    return this.record.pane?.paneDead === true ? 'pane_dead' : 'unknown';
  }

  readyFailed(): void {
    const result = this.record.waits.ready?.result;
    if (result === 'deadline') this.finish('ready_deadline');
    else if (result === 'signed_out') this.finish('ready_signed_out');
    else if (result === 'pane_dead') this.finish('ready_pane_dead');
    else if (result === 'query_failed') this.finish('ready_query_failed');
    else this.finish('ready_unknown');
  }

  pane(observation: PaneObservation): void {
    if (!this.record.finish) this.record.pane = { queryOk: observation.queryOk, paneDead: observation.paneDead, queryError: observation.queryError, status: null, signal: null };
  }

  wire(observation: WireObservation): void {
    if (this.record.finish || observation.sessionHash !== this.record.sessionHash) return;
    this.record.wire = { source: observation.source, pathHash: observation.pathHash, sessionHash: observation.sessionHash, sizeBefore: count(observation.sizeBefore ?? -1), sizeAfter: count(observation.sizeAfter ?? -1), recordType: observation.recordType, cursorBefore: null, cursorAfter: null, cursorReason: 'not_exposed', nativeTurnHash: null, nativeTurnReason: 'not_exposed' };
  }

  pasted(): void { if (!this.record.finish) this.record.counts.paste = Math.min(1_000_000, this.record.counts.paste + 1); }
  entered(): void { if (!this.record.finish) this.record.counts.enter = Math.min(1_000_000, this.record.counts.enter + 1); }
  ack(source: Ack): void { if (!this.record.finish && !this.record.ack) this.record.ack = source; }

  waitStart(phase: Exclude<Phase, 'launch'>, startedAt: number, budgetMs: number | null): void {
    if (this.record.finish || this.record.waits[phase]) return;
    this.record.phase = phase;
    this.record.waits[phase] = { startedAtUtc: new Date(startedAt).toISOString(), endedAtUtc: null, budgetMs: budgetMs === null ? null : count(budgetMs), result: null };
    this.save('wait_start');
  }

  waitEnd(phase: Exclude<Phase, 'launch'>, result: WaitResult): void {
    const wait = this.record.waits[phase];
    if (this.record.finish || !wait || wait.endedAtUtc) return;
    wait.endedAtUtc = new Date().toISOString(); wait.result = result;
    this.record.phase = phase;
    this.save('wait_end');
  }

  finish(reason: Finish): void {
    if (this.record.finish) return;
    this.record.finish = reason;
    this.save('finish');
  }

  bind(jobId: string): void {
    if (this.record.origin !== 'typed' || this.record.jobId || !validId(jobId)) return;
    this.record.jobId = jobId; this.record.gaps.jobId = null;
    this.save('bind');
  }

  complete(ok: boolean, cancelled: boolean): void {
    if (this.record.outcome) return;
    this.record.finish ??= 'runner_result';
    this.record.outcome = cancelled ? 'cancelled' : ok ? 'ok' : 'failed';
    this.save('completion');
  }

  private save(event: PhaseRecord['event']): void {
    if (this.record.seq >= (event === 'finish' || event === 'bind' || event === 'completion' ? PHASE_RECORDS : PHASE_RECORDS - 3)) {
      this.saved = { durable: false, code: 'record_limit', hash: null, seq: this.record.seq };
      return;
    }
    this.record.previousHash = this.saved.durable ? this.saved.hash : this.record.previousHash;
    this.record.seq++;
    this.record.event = event;
    this.record.atUtc = new Date().toISOString();
    this.record.monotonicMs = Math.min(Number.MAX_SAFE_INTEGER, Number((process.hrtime.bigint() - this.started) / 1_000_000n));
    this.saved = this.store.persist(this.record);
    if (!this.saved.durable) {
      this.record.gaps.persistFailures = Math.min(1_000_000, this.record.gaps.persistFailures + 1);
      this.record.gaps.lastPersistFailure = this.saved.code;
    }
  }

  summary(): string {
    return `hh-terminal-phase-v1 attempt=${this.record.attemptId} seq=${this.saved.seq} phase=${this.record.phase} finish=${this.record.finish ?? 'unknown'} durable=${this.saved.durable} code=${this.saved.code} sha256=${this.saved.hash ?? 'none'}`;
  }

  toJSON(): PhaseRecord { return JSON.parse(JSON.stringify(this.record)) as PhaseRecord; }
}
