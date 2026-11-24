import { describe, expect, it } from 'vitest';
import { FrameQuality, QUALITY_STEPS } from '../src/world/frame-quality';

/* #1947 item 6: the world lowers its quality by the frame time it measures, never by the name of the device or
   browser, and raises it again once frames are fast for a while, without swinging back and forth. */

/* Feeds frames of one length for a while; the level after each frame. */
function run(q: FrameQuality, frameMs: number, forMs: number, clock: { now: number }): number[] {
  const levels: number[] = [];
  for (let t = 0; t < forMs; t += frameMs) {
    clock.now += frameMs;
    levels.push(q.frame(frameMs, clock.now));
  }
  return levels;
}

describe('World quality steps by measured frame time (#1947 item 6)', () => {
  it('stays at full quality while frames are fast', () => {
    const clock = { now: 0 };
    const q = new FrameQuality();
    expect(new Set(run(q, 16.7, 60_000, clock))).toEqual(new Set([0]));
  });

  it('steps down one level at a time while frames stay slow, down to the lowest, and no further', () => {
    const clock = { now: 0 };
    const q = new FrameQuality();
    const levels = run(q, 100, 30_000, clock);
    const changes = levels.filter((l, i) => i > 0 && l !== levels[i - 1]);
    expect(changes).toEqual([1, 2, 3]);
    expect(levels[levels.length - 1]).toBe(QUALITY_STEPS.length - 1);
  });

  it('steps down as well when every frame takes half a second, as a browser drawing without a GPU gives', () => {
    const clock = { now: 0 };
    const q = new FrameQuality();
    run(q, 500, 30_000, clock);
    expect(q.level).toBe(QUALITY_STEPS.length - 1);
  });

  it('does not step down for a short stall, as a garbage collection or a tab coming back gives', () => {
    const clock = { now: 0 };
    const q = new FrameQuality();
    run(q, 16.7, 5_000, clock);
    expect(run(q, 120, 400, clock).every(l => l === 0)).toBe(true);
    /* A frame after the page was hidden for seconds is no measure of drawing. */
    clock.now += 5_000;
    expect(q.frame(5_000, clock.now)).toBe(0);
    expect(run(q, 16.7, 5_000, clock).every(l => l === 0)).toBe(true);
  });

  it('steps up again after a long while of fast frames, and stays down once going up made frames slow again', () => {
    const clock = { now: 0 };
    const q = new FrameQuality();
    run(q, 100, 30_000, clock);
    expect(q.level).toBe(3);
    const up = run(q, 12, 20_000, clock);
    expect(up[up.length - 1], 'fast frames bring quality back step by step').toBeLessThan(3);
    const levelUp = q.level;
    /* At the higher level the frames are slow again: back down, and the level that proved too much is not tried soon. */
    run(q, 60, 3_000, clock);
    expect(q.level).toBe(levelUp + 1);
    const after = run(q, 12, 15_000, clock);
    expect(after.every(l => l === levelUp + 1), 'no swing back within the same while').toBe(true);
  });

  it('starts over when the map is shown again after being hidden', () => {
    const clock = { now: 0 };
    const q = new FrameQuality();
    run(q, 100, 4_000, clock);
    const level = q.level;
    q.restart(clock.now);
    run(q, 100, 400, clock);
    expect(q.level, 'keeps the level it found, and does not step on the frames before').toBe(level);
  });

  it('lowers render resolution, plant density and animation by step, each step no richer than the one before', () => {
    expect(QUALITY_STEPS[0]).toEqual({ resolution: 1, plants: 1, animation: 'full' });
    for (let i = 1; i < QUALITY_STEPS.length; i++) {
      const a = QUALITY_STEPS[i - 1]!;
      const b = QUALITY_STEPS[i]!;
      expect(b.resolution).toBeLessThanOrEqual(a.resolution);
      expect(b.plants).toBeLessThanOrEqual(a.plants);
      expect(b.resolution < a.resolution || b.plants < a.plants || b.animation !== a.animation, `step ${i} lowers something`).toBe(true);
    }
    expect(QUALITY_STEPS[QUALITY_STEPS.length - 1]!.resolution).toBeGreaterThanOrEqual(0.5);
  });
});
