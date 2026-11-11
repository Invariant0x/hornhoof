import { describe, expect, it } from 'vitest';
import { orthoRoute, type Rect } from '../src/ui/ortho';
import type { Point } from '../src/ui/wires';

const right = (r: Rect) => r.x + r.w, bottom = (r: Rect) => r.y + r.h;
const onEdge = ([x, y]: Point, r: Rect) =>
  ((x === r.x || x === right(r)) && y >= r.y && y <= bottom(r)) || ((y === r.y || y === bottom(r)) && x >= r.x && x <= right(r));
const square = (pts: Point[]) => pts.slice(1).every((p, i) => p[0] === pts[i]![0] || p[1] === pts[i]![1]);
/* Whether a segment runs through the inside of a block, not just along or up to its edge. */
const through = (a: Point, b: Point, r: Rect) =>
  Math.max(a[0], b[0]) > r.x && Math.min(a[0], b[0]) < right(r) && Math.max(a[1], b[1]) > r.y && Math.min(a[1], b[1]) < bottom(r);
const segments = (pts: Point[]) => pts.slice(1).map((b, i): [Point, Point] => [pts[i]!, b]);
const apart = (a: Rect, b: Rect) => right(a) <= b.x || right(b) <= a.x || bottom(a) <= b.y || bottom(b) <= a.y;

/* The same blocks on every run: a small linear congruential generator. */
function blocks(seed: number, n: number): Rect[] {
  let s = seed;
  const next = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out: Rect[] = [];
  while (out.length < n) {
    const r = { x: Math.round(next() * 1400) - 200, y: Math.round(next() * 1000) - 100, w: 60 + Math.round(next() * 220), h: 40 + Math.round(next() * 120) };
    if (out.every(o => apart({ x: o.x - 30, y: o.y - 30, w: o.w + 60, h: o.h + 60 }, r))) out.push(r);
  }
  return out;
}

describe('a way between two blocks', () => {
  it('runs only across and down, from an edge of one block to an edge of the other, through neither of them', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const [a, b, ...others] = blocks(seed, 6);
      const pts = orthoRoute(a!, b!, others);
      expect(square(pts), `seed ${seed}: ${JSON.stringify(pts)}`).toBe(true);
      expect(onEdge(pts[0]!, a!), `seed ${seed} start`).toBe(true);
      expect(onEdge(pts[pts.length - 1]!, b!), `seed ${seed} end`).toBe(true);
      for (const [p, q] of segments(pts)) {
        expect(through(p, q, a!) || through(p, q, b!), `seed ${seed}: ${JSON.stringify(pts)}`).toBe(false);
        expect(p).not.toEqual(q);
      }
    }
  });

  it('goes around the blocks in its way when a simple way around exists', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const [a, b, ...others] = blocks(seed, 6);
      const pts = orthoRoute(a!, b!, others);
      for (const [p, q] of segments(pts)) for (const o of others) expect(through(p, q, o), `seed ${seed}: ${JSON.stringify(pts)} through ${JSON.stringify(o)}`).toBe(false);
    }
  });

  it('is one straight line between blocks side by side, at the middle of what they share', () => {
    expect(orthoRoute({ x: 0, y: 0, w: 100, h: 60 }, { x: 300, y: 20, w: 100, h: 60 })).toEqual([[100, 40], [300, 40]]);
    expect(orthoRoute({ x: 0, y: 300, w: 100, h: 60 }, { x: 0, y: 0, w: 100, h: 60 })).toEqual([[50, 300], [50, 60]]);
  });

  it('turns once into the middle of the far block when one turn reaches it', () => {
    expect(orthoRoute({ x: 0, y: 0, w: 100, h: 60 }, { x: 300, y: 300, w: 100, h: 60 })).toEqual([[100, 30], [350, 30], [350, 300]]);
  });

  it('steps around a block that stands right between the two', () => {
    const wall = { x: 180, y: -100, w: 40, h: 260 };
    const pts = orthoRoute({ x: 0, y: 0, w: 100, h: 60 }, { x: 300, y: 0, w: 100, h: 60 }, [wall]);
    expect(square(pts)).toBe(true);
    expect(segments(pts).some(([p, q]) => through(p, q, wall))).toBe(false);
    expect(pts[0]).toEqual(expect.arrayContaining([expect.any(Number)]));
    expect(onEdge(pts[0]!, { x: 0, y: 0, w: 100, h: 60 }) && onEdge(pts[pts.length - 1]!, { x: 300, y: 0, w: 100, h: 60 })).toBe(true);
  });

  it('reaches a point from any side, around the blocks in its way', () => {
    const hub = { x: 600, y: 420, w: 0, h: 0 };
    for (const [from, wall] of [
      [{ x: 0, y: 380, w: 100, h: 80 }, { x: 300, y: 300, w: 40, h: 300 }],
      [{ x: 560, y: 900, w: 80, h: 40 }, { x: 450, y: 600, w: 300, h: 40 }],
      [{ x: 1000, y: 100, w: 80, h: 40 }, { x: 500, y: 300, w: 300, h: 40 }],
    ] as const) {
      const pts = orthoRoute(from, hub, [wall]);
      expect(pts[pts.length - 1]).toEqual([600, 420]);
      expect(square(pts)).toBe(true);
      expect(segments(pts).some(([p, q]) => through(p, q, wall)), JSON.stringify(pts)).toBe(false);
    }
    /* Shut close above and on the left, the point is reached from the right or from below. */
    const walls = [{ x: 400, y: 370, w: 400, h: 40 }, { x: 520, y: 410, w: 40, h: 200 }];
    const pts = orthoRoute({ x: 100, y: 100, w: 80, h: 40 }, hub, walls);
    expect(pts[pts.length - 1]).toEqual([600, 420]);
    expect(segments(pts).some(([p, q]) => walls.some(w => through(p, q, w))), JSON.stringify(pts)).toBe(false);
  });

  it('leaves a point, such as the middle of the hub, in a straight line along one axis', () => {
    const pts = orthoRoute({ x: 600, y: 420, w: 0, h: 0 }, { x: 200, y: 100, w: 280, h: 160 });
    expect(pts[0]).toEqual([600, 420]);
    expect(square(pts)).toBe(true);
    expect(onEdge(pts[pts.length - 1]!, { x: 200, y: 100, w: 280, h: 160 })).toBe(true);
  });
});
