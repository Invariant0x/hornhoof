/* Stage 3 organic city growth engine: pack-agnostic role-based placement from center,
   standard 1x1..6x6 building footprints with in-place growth by level/stage, Order/Chaos knob,
   automatic A* road pathfinding with traffic upgrades (trail, dirt, brick, stone, and the 2-tile avenue, road-traffic.ts), reserved growth lots,
   expanding outer city wall rings (old walls convert to ring streets), excavation support for
   subterranean worlds (city growth carves halls and tunnels out of rock), urban densification,
   server-persistable stable snapshots and staged relocation by explicit acceptance.
   Every building keeps the front (bottom) corner of its lot and grows backward from it, with its door on a
   front wall, so the door, the plot corner and the art's registration never move while it grows.
   Contains zero theme-specific words, files or colours. */

import { bridgeEnds, bridgeSite, bridgeStepAllowed, bridgeTiles, onBridge, sameBridge, type BridgeSite } from './bridge-site';
import type { TileCoord } from './coords';
import { openVacatedLots, type VacatedLot } from './lot-clearing';
import type { BuildingLayoutRules, BuildingLayoutSpec, CityBuildingKind, OuterWallMode } from './manifest';
import { createRng, hash2i } from './prng';
import type { GeneratedWorldMap } from './terrain-engine';

export type BuildingKind = CityBuildingKind;

export const ALL_BUILDING_KINDS: readonly BuildingKind[] = [
  'residence',
  'monument',
  'department',
  'district_hub',
  'supply',
  'house',
  'statue',
  'flophouse',
];

export type RoadTier = 'trail' | 'dirt' | 'brick' | 'stone' | 'avenue';

/* The rank of each road kind: a road only ever rises to a higher one. */
export const ROAD_TIER_RANK: Readonly<Record<RoadTier, number>> = { trail: 0, dirt: 1, brick: 2, stone: 3, avenue: 4 };

/* The line an avenue tile lies on (#2003): an avenue is two tiles wide, a run of tiles along `axis` ('u' along col,
   'v' along row) and its lane beside it, and its middle line runs between them, half a tile toward `side` across the
   axis from each tile's centre. */
export type AvenueLine = Readonly<{ axis: 'u' | 'v'; side: -1 | 1 }>;

export type LotRect = Readonly<{
  col: number;
  row: number;
  spanCol: number;
  spanRow: number;
}>;

export type CityBuilding = {
  id: string;
  kind: BuildingKind;
  label: string;
  col: number;
  row: number;
  spanCol: number;
  spanRow: number;
  lot: LotRect;
  door: TileCoord;
  districtId?: string;
  departmentId?: string;
  stage: number;
  maxStage: number;
  floors: number;
  level: number;
  residentIds: string[];
  mergedFromIds: string[];
  goalCount: number;
  placedAtStep: number;
  /* Optional Stage 4 live-data display properties (never alter saved coordinates). */
  entityId?: string;
  acceptedTasks?: number;
  fullness?: number;
  progress?: number;
  reached?: boolean;
  celebrating?: boolean;
  resting?: boolean;
  provider?: string;
  pendingRelocation?: {
    relocationId: string;
    taskId: string;
    taskNumber: number;
    toCol: number;
    toRow: number;
  } | null;
};

export type RoadTile = {
  col: number;
  row: number;
  tier: RoadTier;
  traffic: number;
  bridge: boolean;
  wasOldWall: boolean;
  grandAvenue: boolean;
  /* Set on the tiles of an avenue, whose tier is 'avenue'. */
  avenue?: AvenueLine;
};

export type RelocationStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type RelocationPhase = 'waiting_acceptance' | 'dismantling' | 'building' | 'done';

export type CityRelocation = {
  id: string;
  buildingId: string;
  fromCol: number;
  fromRow: number;
  toCol: number;
  toRow: number;
  status: RelocationStatus;
  phase: RelocationPhase;
  oldStage: number;
  newStage: number;
  targetStage: number;
};

export type CityMetrics = {
  roadStraightness: number;
  gridAlignmentRatio: number;
  densifiedUpgrades: number;
  mergedBuildings: number;
  oldWallRoadsCreated: number;
  bridgeTiles: number;
  excavatedCount: number;
};

export type WallHull = Readonly<{
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minSum: number;
  maxSum: number;
  minDiff: number;
  maxDiff: number;
}>;

export type CityState = {
  packId: string;
  seed: string;
  baseSize: number;
  orderChaos: number;
  outerWallMode: OuterWallMode;
  center: TileCoord;
  stepCounter: number;
  wallGeneration: number;
  wallHull: WallHull | null;
  buildings: CityBuilding[];
  roads: Map<string, RoadTile>;
  wallTiles: Set<string>;
  excavatedTiles: Set<string>;
  relocations: CityRelocation[];
  /* Lots buildings moved away from that are still cleared ground, from the relocations the server keeps; recomputed
     on every sync and never saved with the layout. */
  vacatedLots: VacatedLot[];
  footprintOccupant: Map<string, string>;
  lotReservation: Map<string, string>;
  metrics: CityMetrics;
  rngState: number;
  /* The pack's door and growth rules per kind; pack data, so snapshots leave it out. */
  buildingLayout: BuildingLayoutRules;
  /* The map's bridge when the pack has its pictures (bridge-site.ts, #1985): the one place a street may cross water.
     Null or absent, no street crosses water. Worked out from the map and the pack's art, so snapshots leave it out. */
  bridge?: BridgeSite | null;
};

export type PlaceBuildingRequest = Readonly<{
  id: string;
  kind: BuildingKind;
  label?: string;
  districtId?: string;
  departmentId?: string;
  stage?: number;
  level?: number;
  residentIds?: readonly string[];
  spanCol?: number;
  spanRow?: number;
  lotSpanCol?: number;
  lotSpanRow?: number;
}>;

export type CityLayoutSnapshot = Readonly<{
  version: 3;
  packId: string;
  seed: string;
  baseSize: number;
  orderChaos: number;
  outerWallMode?: OuterWallMode;
  center: TileCoord;
  stepCounter: number;
  wallGeneration: number;
  wallHull: WallHull | null;
  buildings: readonly CityBuilding[];
  roads: readonly RoadTile[];
  wallTiles: readonly string[];
  excavatedTiles: readonly string[];
  relocations: readonly CityRelocation[];
  metrics: CityMetrics;
  rngState: number;
}>;

export type CityInvariantReport = Readonly<{
  ok: boolean;
  errors: readonly string[];
  overlappingPairs: number;
  invalidTerrainTiles: number;
  roadBuildingCollisions: number;
  disconnectedBuildings: number;
  doorsOffFrontWalls: number;
}>;

export type KindTileStats = Readonly<{
  count: number;
  tiles: number;
}>;

export type CityTileBreakdown = Readonly<{
  byKind: Readonly<Record<BuildingKind, KindTileStats>>;
  buildingsTotalTiles: number;
  reservedLotTiles: number;
  roadsTotalTiles: number;
  wallTiles: number;
  excavatedTiles: number;
  activeCityTiles: number;
  enclosedHullTiles: number;
  mapTotalTiles: number;
  mapUsableTiles: number;
  activeShareOfMap: number;
  activeShareOfUsable: number;
  enclosedShareOfMap: number;
  enclosedShareOfUsable: number;
}>;

const ROAD_THRESHOLDS = {
  dirt: 10,
  brick: 35,
  stone: 90,
} as const;

const GRID_BLOCK_STEP = 9;

const CARDINAL_DIRS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export function tileKey(col: number, row: number): string {
  return `${col},${row}`;
}

export function parseTileKey(key: string): TileCoord {
  const comma = key.indexOf(',');
  return {
    col: Number.parseInt(key.slice(0, comma), 10),
    row: Number.parseInt(key.slice(comma + 1), 10),
  };
}

/* Raises a road to a kind when that kind is higher than the one it has. */
export function raiseRoadTier(road: RoadTile, tier: RoadTier): void {
  if (ROAD_TIER_RANK[tier] > ROAD_TIER_RANK[road.tier]) road.tier = tier;
}

export function roadTierForTraffic(traffic: number): RoadTier {
  if (traffic >= ROAD_THRESHOLDS.stone) return 'stone';
  if (traffic >= ROAD_THRESHOLDS.brick) return 'brick';
  if (traffic >= ROAD_THRESHOLDS.dirt) return 'dirt';
  return 'trail';
}

