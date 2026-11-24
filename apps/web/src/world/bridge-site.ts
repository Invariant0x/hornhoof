/* A map's one bridge (#1985): the fixed place where the city's streets may cross water. It is worked out from the map
   alone, so one seed puts it in the same place on every load. The city lays a street over it only when the pack has
   the bridge's pictures; without them no street, and so no resident, crosses water. Knows no world. */

import { BRIDGE_PIECES, bridgePicturePath, type ArtIndex, type BridgePiece } from './art';
import type { TileCoord } from './coords';
import type { WorldPackManifest } from './manifest';
import { displayedWaterDistance } from './smooth-terrain-baker';
import type { GeneratedWorldMap } from './terrain-engine';

/* A bridge spans this many water tiles: its first and last piece, and repeated spans between them. */
export const BRIDGE_LENGTH = { min: 2, max: 10 } as const;
/* How far from the city centre, in tiles, a crossing is looked for. */
const REACH = 30;
/* Tiles of distance a crossing one tile longer must save to be taken: the shorter of two near crossings wins. */
const LENGTH_WEIGHT = 0.25;

/* 'u' runs along the column axis (down right on screen), 'v' along the row axis (down left). */
export type BridgeAxis = 'u' | 'v';
/* The bridge's first water tile (the far end, up the screen), its axis and how many water tiles it spans. overBank:
   whether the water as drawn spills over the bank at the far and the near end, so that end's piece stands on the bank
   tile, where the street meets it, and the deck comes down on drawn land. */
export type BridgeSite = Readonly<{ axis: BridgeAxis; col: number; row: number; length: number; overBank?: readonly [boolean, boolean] }>;

type BridgeMap = Pick<GeneratedWorldMap, 'isLiquid' | 'isWalkable' | 'startCenter' | 'cornerFields'>;

/* Drawn water distance from which the ground shows as land (smooth-terrain-baker.ts, displayedWaterDistance). */
const DRAWN_LAND = 0.08;

const STEP: Readonly<Record<BridgeAxis, readonly [number, number]>> = { u: [1, 0], v: [0, 1] };

const isBank = (map: BridgeMap, col: number, row: number): boolean => map.isWalkable(col, row) && !map.isLiquid(col, row);

/* The water tiles the bridge spans, from its first piece to its last. */
export function bridgeTiles(site: BridgeSite): TileCoord[] {
  const [dc, dr] = STEP[site.axis];
  return Array.from({ length: site.length }, (_, i) => ({ col: site.col + dc * i, row: site.row + dr * i }));
}

/* The dry bank tiles at its two ends, where the streets meet it: before its first piece and after its last. */
export function bridgeEnds(site: BridgeSite): readonly [TileCoord, TileCoord] {
  const [dc, dr] = STEP[site.axis];
  return [{ col: site.col - dc, row: site.row - dr }, { col: site.col + dc * site.length, row: site.row + dr * site.length }];
}

/* Whether a tile is one the bridge spans. */
export function onBridge(site: BridgeSite | null, col: number, row: number): boolean {
  if (!site) return false;
  const along = site.axis === 'u' ? col - site.col : row - site.row;
  const across = site.axis === 'u' ? row - site.row : col - site.col;
  return across === 0 && along >= 0 && along < site.length;
}

/* A step between two tiles keeps to the bridge's line: onto it or off it only at its ends, never from its side. */
export function bridgeStepAllowed(site: BridgeSite | null, from: TileCoord, to: TileCoord): boolean {
  const fromOn = onBridge(site, from.col, from.row);
  const toOn = onBridge(site, to.col, to.row);
  if (fromOn === toOn) return true;
  const ends = bridgeEnds(site!);
  const land = fromOn ? to : from;
  return ends.some(end => end.col === land.col && end.row === land.row);
}

/* How many water tiles a crossing from (col, row) along the axis spans between two dry banks, or 0 when it is none. */
function crossingLength(map: BridgeMap, axis: BridgeAxis, col: number, row: number): number {
  const [dc, dr] = STEP[axis];
  if (!map.isLiquid(col, row) || !isBank(map, col - dc, row - dr)) return 0;
  let n = 1;
  while (n <= BRIDGE_LENGTH.max && map.isLiquid(col + dc * n, row + dr * n)) n++;
  return n >= BRIDGE_LENGTH.min && n <= BRIDGE_LENGTH.max && isBank(map, col + dc * n, row + dr * n) ? n : 0;
}

/* Whether the middle of the edge `side` tiles out from the water tile `i` of a crossing is drawn as land. */
function edgeOnLand(map: BridgeMap, site: BridgeSite, i: number, side: number): boolean {
  const [dc, dr] = STEP[site.axis];
  const along = i + 0.5 + side / 2;
  return displayedWaterDistance(map.cornerFields, site.col + dc * along + 0.5 * dr, site.row + dr * along + 0.5 * dc) >= DRAWN_LAND;
}

/* Where each end's deck comes down: on the water tile's own edge when that is drawn as land, else on the bank tile's
   outer edge; null when even that is drawn as water. */
