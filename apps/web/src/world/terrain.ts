/* Stage 2 deterministic procedural terrain generator.
   Generates an entire company world from a single seed with edge-expansion invariance:
   every tile (col, row) is evaluated from infinite world coordinates, so expanding map borders
   later never shifts existing terrain or the chosen riverside city center. */

import type { TileCoord } from './coords';
import { createRng, fbm2D, hash2i, hashSeed, ridgedFbm2D } from './prng';

export const TERRAIN_KINDS = [
  'river',
  'bank',
  'fertile',
  'field',
  'plain',
  'dune',
  'grove',
  'spring',
  'ridge',
  'quarry',
] as const;

export type TerrainKind = (typeof TERRAIN_KINDS)[number];
export type MapEdge = 'N' | 'E' | 'S' | 'W';

export const MIN_BUILDABLE_RATIO = 0.55;

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

export const TERRAIN_RULES: Readonly<Record<TerrainKind, Readonly<{ buildable: boolean; walkable: boolean }>>> = {
  river: { buildable: false, walkable: false },
  bank: { buildable: false, walkable: true },
  fertile: { buildable: true, walkable: true },
  field: { buildable: true, walkable: true },
  plain: { buildable: true, walkable: true },
  dune: { buildable: false, walkable: true },
  grove: { buildable: false, walkable: true },
  spring: { buildable: false, walkable: false },
  ridge: { buildable: false, walkable: false },
  quarry: { buildable: false, walkable: true },
};

const KIND_TO_INDEX: Readonly<Record<TerrainKind, number>> = {
  river: 0,
  bank: 1,
  fertile: 2,
  field: 3,
  plain: 4,
  dune: 5,
  grove: 6,
  spring: 7,
  ridge: 8,
  quarry: 9,
};

export type TerrainBounds = Readonly<{
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
}>;

export type ProceduralMapOptions = Readonly<{
  seed: string | number;
  mapSize?: number;
  /* Extra tiles added symmetrically around all four edges without shifting any existing coordinate. */
  expandMargin?: number;
}>;

export type RiverContinuityCheck = Readonly<{
  continuous: boolean;
  touchedEdges: readonly MapEdge[];
  largestComponentSize: number;
  totalRiverTiles: number;
}>;

export type ProceduralMapStats = Readonly<{
  totalTiles: number;
  buildableTiles: number;
  buildableRatio: number;
  counts: Readonly<Record<TerrainKind, number>>;
  riverIsContinuous: boolean;
  riverTouchesEdges: readonly MapEdge[];
  centerDistanceToRiver: number;
  centerLocalBuildableRatio: number;
}>;

export type ProceduralMap = Readonly<{
  seed: string;
  numericSeed: number;
  baseSize: number;
  bounds: TerrainBounds;
  width: number;
  height: number;
  cityCenter: TileCoord;
  tiles: Uint8Array;
  tileAt: (col: number, row: number) => TerrainKind | null;
  isBuildable: (col: number, row: number) => boolean;
  stats: ProceduralMapStats;
}>;

type SeedFieldParams = Readonly<{
  origin: number;
  riverCos: number;
  riverSin: number;
  baseOffset: number;
  amp1: number;
  freq1: number;
  phase1: number;
  amp2: number;
  freq2: number;
  phase2: number;
  baseHalfW: number;
  widthPhase1: number;
  widthPhase2: number;
  hasTributary: boolean;
  joinX: number;
  joinY: number;
  tribCos: number;
  tribSin: number;
  tribAmp: number;
  tribFreq: number;
  tribPhase: number;
  tribHalfW: number;
  ridgeCos: number;
  ridgeSin: number;
  duneCos: number;
  duneSin: number;
  fieldCos: number;
  fieldSin: number;
  bankSeed: number;
  fertileSeed: number;
  fieldSeed: number;
  ridgeSeed: number;
  quarrySeed: number;
  duneSeed: number;
  groveSeed: number;
  cityCenter: TileCoord;
}>;

const GROVE_CELL = 46;