function nextRand(city: CityState): number {
  city.rngState = (city.rngState + 0x6d2b79f5) >>> 0;
  let t = Math.imul(city.rngState ^ (city.rngState >>> 15), 1 | city.rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/* Engine growth ladders (sizes from 10-standart-razmerov.json, smallest first) for kinds that grow in place;
   a pack's buildingLayout replaces a kind's ladder. The last size is the lot. */
const ENGINE_SPANS: Readonly<Partial<Record<BuildingKind, readonly number[]>>> = {
  /* 2x2 starter shelter up to a 6x6 grand compound across 5 stages. */
  residence: [2, 3, 4, 5, 6],
  /* 3x3 -> 4x4 -> 5x5 across 10 department stages. */
  department: [3, 4, 5],
  district_hub: [3, 4],
  /* Agent home by level: Lv 1-3 = 1x1, Lv 4-7 = 2x2, Lv 8-14 = 3x3, Lv 15+ = 4x4. */
  house: [1, 2, 3, 4],
  flophouse: [2, 3],
};

/* The growth step (index into the kind's ladder) a building has reached by its level or stage; -1 = no growth. */
function growthStepForProgress(kind: BuildingKind, level: number, stage: number): number {
  switch (kind) {
    case 'residence':
      return Math.max(0, stage - 1);
    /* A district hub's stage is its machine's power tier (1..3) in the live city and its age in years in the
       simulator: one size per step. */
    case 'district_hub':
      return Math.max(0, stage - 1);
    case 'department':
      return stage >= 8 ? 2 : stage >= 4 ? 1 : 0;
    case 'house':
      return level >= 15 ? 3 : level >= 8 ? 2 : level >= 4 ? 1 : 0;
    case 'flophouse':
      return stage >= 3 ? 1 : 0;
    case 'monument':
    case 'statue':
    case 'supply':
      return -1;
  }
}

/* Standard footprints (1x1..6x6 from 10-standart-razmerov.json) and reserved growth lots. */
export function targetSpanForProgress(
  kind: BuildingKind,
  level: number,
  stage: number,
  lot: LotRect,
  rules?: BuildingLayoutRules,
): { spanCol: number; spanRow: number } {
  const step = growthStepForProgress(kind, level, stage);
  const ladder = rules?.[kind]?.spans ?? ENGINE_SPANS[kind];
  if (step < 0 || !ladder) return { spanCol: lot.spanCol, spanRow: lot.spanRow };
  const desired = ladder[Math.min(step, ladder.length - 1)]!;
  return {
    spanCol: Math.min(lot.spanCol, desired),
    spanRow: Math.min(lot.spanRow, desired),
  };
}

/* The lot shares the building's front corner (col + spanCol, row + spanRow) and reaches back from it. */
function lotBehind(col: number, row: number, spanCol: number, spanRow: number, lotC: number, lotR: number): LotRect {
  return { col: col + spanCol - lotC, row: row + spanRow - lotR, spanCol: lotC, spanRow: lotR };
}

function defaultFootprint(
  kind: BuildingKind,
  indexOfKind: number,
  deptStatueIndex: number,
  rules?: BuildingLayoutRules,
): {
  spanCol: number;
  spanRow: number;
  lotSpanCol: number;
  lotSpanRow: number;
  maxStage: number;
} {
  const engine = engineFootprint(kind, indexOfKind, deptStatueIndex);
  const spans = rules?.[kind]?.spans;
  if (!spans || spans.length === 0) return engine;
  const first = spans[0]!;
  const last = spans[spans.length - 1]!;
  return { spanCol: first, spanRow: first, lotSpanCol: last, lotSpanRow: last, maxStage: engine.maxStage };
}

function engineFootprint(
  kind: BuildingKind,
  indexOfKind: number,
  deptStatueIndex: number,
): {
  spanCol: number;
  spanRow: number;
  lotSpanCol: number;
  lotSpanRow: number;
  maxStage: number;
} {
  switch (kind) {
    case 'residence':
      /* Starts 2x2 inside a reserved 6x6 grand residence compound. */
      return { spanCol: 2, spanRow: 2, lotSpanCol: 6, lotSpanRow: 6, maxStage: 5 };
    case 'monument':
      /* Centerpiece primary goal is 6x6; flagship goals (every 5th) are 5x5; standard major goals are 4x4. */
      if (indexOfKind === 0) {
        return { spanCol: 6, spanRow: 6, lotSpanCol: 6, lotSpanRow: 6, maxStage: 10 };
      }
      if ((indexOfKind + 1) % 5 === 0) {
        return { spanCol: 5, spanRow: 5, lotSpanCol: 5, lotSpanRow: 5, maxStage: 10 };
      }
      return { spanCol: 4, spanRow: 4, lotSpanCol: 4, lotSpanRow: 4, maxStage: 10 };
    case 'department':
      /* Starts 3x3 on the main avenue with a reserved 5x5 complex lot. */
      return { spanCol: 3, spanRow: 3, lotSpanCol: 5, lotSpanRow: 5, maxStage: 10 };
    case 'district_hub':
      return { spanCol: 3, spanRow: 3, lotSpanCol: 4, lotSpanRow: 4, maxStage: 10 };
    case 'supply':
      return { spanCol: 3, spanRow: 3, lotSpanCol: 3, lotSpanRow: 3, maxStage: 6 };
    case 'house':
      /* Starts as a 1x1 dwelling inside a reserved 4x4 growth plot (shrinks only under extreme crowding). */
      return { spanCol: 1, spanRow: 1, lotSpanCol: 4, lotSpanRow: 4, maxStage: 10 };
    case 'statue': {
      /* Successive statues along a department avenue grow larger: 1x1 -> 2x2 -> 3x3. */
      const sz = deptStatueIndex >= 5 ? 3 : deptStatueIndex >= 2 ? 2 : 1;
      return { spanCol: sz, spanRow: sz, lotSpanCol: sz, lotSpanRow: sz, maxStage: 20 };
    }
    case 'flophouse':
      return { spanCol: 2, spanRow: 2, lotSpanCol: 3, lotSpanRow: 3, maxStage: 6 };
  }
}

/* Terrain predicate supporting both open-surface worlds and excavatable subterranean worlds. */
function isTerrainCityUsable(map: GeneratedWorldMap, col: number, row: number): boolean {
  return map.isBuildable(col, row) || map.isExcavatable(col, row);
}

function carveTileIfExcavatable(city: CityState, map: GeneratedWorldMap, col: number, row: number): void {
  if (!map.isExcavatable(col, row)) return;
  const k = tileKey(col, row);
  if (!city.excavatedTiles.has(k)) {
    city.excavatedTiles.add(k);
    city.metrics.excavatedCount = city.excavatedTiles.size;
  }
}

function stampBuildingOccupancy(city: CityState, map: GeneratedWorldMap | undefined, b: CityBuilding): void {
  for (let r = b.lot.row; r < b.lot.row + b.lot.spanRow; r++) {
    for (let c = b.lot.col; c < b.lot.col + b.lot.spanCol; c++) {
      const k = tileKey(c, r);
      if (!city.lotReservation.has(k)) city.lotReservation.set(k, b.id);
    }
  }
  for (let r = b.row; r < b.row + b.spanRow; r++) {
    for (let c = b.col; c < b.col + b.spanCol; c++) {
      city.footprintOccupant.set(tileKey(c, r), b.id);
      if (map) carveTileIfExcavatable(city, map, c, r);
    }
  }
}

function clearBuildingOccupancy(city: CityState, b: CityBuilding): void {
  for (let r = b.row; r < b.row + b.spanRow; r++) {
    for (let c = b.col; c < b.col + b.spanCol; c++) {
      const k = tileKey(c, r);
      if (city.footprintOccupant.get(k) === b.id) city.footprintOccupant.delete(k);
    }
  }
  for (let r = b.lot.row; r < b.lot.row + b.lot.spanRow; r++) {
    for (let c = b.lot.col; c < b.lot.col + b.lot.spanCol; c++) {
      const k = tileKey(c, r);
      if (city.lotReservation.get(k) === b.id) city.lotReservation.delete(k);
    }
  }
}

export function setRoadTile(
  city: CityState,
  map: GeneratedWorldMap,
  col: number,
  row: number,
  options?: { trafficDelta?: number; grandAvenue?: boolean; wasOldWall?: boolean; minTier?: RoadTier },
): RoadTile {
  const k = tileKey(col, row);
  const bridge = map.isLiquid(col, row);
  carveTileIfExcavatable(city, map, col, row);
  const existing = city.roads.get(k);
  const delta = options?.trafficDelta ?? 1;
  if (existing) {
    existing.traffic += delta;
    raiseRoadTier(existing, roadTierForTraffic(existing.traffic));
    if (options?.minTier) raiseRoadTier(existing, options.minTier);
    if (options?.grandAvenue) existing.grandAvenue = true;
    if (options?.wasOldWall) existing.wasOldWall = true;
    return existing;
  }

  let tier = roadTierForTraffic(delta);
  if (options?.minTier && ROAD_TIER_RANK[options.minTier] > ROAD_TIER_RANK[tier]) tier = options.minTier;
  if (options?.grandAvenue && ROAD_TIER_RANK.brick > ROAD_TIER_RANK[tier]) tier = 'brick';

  const tile: RoadTile = {
    col,
    row,
    tier,
    traffic: delta,
    bridge,
    wasOldWall: Boolean(options?.wasOldWall),
    grandAvenue: Boolean(options?.grandAvenue),
  };
  city.roads.set(k, tile);
  if (bridge) city.metrics.bridgeTiles++;
  /* A road through an active wall creates a city gate rather than leaving wall over road. */
  city.wallTiles.delete(k);
  return tile;
}

export function canPlaceFootprint(
  city: CityState,
  map: GeneratedWorldMap,
  col: number,
  row: number,
  spanCol: number,
  spanRow: number,
  ignoreBuildingId?: string,
  respectOtherLots = true,
): boolean {
  /* Keep a 3-tile margin inside base map edges so roads and outer walls stay clean. */
  const pad = 3;
  if (
    col < map.bounds.minCol + pad ||
    row < map.bounds.minRow + pad ||
    col + spanCol > map.bounds.maxCol - pad ||
    row + spanRow > map.bounds.maxRow - pad
  ) {
    return false;
  }

  for (let r = row; r < row + spanRow; r++) {
    for (let c = col; c < col + spanCol; c++) {
      if (!isTerrainCityUsable(map, c, r)) return false;
      const k = tileKey(c, r);
      const occ = city.footprintOccupant.get(k);
      if (occ && occ !== ignoreBuildingId) return false;
      if (city.roads.has(k)) return false;
      if (respectOtherLots) {
        const res = city.lotReservation.get(k);
        if (res && res !== ignoreBuildingId) return false;
      }
    }
  }
  return true;
}

export function canWalkRoad(
  city: CityState,
  map: GeneratedWorldMap,
  col: number,
  row: number,
  allowBridge: boolean,
): boolean {
  const spec = map.kindSpecAt(col, row);
  if (!spec) return false;
  if (spec.liquid) {
    if (!waterOpen(city, allowBridge, col, row)) return false;
  } else if (!spec.walkable && !spec.excavatable) {
    return false;
  }
  const k = tileKey(col, row);
  if (city.footprintOccupant.has(k)) return false;
  return true;
}

/* The door tile of a pack rule: on the named front wall, fromFront tile rows back from the front corner.
   The front corner never moves while the building grows, so neither does this tile. */
function ruleDoorTile(col: number, row: number, spanCol: number, spanRow: number, rule: BuildingLayoutSpec): TileCoord {
  const k = Math.max(0, Math.min(rule.door.fromFront, (rule.door.wall === 'front_right' ? spanRow : spanCol) - 1));
  return rule.door.wall === 'front_right'
    ? { col: col + spanCol, row: row + spanRow - 1 - k }
    : { col: col + spanCol - 1 - k, row: row + spanRow };
}

/* Picks the door tile in front of a front wall: the pack's painted door when the kind has a rule, otherwise
   the front-wall tile that reaches the street best. Back walls never hold a door: the lot and the growth
   lie behind the building. */
function pickDoorForFootprint(
  city: CityState,
  map: GeneratedWorldMap,
  col: number,
  row: number,
  spanCol: number,
  spanRow: number,
  target: TileCoord,
  rule?: BuildingLayoutSpec,
): TileCoord | null {
  if (rule) {
    const door = ruleDoorTile(col, row, spanCol, spanRow, rule);
    return canWalkRoad(city, map, door.col, door.row, false) ? door : null;
  }
  const candidates: TileCoord[] = [];
  for (let r = row; r < row + spanRow; r++) candidates.push({ col: col + spanCol, row: r });
  for (let c = col; c < col + spanCol; c++) candidates.push({ col: c, row: row + spanRow });

  let best: TileCoord | null = null;
  let bestScore = Infinity;
  for (const cand of candidates) {
    if (!canWalkRoad(city, map, cand.col, cand.row, false)) continue;
    const k = tileKey(cand.col, cand.row);
    const alreadyRoad = city.roads.has(k);
    const insideOtherLot = !alreadyRoad && city.lotReservation.has(k);
    const d = Math.abs(cand.col - target.col) + Math.abs(cand.row - target.row);
    const score = (insideOtherLot ? 80 : 0) + (alreadyRoad ? -100 : 0) + d;
    if (score < bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  return best;
}

/* Whether a door tile sits in front of one of the building's two front walls. */
export function isDoorOnFrontWall(b: Pick<CityBuilding, 'col' | 'row' | 'spanCol' | 'spanRow' | 'door'>): boolean {
  const { col, row } = b.door;
  if (col === b.col + b.spanCol && row >= b.row && row < b.row + b.spanRow) return true;
  return row === b.row + b.spanRow && col >= b.col && col < b.col + b.spanCol;
}

/* Grows a building toward the back to spanCol x spanRow, keeping its front corner; false when the tiles are taken. */
function growBackward(city: CityState, map: GeneratedWorldMap, b: CityBuilding, spanCol: number, spanRow: number): boolean {
  const col = b.col + b.spanCol - spanCol;
  const row = b.row + b.spanRow - spanRow;
  if (!canPlaceFootprint(city, map, col, row, spanCol, spanRow, b.id, false)) return false;
  /* The door stands in front of a front wall, outside every footprint this growth can reach. */
  b.col = col;
  b.row = row;
  b.spanCol = spanCol;
  b.spanRow = spanRow;
  stampBuildingOccupancy(city, map, b);
  return true;
}

type HeapNode = {
  col: number;
  row: number;
  g: number;
  f: number;
  dirIdx: number;
};

class MinHeap {
  private readonly items: HeapNode[] = [];

  get size(): number {
    return this.items.length;
  }

  push(node: HeapNode): void {
    this.items.push(node);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.items[p]!.f <= this.items[i]!.f) break;
      const tmp = this.items[p]!;
      this.items[p] = this.items[i]!;
      this.items[i] = tmp;
      i = p;
    }
  }

  pop(): HeapNode | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0]!;
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      const len = this.items.length;
      while (true) {
        let smallest = i;
        const l = i * 2 + 1;
        const r = l + 1;
        if (l < len && this.items[l]!.f < this.items[smallest]!.f) smallest = l;
        if (r < len && this.items[r]!.f < this.items[smallest]!.f) smallest = r;
        if (smallest === i) break;
        const tmp = this.items[i]!;
        this.items[i] = this.items[smallest]!;
        this.items[smallest] = tmp;
        i = smallest;
      }
    }
    return top;
  }
}

