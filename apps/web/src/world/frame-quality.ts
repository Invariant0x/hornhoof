/* Quality steps of the world by measured frame time (#1947 item 6). The engine feeds every frame's length; while the
   average frame stays slower than 30 a second the world steps down one level, while it stays faster than 50 a second
   for a long while it steps back up. Nothing here looks at the device or the browser, so every browser behaves the
   same: only the frames it actually draws count. */

export type QualityAnimation = 'full' | 'reduced' | 'still';

export type QualityStep = Readonly<{
  /* Share of the screen's pixel density the world draws at. */
  resolution: number;
  /* Share of the wild plants drawn, the same ones each frame. */
  plants: number;
  /* full: everything moves; reduced: one water layer, no cloth sway; still: plants and cloth stand still too. */
  animation: QualityAnimation;
}>;

export const QUALITY_STEPS: readonly QualityStep[] = [
  { resolution: 1, plants: 1, animation: 'full' },
  { resolution: 1, plants: 0.6, animation: 'reduced' },
  { resolution: 0.75, plants: 0.6, animation: 'reduced' },
  { resolution: 0.5, plants: 0.35, animation: 'still' },
];

const SLOW_FRAME_MS = 1000 / 30;
const FAST_FRAME_MS = 1000 / 50;
/* How long the average must stay slow before a step down, and fast before a step up. */
const DOWN_AFTER_MS = 2000;
const UP_AFTER_MS = 8000;
/* After a change the average settles before it counts again. */
const SETTLE_MS = 1000;
/* A frame this long is a page coming back from hidden or a debugger, not drawing, and is no sample; a browser drawing
   without a GPU can take half a second a frame, and that counts. */
const GAP_MS = 1000;
/* A step up that turns frames slow within this time is not tried again for a while. */
const PROVE_MS = 10_000;
const BLOCK_MS = 60_000;
const AVERAGE_WEIGHT = 0.1;

export class FrameQuality {
  level = 0;
  private average: number | null = null;
  private slowSince: number | null = null;
  private fastSince: number | null = null;
  private settleUntil = 0;
  private lastUpAt: number | null = null;
  private readonly blockedUntil = new Map<number, number>();

  get step(): QualityStep {
    return QUALITY_STEPS[this.level]!;
  }

  /* One drawn frame of frameMs at time now; the level to draw the next frames at. */
  frame(frameMs: number, now: number): number {
    if (!(frameMs > 0) || frameMs > GAP_MS) {
      this.slowSince = null;
      this.fastSince = null;
      return this.level;
    }
    this.average = this.average === null ? frameMs : this.average * (1 - AVERAGE_WEIGHT) + frameMs * AVERAGE_WEIGHT;
    if (now < this.settleUntil) return this.level;
    if (this.average > SLOW_FRAME_MS) {
      this.fastSince = null;
      this.slowSince ??= now;
      if (now - this.slowSince >= DOWN_AFTER_MS && this.level < QUALITY_STEPS.length - 1) {
        if (this.lastUpAt !== null && now - this.lastUpAt < PROVE_MS) this.blockedUntil.set(this.level, now + BLOCK_MS);
        this.change(this.level + 1, now);
      }
    } else if (this.average < FAST_FRAME_MS) {
      this.slowSince = null;
      this.fastSince ??= now;
      const up = this.level - 1;
      if (now - this.fastSince >= UP_AFTER_MS && up >= 0 && now >= (this.blockedUntil.get(up) ?? 0)) {
        this.change(up, now);
        this.lastUpAt = now;
      }
    } else {
      this.slowSince = null;
      this.fastSince = null;
    }
    return this.level;
  }

  /* The map is shown again after being hidden: the level stays, the frames before count no more. */
  restart(now: number): void {
    this.average = null;
    this.slowSince = null;
    this.fastSince = null;
    this.settleUntil = now + SETTLE_MS;
  }

  private change(level: number, now: number): void {
    this.level = level;
    this.slowSince = null;
    this.fastSince = null;
    this.settleUntil = now + SETTLE_MS;
  }
}
