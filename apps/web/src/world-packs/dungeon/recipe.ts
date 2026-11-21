/* Subterranean Dungeon procedural terrain recipe (second world pack proving engine modularity).
   Generates vast excavatable bedrock pierced by natural caverns, glowing fungal pockets,
   ore veins, a continuous winding underground magma river and a carved central starting hall.
   Evaluated strictly in infinite world coordinates so edge expansion never shifts any tile or corner. */

import type { TileCoord } from '../../world/coords';
import type {
  CornerSample,
  PreparedTerrainRecipe,
  TerrainKindSpec,
  TerrainNoiseToolkit,
  TerrainRecipeSpec,
} from '../../world/manifest';

export const DUNGEON_TILE_KINDS: readonly TerrainKindSpec[] = [
  { id: 'solid_rock', label: { en: 'Solid bedrock (carvable)', ru: 'Сплошная порода (вырубается)' }, color: '#393B47', materialId: 'bedrock', buildable: false, walkable: false, excavatable: true },
  { id: 'rough_cavern', label: { en: 'Natural cavern', ru: 'Пещера' }, color: '#585A69', materialId: 'cavern_floor', buildable: true, walkable: true },
  { id: 'start_hall', label: { en: 'Central hall', ru: 'Стартовый зал' }, color: '#7D7A72', materialId: 'hall_stone', buildable: true, walkable: true },
  { id: 'lava', label: { en: 'Magma river', ru: 'Лавовая река' }, color: '#E85D1F', materialId: 'obsidian', buildable: false, walkable: false, liquid: true },
  { id: 'cooled_crust', label: { en: 'Obsidian shore', ru: 'Остывший базальт' }, color: '#2E262A', materialId: 'obsidian', buildable: false, walkable: true },
  { id: 'fungal_grove', label: { en: 'Fungal grove', ru: 'Светящиеся грибы' }, color: '#2F7F7A', materialId: 'fungal', buildable: false, walkable: true },
  { id: 'ore_vein', label: { en: 'Ore vein', ru: 'Рудная жила' }, color: '#998249', materialId: 'ore', buildable: false, walkable: false, excavatable: true },
];

export const DUNGEON_MATERIAL_IDS = [
  'bedrock',
  'cavern_floor',
  'hall_stone',
  'obsidian',
  'fungal',
  'ore',
] as const;

type DungeonSeedParams = Readonly<{
  origin: number;
  lavaCos: number;
  lavaSin: number;
  lavaOffset: number;
  amp1: number;
  freq1: number;
  phase1: number;
  amp2: number;
  freq2: number;
  phase2: number;
  lavaHalfW: number;
  cavernSeed: number;
  tunnelSeed: number;
  fungalSeed: number;
  oreSeed: number;
  startCenter: TileCoord;
  hallRadius: number;
}>;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function signedLavaDistance(params: Omit<DungeonSeedParams, 'startCenter'>, gx: number, gy: number): number {
  const dx = gx - params.origin;
  const dy = gy - params.origin;
  const along = dx * params.lavaCos + dy * params.lavaSin;
  const perp = -dx * params.lavaSin + dy * params.lavaCos;
  const center =
    params.lavaOffset +
    params.amp1 * Math.sin(along * params.freq1 + params.phase1) +
    params.amp2 * Math.sin(along * params.freq2 + params.phase2);
  const slope =
    params.amp1 * params.freq1 * Math.cos(along * params.freq1 + params.phase1) +
    params.amp2 * params.freq2 * Math.cos(along * params.freq2 + params.phase2);
  const halfW = params.lavaHalfW + 0.55 * Math.sin(along * 0.065 + params.phase2);
  return Math.abs(perp - center) / Math.sqrt(1 + slope * slope) - halfW;
}

function chooseCentralHall(params: Omit<DungeonSeedParams, 'startCenter'>, baseSize: number): TileCoord {
  const origin = Math.floor(baseSize / 2);
  const dOrigin = signedLavaDistance(params, origin, origin);
  /* Place the starting hall right at the map center unless magma cuts directly through it, in which case shift just beside the magma gorge. */
  if (dOrigin >= 11) return { col: origin, row: origin };

  let best: TileCoord = { col: origin, row: origin };
  let bestScore = -Infinity;
  for (let rad = 6; rad <= 26; rad += 2) {
    for (let i = 0; i < 16; i++) {
      const a = (i * Math.PI * 2) / 16;
      const col = Math.round(origin + Math.cos(a) * rad);
      const row = Math.round(origin + Math.sin(a) * rad);
      const dLava = signedLavaDistance(params, col, row);
      if (dLava < 10) continue;
      const score = -rad - Math.abs(dLava - 13) * 0.4;
      if (score > bestScore) {
        bestScore = score;
        best = { col, row };
      }
    }
    if (bestScore > -Infinity) break;
  }
  return best;
}

