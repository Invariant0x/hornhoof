/* Ancient Egypt river-valley procedural terrain recipe (pack-owned, outside engine core).
   Generates discrete terrain slots AND smooth continuous vertex corner fields (elevation, moisture,
   exact signed water distance and normalized material blend weights) in infinite world coordinates
   so edge expansion never shifts any existing tile, shoreline or city center. */

import type { TileCoord } from '../../world/coords';
import type {
  CornerSample,
  PreparedTerrainRecipe,
  TerrainKindSpec,
  TerrainNoiseToolkit,
  TerrainRecipeSpec,
} from '../../world/manifest';

export const EGYPT_TILE_KINDS: readonly TerrainKindSpec[] = [
  { id: 'river', label: { en: 'River', ru: 'Река' }, color: '#2678A6', materialId: 'bank', buildable: false, walkable: false, liquid: true },
  { id: 'bank', label: { en: 'Riverbank', ru: 'Берег' }, color: '#D4BA86', materialId: 'bank', buildable: false, walkable: true },
  { id: 'fertile', label: { en: 'Fertile strip', ru: 'Зеленая полоса' }, color: '#5E8E46', materialId: 'grass', buildable: true, walkable: true },
  { id: 'plain', label: { en: 'Flat sand plain', ru: 'Ровная земля' }, color: '#D8C294', materialId: 'sand', buildable: true, walkable: true },
  { id: 'dune', label: { en: 'Dunes', ru: 'Барханы' }, color: '#CFA666', materialId: 'dune', buildable: false, walkable: true },
  { id: 'ridge', label: { en: 'Cliffs & ridges', ru: 'Скалы и гряды' }, color: '#94816A', materialId: 'rock', buildable: false, walkable: false },
  { id: 'quarry', label: { en: 'Quarries', ru: 'Каменоломни' }, color: '#B7AA93', materialId: 'quarry', buildable: false, walkable: true },
  { id: 'oasis_water', label: { en: 'Oasis pool', ru: 'Вода оазиса' }, color: '#339EB2', materialId: 'bank', buildable: false, walkable: false, liquid: true },
  { id: 'oasis_grove', label: { en: 'Oasis grove', ru: 'Оазис' }, color: '#457D43', materialId: 'grass', buildable: false, walkable: true },
];

export const EGYPT_MATERIAL_IDS = [
  'bank',
  'grass',
  'sand',
  'dune',
  'rock',
  'quarry',
  'silt',
  'dust',
] as const;

type EgyptSeedParams = Readonly<{
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
  meadowCos: number;
  meadowSin: number;
  bankSeed: number;
  fertileSeed: number;
  meadowSeed: number;
  ridgeSeed: number;
  quarrySeed: number;
  duneSeed: number;
  oasisSeed: number;
  startCenter: TileCoord;
}>;

