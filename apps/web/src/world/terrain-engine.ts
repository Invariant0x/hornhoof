/* Universal, pack-agnostic procedural terrain engine.
   Knows zero biome names or world themes: runs any WorldPackManifest's terrainRecipe,
   computes discrete tile grids + smooth vertex corner fields (elevation, moisture, signed liquid
   distance and normalized material blend weights), preserves edge-expansion invariance and runs
   reusable connectivity, buildable-share and start-center checks. */

import type { TileCoord } from './coords';
import type {
  TerrainKindSpec,
  TerrainNoiseToolkit,
  WorldPackManifest,
} from './manifest';
import { createRng, fbm2D, hash2i, hashSeed, ridgedFbm2D, valueNoise2D } from './prng';

export type MapEdge = 'N' | 'E' | 'S' | 'W';

export const GALLERY_SEEDS: readonly string[] = [
  'hornhoof',
  'acme-corp',
  'solar-labs',
  'north-star',
  'atlas-studio',
  'velvet-ops',
  'kestrel-ai',
  'cobalt-works',
  'amber-forge',
  'meridian-hq',
  'quartz-cloud',
  'zephyr-games',
];

export const TERRAIN_NOISE_TOOLKIT: TerrainNoiseToolkit = {
  hashSeed,
  createRng,
  hash2i,
  valueNoise2D,
  fbm2D,
  ridgedFbm2D,
};

export type TerrainBounds = Readonly<{
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
}>;

export type GenerateWorldOptions = Readonly<{
  seed: string | number;
  mapSize?: number;
  /* Extra tiles added symmetrically around all four edges without shifting any existing coordinate. */
  expandMargin?: number;
}>;

/* Continuous scalar fields sampled at every tile corner vertex (width + 1) x (height + 1). */
export type CornerFieldGrid = Readonly<{
  minCol: number;
  minRow: number;
  cols: number;
  rows: number;
  elevation: Float32Array;
  moisture: Float32Array;
  signedWaterDist: Float32Array;
  materialIds: readonly string[];
  layerWeights: readonly Float32Array[];
}>;

export type ContinuityCheck = Readonly<{
  continuous: boolean;
  touchedEdges: readonly MapEdge[];
  largestComponentSize: number;
  totalMatchingTiles: number;
}>;

export type GeneratedMapStats = Readonly<{
  totalTiles: number;
  buildableTiles: number;
  buildableRatio: number;
  counts: Readonly<Record<string, number>>;
  continuityOk: boolean;
  continuityEdges: readonly MapEdge[];
  centerDistanceToLiquid: number;
  centerLocalBuildableRatio: number;
}>;

export type GeneratedWorldMap = Readonly<{
  packId: string;
  recipeId: string;
  seed: string;
  numericSeed: number;
  baseSize: number;
  bounds: TerrainBounds;
  width: number;
  height: number;
  startCenter: TileCoord;
  kindSpecs: readonly TerrainKindSpec[];
  kindById: ReadonlyMap<string, TerrainKindSpec>;
  tiles: Uint8Array;
  cornerFields: CornerFieldGrid;
  tileAt: (col: number, row: number) => string | null;
  kindSpecAt: (col: number, row: number) => TerrainKindSpec | null;
  isBuildable: (col: number, row: number) => boolean;
  isWalkable: (col: number, row: number) => boolean;
  stats: GeneratedMapStats;
}>;