function meanderAt(params: Omit<SeedFieldParams, 'cityCenter'>, along: number): { center: number; slope: number; halfW: number } {
  const center =
    params.baseOffset +
    params.amp1 * Math.sin(along * params.freq1 + params.phase1) +
    params.amp2 * Math.sin(along * params.freq2 + params.phase2);
  const slope =
    params.amp1 * params.freq1 * Math.cos(along * params.freq1 + params.phase1) +
    params.amp2 * params.freq2 * Math.cos(along * params.freq2 + params.phase2);
  const halfW =
    params.baseHalfW +
    0.75 * Math.sin(along * 0.055 + params.widthPhase1) +
    0.4 * Math.cos(along * 0.11 + params.widthPhase2);
  return { center, slope, halfW };
}

function mainRiverDistance(params: Omit<SeedFieldParams, 'cityCenter'>, gx: number, gy: number): number {
  const dx = gx - params.origin;
  const dy = gy - params.origin;
  const along = dx * params.riverCos + dy * params.riverSin;
  const perp = -dx * params.riverSin + dy * params.riverCos;
  const { center, slope, halfW } = meanderAt(params, along);
  const dCenter = Math.abs(perp - center) / Math.sqrt(1 + slope * slope);
  return dCenter - halfW;
}

function signedRiverDistance(params: Omit<SeedFieldParams, 'cityCenter'>, gx: number, gy: number): number {
  let d = mainRiverDistance(params, gx, gy);
  if (params.hasTributary) {
    const tdx = gx - params.joinX;
    const tdy = gy - params.joinY;
    const tAlong = tdx * params.tribCos + tdy * params.tribSin;
    if (tAlong >= -params.baseHalfW) {
      const tPerp = -tdx * params.tribSin + tdy * params.tribCos;
      const ramp = Math.min(1, Math.max(0, tAlong / 22));
      const m = ramp * params.tribAmp * Math.sin(tAlong * params.tribFreq + params.tribPhase);
      const dm = ramp * params.tribAmp * params.tribFreq * Math.cos(tAlong * params.tribFreq + params.tribPhase);
      const dCenter = Math.abs(tPerp - m) / Math.sqrt(1 + dm * dm);
      const endCap = tAlong < 0 ? Math.hypot(tAlong, tPerp) : dCenter;
      d = Math.min(d, endCap - params.tribHalfW);
    }
  }
  return d;
}

function rawRidgeValue(params: Omit<SeedFieldParams, 'cityCenter'>, gx: number, gy: number): number {
  const rx = gx * params.ridgeCos - gy * params.ridgeSin;
  const ry = gx * params.ridgeSin + gy * params.ridgeCos;
  /* Directional 2.2:1 stretching forms natural mountain ridges and escarpments. */
  const chain = ridgedFbm2D(rx * 0.017, ry * 0.036, params.ridgeSeed, 4);
  const massif = fbm2D(gx * 0.024 + 13.7, gy * 0.024 - 7.3, (params.ridgeSeed + 7919) >>> 0, 3);
  return chain * 0.72 + massif * 0.28;
}

function fertileBandWidth(params: Omit<SeedFieldParams, 'cityCenter'>, gx: number, gy: number): number {
  return 6.5 + 6.0 * fbm2D(gx * 0.032, gy * 0.032, params.fertileSeed, 3);
}

function bankBandWidth(params: Omit<SeedFieldParams, 'cityCenter'>, gx: number, gy: number): number {
  return 1.15 + 0.65 * fbm2D(gx * 0.09, gy * 0.09, params.bankSeed, 2);
}

/* Chooses a flat riverside city center strictly inside the canonical core window of baseSize,
   so edge expansion never alters the chosen center. */
