import { through, tidy, type Rect } from './ui/ortho';
import type { Point } from './ui/wires';

/* Lines that run side by side closer than this join into one road, as roads form: one line where they go together, and a fork
   where each leaves it for its own block. */
export const ROAD = 28;
/* How far a line that moves onto a road keeps from a block it passes, and how near a corner its end may slide along a side. */
const CLEAR = 8, CORNER = 12;
/* How many times the joining goes over the runs across and down, at most: each join can bring others side by side. */
const ROUNDS = 12;

/* A line of the map: its points, whether it keeps its place, and the blocks its two ends stand on. An end on a block may slide
   along the side it meets; an end anywhere else stays where it is. */
export type Way = { pts: Point[]; fixed?: boolean; ends?: readonly [Rect | null, Rect | null] };

/* Which coordinate a run keeps: 1 for a run across, 0 for a run down. */
type Keep = 0 | 1;
/* A straight run of a line: which line and which of its runs, where it stands and from where to where it goes along. */
type Run = { way: number; k: number; at: number; lo: number; hi: number; fixed: boolean };

const same = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1];
const inside = ([x, y]: Point, r: Rect) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h;
const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const length = (r: Run) => r.hi - r.lo;

function runsOf(lines: Point[][], ways: readonly Way[], keep: Keep): Run[] {
  const along = 1 - keep;
  return lines.flatMap((pts, way) =>
    pts.slice(1).flatMap((b, k): Run[] => {
      const a = pts[k]!;
      if (a[keep] !== b[keep] || same(a, b)) return [];
      return [{ way, k, at: a[keep], lo: Math.min(a[along]!, b[along]!), hi: Math.max(a[along]!, b[along]!), fixed: !!ways[way]!.fixed }];
    }),
  );
}

/* Runs of different lines that go side by side for a stretch, closer than a road, in groups; a group all on one line is a road
   already. */
function sideBySide(runs: Run[]): Run[][] {
  const parent = runs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  runs.forEach((a, i) => {
    for (let j = i + 1; j < runs.length; j++) {
      const b = runs[j]!;
      if (a.way !== b.way && Math.abs(a.at - b.at) < ROAD && Math.min(a.hi, b.hi) > Math.max(a.lo, b.lo)) parent[find(j)] = find(i);
    }
  });
  const groups = new Map<number, Run[]>();
  runs.forEach((r, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), r]));
  return [...groups.values()].filter(g => new Set(g.map(r => r.at)).size > 1);
}

/* Where a group's road may run, best first: on a line that keeps its place, else where the lines move least. */
function roadsFor(group: Run[]): number[] {
  const fixed = group.filter(r => r.fixed);
  const from = fixed.length ? fixed : group;
  const on = (at: number) => from.filter(r => r.at === at).reduce((s, r) => s + length(r), 0);
  const moves = (at: number) => group.reduce((s, r) => s + length(r) * Math.abs(r.at - at), 0);
  return [...new Set(from.map(r => r.at))].sort((p, q) => (fixed.length ? 0 : moves(p) - moves(q)) || on(q) - on(p) || p - q);
}

/* Whether an end may slide along the side of its block it meets to there, clear of the corners. */
function slides(p: Point, r: Rect, keep: Keep, to: number): boolean {
  const [lo, size] = keep ? [r.y, r.h] : [r.x, r.w];
  const side = keep ? p[0] === r.x || p[0] === r.x + r.w : p[1] === r.y || p[1] === r.y + r.h;
  const inset = Math.min(CORNER, size / 2);
  return side && to >= lo + inset && to <= lo + size - inset;
}

/* How badly a line meets the blocks: the blocks it runs through, then those it passes too near. A line may run through the
   block its end stands inside, as the lines from the middle of the hub do, and it touches the blocks it joins. */
function harm(pts: Point[], way: Way, blocks: readonly Rect[]): [number, number] {
  let crossed = 0, near = 0;
  const last = pts.length - 2;
  pts.slice(1).forEach((b, i) => {
    const a = pts[i]!;
    for (const r of blocks) {
      if ((i === 0 && inside(pts[0]!, r)) || (i === last && inside(b, r))) continue;
      if (through(a, b, r, 0)) crossed++;
      else if (!way.ends?.some(e => e && sameRect(e, r)) && through(a, b, r, CLEAR)) near++;
    }
  });
  return [crossed, near];
}

/* The line with one of its runs moved to stand at a road, and the runs on either side drawn up to it; null when an end would
   have to leave the side of its block, or the line would run through or nearer a block than before. */
function moved(pts: Point[], way: Way, run: Run, keep: Keep, at: number, blocks: readonly Rect[]): Point[] | null {
  const out = pts.map((p): Point => [p[0], p[1]]);
  for (const j of [run.k, run.k + 1]) {
    const end = j === 0 || j === pts.length - 1;
    const block = way.ends?.[j === 0 ? 0 : 1];
    if (end && (!block || !slides(pts[j]!, block, keep, at))) return null;
    out[j]![keep] = at;
  }
  const [was, now] = [harm(pts, way, blocks), harm(out, way, blocks)];
  return now[0] < was[0] || (now[0] === was[0] && now[1] <= was[1]) ? tidy(out) : null;
}

/* The lines of the map with the lines that run side by side joined into roads. A line that keeps its place draws the others
   onto it; a line moves only where it still runs clear of every block and its ends stay on the sides they meet. */