/* Verifies that all tiles belonging to `kindIds` form one continuous 4-connected component reaching map edges. */
export function verifyTileContinuity(map: GeneratedWorldMap, kindIds: readonly string[]): ContinuityCheck {
  const { width, height, tiles, kindSpecs } = map;
  const targetIndices = new Set<number>();
  for (let i = 0; i < kindSpecs.length; i++) {
    if (kindIds.includes(kindSpecs[i]!.id)) targetIndices.add(i);
  }

  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let totalMatchingTiles = 0;
  let largestComponentSize = 0;
  let bestEdges = new Set<MapEdge>();

  for (let i = 0; i < tiles.length; i++) {
    if (targetIndices.has(tiles[i]!)) totalMatchingTiles++;
  }

  for (let start = 0; start < tiles.length; start++) {
    if (!targetIndices.has(tiles[start]!) || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    const edges = new Set<MapEdge>();

    while (head < tail) {
      const cur = queue[head++]!;
      const x = cur % width;
      const y = (cur - x) / width;

      if (y === 0) edges.add('N');
      if (x === width - 1) edges.add('E');
      if (y === height - 1) edges.add('S');
      if (x === 0) edges.add('W');

      if (x > 0) {
        const n = cur - 1;
        if (targetIndices.has(tiles[n]!) && !visited[n]) {
          visited[n] = 1;
          queue[tail++] = n;
        }
      }
      if (x + 1 < width) {
        const n = cur + 1;
        if (targetIndices.has(tiles[n]!) && !visited[n]) {
          visited[n] = 1;
          queue[tail++] = n;
        }
      }
      if (y > 0) {
        const n = cur - width;
        if (targetIndices.has(tiles[n]!) && !visited[n]) {
          visited[n] = 1;
          queue[tail++] = n;
        }
      }
      if (y + 1 < height) {
        const n = cur + width;
        if (targetIndices.has(tiles[n]!) && !visited[n]) {
          visited[n] = 1;
          queue[tail++] = n;
        }
      }
    }

    if (tail > largestComponentSize) {
      largestComponentSize = tail;
      bestEdges = edges;
    }
  }

  const order: MapEdge[] = ['N', 'E', 'S', 'W'];
  return {
    continuous: totalMatchingTiles > 0 && largestComponentSize === totalMatchingTiles,
    touchedEdges: order.filter(e => bestEdges.has(e)),
    largestComponentSize,
    totalMatchingTiles,
  };
}

function measureCenterDistanceToLiquid(
  startCenter: TileCoord,
  kindSpecAt: (col: number, row: number) => TerrainKindSpec | null,
): number {
  let bestSq = Infinity;
  const searchRadius = 28;
  for (let dy = -searchRadius; dy <= searchRadius; dy++) {
    for (let dx = -searchRadius; dx <= searchRadius; dx++) {
      if (kindSpecAt(startCenter.col + dx, startCenter.row + dy)?.liquid) {
        const sq = dx * dx + dy * dy;
        if (sq < bestSq) bestSq = sq;
      }
    }
  }
  return Number.isFinite(bestSq) ? Math.round(Math.sqrt(bestSq) * 10) / 10 : Infinity;
}

function measureCenterLocalBuildable(
  startCenter: TileCoord,
  isBuildable: (col: number, row: number) => boolean,
): number {
  let total = 0;
  let buildable = 0;
  for (let dy = -5; dy <= 5; dy++) {
    for (let dx = -5; dx <= 5; dx++) {
      total++;
      if (isBuildable(startCenter.col + dx, startCenter.row + dy)) buildable++;
    }
  }
  return total > 0 ? buildable / total : 0;
}

/* Executes any world pack's terrainRecipe deterministically, filling both discrete tiles
   and continuous smooth corner-vertex fields for texture blending and shoreline curves. */
export function generateWorldTerrain(
  pack: WorldPackManifest,
  options: GenerateWorldOptions,
): GeneratedWorldMap {
  const recipe = pack.terrainRecipe;
  if (!recipe) {
    throw new Error(`World pack "${pack.id}" does not declare a terrainRecipe`);
  }

  const baseSize = Math.max(32, Math.floor(options.mapSize ?? pack.mapSize));
  const expandMargin = Math.max(0, Math.floor(options.expandMargin ?? 0));
  const seedText = String(options.seed);
  const numericSeed = hashSeed(seedText);
  const prepared = recipe.prepare(numericSeed, baseSize, TERRAIN_NOISE_TOOLKIT);

  const bounds: TerrainBounds = {
    minCol: -expandMargin,
    maxCol: baseSize + expandMargin,
    minRow: -expandMargin,
    maxRow: baseSize + expandMargin,
  };
  const width = bounds.maxCol - bounds.minCol;
  const height = bounds.maxRow - bounds.minRow;

  const kindSpecs = recipe.tileKinds;
  const kindIndexById = new Map<string, number>();
  const kindById = new Map<string, TerrainKindSpec>();
  const counts: Record<string, number> = {};
  for (let i = 0; i < kindSpecs.length; i++) {
    const spec = kindSpecs[i]!;
    kindIndexById.set(spec.id, i);
    kindById.set(spec.id, spec);
    counts[spec.id] = 0;
  }

  const tiles = new Uint8Array(width * height);
  let buildableTiles = 0;
  let cursor = 0;
  for (let row = bounds.minRow; row < bounds.maxRow; row++) {
    for (let col = bounds.minCol; col < bounds.maxCol; col++) {
      const id = prepared.sampleTile(col, row);
      const idx = kindIndexById.get(id) ?? 0;
      const spec = kindSpecs[idx]!;
      tiles[cursor++] = idx;
      counts[spec.id] = (counts[spec.id] ?? 0) + 1;
      if (spec.buildable || (recipe.countExcavatableAsOpen && spec.excavatable)) {
        buildableTiles++;
      }
    }
  }

  /* Evaluate continuous smooth fields on the (width + 1) x (height + 1) tile-corner lattice. */
  const vCols = width + 1;
  const vRows = height + 1;
  const vCount = vCols * vRows;
  const materialIds = recipe.materialIds;
  const elevation = new Float32Array(vCount);
  const moisture = new Float32Array(vCount);
  const signedWaterDist = new Float32Array(vCount);
  const layerWeights = materialIds.map(() => new Float32Array(vCount));

  let vc = 0;
  for (let vr = bounds.minRow; vr <= bounds.maxRow; vr++) {
    for (let vCol = bounds.minCol; vCol <= bounds.maxCol; vCol++) {
      const sample = prepared.sampleCorner(vCol, vr);
      elevation[vc] = sample.elevation;
      moisture[vc] = sample.moisture;
      signedWaterDist[vc] = sample.signedWaterDist;

      let sumW = 0;
      for (let m = 0; m < materialIds.length; m++) {
        const raw = sample.layerWeights[materialIds[m]!] ?? 0;
        const clamped = raw > 0 ? raw : 0;
        layerWeights[m]![vc] = clamped;
        sumW += clamped;
      }
      if (sumW > 1e-6) {
        const inv = 1 / sumW;
        for (let m = 0; m < materialIds.length; m++) {
          layerWeights[m]![vc] = layerWeights[m]![vc]! * inv;
        }
      } else if (materialIds.length > 0) {
        layerWeights[0]![vc] = 1;
      }
      vc++;
    }
  }

  const cornerFields: CornerFieldGrid = {
    minCol: bounds.minCol,
    minRow: bounds.minRow,
    cols: vCols,
    rows: vRows,
    elevation,
    moisture,
    signedWaterDist,
    materialIds,
    layerWeights,
  };

  const tileAt = (col: number, row: number): string | null => {
    if (col < bounds.minCol || col >= bounds.maxCol || row < bounds.minRow || row >= bounds.maxRow) {
      return null;
    }
    const idx = (row - bounds.minRow) * width + (col - bounds.minCol);
    return kindSpecs[tiles[idx]!]?.id ?? null;
  };

  const kindSpecAt = (col: number, row: number): TerrainKindSpec | null => {
    const id = tileAt(col, row);
    return id ? (kindById.get(id) ?? null) : null;
  };

  const isBuildable = (col: number, row: number): boolean => Boolean(kindSpecAt(col, row)?.buildable);
  const isWalkable = (col: number, row: number): boolean => Boolean(kindSpecAt(col, row)?.walkable);

  const partial: GeneratedWorldMap = {
    packId: pack.id,
    recipeId: recipe.id,
    seed: seedText,
    numericSeed,
    baseSize,
    bounds,
    width,
    height,
    startCenter: prepared.startCenter,
    kindSpecs,
    kindById,
    tiles,
    cornerFields,
    tileAt,
    kindSpecAt,
    isBuildable,
    isWalkable,
    stats: {
      totalTiles: width * height,
      buildableTiles,
      buildableRatio: buildableTiles / (width * height),
      counts,
      continuityOk: true,
      continuityEdges: [],
      centerDistanceToLiquid: 0,
      centerLocalBuildableRatio: 0,
    },
  };

  const continuity =
    recipe.continuityKindIds && recipe.continuityKindIds.length > 0
      ? verifyTileContinuity(partial, recipe.continuityKindIds)
      : { continuous: true, touchedEdges: [] as MapEdge[], largestComponentSize: 0, totalMatchingTiles: 0 };

  return {
    ...partial,
    stats: {
      totalTiles: width * height,
      buildableTiles,
      buildableRatio: buildableTiles / (width * height),
      counts,
      continuityOk: continuity.continuous,
      continuityEdges: continuity.touchedEdges,
      centerDistanceToLiquid: measureCenterDistanceToLiquid(prepared.startCenter, kindSpecAt),
      centerLocalBuildableRatio: measureCenterLocalBuildable(prepared.startCenter, isBuildable),
    },
  };
}