const OASIS_CELL = 46;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function meanderAt(params: Omit<EgyptSeedParams, 'startCenter'>, along: number): { center: number; slope: number; halfW: number } {
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

function signedRiverDistance(params: Omit<EgyptSeedParams, 'startCenter'>, gx: number, gy: number): number {
  const dx = gx - params.origin;
  const dy = gy - params.origin;
  const along = dx * params.riverCos + dy * params.riverSin;
  const perp = -dx * params.riverSin + dy * params.riverCos;
  const { center, slope, halfW } = meanderAt(params, along);
  let d = Math.abs(perp - center) / Math.sqrt(1 + slope * slope) - halfW;

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

function rawRidgeValue(params: Omit<EgyptSeedParams, 'startCenter'>, noise: TerrainNoiseToolkit, gx: number, gy: number): number {
  const rx = gx * params.ridgeCos - gy * params.ridgeSin;
  const ry = gx * params.ridgeSin + gy * params.ridgeCos;
  const chain = noise.ridgedFbm2D(rx * 0.017, ry * 0.036, params.ridgeSeed, 4);
  const massif = noise.fbm2D(gx * 0.024 + 13.7, gy * 0.024 - 7.3, (params.ridgeSeed + 7919) >>> 0, 3);
  return chain * 0.72 + massif * 0.28;
}

function fertileWidthAt(params: Omit<EgyptSeedParams, 'startCenter'>, noise: TerrainNoiseToolkit, gx: number, gy: number): number {
  return 6.5 + 6.0 * noise.fbm2D(gx * 0.032, gy * 0.032, params.fertileSeed, 3);
}

function bankWidthAt(params: Omit<EgyptSeedParams, 'startCenter'>, noise: TerrainNoiseToolkit, gx: number, gy: number): number {
  return 1.15 + 0.65 * noise.fbm2D(gx * 0.09, gy * 0.09, params.bankSeed, 2);
}

function chooseRiversideCenter(
  params: Omit<EgyptSeedParams, 'startCenter'>,
  baseSize: number,
  noise: TerrainNoiseToolkit,
): TileCoord {
  const minCoord = Math.floor(baseSize * 0.25);
  const maxCoord = Math.floor(baseSize * 0.75);
  let best: TileCoord = { col: params.origin, row: params.origin };
  let bestScore = -Infinity;

  for (let along = -34; along <= 34; along += 2) {
    const { center, slope, halfW } = meanderAt(params, along);
    const invLen = 1 / Math.sqrt(1 + slope * slope);
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

      let waterOrBank = 0;
      for (let dy = -5; dy <= 5; dy += 2) {
        for (let dx = -5; dx <= 5; dx += 2) {
          if (signedRiverDistance(params, col + dx, row + dy) <= 1.8) waterOrBank++;
        }
      }
      if (waterOrBank > 7) continue;

      const distToOrigin = Math.hypot(col - params.origin, row - params.origin);
      const ridgeAvg =
        (rawRidgeValue(params, noise, col, row) +
          rawRidgeValue(params, noise, col + 6, row) +
          rawRidgeValue(params, noise, col - 6, row) +
          rawRidgeValue(params, noise, col, row + 6) +
          rawRidgeValue(params, noise, col, row - 6)) /
        5;

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

type OasisCandidate = Readonly<{
  x: number;
  y: number;
  cosA: number;
  sinA: number;
  aspect: number;
  waterR: number;
  groveR: number;
}>;

function oasisInCell(
  params: EgyptSeedParams,
  noise: TerrainNoiseToolkit,
  cellX: number,
  cellY: number,
): OasisCandidate | null {
  if (noise.hash2i(cellX, cellY, params.oasisSeed) > 0.62) return null;
  const jx = 0.18 + 0.64 * noise.hash2i(cellX, cellY, (params.oasisSeed + 101) >>> 0);
  const jy = 0.18 + 0.64 * noise.hash2i(cellX, cellY, (params.oasisSeed + 211) >>> 0);
  const x = (cellX + jx) * OASIS_CELL;
  const y = (cellY + jy) * OASIS_CELL;

  const dRiver = signedRiverDistance(params, x, y);
  const fertileW = fertileWidthAt(params, noise, x, y);
  if (dRiver < fertileW + 9) return null;
  if (Math.hypot(x - params.startCenter.col, y - params.startCenter.row) < 20) return null;
  if (rawRidgeValue(params, noise, x, y) > 0.59) return null;

  const angle = noise.hash2i(cellX, cellY, (params.oasisSeed + 613) >>> 0) * Math.PI;
  const aspect = 1.25 + 0.55 * noise.hash2i(cellX, cellY, (params.oasisSeed + 719) >>> 0);
  const waterR = 1.6 + 1.0 * noise.hash2i(cellX, cellY, (params.oasisSeed + 307) >>> 0);
  const groveR = 4.6 + 2.6 * noise.hash2i(cellX, cellY, (params.oasisSeed + 409) >>> 0);
  return { x, y, cosA: Math.cos(angle), sinA: Math.sin(angle), aspect, waterR, groveR };
}

function sampleOasisDistances(
  params: EgyptSeedParams,
  noise: TerrainNoiseToolkit,
  gx: number,
  gy: number,
): { waterDist: number; groveDist: number } {
  const cx = Math.floor(gx / OASIS_CELL);
  const cy = Math.floor(gy / OASIS_CELL);
  const wobble = (noise.fbm2D(gx * 0.14, gy * 0.14, (params.oasisSeed + 521) >>> 0, 2) - 0.5) * 2.4;
  let minWater = Infinity;
  let minGrove = Infinity;

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cand = oasisInCell(params, noise, cx + dx, cy + dy);
      if (!cand) continue;
      const rx = gx - cand.x;
      const ry = gy - cand.y;
      const lx = (rx * cand.cosA + ry * cand.sinA) / cand.aspect;
      const ly = -rx * cand.sinA + ry * cand.cosA;
      const dist = Math.hypot(lx, ly) + wobble * 0.7;
      const dw = dist - cand.waterR;
      const dg = dist - cand.groveR;
      if (dw < minWater) minWater = dw;
      if (dg < minGrove) minGrove = dg;
    }
  }
  return { waterDist: minWater, groveDist: minGrove };
}

export const EGYPT_TERRAIN_RECIPE: TerrainRecipeSpec = {
  id: 'egypt-river-valley',
  name: { en: 'Ancient Egypt (River Valley)', ru: 'Древний Египет (речная долина)' },
  tileKinds: EGYPT_TILE_KINDS,
  materialIds: EGYPT_MATERIAL_IDS,
  minBuildableRatio: 0.55,
  continuityKindIds: ['river'],
  prepare(numericSeed: number, baseSize: number, noise: TerrainNoiseToolkit): PreparedTerrainRecipe {
    const rng = noise.createRng(numericSeed);
    const origin = Math.floor(baseSize / 2);

    const theta = rng() * Math.PI;
    const riverCos = Math.cos(theta);
    const riverSin = Math.sin(theta);

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
    const meadowAngle = theta + (rng() * 0.25 - 0.125);

    const joinCenter =
      baseOffset +
      amp1 * Math.sin(joinAlong * freq1 + phase1) +
      amp2 * Math.sin(joinAlong * freq2 + phase2);
    const joinX = origin + joinAlong * riverCos - joinCenter * riverSin;
    const joinY = origin + joinAlong * riverSin + joinCenter * riverCos;

    const baseParams: Omit<EgyptSeedParams, 'startCenter'> = {
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
      meadowCos: Math.cos(meadowAngle),
      meadowSin: Math.sin(meadowAngle),
      bankSeed: (numericSeed ^ 0x1a2b3c4d) >>> 0,
      fertileSeed: (numericSeed ^ 0x2b3c4d5e) >>> 0,
      meadowSeed: (numericSeed ^ 0x3c4d5e6f) >>> 0,
      ridgeSeed: (numericSeed ^ 0x4d5e6f71) >>> 0,
      quarrySeed: (numericSeed ^ 0x5e6f7182) >>> 0,
      duneSeed: (numericSeed ^ 0x6f718293) >>> 0,
      oasisSeed: (numericSeed ^ 0x718293a4) >>> 0,
    };

    const startCenter = chooseRiversideCenter(baseParams, baseSize, noise);
    const params: EgyptSeedParams = { ...baseParams, startCenter };

    const sampleTile = (col: number, row: number): string => {
      const gx = col + 0.5;
      const gy = row + 0.5;
      const dRiver = signedRiverDistance(params, gx, gy);
      if (dRiver <= 0) return 'river';

      const bankW = bankWidthAt(params, noise, gx, gy);
      if (dRiver <= bankW) return 'bank';

      const fertileW = fertileWidthAt(params, noise, gx, gy);
      const distCenter = Math.hypot(gx - params.startCenter.col, gy - params.startCenter.row);

      /* Meadows reach out of the green strip in rectangular patches. Sown fields once stood here; on Ivan's word
         (23.11.2026) they are a game object people work on, not landscape, so the land is the strip's grass. */
      if (dRiver > bankW + 1.2 && dRiver <= fertileW + 3.5 && distCenter > 4.5) {
        const fx = gx * params.meadowCos - gy * params.meadowSin;
        const fy = gx * params.meadowSin + gy * params.meadowCos;
        const plotHash = noise.hash2i(Math.floor(fx / 6), Math.floor(fy / 5), params.meadowSeed);
        const localBreak = noise.fbm2D(gx * 0.11, gy * 0.11, (params.meadowSeed + 997) >>> 0, 2);
        if (plotHash > 0.52 && localBreak > 0.34) return 'fertile';
      }

      if (dRiver <= fertileW) return 'fertile';
      if (distCenter <= 11.5) return 'plain';

      const oasis = sampleOasisDistances(params, noise, gx, gy);
      if (oasis.waterDist <= 0) return 'oasis_water';
      if (oasis.groveDist <= 0) return 'oasis_grove';

      if (dRiver > fertileW + 4.5 && distCenter > 16) {
        const ridgeVal = rawRidgeValue(params, noise, gx, gy);
        const outerBoost = Math.min(0.055, Math.max(0, (distCenter - 26) / 680));
        const effectiveRidge = ridgeVal + outerBoost;
        const ridgeThreshold = 0.688;
        if (effectiveRidge >= ridgeThreshold) return 'ridge';
        if (effectiveRidge >= ridgeThreshold - 0.068) {
          if (noise.fbm2D(gx * 0.074, gy * 0.074, params.quarrySeed, 3) > 0.57) return 'quarry';
        }
      }

      if (dRiver > fertileW + 10 && distCenter > 24) {
        const wx = gx * params.duneCos - gy * params.duneSin;
        const wy = gx * params.duneSin + gy * params.duneCos;
        const duneMacro = noise.fbm2D(wx * 0.025, wy * 0.044, params.duneSeed, 3);
        const outerBias = Math.min(0.055, Math.max(0, (distCenter - 32) / 620));
        if (duneMacro + outerBias > 0.678) return 'dune';
      }

      return 'plain';
    };

    /* Continuous smooth corner evaluator for curved shorelines, directional elevation shading and seamless material blending. */
    const sampleCorner = (vx: number, vy: number): CornerSample => {
      const dRiver = signedRiverDistance(params, vx, vy);
      const bankW = bankWidthAt(params, noise, vx, vy);
      const fertileW = fertileWidthAt(params, noise, vx, vy);
      const distCenter = Math.hypot(vx - params.startCenter.col, vy - params.startCenter.row);

      const oasis = distCenter > 10 ? sampleOasisDistances(params, noise, vx, vy) : { waterDist: Infinity, groveDist: Infinity };
      const signedWaterDist = Math.min(dRiver, oasis.waterDist);

      /* The green strip along the water is one to three tiles wide and narrows and widens along the river. Meadow
         patches reach out of it where the sown fields and the grass around them were (see sampleTile): an edge as
         steep as the strip's keeps their painted edge as narrow as every other. */
      const stripW = 1.3 + 2.0 * smoothstep(0.32, 0.68, noise.fbm2D(vx * 0.06 + 9.1, vy * 0.06 - 3.3, (params.bankSeed + 77) >>> 0, 3));
      const fx = vx * params.meadowCos - vy * params.meadowSin;
      const fy = vx * params.meadowSin + vy * params.meadowCos;
      const meadowPatch = noise.fbm2D(fx * 0.085, fy * 0.095, params.meadowSeed, 2);
      const meadowBand =
        smoothstep(stripW * 0.7, stripW * 0.7 + 1.2, dRiver) *
        (1 - smoothstep(fertileW - 1.5, fertileW + 1.5, dRiver)) *
        smoothstep(3.5, 6.5, distCenter);
      const meadowGrass = smoothstep(0.3, 0.7, smoothstep(0.4, 0.64, meadowPatch) * meadowBand);

      /* Smooth moisture field peaks along riverbanks and oases, tapering naturally into the desert. The meadows are
         watered land, so their grass grows the strip's plants. */
      const riverMoist = 1 - smoothstep(0, fertileW + 2.5, Math.max(0, dRiver));
      const oasisMoist = oasis.groveDist < 3 ? 1 - smoothstep(-1.5, 2.2, oasis.groveDist) : 0;
      const moisture = Math.max(riverMoist, oasisMoist, meadowGrass * 0.6);

      /* Continuous elevation: recessed river bed -> sloped bank -> flat plain -> rolling dunes -> steep cliffs. */
      const bankSlope = smoothstep(-1.2, 2.4, signedWaterDist) * 0.24;
      const ridgeVal = rawRidgeValue(params, noise, vx, vy);
      const ridgeMask =
        smoothstep(fertileW + 2.5, fertileW + 7.5, dRiver) * smoothstep(13, 21, distCenter);
      const outerBoost = Math.min(0.055, Math.max(0, (distCenter - 26) / 680));
      const effRidge = ridgeVal + outerBoost;
      const rockWeight = smoothstep(0.65, 0.72, effRidge) * ridgeMask;

      const quarryNoise = noise.fbm2D(vx * 0.074, vy * 0.074, params.quarrySeed, 3);
      const quarryBand =
        smoothstep(0.60, 0.65, effRidge) *
        (1 - smoothstep(0.68, 0.72, effRidge)) *
        smoothstep(0.51, 0.61, quarryNoise) *
        ridgeMask;

      const wx = vx * params.duneCos - vy * params.duneSin;
      const wy = vx * params.duneSin + vy * params.duneCos;
      const duneMacro = noise.fbm2D(wx * 0.025, wy * 0.044, params.duneSeed, 3);
      const outerBias = Math.min(0.055, Math.max(0, (distCenter - 32) / 620));
      const duneMask =
        smoothstep(fertileW + 7, fertileW + 14, dRiver) * smoothstep(20, 29, distCenter) * (1 - rockWeight);
      const duneWeight = smoothstep(0.635, 0.71, duneMacro + outerBias) * duneMask;

      /* Golden sand is the main ground. The water is edged by a narrow strip of wet bank, then the green strip; beyond
         it sand, with the meadow patches and grass around the oases. */
      const wetW = 0.45 + 0.25 * noise.fbm2D(vx * 0.11 + 4.7, vy * 0.11 - 8.2, (params.bankSeed + 31) >>> 0, 2);
      const bankWeight = (1 - smoothstep(wetW - 0.25, wetW + 0.25, Math.max(0, signedWaterDist))) * (1 - rockWeight);

      const valleyGrass = smoothstep(wetW - 0.2, wetW + 0.3, dRiver) * (1 - smoothstep(stripW - 0.4, stripW + 0.4, dRiver));
      const oasisGrass = oasis.groveDist < 3 ? 1 - smoothstep(-0.6, 1.0, oasis.groveDist) : 0;
      const grassWeight = Math.max(valleyGrass, oasisGrass, meadowGrass) * (1 - rockWeight);

      /* Dark Nile silt in a patchy band just above the waterline, and trodden dust on the city site around the start. */
      const siltNoise = noise.fbm2D(vx * 0.12 + 3.1, vy * 0.12 - 1.7, (params.bankSeed + 211) >>> 0, 2);
      const siltBand =
        smoothstep(bankW - 0.2, bankW + 0.7, dRiver) * (1 - smoothstep(bankW + 1.2, bankW + 2.6, dRiver));
      const siltWeight = siltBand * smoothstep(0.4, 0.66, siltNoise) * 0.3 * (1 - rockWeight);
      const dustNoise = noise.fbm2D(vx * 0.16, vy * 0.16, (params.oasisSeed + 4423) >>> 0, 3);
      const dustWeight =
        (1 - smoothstep(5, 12.5, distCenter)) * smoothstep(0.28, 0.55, dustNoise) * 0.85 * (1 - bankWeight) * (1 - grassWeight * 0.6);

      const used = bankWeight + grassWeight + duneWeight + rockWeight + quarryBand + siltWeight + dustWeight;
      const sandWeight = Math.max(0.04, 1 - Math.min(1, used));

      const elevation =
        -0.18 +
        bankSlope +
        duneWeight * (0.16 + 0.14 * Math.sin(wy * 0.35)) +
        quarryBand * 0.28 +
        rockWeight * (0.55 + Math.max(0, effRidge - 0.68) * 3.8);

      return {
        elevation,
        moisture,
        signedWaterDist,
        layerWeights: {
          bank: bankWeight,
          grass: grassWeight,
          sand: sandWeight,
          dune: duneWeight,
          rock: rockWeight,
          quarry: quarryBand,
          silt: siltWeight,
          dust: dustWeight,
        },
      };
    };

    return { startCenter, sampleTile, sampleCorner };
  },
};
