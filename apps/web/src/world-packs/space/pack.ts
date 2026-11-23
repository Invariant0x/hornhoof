/* Orbital station test pack: the second world of Stage 9, written only against the engine's
   pack and art contracts. Adding it changed no engine file: its recipe, looks, palette, stage
   names and art slots all live here. */

import type { ResidentRoleClass } from '@hornhoof/protocol/world';
import type { WorldArtCatalog } from '../../world/art';
import {
  DEFAULT_CAMERA_BOUNDS,
  DEFAULT_CONSTRUCTION_STAGES,
  DEFAULT_ISOMETRIC_PROJECTION,
  type ConstructionStageSpec,
  type GroundMaterialSpec,
  type PackRoleLookSpec,
  type WorldPackManifest,
} from '../../world/manifest';
import { SPACE_TERRAIN_RECIPE, SPACE_TILE_KINDS } from './recipe';

const SPACE_ROLE_LOOKS: Readonly<Record<string, PackRoleLookSpec>> = {
  ruler: { id: 'space-admiral', label: { en: 'Fleet Admiral', ru: 'Адмирал флота' }, tunicColor: '#1E2A44', trimColor: '#F2C14E', prop: 'staff', headgear: 'crown', insignia: true },
  head: { id: 'space-officer', label: { en: 'Deck Officer', ru: 'Офицер палубы' }, tunicColor: '#2E3F63', trimColor: '#7FD1FF', prop: 'staff', headgear: 'circlet', insignia: true },
  checker: { id: 'space-inspector', label: { en: 'Systems Inspector', ru: 'Инспектор систем' }, tunicColor: '#D9DEE8', trimColor: '#3D7BD9', prop: 'scroll', headgear: 'cap' },
  builder: { id: 'space-engineer', label: { en: 'Module Engineer', ru: 'Инженер модулей' }, tunicColor: '#E07B39', trimColor: '#3A3F4A', prop: 'tool', headgear: 'helm' },
  gate_guard: { id: 'space-security', label: { en: 'Security Officer', ru: 'Офицер безопасности' }, tunicColor: '#3B3F4C', trimColor: '#E04F4F', prop: 'spear_shield', headgear: 'helm' },
  turnkey_specialist: { id: 'space-pilot', label: { en: 'Test Pilot', ru: 'Пилот-испытатель' }, tunicColor: '#F2F2F2', trimColor: '#E5B85C', prop: 'banner', headgear: 'helm', insignia: true },
  day_laborer: { id: 'space-contractor', label: { en: 'Dock Contractor', ru: 'Докер по контракту' }, tunicColor: '#8C8F99', trimColor: '#5C606B', prop: 'stone', headgear: 'cap' },
};

const SPACE_CLASS_FALLBACKS: Readonly<Record<ResidentRoleClass, PackRoleLookSpec>> = {
  ruler: SPACE_ROLE_LOOKS.ruler!,
  head: SPACE_ROLE_LOOKS.head!,
  checker: SPACE_ROLE_LOOKS.checker!,
  executor: SPACE_ROLE_LOOKS.builder!,
  turnkey: SPACE_ROLE_LOOKS.turnkey_specialist!,
  day_laborer: SPACE_ROLE_LOOKS.day_laborer!,
};

const SPACE_MATERIALS: readonly GroundMaterialSpec[] = [
  { id: 'void_edge', baseColor: '#121830', secondaryColor: '#0A0E1F', accentColor: '#28345C', pattern: 'fine_grain', contrast: 0.8 },
  { id: 'hull_plate', baseColor: '#5E6776', secondaryColor: '#474F5C', accentColor: '#7D8796', pattern: 'paved_stone', contrast: 1.1 },
  { id: 'deck_plate', baseColor: '#8E97A5', secondaryColor: '#757E8C', accentColor: '#A8B1BE', pattern: 'paved_stone', contrast: 1.0 },
  { id: 'grating', baseColor: '#A7B1C0', secondaryColor: '#8893A3', accentColor: '#C4CDD9', pattern: 'cut_stone', contrast: 1.15 },
  { id: 'command_floor', baseColor: '#C8D2DF', secondaryColor: '#AEB9C8', accentColor: '#7FD1FF', pattern: 'paved_stone', contrast: 1.05 },
  { id: 'garden', baseColor: '#3F8E68', secondaryColor: '#2D6B4D', accentColor: '#7BD39E', pattern: 'grass_tufts', contrast: 1.2 },
  { id: 'cargo_floor', baseColor: '#B4834F', secondaryColor: '#93683B', accentColor: '#D6A66C', pattern: 'furrows', contrast: 1.05 },
  { id: 'frame_truss', baseColor: '#3B414D', secondaryColor: '#272C35', accentColor: '#59606E', pattern: 'cracked_rock', contrast: 1.2 },
];