function overBankOf(map: BridgeMap, site: BridgeSite): readonly [boolean, boolean] | null {
  const ends = [
    { i: 0, side: -1 },
    { i: site.length - 1, side: 1 },
  ].map(({ i, side }) => {
    if (edgeOnLand(map, site, i, side)) return false;
    return edgeOnLand(map, site, i + side, side) ? true : null;
  });
  return ends[0] === null || ends[1] === null ? null : [ends[0]!, ends[1]!];
}

/* How far the middle of a crossing lies from the city centre, weighed with its length. */
function crossingScore(site: BridgeSite, centre: TileCoord): number {
  const [dc, dr] = STEP[site.axis];
  const midCol = site.col + 0.5 + (dc * (site.length - 1)) / 2;
  const midRow = site.row + 0.5 + (dr * (site.length - 1)) / 2;
  return Math.hypot(midCol - centre.col - 0.5, midRow - centre.row - 0.5) + LENGTH_WEIGHT * site.length;
}

/* The bridge of a map: the straight crossing of 2 to 10 water tiles nearest the city centre, a shorter one first, whose
   deck can come down on drawn land at both ends, or null when no water lies within reach. Rows are searched from the
   top, then columns, then u before v, and only a strictly better crossing replaces the one found, so every load finds
   the same. */
export function bridgeSite(map: BridgeMap): BridgeSite | null {
  const centre = map.startCenter;
  let best: BridgeSite | null = null;
  let bestScore = Infinity;
  for (let row = centre.row - REACH; row <= centre.row + REACH; row++) {
    for (let col = centre.col - REACH; col <= centre.col + REACH; col++) {
      for (const axis of ['u', 'v'] as const) {
        const length = crossingLength(map, axis, col, row);
        if (!length) continue;
        const site: BridgeSite = { axis, col, row, length };
        const score = crossingScore(site, centre);
        if (score >= bestScore) continue;
        const overBank = overBankOf(map, site);
        if (!overBank) continue;
        best = { ...site, overBank };
        bestScore = score;
      }
    }
  }
  return best;
}

/* Whether the pack's bridge can be drawn: its catalog declares the bridge and every piece is in the art folder. */
export function hasBridgeArt(pack: WorldPackManifest, index: ArtIndex | null): boolean {
  if (!pack.art?.bridge || !index) return false;
  return (['u', 'v'] as const).every(axis => BRIDGE_PIECES.every(piece => Boolean(index.files[bridgePicturePath(axis, piece)])));
}

/* The tiles the bridge's pieces stand on, from the far end to the near end: its water tiles, and the bank tile at an
   end where the drawn water spills over the bank. */
export function bridgePieceTiles(site: BridgeSite): TileCoord[] {
  const [dc, dr] = STEP[site.axis];
  const [from, to] = drawnSpan(site);
  return Array.from({ length: to - from + 1 }, (_, k) => ({ col: site.col + dc * (from + k), row: site.row + dr * (from + k) }));
}

/* The first and last tile a piece stands on, counted from the first water tile. */
function drawnSpan(site: BridgeSite): readonly [number, number] {
  return [site.overBank?.[0] ? -1 : 0, site.length - 1 + (site.overBank?.[1] ? 1 : 0)];
}

/* The piece the k-th of `count` drawn tiles shows: the first, a span or the last. */
export function bridgePieceAt(count: number, k: number): BridgePiece {
  if (k === 0) return 'start';
  return k === count - 1 ? 'end' : 'span';
}

/* How far over the tile it stands before, a resident on the bridge is drawn: past that piece, short of the next. */
const OVER_PIECE = 0.25;

/* The depth a resident is drawn at, at (col, row) with tile centres on whole numbers. Anywhere but the bridge, the
   depth of its feet. On the bridge, or stepping onto it, the depth of the nearer of the two tiles it is between, a
   little over that piece: the deck it walks on is drawn under it, never over its legs, while the pieces further on
   still lie over it. */
export function residentDepthY(site: BridgeSite | null, col: number, row: number, tileH: number): number {
  if (!site) return (col + row + 1) * (tileH / 2);
  const [along, across] = site.axis === 'u' ? [col, row] : [row, col];
  const [first, line] = site.axis === 'u' ? [site.col, site.row] : [site.row, site.col];
  const [from, to] = drawnSpan(site);
  const touches = Math.round(across) === line && Math.ceil(along) - first >= from && Math.floor(along) - first <= to;
  if (!touches) return (col + row + 1) * (tileH / 2);
  return (Math.ceil(along) + across + 1 + OVER_PIECE) * (tileH / 2);
}

/* Two sites are the same bridge. */
export function sameBridge(a: BridgeSite | null | undefined, b: BridgeSite | null | undefined): boolean {
  return bridgeKey(a) === bridgeKey(b);
}

/* A site's axis, place, length and bank ends in one word: empty for no bridge, so two sites compare by their keys. */
function bridgeKey(s: BridgeSite | null | undefined): string {
  return s ? `${s.axis}|${s.col}|${s.row}|${s.length}|${Boolean(s.overBank?.[0])}|${Boolean(s.overBank?.[1])}` : '';
}