function chooseCityCenter(params: Omit<SeedFieldParams, 'cityCenter'>, baseSize: number): TileCoord {
  const minCoord = Math.floor(baseSize * 0.25);
  const maxCoord = Math.floor(baseSize * 0.75);
  let best: TileCoord = { col: params.origin, row: params.origin };
  let bestScore = -Infinity;

  for (let along = -34; along <= 34; along += 2) {
    const { center, slope, halfW } = meanderAt(params, along);
    const invLen = 1 / Math.sqrt(1 + slope * slope);
    /* Normal to river curve at this along sample. */
    const normalAlong = -slope * invLen;
    const normalPerp = invLen;
    const targetDist = halfW + 5.5;

    for (const side of [-1, 1] as const) {
      const a = along + side * normalAlong * targetDist;
      const p = center + side * normalPerp * targetDist;
      const col = Math.round(params.origin + a * params.riverCos - p * params.riverSin);
      const row = Math.round(params.origin + a * params.riverSin + p * params.riverCos);
      if (col < minCoord || col > maxCoord || row < minCoord || row > maxCoord) continue;

      const dRiver = signedRiverDistance(params, col, row);
      if (dRiver < 2.8 || dRiver > 7.5) continue;

      const distToOrigin = Math.hypot(col - params.origin, row - params.origin);
      const ridgeHere = rawRidgeValue(params, col, row);
      const ridgeAvg =
        (ridgeHere +
          rawRidgeValue(params, col + 6, row) +
          rawRidgeValue(params, col - 6, row) +
          rawRidgeValue(params, col, row + 6) +
          rawRidgeValue(params, col, row - 6)) /
        5;

      /* Reject cramped confluence pockets where water/banks consume too much of the founding plaza. */
      let waterOrBank = 0;
      for (let dy = -5; dy <= 5; dy += 2) {
        for (let dx = -5; dx <= 5; dx += 2) {
          const nd = signedRiverDistance(params, col + dx, row + dy);
          if (nd <= 1.8) waterOrBank++;
        }
      }
      if (waterOrBank > 7) continue;

      /* Prefer locations near map center, right next to the river, with low natural ridge elevation. */
      const riverIdeal = 1 - Math.abs(dRiver - 5.2) / 5.2;
      const score = riverIdeal * 2.4 - ridgeAvg * 3.2 - waterOrBank * 0.25 - distToOrigin * 0.035;
      if (score > bestScore) {
        bestScore = score;
        best = { col, row };
      }
    }
  }

  return best;
}

function buildSeedParams(numericSeed: number, baseSize: number): SeedFieldParams {
  const rng = createRng(numericSeed);
  const origin = Math.floor(baseSize / 2);

  /* Flow angle covers the full 180-degree compass so every seed has a distinct river bearing. */
  const theta = rng() * Math.PI;
  const riverCos = Math.cos(theta);
  const riverSin = Math.sin(theta);

  /* Pronounced S-curve river meanders (wavelength ~95..140 tiles) with bounded lateral excursion
     so every company map has vivid natural bends and a single continuous edge-to-edge river. */
  const baseOffset = (rng() * 2 - 1) * 11;
  const amp1 = 10 + rng() * 5.5;
  const freq1 = 0.042 + rng() * 0.02;
  const phase1 = rng() * Math.PI * 2;
  const amp2 = 3.0 + rng() * 2.5;
  const freq2 = 0.082 + rng() * 0.032;
  const phase2 = rng() * Math.PI * 2;
  const baseHalfW = 2.85 + rng() * 0.85;
  const widthPhase1 = rng() * Math.PI * 2;
  const widthPhase2 = rng() * Math.PI * 2;

  /* Roughly half of all company seeds feature a sweeping tributary merging at a natural 32..50 degree angle. */
  const hasTributary = rng() < 0.45;
  const joinAlong = (rng() * 2 - 1) * 20;
  const tribSide = rng() < 0.5 ? -1 : 1;
  const tribDir = rng() < 0.5 ? 0 : Math.PI;
  const tribBranchAngle = theta + tribDir + tribSide * (0.56 + rng() * 0.32);
  const tribCos = Math.cos(tribBranchAngle);
  const tribSin = Math.sin(tribBranchAngle);
  const tribAmp = 7 + rng() * 4.5;
  const tribFreq = 0.048 + rng() * 0.022;
  const tribPhase = rng() * Math.PI * 2;
  const tribHalfW = 1.95 + rng() * 0.45;

  const ridgeAngle = rng() * Math.PI;
  const duneAngle = rng() * Math.PI;
  const fieldAngle = theta + (rng() * 0.25 - 0.125);

  const joinCenter =
    baseOffset +
    amp1 * Math.sin(joinAlong * freq1 + phase1) +
    amp2 * Math.sin(joinAlong * freq2 + phase2);
  const joinX = origin + joinAlong * riverCos - joinCenter * riverSin;
  const joinY = origin + joinAlong * riverSin + joinCenter * riverCos;

  const baseParams: Omit<SeedFieldParams, 'cityCenter'> = {
    origin,
    riverCos,
    riverSin,
    baseOffset,
    amp1,
    freq1,
    phase1,
    amp2,
    freq2,
    phase2,
    baseHalfW,
    widthPhase1,
    widthPhase2,
    hasTributary,
    joinX,
    joinY,
    tribCos,
    tribSin,
    tribAmp,
    tribFreq,
    tribPhase,
    tribHalfW,
    ridgeCos: Math.cos(ridgeAngle),
    ridgeSin: Math.sin(ridgeAngle),
    duneCos: Math.cos(duneAngle),
    duneSin: Math.sin(duneAngle),
    fieldCos: Math.cos(fieldAngle),
    fieldSin: Math.sin(fieldAngle),
    bankSeed: (numericSeed ^ 0x1a2b3c4d) >>> 0,
    fertileSeed: (numericSeed ^ 0x2b3c4d5e) >>> 0,
    fieldSeed: (numericSeed ^ 0x3c4d5e6f) >>> 0,
    ridgeSeed: (numericSeed ^ 0x4d5e6f71) >>> 0,
    quarrySeed: (numericSeed ^ 0x5e6f7182) >>> 0,
    duneSeed: (numericSeed ^ 0x6f718293) >>> 0,
    groveSeed: (numericSeed ^ 0x718293a4) >>> 0,
  };

  const cityCenter = chooseCityCenter(baseParams, baseSize);
  return { ...baseParams, cityCenter };
}

