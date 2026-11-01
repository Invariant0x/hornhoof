import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TASK43_FAILURE_REASONS, TASK43_TRANSFER_V1, Task43Ack, Task43Chunk, Task43Failed, Task43Ready, Task43SourceVerified, Task43Stored, Task43Verified,
  type Task43FailureReason, type Task43NodeMessage, type Task43Policy, type Task43ServerMessage,
} from '@hornhoof/protocol';

const DEFAULT_HELPER = existsSync('/app/task43-file.py') ? '/app/task43-file.py' : fileURLToPath(new URL('../task43-file.py', import.meta.url));
const MAX_FRAME = TASK43_TRANSFER_V1.frameBytes;

type HelperResponse = Record<string, unknown> & { ok: boolean; reason?: string };
type Pending = { resolve(value: HelperResponse): void; reject(error: NodeFailure): void; timer: NodeJS.Timeout };

class NodeFailure extends Error {
  constructor(readonly reason: Task43FailureReason) {
    super(reason);
  }
}

class Helper {
  private readonly child: ChildProcessWithoutNullStreams;
  private pending: Pending | null = null;
  private input = Buffer.alloc(0);
  private closed = false;

  constructor(root: string, helperPath: string, timeoutMs: number) {
    let rootFd: number | undefined;
    try {
      rootFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      this.child = spawn('/usr/bin/python3', ['-I', helperPath], {
        shell: false,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', PYTHONHASHSEED: '0' },
        stdio: ['pipe', 'pipe', 'pipe', rootFd],
      }) as ChildProcessWithoutNullStreams;
      closeSync(rootFd);
      rootFd = undefined;
      this.child.stderr.resume();
      this.child.stdin.on('error', () => this.fail());
      this.child.on('error', () => this.fail());
      this.child.on('close', () => {
        this.closed = true;
        this.fail();
      });
      this.child.stdout.on('data', data => this.received(data));
      this.timeoutMs = timeoutMs;
    } finally {
      if (rootFd !== undefined) closeSync(rootFd);
    }
  }

  private readonly timeoutMs: number;

  call(request: Record<string, unknown>): Promise<HelperResponse> {
    if (this.closed) return Promise.reject(new NodeFailure('io_failed'));
    if (this.pending) return Promise.reject(new NodeFailure('busy'));
    const payload = Buffer.from(JSON.stringify(request) + '\n');
    if (payload.length > MAX_FRAME + 1) return Promise.reject(new NodeFailure('size_mismatch'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        this.close();
        reject(new NodeFailure('timeout'));
      }, this.timeoutMs);
      timer.unref();
      this.pending = { resolve, reject, timer };
      this.child.stdin.write(payload);
    });
  }

  close(): void {
    if (!this.closed) this.child.kill();
    this.closed = true;
    this.fail();
  }

  private fail(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(new NodeFailure('io_failed'));
  }

  private received(data: Buffer): void {
    if (this.closed) return;
    this.input = Buffer.concat([this.input, data]);
    for (;;) {
      const end = this.input.indexOf(10);
      if (end < 0) break;
      const line = this.input.subarray(0, end);
      this.input = this.input.subarray(end + 1);
      if (line.length > MAX_FRAME) {
        this.close();
        return;
      }
      let response: HelperResponse;
      try {
        response = JSON.parse(line.toString('utf8')) as HelperResponse;
      } catch {
        this.close();
        return;
      }
      const pending = this.pending;
      if (!pending) {
        this.close();
        return;
      }
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve(response);
    }
    if (this.input.length > MAX_FRAME) this.close();
  }
}

type Attempt = {
  requestId: string;
  role: 'source' | 'target';
  helper: Helper;
  mayExist: boolean;
};

export type Task43NodeOptions = {
  dir: string;
  policy?: Task43Policy;
  helperPath?: string;
  send(message: Task43NodeMessage): void;
};

export class Task43Node {
  readonly policy: Task43Policy;
  readonly root: string;
  readonly helperPath: string;
  readonly send: Task43NodeOptions['send'];
  capability = false;
  private readonly attempts = new Map<string, Attempt>();
  private chain: Promise<void> = Promise.resolve();
  private epoch = 0;
  private handlingEpoch = 0;

  constructor(options: Task43NodeOptions) {
    this.policy = options.policy ?? TASK43_TRANSFER_V1;
    this.root = join(options.dir, 'work', 'agents');
    this.helperPath = options.helperPath ?? DEFAULT_HELPER;
    this.send = options.send;
  }

  handle(frame: Task43ServerMessage): Promise<void> {
    const run = this.chain.then(() => this.handleOne(frame));
    this.chain = run.catch(() => {});
    return run;
  }

