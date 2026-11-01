import type { Limits, NodeMessage, UsageObservation } from '@hornhoof/protocol';

/* A single fetch can preserve raw plan windows alongside the older display projection. Never send this internal field. */
export type CollectedLimits = Limits & { observedWindows?: Limits['windows'] };

export function legacyLimits(limits: CollectedLimits): Limits {
  const { status, windows, complete } = limits;
  return { status, windows, ...(complete !== undefined ? { complete } : {}) };
}

/* Epoch and order belong to the collection, never to a later heartbeat or reconnect. */
export class UsageSampler {
  epoch: string | null = null;
  private seq = 0;
  private observation: UsageObservation | undefined;

  setEpoch(epoch: string, refresh?: () => void | Promise<void>): boolean {
    if (this.epoch === epoch) return false;
    this.epoch = epoch;
    this.seq = 0;
    this.observation = undefined;
    void refresh?.();
    return true;
  }

  metadata(): { usageObservation?: UsageObservation } {
    return this.observation ? { usageObservation: this.observation } : {};
  }

  async update(known: () => Limits | null, read: () => Promise<Limits | null>, merge: (known: Limits | null, news: Limits) => Limits): Promise<{ limits: Limits | null } | null> {
    const { limits, observation } = await this.collect(read);
    if (observation.epoch !== this.epoch) return null;
    if (this.observation && observation.seq <= this.observation.seq) return null;
    const previous = known();
    const next = limits ? merge(previous, legacyLimits(limits)) : previous;
    if (this.epoch === null && (!limits || JSON.stringify(next) === JSON.stringify(previous))) return null;
    if (this.epoch !== null) this.observation = observation;
    return { limits: next };
  }

  async collect(read: () => Promise<CollectedLimits | null>): Promise<{ limits: CollectedLimits | null; observation: UsageObservation }> {
    const order = { epoch: this.epoch, seq: ++this.seq, delivery: 'live' as const, source: 'usage_fetch' as const };
    const limits = await read().catch(() => null);
    const observation: UsageObservation = limits
      ? { ...order, outcome: 'success', sampledAt: new Date().toISOString(), complete: limits.complete === true, status: limits.status, windows: structuredClone(limits.observedWindows ?? limits.windows) }
      : { ...order, outcome: 'unavailable', sampledAt: null, complete: false, status: null, windows: [] };
    return { limits, observation };
  }
}

/* Delivery is the only provenance field that changes, once, towards less trust. Cached references stay marked too. */
export function markOutbox(message: NodeMessage): void {
  if (message.type !== 'status' && message.type !== 'job.done') return;
  if (message.usageObservation) message.usageObservation.delivery = 'outbox';
  if (message.type === 'job.done' && message.quotaRefusal) message.quotaRefusal.delivery = 'outbox';
}
