import { TOOL_QUIET_ALARM_MS } from '@hornhoof/protocol/map';
import { CHECK_LEASE_MS, CheckSlotQueue, checkCapacity, type CheckQueueReply, type CheckQueueRequest } from '@hornhoof/protocol';

type Acquire = Extract<CheckQueueRequest, { type: 'check.acquire' }>;
type Sample = { cpus: number; load: number; at?: number };
type Member = { host: string; sample: Sample; online: boolean; at: number };
type Entry = { node: string; request: Acquire; state: CheckQueueReply['state']; position: number; stop: AbortController; finish(): void; retired: boolean };
/* heard: when the server last took in a frame from the node, whether or not it has handled it yet (#1060). */
type Options = { send(node: string, reply: CheckQueueReply): void; now?(): number; warmupMs?: number; heard?(node: string): number | null };

/* A disconnected worker must stop its process group before another worker gets its CPU budget.
   The startup hold covers old workers discovering a server restart and performing that cleanup. */
export class CheckCoordinator {
  private readonly nodes = new Map<string, Member>();
  private readonly pools = new Map<string, CheckSlotQueue>();
  private readonly entries = new Map<string, Entry>();
  private readonly queueEnds = new Map<string, { node: string; at: number }>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly now: () => number;
  private readonly readyAt: number;

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.readyAt = this.now() + (options.warmupMs ?? CHECK_LEASE_MS);
    this.later(() => this.refresh(), options.warmupMs ?? CHECK_LEASE_MS);
  }

  node(node: string, host: string, sample: Sample): void {
    const at = sample.at ?? this.now();
    if (this.now() - this.heardSince(node, at) >= CHECK_LEASE_MS) { this.lost(node); return; }
    this.nodes.set(node, { host, sample, online: true, at });
    if (!this.pools.has(host)) this.pools.set(host, new CheckSlotQueue(() => this.capacity(host)));
    this.refresh();
  }

  acquire(node: string, request: Acquire): void {
    const key = `${node}:${request.id}`, previous = this.entries.get(key);
    if (previous && !previous.retired) { this.tell(previous); return; }
    const member = this.nodes.get(node);
    /* A claim to resume a lease this machine no longer holds here is late, or not its own: it is ended, never queued anew. */
    if (previous || !member?.online || request.resume) { this.options.send(node, { type: 'check.state', id: request.id, state: 'ended', position: 0 }); return; }
    const entry: Entry = { node, request, state: 'queued', position: 1, stop: new AbortController(), finish: () => {}, retired: false };
    this.entries.set(key, entry);
    const run = this.pools.get(member.host)!.withSlot(() => new Promise<void>(resolve => {
      entry.finish = resolve;
      entry.state = 'running'; entry.position = 0; this.rememberEnd(entry);
      this.tell(entry);
    }), { signal: entry.stop.signal, onPosition: position => { entry.position = position; this.tell(entry); } });
    void run.catch(() => {}).finally(() => {
      entry.state = 'ended'; entry.position = 0;
      this.entries.delete(key);
      this.tell(entry);
    });
  }

  release(node: string, id: string): void {
    const entry = this.entries.get(`${node}:${id}`);
    if (!entry) return;
    if (entry.state === 'queued') this.rememberEnd(entry);
    entry.stop.abort(new Error('Check released.'));
    entry.finish();
  }

  /* The machine's connection dropped. Its leases stay while it may come back and claim them again; one not heard again
     within a lease loses them as a silent machine does. */
  away(node: string): void {
    if (!this.nodes.get(node)?.online) return;
    this.later(() => { if (!this.live(node)) this.lost(node); }, CHECK_LEASE_MS);
  }

  lost(node: string): void {
    const member = this.nodes.get(node);
    if (!member?.online) return;
    member.online = false;
    for (const entry of this.entries.values()) if (entry.node === node) this.retire(entry);
  }

  waiting(jobId: string, now = this.now()): boolean {
    return [...this.entries.values()].some(entry => entry.request.jobId === jobId && entry.state === 'queued' && this.live(entry.node, now));
  }

  lastEnd(jobId: string, now = this.now()): number | null {
    const ended = this.queueEnds.get(jobId);
    return ended && this.live(ended.node, now) && now - ended.at < TOOL_QUIET_ALARM_MS ? ended.at : null;
  }

  private rememberEnd(entry: Entry): void {
    if (entry.request.jobId) this.queueEnds.set(entry.request.jobId, { node: entry.node, at: this.now() });
  }

  refresh(): void {
    for (const [key, member] of this.nodes) if (member.online && !this.live(key)) this.lost(key);
    for (const pool of this.pools.values()) pool.refresh();
    for (const [id, ended] of this.queueEnds) if (this.now() - ended.at >= TOOL_QUIET_ALARM_MS) this.queueEnds.delete(id);
  }

  close(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const entry of this.entries.values()) this.release(entry.node, entry.request.id);
    this.queueEnds.clear();
  }

  /* A machine is live while it was heard within a lease: its last load handled, or any frame that came after it, as a frame
     can wait behind others of the node and behind the shared pump of test runs long after it came. */
  private live(node: string, now = this.now()): boolean {
    const member = this.nodes.get(node);
    return Boolean(member?.online && now - this.heardSince(node, member.at) < CHECK_LEASE_MS);
  }

  private heardSince(node: string, at: number): number {
    return Math.max(at, this.options.heard?.(node) ?? Number.NEGATIVE_INFINITY);
  }

  private capacity(host: string): number {
    if (this.now() < this.readyAt) return 0;
    const samples = [...this.nodes.values()].filter(node => node.host === host && node.online).map(node => node.sample);
    if (!samples.length) return 0;
    return checkCapacity(Math.min(...samples.map(s => s.cpus)), Math.max(...samples.map(s => s.load)));
  }

  private retire(entry: Entry): void {
    entry.retired = true;
    this.options.send(entry.node, { type: 'check.state', id: entry.request.id, state: 'ended', position: 0 });
    if (entry.state === 'queued') { this.release(entry.node, entry.request.id); return; }
    this.later(() => this.release(entry.node, entry.request.id), CHECK_LEASE_MS);
  }

  private tell(entry: Entry): void {
    if (!this.nodes.get(entry.node)?.online) return;
    this.options.send(entry.node, { type: 'check.state', id: entry.request.id, state: entry.state, position: entry.position });
  }

  private later(run: () => void, ms: number): void {
    const timer = setTimeout(() => { this.timers.delete(timer); run(); }, ms);
    timer.unref(); this.timers.add(timer);
  }
}
