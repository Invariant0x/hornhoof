export type HookRejected = (key: string | null, event: string, reason: string) => void;
const EVERY_MS = 60_000;

/* Status hooks run many times a minute. One repeated cause says enough without flooding the node or the server. */
export class HookFailures {
  private readonly heard = new Map<string, number>();
  constructor(private readonly report?: HookRejected) {}

  reject(key: string | null, event: string, reason: string): void {
    const now = Date.now();
    const id = JSON.stringify([key, event, reason]);
    if (now - (this.heard.get(id) ?? -Infinity) < EVERY_MS) return;
    for (const [id, at] of this.heard) if (now - at >= EVERY_MS) this.heard.delete(id);
    this.heard.set(id, now);
    this.report?.(key, event, reason);
  }
}
