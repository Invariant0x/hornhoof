/* The city's streets baked into the ground (#1985). All the streets are one field with one soft edge: a pixel is as
   opaque as the street nearest to it, its colour mostly that street's, so where streets cross, meet in a T or bend,
   their edges merge into one outline instead of strips laid over each other doubling the light edge. A straight street
   is one run from its first tile to its last. Across a street its tier's strip runs by the distance from its middle
   line, along it by the tile axis, anchored to the world, so a straight street shows no seam; round a bend its ruts
   follow the turn, and where a street ends with nothing meeting it they run straight on and fade out. A lower street
   runs into a higher one's edge, not across its middle, so the higher keeps its look. A street runs into the bridge up
   to the water's tile edge, under the bridge's first piece. An avenue (#2003) is one run along the middle line between
   its two rows of tiles, in the avenue's strip, its ends round within its first and last tiles; a street meeting it
   ends at its edge, and a pack with no avenue strip shows its tiles as stone streets. Knows no world: the strips come
   from the pack. */

import type { AvenueLine, RoadTier } from './city-layout';
import type { ArtPixels } from './terrain-art';

export type StreetTile = Readonly<{ col: number; row: number; tier: RoadTier; bridge?: boolean; avenue?: AvenueLine }>;
export type StreetStrips = Readonly<Partial<Record<RoadTier, ArtPixels>>>;

export type StreetField = Readonly<{
  /* The street at (u, v) in tiles into out: colour in out[0..2], opacity in [0, 1] in out[3]; 0 where none lies. */
  at: (u: number, v: number, out: number[]) => void;
}>;

/* The tiers every painted pack has; the avenue's strip may be missing. */
const TIERS: readonly RoadTier[] = ['trail', 'dirt', 'brick', 'stone'];
const TIER_ORDER: Readonly<Record<RoadTier, number>> = { trail: 0, dirt: 1, brick: 2, stone: 3, avenue: 4 };
/* Strip columns along the second axis start elsewhere, so crossing streets do not show the same pebble twice. */
const V_AXIS_TEXEL_OFFSET = 311;

/* Whether the ground carries the streets: every tier has its strip. Short of one, the city draws its street tiles. */
export function paintsEveryStreet(strips: StreetStrips | undefined): boolean {
  return TIERS.every(t => Boolean(strips?.[t]));
}

/* One run of a street's middle line along one axis, at `across`, from `from` to `to`, with round ends. An open end is
   one no street meets from the side: past it the strip keeps its rows straight instead of turning round the end. */
type Piece = Readonly<{ axis: 'u' | 'v'; across: number; from: number; to: number; half: number; openFrom: boolean; openTo: boolean }>;
type TierPiece = Readonly<{ tier: RoadTier; piece: Piece }>;
/* A run with the strip it is painted with. */
type FieldPiece = Piece & Readonly<{ strip: ArtPixels }>;

/* The four neighbours of a tile: along which axis and to which side. */
const NEIGHBOURS = [
  { axis: 'u', dc: 1, dr: 0, side: 1 },
  { axis: 'u', dc: -1, dr: 0, side: -1 },
  { axis: 'v', dc: 0, dr: 1, side: 1 },
  { axis: 'v', dc: 0, dr: -1, side: -1 },
] as const;

const keyOf = (col: number, row: number): number => (col + 32768) * 65536 + (row + 32768);
const lower = (a: RoadTier, b: RoadTier): RoadTier => (TIER_ORDER[a] <= TIER_ORDER[b] ? a : b);

type StreetsAt = ReadonlyMap<number, StreetTile>;

/* Whether a street meets the tile from the side of a run along `axis`. */
function metFromSide(at: StreetsAt, col: number, row: number, axis: 'u' | 'v'): boolean {
  const [dc, dr] = axis === 'u' ? [0, 1] : [1, 0];
  return at.has(keyOf(col + dc, row + dr)) || at.has(keyOf(col - dc, row - dr));
}

