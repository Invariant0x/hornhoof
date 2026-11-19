import { TOOL_QUIET_ALARM_MS } from '@hornhoof/protocol/map';
import { CHECK_LEASE_MS, LOAD_MS, CheckSlotQueue, checkCapacity, fitsCheck, type CheckLeaseSnapshot, type CheckQueueReply, type CheckQueueRequest } from '@hornhoof/protocol';
import { z } from 'zod';
import { latestReport } from './host-load.js';

type Acquire = Extract<CheckQueueRequest, { type: 'check.acquire' }>;
type Report = CheckLeaseSnapshot & { receivedAt: number; linkId?: string };
type Order = Pick<Report, 'linkId' | 'sequence'>;
type Sample = { cpus: number; load: number; at?: number; checkLeases?: Report };
type Member = { host: string; sample: Sample; online: boolean; at: number; lastReport?: Order };
export type CheckClaim = { node: string; request: Acquire; position: number; queuedAt: number; startedAt: number | null; retired: boolean };
export type CheckSnapshot = { capacity: number; holders: CheckClaim[]; queue: CheckClaim[] };
type Entry = CheckClaim & { state: CheckQueueReply['state']; stop: AbortController; finish(): void };
/* heard: when the server last took in a frame from the node, whether or not it has handled it yet (#1060). */
type Options = { send(node: string, reply: CheckQueueReply): void; now?(): number; warmupMs?: number; heard?(node: string): number | null };

export function checkPartId(request: Acquire): string | undefined {
  if (request.agentId || request.jobId) return undefined;
  const part = /^Run part (.+)$/.exec(request.label)?.[1];
  return z.uuid().safeParse(part).data;
}

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

  node(node: string, host: string, { at = this.now(), checkLeases, ...sample }: Sample): void {
    if (this.now() - this.heardSince(node, at) >= CHECK_LEASE_MS) { this.lost(node); return; }
    const member: Member = { host, sample, online: true, at, lastReport: this.nodes.get(node)?.lastReport };
    this.nodes.set(node, member);
    if (!this.pools.has(host)) this.pools.set(host, new CheckSlotQueue(() => Infinity, (held, cores) => this.fits(host, held, cores)));
    if (checkLeases) this.reconcile(node, member, checkLeases);
    this.refresh();
  }

  private reconcile(node: string, member: Member, { linkId, sequence, receivedAt, ids }: Report): void {
    const last = member.lastReport;
    if (last && last.linkId === linkId && last.sequence >= sequence) return;
    member.lastReport = { linkId, sequence };
    const held = new Set(ids);
    const cutoff = receivedAt - LOAD_MS;
    for (const entry of this.entries.values()) {
      if (entry.node !== node) continue;
      if (entry.startedAt === null) continue;
      if (entry.startedAt >= cutoff) continue;
      if (held.has(entry.request.id)) continue;
      this.releaseEntry(entry);
    }
  }

  acquire(node: string, request: Acquire, cores = 0): void {
    const key = `${node}:${request.id}`, previous = this.entries.get(key);
    if (previous && !previous.retired) { this.tell(previous); return; }
    const member = this.nodes.get(node);
    /* A claim to resume a lease this machine no longer holds here is late, or not its own: it is ended, never queued anew. */
    if (previous || !member?.online || request.resume) { this.options.send(node, { type: 'check.state', id: request.id, state: 'ended', position: 0 }); return; }
    const entry: Entry = { node, request, state: 'queued', position: 1, queuedAt: this.now(), startedAt: null, stop: new AbortController(), finish: () => {}, retired: false };
    this.entries.set(key, entry);
    const run = this.pools.get(member.host)!.withSlot(() => new Promise<void>(resolve => {
      entry.finish = resolve;
      entry.state = 'running'; entry.position = 0; entry.startedAt = this.now(); this.rememberEnd(entry);
      this.tell(entry);
    }), { cores, signal: entry.stop.signal, onPosition: position => { entry.position = position; this.tell(entry); } });
    void run.catch(() => {}).finally(() => {
      entry.state = 'ended'; entry.position = 0;
      this.entries.delete(key);
      this.tell(entry);
    });
  }

  release(node: string, id: string): void {
    const entry = this.entries.get(`${node}:${id}`);
    if (entry) this.releaseEntry(entry);
  }

  private releaseEntry(entry: Entry): void {
    if (entry.state === 'queued') this.rememberEnd(entry);
    entry.stop.abort(new Error('Check released.'));
    entry.finish();
  }

  /* Leases belong to a node process. A new process proves the old one cannot resume its claims. */
  restart(node: string): void {
    for (const entry of this.entries.values()) {
      if (entry.node !== node) continue;
      entry.retired = true;
      this.releaseEntry(entry);
    }
  }

  endParts(node: string, matches: (partId: string) => boolean, cleaned: boolean): void {
    for (const entry of this.entries.values()) {
      if (entry.node !== node) continue;
      const partId = checkPartId(entry.request);
      if (!partId || !matches(partId)) continue;
      if (cleaned) this.releaseEntry(entry);
      else this.retire(entry);
    }
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

  /* Reading a snapshot never refreshes admission or retires leases. Cleanup still holds its slot until release. */
  inspect(node: string): CheckSnapshot | null {
    const member = this.nodes.get(node);
    if (!member) return null;
    const entries = [...this.entries.values()].filter(entry => this.nodes.get(entry.node)?.host === member.host);
    const copy = ({ node, request, position, queuedAt, startedAt, retired }: Entry): CheckClaim => ({ node, request: { ...request }, position, queuedAt, startedAt, retired });
    return {
      capacity: this.capacity(member.host),
      holders: entries.filter(entry => entry.state === 'running').map(copy),
      queue: entries.filter(entry => entry.state === 'queued' && !entry.stop.signal.aborted).sort((a, b) => a.position - b.position).map(copy),
    };
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
    const sample = this.hostSample(host);
    return sample ? checkCapacity(sample.cpus, sample.load) : 0;
  }

  private fits(host: string, held: Iterable<number>, cores: number): boolean {
    const sample = this.hostSample(host);
    return sample !== undefined && fitsCheck(sample.cpus, sample.load, held, cores);
  }

  private hostSample(host: string): Sample | undefined {
    if (this.now() < this.readyAt) return undefined;
    return latestReport([...this.nodes.values()].filter(node => node.host === host && node.online))?.sample;
  }

  private retire(entry: Entry): void {
    if (entry.retired) return;
    entry.retired = true;
    this.options.send(entry.node, { type: 'check.state', id: entry.request.id, state: 'ended', position: 0 });
    if (entry.state === 'queued') { this.releaseEntry(entry); return; }
    this.later(() => this.releaseEntry(entry), CHECK_LEASE_MS);
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