function computeMainRoadComponent(city: CityState): Set<string> {
  const res = city.buildings.find(b => b.kind === 'residence') ?? city.buildings[0];
  const reachable = new Set<string>();
  if (!res) return reachable;
  const startKey = tileKey(res.door.col, res.door.row);
  if (!city.roads.has(startKey)) return reachable;
  const queue: string[] = [startKey];
  reachable.add(startKey);
  let head = 0;
  while (head < queue.length) {
    const ck = queue[head++]!;
    const cur = parseTileKey(ck);
    for (const [dx, dy] of CARDINAL_DIRS) {
      const nk = tileKey(cur.col + dx, cur.row + dy);
      if (!reachable.has(nk) && city.roads.has(nk)) {
        reachable.add(nk);
        queue.push(nk);
      }
    }
  }
  return reachable;
}

function findNearestRoadTile(city: CityState, from: TileCoord, allowedSet?: ReadonlySet<string>): TileCoord {
  if (city.roads.size === 0) return city.center;
  let best = city.center;
  let bestDist = Infinity;
  for (const [k, road] of city.roads) {
    if (allowedSet && !allowedSet.has(k)) continue;
    const d = Math.abs(road.col - from.col) + Math.abs(road.row - from.row);
    if (d < bestDist) {
      bestDist = d;
      best = { col: road.col, row: road.row };
      if (d <= 1) break;
    }
  }
  return best;
}

/* Bounded A* connecting `start` to either any tile in `targetRoads` or `goalHint`. */
function findRoadPath(
  city: CityState,
  map: GeneratedWorldMap,
  start: TileCoord,
  goalHint: TileCoord,
  options: {
    stopAtAnyRoad: boolean;
    targetRoads?: ReadonlySet<string>;
    allowBridge: boolean;
    avoidLots?: boolean;
    maxExpansions: number;
  },
): TileCoord[] | null {
  const startKey = tileKey(start.col, start.row);
  const isGoalRoad = (k: string): boolean =>
    options.targetRoads ? options.targetRoads.has(k) : city.roads.has(k);
  if (options.stopAtAnyRoad && isGoalRoad(startKey)) {
    return [start];
  }

  const order = city.orderChaos;
  const turnPenalty = 0.08 + order * 1.45;
  const noiseWeight = (1 - order) * 1.65;
  const pathSeed = (map.numericSeed ^ (city.stepCounter * 2654435761)) >>> 0;
  const rx = city.center.col;
  const ry = city.center.row;

  const open = new MinHeap();
  const gScore = new Map<string, number>();
  const parent = new Map<string, string>();
  const closed = new Set<string>();

  gScore.set(startKey, 0);
  open.push({
    col: start.col,
    row: start.row,
    g: 0,
    f: Math.abs(start.col - goalHint.col) + Math.abs(start.row - goalHint.row),
    dirIdx: -1,
  });

  let expansions = 0;
  let goalKey: string | null = null;

  while (open.size > 0 && expansions < options.maxExpansions) {
    const cur = open.pop()!;
    const ck = tileKey(cur.col, cur.row);
    if (closed.has(ck)) continue;
    closed.add(ck);
    expansions++;

    if (options.stopAtAnyRoad && ck !== startKey && isGoalRoad(ck)) {
      goalKey = ck;
      break;
    }
    if (!options.stopAtAnyRoad && cur.col === goalHint.col && cur.row === goalHint.row) {
      goalKey = ck;
      break;
    }

    for (let dIdx = 0; dIdx < 4; dIdx++) {
      const [dx, dy] = CARDINAL_DIRS[dIdx]!;
      const nc = cur.col + dx;
      const nr = cur.row + dy;
      const nk = tileKey(nc, nr);
      if (closed.has(nk)) continue;

      const isExistingRoad = city.roads.has(nk);
      if (!canStepTo(city, map, cur, { col: nc, row: nr }, isExistingRoad, options.allowBridge)) continue;
      if (!isExistingRoad && options.avoidLots && city.lotReservation.has(nk)) continue;

      const spec = map.kindSpecAt(nc, nr);
      let stepCost = 1.0;
      if (isExistingRoad) {
        stepCost = 0.25;
      } else if (spec?.liquid) {
        /* Bridges / arches across liquid are expensive and prefer straight crossings. */
        stepCost = 24 + (cur.dirIdx !== -1 && cur.dirIdx !== dIdx ? 18 : 0);
      } else {
        /* Excavating corridors through solid rock costs more than following open caverns. */
        if (spec && !spec.walkable && spec.excavatable) {
          stepCost = 2.2;
        }
        /* Strongly steer fallback roads around reserved building growth lots so homes can expand smoothly. */
        if (city.lotReservation.has(nk)) stepCost += 25;
        if (cur.dirIdx !== -1 && cur.dirIdx !== dIdx) stepCost += turnPenalty;
        if (order > 0.25) {
          const onGrid = (nc - rx) % GRID_BLOCK_STEP === 0 || (nr - ry) % GRID_BLOCK_STEP === 0;
          stepCost *= onGrid ? 1 - 0.52 * order : 1 + 0.18 * order;
        }
        if (noiseWeight > 0.05) {
          stepCost += hash2i(nc, nr, pathSeed) * noiseWeight;
        }
      }

      const ng = cur.g + stepCost;
      const prevG = gScore.get(nk);
      if (prevG === undefined || ng < prevG) {
        gScore.set(nk, ng);
        parent.set(nk, ck);
        const h = (Math.abs(nc - goalHint.col) + Math.abs(nr - goalHint.row)) * (options.stopAtAnyRoad ? 0.65 : 1.0);
        open.push({ col: nc, row: nr, g: ng, f: ng + h, dirIdx: dIdx });
      }
    }
  }

  if (!goalKey) return null;
  const path: TileCoord[] = [];
  let curKey: string | undefined = goalKey;
  while (curKey) {
    path.push(parseTileKey(curKey));
    if (curKey === startKey) break;
    curKey = parent.get(curKey);
  }
  path.reverse();
  return path;
}

function connectDoorToRoads(
  city: CityState,
  map: GeneratedWorldMap,
  door: TileCoord,
  trafficDelta = 2,
  targetRoads?: ReadonlySet<string>,
): boolean {
  const nearest = findNearestRoadTile(city, door, targetRoads);
  let path = findRoadPath(city, map, door, nearest, {
    stopAtAnyRoad: true,
    targetRoads,
    allowBridge: false,
    avoidLots: true,
    maxExpansions: 3200,
  });
  if (!path) {
    path = findRoadPath(city, map, door, nearest, {
      stopAtAnyRoad: true,
      targetRoads,
      allowBridge: true,
      avoidLots: true,
      maxExpansions: 8000,
    });
  }
  if (!path) {
    path = findRoadPath(city, map, door, nearest, {
      stopAtAnyRoad: true,
      targetRoads,
      allowBridge: true,
      avoidLots: false,
      maxExpansions: 10000,
    });
  }
  if (!path) return false;
  for (const pt of path) {
    setRoadTile(city, map, pt.col, pt.row, { trafficDelta });
  }
  return true;
}