/* The middle line of the avenue a tile is on, across its axis. */
const avenueMiddle = (t: StreetTile, line: AvenueLine): number => (line.axis === 'u' ? t.row : t.col) + 0.5 + line.side / 2;

/* Whether two tiles lie on one avenue: along one axis, about one middle line. */
function sameAvenue(a: StreetTile, b: StreetTile | undefined): boolean {
  return Boolean(a.avenue && b?.avenue && a.avenue.axis === b.avenue.axis && avenueMiddle(a, a.avenue) === avenueMiddle(b, b.avenue));
}

/* How far from a tile's centre its street's edge lies toward a neighbour along `axis`: half its width; on an avenue,
   its outer side across it, or where its round end crosses the tile's line along it. */
function edgeOf(t: StreetTile, axis: 'u' | 'v', halfOf: (tier: RoadTier) => number): number {
  if (!t.avenue) return halfOf(t.tier);
  const half = halfOf('avenue');
  if (axis !== t.avenue.axis) return half - 0.5;
  return 0.5 - half + Math.sqrt(Math.max(0, half * half - 0.25));
}

/* Where the piece from a street tile toward its neighbour starts and ends, in tiles from the tile's centre: centre to
   centre between streets of one tier; at a higher street's edge where it meets one, so the lower street runs into the
   higher one's edge and not across its middle; to the edge of a bridge tile. */
function pieceSpan(t: StreetTile, next: StreetTile, axis: 'u' | 'v', halfOf: (tier: RoadTier) => number): readonly [number, number] {
  if (next.bridge) return [0, 0.5];
  const step = TIER_ORDER[t.tier] - TIER_ORDER[next.tier];
  if (step > 0) return [edgeOf(t, axis, halfOf), 1];
  return step < 0 ? [0, 1 - edgeOf(next, axis, halfOf)] : [0, 1];
}

/* Whether a street tile lays the piece toward a neighbour: between two streets only the one on the lower side does,
   and between avenue tiles none, the avenues lay their own; toward the bridge the street always does. */
function laysPieceToward(t: StreetTile, next: StreetTile, side: number): boolean {
  if (t.avenue && next.avenue) return false;
  return Boolean(next.bridge) || side > 0;
}

/* The tier of the piece between two street tiles: the lower of the two; into the bridge the street's own, an avenue
   narrowing to stone. */
function pieceTier(t: StreetTile, next: StreetTile): RoadTier {
  if (!next.bridge) return lower(t.tier, next.tier);
  return t.avenue ? 'stone' : t.tier;
}

/* The piece from a street tile toward its neighbour. */
function pieceToward(t: StreetTile, next: StreetTile, n: (typeof NEIGHBOURS)[number], halfOf: (tier: RoadTier) => number, at: StreetsAt): TierPiece | null {
  if (!laysPieceToward(t, next, n.side)) return null;
  const tier = pieceTier(t, next);
  const [centre, across] = n.axis === 'u' ? [t.col + 0.5, t.row + 0.5] : [t.row + 0.5, t.col + 0.5];
  const [start, end] = pieceSpan(t, next, n.axis, halfOf);
  const along = centre + n.side * start;
  const far = centre + n.side * end;
  const openHere = !metFromSide(at, t.col, t.row, n.axis);
  const openThere = !metFromSide(at, next.col, next.row, n.axis);
  const [openFrom, openTo] = n.side > 0 ? [openHere, openThere] : [openThere, openHere];
  return { tier, piece: { axis: n.axis, across, from: Math.min(along, far), to: Math.max(along, far), half: halfOf(tier), openFrom, openTo } };
}

/* The piece an avenue tile lays along its avenue's middle line: over the whole tile where the avenue goes on, and
   where it stops, short of the tile's edge by so much that its round end reaches just that edge. */
