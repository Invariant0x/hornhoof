import { z } from 'zod';

export const CHECK_LEASE_MS = 90_000;
const Id = z.uuid();
/* resume: the node claims again, after a reconnect, a lease it held; the server keeps it or answers ended, never queues it anew. */
export const CheckAcquire = z.object({ type: z.literal('check.acquire'), id: Id, label: z.string().max(100), agentId: Id.optional(), jobId: Id.optional(), resume: z.literal(true).optional() });
export const CheckRelease = z.object({ type: z.literal('check.release'), id: Id });
export const CheckQueueRequest = z.discriminatedUnion('type', [CheckAcquire, CheckRelease]);
export type CheckQueueRequest = z.infer<typeof CheckQueueRequest>;
export const CheckQueueReply = z.object({
  type: z.literal('check.state'), id: Id,
  state: z.enum(['queued', 'running', 'ended']), position: z.number().int().nonnegative(),
}).refine(reply => reply.state === 'queued' ? reply.position > 0 : reply.position === 0);
export type CheckQueueReply = z.infer<typeof CheckQueueReply>;

/* Benchmarks passed two concurrent checks on nine CPUs and failed at four.
   Reserve five CPU equivalents per unbounded check, falling back to one while load is high.
   An active check is never killed when a newer load measurement reduces admission. */
export function checkCapacity(cpus: number, load: number): number {
  return Math.max(1, Math.floor((cpus - load) / 5));
}

export type CheckOptions = { signal?: AbortSignal; onPosition?(position: number): void };
type Waiting = { start(): void; cancel(reason?: unknown): void; options: CheckOptions; position: number };

export class CheckSlotQueue {
  private running = 0;
  private readonly waiting: Waiting[] = [];
  constructor(readonly capacity: () => number) {}

  async withSlot<T>(run: () => Promise<T>, options: CheckOptions = {}): Promise<T> {
    options.signal?.throwIfAborted();
    await this.acquire(options);
    try { options.signal?.throwIfAborted(); return await run(); }
    finally { this.running--; this.pump(); }
  }

  private acquire(options: CheckOptions): Promise<void> {
    options.signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => entry.cancel(options.signal?.reason);
      const remove = () => options.signal?.removeEventListener('abort', abort);
      const entry: Waiting = {
        options, position: 0,
        start: () => { remove(); resolve(); },
        cancel: reason => {
          const index = this.waiting.indexOf(entry);
          if (index < 0) return;
          remove();
          this.waiting.splice(index, 1);
          reject(reason);
          this.pump();
        },
      };
      this.waiting.push(entry);
      options.signal?.addEventListener('abort', abort, { once: true });
      this.pump();
    });
  }

  refresh(): void { this.pump(); }

  private pump(): void {
    while (this.waiting.length && this.running < this.capacity()) {
      const entry = this.waiting.shift()!;
      this.running++;
      entry.start();
    }
    this.waiting.forEach((entry, index) => {
      if (entry.position === index + 1) return;
      entry.position = index + 1;
      try { entry.options.onPosition?.(entry.position); }
      catch (error) { entry.cancel(error); }
    });
  }
}
