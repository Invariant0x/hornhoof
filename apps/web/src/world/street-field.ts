/* The city's streets baked into the ground (#1985). Each tier's streets are one strip with one soft edge: a pixel is
   as opaque as the street nearest to it, so where streets cross, meet in a T or bend, their edges merge into one
   outline instead of strips laid over each other doubling the light edge. A straight street is one run from its first
   tile to its last. Across a street the pack's strip runs by the distance from its middle line, along it by the tile
   axis, anchored to the world, so a straight street shows no seam; round a bend its ruts follow the turn, and where a
   street ends with nothing meeting it they run straight on and fade out. The higher tier lies over the lower. A street runs into the bridge up to the water's tile edge, under the
   bridge's first piece. Knows no world: the strips come from the pack. */

import type { RoadTier } from './city-layout';
import type { ArtPixels } from './terrain-art';

export type StreetTile = Readonly<{ col: number; row: number; tier: RoadTier; bridge?: boolean }>;
export type StreetStrips = Readonly<Partial<Record<RoadTier, ArtPixels>>>;

export type StreetField = Readonly<{
  /* The street at (u, v) in tiles into out: colour in out[0..2], opacity in [0, 1] in out[3]; 0 where none lies. */
  at: (u: number, v: number, out: number[]) => void;
}>;

const TIERS: readonly RoadTier[] = ['trail', 'dirt', 'brick', 'stone'];
const TIER_ORDER: Readonly<Record<RoadTier, number>> = { trail: 0, dirt: 1, brick: 2, stone: 3 };
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
type TierField = { strip: ArtPixels; half: number; byTile: Map<number, Piece[]> };

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

/* The piece from a street tile toward its neighbour, under the lower tier of the two: to the neighbour's centre, or
   to the edge of a bridge tile. Between two streets only the one on the lower side lays it. */
function pieceToward(t: StreetTile, next: StreetTile, n: (typeof NEIGHBOURS)[number], halfOf: (tier: RoadTier) => number, at: StreetsAt): TierPiece | null {
  if (!next.bridge && n.side < 0) return null;
  const tier = next.bridge ? t.tier : lower(t.tier, next.tier);
  const [along, across] = n.axis === 'u' ? [t.col + 0.5, t.row + 0.5] : [t.row + 0.5, t.col + 0.5];
  const far = along + n.side * (next.bridge ? 0.5 : 1);
  const openHere = !metFromSide(at, t.col, t.row, n.axis);
  const openThere = !metFromSide(at, next.col, next.row, n.axis);
  const [openFrom, openTo] = n.side > 0 ? [openHere, openThere] : [openThere, openHere];
  return { tier, piece: { axis: n.axis, across, from: Math.min(along, far), to: Math.max(along, far), half: halfOf(tier), openFrom, openTo } };
}

/* The pieces one street tile lays; a tile with no neighbour is a round patch of its own. */
function piecesOfTile(t: StreetTile, at: StreetsAt, halfOf: (tier: RoadTier) => number): TierPiece[] {
  const out: TierPiece[] = [];
  let linked = false;
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
function indexPiece(byTile: Map<number, Piece[]>, p: Piece): void {
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

/* The tiers that have pieces and a strip, lowest first, each with its pieces filed by tile. */
function tierFields(tiles: readonly StreetTile[], strips: StreetStrips, texelsPerTile: number): TierField[] {
  const halfOf = (tier: RoadTier): number => (strips[tier]?.height ?? 0) / texelsPerTile / 2;
  const fields = new Map<RoadTier, TierField>();
  for (const { tier, piece } of piecesOf(tiles, halfOf)) {
    const strip = strips[tier];
    if (!strip) continue;
    const f = fields.get(tier) ?? { strip, half: piece.half, byTile: new Map<number, Piece[]>() };
    fields.set(tier, f);
    indexPiece(f.byTile, piece);
  }
  return TIERS.flatMap(t => fields.get(t) ?? []);
}

/* Builds the field of a set of street tiles, or null when none of them has a strip to be painted with. */
export function streetField(tiles: readonly StreetTile[], strips: StreetStrips, texelsPerTile: number): StreetField | null {
  const order = tierFields(tiles, strips, texelsPerTile);
  if (order.length === 0) return null;
  const tierOut = [0, 0, 0, 0];
  return { at: (u, v, out) => compositeAt(order, texelsPerTile, u, v, out, tierOut) };
}

const NO_PIECES: readonly Piece[] = [];

/* The tiers at (u, v), each over the ones below it, into out (straight colour and opacity). */
function compositeAt(order: readonly TierField[], tpt: number, u: number, v: number, out: number[], tierOut: number[]): void {
  out.fill(0, 0, 4);
  const key = keyOf(Math.floor(u), Math.floor(v));
  for (const f of order) {
    const a = tierAt(f, f.byTile.get(key) ?? NO_PIECES, u, v, tpt, tierOut);
    for (let i = 0; i < 3; i++) out[i] = out[i]! * (1 - a) + tierOut[i]! * a;
    out[3] = out[3]! + a * (1 - out[3]!);
  }
  /* The colour so far is premultiplied by the opacity: give it back straight. */
  const alpha = out[3]!;
  for (let i = 0; i < 3 && alpha > 0; i++) out[i] = out[i]! / alpha;
}

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

/* One tier at (u, v) into out, its opacity returned (0 where it lies not): as opaque as its most opaque piece there,
   its colour taken mostly from the pieces whose middle is nearest, so the light edge of one street never shows across
   another's middle. */
function tierAt(f: TierField, near: readonly Piece[], u: number, v: number, tpt: number, out: number[]): number {
  let alpha = 0;
  let weights = 0;
  out.fill(0, 0, 3);
  for (const p of near) {
    const sd = signedDistance(p, u, v);
    const core = 1 - Math.abs(sd) / f.half;
    if (core <= 0) continue;
    const a = stripPixel(f.strip, sd, rowOffset(p, u, v, sd), p.axis === 'u' ? u * tpt : v * tpt + V_AXIS_TEXEL_OFFSET, tpt, pixel);
    const w = a * core ** 4 + 1e-6;
    for (let i = 0; i < 3; i++) out[i] = out[i]! + pixel[i]! * w;
    weights += w;
    alpha = Math.max(alpha, a);
  }
  for (let i = 0; i < 3 && weights > 0; i++) out[i] = out[i]! / weights;
  return alpha;
}
