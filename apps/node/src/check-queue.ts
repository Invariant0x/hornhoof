import { AsyncLocalStorage } from 'node:async_hooks';
import { CheckClient, type CheckLease, type SlotOptions } from './check-client.js';

export type { CheckOptions } from '@hornhoof/protocol';

let client: CheckClient | null = null;
const leased = new AsyncLocalStorage<{ lease: CheckLease; active: boolean }>();
const leases = new Map<string, { lease: CheckLease; agentId?: string; jobId?: string; active: boolean; children: Set<Promise<unknown>> }>();

const blocked = new Map<number, string>();
export function setCheckClient(next: CheckClient | null): void { client = next; if (!next) blocked.clear(); }
export function suspendCheckSlots(group: number, reason: string | null): void {
  if (reason) blocked.set(group, reason); else blocked.delete(group);
  client?.refuse(blocked.values().next().value ?? null);
}
export function checkQueueOffline(): boolean { return !client?.isOnline(); }
export function checkSlotWaiting(agentId: string, jobId?: string | null): boolean { return client?.waiting(agentId, jobId) ?? false; }
export function currentCheckLease(): string | undefined { const parent = leased.getStore(); return parent?.active ? parent.lease.id : undefined; }
export function currentCheckSignal(): AbortSignal | undefined { return leased.getStore()?.lease.signal; }

export function checkLeaseJob(id: string, agentId: string): string | undefined {
  const entry = leases.get(id);
  return entry?.active && entry.agentId === agentId ? entry.jobId : undefined;
}

export async function reuseCheckLease<T>(id: string, agentId: string | undefined, signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>, jobId?: string): Promise<T> {
  const entry = leases.get(id);
  if (!entry?.active || entry.agentId !== agentId || entry.jobId !== jobId) throw new Error('The parent check slot is no longer active.');
  const context = { lease: { ...entry.lease, signal: AbortSignal.any([entry.lease.signal, signal]) }, active: true };
  const pending = Promise.resolve().then(() => leased.run(context, () => run(context.lease.signal)));
  entry.children.add(pending);
  try { return await pending; }
  finally { context.active = false; entry.children.delete(pending); }
}

/* The callback covers checkout, dependency preparation, services, execution and cleanup.
   Use its signal for child processes: it includes both the caller's deadline and loss of the lease. */
export async function withCheckSlot<T>(run: (signal: AbortSignal) => Promise<T>, options: SlotOptions = {}): Promise<T> {
  options.signal?.throwIfAborted();
  const parent = leased.getStore();
  if (parent?.active) {
    const entry = leases.get(parent.lease.id);
    return reuseCheckLease(parent.lease.id, options.agentId ?? entry?.agentId, options.signal ?? parent.lease.signal, run, options.jobId ?? entry?.jobId);
  }
  if (!client) throw new Error('Machine check queue is not connected.');
  const lease = await client.acquire(options), context = { lease, active: true };
  const entry = { lease, agentId: options.agentId, jobId: options.jobId, active: true, children: new Set<Promise<unknown>>() };
  leases.set(lease.id, entry);
  return leased.run(context, async () => {
    try { lease.signal.throwIfAborted(); return await run(lease.signal); }
    finally {
      context.active = false; entry.active = false;
      await Promise.allSettled(entry.children);
      leases.delete(lease.id); lease.release();
    }
  });
}
