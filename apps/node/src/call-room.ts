/* The program a one-shot call runs, alone and once, with no session and none of a turn's helpers: about 400 MB. */
export const CALL_BYTES = 400 * 2 ** 20;

/* A call that got its room: its program said its first word, so the memory it takes shows in the machine's own measure from
   then on; or it ended. */
export type CallSeat = { settled(): void; leave(): void };

type Waiting = { go: (seat: CallSeat) => void; signal: AbortSignal; stop: () => void };

/* Where one-shot calls start: as many at once as the machine's memory holds, with no count of its own. One more starts while
   the memory a new program can get holds its program besides the calls that started and do not show in that memory yet.
   Where no call runs, one starts all the same, so a small machine is never left with none. The others wait in their order
   and look again when a call says its first word or ends, and whenever the node looks at its machine. A call takes no slot
   of the check queue: it waits on its model, and its cost on the machine is the memory of its program. */
export class CallRoom {
  private running = 0;
  /* Calls that started and whose programs have not said a word yet. */
  private fresh = 0;
  private readonly queue: Waiting[] = [];

  /* free: the memory a new program can get now. */
  constructor(private readonly free: () => number, private readonly size = CALL_BYTES) {}

  enter(signal: AbortSignal): Promise<CallSeat> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const waiting: Waiting = {
        go: resolve,
        signal,
        stop: () => {
          this.queue.splice(this.queue.indexOf(waiting), 1);
          reject(signal.reason as Error);
          this.look();
        },
      };
      signal.addEventListener('abort', waiting.stop, { once: true });
      this.queue.push(waiting);
      this.look();
    });
  }

  /* Starts the calls the memory has room for now, first come first. */
  look(): void {
    while (this.queue.length && this.fits()) {
      const next = this.queue.shift()!;
      next.signal.removeEventListener('abort', next.stop);
      next.go(this.seat());
    }
  }

  private fits(): boolean {
    return this.running === 0 || this.free() - this.fresh * this.size >= this.size;
  }

  private seat(): CallSeat {
    this.running += 1;
    this.fresh += 1;
    let fresh = true, gone = false;
    const settle = () => {
      if (!fresh) return;
      fresh = false;
      this.fresh -= 1;
    };
    return {
      settled: () => {
        settle();
        this.look();
      },
      leave: () => {
        if (gone) return;
        gone = true;
        settle();
        this.running -= 1;
        this.look();
      },
    };
  }
}