function avenuePiece(t: StreetTile, line: AvenueLine, at: StreetsAt, half: number): TierPiece {
  const [dc, dr] = line.axis === 'u' ? [1, 0] : [0, 1];
  const centre = (line.axis === 'u' ? t.col : t.row) + 0.5;
  const back = sameAvenue(t, at.get(keyOf(t.col - dc, t.row - dr)));
  const on = sameAvenue(t, at.get(keyOf(t.col + dc, t.row + dr)));
  const from = back ? centre - 0.5 : centre - 0.5 + half;
  const to = on ? centre + 0.5 : centre + 0.5 - half;
  const [a, b] = from <= to ? [from, to] : [centre, centre];
  return { tier: 'avenue', piece: { axis: line.axis, across: avenueMiddle(t, line), from: a, to: b, half, openFrom: !back, openTo: !on } };
}

/* The pieces one street tile lays; a tile with no neighbour is a round patch of its own. */
function piecesOfTile(t: StreetTile, at: StreetsAt, halfOf: (tier: RoadTier) => number): TierPiece[] {
  const out: TierPiece[] = t.avenue ? [avenuePiece(t, t.avenue, at, halfOf('avenue'))] : [];
  let linked = Boolean(t.avenue);
  for (const n of NEIGHBOURS) {
    const next = at.get(keyOf(t.col + n.dc, t.row + n.dr));
    if (!next) continue;
    linked = true;
    const piece = pieceToward(t, next, n, halfOf, at);
    if (piece) out.push(piece);
  }
  if (!linked) out.push({ tier: t.tier, piece: { axis: 'u', across: t.row + 0.5, from: t.col + 0.5, to: t.col + 0.5, half: halfOf(t.tier), openFrom: true, openTo: true } });
  return out;
}

const runKey = ({ tier, piece }: TierPiece): string => `${tier}|${piece.axis}|${piece.across}`;

/* Joins the pieces of one tier that follow each other along one line into a single run, so a straight street has no
   joint where one tile's piece meets the next. */
function joinRuns(pieces: readonly TierPiece[]): TierPiece[] {
  const sorted = [...pieces].sort((a, b) => runKey(a).localeCompare(runKey(b)) || a.piece.from - b.piece.from);
  const runs: TierPiece[] = [];
  for (const next of sorted) {
    const last = runs.at(-1);
    if (last && runKey(last) === runKey(next) && next.piece.from <= last.piece.to) {
      const longer = next.piece.to > last.piece.to;
      runs[runs.length - 1] = { tier: last.tier, piece: { ...last.piece, to: longer ? next.piece.to : last.piece.to, openTo: longer ? next.piece.openTo : last.piece.openTo } };
    } else runs.push(next);
  }
  return runs;
}

/* The runs of the street network; a bridge tile lays none, the streets run into it. */
function piecesOf(tiles: readonly StreetTile[], halfOf: (tier: RoadTier) => number): TierPiece[] {
  const at = new Map(tiles.map(t => [keyOf(t.col, t.row), t] as const));
  return joinRuns(tiles.filter(t => !t.bridge).flatMap(t => piecesOfTile(t, at, halfOf)));
}

/* Files a piece under every tile its strip can reach, so a pixel looks only at the pieces near it. */
function indexPiece(byTile: Map<number, FieldPiece[]>, p: FieldPiece): void {
  for (let a = Math.floor(p.from - p.half); a <= Math.floor(p.to + p.half); a++) {
    for (let b = Math.floor(p.across - p.half); b <= Math.floor(p.across + p.half); b++) {
      const k = p.axis === 'u' ? keyOf(a, b) : keyOf(b, a);
      byTile.set(k, [...(byTile.get(k) ?? []), p]);
    }
  }
}

/* The offset across a piece that picks the strip's row at (u, v): past an open end the straight offset from its line,
   so the rows run on; elsewhere the round distance sd. */
function rowOffset(p: Piece, u: number, v: number, sd: number): number {
  const along = p.axis === 'u' ? u : v;
  const open = (along < p.from && p.openFrom) || (along > p.to && p.openTo);
  return open ? (p.axis === 'u' ? v : u) - p.across : sd;
}

