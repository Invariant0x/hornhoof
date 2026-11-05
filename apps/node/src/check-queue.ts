import { AsyncLocalStorage } from 'node:async_hooks';

export type CheckOptions = { signal?: AbortSignal; onPosition?(position: number): void };
type Waiting = { start(): void; cancel(reason?: unknown): void; options: CheckOptions; position: number };

export class CheckQueue {
  private running = 0;
  private readonly waiting: Waiting[] = [];
  private readonly context = new AsyncLocalStorage<{ active: boolean }>();
  constructor(readonly capacity: () => number) {}

  async withSlot<T>(run: () => Promise<T>, options: CheckOptions = {}): Promise<T> {
    options.signal?.throwIfAborted();
    if (this.context.getStore()?.active) return run();
    await this.acquire(options);
    const context = { active: true };
    return this.context.run(context, async () => {
      try { return await run(); }
      finally { context.active = false; this.running--; this.pump(); }
    });
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
          remove();
          this.waiting.splice(this.waiting.indexOf(entry), 1);
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
