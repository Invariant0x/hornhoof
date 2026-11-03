import type { PersonWire } from './map-people';
import { lengthOf, type Point } from './ui/wires';

type Segment = { a: Point; b: Point; offset: number };
type Gap = { start: number; end: number };
export type WireGap = { personId: string; pts: Point[] };
const BRIDGE = 6;
const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function segments(pts: Point[]): Segment[] {
  let offset = 0;
  return pts.slice(1).map((b, i) => {
    const a = pts[i]!;
    const segment = { a, b, offset };
    offset += distance(a, b);
    return segment;
  });
}

const between = (v: number, a: number, b: number) => v >= Math.min(a, b) && v <= Math.max(a, b);

function intersection(a: Segment, b: Segment): Point | null {
  const aVertical = a.a[0] === a.b[0], bVertical = b.a[0] === b.b[0];
  if (aVertical === bVertical) return null;
  const v = aVertical ? a : b, h = aVertical ? b : a;
  return between(v.a[0], h.a[0], h.b[0]) && between(h.a[1], v.a[1], v.b[1]) ? [v.a[0], h.a[1]] : null;
}

function gapsOn(segment: Segment, obstacles: Segment[]): Gap[] {
  return obstacles.flatMap(other => {
    const point = intersection(segment, other);
    if (!point) return [];
    const at = segment.offset + distance(segment.a, point);
    return [{ start: at - BRIDGE, end: at + BRIDGE }];
  });
}

function mergeGaps(gaps: Gap[]): Gap[] {
  const merged: Gap[] = [];
  for (const gap of gaps.sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && gap.start <= last.end) last.end = Math.max(last.end, gap.end);
    else merged.push({ ...gap });
  }
  return merged;
}

function pointAt(segment: Segment, at: number): Point {
  const ratio = (at - segment.offset) / distance(segment.a, segment.b);
  return [segment.a[0] + ratio * (segment.b[0] - segment.a[0]), segment.a[1] + ratio * (segment.b[1] - segment.a[1])];
}

function portion(parts: Segment[], start: number, end: number): Point[] {
  const points: Point[] = [];
  for (const part of parts) {
    const from = Math.max(start, part.offset), to = Math.min(end, part.offset + distance(part.a, part.b));
    if (from >= to) continue;
    if (!points.length) points.push(pointAt(part, from));
    points.push(pointAt(part, to));
  }
  return points;
}

function cutWire(wire: PersonWire, obstacles: Segment[], bridges: WireGap[]): PersonWire[] {
  const parts = segments(wire.pts);
  const gaps = mergeGaps(parts.flatMap(s => gapsOn(s, obstacles)));
  bridges.push(...gaps.map(g => ({ personId: wire.personId, pts: portion(parts, g.start, g.end) })));
  const ends = [...gaps.map(g => g.start), lengthOf(wire.pts)];
  const starts = [0, ...gaps.map(g => g.end)];
  return starts.flatMap((start, i) => {
    const pts = portion(parts, start, ends[i]!);
    return pts.length < 2 ? [] : [{ ...wire, id: `${wire.id}:${i}`, pts }];
  });
}

/* A gap under another trace keeps independent lines distinct; messages still follow the full route. */
export function bridgeWires(wires: PersonWire[]): { wires: PersonWire[]; gaps: WireGap[] } {
  const gaps: WireGap[] = [];
  const pieces = wires.flatMap((wire, i) => {
    const obstacles = wires.slice(0, i).filter(w => w.personId !== wire.personId).flatMap(w => segments(w.pts));
    return cutWire(wire, obstacles, gaps);
  });
  return { wires: pieces, gaps };
}
