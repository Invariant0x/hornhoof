import { describe, expect, it } from 'vitest';
import { drawOnce, joinRoads, ROAD, roadForks, type Way } from '../src/map-roads';
import type { Rect } from '../src/ui/ortho';
import type { Point } from '../src/ui/wires';

const right = (r: Rect) => r.x + r.w, bottom = (r: Rect) => r.y + r.h;
const onEdge = ([x, y]: Point, r: Rect) =>
  ((x === r.x || x === right(r)) && y >= r.y && y <= bottom(r)) || ((y === r.y || y === bottom(r)) && x >= r.x && x <= right(r));
const square = (pts: Point[]) => pts.slice(1).every((p, i) => p[0] === pts[i]![0] || p[1] === pts[i]![1]);
const through = (a: Point, b: Point, r: Rect) =>
  Math.max(a[0], b[0]) > r.x && Math.min(a[0], b[0]) < right(r) && Math.max(a[1], b[1]) > r.y && Math.min(a[1], b[1]) < bottom(r);
const segments = (pts: Point[]) => pts.slice(1).map((b, i): [Point, Point] => [pts[i]!, b]);

/* A card on top and two cards below it; a line from the card to each, the two running side by side 12 apart. */
const TOP: Rect = { x: 0, y: 0, w: 120, h: 40 }, LEFT: Rect = { x: 300, y: 200, w: 120, h: 40 }, FAR: Rect = { x: 500, y: 200, w: 120, h: 40 };
const toLeft: Way = { pts: [[40, 40], [40, 100], [360, 100], [360, 200]], ends: [TOP, LEFT] };
const toFar: Way = { pts: [[52, 40], [52, 112], [560, 112], [560, 200]], ends: [TOP, FAR] };

describe('lines that run side by side', () => {
  it('join into one road, and each leaves it for its own block', () => {
    const [a, b] = joinRoads([toLeft, toFar], [TOP, LEFT, FAR]);
    /* One way down from the card and one way across, shared, and the far line goes on alone. */
    expect(a![0]).toEqual(b![0]);
    expect(a![1]).toEqual(b![1]);
    expect(a![2]![1]).toBe(b![2]![1]);
    expect(b![2]![0]).toBeGreaterThan(a![2]![0]);
    for (const [pts, end] of [[a!, LEFT], [b!, FAR]] as const) {
      expect(square(pts)).toBe(true);
      expect(onEdge(pts[0]!, TOP)).toBe(true);
      expect(onEdge(pts[pts.length - 1]!, end)).toBe(true);
    }
  });

  it('take the road a line that keeps its place already runs on', () => {
    const fixed: Way = { pts: [[0, 300], [600, 300]], fixed: true };
    const near: Way = { pts: [[100, 250], [100, 316], [400, 316], [400, 400]] };
    const [kept, joined] = joinRoads([fixed, near], []);
    expect(kept).toEqual(fixed.pts);
    expect(joined).toEqual([[100, 250], [100, 300], [400, 300], [400, 400]]);
  });

  it('join on the other line when joining on the first would take one through a block', () => {
    /* The longer line runs at 100, where a block stands in the way of the shorter one; so the road runs at 112. */
    const wall: Rect = { x: 450, y: 96, w: 20, h: 8 }, end: Rect = { x: 700, y: 200, w: 120, h: 40 };
    const [a, b] = joinRoads([{ pts: [[40, 40], [40, 100], [760, 100], [760, 200]], ends: [TOP, end] }, toFar], [TOP, LEFT, FAR, end, wall]);
    for (const pts of [a!, b!]) expect(segments(pts).some(([p, q]) => through(p, q, wall)), JSON.stringify(pts)).toBe(false);
    expect([a![1], b![1]]).toEqual([[40, 112], [40, 112]]);
  });

  it('stay as they are when a road apart or more', () => {
    const apart: Way = { ...toFar, pts: [[80, 40], [80, 100 + ROAD], [560, 100 + ROAD], [560, 200]] };
    expect(joinRoads([toLeft, apart], [TOP, LEFT, FAR])).toEqual([toLeft.pts, apart.pts]);
  });

  it('slide an end only along the side it meets, clear of its corners', () => {
    /* The card's own side ends 4 past the other line: the end may not slide that close to the corner. */
    const small: Rect = { x: 0, y: 30, w: 30, h: 82 };
    const side: Way = { pts: [[30, 108], [600, 108]], ends: [small, null] };
    const other: Way = { pts: [[0, 120], [600, 120]], fixed: true };
    const [moved] = joinRoads([side, other], [small]);
    expect(moved).toEqual(side.pts);
  });

  it('never fold a line onto itself', () => {
    const u: Way = { pts: [[0, 0], [0, 100], [10, 100], [10, 0]] };
    expect(joinRoads([u], [])).toEqual([u.pts]);
  });
});

describe('drawing the roads', () => {
  it('draws a stretch that lines share once, with the first line that runs on it', () => {
    const first: Point[] = [[0, 0], [100, 0], [100, 50]];
    expect(drawOnce([first, [[0, 0], [100, 0], [200, 0]], [[0, 0], [60, 0]], [[-50, 0], [300, 0]]])).toEqual([
      [first],
      [[[100, 0], [200, 0]]],
      [],
      [[[-50, 0], [0, 0]], [[200, 0], [300, 0]]],
    ]);
  });

  it('keeps the turns of what is left of a line', () => {
    expect(drawOnce([[[0, 0], [0, 40]], [[0, 0], [0, 40], [80, 40], [80, 90]]])).toEqual([[[[0, 0], [0, 40]]], [[[0, 40], [80, 40], [80, 90]]]]);
  });

  it('marks where a road forks, but not where two lines only cross or inside a block', () => {
    const road: Point[] = [[0, 0], [100, 0]];
    expect(roadForks([road, [[50, 0], [50, 50]]], [])).toEqual([[50, 0]]);
    expect(roadForks([road, [[50, -50], [50, 50]]], [])).toEqual([]);
    expect(roadForks([road, [[50, 0], [50, 50]]], [{ x: 40, y: -10, w: 20, h: 20 }])).toEqual([]);
    /* A line that comes along the road and turns off it forks it too. */
    expect(roadForks([road, [[0, 0], [70, 0], [70, 30]]], [])).toEqual([[70, 0]]);
  });
});
