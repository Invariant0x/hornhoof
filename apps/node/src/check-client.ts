import { randomUUID } from 'node:crypto';
import { CHECK_LEASE_MS, CheckQueueRequest, type CheckOptions, type CheckQueueReply } from '@hornhoof/protocol';

/* light: a check of types, style or tests, which needs a few GiB of disk at most; other work is heavy and waits for more. */
export type SlotOptions = CheckOptions & { label?: string; agentId?: string; jobId?: string; light?: boolean };
export type CheckLease = { id: string; signal: AbortSignal; release(): void };
type Pending = { options: SlotOptions; frame: CheckQueueRequest; stop: AbortController; state: 'queued' | 'running'; resolve(lease: CheckLease): void; reject(reason: unknown): void; detach(): void };

/* A connection that drops for a moment takes no lease with it (#1060): the leases wait as long as the server keeps them,
   and are claimed again once the node is back. One away longer loses them, and what runs under them stops. */
export class CheckClient {
  private connected = false;
  /* Why no check starts, and why no heavy work does, which has every reason a check has and its own. */
  private refusal: string | null = null;
  private heavyRefusal: string | null = null;
  refusalChanged: (() => void) | undefined;
  /* The one that looks after the disk: asked before a check is refused, it may lift the refusal. */
  beforeRefusing: (() => Promise<void>) | undefined;
  isOnline(): boolean { return this.connected; }
  /* Pending claims can be granted at any time. Aborted holders still own their slot during cleanup. */
  leaseIds(): string[] { return [...this.entries.keys()]; }
  /* Why heavy work, or with light a light check, is refused now. */
  refused(light = false): string | null { return light ? this.refusal : this.heavyRefusal; }
  /* Refuse every check with all, and heavy work also with heavy, which is all when it is not given. */
  refuse(all: string | null, heavy: string | null = all): void {
    const both = heavy ?? all;
    if (all === this.refusal && both === this.heavyRefusal) return;
    this.refusal = all; this.heavyRefusal = both;
    for (const [id, entry] of this.entries) if (entry.state === 'queued') {
      const reason = this.refused(entry.options.light);
      if (reason) { this.release(id); entry.reject(new Error(reason)); }
    }
    this.refusalChanged?.();
  }
  private readonly entries = new Map<string, Pending>();
  /* Releases that did not reach the server, retried when the socket reopens. */
  private readonly letGo = new Set<string>();
  private away: NodeJS.Timeout | undefined;
  constructor(private readonly send: (frame: CheckQueueRequest) => boolean, private readonly graceMs = CHECK_LEASE_MS) {}

  online(value: boolean): void {
    if (this.connected === value) return;
    this.connected = value;
    if (value) { this.back(); return; }
    this.away = setTimeout(() => this.gone(), this.graceMs);
    this.away.unref();
  }

  /* The node stops: every lease ends now, with nothing to come back to. */
  stop(): void {
    this.connected = false;
    clearTimeout(this.away);
    this.gone();
  }

  private back(): void {
    clearTimeout(this.away); this.away = undefined;
    for (const id of this.letGo) if (this.sendRelease(id)) this.letGo.delete(id);
    for (const [id, entry] of this.entries) if (!entry.stop.signal.aborted) this.publish(id, entry, { ...entry.frame, resume: true } as CheckQueueRequest);
  }

  private gone(): void {
    this.away = undefined;
    for (const [id, entry] of this.entries) this.lost(id, entry);
  }

  /* Asks the one that looks after the disk to look again, which may lift a refusal. */
  private async lookAgain(): Promise<void> {
    await this.beforeRefusing?.().catch(() => {});
  }

  async acquire(options: SlotOptions = {}): Promise<CheckLease> {
    options.signal?.throwIfAborted();
    if (this.refused(options.light)) await this.lookAgain();
    options.signal?.throwIfAborted();
    const refusal = this.refused(options.light);
    if (refusal) throw new Error(refusal);
    if (!this.connected) throw new Error('Machine check queue is offline.');
    const id = randomUUID(), frame = this.request(id, options);
    return new Promise((resolve, reject) => {
      const abort = () => { this.release(id); reject(options.signal?.reason); };
      const entry: Pending = { options, frame, stop: new AbortController(), state: 'queued', resolve, reject, detach: () => options.signal?.removeEventListener('abort', abort) };
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
    catch (error) { this.lost(id, entry, error); }
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
    const sent = this.connected && this.sendRelease(id);
    if (!sent) this.letGo.add(id);
  }

  private sendRelease(id: string): boolean {
    try { return this.send({ type: 'check.release', id }); }
    catch { return false; }
  }

  private lost(id: string, entry: Pending, reason: unknown = new Error('Machine check queue lease was lost.')): void {
    entry.stop.abort(reason); entry.detach();
    if (entry.state === 'queued') { this.entries.delete(id); entry.reject(reason); }
  }
}
