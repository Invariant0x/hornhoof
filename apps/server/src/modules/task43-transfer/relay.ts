import { createHash, randomUUID } from 'node:crypto';
import { TASK43_TRANSFER_V1, type Task43FailureReason, type Task43NodeMessage, type Task43Policy, type Task43Receipt, type Task43ServerMessage } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
import { loadTask, note, published } from '../tasks/engine.js';
import type { NodeConnectionRef } from '../nodes/hub.js';
import { authorizeTask43, sameTask43Authorization, type Task43AuthContext } from './auth.js';
import { Task43Error, task43Error } from './errors.js';

type Pending = {
  connection: NodeConnectionRef;
  expected: Task43NodeMessage['type'];
  resolve(message: Task43NodeMessage): void;
  reject(error: Task43Error): void;
  timer: NodeJS.Timeout;
};

type Attempt = {
  auth: Task43AuthContext;
  requestId: string;
  attemptId: string;
  signal: AbortSignal;
  receipt: Task43Receipt;
  pending: Pending | null;
  failure: Task43Error | null;
  commitIssued: boolean;
  mayExist: boolean;
  sourceReadAt: string | null;
  targetVerifiedAt: string | null;
  totalTimer: NodeJS.Timeout;
  onAbort(): void;
};

export class Task43Transfer {
  private active: Attempt | null = null;

  constructor(private readonly ctx: Ctx, readonly policy: Task43Policy = TASK43_TRANSFER_V1) {}

