import type { Department } from './types';
import type { Point } from './ui/wires';

/* A department's turn shows as this many squares on its card, and as many segments on the hub while it works alone. */
export const TURN_CELLS = 20;
/* The hub's arcs run 103 from its middle. The lower half runs from 6 degrees under its left end to 6 under its right, so the
   marks at both ends of the middle line stay clear, as the gauge of working agents above it. */
const R = 103, FROM = 174, TO = 6, HALF = FROM - TO;
/* Each segment is a dash and a gap, and the last dash ends where the arc ends: n segments take n less this gap. */
const DASH_GAP = 0.28;
export const dashLength = (segments: number): number => +(segments - DASH_GAP).toFixed(2);
/* A sector's segment stays at least this many degrees wide, so a dozen departments still read. */
const MIN_SEGMENT = 5;
/* Segments of a sector while one, two or three departments work; more share the half in up to four each. */
const FEW: readonly number[] = [0, TURN_CELLS, 8, 6];

/* A department working in the open turn: the tasks of it the person sees, done out of all. */
export type WorkingTurn = { id: string; roleCode: string; turnNumber: number; done: number; total: number };

/* The departments that work in the open turn, in the order of their cards: those it gave tasks to. */
export function workingTurns(departments: Department[]): WorkingTurn[] {
  return departments.flatMap(d => (d.turnProgress && d.turnProgress.total > 0 ? [{ id: d.id, roleCode: d.roleCode, ...d.turnProgress }] : []));
}

/* How many squares light from the left: none before the first task is done, and all only when every task is. */
export function litSquares(done: number, total: number, cells = TURN_CELLS): number {
  if (total <= 0 || done <= 0) return 0;
  if (done >= total) return cells;
  return Math.min(cells - 1, Math.max(1, Math.round((cells * done) / total)));
}

export const sharePercent = (done: number, total: number): number => (total > 0 ? Math.round((done / total) * 100) : 0);

/* A point at an angle from the hub's middle, 0 to the right and 90 straight down. */
function hubPoint(deg: number, r = R): Point {
  const a = (deg * Math.PI) / 180;
  return [120 + r * Math.cos(a), 120 + r * Math.sin(a)];
}

export const arcEnd = (deg: number): string => hubPoint(deg).map(v => v.toFixed(2)).join(' ');

/* The arc between two angles: clockwise when the second is larger, as over the top, back through the bottom otherwise. */
export const arcD = (from: number, to: number): string => `M ${arcEnd(from)} A ${R} ${R} 0 0 ${to > from ? 1 : 0} ${arcEnd(to)}`;

/* A department's part of the lower half, from left to right, and the mark between it and the next. */
export type HubSector = { from: number; to: number; segments: number; separator: [Point, Point] | null };

/* Degrees between sectors: wide for a few departments, narrower as more share the half. */
const sectorGap = (n: number): number => Math.min(n <= 3 ? 12 : n <= 5 ? 9 : Math.max(4, 14 - n), HALF / (2 * n));

const sectorSegments = (n: number, span: number): number => FEW[n] ?? Math.max(1, Math.min(4, Math.floor(span / MIN_SEGMENT)));

/* The lower half of the hub, split among the departments that work in the turn. */
export function hubSectors(n: number): HubSector[] {
  const gap = sectorGap(n);
  const span = (HALF - gap * (n - 1)) / n;
  const segments = sectorSegments(n, span);
  return Array.from({ length: n }, (_, i) => {
    const from = FROM - i * (span + gap), to = from - span;
    return { from, to, segments, separator: i < n - 1 ? [hubPoint(to - gap / 2, 95), hubPoint(to - gap / 2, 111)] : null };
  });
}

/* The lit part of a sector, from its left end to the end of its last lit segment; none while nothing is done. */
export function sectorFill(s: HubSector, done: number, total: number): { d: string; length: number } | null {
  const lit = litSquares(done, total, s.segments);
  if (!lit) return null;
  const length = dashLength(lit);
  return { d: arcD(s.from, s.from - ((s.from - s.to) * length) / dashLength(s.segments)), length };
}
