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
const CHECK_CORES = 5;
export function checkCapacity(cpus: number, load: number): number {
  return Math.max(1, Math.floor((cpus - load) / CHECK_CORES));
}

export const freeCores = (cpus: number, load: number): number => Math.max(0, Math.floor(cpus - load));

/* Zero names an unbounded check. Its one-slot fallback is for hosts running only unbounded checks. */
export function fitsCheck(cpus: number, load: number, held: Iterable<number>, next: number): boolean {
  const active = [...held];
  if (!next && active.every(cores => !cores)) return active.length < checkCapacity(cpus, load);
  return active.reduce((used, cores) => used + (cores || CHECK_CORES), next || CHECK_CORES) <= freeCores(cpus, load);
}

export type CheckOptions = { signal?: AbortSignal; onPosition?(position: number): void; cores?: number };
type Waiting = { start(): void; cancel(reason?: unknown): void; options: CheckOptions; position: number };

export class CheckSlotQueue {
  private readonly running = new Map<Waiting, number>();
  private readonly waiting: Waiting[] = [];
  constructor(readonly capacity: () => number, private readonly fits?: (held: Iterable<number>, cores: number) => boolean) {}

  async withSlot<T>(run: () => Promise<T>, options: CheckOptions = {}): Promise<T> {
    options.signal?.throwIfAborted();
    const entry = await this.acquire(options);
    try { options.signal?.throwIfAborted(); return await run(); }
    finally { this.running.delete(entry); this.pump(); }
  }

  private acquire(options: CheckOptions): Promise<Waiting> {
    options.signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => entry.cancel(options.signal?.reason);
      const remove = () => options.signal?.removeEventListener('abort', abort);
      const entry: Waiting = {
        options, position: 0,
        start: () => { remove(); this.running.set(entry, options.cores ?? 0); resolve(entry); },
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
    while (this.waiting.length && this.running.size < this.capacity()) {
      const entry = this.waiting[0]!;
      if (this.fits && !this.fits(this.running.values(), entry.options.cores ?? 0)) break;
      this.waiting.shift();
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