const SPACE_STAGE_LABELS: Readonly<Record<string, Readonly<{ en: string; ru: string }>>> = {
  stakes_and_rope: { en: 'Marker Beacons', ru: 'Маячки разметки' },
  foundation: { en: 'Docking Frame', ru: 'Стыковочная рама' },
  low_walls_open: { en: 'Open Module Frame', ru: 'Открытый каркас модуля' },
  waist_walls_scaffold: { en: 'Half Plated with Gantry', ru: 'Обшивка до половины, монтажная ферма' },
  full_walls: { en: 'Fully Plated', ru: 'Обшивка целиком' },
  roof_beams: { en: 'Roof Ribs', ru: 'Ребра купола' },
  roof: { en: 'Pressure Dome', ru: 'Герметичный купол' },
  finishing: { en: 'Lights and Markings', ru: 'Огни и разметка' },
  complete: { en: 'Module Online', ru: 'Модуль в строю' },
  upgraded: { en: 'Extended Module', ru: 'Расширенный модуль' },
};

const SPACE_CONSTRUCTION_STAGES: readonly ConstructionStageSpec[] = DEFAULT_CONSTRUCTION_STAGES.map(s => ({
  ...s,
  label: SPACE_STAGE_LABELS[s.id] ?? s.label,
}));

const SPACE_ART_CATALOG: WorldArtCatalog = {
  baseUrl: '/world-art/space/',
  buildings: {
    house: [
      { id: 'bunk_pod', footprint: '1x1', fromLevel: 1, label: { en: 'Bunk pod', ru: 'Спальная капсула' } },
      { id: 'cabin', footprint: '2x2', fromLevel: 4, label: { en: 'Cabin', ru: 'Каюта' } },
      { id: 'quarters', footprint: '3x3', fromLevel: 8, label: { en: 'Quarters', ru: 'Жилой блок' } },
      { id: 'suite', footprint: '4x4', fromLevel: 15, label: { en: 'Suite with a view', ru: 'Люкс с иллюминатором' } },
    ],
    department: [
      { id: 'lab', footprint: '3x3', fromStage: 1, label: { en: 'Lab module', ru: 'Лабораторный модуль' } },
      { id: 'wing', footprint: '4x4', fromStage: 4, label: { en: 'Research wing', ru: 'Научное крыло' } },
      { id: 'dome', footprint: '5x5', fromStage: 8, label: { en: 'Science dome', ru: 'Научный купол' } },
    ],
    residence: [
      { id: 'shuttle', footprint: '2x2', fromStage: 1, label: { en: 'Landed shuttle', ru: 'Посадочный челнок' } },
      { id: 'command_cabin', footprint: '3x3', fromStage: 2, label: { en: 'Command cabin', ru: 'Командная каюта' } },
      { id: 'bridge', footprint: '4x4', fromStage: 3, label: { en: 'Bridge', ru: 'Мостик' } },
      { id: 'flag_bridge', footprint: '5x5', fromStage: 4, label: { en: 'Flag bridge', ru: 'Флагманский мостик' } },
      { id: 'command_tower', footprint: '6x6', fromStage: 5, label: { en: 'Command tower', ru: 'Командная башня' } },
    ],
    district_hub: [
      { id: 'server_node', footprint: '3x3', fromStage: 1, label: { en: 'Server node', ru: 'Серверный узел' } },
      { id: 'server_hall', footprint: '4x4', fromStage: 2, label: { en: 'Server hall', ru: 'Серверный зал' } },
    ],
    supply: [{ id: 'fuel_tank', footprint: '3x3', label: { en: 'Fuel tank', ru: 'Топливный бак' } }],
    flophouse: [
      { id: 'crew_pods', footprint: '2x2', fromStage: 1, label: { en: 'Crew pods', ru: 'Капсулы экипажа' } },
      { id: 'crew_deck', footprint: '3x3', fromStage: 3, label: { en: 'Crew deck', ru: 'Палуба экипажа' } },
    ],
    statue: [
      { id: 'beacon', footprint: '1x1', label: { en: 'Beacon', ru: 'Маяк' } },
      { id: 'mast', footprint: '2x2', label: { en: 'Signal mast', ru: 'Сигнальная мачта' } },
      { id: 'monolith', footprint: '3x3', label: { en: 'Monolith', ru: 'Монолит' } },
    ],
    monument: [
      { id: 'antenna', footprint: '4x4', label: { en: 'Goal antenna', ru: 'Антенна цели' } },
      { id: 'array', footprint: '5x5', label: { en: 'Antenna array', ru: 'Антенная решетка' } },
      { id: 'deep_array', footprint: '6x6', label: { en: 'Deep space array', ru: 'Дальняя антенная решетка' } },
    ],
  },
  altar: true,
  flags: { district: true, department: true },
  people: { looks: [...new Set(Object.values(SPACE_ROLE_LOOKS).map(l => l.id))], tiers: 5 },
  loops: ['crane', 'hoist_block', 'dust', 'smoke', 'water', 'awning', 'celebration'],
};

