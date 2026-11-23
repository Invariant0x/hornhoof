/* Which drawn variant of its step each building shows (#1975). A building's own id picks it, so it stays the same in
   every session; buildings are taken oldest first, and a newer one steps past the variants its next-door neighbours of
   the same step already show while another is free, so an older building never changes when a neighbour arrives.
   Contains no theme words: the pack's art catalog says which steps have variants and how many. */

import { variantStepOf } from './art';
import type { CityBuilding } from './city-layout';
import type { WorldPackManifest } from './manifest';
import { hashSeed } from './prng';

/* The step a building shows and how many variants it has; buildings of one key are compared with each other. */
export type VariantStep = Readonly<{ key: string; count: number }>;

/* Lots this close (in tiles, a lane between them) count as next door. */
const NEXT_DOOR_GAP = 1;

function gap(a: CityBuilding['lot'], b: CityBuilding['lot']): number {
  const cols = Math.max(b.col - (a.col + a.spanCol), a.col - (b.col + b.spanCol));
  const rows = Math.max(b.row - (a.row + a.spanRow), a.row - (b.row + b.spanRow));
  return Math.max(cols, rows);
}

function olderFirst(a: CityBuilding, b: CityBuilding): number {
  return a.placedAtStep - b.placedAtStep || a.id.localeCompare(b.id);
}

/* The first variant from the building's own, going round, that no neighbour shows; its own when all are taken. */
function freeVariant(own: number, count: number, taken: ReadonlySet<number>): number {
  for (let k = 0; k < count; k++) {
    const v = (own + k) % count;
    if (!taken.has(v)) return v;
  }
  return own;
}

/* Building id -> variant index (0 = v01) for every building whose step has variants. */
export function chooseBuildingVariants(
  buildings: readonly CityBuilding[],
  stepOf: (building: CityBuilding) => VariantStep | null,
): ReadonlyMap<string, number> {
  const chosen = new Map<string, number>();
  const placed: { building: CityBuilding; key: string; variant: number }[] = [];
  for (const b of [...buildings].sort(olderFirst)) {
    const step = stepOf(b);
    if (!step || step.count < 1) continue;
    const taken = new Set(placed.filter(p => p.key === step.key && gap(p.building.lot, b.lot) <= NEXT_DOOR_GAP).map(p => p.variant));
    const variant = freeVariant(hashSeed(b.id) % step.count, step.count, taken);
    chosen.set(b.id, variant);
    placed.push({ building: b, key: step.key, variant });
  }
  return chosen;
}

/* The variants of the buildings of the city shown, if any, under the pack's art catalog. */
export function cityBuildingVariants(
  state: Readonly<{ city: Readonly<{ buildings: readonly CityBuilding[] }> }> | null,
  pack: WorldPackManifest,
): ReadonlyMap<string, number> {
  return chooseBuildingVariants(state?.city.buildings ?? [], b => variantStepOf(pack, b));
}
