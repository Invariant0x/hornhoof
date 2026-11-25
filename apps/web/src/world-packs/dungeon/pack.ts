/* Subterranean Dungeon world pack manifest: proves a completely non-river world
   (bedrock, caverns, glowing magma river, fungal groves, ore veins, carved central hall)
   runs on the exact same engine with zero engine modifications. */

import type { ResidentRoleClass } from '@hornhoof/protocol/world';
import {
  DEFAULT_CAMERA_BOUNDS,
  DEFAULT_CONSTRUCTION_STAGES,
  DEFAULT_ISOMETRIC_PROJECTION,
  type ConstructionStageSpec,
  type GroundMaterialSpec,
  type PackRoleLookSpec,
  type WorldPackManifest,
} from '../../world/manifest';
import { DUNGEON_TERRAIN_RECIPE, DUNGEON_TILE_KINDS } from './recipe';
import { text } from '../../world/pack-text';

const DUNGEON_ROLE_LOOKS: Readonly<Record<string, PackRoleLookSpec>> = {
  ruler: {
    id: 'dungeon-archmage',
    label: text('Delve Lord'),
    prop: 'staff',
    headgear: 'crown',
    insignia: true,
  },
  head: {
    id: 'dungeon-foreman',
    label: text('Hall Foreman'),
    prop: 'staff',
    headgear: 'circlet',
    insignia: true,
  },
  guard_captain: {
    id: 'dungeon-warden',
    label: text('Gate Warden'),
    prop: 'staff',
    headgear: 'helm',
    insignia: true,
  },
  checker: {
    id: 'dungeon-rune-checker',
    label: text('Rune Inspector'),
    prop: 'scroll',
    headgear: 'hood',
  },
  builder: {
    id: 'dungeon-delver',
    label: text('Stone Delver'),
    prop: 'stone',
    headgear: 'helm',
  },
  turnkey_specialist: {
    id: 'dungeon-master-delver',
    label: text('Guild Artificer'),
    prop: 'banner',
    headgear: 'hood',
    insignia: true,
  },
  day_laborer: {
    id: 'dungeon-drifter',
    label: text('Tunnel Drifter'),
    prop: 'stone',
    headgear: 'none',
  },
};

const DUNGEON_CLASS_FALLBACKS: Readonly<Record<ResidentRoleClass, PackRoleLookSpec>> = {
  ruler: DUNGEON_ROLE_LOOKS.ruler!,
  head: DUNGEON_ROLE_LOOKS.head!,
  checker: DUNGEON_ROLE_LOOKS.checker!,
  executor: DUNGEON_ROLE_LOOKS.builder!,
  turnkey: DUNGEON_ROLE_LOOKS.turnkey_specialist!,
  day_laborer: DUNGEON_ROLE_LOOKS.day_laborer!,
};

const DUNGEON_MATERIALS: readonly GroundMaterialSpec[] = [
  {
    id: 'bedrock',
    baseColor: '#3D404E',
    secondaryColor: '#252731',
    accentColor: '#5B6073',
    pattern: 'cracked_rock',
    contrast: 1.25,
  },
  {
    id: 'cavern_floor',
    baseColor: '#5F6170',
    secondaryColor: '#484A58',
    accentColor: '#7B7E90',
    pattern: 'fine_grain',
    contrast: 1.0,
  },
  {
    id: 'hall_stone',
    baseColor: '#848078',
    secondaryColor: '#67635B',
    accentColor: '#A9A49A',
    pattern: 'paved_stone',
    contrast: 1.15,
  },
  {
    id: 'obsidian',
    baseColor: '#36292D',
    secondaryColor: '#21181B',
    accentColor: '#69392C',
    pattern: 'cracked_rock',
    contrast: 1.2,
  },
  {
    id: 'fungal',
    baseColor: '#2F6E6D',
    secondaryColor: '#224E52',
    accentColor: '#64E3CE',
    pattern: 'moss_glow',
    contrast: 1.3,
  },
  {
    id: 'ore',
    baseColor: '#6E5E44',
    secondaryColor: '#413B38',
    accentColor: '#E5B952',
    pattern: 'moss_glow',
    contrast: 1.3,
  },
];