/* Signed distance of (u, v) from a piece's middle line, the sign telling which side; round past its ends. */
function signedDistance(p: Piece, u: number, v: number): number {
  const along = p.axis === 'u' ? u : v;
  const side = (p.axis === 'u' ? v : u) - p.across;
  const past = Math.max(p.from - along, along - p.to, 0);
  if (past === 0) return side;
  return Math.sign(side || 1) * Math.hypot(past, side);
}

/* The tiles as the pack's strips paint them: an avenue's as stone streets when the pack has no avenue strip. */
function paintedTiles(tiles: readonly StreetTile[], strips: StreetStrips): readonly StreetTile[] {
  return tiles.map(t => (t.tier === 'avenue' && !(strips.avenue && t.avenue) ? { col: t.col, row: t.row, tier: 'stone', bridge: t.bridge } : t));
}

/* The runs that have a strip, each with its strip. */
function fieldPieces(tiles: readonly StreetTile[], strips: StreetStrips, texelsPerTile: number): FieldPiece[] {
  const halfOf = (tier: RoadTier): number => (strips[tier]?.height ?? 0) / texelsPerTile / 2;
  return piecesOf(paintedTiles(tiles, strips), halfOf).flatMap(({ tier, piece }) => {
    const strip = strips[tier];
    return strip ? [{ ...piece, strip }] : [];
  });
}

/* Builds the field of a set of street tiles, or null when none of them has a strip to be painted with. */
export function streetField(tiles: readonly StreetTile[], strips: StreetStrips, texelsPerTile: number): StreetField | null {
  const pieces = fieldPieces(tiles, strips, texelsPerTile);
  if (pieces.length === 0) return null;
  const byTile = new Map<number, FieldPiece[]>();
  for (const p of pieces) indexPiece(byTile, p);
  return { at: (u, v, out) => fieldAt(byTile.get(keyOf(Math.floor(u), Math.floor(v))) ?? NO_PIECES, u, v, texelsPerTile, out) };
}

const NO_PIECES: readonly FieldPiece[] = [];

const stripRow = (strip: ArtPixels, offset: number, tpt: number): number => Math.min(strip.height - 1, Math.max(0, Math.floor(strip.height / 2 + offset * tpt)));

/* One strip pixel at a texel along it: the colour of the row at `rowAt` across it into rgb, and the opacity of the row
   at the distance sd returned. */
function stripPixel(strip: ArtPixels, sd: number, rowAt: number, along: number, tpt: number, rgb: number[]): number {
  const x = ((Math.floor(along) % strip.width) + strip.width) % strip.width;
  const o = (stripRow(strip, rowAt, tpt) * strip.width + x) * 4;
  rgb[0] = strip.data[o]!;
  rgb[1] = strip.data[o + 1]!;
  rgb[2] = strip.data[o + 2]!;
  return strip.data[(stripRow(strip, sd, tpt) * strip.width + x) * 4 + 3]! / 255;
}

const pixel = [0, 0, 0];

/* The streets at (u, v) into out: as opaque as the most opaque run there, the colour taken mostly from the runs whose
   middle is nearest, so the light edge of one street never shows across another's middle. */
function fieldAt(near: readonly FieldPiece[], u: number, v: number, tpt: number, out: number[]): void {
  let weights = 0;
  out.fill(0, 0, 4);
  for (const p of near) {
    const sd = signedDistance(p, u, v);
    const core = 1 - Math.abs(sd) / p.half;
    if (core <= 0) continue;
    const a = stripPixel(p.strip, sd, rowOffset(p, u, v, sd), p.axis === 'u' ? u * tpt : v * tpt + V_AXIS_TEXEL_OFFSET, tpt, pixel);
    const w = a * core ** 4 + 1e-6;
    for (let i = 0; i < 3; i++) out[i] = out[i]! + pixel[i]! * w;
    weights += w;
    out[3] = Math.max(out[3]!, a);
  }
  for (let i = 0; i < 3 && weights > 0; i++) out[i] = out[i]! / weights;
}
