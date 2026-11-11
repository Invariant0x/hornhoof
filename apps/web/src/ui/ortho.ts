import type { Point } from './wires';

/* A block on the map in world pixels: its top left and its size. A block of no size is a point, such as the middle of the hub. */
export type Rect = { x: number; y: number; w: number; h: number };

/* How far a way keeps from a block it passes; how far from a block's corner it meets the block; what a turn costs, in pixels
   of length, so a way with fewer turns wins unless it is much longer. */
const CLEAR = 16, PAD = CLEAR / 2, CORNER = 12, TURN = 60;

type Dir = 0 | 1 | 2 | 3;
/* Right, down, left, up. */
const STEP: Record<Dir, Point> = { 0: [1, 0], 1: [0, 1], 2: [-1, 0], 3: [0, -1] };

const right = (r: Rect) => r.x + r.w, bottom = (r: Rect) => r.y + r.h;
const midX = (r: Rect) => r.x + r.w / 2, midY = (r: Rect) => r.y + r.h / 2;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/* How far from a corner a way meets a side of this block: the corner gap, or the middle of a side shorter than two of them. */
const inset = (size: number) => Math.min(CORNER, size / 2);

/* Whether the segment a-b runs through the inside of r grown by pad on every side. */
export function through(a: Point, b: Point, r: Rect, pad: number): boolean {
  return Math.max(a[0], b[0]) > r.x - pad && Math.min(a[0], b[0]) < right(r) + pad && Math.max(a[1], b[1]) > r.y - pad && Math.min(a[1], b[1]) < bottom(r) + pad;
}

const segmentsOf = (pts: Point[]) => pts.slice(1).map((b, i): [Point, Point] => [pts[i]!, b]);

/* Drops repeated points and points in the middle of a straight run. */
export function tidy(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    const before = out[out.length - 2];
    if (last && before && ((before[0] === last[0] && last[0] === p[0]) || (before[1] === last[1] && last[1] === p[1]))) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/* A way that runs through neither end, and how much it costs: blocks it crosses first, then turns, then length. */
function score(pts: Point[], a: Rect, b: Rect, others: readonly Rect[]): number {
  let cost = 0;
  for (const [p, q] of segmentsOf(pts)) {
    if (through(p, q, a, -0.5) || through(p, q, b, -0.5)) return Infinity;
    for (const o of others) if (through(p, q, o, PAD)) cost += 1e6;
    cost += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]);
  }
  return cost + (pts.length - 2) * TURN;
}

/* The simple ways: straight, with one turn, or with two turns in the gap between the blocks. */
function simpleWays(a: Rect, b: Rect): Point[][] {
  const ways: Point[][] = [];
  const top = Math.max(a.y + inset(a.h), b.y + inset(b.h)), low = Math.min(bottom(a) - inset(a.h), bottom(b) - inset(b.h));
  const left = Math.max(a.x + inset(a.w), b.x + inset(b.w)), far = Math.min(right(a) - inset(a.w), right(b) - inset(b.w));
  const y = clamp((midY(a) + midY(b)) / 2, top, low), x = clamp((midX(a) + midX(b)) / 2, left, far);
  if (top <= low && right(a) <= b.x) ways.push([[right(a), y], [b.x, y]]);
  if (top <= low && right(b) <= a.x) ways.push([[a.x, y], [right(b), y]]);
  if (left <= far && bottom(a) <= b.y) ways.push([[x, bottom(a)], [x, b.y]]);
  if (left <= far && bottom(b) <= a.y) ways.push([[x, a.y], [x, bottom(b)]]);
  /* Across out of the near side, then down into the middle of the far block's top or bottom; and the other way round. */
  const ax = midX(b) > right(a) ? right(a) : midX(b) < a.x ? a.x : null;
  const by = midY(a) < b.y ? b.y : midY(a) > bottom(b) ? bottom(b) : null;
  if (ax !== null && by !== null) ways.push([[ax, midY(a)], [midX(b), midY(a)], [midX(b), by]]);
  const ay = midY(b) > bottom(a) ? bottom(a) : midY(b) < a.y ? a.y : null;
  const bx = midX(a) < b.x ? b.x : midX(a) > right(b) ? right(b) : null;
  if (ay !== null && bx !== null) ways.push([[midX(a), ay], [midX(a), midY(b)], [bx, midY(b)]]);
  /* Two turns in the middle of the gap between them. */
  if (right(a) < b.x) ways.push([[right(a), midY(a)], [(right(a) + b.x) / 2, midY(a)], [(right(a) + b.x) / 2, midY(b)], [b.x, midY(b)]]);
  if (right(b) < a.x) ways.push([[a.x, midY(a)], [(a.x + right(b)) / 2, midY(a)], [(a.x + right(b)) / 2, midY(b)], [right(b), midY(b)]]);
  if (bottom(a) < b.y) ways.push([[midX(a), bottom(a)], [midX(a), (bottom(a) + b.y) / 2], [midX(b), (bottom(a) + b.y) / 2], [midX(b), b.y]]);
  if (bottom(b) < a.y) ways.push([[midX(a), a.y], [midX(a), (a.y + bottom(b)) / 2], [midX(b), (a.y + bottom(b)) / 2], [midX(b), bottom(b)]]);
  return ways.map(tidy);
}