  close(): void {
    this.epoch++;
    for (const attempt of this.attempts.values()) attempt.helper.close();
    this.attempts.clear();
  }

  async qualify(dir: string): Promise<boolean> {
    let fixture = '';
    let source: Helper | null = null;
    let target: Helper | null = null;
    let retry: Helper | null = null;
    try {
      fixture = mkdtempSync(join(dir, '.task43-qualify-'));
      const root = join(fixture, 'agents');
      const sourceWorkspace = join(root, this.policy.sourceAgentId);
      const targetWorkspace = join(root, this.policy.targetAgentId);
      mkdirSync(sourceWorkspace, { recursive: true });
      mkdirSync(targetWorkspace, { recursive: true });
      const relative = this.policy.relativeSource;
      const sourceFile = join(sourceWorkspace, relative);
      mkdirSync(join(sourceFile, '..'), { recursive: true });
      const data = Buffer.from('q');
      const sha256 = createHash('sha256').update(data).digest('hex');
      writeFileSync(sourceFile, data);
      source = new Helper(root, this.helperPath, this.policy.idleMs);
      target = new Helper(root, this.helperPath, this.policy.idleMs);
      const openedSource = await source.call({ op: 'open_source', agentId: this.policy.sourceAgentId, relativePath: relative, expectedSize: 1, expectedSha256: sha256 });
      const openedTarget = await target.call({ op: 'open_target', agentId: this.policy.targetAgentId, destinationBasename: this.policy.destinationBasename, expectedSize: 1, expectedSha256: sha256 });
      this.require(openedSource);
      this.require(openedTarget);
      const chunk = await source.call({ op: 'read', offset: 0 });
      this.require(chunk);
      this.require(await target.call({ op: 'write', offset: 0, data: chunk.data }));
      this.require(await source.call({ op: 'source_finish' }));
      this.require(await target.call({ op: 'verify_target' }));
      this.require(await target.call({ op: 'commit_target' }));
      const final = join(targetWorkspace, this.policy.destinationBasename);
      if (!readFileSync(final).equals(data)) return false;
      retry = new Helper(root, this.helperPath, this.policy.idleMs);
      this.require(await retry.call({ op: 'open_target', agentId: this.policy.targetAgentId, destinationBasename: this.policy.destinationBasename, expectedSize: 1, expectedSha256: sha256 }));
      const stored = await retry.call({ op: 'commit_target' });
      this.require(stored);
      this.capability = stored.mode === 'already_present';
      return this.capability;
    } catch {
      this.capability = false;
      return false;
    } finally {
      source?.close();
      target?.close();
      retry?.close();
      if (fixture) {
        try {
          rmSync(fixture, { recursive: true, force: true });
        } catch {
          this.capability = false;
        }
      }
    }
  }

  private require(response: HelperResponse): void {
    if (response.ok !== true) {
      const reason = response.reason && (TASK43_FAILURE_REASONS as readonly string[]).includes(response.reason) ? response.reason as Task43FailureReason : 'io_failed';
      throw new NodeFailure(reason);
    }
  }

  private key(id: string, role: 'source' | 'target'): string {
    return `${id}:${role}`;
  }

  private roleOf(frame: Task43ServerMessage): 'source' | 'target' {
    if (frame.type === 'task43.prepare') return frame.role;
    return frame.type === 'task43.read' || frame.type === 'task43.source_finish' ? 'source' : 'target';
  }

