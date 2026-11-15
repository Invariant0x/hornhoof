export const DAY_MS = 86_400_000;
const EVERY_MS = 20_000;

/* The round trips of a day to one machine, and their median. At most one sample is kept for each stretch of everyMs,
   so a day is a few thousand numbers however often the trip is made. */
export class RoundTrips {
  private readonly samples: { ms: number; at: number }[] = [];
  private readonly keepMs: number;
  private readonly everyMs: number;

  constructor(opts: { keepMs?: number; everyMs?: number } = {}) {
    this.keepMs = opts.keepMs ?? DAY_MS;
    this.everyMs = opts.everyMs ?? EVERY_MS;
  }

  /* at: the moment of the sample, in ms as Date.now() counts them. */
  add(ms: number, at: number): void {
    const last = this.samples.at(-1);
    if (last && at - last.at < this.everyMs) return;
    this.samples.push({ ms, at });
    this.drop(at);
  }

  /* Of the samples within the day, rounded; null with none. */
  median(now: number): number | null {
    this.drop(now);
    if (this.samples.length === 0) return null;
    const sorted = this.samples.map(sample => sample.ms).sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return Math.round(sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2);
  }

  private drop(now: number): void {
    while (this.samples.length > 0 && this.samples[0]!.at < now - this.keepMs) this.samples.shift();
  }
}
