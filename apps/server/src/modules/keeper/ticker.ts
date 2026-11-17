/* A round every so many milliseconds that keeps no process alive. Started twice it still runs once, and once stopped it
   never starts again. */
export class Ticker {
  private timer: NodeJS.Timeout | null = null;
  private off = false;

  constructor(private readonly round: () => Promise<void>, private readonly everyMs: number) {}

  get stopped(): boolean {
    return this.off;
  }

  start(): void {
    if (this.timer || this.off) return;
    this.timer = setInterval(() => void this.round(), this.everyMs);
    this.timer.unref();
  }

  stop(): void {
    this.off = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
