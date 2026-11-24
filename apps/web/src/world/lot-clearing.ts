/* Cleared ground under the city's building lots, for every pack (#1958): a lot is cleared from its first construction
   stage, its edge eases into the land around, and a lot a building moved away from stays cleared until another
   building stands on it or the pack's regrowth time has passed. The ground baker mixes the pack's lot ground in by the
   share given here, and plants stay off every cleared lot. Contains no theme words. */

import type { WorldRelocationRecord } from '@hornhoof/protocol/world';
import type { CityBuilding, CityState } from './city-layout';
import type { LotGroundSpec, WorldPackManifest } from './manifest';
import type { StreetTile } from './street-field';

export type LotRect = Readonly<{ col: number; row: number; spanCol: number; spanRow: number }>;

/* A lot a building moved away from, and when (ms since the epoch): the time the server accepted the move. */
export type VacatedLot = LotRect & Readonly<{ since: number }>;

export type LotClearing = Readonly<{
  lots: readonly LotRect[];
  /* Width in tiles of the soft edge outside each lot. */
  edge: number;
  /* The city's street tiles, baked into the same ground under the pack's street strips (street-field.ts, #1985). */
  streets?: readonly StreetTile[];
}>;

const HOUR_MS = 3_600_000;

function rectOf(r: LotRect): LotRect {
  return { col: r.col, row: r.row, spanCol: r.spanCol, spanRow: r.spanRow };
}

function overlaps(a: LotRect, b: LotRect): boolean {
  return a.col < b.col + b.spanCol && b.col < a.col + a.spanCol && a.row < b.row + b.spanRow && b.row < a.row + a.spanRow;
}

/* The lots buildings left that no building stands on now. */
export function openVacatedLots(city: Pick<CityState, 'buildings' | 'vacatedLots'>): VacatedLot[] {
  return city.vacatedLots.filter(lot => !city.buildings.some(b => overlaps(b, lot)));
}

/* The lots the city's accepted moves left behind and that have not grown back by `now`: each move's starting lot with the
   moved building's footprint, while no building stands on it. Only what the server already keeps is read. A pack with no
   lot ground keeps none. */
export function vacatedLotsFromRelocations(
  relocations: readonly WorldRelocationRecord[],
  buildings: readonly CityBuilding[],
  spec: LotGroundSpec | undefined,
  now: number,
): VacatedLot[] {
  const out: VacatedLot[] = [];
  if (!spec) return out;
  for (const rel of relocations) {
    if (rel.status !== 'applied' || !rel.resolvedAt) continue;
    const moved = buildings.find(b => b.id === rel.buildingId);
    const since = Date.parse(rel.resolvedAt);
    if (!moved || !Number.isFinite(since) || now - since >= spec.regrowthHours * HOUR_MS) continue;
    const lot: VacatedLot = { col: rel.fromCol, row: rel.fromRow, spanCol: moved.spanCol, spanRow: moved.spanRow, since };
    if (!buildings.some(b => overlaps(b, lot))) out.push(lot);
  }
  return out;
}

/* The city's cleared lots under the pack's rule, or null for a pack without a lot ground: every building from its
   first construction stage on, every open lot a building left, and any extra lots (a surveyed plot). */