export const DUNGEON_TERRAIN_RECIPE: TerrainRecipeSpec = {
  id: 'dungeon-subterranean',
  name: { en: 'Subterranean Dungeon', ru: 'Подземелье (порода, пещеры, лава)' },
  tileKinds: DUNGEON_TILE_KINDS,
  materialIds: DUNGEON_MATERIAL_IDS,
  minBuildableRatio: 0.65,
  continuityKindIds: ['lava'],
  /* In a dungeon, city growth carves chambers out of solid bedrock. */
  countExcavatableAsOpen: true,
  prepare(numericSeed: number, baseSize: number, noise: TerrainNoiseToolkit): PreparedTerrainRecipe {
    const rng = noise.createRng(numericSeed);
    const origin = Math.floor(baseSize / 2);

    const theta = rng() * Math.PI;
    const lavaCos = Math.cos(theta);
    const lavaSin = Math.sin(theta);
    /* Keep magma stream slightly offset from dead center so the central starting hall sits dramatically beside the lava gorge. */
    const side = rng() < 0.5 ? -1 : 1;
    const lavaOffset = side * (12 + rng() * 9);
    const amp1 = 9 + rng() * 5;
    const freq1 = 0.044 + rng() * 0.02;
    const phase1 = rng() * Math.PI * 2;
    const amp2 = 2.5 + rng() * 2.0;
    const freq2 = 0.088 + rng() * 0.028;
    const phase2 = rng() * Math.PI * 2;
    const lavaHalfW = 2.35 + rng() * 0.65;
    const hallRadius = 6.2 + rng() * 1.4;

    const baseParams: Omit<DungeonSeedParams, 'startCenter'> = {
      origin,
      lavaCos,
      lavaSin,
      lavaOffset,
      amp1,
      freq1,
      phase1,
      amp2,
      freq2,
      phase2,
      lavaHalfW,
      cavernSeed: (numericSeed ^ 0x2468ace1) >>> 0,
      tunnelSeed: (numericSeed ^ 0x13579bdf) >>> 0,
      fungalSeed: (numericSeed ^ 0x369cf258) >>> 0,
      oreSeed: (numericSeed ^ 0x4826a19c) >>> 0,
      hallRadius,
    };

    const startCenter = chooseCentralHall(baseParams, baseSize);
    const params: DungeonSeedParams = { ...baseParams, startCenter };

    const evaluateCavernField = (gx: number, gy: number): { hallDist: number; cavernVal: number; tunnelVal: number; fungalVal: number; oreVal: number } => {
      const dx = gx - params.startCenter.col;
      const dy = gy - params.startCenter.row;
      const wobble = (noise.fbm2D(gx * 0.14, gy * 0.14, params.cavernSeed + 31, 2) - 0.5) * 2.4;
      const hallDist = Math.hypot(dx, dy) + wobble * 0.72 - params.hallRadius;
      const cavernVal = noise.fbm2D(gx * 0.036, gy * 0.036, params.cavernSeed, 3);
      const tunnelRidge = noise.ridgedFbm2D(gx * 0.026, gy * 0.026, params.tunnelSeed, 3);
      const fungalVal = noise.fbm2D(gx * 0.075, gy * 0.075, params.fungalSeed, 3);
      const oreVal = noise.fbm2D(gx * 0.095, gy * 0.095, params.oreSeed, 3);
      return { hallDist, cavernVal, tunnelVal: tunnelRidge, fungalVal, oreVal };
    };

    const sampleTile = (col: number, row: number): string => {
      const gx = col + 0.5;
      const gy = row + 0.5;
      const dLava = signedLavaDistance(params, gx, gy);
      if (dLava <= 0) return 'lava';
      if (dLava <= 1.8) return 'cooled_crust';

      const f = evaluateCavernField(gx, gy);
      if (f.hallDist <= 0) return 'start_hall';

      const isNaturalCavern = f.cavernVal > 0.625 || f.tunnelVal > 0.805;
      if (isNaturalCavern) {
        if (f.fungalVal > 0.62 && dLava > 6) return 'fungal_grove';
        return 'rough_cavern';
      }

      if (f.oreVal > 0.68 && dLava > 3.5) return 'ore_vein';
      return 'solid_rock';
    };

    const sampleCorner = (vx: number, vy: number): CornerSample => {
      const dLava = signedLavaDistance(params, vx, vy);
      const f = evaluateCavernField(vx, vy);

      const obsidianW = 1 - smoothstep(0.6, 2.5, Math.max(0, dLava));
      const hallW = (1 - smoothstep(-1.0, 1.4, f.hallDist)) * (1 - obsidianW);

      const cavernSignal = Math.max(
        smoothstep(0.585, 0.655, f.cavernVal),
        smoothstep(0.765, 0.835, f.tunnelVal),
      );
      const openCavern = cavernSignal * (1 - hallW) * (1 - obsidianW);
      const fungalW = openCavern * smoothstep(0.57, 0.67, f.fungalVal) * smoothstep(4, 8, dLava);
      const cavernFloorW = Math.max(0, openCavern - fungalW);

      const solidMask = Math.max(0, 1 - Math.min(1, obsidianW + hallW + openCavern));
      const oreW = solidMask * smoothstep(0.64, 0.72, f.oreVal) * smoothstep(2.5, 5.5, dLava);
      const bedrockW = Math.max(0.02, solidMask - oreW);

      /* Carved halls and caverns lie low; uncut bedrock rises steeply as cavern walls under top-left light. */
      const lavaDip = smoothstep(-1.2, 2.0, dLava) * 0.25;
      const wallLift = solidMask * (0.68 + 0.32 * noise.ridgedFbm2D(vx * 0.05, vy * 0.05, params.cavernSeed + 99, 2));
      const elevation = -0.22 + lavaDip + wallLift;
      const moisture = Math.max(fungalW, 1 - smoothstep(0, 8, Math.max(0, dLava)));

      return {
        elevation,
        moisture,
        signedWaterDist: dLava,
        layerWeights: {
          bedrock: bedrockW,
          cavern_floor: cavernFloorW,
          hall_stone: hallW,
          obsidian: obsidianW,
          fungal: fungalW,
          ore: oreW,
        },
      };
    };

    return { startCenter, sampleTile, sampleCorner };
  },
};