  async transfer(auth: Task43AuthContext, requestId: string, signal: AbortSignal): Promise<Task43Receipt> {
    if (this.active) throw task43Error('conflict', 'busy', 'Another artifact transfer is already running.');
    if (signal.aborted || !this.ctx.hub.isPinned(auth.sourceConnection) || !this.ctx.hub.isPinned(auth.targetConnection)) {
      throw task43Error('unavailable', 'disconnected', 'A required connection is no longer available.');
    }
    const attemptId = randomUUID();
    const receipt = this.receipt(auth, requestId, attemptId, 'started');
    const attempt = {} as Attempt;
    attempt.auth = auth;
    attempt.requestId = requestId;
    attempt.attemptId = attemptId;
    attempt.signal = signal;
    attempt.receipt = receipt;
    attempt.pending = null;
    attempt.failure = null;
    attempt.commitIssued = false;
    attempt.mayExist = false;
    attempt.sourceReadAt = null;
    attempt.targetVerifiedAt = null;
    attempt.onAbort = () => this.fail(attempt, 'disconnected');
    attempt.totalTimer = setTimeout(() => this.fail(attempt, 'timeout'), this.policy.totalMs);
    attempt.totalTimer.unref();
    this.active = attempt;
    signal.addEventListener('abort', attempt.onAbort, { once: true });
    try {
      await this.persist(attempt.receipt);
      const targetReady = await this.request(attempt, auth.targetConnection, {
        type: 'task43.prepare', requestId, attemptId, role: 'target', taskId: auth.taskId, companyId: auth.companyId, jobId: auth.jobId,
      }, 'task43.ready');
      if (targetReady.type !== 'task43.ready' || targetReady.role !== 'target') throw task43Error('unavailable', 'io_failed', 'The target preparation was invalid.');
      if (targetReady.existing === 'matching') attempt.mayExist = true;
      let stored: Extract<Task43NodeMessage, { type: 'task43.stored' }>;
      if (targetReady.existing === 'matching') {
        await this.reauthorize(attempt);
        attempt.commitIssued = true;
        stored = await this.request(attempt, auth.targetConnection, { type: 'task43.commit', requestId, attemptId }, 'task43.stored') as Extract<Task43NodeMessage, { type: 'task43.stored' }>;
        this.checkStored(stored, 'already_present');
      } else {
        const sourceReady = await this.request(attempt, auth.sourceConnection, {
          type: 'task43.prepare', requestId, attemptId, role: 'source', taskId: auth.taskId, companyId: auth.companyId, jobId: auth.jobId,
        }, 'task43.ready');
        if (sourceReady.type !== 'task43.ready' || sourceReady.role !== 'source' || sourceReady.existing !== 'absent') {
          throw task43Error('unavailable', 'io_failed', 'The source preparation was invalid.');
        }
        const serverHash = createHash('sha256');
        for (let offset = 0; offset < this.policy.size;) {
          await this.reauthorize(attempt);
          const chunk = await this.request(attempt, auth.sourceConnection, { type: 'task43.read', requestId, attemptId, offset }, 'task43.chunk');
          if (chunk.type !== 'task43.chunk' || chunk.offset !== offset) throw task43Error('unavailable', 'size_mismatch', 'The source returned a wrong offset.');
          const data = Buffer.from(chunk.data, 'base64');
          const expected = Math.min(this.policy.chunkBytes, this.policy.size - offset);
          if (data.length !== expected || data.toString('base64') !== chunk.data) throw task43Error('unavailable', 'size_mismatch', 'The source returned a non-canonical or wrong-size chunk.');
          serverHash.update(data);
          const acknowledged = await this.request(attempt, auth.targetConnection, { type: 'task43.write', requestId, attemptId, offset, data: chunk.data }, 'task43.ack');
          if (acknowledged.type !== 'task43.ack' || acknowledged.nextOffset !== offset + expected) throw task43Error('unavailable', 'size_mismatch', 'The target acknowledged a wrong offset.');
          offset += expected;
        }
        const sourceVerified = await this.request(attempt, auth.sourceConnection, { type: 'task43.source_finish', requestId, attemptId }, 'task43.source_verified');
        if (sourceVerified.type !== 'task43.source_verified' || sourceVerified.size !== this.policy.size || sourceVerified.sha256 !== this.policy.sha256 || sourceVerified.sha256 !== serverHash.digest('hex')) {
          throw task43Error('unavailable', 'hash_mismatch', 'The source bytes do not match the delegated hash.');
        }
        attempt.sourceReadAt = sourceVerified.sourceReadAt;
        const verified = await this.request(attempt, auth.targetConnection, { type: 'task43.verify', requestId, attemptId }, 'task43.verified');
        if (verified.type !== 'task43.verified' || verified.size !== this.policy.size || verified.sha256 !== this.policy.sha256) {
          throw task43Error('unavailable', 'hash_mismatch', 'The target bytes do not match the delegated hash.');
        }
        attempt.targetVerifiedAt = verified.targetVerifiedAt;
        await this.reauthorize(attempt);
        attempt.commitIssued = true;
        stored = await this.request(attempt, auth.targetConnection, { type: 'task43.commit', requestId, attemptId }, 'task43.stored') as Extract<Task43NodeMessage, { type: 'task43.stored' }>;
        this.checkStored(stored, 'copied');
      }
      attempt.mayExist = true;
      attempt.receipt = {
        ...attempt.receipt,
        status: 'server_complete',
        serverReceivedAt: new Date().toISOString(),
        actualPath: stored.actualPath,
        actualSize: stored.size,
        actualSha256: stored.sha256,
        sourceReadAt: stored.mode === 'copied' ? attempt.sourceReadAt : null,
        targetVerifiedAt: stored.targetVerifiedAt,
        storedAt: stored.storedAt,
        mode: stored.mode,
        errorReason: null,
        mayExist: true,
      };
      await this.persist(attempt.receipt);
      return attempt.receipt;
    } catch (error) {
      let reason = this.reasonOf(error);
      if (attempt.commitIssued && ['disconnected', 'timeout', 'backpressure', 'io_failed'].includes(reason)) reason = 'commit_outcome_unknown';
      attempt.receipt = {
        ...attempt.receipt,
        status: 'failed',
        serverReceivedAt: new Date().toISOString(),
        actualPath: null,
        actualSize: null,
        actualSha256: null,
        sourceReadAt: attempt.sourceReadAt,
        targetVerifiedAt: null,
        storedAt: null,
        mode: null,
        errorReason: reason,
        mayExist: attempt.mayExist || attempt.commitIssued,
      };
      this.sendAbort(attempt, reason);
      await this.persist(attempt.receipt).catch(() => {});
      return attempt.receipt;
    } finally {
      clearTimeout(attempt.totalTimer);
      signal.removeEventListener('abort', attempt.onAbort);
      if (this.active === attempt) this.active = null;
    }
  }

  fromNode(connection: NodeConnectionRef, message: Task43NodeMessage): void {
    const attempt = this.active;
    if (!attempt || message.attemptId !== attempt.attemptId) return;
    if (message.requestId !== attempt.requestId || !attempt.pending || attempt.pending.connection !== connection) {
      this.fail(attempt, 'size_mismatch');
      return;
    }
    const pending = attempt.pending;
    if (message.type === 'task43.failed') {
      attempt.mayExist ||= message.mayExist;
      this.settle(attempt, task43Error('unavailable', message.reason, 'The node reported a transfer failure.'), false);
      return;
    }
    if (message.type !== pending.expected) {
      this.settle(attempt, task43Error('unavailable', 'size_mismatch', 'The node returned a frame in the wrong phase.'), false);
      return;
    }
    this.settle(attempt, null, true, message);
  }

