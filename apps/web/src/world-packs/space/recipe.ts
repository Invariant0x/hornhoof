/* Orbital station terrain recipe (second test pack of Stage 9, built only on the engine's public contract).
   One large station floats in open space: an irregular outer hull with docking arms, ring corridors and
   spokes, garden bays, cargo bays, open frame the city builds new modules into, and the command deck
   at the start. Evaluated in world coordinates only, so growing the map edges never moves a tile. */

import type { TileCoord } from '../../world/coords';
import type {
  CornerSample,
  PreparedTerrainRecipe,
  TerrainKindSpec,
  TerrainNoiseToolkit,
  TerrainRecipeSpec,
} from '../../world/manifest';

export const SPACE_TILE_KINDS: readonly TerrainKindSpec[] = [
  { id: 'open_space', label: { en: 'Open space', ru: 'Открытый космос' }, color: '#0B1026', materialId: 'void_edge', buildable: false, walkable: false, liquid: true },
  { id: 'outer_hull', label: { en: 'Outer hull', ru: 'Внешняя обшивка' }, color: '#5A6372', materialId: 'hull_plate', buildable: false, walkable: true },
  { id: 'deck', label: { en: 'Deck', ru: 'Палуба' }, color: '#8C95A3', materialId: 'deck_plate', buildable: true, walkable: true },
  { id: 'corridor', label: { en: 'Corridor', ru: 'Коридор' }, color: '#A9B3C2', materialId: 'grating', buildable: true, walkable: true },
  { id: 'command_deck', label: { en: 'Command deck', ru: 'Командная палуба' }, color: '#C9D3E0', materialId: 'command_floor', buildable: true, walkable: true },
  { id: 'garden_bay', label: { en: 'Garden bay', ru: 'Оранжерея' }, color: '#3E8F6A', materialId: 'garden', buildable: false, walkable: true },
  { id: 'cargo_bay', label: { en: 'Cargo bay', ru: 'Грузовой отсек' }, color: '#B8834A', materialId: 'cargo_floor', buildable: true, walkable: true },
  { id: 'frame', label: { en: 'Open frame (new modules go here)', ru: 'Открытый каркас (сюда встают новые модули)' }, color: '#3A404C', materialId: 'frame_truss', buildable: false, walkable: false, excavatable: true },
];

export const SPACE_MATERIAL_IDS = [
  'void_edge',
  'hull_plate',
  'deck_plate',
  'grating',
  'command_floor',
  'garden',
  'cargo_floor',
  'frame_truss',
] as const;

type StationParams = Readonly<{
  origin: number;
  radius: number;
  arms: number;
  armPhase: number;
  armReach: number;
  ringStep: number;
  hullSeed: number;
  baySeed: number;
  cargoSeed: number;
  frameSeed: number;
  commandRadius: number;
}>;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/* Signed distance to open space: positive inside the station, negative outside. */
function hullDistance(p: StationParams, noise: TerrainNoiseToolkit, gx: number, gy: number): number {
  const dx = gx - p.origin;
  const dy = gy - p.origin;
  const r = Math.hypot(dx, dy);
  const theta = Math.atan2(dy, dx);
  const wobble = noise.fbm2D(Math.cos(theta) * 1.6 + 7, Math.sin(theta) * 1.6 + 7, p.hullSeed, 3);
  const arm = Math.pow(Math.max(0, Math.cos(p.arms * (theta - p.armPhase) * 0.5)), 24) * p.armReach;
  /* Open space always rings the station inside the base map, so it stays one field touching every edge. */
  return Math.min(p.radius * (0.86 + 0.22 * wobble) + arm, p.origin - 5) - r;
}

/* Distance to the nearest ring corridor or spoke, in tiles. */
function corridorDistance(p: StationParams, gx: number, gy: number): number {
  const dx = gx - p.origin;
  const dy = gy - p.origin;
  const r = Math.hypot(dx, dy);
  const ring = Math.abs(r - Math.max(1, Math.round(r / p.ringStep)) * p.ringStep);
  const theta = Math.atan2(dy, dx);
  const sector = (Math.PI * 2) / p.arms;
  const rel = (((theta - p.armPhase) % sector) + sector) % sector;
  const spoke = Math.min(rel, sector - rel) * r;
  return Math.min(ring, spoke);
}