export const SPACE_WORLD_PACK: WorldPackManifest = {
  id: 'space',
  name: { en: 'Orbital Station', ru: 'Орбитальная станция' },
  engine: 'isometric-2d',
  mapSize: 150,
  projection: DEFAULT_ISOMETRIC_PROJECTION,
  camera: DEFAULT_CAMERA_BOUNDS,
  defaultTileId: 'open_space',
  showGridByDefault: false,
  outerWallMode: 'none',
  altarAnchor: { offsetCol: 3, offsetRow: 2, label: { en: 'Signal shrine', ru: 'Сигнальный алтарь' } },
  roleLooks: SPACE_ROLE_LOOKS,
  classFallbackLooks: SPACE_CLASS_FALLBACKS,
  constructionStages: SPACE_CONSTRUCTION_STAGES,
  constructionPalette: {
    scaffoldWood: '#C9CED8',
    rampEarth: '#6B7383',
    dustColor: '#B9C6E0',
    smokeColor: '#7A8296',
    waterColor: '#7FD1FF',
    awningPrimary: '#3D7BD9',
    awningSecondary: '#E6ECF5',
    capstoneColor: '#7FD1FF',
    celebrationPrimary: '#F2C14E',
    celebrationSecondary: '#7FD1FF',
    statueBaseColor: '#7D8796',
    statueFinishedColor: '#B8E4FF',
  },
  tiles: SPACE_TILE_KINDS.map(k => ({ id: k.id, fill: k.color, stroke: k.color, buildable: k.buildable, walkable: k.walkable })),
  materials: SPACE_MATERIALS,
  liquidLayer: {
    baseColor: '#0B1026',
    deepColor: '#05081A',
    highlightColor: '#9FD8FF',
    shoreFoamColor: '#3A6EA8',
    shallowTintColor: '#16264F',
    speedX: 3,
    speedY: 1.5,
    glow: true,
  },
  terrainRecipe: SPACE_TERRAIN_RECIPE,
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
    backdrop: '#05081A',
    border: '#5E6B85',
    gridLine: 'rgba(200, 220, 255, 0.26)',
    chunkLine: 'rgba(200, 220, 255, 0.1)',
    hoverFill: 'rgba(127, 209, 255, 0.24)',
    hoverStroke: '#7FD1FF',
    selectFill: 'rgba(242, 193, 78, 0.34)',
    selectStroke: '#F2C14E',
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
    orderChaosDefault: 0.65,
  },
  art: SPACE_ART_CATALOG,
};