/* Where a way may leave or reach a block, heading out of it: the middle of each side, or a point in every direction. */
function portsOf(r: Rect): { at: Point; out: Dir }[] {
  if (!r.w && !r.h) return ([0, 1, 2, 3] as Dir[]).map(out => ({ at: [r.x, r.y], out }));
  return [
    { at: [right(r), midY(r)], out: 0 },
    { at: [midX(r), bottom(r)], out: 1 },
    { at: [r.x, midY(r)], out: 2 },
    { at: [midX(r), r.y], out: 3 },
  ];
}

/* A small heap of states by cost, for the search around blocks. */
class Queue {
  private items: { cost: number; state: number }[] = [];
  get size() { return this.items.length; }
  push(cost: number, state: number) {
    const items = this.items;
    items.push({ cost, state });
    let i = items.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (items[up]!.cost <= items[i]!.cost) break;
      [items[up], items[i]] = [items[i]!, items[up]!];
      i = up;
    }
  }
  pop(): { cost: number; state: number } {
    const items = this.items;
    const top = items[0]!, last = items.pop()!;
    if (items.length) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < items.length && items[l]!.cost < items[m]!.cost) m = l;
        if (r < items.length && items[r]!.cost < items[m]!.cost) m = r;
        if (m === i) break;
        [items[m], items[i]] = [items[i]!, items[m]!];
        i = m;
      }
    }
    return top;
  }
}

/* The cheapest way along lines just clear of every block, when no simple way is clear: from a side of a, out of it, to a side
   of b, into it. Null when the blocks leave no way at all. */
function aroundWay(a: Rect, b: Rect, others: readonly Rect[]): Point[] | null {
  const from = portsOf(a), to = portsOf(b);
  const xs = [...new Set([...from, ...to].map(p => p.at[0]).concat(...[a, b, ...others].map(r => [r.x - CLEAR, right(r) + CLEAR])))].sort((p, q) => p - q);
  const ys = [...new Set([...from, ...to].map(p => p.at[1]).concat(...[a, b, ...others].map(r => [r.y - CLEAR, bottom(r) + CLEAR])))].sort((p, q) => p - q);
  const W = xs.length, H = ys.length;
  const node = (i: number, j: number) => j * W + i;
  const pointOf = (n: number): Point => [xs[n % W]!, ys[Math.floor(n / W)]!];
  /* Each end, by the way a step must head to come into it: a point takes one from any side. */
  const ends = new Map<number, Set<Dir>>();
  for (const p of to) {
    const n = node(xs.indexOf(p.at[0]), ys.indexOf(p.at[1]));
    ends.set(n, (ends.get(n) ?? new Set<Dir>()).add(((p.out + 2) % 4) as Dir));
  }
  /* A step may run up to a side of an end only where it leaves or reaches that end. */
  const open = (p: Point, q: Point, last: boolean, first: boolean) =>
    !others.some(o => through(p, q, o, PAD)) &&
    !through(p, q, a, first ? -0.5 : PAD) &&
    !through(p, q, b, last ? -0.5 : PAD);
  const best = new Map<number, number>(), back = new Map<number, number>();
  const queue = new Queue();
  for (const p of from) {
    const state = node(xs.indexOf(p.at[0]), ys.indexOf(p.at[1])) * 4 + p.out;
    best.set(state, 0);
    back.set(state, -1);
    queue.push(0, state);
  }
  const starts = new Set([...best.keys()].map(s => s >> 2));
  while (queue.size) {
    const { cost, state } = queue.pop();
    if (cost > (best.get(state) ?? Infinity)) continue;
    const n = state >> 2, dir = (state & 3) as Dir;
    if (ends.get(n)?.has(dir) && !starts.has(n)) {
      const pts: Point[] = [];
      for (let s = state; s !== -1; s = back.get(s)!) pts.push(pointOf(s >> 2));
      return tidy(pts.reverse());
    }
    for (const turn of [dir, (dir + 1) % 4, (dir + 3) % 4] as Dir[]) {
      const i = n % W, j = Math.floor(n / W);
      const ni = i + STEP[turn][0], nj = j + STEP[turn][1];
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const m = node(ni, nj);
      const p = pointOf(n), q = pointOf(m);
      if (!open(p, q, ends.has(m), starts.has(n))) continue;
      const next = cost + Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + (turn === dir ? 0 : TURN);
      const s = m * 4 + turn;
      if (next < (best.get(s) ?? Infinity)) {
        best.set(s, next);
        back.set(s, state);
        queue.push(next, s);
      }
    }
  }
  return null;
}

/* A way from an edge of block a to an edge of block b made only of runs across and down, around the other blocks where a
   simple way around exists: straight when the blocks face each other, else with as few turns as the blocks around allow. */
export function orthoRoute(a: Rect, b: Rect, others: readonly Rect[] = []): Point[] {
  const ranked = simpleWays(a, b).map(pts => ({ pts, cost: score(pts, a, b, others) })).filter(w => Number.isFinite(w.cost)).sort((p, q) => p.cost - q.cost);
  const simple = ranked[0];
  if (simple && simple.cost < 1e6) return simple.pts;
  const around = aroundWay(a, b, others);
  if (around) return around;
  return simple?.pts ?? tidy([[midX(a), midY(a)], [midX(a), midY(b)], [midX(b), midY(b)]]);
}
