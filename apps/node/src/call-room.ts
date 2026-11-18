/* Where one-shot calls start: all at once, with no count of their own, while the machine's last report found no process
   its kernel killed for want of memory. After one that did, new calls wait in their order and start once a report finds
   none, as the node looks at its machine; the calls that run go on. A call takes no slot of the check queue: it waits on
   its model. */
export class CallRoom {
  private readonly queue: { go: () => void; signal: AbortSignal; stop: () => void }[] = [];

  /* short: whether the machine's last report found a kill for want of memory. */
  constructor(private readonly short: () => boolean) {}

  enter(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const waiting = {
        go: resolve,
        signal,
        stop: () => {
          this.queue.splice(this.queue.indexOf(waiting), 1);
          reject(signal.reason as Error);
        },
      };
      signal.addEventListener('abort', waiting.stop, { once: true });
      this.queue.push(waiting);
      this.look();
    });
  }

  /* Starts the calls that wait, first come first, unless the machine is short of memory now. */
  look(): void {
    while (this.queue.length && !this.short()) {
      const next = this.queue.shift()!;
      next.signal.removeEventListener('abort', next.stop);
      next.go();
    }
  }
}
