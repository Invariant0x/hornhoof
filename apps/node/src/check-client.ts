import { randomUUID } from 'node:crypto';
import { CheckQueueRequest, type CheckOptions, type CheckQueueReply } from '@hornhoof/protocol';

export type SlotOptions = CheckOptions & { label?: string; agentId?: string; jobId?: string };
export type CheckLease = { id: string; signal: AbortSignal; release(): void };
type Pending = { options: SlotOptions; stop: AbortController; state: 'queued' | 'running'; resolve(lease: CheckLease): void; reject(reason: unknown): void; detach(): void };

export class CheckClient {
  private connected = false;
  private readonly entries = new Map<string, Pending>();
  constructor(private readonly send: (frame: CheckQueueRequest) => boolean) {}

  online(value: boolean): void {
    this.connected = value;
    if (value) return;
    for (const [id, entry] of this.entries) this.lost(id, entry);
  }

  async acquire(options: SlotOptions = {}): Promise<CheckLease> {
    options.signal?.throwIfAborted();
    if (!this.connected) throw new Error('Machine check queue is offline.');
    const id = randomUUID(), frame = this.request(id, options);
    return new Promise((resolve, reject) => {
      const abort = () => { this.release(id); reject(options.signal?.reason); };
      const entry: Pending = { options, stop: new AbortController(), state: 'queued', resolve, reject, detach: () => options.signal?.removeEventListener('abort', abort) };
      this.entries.set(id, entry);
      options.signal?.addEventListener('abort', abort, { once: true });
      this.publish(id, entry, frame);
    });
  }

  private request(id: string, options: SlotOptions): CheckQueueRequest {
    return CheckQueueRequest.parse({ type: 'check.acquire', id, label: options.label ?? 'Heavy check', ...(options.agentId ? { agentId: options.agentId } : {}), ...(options.jobId ? { jobId: options.jobId } : {}) });
  }

  private publish(id: string, entry: Pending, frame: CheckQueueRequest): void {
    try { if (!this.send(frame)) this.lost(id, entry); }
    catch (error) { entry.detach(); this.entries.delete(id); entry.stop.abort(error); entry.reject(error); }
  }

  receive(reply: CheckQueueReply): void {
    const entry = this.entries.get(reply.id);
    if (!entry) return;
    if (reply.state === 'ended') { this.lost(reply.id, entry); return; }
    if (entry.state === 'running') return;
    if (reply.state === 'queued') { this.position(reply.id, entry, reply.position); return; }
    entry.state = 'running'; entry.detach();
    const signals = [entry.stop.signal, ...(entry.options.signal ? [entry.options.signal] : [])];
    entry.resolve({ id: reply.id, signal: AbortSignal.any(signals), release: () => this.release(reply.id) });
  }

  waiting(agentId: string, jobId?: string | null): boolean {
    return this.connected && [...this.entries.values()].some(entry => entry.state === 'queued' && entry.options.agentId === agentId && (!jobId || !entry.options.jobId || entry.options.jobId === jobId));
  }

  private position(id: string, entry: Pending, position: number): void {
    try { entry.options.onPosition?.(position); }
    catch (error) { this.release(id); entry.reject(error); }
  }

  private release(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.detach(); this.entries.delete(id);
    if (this.connected) this.send({ type: 'check.release', id });
  }

  private lost(id: string, entry: Pending): void {
    const reason = new Error('Machine check queue lease was lost.');
    entry.stop.abort(reason); entry.detach();
    if (entry.state === 'queued') { this.entries.delete(id); entry.reject(reason); }
  }
}
