/* One part of a keeper that looks again and again, at its own pace: often while something it takes part in is under
   way, seldom while nothing is. The next look is set only once the last one ended, so two never run at once. */
export class Looks {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  /* look: one look, which says for itself what failed. pace: how long until the next one, asked after each. */
  constructor(private readonly look: () => Promise<void>, private readonly pace: () => number) {}

  start(): void {
    this.next();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private next(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.look().catch(() => undefined).finally(() => this.next()), this.pace());
    this.timer.unref();
  }
}

/* How often a part of the keeper looks while nothing it takes part in is under way. */
export const IDLE_MS = 1000;
