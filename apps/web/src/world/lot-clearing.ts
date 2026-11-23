/* Cleared ground under the city's building lots, for every pack (#1958): a lot is cleared from its first construction
   stage, its edge eases into the land around, and a lot a building moved away from stays cleared until another
   building stands on it or the pack's regrowth time has passed. The ground baker mixes the pack's lot ground in by the
   share given here, and plants stay off every cleared lot. Contains no theme words. */

import type { WorldRelocationRecord } from '@hornhoof/protocol/world';
import type { CityBuilding, CityState } from './city-layout';
import type { LotGroundSpec, WorldPackManifest } from './manifest';

export type LotRect = Readonly<{ col: number; row: number; spanCol: number; spanRow: number }>;

/* A lot a building moved away from, and when (ms since the epoch): the time the server accepted the move. */
export type VacatedLot = LotRect & Readonly<{ since: number }>;

export type LotClearing = Readonly<{
  lots: readonly LotRect[];
  /* Width in tiles of the soft edge outside each lot. */
  edge: number;
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
   moved building's footprint, while no building stands on it. Only what the server already keeps is read. */
export function vacatedLotsFromRelocations(
  relocations: readonly WorldRelocationRecord[],
  buildings: readonly CityBuilding[],
  spec: LotGroundSpec,
  now: number,
): VacatedLot[] {
  const out: VacatedLot[] = [];
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
  return lots.length > 0 ? { lots, edge: e } : null;
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
  return clearing.lots.map(l => `${l.col},${l.row},${l.spanCol},${l.spanRow}`).join(';');
}