type GroveCandidate = Readonly<{
  x: number;
  y: number;
  cosA: number;
  sinA: number;
  aspect: number;
  springR: number;
  groveR: number;
}>;

/* Evaluates whether infinite lattice cell (cellX, cellY) hosts an inland spring + grove pocket. */
function groveInCell(params: SeedFieldParams, cellX: number, cellY: number): GroveCandidate | null {
  const roll = hash2i(cellX, cellY, params.groveSeed);
  if (roll > 0.62) return null;

  const jx = 0.18 + 0.64 * hash2i(cellX, cellY, (params.groveSeed + 101) >>> 0);
  const jy = 0.18 + 0.64 * hash2i(cellX, cellY, (params.groveSeed + 211) >>> 0);
  const x = (cellX + jx) * GROVE_CELL;
  const y = (cellY + jy) * GROVE_CELL;

  /* Keep inland springs out of the river valley, out of the central city plateau and off mountain crests. */
  const dRiver = signedRiverDistance(params, x, y);
  const fertileW = fertileBandWidth(params, x, y);
  if (dRiver < fertileW + 9) return null;
  if (Math.hypot(x - params.cityCenter.col, y - params.cityCenter.row) < 20) return null;
  if (rawRidgeValue(params, x, y) > 0.59) return null;

  const angle = hash2i(cellX, cellY, (params.groveSeed + 613) >>> 0) * Math.PI;
  const aspect = 1.25 + 0.55 * hash2i(cellX, cellY, (params.groveSeed + 719) >>> 0);
  const springR = 1.6 + 1.0 * hash2i(cellX, cellY, (params.groveSeed + 307) >>> 0);
  const groveR = 4.6 + 2.6 * hash2i(cellX, cellY, (params.groveSeed + 409) >>> 0);
  return { x, y, cosA: Math.cos(angle), sinA: Math.sin(angle), aspect, springR, groveR };
}