const DUNGEON_STAGE_LABELS: Readonly<Record<string, string>> = {
  stakes_and_rope: text('Chalk Marks & Iron Pitons'),
  foundation: text('Basalt Floor Slab'),
  low_walls_open: text('Cut Vault Partitions (Open Chambers)'),
  waist_walls_scaffold: text('Ashlar Walls, Iron Scaffold & Ramp'),
  full_walls: text('Full Cavern Buttresses'),
  roof_beams: text('Forged Iron Vault Ribs'),
  roof: text('Sealed Stone Vault'),
  finishing: text('Runic Carving & Brazier Trim'),
  complete: text('Completed Subterranean Hall'),
  upgraded: text('Crystal Spire & Runic Annex'),
};

const DUNGEON_CONSTRUCTION_STAGES: readonly ConstructionStageSpec[] = DEFAULT_CONSTRUCTION_STAGES.map(s => ({
  ...s,
  label: DUNGEON_STAGE_LABELS[s.id] ?? s.label,
}));

export const DUNGEON_WORLD_PACK: WorldPackManifest = {
  id: 'dungeon',
  name: text('Subterranean Dungeon'),
  engine: 'isometric-2d',
  mapSize: 150,
  projection: DEFAULT_ISOMETRIC_PROJECTION,
  camera: DEFAULT_CAMERA_BOUNDS,
  defaultTileId: 'solid_rock',
  showGridByDefault: false,
  outerWallMode: 'none',
  altarAnchor: {
    offsetCol: -3,
    offsetRow: 2,
    label: text('Runic Shrine'),
  },
  roleLooks: DUNGEON_ROLE_LOOKS,
  classFallbackLooks: DUNGEON_CLASS_FALLBACKS,
  constructionStages: DUNGEON_CONSTRUCTION_STAGES,
  tiles: DUNGEON_TILE_KINDS.map(k => ({
    id: k.id,
    fill: k.color,
    stroke: k.color,
    buildable: k.buildable,
    walkable: k.walkable,
  })),
  materials: DUNGEON_MATERIALS,
  /* Building lots are dressed hall stone; fungus creeps back over an empty one in a week. */
  lotGround: { material: 'hall_stone', edgeTiles: 0.4, regrowthHours: 168 },
  liquidLayer: {
    baseColor: '#E85D1F',
    deepColor: '#9E240F',
    highlightColor: '#FFD65C',
    shoreFoamColor: '#FF9E3D',
    shallowTintColor: '#C43E18',
    speedX: 11,
    speedY: -7,
    glow: true,
  },
  terrainRecipe: DUNGEON_TERRAIN_RECIPE,
  sprites: [],
  stageCounts: {
    house: 10,
    department: 10,
    district: 30,
    residence: 5,
    statue: 20,
    monument: 10,
    flophouse: 6,
    construction: 10,
  },
  palette: {
    backdrop: '#111118',
    border: '#72758C',
    gridLine: 'rgba(215, 224, 245, 0.28)',
    chunkLine: 'rgba(215, 224, 245, 0.12)',
    hoverFill: 'rgba(100, 227, 206, 0.24)',
    hoverStroke: '#64E3CE',
    selectFill: 'rgba(255, 209, 102, 0.34)',
    selectStroke: '#FFD166',
    providers: {
      claude: '#C96A4B',
      codex: '#3FA796',
      antigravity: '#4DA167',
      kimi: '#4C84D6',
      glm: '#766BD6',
      api_key: '#B89B5E',
    },
  },
  params: {
    chunkSize: 4,
    orderChaosDefault: 0.35,
  },
};