export const SPACE_TERRAIN_RECIPE: TerrainRecipeSpec = {
  id: 'space-station',
  name: { en: 'Orbital station', ru: 'Орбитальная станция' },
  tileKinds: SPACE_TILE_KINDS,
  materialIds: SPACE_MATERIAL_IDS,
  minBuildableRatio: 0.38,
  /* The station grows by building new modules into its open frame. */
  countExcavatableAsOpen: true,
  prepare(numericSeed: number, baseSize: number, noise: TerrainNoiseToolkit): PreparedTerrainRecipe {
    const rng = noise.createRng(numericSeed);
    const origin = Math.floor(baseSize / 2);
    const params: StationParams = {
      origin,
      radius: baseSize * (0.41 + rng() * 0.03),
      arms: 3 + Math.floor(rng() * 3),
      armPhase: rng() * Math.PI * 2,
      armReach: 8 + rng() * 6,
      ringStep: 11 + rng() * 4,
      hullSeed: (numericSeed ^ 0x51a7e0c1) >>> 0,
      baySeed: (numericSeed ^ 0x2b9d3f17) >>> 0,
      cargoSeed: (numericSeed ^ 0x7c3e9a55) >>> 0,
      frameSeed: (numericSeed ^ 0x1d6f4b83) >>> 0,
      commandRadius: 5.5 + rng() * 1.5,
    };
    const startCenter: TileCoord = { col: origin, row: origin };

    const fields = (gx: number, gy: number) => {
      const hull = hullDistance(params, noise, gx, gy);
      const command = Math.hypot(gx - origin, gy - origin) - params.commandRadius;
      const corridor = corridorDistance(params, gx, gy);
      const bay = noise.fbm2D(gx * 0.07, gy * 0.07, params.baySeed, 3);
      const cargo = noise.fbm2D(gx * 0.06, gy * 0.06, params.cargoSeed, 3);
      const frame = noise.fbm2D(gx * 0.045, gy * 0.045, params.frameSeed, 3);
      return { hull, command, corridor, bay, cargo, frame };
    };

    const sampleTile = (col: number, row: number): string => {
      const f = fields(col + 0.5, row + 0.5);
      if (f.hull <= 0) return 'open_space';
      if (f.hull <= 1.6) return 'outer_hull';
      if (f.command <= 0) return 'command_deck';
      if (f.corridor <= 0.8) return 'corridor';
      if (f.frame < 0.34) return 'frame';
      if (f.bay > 0.64) return 'garden_bay';
      if (f.cargo > 0.66) return 'cargo_bay';
      return 'deck';
    };

    const sampleCorner = (vx: number, vy: number): CornerSample => {
      const f = fields(vx, vy);
      const inside = smoothstep(-0.6, 0.6, f.hull);
      const hullRim = inside * (1 - smoothstep(1.0, 2.4, f.hull));
      const body = inside * (1 - hullRim);
      const command = body * (1 - smoothstep(-1.0, 1.0, f.command));
      const corridor = body * (1 - command) * (1 - smoothstep(0.5, 1.3, f.corridor));
      const rest = Math.max(0, body - command - corridor);
      const frame = rest * (1 - smoothstep(0.3, 0.38, f.frame));
      const garden = (rest - frame) * smoothstep(0.6, 0.68, f.bay);
      const cargo = (rest - frame - garden) * smoothstep(0.62, 0.7, f.cargo);
      const deck = Math.max(0.02 * inside, rest - frame - garden - cargo);
      return {
        elevation: 0.05 * inside + 0.12 * hullRim - 0.06 * frame,
        moisture: garden,
        signedWaterDist: f.hull,
        layerWeights: {
          void_edge: Math.max(0.0001, 1 - inside),
          hull_plate: hullRim,
          deck_plate: deck,
          grating: corridor,
          command_floor: command,
          garden,
          cargo_floor: cargo,
          frame_truss: frame,
        },
      };
    };

    return { startCenter, sampleTile, sampleCorner };
  },
};