/* A water tile is open to a street only on the city's bridge, and only where the search allows bridges (#1985). */
function waterOpen(city: CityState, allowBridge: boolean, col: number, row: number): boolean {
  return allowBridge && onBridge(city.bridge ?? null, col, row);
}

/* A road search may step from one tile to the next: onto or off the bridge only at its ends, and onto a tile that is
   a road already or one a road may be laid on. */
function canStepTo(city: CityState, map: GeneratedWorldMap, from: TileCoord, to: TileCoord, isExistingRoad: boolean, allowBridge: boolean): boolean {
  if (!bridgeStepAllowed(city.bridge ?? null, from, to)) return false;
  return isExistingRoad || canWalkRoad(city, map, to.col, to.row, allowBridge);
}

const bridgeOption = (options?: { bridge?: BridgeSite | null }): BridgeSite | null => options?.bridge ?? null;

/* Lays the street over the city's bridge, its two bank tiles included, unless a building stands on any of it; the
   stitching that follows joins it to the streets. */
function layBridge(city: CityState, map: GeneratedWorldMap): void {
  if (!city.bridge) return;
  const tiles = [...bridgeEnds(city.bridge), ...bridgeTiles(city.bridge)];
  if (tiles.some(t => city.footprintOccupant.has(tileKey(t.col, t.row)))) return;
  for (const t of tiles) setRoadTile(city, map, t.col, t.row, { trafficDelta: 4, minTier: 'dirt' });
}

/* Puts the bridge rule on a city built or saved before it, or under other art (#1985): a street on water stays only
   where the bridge is, and with a bridge its street is laid and joined to the others. The same city is returned. */
export function applyBridgeRule(city: CityState, map: GeneratedWorldMap, bridge: BridgeSite | null): CityState {
  city.bridge = bridge;
  for (const [k, road] of city.roads) {
    if (map.isLiquid(road.col, road.row) && !onBridge(bridge, road.col, road.row)) city.roads.delete(k);
  }
  if (bridge && bridgeTiles(bridge).some(t => !city.roads.has(tileKey(t.col, t.row)))) {
    layBridge(city, map);
    stitchDisconnectedRoadArcs(city, map);
  }
  city.metrics.bridgeTiles = [...city.roads.values()].filter(road => road.bridge).length;
  return city;
}

/* Each map's bridge site, worked out once. */
const mapBridges = new WeakMap<GeneratedWorldMap, BridgeSite | null>();
function bridgeOfMap(map: GeneratedWorldMap): BridgeSite | null {
  if (!mapBridges.has(map)) mapBridges.set(map, bridgeSite(map));
  return mapBridges.get(map)!;
}

/* The shown city keeps the map's bridge while the pack's bridge pictures are all there, and has none before they are
   or after they go (#1985): the street over it is laid or taken away only when that changes. */
export function keepMapBridge(state: Readonly<{ city: CityState }> | null, map: GeneratedWorldMap | undefined, bridgeArt: boolean): void {
  if (!state || !map) return;
  const site = bridgeArt ? bridgeOfMap(map) : null;
  if (!sameBridge(state.city.bridge, site)) applyBridgeRule(state.city, map, site);
}

/* Reconnects any disconnected road arcs (e.g. liquid-split converted old wall segments) into the main network. */
function stitchDisconnectedRoadArcs(city: CityState, map: GeneratedWorldMap): void {
  const doorKeys = new Set(city.buildings.map(b => tileKey(b.door.col, b.door.row)));
  for (let pass = 0; pass < 40; pass++) {
    const main = computeMainRoadComponent(city);
    if (main.size === city.roads.size) return;

    let bestStray: TileCoord | null = null;
    let bestDist = Infinity;
    for (const [k, road] of city.roads) {
      if (main.has(k)) continue;
      const d = Math.abs(road.col - city.center.col) + Math.abs(road.row - city.center.row);
      if (d < bestDist) {
        bestDist = d;
        bestStray = { col: road.col, row: road.row };
      }
    }
    if (!bestStray) return;
    const connected = connectDoorToRoads(city, map, bestStray, 6, main);
    if (!connected) {
      const stale: string[] = [];
      for (const k of city.roads.keys()) {
        if (!main.has(k) && !doorKeys.has(k)) stale.push(k);
      }
      for (const k of stale) city.roads.delete(k);
      return;
    }
  }
}

/* Finds the closest walkable/usable tile directly adjacent to liquid (shoreline or liquid bank). */
function findNearestLiquidShoreTile(map: GeneratedWorldMap, from: TileCoord, maxSearch = 36): TileCoord {
  let best = from;
  let bestDist = Infinity;
  for (let dy = -maxSearch; dy <= maxSearch; dy++) {
    for (let dx = -maxSearch; dx <= maxSearch; dx++) {
      const c = from.col + dx;
      const r = from.row + dy;
      const spec = map.kindSpecAt(c, r);
      if (!spec || spec.liquid || (!spec.walkable && !spec.excavatable)) continue;
      const adjLiquid =
        map.isLiquid(c + 1, r) ||
        map.isLiquid(c - 1, r) ||
        map.isLiquid(c, r + 1) ||
        map.isLiquid(c, r - 1);
      if (!adjLiquid) continue;
      const d = Math.hypot(dx, dy);
      if (d < bestDist) {
        bestDist = d;
        best = { col: c, row: r };
      }
    }
  }
  return best;
}