export function joinRoads(ways: readonly Way[], blocks: readonly Rect[]): Point[][] {
  const lines = ways.map(w => (w.fixed ? w.pts : tidy(w.pts)));
  const joined = new Set<number>();
  for (let round = 0, still = 0; round < ROUNDS && still < 2; round++) {
    const keep: Keep = round % 2 ? 0 : 1;
    /* A line moves once a round, so the runs found at its start still name its points. */
    const done = new Set<number>();
    for (const group of sideBySide(runsOf(lines, ways, keep))) {
      if (group.some(r => done.has(r.way))) continue;
      /* The road that leaves the fewest lines beside it, then the most on it; and only one that leaves fewer than now, so lines
         never go to and fro between two roads. */
      const now = new Set(group.map(r => r.at)).size;
      let best: { apart: number; on: number; moves: Map<number, Point[]> } | null = null;
      for (const at of roadsFor(group)) {
        const there = new Set(group.filter(r => r.at === at).map(r => r.way));
        const moves = new Map<number, Point[]>(), left = new Set<Run>();
        let on = group.filter(r => r.at === at).reduce((s, r) => s + length(r), 0);
        for (const r of [...group].sort((p, q) => Math.abs(p.at - at) - Math.abs(q.at - at))) {
          const pts = r.fixed || there.has(r.way) || moves.has(r.way) || Math.abs(r.at - at) >= ROAD ? null : moved(lines[r.way]!, ways[r.way]!, r, keep, at, blocks);
          if (pts) {
            moves.set(r.way, pts);
            on += length(r);
          } else left.add(r);
        }
        const apart = new Set([at, ...[...left].map(r => r.at)]).size;
        if (apart < now && (!best || apart < best.apart || (apart === best.apart && on > best.on))) best = { apart, on, moves };
      }
      for (const [way, pts] of best?.moves ?? []) {
        lines[way] = pts;
        done.add(way);
        joined.add(way);
      }
    }
    still = done.size ? 0 : still + 1;
  }
  /* A line that joined no road comes back as it came. */
  return lines.map((pts, i) => (joined.has(i) ? pts : ways[i]!.pts));
}

/* Each line as it is drawn: only the stretches no line before it took, in runs that keep their turns, so a road that lines
   share is drawn once and never thicker or darker than a line alone. */
export function drawOnce(lines: readonly Point[][]): Point[][][] {
  const drawn = new Map<string, [number, number][]>();
  return lines.map(pts => {
    const runs: Point[][] = [];
    pts.slice(1).forEach((b, i) => {
      const a = pts[i]!;
      if (same(a, b)) return;
      const keep: Keep = a[1] === b[1] ? 1 : 0, along = 1 - keep, key = `${keep}:${a[keep]}`;
      const at = (v: number): Point => (keep ? [v, a[1]] : [a[0], v]);
      const from = a[along]!, to = b[along]!, lo = Math.min(from, to), hi = Math.max(from, to);
      const taken = drawn.get(key) ?? [];
      /* The parts of the run no line took yet, in the order the line goes. */
      const free: [number, number][] = [];
      let start = lo;
      for (const [l, h] of taken) {
        if (h <= start || l >= hi) continue;
        if (l > start) free.push([start, l]);
        start = Math.max(start, h);
      }
      if (start < hi) free.push([start, hi]);
      if (from > to) free.reverse().forEach(f => f.reverse());
      for (const [p, q] of free) {
        const run = runs[runs.length - 1];
        if (run && same(run[run.length - 1]!, at(p))) run.push(at(q));
        else runs.push([at(p), at(q)]);
      }
      drawn.set(key, merge([...taken, [lo, hi]]));
    });
    return runs.map(tidy);
  });
}

function merge(spans: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [l, h] of spans.sort((p, q) => p[0] - q[0])) {
    const last = out[out.length - 1];
    if (last && l <= last[1]) last[1] = Math.max(last[1], h);
    else out.push([l, h]);
  }
  return out;
}

const heading = (from: Point, to: Point) => `${Math.sign(to[0] - from[0])},${Math.sign(to[1] - from[1])}`;
/* Whether p stands on the run a-b between its ends. */
const within = (p: Point, a: Point, b: Point) =>
  (a[0] === b[0] && p[0] === a[0] && p[1] > Math.min(a[1], b[1]) && p[1] < Math.max(a[1], b[1])) ||
  (a[1] === b[1] && p[1] === a[1] && p[0] > Math.min(a[0], b[0]) && p[0] < Math.max(a[0], b[0]));

/* Where roads fork: a turn or an end of a line where three or more ways meet, outside the blocks. Two lines that only cross do
   not fork. */
export function roadForks(lines: readonly Point[][], blocks: readonly Rect[]): Point[] {
  const segs = lines.flatMap(pts => pts.slice(1).map((b, i): [Point, Point] => [pts[i]!, b])).filter(([a, b]) => !same(a, b));
  const seen = new Set<string>();
  return lines.flat().filter(p => {
    const key = `${p[0]}:${p[1]}`;
    if (seen.has(key) || blocks.some(r => inside(p, r))) return false;
    seen.add(key);
    const ways = new Set<string>();
    for (const [a, b] of segs) {
      if (same(a, p)) ways.add(heading(p, b));
      else if (same(b, p)) ways.add(heading(p, a));
      else if (within(p, a, b)) [a, b].forEach(q => ways.add(heading(p, q)));
    }
    return ways.size >= 3;
  });
}