  private async handleOne(frame: Task43ServerMessage): Promise<void> {
    this.handlingEpoch = this.epoch;
    const role = this.roleOf(frame);
    const key = this.key(frame.attemptId, role);
    if (frame.type === 'task43.abort') {
      this.closeAttempt(this.key(frame.attemptId, 'source'));
      this.closeAttempt(this.key(frame.attemptId, 'target'));
      return;
    }
    if (!this.capability) {
      this.sendFailure(frame, 'unsupported_node', false);
      return;
    }
    let attempt = this.attempts.get(key);
    try {
      if (frame.type === 'task43.prepare') {
        if (attempt || this.attempts.size >= 2) {
          this.closeAttempt(key);
          this.sendFailure(frame, 'busy', false);
          return;
        }
        const helper = new Helper(this.root, this.helperPath, this.policy.idleMs);
        attempt = { requestId: frame.requestId, role, helper, mayExist: false };
        this.attempts.set(key, attempt);
        if (role === 'source') {
          this.require(await helper.call({ op: 'open_source', agentId: this.policy.sourceAgentId, relativePath: this.policy.relativeSource, expectedSize: this.policy.size, expectedSha256: this.policy.sha256 }));
          this.emit(Task43Ready.parse({ type: 'task43.ready', requestId: frame.requestId, attemptId: frame.attemptId, role, existing: 'absent' }));
        } else {
          const opened = await helper.call({ op: 'open_target', agentId: this.policy.targetAgentId, destinationBasename: this.policy.destinationBasename, expectedSize: this.policy.size, expectedSha256: this.policy.sha256 });
          this.require(opened);
          const existing = opened.existing === 'matching' ? 'matching' : opened.existing === 'absent' ? 'absent' : null;
          if (!existing) throw new NodeFailure('io_failed');
          attempt.mayExist = existing === 'matching';
          this.emit(Task43Ready.parse({ type: 'task43.ready', requestId: frame.requestId, attemptId: frame.attemptId, role, existing }));
        }
        return;
      }
      if (!attempt || attempt.requestId !== frame.requestId) throw new NodeFailure('io_failed');
      switch (frame.type) {
        case 'task43.read': {
          const response = await attempt.helper.call({ op: 'read', offset: frame.offset });
          this.require(response);
          const chunk = Task43Chunk.parse({ type: 'task43.chunk', requestId: frame.requestId, attemptId: frame.attemptId, offset: frame.offset, data: response.data });
          const expected = Math.min(this.policy.chunkBytes, this.policy.size - frame.offset);
          if (Buffer.from(chunk.data, 'base64').length !== expected || Buffer.from(chunk.data, 'base64').toString('base64') !== chunk.data) throw new NodeFailure('size_mismatch');
          this.emit(chunk);
          return;
        }
        case 'task43.write': {
          const response = await attempt.helper.call({ op: 'write', offset: frame.offset, data: frame.data });
          this.require(response);
          this.emit(Task43Ack.parse({ type: 'task43.ack', requestId: frame.requestId, attemptId: frame.attemptId, nextOffset: response.nextOffset }));
          return;
        }
        case 'task43.source_finish': {
          const response = await attempt.helper.call({ op: 'source_finish' });
          this.require(response);
          const verified = Task43SourceVerified.parse({ type: 'task43.source_verified', requestId: frame.requestId, attemptId: frame.attemptId, size: response.size, sha256: response.sha256, sourceReadAt: response.sourceReadAt });
          if (verified.size !== this.policy.size || verified.sha256 !== this.policy.sha256) throw new NodeFailure('hash_mismatch');
          this.emit(verified);
          return;
        }
        case 'task43.verify': {
          const response = await attempt.helper.call({ op: 'verify_target' });
          this.require(response);
          const verified = Task43Verified.parse({ type: 'task43.verified', requestId: frame.requestId, attemptId: frame.attemptId, size: response.size, sha256: response.sha256, targetVerifiedAt: response.targetVerifiedAt });
          if (verified.size !== this.policy.size || verified.sha256 !== this.policy.sha256) throw new NodeFailure('hash_mismatch');
          this.emit(verified);
          return;
        }
        case 'task43.commit': {
          attempt.mayExist = true;
          const response = await attempt.helper.call({ op: 'commit_target' });
          this.require(response);
          const stored = Task43Stored.parse({
            type: 'task43.stored', requestId: frame.requestId, attemptId: frame.attemptId, mode: response.mode, size: response.size, sha256: response.sha256,
            actualPath: response.actualPath, targetVerifiedAt: response.targetVerifiedAt, storedAt: response.storedAt,
          });
          const expectedPath = join(realpathSync(this.root), this.policy.targetAgentId, this.policy.destinationBasename);
          if (stored.size !== this.policy.size || stored.sha256 !== this.policy.sha256 || stored.actualPath !== expectedPath) throw new NodeFailure('io_failed');
          this.emit(stored);
          this.closeAttempt(key);
          return;
        }
      }
    } catch (error) {
      const reason = error instanceof NodeFailure ? error.reason : 'io_failed';
      this.sendFailure(frame, reason, (attempt?.mayExist ?? false) || reason === 'destination_conflict');
      this.closeAttempt(key);
    }
  }

  private emit(message: Task43NodeMessage): void {
    if (this.handlingEpoch === this.epoch) this.send(message);
  }

  private sendFailure(frame: Task43ServerMessage, reason: Task43FailureReason, mayExist: boolean): void {
    this.emit(Task43Failed.parse({ type: 'task43.failed', requestId: frame.requestId, attemptId: frame.attemptId, reason, mayExist }));
  }

  private closeAttempt(key: string): void {
    const attempt = this.attempts.get(key);
    attempt?.helper.close();
    this.attempts.delete(key);
  }
}

export async function createTask43Node(options: Task43NodeOptions & { dir: string }): Promise<Task43Node> {
  const node = new Task43Node(options);
  await node.qualify(options.dir);
  return node;
}