function nearestLiquidDistance(map: GeneratedWorldMap, col: number, row: number, maxSearch = 10): number {
  let best = Infinity;
  for (let dy = -maxSearch; dy <= maxSearch; dy++) {
    for (let dx = -maxSearch; dx <= maxSearch; dx++) {
      if (map.isLiquid(col + dx, row + dy)) {
        const d = Math.hypot(dx, dy);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

/* Recomputes city road straightness and grid alignment metrics (verifies Order vs Chaos knob). */
export function refreshCityMetrics(city: CityState): void {
  let interiorRoads = 0;
  let straightTiles = 0;
  let gridAlignedBuildings = 0;
  const rx = city.center.col;
  const ry = city.center.row;

  for (const road of city.roads.values()) {
    const n = city.roads.has(tileKey(road.col, road.row - 1));
    const s = city.roads.has(tileKey(road.col, road.row + 1));
    const e = city.roads.has(tileKey(road.col + 1, road.row));
    const w = city.roads.has(tileKey(road.col - 1, road.row));
    const deg = (n ? 1 : 0) + (s ? 1 : 0) + (e ? 1 : 0) + (w ? 1 : 0);
    if (deg < 2) continue;
    interiorRoads++;
    if ((n && s) || (e && w)) {
      straightTiles++;
    }
  }

  for (const b of city.buildings) {
    if (b.kind === 'residence') continue;
    const modX = (((b.col - rx) % GRID_BLOCK_STEP) + GRID_BLOCK_STEP) % GRID_BLOCK_STEP;
    const modY = (((b.row - ry) % GRID_BLOCK_STEP) + GRID_BLOCK_STEP) % GRID_BLOCK_STEP;
    if (modX === 1 || modY === 1 || modX === 5 || modY === 5) {
      gridAlignedBuildings++;
    }
  }

  const nonRes = Math.max(1, city.buildings.length - 1);
  city.metrics.roadStraightness = interiorRoads > 0 ? straightTiles / interiorRoads : 1;
  city.metrics.gridAlignmentRatio = gridAlignedBuildings / nonRes;
  city.metrics.excavatedCount = city.excavatedTiles.size;
}

/* Creates a new city centered on the generated map's startCenter, with initial residence and starter avenue. */
export function createCity(
  map: GeneratedWorldMap,
  options?: { orderChaos?: number; outerWallMode?: OuterWallMode; buildingLayout?: BuildingLayoutRules; bridge?: BridgeSite | null },
): CityState {
  const orderChaos = Math.max(0, Math.min(1, options?.orderChaos ?? 0.5));
  const outerWallMode: OuterWallMode = options?.outerWallMode ?? 'ring';
  const rng = createRng((map.numericSeed ^ Math.round(orderChaos * 10007)) >>> 0);
  const city: CityState = {
    packId: map.packId,
    seed: map.seed,
    baseSize: map.baseSize,
    orderChaos,
    outerWallMode,
    center: { col: map.startCenter.col, row: map.startCenter.row },
    bridge: bridgeOption(options),
    stepCounter: 0,
    wallGeneration: 0,
    wallHull: null,
    buildings: [],
    roads: new Map(),
    wallTiles: new Set(),
    excavatedTiles: new Set(),
    relocations: [],
    vacatedLots: [],
    footprintOccupant: new Map(),
    lotReservation: new Map(),
    metrics: {
      roadStraightness: 1,
      gridAlignmentRatio: 1,
      densifiedUpgrades: 0,
      mergedBuildings: 0,
      oldWallRoadsCreated: 0,
      bridgeTiles: 0,
      excavatedCount: 0,
    },
    rngState: Math.floor(rng() * 0xffffffff) >>> 0,
    buildingLayout: options?.buildingLayout ?? {},
  };

  /* Place the ruler's residence right on startCenter with a clear reserved royal growth lot behind it. */
  const rules = city.buildingLayout;
  const spec = defaultFootprint('residence', 0, 0, rules);
  const fits = (col: number, row: number, fullLot: boolean): boolean => {
    const lot = fullLot ? lotBehind(col, row, spec.spanCol, spec.spanRow, spec.lotSpanCol, spec.lotSpanRow) : null;
    return lot
      ? canPlaceFootprint(city, map, lot.col, lot.row, lot.spanCol, lot.spanRow, undefined, false)
      : canPlaceFootprint(city, map, col, row, spec.spanCol, spec.spanRow, undefined, false);
  };
  let resCol = map.startCenter.col - 1;
  let resRow = map.startCenter.row - 1;
  if (!fits(resCol, resRow, true)) {
    let found = false;
    for (const fullLot of [true, false]) {
      if (found) break;
      for (let rad = 0; rad <= 10 && !found; rad++) {
        for (let dr = -rad; dr <= rad && !found; dr++) {
          for (let dc = -rad; dc <= rad && !found; dc++) {
            if (fits(map.startCenter.col + dc, map.startCenter.row + dr, fullLot)) {
              resCol = map.startCenter.col + dc;
              resRow = map.startCenter.row + dr;
              found = true;
            }
          }
        }
      }
    }
  }

  const resLot = lotBehind(resCol, resRow, spec.spanCol, spec.spanRow, spec.lotSpanCol, spec.lotSpanRow);
  const shore = findNearestLiquidShoreTile(map, { col: resCol, row: resRow }, 32);
  const door =
    pickDoorForFootprint(city, map, resCol, resRow, spec.spanCol, spec.spanRow, shore, rules.residence) ?? {
      col: resCol,
      row: resRow + spec.spanRow,
    };

  const residence: CityBuilding = {
    id: 'residence-main',
    kind: 'residence',
    label: 'Ruler Residence',
    col: resCol,
    row: resRow,
    spanCol: spec.spanCol,
    spanRow: spec.spanRow,
    lot: resLot,
    door,
    stage: 1,
    maxStage: spec.maxStage,
    floors: 1,
    level: 1,
    residentIds: [],
    mergedFromIds: [],
    goalCount: 0,
    placedAtStep: ++city.stepCounter,
  };

  city.buildings.push(residence);
  stampBuildingOccupancy(city, map, residence);
  setRoadTile(city, map, door.col, door.row, {
    trafficDelta: 20,
    grandAvenue: true,
    minTier: orderChaos >= 0.7 ? 'brick' : 'dirt',
  });

  /* Build the ceremonial avenue from the residence door toward the nearest liquid shoreline (when close). */
  const shoreDist = Math.hypot(shore.col - door.col, shore.row - door.row);
  if (shoreDist > 1 && shoreDist <= 26) {
    const shorePath = findRoadPath(city, map, door, shore, {
      stopAtAnyRoad: false,
      allowBridge: false,
      avoidLots: true,
      maxExpansions: 3200,
    });
    if (shorePath) {
      for (const pt of shorePath) {
        setRoadTile(city, map, pt.col, pt.row, {
          trafficDelta: 16,
          grandAvenue: true,
          minTier: orderChaos >= 0.7 ? 'brick' : 'dirt',
        });
      }
    }
  }

  /* High order lays out straight starter cross-avenues around the central square. */
  if (orderChaos >= 0.65) {
    const armLen = Math.round(12 + 12 * orderChaos);
    for (const [dx, dy] of CARDINAL_DIRS) {
      for (let step = 1; step <= armLen; step++) {
        const c = door.col + dx * step;
        const r = door.row + dy * step;
        if (!canWalkRoad(city, map, c, r, false)) break;
        if (city.lotReservation.has(tileKey(c, r))) break;
        setRoadTile(city, map, c, r, { trafficDelta: 12, grandAvenue: step <= 12, minTier: 'dirt' });
      }
    }
    const parallelOffsets = [-GRID_BLOCK_STEP, GRID_BLOCK_STEP];
    for (const off of parallelOffsets) {
      if (city.roads.has(tileKey(door.col + off, door.row))) {
        for (const dir of [-1, 1] as const) {
          for (let step = 1; step <= GRID_BLOCK_STEP; step++) {
            const c1 = door.col + off;
            const r1 = door.row + dir * step;
            if (!canWalkRoad(city, map, c1, r1, false)) break;
            if (city.lotReservation.has(tileKey(c1, r1))) break;
            setRoadTile(city, map, c1, r1, { trafficDelta: 4, minTier: 'trail' });
          }
        }
      }
      if (city.roads.has(tileKey(door.col, door.row + off))) {
        for (const dir of [-1, 1] as const) {
          for (let step = 1; step <= GRID_BLOCK_STEP; step++) {
            const c2 = door.col + dir * step;
            const r2 = door.row + off;
            if (!canWalkRoad(city, map, c2, r2, false)) break;
            if (city.lotReservation.has(tileKey(c2, r2))) break;
            setRoadTile(city, map, c2, r2, { trafficDelta: 4, minTier: 'trail' });
          }
        }
      }
    }
  }

  layBridge(city, map);
  stitchDisconnectedRoadArcs(city, map);
  bindCityMap(city, map);
  refreshCityMetrics(city);
  return city;
}

function distanceToNearestRoad(city: CityState, col: number, row: number, spanCol: number, spanRow: number): number {
  let best = Infinity;
  const cx = col + spanCol / 2;
  const cy = row + spanRow / 2;
  for (const r of city.roads.values()) {
    const d = Math.abs(r.col - cx) + Math.abs(r.row - cy);
    if (d < best) {
      best = d;
      if (d <= 2) break;
    }
  }
  return best;
}

function chooseRoleAnchor(city: CityState, map: GeneratedWorldMap, req: PlaceBuildingRequest): TileCoord {
  const res = city.buildings[0]!;
  if (req.kind === 'monument') {
    const existing = city.buildings.filter(b => b.kind === 'monument');
    if (existing.length === 0) return { col: res.col, row: res.row };
    const angle = (existing.length * 2.399963) % (Math.PI * 2);
    const radius = 12 + Math.sqrt(existing.length) * 6.5;
    return {
      col: Math.round(res.col + Math.cos(angle) * radius),
      row: Math.round(res.row + Math.sin(angle) * radius),
    };
  }
  if (req.kind === 'department') {
    return { col: res.door.col, row: res.door.row };
  }
  if (req.kind === 'supply') {
    return findNearestLiquidShoreTile(map, { col: res.col, row: res.row }, 40);
  }
  if (req.kind === 'district_hub') {
    const hubs = city.buildings.filter(b => b.kind === 'district_hub');
    const angle = (hubs.length * Math.PI * 2) / 6 + 0.35;
    const dist = 20 + hubs.length * 4;
    return {
      col: Math.round(res.col + Math.cos(angle) * dist),
      row: Math.round(res.row + Math.sin(angle) * dist),
    };
  }
  if (req.kind === 'flophouse' && req.districtId) {
    const hub = city.buildings.find(b => b.kind === 'district_hub' && b.districtId === req.districtId);
    if (hub) {
      const dx = hub.col - res.col;
      const dy = hub.row - res.row;
      const len = Math.max(1, Math.hypot(dx, dy));
      return {
        col: Math.round(hub.col + (dx / len) * 14),
        row: Math.round(hub.row + (dy / len) * 14),
      };
    }
  }
  if (req.kind === 'statue' && req.departmentId) {
    const dept = city.buildings.find(b => b.kind === 'department' && b.departmentId === req.departmentId);
    if (dept) return { col: dept.door.col, row: dept.door.row };
  }
  if (req.kind === 'house' && req.districtId) {
    const hub = city.buildings.find(b => b.kind === 'district_hub' && b.districtId === req.districtId);
    const districtHouses = city.buildings.filter(b => b.kind === 'house' && b.districtId === req.districtId);
    if (hub && districtHouses.length === 0) return { col: hub.col, row: hub.row };
    if (hub && districtHouses.length > 0) {
      /* Anchor near the centroid of the district hub and most recent neighbor house so neighborhoods grow smoothly outward. */
      const latest = districtHouses[districtHouses.length - 1]!;
      return {
        col: Math.round(hub.col * 0.65 + latest.col * 0.35),
        row: Math.round(hub.row * 0.65 + latest.row * 0.35),
      };
    }
  }
  return { col: res.col, row: res.row };
}

/* Places a new building near its role anchor using real 1x1..6x6 standard footprints, reserving a
   growth lot and connecting its door to the nearest street by A*. */
export function placeBuilding(
  city: CityState,
  req: PlaceBuildingRequest,
  mapRef?: GeneratedWorldMap,
): CityBuilding | null {
  const map = mapRef ?? (city as CityState & { _map?: GeneratedWorldMap })._map;
  if (!map) throw new Error('CityState is not bound to a GeneratedWorldMap');

  const indexOfKind = city.buildings.filter(b => b.kind === req.kind).length;
  const deptStatueIndex =
    req.kind === 'statue' && req.departmentId
      ? city.buildings.filter(b => b.kind === 'statue' && b.departmentId === req.departmentId).length
      : 0;
  const rule = city.buildingLayout[req.kind];
  const spec = defaultFootprint(req.kind, indexOfKind, deptStatueIndex, city.buildingLayout);
  const spanCol = req.spanCol ?? spec.spanCol;
  const spanRow = req.spanRow ?? spec.spanRow;
  const desiredLotC = req.lotSpanCol ?? Math.max(spanCol, spec.lotSpanCol);
  const desiredLotR = req.lotSpanRow ?? Math.max(spanRow, spec.lotSpanRow);

  const anchor = chooseRoleAnchor(city, map, req);
  const order = city.orderChaos;
  const rx = city.center.col;
  const ry = city.center.row;
  const res = city.buildings[0]!;

  /* Progressive search rings around the role anchor so nothing ever jumps to the far edge of the map. */
  const rings = req.kind === 'supply' ? [18, 36, 58] : [12, 24, 40, 58, 76];
  const dept = req.departmentId
    ? city.buildings.find(b => b.kind === 'department' && b.departmentId === req.departmentId)
    : undefined;
  const districtHub = req.districtId
    ? city.buildings.find(b => b.kind === 'district_hub' && b.districtId === req.districtId)
    : undefined;

  const passes: readonly { respectLots: boolean; requireFullLot: boolean }[] = [
    { respectLots: true, requireFullLot: true },
    { respectLots: true, requireFullLot: false },
    { respectLots: false, requireFullLot: false },
  ];

  for (const { respectLots, requireFullLot } of passes) {
    for (const radius of rings) {
      let best: { col: number; row: number; door: TileCoord; lot: LotRect; score: number } | null = null;
      const step = radius <= 18 ? 1 : radius <= 40 ? 2 : 3;

      for (let dr = -radius; dr <= radius; dr += step) {
        for (let dc = -radius; dc <= radius; dc += step) {
          const col = anchor.col + dc;
          const row = anchor.row + dr;
          if (requireFullLot) {
            const full = lotBehind(col, row, spanCol, spanRow, desiredLotC, desiredLotR);
            if (!canPlaceFootprint(city, map, full.col, full.row, desiredLotC, desiredLotR, undefined, true)) continue;
          } else {
            if (!canPlaceFootprint(city, map, col, row, spanCol, spanRow, undefined, respectLots)) continue;
          }

          /* Supplies must stand close to liquid (flowing waterway or subterranean liquid channel). */
          let liquidDist = 0;
          if (req.kind === 'supply') {
            liquidDist = nearestLiquidDistance(map, col + Math.floor(spanCol / 2), row + Math.floor(spanRow / 2), 8);
            if (liquidDist > 7.5) continue;
          }

          const roadDist = distanceToNearestRoad(city, col, row, spanCol, spanRow);
          /* Keep new buildings anchored to the existing city frontier. */
          if (req.kind !== 'district_hub' && req.kind !== 'supply' && roadDist > 22 + radius * 0.45) continue;

          /* Reserve the full growth lot behind the building when clear, or shrink it from the back when tight. */
          let lotC = desiredLotC;
          let lotR = desiredLotR;
          if (!requireFullLot && (lotC > spanCol || lotR > spanRow)) {
            const fitsLot = (c: number, r: number): boolean => {
              const back = lotBehind(col, row, spanCol, spanRow, c, r);
              return canPlaceFootprint(city, map, back.col, back.row, c, r, undefined, true);
            };
            while ((lotC > spanCol || lotR > spanRow) && !fitsLot(lotC, lotR)) {
              if (lotC > spanCol) lotC--;
              if (lotR > spanRow) lotR--;
            }
          }
          const lot = lotBehind(col, row, spanCol, spanRow, lotC, lotR);

          const nearestRoad = findNearestRoadTile(city, { col, row });
          const door = pickDoorForFootprint(city, map, col, row, spanCol, spanRow, nearestRoad, rule);
          if (!door) continue;

          const distAnchor = Math.hypot(col - anchor.col, row - anchor.row);
          const distCenter = Math.hypot(col - res.col, row - res.row);

          let score = -distAnchor * 1.35 - roadDist * 0.8;
          /* Reward sites where the full growth lot fits cleanly! */
          if (lotC === desiredLotC && lotR === desiredLotR) score += 3.0;

          if (req.kind === 'department') {
            const nearGrand = CARDINAL_DIRS.some(([dx, dy]) => city.roads.get(tileKey(door.col + dx, door.row + dy))?.grandAvenue);
            score += (nearGrand ? 8 : 0) - distCenter * 0.7;
          } else if (req.kind === 'monument') {
            score -= distCenter * 0.9;
          } else if (req.kind === 'supply') {
            score -= liquidDist * 2.5 + distCenter * 0.28;
          } else if (req.kind === 'statue') {
            const roadAdj = city.roads.has(tileKey(door.col, door.row)) || roadDist <= 2;
            const dDept = dept ? Math.hypot(col - dept.col, row - dept.row) : distCenter;
            score += (roadAdj ? 12 : -6) - dDept * 0.85;
          } else if (req.kind === 'house' && districtHub) {
            const dHub = Math.hypot(col - districtHub.col, row - districtHub.row);
            score -= dHub * 1.05;
            if (order < 0.5) {
              const adjSameDistrict = city.buildings.some(
                b => b.districtId === req.districtId && Math.hypot(b.col - col, b.row - row) <= 6.5,
              );
              if (adjSameDistrict) score += 3.5 * (1 - order);
            }
          }

          /* Order/Chaos knob: high order snaps buildings neatly into block grid lots; low order adds organic scatter. */
          if (order > 0.1) {
            const modX = (((col - rx) % GRID_BLOCK_STEP) + GRID_BLOCK_STEP) % GRID_BLOCK_STEP;
            const modY = (((row - ry) % GRID_BLOCK_STEP) + GRID_BLOCK_STEP) % GRID_BLOCK_STEP;
            const aligned = modX === 1 || modY === 1 || modX === 5 || modY === 5;
            score += (aligned ? 5.2 : -2.4) * order;
          }
          if (order < 0.95) {
            score += (nextRand(city) - 0.5) * 7.5 * (1 - order);
          }

          if (city.wallHull && isInsideHull(city.wallHull, col, row, 1)) {
            score += 2.0;
          }

          if (!best || score > best.score) {
            best = { col, row, door, lot, score };
          }
        }
      }

      if (best) {
        const building: CityBuilding = {
          id: req.id,
          kind: req.kind,
          label: req.label ?? req.id,
          col: best.col,
          row: best.row,
          spanCol,
          spanRow,
          lot: best.lot,
          door: best.door,
          districtId: req.districtId,
          departmentId: req.departmentId,
          stage: req.stage ?? 1,
          maxStage: spec.maxStage,
          floors: 1,
          level: req.level ?? 1,
          residentIds: req.residentIds ? [...req.residentIds] : req.kind === 'house' ? [req.id] : [],
          mergedFromIds: [],
          goalCount: req.kind === 'monument' ? 1 : 0,
          placedAtStep: ++city.stepCounter,
        };

        stampBuildingOccupancy(city, map, building);
        const connected = connectDoorToRoads(city, map, best.door, req.kind === 'department' ? 8 : 2);
        if (!connected) {
          clearBuildingOccupancy(city, building);
          continue;
        }

        city.buildings.push(building);
        refreshCityMetrics(city);
        return building;
      }
    }
  }

  return null;
}

/* Grows a building's footprint smoothly backward inside its reserved lot as its level or stage rises.
   Its front corner (col + spanCol, row + spanRow) and its door NEVER move (zero coordinate jumps). */
export function growBuildingForProgress(
  city: CityState,
  map: GeneratedWorldMap,
  b: CityBuilding,
): boolean {
  const target = targetSpanForProgress(b.kind, b.level, b.stage, b.lot, city.buildingLayout);
  if (target.spanCol <= b.spanCol && target.spanRow <= b.spanRow) return false;

  let expanded = false;
  while (b.spanCol < target.spanCol || b.spanRow < target.spanRow) {
    const nextC = Math.min(target.spanCol, b.spanCol + 1);
    const nextR = Math.min(target.spanRow, b.spanRow + 1);
    if (!growBackward(city, map, b, nextC, nextR)) break;
    expanded = true;
  }
  return expanded;
}

/* Increments street traffic along the road network between two door tiles (upgrades trail -> dirt -> brick -> stone). */
export function recordTrafficRoute(
  city: CityState,
  fromDoor: TileCoord,
  toDoor: TileCoord,
  weight = 1,
): number {
  const startKey = tileKey(fromDoor.col, fromDoor.row);
  const goalKey = tileKey(toDoor.col, toDoor.row);
  if (!city.roads.has(startKey) || !city.roads.has(goalKey)) return 0;

  const queue: string[] = [startKey];
  const parent = new Map<string, string>();
  parent.set(startKey, '');
  let head = 0;
  let found = false;

  while (head < queue.length && head < 3000) {
    const ck = queue[head++]!;
    if (ck === goalKey) {
      found = true;
      break;
    }
    const cur = parseTileKey(ck);
    for (const [dx, dy] of CARDINAL_DIRS) {
      const nk = tileKey(cur.col + dx, cur.row + dy);
      if (parent.has(nk) || !city.roads.has(nk)) continue;
      parent.set(nk, ck);
      queue.push(nk);
    }
  }

  if (!found) {
    const a = city.roads.get(startKey);
    const b = city.roads.get(goalKey);
    if (a) {
      a.traffic += weight;
      raiseRoadTier(a, roadTierForTraffic(a.traffic));
    }
    if (b) {
      b.traffic += weight;
      raiseRoadTier(b, roadTierForTraffic(b.traffic));
    }
    return 2;
  }

  let count = 0;
  let k: string | undefined = goalKey;
  while (k) {
    const road = city.roads.get(k);
    if (road) {
      road.traffic += weight;
      raiseRoadTier(road, roadTierForTraffic(road.traffic));
      count++;
    }
    const p = parent.get(k);
    k = p || undefined;
  }
  return count;
}

function computeOctagonalHull(buildings: readonly CityBuilding[], margin: number): WallHull {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minSum = Infinity;
  let maxSum = -Infinity;
  let minDiff = Infinity;
  let maxDiff = -Infinity;

  for (const b of buildings) {
    const corners: [number, number][] = [
      [b.col, b.row],
      [b.col + b.spanCol - 1, b.row],
      [b.col, b.row + b.spanRow - 1],
      [b.col + b.spanCol - 1, b.row + b.spanRow - 1],
    ];
    for (const [x, y] of corners) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x + y < minSum) minSum = x + y;
      if (x + y > maxSum) maxSum = x + y;
      if (x - y < minDiff) minDiff = x - y;
      if (x - y > maxDiff) maxDiff = x - y;
    }
  }

  const diagMargin = Math.round(margin * 1.4);
  return {
    minX: minX - margin,
    maxX: maxX + margin,
    minY: minY - margin,
    maxY: maxY + margin,
    minSum: minSum - diagMargin,
    maxSum: maxSum + diagMargin,
    minDiff: minDiff - diagMargin,
    maxDiff: maxDiff + diagMargin,
  };
}

function isInsideHull(hull: WallHull, c: number, r: number, inset = 0): boolean {
  const dInset = Math.round(inset * 1.4);
  return (
    c >= hull.minX + inset &&
    c <= hull.maxX - inset &&
    r >= hull.minY + inset &&
    r <= hull.maxY - inset &&
    c + r >= hull.minSum + dInset &&
    c + r <= hull.maxSum - dInset &&
    c - r >= hull.minDiff + dInset &&
    c - r <= hull.maxDiff - dInset
  );
}

/* Builds or expands the single outer city wall ring. When the city outgrows an old wall,
   the old wall ring converts into a connected boulevard street and a new wider outer wall rises. */
export function rebuildWallIfNeeded(city: CityState, map: GeneratedWorldMap, forceCheck = false): boolean {
  if (city.outerWallMode === 'none') return false;
  if (city.buildings.length < 12) return false;

  const needInitial = city.wallGeneration === 0;
  let needExpand = false;
  if (!needInitial && city.wallHull) {
    let outsideCount = 0;
    for (const b of city.buildings) {
      if (
        !isInsideHull(city.wallHull, b.col, b.row, 1) ||
        !isInsideHull(city.wallHull, b.col + b.spanCol - 1, b.row + b.spanRow - 1, 1)
      ) {
        outsideCount++;
      }
    }
    needExpand = outsideCount >= (forceCheck ? 1 : 10);
  }

  if (!needInitial && !needExpand) return false;

  /* Convert superseded old wall tiles into a ring boulevard street and stitch into the main road network. */
  if (city.wallTiles.size > 0) {
    let converted = 0;
    for (const key of city.wallTiles) {
      const pt = parseTileKey(key);
      if (canWalkRoad(city, map, pt.col, pt.row, false)) {
        setRoadTile(city, map, pt.col, pt.row, {
          trafficDelta: 22,
          wasOldWall: true,
          minTier: 'dirt',
        });
        converted++;
      }
    }
    city.metrics.oldWallRoadsCreated += converted;
    city.wallTiles.clear();
    stitchDisconnectedRoadArcs(city, map);
  }

  const margin = city.wallGeneration === 0 ? 7 : 9;
  const hull = computeOctagonalHull(city.buildings, margin);
  const clampedHull: WallHull = {
    minX: Math.max(map.bounds.minCol + 1, hull.minX),
    maxX: Math.min(map.bounds.maxCol - 2, hull.maxX),
    minY: Math.max(map.bounds.minRow + 1, hull.minY),
    maxY: Math.min(map.bounds.maxRow - 2, hull.maxY),
    minSum: hull.minSum,
    maxSum: hull.maxSum,
    minDiff: hull.minDiff,
    maxDiff: hull.maxDiff,
  };

  for (let r = clampedHull.minY; r <= clampedHull.maxY; r++) {
    for (let c = clampedHull.minX; c <= clampedHull.maxX; c++) {
      if (!isInsideHull(clampedHull, c, r, 0)) continue;
      const onEdge =
        !isInsideHull(clampedHull, c - 1, r, 0) ||
        !isInsideHull(clampedHull, c + 1, r, 0) ||
        !isInsideHull(clampedHull, c, r - 1, 0) ||
        !isInsideHull(clampedHull, c, r + 1, 0) ||
        !isInsideHull(clampedHull, c - 1, r - 1, 0) ||
        !isInsideHull(clampedHull, c + 1, r - 1, 0) ||
        !isInsideHull(clampedHull, c - 1, r + 1, 0) ||
        !isInsideHull(clampedHull, c + 1, r + 1, 0);
      if (!onEdge) continue;

      const spec = map.kindSpecAt(c, r);
      if (!spec || spec.liquid || (!spec.walkable && !spec.excavatable)) continue;
      const k = tileKey(c, r);
      if (city.footprintOccupant.has(k) || city.roads.has(k)) continue;
      city.wallTiles.add(k);
    }
  }

  city.wallHull = clampedHull;
  city.wallGeneration++;
  refreshCityMetrics(city);
  return true;
}

/* Urban densification: upgrades buildings in place (using reserved growth lots or vertical floors)
   and merges nearby small houses into larger multi-resident compounds when land tightens. */
export function densifyCity(
  city: CityState,
  map: GeneratedWorldMap,
  options?: { maxUpgrades?: number; maxMerges?: number },
): { upgraded: number; merged: number } {
  const maxUpgrades = options?.maxUpgrades ?? 3;
  const maxMerges = options?.maxMerges ?? 1;
  let upgraded = 0;
  let merged = 0;

  /* 1. In-place upgrades (expand into reserved growth lot or add vertical stories). */
  for (const b of city.buildings) {
    if (upgraded >= maxUpgrades) break;
    if (b.kind !== 'house' && b.kind !== 'department' && b.kind !== 'residence') continue;
    if (b.spanCol < b.lot.spanCol || b.spanRow < b.lot.spanRow) {
      const nextSpanC = Math.min(b.lot.spanCol, b.spanCol + 1);
      const nextSpanR = Math.min(b.lot.spanRow, b.spanRow + 1);
      if (growBackward(city, map, b, nextSpanC, nextSpanR)) {
        b.floors = Math.min(4, b.floors + 1);
        b.stage = Math.min(b.maxStage, b.stage + 1);
        city.metrics.densifiedUpgrades++;
        upgraded++;
        continue;
      }
    }
    if (b.floors < 4 && b.level >= b.floors * 4) {
      b.floors++;
      b.stage = Math.min(b.maxStage, b.stage + 1);
      city.metrics.densifiedUpgrades++;
      upgraded++;
    }
  }

  /* 2. Merge adjacent small single-resident houses of the same district into denser estates. */
  while (merged < maxMerges) {
    const smallHouses = city.buildings.filter(b => b.kind === 'house' && b.residentIds.length === 1);
    let pair: [CityBuilding, CityBuilding] | null = null;
    let bestDist = 11;
    for (let i = 0; i < smallHouses.length; i++) {
      const a = smallHouses[i]!;
      for (let j = i + 1; j < smallHouses.length; j++) {
        const b = smallHouses[j]!;
        if (a.districtId !== b.districtId) continue;
        const d = Math.hypot(a.col - b.col, a.row - b.row);
        if (d < bestDist) {
          bestDist = d;
          pair = [a, b];
        }
      }
    }
    if (!pair) break;

    const [primary, absorbed] = pair;
    primary.residentIds.push(...absorbed.residentIds);
    primary.mergedFromIds.push(absorbed.id, ...absorbed.mergedFromIds);
    primary.floors = Math.min(4, Math.max(primary.floors, absorbed.floors) + 1);
    primary.level = Math.max(primary.level, absorbed.level);
    primary.stage = Math.min(primary.maxStage, Math.max(primary.stage, absorbed.stage) + 1);
    growBuildingForProgress(city, map, primary);

    clearBuildingOccupancy(city, absorbed);
    city.buildings = city.buildings.filter(b => b.id !== absorbed.id);
    city.metrics.mergedBuildings++;
    merged++;
  }

  refreshCityMetrics(city);
  return { upgraded, merged };
}

/* Relocation by God's Word: creates a pending request without moving the building until the task is accepted. */
export function requestRelocation(
  city: CityState,
  buildingId: string,
  toCol: number,
  toRow: number,
  mapRef?: GeneratedWorldMap,
): CityRelocation | null {
  const map = mapRef ?? (city as CityState & { _map?: GeneratedWorldMap })._map;
  const building = city.buildings.find(b => b.id === buildingId);
  if (!building || !map) return null;
  if (!canPlaceFootprint(city, map, toCol, toRow, building.spanCol, building.spanRow, building.id, true)) {
    return null;
  }

  const rel: CityRelocation = {
    id: `reloc-${city.relocations.length + 1}`,
    buildingId,
    fromCol: building.col,
    fromRow: building.row,
    toCol,
    toRow,
    status: 'pending',
    phase: 'waiting_acceptance',
    oldStage: building.stage,
    newStage: 0,
    targetStage: Math.max(2, building.stage),
  };
  city.relocations.push(rel);
  return rel;
}

export function cancelRelocation(city: CityState, relocationId: string): boolean {
  const rel = city.relocations.find(r => r.id === relocationId);
  if (!rel || rel.status === 'completed') return false;
  rel.status = 'cancelled';
  return true;
}

export function acceptRelocation(city: CityState, relocationId: string): boolean {
  const rel = city.relocations.find(r => r.id === relocationId);
  if (!rel || rel.status !== 'pending') return false;
  rel.status = 'in_progress';
  rel.phase = 'dismantling';
  return true;
}

/* Steps a relocation through staged dismantling at the old site and staged construction at the new site,
   committing the new coordinates and connecting the new door to roads upon completion. */
export function advanceRelocationStep(
  city: CityState,
  map: GeneratedWorldMap,
  relocationId: string,
): CityRelocation | null {
  const rel = city.relocations.find(r => r.id === relocationId);
  if (!rel || rel.status !== 'in_progress') return rel ?? null;
  const building = city.buildings.find(b => b.id === rel.buildingId);
  if (!building) {
    rel.status = 'cancelled';
    return rel;
  }

  if (rel.phase === 'dismantling') {
    if (rel.oldStage > 0) rel.oldStage--;
    if (rel.oldStage === 0) rel.phase = 'building';
    return rel;
  }

  if (rel.phase === 'building') {
    if (rel.newStage < rel.targetStage) rel.newStage++;
    if (rel.newStage >= rel.targetStage) {
      const nextLot = lotBehind(
        rel.toCol,
        rel.toRow,
        building.spanCol,
        building.spanRow,
        Math.max(building.spanCol, building.lot.spanCol),
        Math.max(building.spanRow, building.lot.spanRow),
      );
      const nearestRoad = findNearestRoadTile(city, { col: rel.toCol, row: rel.toRow });
      const newDoor =
        pickDoorForFootprint(
          city,
          map,
          rel.toCol,
          rel.toRow,
          building.spanCol,
          building.spanRow,
          nearestRoad,
          city.buildingLayout[building.kind],
        ) ?? {
          col: rel.toCol,
          row: rel.toRow + building.spanRow,
        };
      clearBuildingOccupancy(city, building);
      building.col = rel.toCol;
      building.row = rel.toRow;
      building.lot = nextLot;
      building.door = newDoor;
      building.stage = rel.targetStage;
      stampBuildingOccupancy(city, map, building);
      connectDoorToRoads(city, map, newDoor, 2);
      rel.phase = 'done';
      rel.status = 'completed';
      refreshCityMetrics(city);
    }
  }
  return rel;
}

/* Computes exact, unpadded tile area telemetry for every building kind, reserved lots, roads,
   active outer wall, excavated rock and enclosed metropolitan area. */
export function computeCityTileBreakdown(city: CityState, map: GeneratedWorldMap): CityTileBreakdown {
  const byKindMut: Record<BuildingKind, { count: number; tiles: number }> = {
    residence: { count: 0, tiles: 0 },
    monument: { count: 0, tiles: 0 },
    department: { count: 0, tiles: 0 },
    district_hub: { count: 0, tiles: 0 },
    supply: { count: 0, tiles: 0 },
    house: { count: 0, tiles: 0 },
    statue: { count: 0, tiles: 0 },
    flophouse: { count: 0, tiles: 0 },
  };

  const footprintSet = new Set<string>();
  const activeUnion = new Set<string>();

  for (const b of city.buildings) {
    const area = b.spanCol * b.spanRow;
    byKindMut[b.kind].count++;
    byKindMut[b.kind].tiles += area;
    for (let r = b.row; r < b.row + b.spanRow; r++) {
      for (let c = b.col; c < b.col + b.spanCol; c++) {
        const k = tileKey(c, r);
        footprintSet.add(k);
        activeUnion.add(k);
      }
    }
  }

  let reservedLotTiles = 0;
  for (const k of city.lotReservation.keys()) {
    if (!footprintSet.has(k) && !city.roads.has(k)) {
      reservedLotTiles++;
      activeUnion.add(k);
    }
  }

  for (const k of city.roads.keys()) activeUnion.add(k);
  for (const k of city.wallTiles) activeUnion.add(k);

  const mapTotalTiles = map.baseSize * map.baseSize;
  let mapUsableTiles = 0;
  let enclosedHullTiles = 0;
  for (let r = 0; r < map.baseSize; r++) {
    for (let c = 0; c < map.baseSize; c++) {
      if (isTerrainCityUsable(map, c, r)) mapUsableTiles++;
      if (city.wallHull && isInsideHull(city.wallHull, c, r, 0)) enclosedHullTiles++;
    }
  }

  return {
    byKind: byKindMut,
    buildingsTotalTiles: footprintSet.size,
    reservedLotTiles,
    roadsTotalTiles: city.roads.size,
    wallTiles: city.wallTiles.size,
    excavatedTiles: city.excavatedTiles.size,
    activeCityTiles: activeUnion.size,
    enclosedHullTiles,
    mapTotalTiles,
    mapUsableTiles,
    activeShareOfMap: activeUnion.size / Math.max(1, mapTotalTiles),
    activeShareOfUsable: activeUnion.size / Math.max(1, mapUsableTiles),
    enclosedShareOfMap: enclosedHullTiles / Math.max(1, mapTotalTiles),
    enclosedShareOfUsable: enclosedHullTiles / Math.max(1, mapUsableTiles),
  };
}

export function serializeCityLayout(city: CityState): CityLayoutSnapshot {
  return {
    version: 3,
    packId: city.packId,
    seed: city.seed,
    baseSize: city.baseSize,
    orderChaos: city.orderChaos,
    outerWallMode: city.outerWallMode,
    center: { ...city.center },
    stepCounter: city.stepCounter,
    wallGeneration: city.wallGeneration,
    wallHull: city.wallHull ? { ...city.wallHull } : null,
    buildings: city.buildings.map(b => ({
      ...b,
      lot: { ...b.lot },
      door: { ...b.door },
      residentIds: [...b.residentIds],
      mergedFromIds: [...b.mergedFromIds],
    })),
    roads: [...city.roads.values()].map(r => ({ ...r })),
    wallTiles: [...city.wallTiles],
    excavatedTiles: [...city.excavatedTiles],
    relocations: city.relocations.map(r => ({ ...r })),
    metrics: { ...city.metrics },
    rngState: city.rngState,
  };
}

export function deserializeCityLayout(
  snapshot: CityLayoutSnapshot,
  options?: { buildingLayout?: BuildingLayoutRules },
): CityState {
  const city: CityState = {
    packId: snapshot.packId,
    seed: snapshot.seed,
    baseSize: snapshot.baseSize,
    orderChaos: snapshot.orderChaos,
    outerWallMode: snapshot.outerWallMode ?? 'ring',
    center: { ...snapshot.center },
    stepCounter: snapshot.stepCounter,
    wallGeneration: snapshot.wallGeneration,
    wallHull: snapshot.wallHull ? { ...snapshot.wallHull } : null,
    buildings: snapshot.buildings.map(b => ({
      ...b,
      lot: { ...b.lot },
      door: { ...b.door },
      residentIds: [...b.residentIds],
      mergedFromIds: [...b.mergedFromIds],
    })),
    roads: new Map(snapshot.roads.map(r => [tileKey(r.col, r.row), { ...r }])),
    wallTiles: new Set(snapshot.wallTiles),
    excavatedTiles: new Set(snapshot.excavatedTiles),
    relocations: snapshot.relocations.map(r => ({ ...r })),
    vacatedLots: [],
    footprintOccupant: new Map(),
    lotReservation: new Map(),
    metrics: { ...snapshot.metrics },
    rngState: snapshot.rngState,
    buildingLayout: options?.buildingLayout ?? {},
  };
  for (const b of city.buildings) {
    stampBuildingOccupancy(city, undefined, b);
  }
  return city;
}

/* Exhaustively verifies Stage 3 city invariants: zero overlaps, valid buildable/excavatable terrain,
   zero road/building collisions and 100% 4-connected road reachability. */
export function verifyCityInvariants(city: CityState, map: GeneratedWorldMap): CityInvariantReport {
  const errors: string[] = [];
  const tileOwner = new Map<string, string>();
  let overlappingPairs = 0;
  let invalidTerrainTiles = 0;
  let roadBuildingCollisions = 0;

  for (const b of city.buildings) {
    for (let r = b.row; r < b.row + b.spanRow; r++) {
      for (let c = b.col; c < b.col + b.spanCol; c++) {
        const k = tileKey(c, r);
        if (!isTerrainCityUsable(map, c, r)) {
          invalidTerrainTiles++;
          if (errors.length < 8) errors.push(`building ${b.id} on unusable tile (${c},${r})`);
        }
        const prev = tileOwner.get(k);
        if (prev && prev !== b.id) {
          overlappingPairs++;
          if (errors.length < 8) errors.push(`overlap at (${c},${r}) between ${prev} and ${b.id}`);
        }
        tileOwner.set(k, b.id);
        if (city.roads.has(k)) {
          roadBuildingCollisions++;
          if (errors.length < 8) errors.push(`road overlaps building ${b.id} at (${c},${r})`);
        }
      }
    }
  }

  const res = city.buildings.find(b => b.kind === 'residence') ?? city.buildings[0];
  const reachable = new Set<string>();
  if (res) {
    const startKey = tileKey(res.door.col, res.door.row);
    if (city.roads.has(startKey)) {
      const queue: string[] = [startKey];
      reachable.add(startKey);
      let head = 0;
      while (head < queue.length) {
        const ck = queue[head++]!;
        const cur = parseTileKey(ck);
        for (const [dx, dy] of CARDINAL_DIRS) {
          const nk = tileKey(cur.col + dx, cur.row + dy);
          if (!reachable.has(nk) && city.roads.has(nk)) {
            reachable.add(nk);
            queue.push(nk);
          }
        }
      }
    }
  }

  let disconnectedBuildings = 0;
  let doorsOffFrontWalls = 0;
  for (const b of city.buildings) {
    const dk = tileKey(b.door.col, b.door.row);
    if (!reachable.has(dk)) {
      disconnectedBuildings++;
      if (errors.length < 8) errors.push(`building ${b.id} door (${b.door.col},${b.door.row}) disconnected`);
    }
    if (!isDoorOnFrontWall(b)) {
      doorsOffFrontWalls++;
      if (errors.length < 8) errors.push(`building ${b.id} door (${b.door.col},${b.door.row}) is not on a front wall`);
    }
  }

  return {
    ok:
      overlappingPairs === 0 &&
      invalidTerrainTiles === 0 &&
      roadBuildingCollisions === 0 &&
      disconnectedBuildings === 0 &&
      doorsOffFrontWalls === 0,
    errors,
    overlappingPairs,
    invalidTerrainTiles,
    roadBuildingCollisions,
    disconnectedBuildings,
    doorsOffFrontWalls,
  };
}

/* How far (tiles) plants keep from a footprint's edge, so no root stands right against a wall. */
const PLANT_CLEARANCE = 0.15;

/* Whether the city claims the ground at a point (fractional tile coordinates): a footprint with a thin margin, a lot a
   building left while it is still cleared, a street or a wall. Plants of the map do not grow there. */
export function cityPlantCover(city: CityState): (col: number, row: number) => boolean {
  const lots: readonly Pick<CityBuilding, 'col' | 'row' | 'spanCol' | 'spanRow'>[] = [...city.buildings, ...openVacatedLots(city)];
  const near = new Set<string>();
  for (const b of lots) {
    for (let r = b.row - 1; r <= b.row + b.spanRow; r++) {
      for (let c = b.col - 1; c <= b.col + b.spanCol; c++) near.add(tileKey(c, r));
    }
  }
  return (col, row) => {
    const k = tileKey(Math.floor(col), Math.floor(row));
    if (city.roads.has(k) || city.wallTiles.has(k)) return true;
    if (!near.has(k)) return false;
    return lots.some(
      b =>
        col > b.col - PLANT_CLEARANCE &&
        col < b.col + b.spanCol + PLANT_CLEARANCE &&
        row > b.row - PLANT_CLEARANCE &&
        row < b.row + b.spanRow + PLANT_CLEARANCE,
    );
  };
}

/* Depth key of a building in world y: the height of its side corners. A point (plant root, feet) in front of either
   front wall lies lower on screen than this, a point behind either back wall higher, so one sort by y draws plants,
   people and buildings in the right order. The order buildings sort among themselves by is the same key. */
export function cityDepthY(b: Pick<CityBuilding, 'col' | 'row' | 'spanCol' | 'spanRow'>, tileH: number): number {
  return (b.col + b.row + (b.spanCol + b.spanRow) / 2) * (tileH / 2);
}

export function bindCityMap(city: CityState, map: GeneratedWorldMap): CityState {
  (city as CityState & { _map?: GeneratedWorldMap })._map = map;
  return city;
}