/* Pure O(1) evaluation of a single world tile (gx, gy), invariant under any map edge expansion. */
function evaluateTerrainAt(params: SeedFieldParams, gx: number, gy: number): TerrainKind {
  const dRiver = signedRiverDistance(params, gx, gy);
  if (dRiver <= 0) return 'river';

  const bankW = bankBandWidth(params, gx, gy);
  if (dRiver <= bankW) return 'bank';

  const fertileW = fertileBandWidth(params, gx, gy);
  const distCenter = Math.hypot(gx - params.cityCenter.col, gy - params.cityCenter.row);

  /* Cultivated fields sit inside and along the edge of the fertile valley, clear of the founding plaza. */
  if (dRiver > bankW + 1.2 && dRiver <= fertileW + 3.5 && distCenter > 4.5) {
    const fx = gx * params.fieldCos - gy * params.fieldSin;
    const fy = gx * params.fieldSin + gy * params.fieldCos;
    const plotHash = hash2i(Math.floor(fx / 6), Math.floor(fy / 5), params.fieldSeed);
    const localBreak = fbm2D(gx * 0.11, gy * 0.11, (params.fieldSeed + 997) >>> 0, 2);
    if (plotHash > 0.52 && localBreak > 0.34) {
      return 'field';
    }
  }

  if (dRiver <= fertileW) return 'fertile';

  /* Keep a flat buildable riverside basin around the city center free of cliffs, quarries, dunes and springs. */
  if (distCenter <= 11.5) return 'plain';

  /* Check inland spring + grove pockets across the 3x3 surrounding infinite lattice cells. */
  const cx = Math.floor(gx / GROVE_CELL);
  const cy = Math.floor(gy / GROVE_CELL);
  const wobble = (fbm2D(gx * 0.14, gy * 0.14, (params.groveSeed + 521) >>> 0, 2) - 0.5) * 2.4;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cand = groveInCell(params, cx + dx, cy + dy);
      if (!cand) continue;
      const rx = gx - cand.x;
      const ry = gy - cand.y;
      const lx = (rx * cand.cosA + ry * cand.sinA) / cand.aspect;
      const ly = -rx * cand.sinA + ry * cand.cosA;
      const dist = Math.hypot(lx, ly) + wobble * 0.7;
      if (dist <= cand.springR) return 'spring';
      if (dist <= cand.groveR) return 'grove';
    }
  }

  /* Mountain ridges and foothill quarries outside the river valley and central basin. */
  if (dRiver > fertileW + 4.5 && distCenter > 16) {
    const ridgeVal = rawRidgeValue(params, gx, gy);
    const outerBoost = Math.min(0.055, Math.max(0, (distCenter - 26) / 680));
    const effectiveRidge = ridgeVal + outerBoost;
    const ridgeThreshold = 0.688;
    if (effectiveRidge >= ridgeThreshold) return 'ridge';

    /* Quarries form compact stone outcrops nestled along the foothill skirts of ridges. */
    if (effectiveRidge >= ridgeThreshold - 0.068) {
      const qNoise = fbm2D(gx * 0.074, gy * 0.074, params.quarrySeed, 3);
      if (qNoise > 0.57) return 'quarry';
    }
  }

  /* Outer rolling dunes / wild terrain swept along wind lines, preserving a spacious buildable plain. */
  if (dRiver > fertileW + 10 && distCenter > 24) {
    const wx = gx * params.duneCos - gy * params.duneSin;
    const wy = gx * params.duneSin + gy * params.duneCos;
    const duneMacro = fbm2D(wx * 0.025, wy * 0.044, params.duneSeed, 3);
    const outerBias = Math.min(0.055, Math.max(0, (distCenter - 32) / 620));
    if (duneMacro + outerBias > 0.678) return 'dune';
  }

  return 'plain';
}