export function cityLotClearing(
  city: Pick<CityState, 'buildings' | 'vacatedLots'>,
  pack: WorldPackManifest,
  extra: readonly LotRect[] = [],
): LotClearing | null {
  const spec = pack.lotGround;
  if (!spec) return null;
  const lots = [...city.buildings.filter(b => b.stage >= 1), ...openVacatedLots(city), ...extra].map(rectOf);
  return { lots, edge: spec.edgeTiles };
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/* How much farther or nearer the edge reaches at (u, v): a slow wobble two tiles long, so even a one-tile lot gets an
   uneven outline. Slow enough that the share still only falls going away from a lot. */
const EDGE_WOBBLE = 0.45;
function edgeWobble(u: number, v: number): number {
  return 1 + EDGE_WOBBLE * 0.5 * (Math.sin(u * 3.1 + v * 1.3) + Math.sin(v * 2.9 - u * 1.7));
}

/* Share of the cleared ground at (u, v) in tiles: 1 on a lot, easing to 0 over about the edge width outside it. */
export function lotClearingAt(clearing: LotClearing, u: number, v: number): number {
  let best = 0;
  const edge = clearing.edge;
  const reach = edge / (1 - EDGE_WOBBLE);
  for (const lot of clearing.lots) {
    const dx = Math.max(lot.col - u, 0, u - lot.col - lot.spanCol);
    if (dx >= reach) continue;
    const dy = Math.max(lot.row - v, 0, v - lot.row - lot.spanRow);
    if (dy >= reach) continue;
    const share = 1 - smoothstep(0, edge, Math.hypot(dx, dy) * edgeWobble(u, v));
    if (share > best) {
      best = share;
      if (best >= 1) break;
    }
  }
  return best;
}

/* The lots whose cleared ground reaches into a tile rectangle, as a clearing of their own; null when none does. */
export function lotClearingNear(
  clearing: LotClearing,
  area: Readonly<{ colStart: number; colEnd: number; rowStart: number; rowEnd: number }>,
): LotClearing | null {
  const e = clearing.edge / (1 - EDGE_WOBBLE);
  const lots = clearing.lots.filter(
    l => l.col - e < area.colEnd && l.col + l.spanCol + e > area.colStart && l.row - e < area.rowEnd && l.row + l.spanRow + e > area.rowStart,
  );
  return nearClearing(lots, e, streetsNear(clearing.streets, area));
}

/* The streets whose joins reach into a tile rectangle: a street's neighbours decide its joins, one tile beyond it. */
function streetsNear(
  streets: readonly StreetTile[] | undefined,
  area: Readonly<{ colStart: number; colEnd: number; rowStart: number; rowEnd: number }>,
): readonly StreetTile[] {
  return (streets ?? []).filter(t => t.col + 2 > area.colStart && t.col - 1 < area.colEnd && t.row + 2 > area.rowStart && t.row - 1 < area.rowEnd);
}

/* A clearing of the lots and streets near a place, or null when neither is. */
function nearClearing(lots: readonly LotRect[], edge: number, streets: readonly StreetTile[]): LotClearing | null {
  if (streets.length > 0) return { lots, edge, streets };
  return lots.length > 0 ? { lots, edge } : null;
}

/* The lots a chunk's bake needs: those reaching into its tiles or the one-tile margin its pixels overlap. */
export function chunkLotClearing(
  clearing: LotClearing | null,
  chunk: Readonly<{ colStart: number; colEnd: number; rowStart: number; rowEnd: number }>,
): LotClearing | null {
  if (!clearing) return null;
  return lotClearingNear(clearing, { colStart: chunk.colStart - 1, colEnd: chunk.colEnd + 1, rowStart: chunk.rowStart - 1, rowEnd: chunk.rowEnd + 1 });
}

/* The surveyed plot of an empty lot, around its stakes: cleared ground under the stakes, the rope and the boards. */
export function surveyedLot(stakes: readonly Readonly<{ col: number; row: number }>[]): LotRect | null {
  if (stakes.length === 0) return null;
  const cols = stakes.map(s => s.col);
  const rows = stakes.map(s => s.row);
  const col = Math.min(...cols);
  const row = Math.min(...rows);
  return { col, row, spanCol: Math.max(...cols) - col + 1, spanRow: Math.max(...rows) - row + 1 };
}

/* A short text that changes whenever the lots of a clearing do: part of a baked chunk's cache key. */
export function lotClearingKey(clearing: LotClearing | null): string {
  if (!clearing) return '';
  return clearing.lots.map(l => `${l.col},${l.row},${l.spanCol},${l.spanRow}`).join(';') + streetsKey(clearing.streets);
}

/* The streets' part of a clearing's key: empty without streets, so a clearing of lots alone keeps its key. */
function streetsKey(streets: readonly StreetTile[] | undefined): string {
  if (!streets?.length) return '';
  return `|${streets.map(t => `${t.col},${t.row}${t.tier[0]}${t.bridge ? 'b' : ''}`).join(';')}`;
}

/* The cache-key part of the cleared lots for each chunk under one clearing, and the last key each chunk was baked under:
   a chunk whose lots changed shows that picture until the one with the new lots is baked. */
export class ChunkLotKeys {
  private clearing: LotClearing | null = null;
  private readonly byChunk = new Map<string, string>();
  private readonly lastBaked = new Map<string, string>();

  /* A new clearing: every chunk's key part is worked out again. */
  reset(clearing: LotClearing | null): void {
    this.clearing = clearing;
    this.byChunk.clear();
  }

  /* '#' and the lots reaching into the chunk, or '' when none does. */
  keyOf(chunk: Readonly<{ key: string; colStart: number; colEnd: number; rowStart: number; rowEnd: number }>): string {
    let k = this.byChunk.get(chunk.key);
    if (k === undefined) {
      const near = chunkLotClearing(this.clearing, chunk);
      k = near ? `#${lotClearingKey(near)}` : '';
      this.byChunk.set(chunk.key, k);
    }
    return k;
  }

  /* A chunk's picture was baked under this whole cache key. */
  baked(key: string): void {
    this.lastBaked.set(key.split('#')[0]!, key);
  }

  /* The picture last baked for a chunk under any clearing, at the levels of detail in the order the cache is searched. */
  lastBakedHit<T>(chunkKey: string, lodIds: readonly string[], get: (key: string) => T | undefined): { key: string; entry: T } | null {
    for (let i = lodIds.length - 1; i >= 0; i--) {
      const key = this.lastBaked.get(`${chunkKey}@${lodIds[i]}`);
      const entry = key === undefined ? undefined : get(key);
      if (entry !== undefined) return { key: key!, entry };
    }
    return null;
  }
}