  abortConnection(connection: NodeConnectionRef): void {
    const attempt = this.active;
    if (attempt && (attempt.auth.sourceConnection === connection || attempt.auth.targetConnection === connection)) this.fail(attempt, 'disconnected');
  }

  stop(): void {
    if (this.active) this.fail(this.active, 'disconnected');
  }

  private receipt(auth: Task43AuthContext, requestId: string, attemptId: string, status: 'started'): Task43Receipt {
    return {
      schema: 'task43-transfer-v1', requestId, attemptId,
      taskId: auth.taskId, taskNumber: 56, companyId: auth.companyId, jobId: auth.jobId,
      sourceAgentId: this.policy.sourceAgentId, targetAgentId: this.policy.targetAgentId,
      sourceRelativePath: this.policy.relativeSource, destinationBasename: this.policy.destinationBasename,
      actualPath: null, expectedSize: this.policy.size, expectedSha256: this.policy.sha256,
      actualSize: null, actualSha256: null, sourceReadAt: null, targetVerifiedAt: null, storedAt: null,
      serverReceivedAt: new Date().toISOString(), status, delivered: false, mode: null, errorReason: null, mayExist: false,
    } as Task43Receipt;
  }

  private async persist(receipt: Task43Receipt): Promise<void> {
    const task = await loadTask(this.ctx.db, receipt.taskId);
    await note(this.ctx.db, task, { kind: 'comment', actor: { agentId: this.active!.auth.actorAgentId }, data: { task43Transfer: receipt } });
    published(this.ctx, task);
  }

  private async reauthorize(attempt: Attempt): Promise<void> {
    this.guard(attempt);
    const fresh = await authorizeTask43(this.ctx, attempt.auth.jobId, this.policy);
    if (!sameTask43Authorization(attempt.auth, fresh)) throw task43Error('forbidden', 'wrong_context', 'The task or connection authorization changed.');
    this.guard(attempt);
  }

  private guard(attempt: Attempt): void {
    if (attempt.failure) throw attempt.failure;
    if (attempt.signal.aborted) throw task43Error('unavailable', 'disconnected', 'The caller disconnected.');
    if (this.active !== attempt) throw task43Error('unavailable', 'disconnected', 'The attempt is no longer active.');
  }

  private request(attempt: Attempt, connection: NodeConnectionRef, message: Task43ServerMessage, expected: Task43NodeMessage['type']): Promise<Task43NodeMessage> {
    this.guard(attempt);
    if (attempt.pending) return Promise.reject(task43Error('unavailable', 'busy', 'A transfer frame is already pending.'));
    return new Promise((resolve, reject) => {
      const pending = {} as Pending;
      pending.connection = connection;
      pending.expected = expected;
      pending.resolve = resolve;
      pending.reject = reject;
      pending.timer = setTimeout(() => this.fail(attempt, 'timeout'), this.policy.idleMs);
      pending.timer.unref();
      attempt.pending = pending;
      const sent = this.ctx.hub.sendTask43(connection, message);
      if (sent !== 'ok') this.settle(attempt, task43Error('unavailable', sent === 'backpressure' ? 'backpressure' : 'disconnected', 'The transfer frame could not be sent.'), false);
    });
  }

  private settle(attempt: Attempt, error: Task43Error | null, success: boolean, message?: Task43NodeMessage): void {
    const pending = attempt.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    attempt.pending = null;
    if (success && message) pending.resolve(message);
    else if (error) pending.reject(error);
  }

  private fail(attempt: Attempt, reason: Task43FailureReason): void {
    const error = task43Error('unavailable', reason, 'The transfer was interrupted.');
    attempt.failure = error;
    this.settle(attempt, error, false);
  }

  private sendAbort(attempt: Attempt, reason: Task43FailureReason): void {
    for (const connection of [attempt.auth.sourceConnection, attempt.auth.targetConnection]) {
      this.ctx.hub.sendTask43(connection, { type: 'task43.abort', requestId: attempt.requestId, attemptId: attempt.attemptId, reason });
    }
  }

  private checkStored(stored: Extract<Task43NodeMessage, { type: 'task43.stored' }>, mode: 'copied' | 'already_present'): void {
    const suffix = `/${this.policy.targetAgentId}/${this.policy.destinationBasename}`;
    if (stored.mode !== mode || stored.size !== this.policy.size || stored.sha256 !== this.policy.sha256 || !stored.actualPath.endsWith(suffix) || /[\0\r\n]/.test(stored.actualPath)) {
      throw task43Error('unavailable', 'io_failed', 'The stored metadata does not match the delegated file.');
    }
  }

  private reasonOf(error: unknown): Task43FailureReason {
    return error instanceof Task43Error ? error.reason : 'io_failed';
  }
}