/* Verifies that all river tiles form one continuous 4-connected component reaching at least 2 map edges. */
export function verifyRiverContinuity(map: ProceduralMap): RiverContinuityCheck {
  const { width, height, tiles } = map;
  const riverIdx = KIND_TO_INDEX.river;
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);

  let totalRiverTiles = 0;
  let largestComponentSize = 0;
  let bestEdges = new Set<MapEdge>();

  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] === riverIdx) totalRiverTiles++;
  }

  for (let start = 0; start < tiles.length; start++) {
    if (tiles[start] !== riverIdx || visited[start]) continue;
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
        if (tiles[n] === riverIdx && !visited[n]) {
          visited[n] = 1;
          queue[tail++] = n;
        }
      }
      if (x + 1 < width) {
        const n = cur + 1;
        if (tiles[n] === riverIdx && !visited[n]) {
          visited[n] = 1;
          queue[tail++] = n;
        }
      }
      if (y > 0) {
        const n = cur - width;
        if (tiles[n] === riverIdx && !visited[n]) {
          visited[n] = 1;
          queue[tail++] = n;
        }
      }
      if (y + 1 < height) {
        const n = cur + width;
        if (tiles[n] === riverIdx && !visited[n]) {
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
  const touchedEdges = order.filter(e => bestEdges.has(e));
  return {
    continuous: totalRiverTiles > 0 && largestComponentSize === totalRiverTiles,
    touchedEdges,
    largestComponentSize,
    totalRiverTiles,
  };
}

function measureCenterDistanceToRiver(map: Omit<ProceduralMap, 'stats'>): number {
  const { col: cx, row: cy } = map.cityCenter;
  let bestSq = Infinity;
  const searchRadius = 24;
  for (let dy = -searchRadius; dy <= searchRadius; dy++) {
    for (let dx = -searchRadius; dx <= searchRadius; dx++) {
      if (map.tileAt(cx + dx, cy + dy) === 'river') {
        const sq = dx * dx + dy * dy;
        if (sq < bestSq) bestSq = sq;
      }
    }
  }
  return Number.isFinite(bestSq) ? Math.round(Math.sqrt(bestSq) * 10) / 10 : Infinity;
}

function measureCenterLocalBuildable(map: Omit<ProceduralMap, 'stats'>): number {
  const { col: cx, row: cy } = map.cityCenter;
  let total = 0;
  let buildable = 0;
  for (let dy = -5; dy <= 5; dy++) {
    for (let dx = -5; dx <= 5; dx++) {
      const kind = map.tileAt(cx + dx, cy + dy);
      if (!kind) continue;
      total++;
      if (TERRAIN_RULES[kind].buildable) buildable++;
    }
  }
  return total > 0 ? buildable / total : 0;
}

/* Generates a complete procedural map for the company seed, with optional symmetric edge expansion. */
export function generateProceduralMap(options: ProceduralMapOptions): ProceduralMap {
  const baseSize = Math.max(32, Math.floor(options.mapSize ?? 150));
  const expandMargin = Math.max(0, Math.floor(options.expandMargin ?? 0));
  const seedText = String(options.seed);
  const numericSeed = hashSeed(seedText);
  const params = buildSeedParams(numericSeed, baseSize);

  const bounds: TerrainBounds = {
    minCol: -expandMargin,
    maxCol: baseSize + expandMargin,
    minRow: -expandMargin,
    maxRow: baseSize + expandMargin,
  };
  const width = bounds.maxCol - bounds.minCol;
  const height = bounds.maxRow - bounds.minRow;
  const tiles = new Uint8Array(width * height);

  const counts: Record<TerrainKind, number> = {
    river: 0,
    bank: 0,
    fertile: 0,
    field: 0,
    plain: 0,
    dune: 0,
    grove: 0,
    spring: 0,
    ridge: 0,
    quarry: 0,
  };

  let buildableTiles = 0;
  let cursor = 0;
  for (let row = bounds.minRow; row < bounds.maxRow; row++) {
    for (let col = bounds.minCol; col < bounds.maxCol; col++) {
      const kind = evaluateTerrainAt(params, col, row);
      tiles[cursor++] = KIND_TO_INDEX[kind];
      counts[kind]++;
      if (TERRAIN_RULES[kind].buildable) buildableTiles++;
    }
  }

  const tileAt = (col: number, row: number): TerrainKind | null => {
    if (col < bounds.minCol || col >= bounds.maxCol || row < bounds.minRow || row >= bounds.maxRow) {
      return null;
    }
    const idx = (row - bounds.minRow) * width + (col - bounds.minCol);
    return TERRAIN_KINDS[tiles[idx]!] ?? null;
  };

  const isBuildable = (col: number, row: number): boolean => {
    const kind = tileAt(col, row);
    return kind ? TERRAIN_RULES[kind].buildable : false;
  };

  const partialMap: Omit<ProceduralMap, 'stats'> = {
    seed: seedText,
    numericSeed,
    baseSize,
    bounds,
    width,
    height,
    cityCenter: params.cityCenter,
    tiles,
    tileAt,
    isBuildable,
  };

  const riverCheck = verifyRiverContinuity({
    ...partialMap,
    stats: {
      totalTiles: width * height,
      buildableTiles,
      buildableRatio: buildableTiles / (width * height),
      counts,
      riverIsContinuous: false,
      riverTouchesEdges: [],
      centerDistanceToRiver: 0,
      centerLocalBuildableRatio: 0,
    },
  });

  const stats: ProceduralMapStats = {
    totalTiles: width * height,
    buildableTiles,
    buildableRatio: buildableTiles / (width * height),
    counts,
    riverIsContinuous: riverCheck.continuous,
    riverTouchesEdges: riverCheck.touchedEdges,
    centerDistanceToRiver: measureCenterDistanceToRiver(partialMap),
    centerLocalBuildableRatio: measureCenterLocalBuildable(partialMap),
  };

  return {
    ...partialMap,
    stats,
  };
}
