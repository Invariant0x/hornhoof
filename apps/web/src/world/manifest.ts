/* Universal world pack manifest contract for the isometric world engine.
   Contains zero theme-specific words, files or colours; every concrete world supplies its own manifest,
   materials, liquid layer and procedural terrain recipe. */

import type { ResidentRoleClass, RoleArchetype } from '@hornhoof/protocol/world';
import { validateArtCatalog, type WorldArtCatalog } from './art';
import type { TileCoord } from './coords';

export type EngineKind = 'isometric-2d' | '3d';
export type OuterWallMode = 'ring' | 'none';

export type RolePropKind =
  | 'stone'
  | 'scroll'
  | 'staff'
  | 'tool'
  | 'spear_shield'
  | 'water_jar'
  | 'gong'
  | 'key'
  | 'chisel'
  | 'banner'
  | 'none';

export type RoleHeadgearKind = 'none' | 'cap' | 'hood' | 'helm' | 'crown' | 'circlet';

export type PackRoleLookSpec = Readonly<{
  id: string;
  label: Readonly<{ en: string; ru: string }>;
  tunicColor: string;
  trimColor: string;
  prop: RolePropKind;
  headgear: RoleHeadgearKind;
  insignia?: boolean;
  /* Its prop is a large item held in one hand or on one shoulder (a staff, a banner, a jar): a mirrored row would move
     it to the other side, so its walk is drawn in the 4 diagonals NE, SE, SW and NW and its idle in SE and SW (order v3 4.4). */
  largeItem?: boolean;
}>;

/* Building kinds the city engine places; a pack's layout rules and stage counts refer to them. */
export const CITY_BUILDING_KINDS = [
  'residence',
  'monument',
  'department',
  'district_hub',
  'supply',
  'house',
  'statue',
  'flophouse',
] as const;

export type CityBuildingKind = (typeof CITY_BUILDING_KINDS)[number];

/* The two walls that face the viewer in the 2:1 projection. They meet at the plot's front (bottom) corner:
   the front-right wall runs along the plot's last column, the front-left wall along its last row. */
export type FrontWall = 'front_right' | 'front_left';

/* How the artist drew a building kind: which front wall holds the door and at which tile row of that wall,
   counted from the front corner (0 = the row at the corner). The building keeps its front corner while it
   grows through spans (square sizes in tiles, one per growth step of the kind, never smaller than the one
   before, so a kind may keep a size for two steps); the last span is its lot. */
export type BuildingLayoutSpec = Readonly<{
  door: Readonly<{ wall: FrontWall; fromFront: number }>;
  spans: readonly number[];
}>;

export type BuildingLayoutRules = Readonly<Partial<Record<CityBuildingKind, BuildingLayoutSpec>>>;

export type AltarAnchorSpec = Readonly<{
  offsetCol: number;
  offsetRow: number;
  label?: Readonly<{ en: string; ru: string }>;
}>;

export const CONSTRUCTION_STAGE_IDS = [
  'stakes_and_rope',
  'foundation',
  'low_walls_open',
  'waist_walls_scaffold',
  'full_walls',
  'roof_beams',
  'roof',
  'finishing',
  'complete',
  'upgraded',
] as const;

export type ConstructionStageId = (typeof CONSTRUCTION_STAGE_IDS)[number];

export type BuildingLoopKind =
  | 'crane'
  | 'hoist_block'
  | 'dust'
  | 'smoke'
  | 'water'
  | 'awning'
  | 'celebration';

export type WorkSlotAction =
  | 'interior_mason'
  | 'hammer_scaffold'
  | 'carry_ramp'
  | 'pull_sled'
  | 'carve_statue'
  | 'demolish_rubble';

export type ConstructionStageSpec = Readonly<{
  stage: number;
  id: ConstructionStageId;
  label: Readonly<{ en: string; ru: string }>;
  heightRatio: number;
  openInteriorVisible: boolean;
  hasScaffolding: boolean;
  hasRamp: boolean;
  hasRoofBeams: boolean;
  hasRoof: boolean;
  hasFinishing: boolean;
  hasUpgrades: boolean;
  defaultLoops: readonly BuildingLoopKind[];
}>;

export type ConstructionPaletteSpec = Readonly<{
  scaffoldWood: string;
  rampEarth: string;
  dustColor: string;
  smokeColor: string;
  waterColor: string;
  awningPrimary: string;
  awningSecondary: string;
  capstoneColor: string;
  celebrationPrimary: string;
  celebrationSecondary: string;
  statueBaseColor: string;
  statueFinishedColor: string;
}>;

export type Direction8 = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';
export type UniqueRenderAngle5 = 'N' | 'NE' | 'E' | 'SE' | 'S';
export type LodTierId = '1x' | '2x' | '4x' | '8x';
export type AnimationDetailLevel = 'reduced' | 'standard' | 'full';
export type FootprintKey = '1x1' | '2x2' | '3x3' | '4x4' | '5x5' | '6x6';

export type LodTierSpec = Readonly<{
  id: LodTierId;
  tileW: number;
  tileH: number;
  humanHeightPx: number;
  rigSourceHumanHeightPx?: number;
  animationDetail: AnimationDetailLevel;
}>;

export type FootprintMetrics = Readonly<{
  diamondW: number;
  diamondH: number;
  doorHeightPx: number;
  maxCanvasH: number;
}>;

export type CameraBoundsSpec = Readonly<{
  /* Zoom relative to default 100% (1.0 = 120x60 CSS px): 0.5 = 50% (60x30), 2.0 = 200% (240x120). */
  minZoom: number;
  defaultZoom: number;
  maxZoom: number;
}>;

export type ProjectionSpec = Readonly<{
  type: 'dimetric_2_to_1';
  tileRatioWToH: number;
  diamondAngleDeg: number;
  cameraElevationDeg: number;
  /* Logical world tile dimensions at 100% default zoom (120 x 60 CSS px). */
  defaultTileW: number;
  defaultTileH: number;
  sun: Readonly<{
    direction: 'top_left';
    azimuthDeg: number;
    elevationDeg: number;
    kelvin: number;
  }>;
  /* Sorted ascending by tileW; 8x (480x240) provides 2x Retina crispness at 200% (240x120 CSS px). */
  lods: readonly LodTierSpec[];
  buildingFootprintsMaster4x: Readonly<Record<FootprintKey, FootprintMetrics>>;
  directions: Readonly<{
    order: readonly Direction8[];
    uniqueRenderAngles: readonly UniqueRenderAngle5[];
    horizontalMirrors: Readonly<Record<'SW' | 'W' | 'NW', UniqueRenderAngle5>>;
  }>;
}>;

/* Discrete terrain tile visual slot declared by a world pack (used by stub packs and pick readouts). */
export type TileSlotSpec = Readonly<{
  id: string;
  fill: string;
  stroke: string;
  accent?: string;
  buildable: boolean;
  walkable: boolean;
}>;

/* Procedural placeholder texture pattern replaced later by artist-authored seamless PNG textures. */
export type GroundTexturePattern =
  | 'fine_grain'
  | 'grass_tufts'
  | 'furrows'
  | 'wind_ripples'
  | 'cracked_rock'
  | 'cut_stone'
  | 'moss_glow'
  | 'paved_stone'
  | 'soil_clods'
  | 'packed_dust'
  | 'crop_rows';

/* Fields laid out as rectangular plots along the tile axes: each plot has rows running one way or the other, a raised
   strip of earth around it and, along some edges, a narrow irrigation ditch. Sizes are in tiles. */
export type GroundPlotSpec = Readonly<{
  sizeU: number;
  sizeV: number;
  ridgeColor: string;
  ditchColor?: string;
  /* Material id of the margin around tilled plots: plots are tilled only where this ground and the plot's own cover
     the plot's corners, and untilled plot ground next to a tilled plot turns into it. */
  margin?: string;
  /* Material id that untilled plot ground turns into away from the tilled plots. Without it, it is left out. */
  fallow?: string;
}>;

/* Seamless tileable ground material blended across smooth corner-field masks during chunk baking. */
export type GroundMaterialSpec = Readonly<{
  id: string;
  baseColor: string;
  secondaryColor: string;
  accentColor: string;
  pattern: GroundTexturePattern;
  scalePx?: number;
  contrast?: number;
  edgeNoiseWeight?: number;
  textureUrl?: string;
  /* Wind ripples drawn across this ground in world space and lit by the sun, in [0, 1]; dry ground only. */
  ripples?: number;
  plots?: GroundPlotSpec;
}>;

/* Painted ground art of a pack, paths relative to its art folder (art.baseUrl). Textures are seamless and seen from
   straight above; the engine projects them onto the 2:1 ground. Anything missing keeps the procedural look. */
export type TerrainArtSpec = Readonly<{
  /* Material id -> seamless square texture. */
  ground: Readonly<Record<string, string>>;
  /* Texels of a ground texture along one tile. */
  texelsPerTile: number;
  /* 'first|second' material ids -> grayscale edge mask: 255 is the first ground, 0 the second; rows run across the edge,
     one tile over texelsPerTile rows centred on the edge, columns along it and wrap. */
  edges?: Readonly<Record<string, string>>;
  /* Mask for any pair not listed. */
  defaultEdge?: string;
  /* Mask of the waterline: 255 is liquid, 0 is land, same rows and columns as the edges. */
  shoreEdge?: string;
  /* Liquid painted in layers: the bed's relief (no water tint) and a grey ripple map with mean 128, over the base colour;
     surface is the still look of the water, used for narrow channels. */
  liquid?: Readonly<{ bed: string; ripples: string; surface?: string; baseColor: string }>;
  /* Strip for worn paths: columns along the path (wrapping), rows across it, transparent at both long edges. */
  pathStrip?: string;
  /* City streets by tier, strips like pathStrip: texelsPerTile columns per tile, a street as wide as the strip is tall.
     With all four the city paints its streets on the ground instead of drawing street tiles. */
  roads?: Readonly<Partial<Record<'trail' | 'dirt' | 'brick' | 'stone', string>>>;
}>;

/* Ground under a building's lot: the city clears it from the first construction stage, eases its edge into the land
   around and keeps it cleared after a demolition until another building takes the lot or the regrowth time is over. */
export type LotGroundSpec = Readonly<{
  /* Material id the cleared lot is drawn with: packed earth, bare sand or a floor, never grass or crops. */
  material: string;
  /* Width in tiles of the soft edge outside the footprint over which the cleared ground fades into the land. */
  edgeTiles: number;
  /* Hours after a building left a lot before the land grows back over it, when nothing was built there. */
  regrowthHours: number;
}>;

/* Worn footpaths over open ground: thin winding lines with cart ruts and footprints, on the listed materials only. */
export type GroundPathSpec = Readonly<{
  color: string;
  rutColor: string;
  widthTiles: number;
  spacingTiles: number;
  materials: readonly string[];
}>;

/* Separate animated liquid layer rendered beneath alpha-cutout terrain chunks. */
export type LiquidLayerSpec = Readonly<{
  baseColor: string;
  deepColor: string;
  highlightColor: string;
  shoreFoamColor: string;
  shallowTintColor: string;
  speedX: number;
  speedY: number;
  glow?: boolean;
  /* How dark the middle of a wide stretch of liquid gets, in [0, 1]; the shallows stay light. Off when absent. */
  depthShade?: number;
}>;

/* Generic plant silhouettes the engine can draw procedurally from a pack's palette. Artists replace them later with
   sprite art (see PlantArtSpec); the silhouette names describe geometry only, never a species or a biome. */
export type PlantShape =
  | 'fronded_tree'
  | 'blade_cluster'
  | 'umbel_reed'
  | 'round_shrub'
  | 'broad_tree'
  | 'stone_cluster';

/* Where inside a plant image its parts are, in image pixels with y pointing down. */
export type PlantPassport = Readonly<{
  /* Where the plant meets the ground: the sway pivot and the depth-sorting point. */
  rootPoint: readonly [number, number];
  /* Middle of the crown, used for wind flutter and for the shadow's widest point. */
  crownCenter: readonly [number, number];
  /* Where the crown attaches to the stem; the crown flutters around this point. */
  crownHub: readonly [number, number];
  heightPx: number;
  crownWidthPx: number;
}>;

/* Painted picture of one plant variant, paths relative to the pack's art folder (art.baseUrl): the RGBA image, an
   optional grayscale wind-weight map of the same size (0 = rooted, 1 = free) and the passport JSON beside it with
   root_point, crown_center, crown_hub, height_px and crown_width_px in the image's own pixels. */
export type PlantArtSpec = Readonly<{
  image: string;
  windMask?: string;
  passport?: string;
}>;

export type PlantRange = Readonly<{ min: number; max: number }>;

/* Pack-owned plant kind: what it looks like, where it may grow and how the wind moves it. */
export type PlantKindSpec = Readonly<{
  id: string;
  label: Readonly<{ en: string; ru: string }>;
  /* Procedural silhouette, used when no art is supplied. */
  shape: PlantShape;
  /* Painted variants; when they load they replace the procedural silhouette. */
  art?: readonly PlantArtSpec[];
  /* Lies flat on the ground (pebbles, tracks, small tufts): no cast shadow, no reflection, drawn under standing plants. */
  flat?: boolean;
  /* Tile kind ids (from the pack's terrain recipe) where this kind may stand. */
  tileKinds: readonly string[];
  /* Chance per tile when every suitability term is 1. */
  density: number;
  /* Smooth windows over the corner fields; chance fades toward the edges of each window. */
  moisture: PlantRange;
  /* Signed distance to liquid in tiles: positive on land, near zero at the waterline. */
  waterDist: PlantRange;
  /* Highest blend weight each ground material may have at the exact spot (keeps plants off bare rock and quarries). */
  materialCaps?: Readonly<Record<string, number>>;
  /* 0 = even spread, 1 = tight groves; clumpScale is the grove size in tiles. */
  clumping: number;
  clumpScale: number;
  /* Tiles around a plant that no plant of lower priority may take. */
  spacing: number;
  /* Wins conflicts between kinds and decides depth ties. */
  priority: number;
  /* Plants per chosen tile: reeds come in beds. */
  clusterSize?: PlantRange;
  /* Tiles around the chosen tile that a bed spreads over. */
  clusterRadius?: number;
  /* Spreads the kind evenly instead of by chance per tile: at most one plant in each cell of this many tiles a side,
     at a random spot inside it, where the ground fits. Density is then the chance per cell. */
  evenCell?: number;
  /* Grounds the plant needs: their blend weights at the spot must add up to at least 0.35. */
  onMaterials?: readonly string[];
  /* Height at 100% zoom in px, picked per plant. */
  heightPx: PlantRange;
  palette: Readonly<{ primary: string; secondary: string; accent: string; trunk?: string }>;
  /* Wind response: amplitude scales the lean, frequency is in Hz, flutter scales the crown's fast shiver. */
  sway: Readonly<{ amplitude: number; frequency: number; flutter: number }>;
  /* Different drawings per kind so a grove does not repeat one image. */
  variants: number;
}>;

/* Wind field shared by every plant: a steady breeze plus gust fronts that travel across the map. */
export type WindSpec = Readonly<{
  /* Direction the wind blows toward on screen, degrees: 0 = right, 90 = down. */
  directionDeg: number;
  /* Steady lean of a plant with sway amplitude 1, in [0, 1]. */
  baseStrength: number;
  /* Extra lean while a gust front passes, in [0, 1]. */
  gustStrength: number;
  /* How fast a gust front travels, tiles per second. */
  gustSpeed: number;
  /* Size of a gust front, tiles. */
  gustScale: number;
}>;

/* Light and shadow for plants and later buildings and people. The sun position comes from the projection. */
export type LightingSpec = Readonly<{
  shadowColor: string;
  /* Opacity of a plant's cast shadow at its darkest, in [0, 1]. */
  shadowAlpha: number;
  /* Shadow length as a multiple of the plant's height. */
  shadowLength: number;
  /* Warm tint multiplied over sunlit ground, '#ffffff' for none. */
  sunTint: string;
}>;

/* Pack-owned terrain tile category with gameplay rules and legend metadata. */
export type TerrainKindSpec = Readonly<{
  id: string;
  label: Readonly<{ en: string; ru: string }>;
  color: string;
  materialId: string;
  buildable: boolean;
  walkable: boolean;
  liquid?: boolean;
  excavatable?: boolean;
}>;

/* Smooth continuous values evaluated at each tile corner vertex (vCol, vRow). */
export type CornerSample = Readonly<{
  elevation: number;
  moisture: number;
  /* Signed distance to liquid boundary: < 0 inside liquid, 0 smooth shoreline, > 0 solid ground. */
  signedWaterDist: number;
  /* Blend weight per pack materialId (normalized to sum to 1 by the engine). */
  layerWeights: Readonly<Record<string, number>>;
}>;

/* Deterministic noise toolkit supplied by the engine to any pack's terrain recipe. */
export type TerrainNoiseToolkit = Readonly<{
  hashSeed: (seed: string | number) => number;
  createRng: (seed: number) => () => number;
  hash2i: (ix: number, iy: number, seed: number) => number;
  valueNoise2D: (x: number, y: number, seed: number) => number;
  fbm2D: (x: number, y: number, seed: number, octaves?: number, lacunarity?: number, gain?: number) => number;
  ridgedFbm2D: (x: number, y: number, seed: number, octaves?: number, lacunarity?: number, gain?: number) => number;
}>;

/* Prepared per-seed terrain evaluator returned by a world pack's recipe.
   Must evaluate purely in infinite world coordinates so edge expansion never shifts existing tiles or corners. */
export type PreparedTerrainRecipe = Readonly<{
  startCenter: TileCoord;
  sampleTile: (col: number, row: number) => string;
  sampleCorner: (vertexCol: number, vertexRow: number) => CornerSample;
}>;

/* Pack-owned procedural world generation recipe. */
export type TerrainRecipeSpec = Readonly<{
  id: string;
  name: Readonly<{ en: string; ru: string }>;
  tileKinds: readonly TerrainKindSpec[];
  materialIds: readonly string[];
  minBuildableRatio: number;
  /* Optional tile kind IDs that must form a single continuous edge-to-edge network (e.g. waterways). */
  continuityKindIds?: readonly string[];
  /* When true, excavatable solid rock counts toward the pack's expansion space budget. */
  countExcavatableAsOpen?: boolean;
  prepare: (numericSeed: number, baseSize: number, noise: TerrainNoiseToolkit) => PreparedTerrainRecipe;
}>;

/* Optional sprite sheet reference declared by a world pack (empty in pure geometric stub packs). */
export type SpriteAtlasSpec = Readonly<{
  id: string;
  url: string;
  maxSourceTileW?: number;
}>;

/* Stage counts declared by a world pack; the engine adapts to any positive integers. */
export type StageCountsSpec = Readonly<{
  house: number;
  department: number;
  district: number;
  residence: number;
  statue: number;
  monument: number;
  flophouse: number;
  construction: number;
}>;

export type WorldPaletteSpec = Readonly<{
  backdrop: string;
  border: string;
  gridLine: string;
  chunkLine: string;
  hoverFill: string;
  hoverStroke: string;
  selectFill: string;
  selectStroke: string;
  providers: Readonly<Record<string, string>>;
}>;

export type WorldEngineParamsSpec = Readonly<{
  chunkSize: number;
  orderChaosDefault: number;
}>;

/* Where the work comes from (#2006): the liquids cargo boats sail, and how many blocks one deck shows. */
export type HarbourSpec = Readonly<{
  /* Liquid tile kinds boats sail on. With none, or none of them on the map, the work comes by caravan through a gate. */
  boatLiquids?: readonly string[];
  /* The most stone blocks one boat or caravan shows, 1 to 4 (Design: one row, never stacked); 4 when unset. */
  boatCargoMax?: number;
}>;

export type WorldPackManifest = Readonly<{
  id: string;
  name: Readonly<{ en: string; ru: string }>;
  engine: EngineKind;
  /* Single map dimension N for an N x N diamond tile grid. */
  mapSize: number;
  projection: ProjectionSpec;
  camera: CameraBoundsSpec;
  defaultTileId: string;
  tiles: readonly TileSlotSpec[];
  sprites: readonly SpriteAtlasSpec[];
  stageCounts: StageCountsSpec;
  palette: WorldPaletteSpec;
  params: WorldEngineParamsSpec;
  /* Smooth blended ground packs set showGridByDefault: false so the grid appears only in build mode. */
  showGridByDefault?: boolean;
  /* Whether the city builds an expanding outer wall ring ('ring', default) or relies on natural boundaries ('none'). */
  outerWallMode?: OuterWallMode;
  /* Door wall, door row and growth sizes per building kind, as the art draws them; kinds left out keep the
     engine's sizes and take the door on whichever front wall reaches the street best. */
  buildingLayout?: BuildingLayoutRules;
  /* Dedicated shrine/altar offset near the ruler residence where agents waiting for a human stand with a scroll. */
  altarAnchor?: AltarAnchorSpec;
  /* The harbour the tasks arrive at (#2006); a pack without it brings the work by caravan. */
  harbour?: HarbourSpec;
  /* Pack-owned visual looks keyed by Hornhoof roleKey or generic archetype, plus per-class fallback looks. */
  roleLooks?: Readonly<Record<string, PackRoleLookSpec>>;
  classFallbackLooks?: Readonly<Record<ResidentRoleClass, PackRoleLookSpec>>;
  /* Pack-owned Stage 6 construction stage sequence (1..10) and visual loop palette. */
  constructionStages?: readonly ConstructionStageSpec[];
  constructionPalette?: ConstructionPaletteSpec;
  materials?: readonly GroundMaterialSpec[];
  liquidLayer?: LiquidLayerSpec;
  terrainRecipe?: TerrainRecipeSpec;
  /* Plant kinds, wind and light; a pack with none draws a bare world. */
  plants?: readonly PlantKindSpec[];
  wind?: WindSpec;
  lighting?: LightingSpec;
  paths?: GroundPathSpec;
  /* Cleared ground under building lots; every pack with smooth ground names one. */
  lotGround?: LotGroundSpec;
  terrainArt?: TerrainArtSpec;
  /* Optional pure tile resolver for stub or preview packs; defaults to defaultTileId. */
  resolveEmptyTileId?: (col: number, row: number, chunkSize: number, mapSize: number) => string;
  /* Slots for artist pictures and sheets (ARTIST_CONTRACT.md); without art the engine draws placeholders. */
  art?: WorldArtCatalog;
}>;

/* Canonical 2:1 dimetric asset standard:
   50% min (60x30 CSS px, 34px human), 100% default (120x60 CSS px, 68px human),
   200% max (240x120 CSS px, 136px human), plus 8x (480x240, 544px rig source) for 2x Retina displays. */
export const DEFAULT_ISOMETRIC_PROJECTION: ProjectionSpec = {
  type: 'dimetric_2_to_1',
  tileRatioWToH: 2.0,
  diamondAngleDeg: 26.56505,
  cameraElevationDeg: 30.0,
  defaultTileW: 120,
  defaultTileH: 60,
  sun: {
    direction: 'top_left',
    azimuthDeg: -45,
    elevationDeg: 55,
    kelvin: 5200,
  },
  lods: [
    { id: '1x', tileW: 60, tileH: 30, humanHeightPx: 34, animationDetail: 'reduced' },
    { id: '2x', tileW: 120, tileH: 60, humanHeightPx: 68, animationDetail: 'standard' },
    { id: '4x', tileW: 240, tileH: 120, humanHeightPx: 136, animationDetail: 'full' },
    { id: '8x', tileW: 480, tileH: 240, humanHeightPx: 272, rigSourceHumanHeightPx: 544, animationDetail: 'full' },
  ],
  buildingFootprintsMaster4x: {
    '1x1': { diamondW: 240, diamondH: 120, doorHeightPx: 148, maxCanvasH: 420 },
    '2x2': { diamondW: 480, diamondH: 240, doorHeightPx: 152, maxCanvasH: 680 },
    '3x3': { diamondW: 720, diamondH: 360, doorHeightPx: 156, maxCanvasH: 960 },
    '4x4': { diamondW: 960, diamondH: 480, doorHeightPx: 160, maxCanvasH: 1200 },
    '5x5': { diamondW: 1200, diamondH: 600, doorHeightPx: 164, maxCanvasH: 1440 },
    '6x6': { diamondW: 1440, diamondH: 720, doorHeightPx: 168, maxCanvasH: 1680 },
  },
  directions: {
    order: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'],
    uniqueRenderAngles: ['N', 'NE', 'E', 'SE', 'S'],
    horizontalMirrors: { SW: 'SE', W: 'E', NW: 'NE' },
  },
};

export const DEFAULT_CAMERA_BOUNDS: CameraBoundsSpec = {
  minZoom: 0.5,
  defaultZoom: 1.0,
  maxZoom: 2.0,
};

const COLOR_PATTERN = /^(?:#[0-9a-f]{3,8}|rgba?\([^)]+\))$/i;

const ENGINE_DEFAULT_CLASS_LOOKS: Readonly<Record<ResidentRoleClass, PackRoleLookSpec>> = {
  ruler: {
    id: 'default-ruler',
    label: { en: 'Ruler', ru: 'Правитель' },
    tunicColor: '#EAE0C8',
    trimColor: '#E8B948',
    prop: 'staff',
    headgear: 'crown',
    insignia: true,
  },
  head: {
    id: 'default-head',
    label: { en: 'Department Head', ru: 'Глава отдела' },
    tunicColor: '#D6C7A8',
    trimColor: '#5CA6E6',
    prop: 'staff',
    headgear: 'circlet',
    insignia: true,
  },
  checker: {
    id: 'default-checker',
    label: { en: 'Inspector', ru: 'Проверяющий' },
    tunicColor: '#C5CFD9',
    trimColor: '#6994C2',
    prop: 'scroll',
    headgear: 'cap',
  },
  executor: {
    id: 'default-executor',
    label: { en: 'Builder', ru: 'Исполнитель' },
    tunicColor: '#D4BC94',
    trimColor: '#A67C52',
    prop: 'tool',
    headgear: 'none',
  },
  turnkey: {
    id: 'default-turnkey',
    label: { en: 'Turnkey Specialist', ru: 'Универсал под ключ' },
    tunicColor: '#48607A',
    trimColor: '#E5B85C',
    prop: 'banner',
    headgear: 'hood',
    insignia: true,
  },
  day_laborer: {
    id: 'default-day-laborer',
    label: { en: 'Day Laborer', ru: 'Поденщик' },
    tunicColor: '#9C8D78',
    trimColor: '#736553',
    prop: 'stone',
    headgear: 'none',
  },
};

export const DEFAULT_CONSTRUCTION_STAGES: readonly ConstructionStageSpec[] = [
  {
    stage: 1,
    id: 'stakes_and_rope',
    label: { en: 'Stakes and Rope', ru: 'Колышки и веревка' },
    heightRatio: 0.05,
    openInteriorVisible: false,
    hasScaffolding: false,
    hasRamp: false,
    hasRoofBeams: false,
    hasRoof: false,
    hasFinishing: false,
    hasUpgrades: false,
    defaultLoops: ['dust'],
  },
  {
    stage: 2,
    id: 'foundation',
    label: { en: 'Site and Foundation', ru: 'Площадка и фундамент' },
    heightRatio: 0.16,
    openInteriorVisible: false,
    hasScaffolding: false,
    hasRamp: false,
    hasRoofBeams: false,
    hasRoof: false,
    hasFinishing: false,
    hasUpgrades: false,
    defaultLoops: ['dust'],
  },
  {
    stage: 3,
    id: 'low_walls_open',
    label: { en: 'First Wall Courses (Open Rooms)', ru: 'Первые ряды стен (видны комнаты)' },
    heightRatio: 0.34,
    openInteriorVisible: true,
    hasScaffolding: false,
    hasRamp: false,
    hasRoofBeams: false,
    hasRoof: false,
    hasFinishing: false,
    hasUpgrades: false,
    defaultLoops: ['dust'],
  },
  {
    stage: 4,
    id: 'waist_walls_scaffold',
    label: { en: 'Waist Walls with Scaffolding and Ramp', ru: 'Стены по пояс с лесами и пандусом' },
    heightRatio: 0.56,
    openInteriorVisible: true,
    hasScaffolding: true,
    hasRamp: true,
    hasRoofBeams: false,
    hasRoof: false,
    hasFinishing: false,
    hasUpgrades: false,
    defaultLoops: ['crane', 'hoist_block', 'dust'],
  },
  {
    stage: 5,
    id: 'full_walls',
    label: { en: 'Full-Height Walls', ru: 'Стены в рост' },
    heightRatio: 0.82,
    openInteriorVisible: false,
    hasScaffolding: true,
    hasRamp: true,
    hasRoofBeams: false,
    hasRoof: false,
    hasFinishing: false,
    hasUpgrades: false,
    defaultLoops: ['crane', 'hoist_block', 'dust'],
  },
  {
    stage: 6,
    id: 'roof_beams',
    label: { en: 'Roof Beams', ru: 'Балки' },
    heightRatio: 0.9,
    openInteriorVisible: false,
    hasScaffolding: true,
    hasRamp: false,
    hasRoofBeams: true,
    hasRoof: false,
    hasFinishing: false,
    hasUpgrades: false,
    defaultLoops: ['crane', 'hoist_block', 'dust'],
  },
  {
    stage: 7,
    id: 'roof',
    label: { en: 'Roofing', ru: 'Крыша' },
    heightRatio: 0.96,
    openInteriorVisible: false,
    hasScaffolding: true,
    hasRamp: false,
    hasRoofBeams: false,
    hasRoof: true,
    hasFinishing: false,
    hasUpgrades: false,
    defaultLoops: ['dust'],
  },
  {
    stage: 8,
    id: 'finishing',
    label: { en: 'Finishing Trim', ru: 'Отделка' },
    heightRatio: 1.0,
    openInteriorVisible: false,
    hasScaffolding: true,
    hasRamp: false,
    hasRoofBeams: false,
    hasRoof: true,
    hasFinishing: true,
    hasUpgrades: false,
    defaultLoops: ['dust', 'awning'],
  },
  {
    stage: 9,
    id: 'complete',
    label: { en: 'Complete', ru: 'Готово' },
    heightRatio: 1.0,
    openInteriorVisible: false,
    hasScaffolding: false,
    hasRamp: false,
    hasRoofBeams: false,
    hasRoof: true,
    hasFinishing: true,
    hasUpgrades: false,
    defaultLoops: ['awning', 'smoke'],
  },
  {
    stage: 10,
    id: 'upgraded',
    label: { en: 'Upgraded Annex', ru: 'Улучшения' },
    heightRatio: 1.16,
    openInteriorVisible: false,
    hasScaffolding: false,
    hasRamp: false,
    hasRoofBeams: false,
    hasRoof: true,
    hasFinishing: true,
    hasUpgrades: true,
    defaultLoops: ['awning', 'smoke'],
  },
];

export const DEFAULT_CONSTRUCTION_PALETTE: ConstructionPaletteSpec = {
  scaffoldWood: '#B9874A',
  rampEarth: '#C9AD7F',
  dustColor: '#DFCFAF',
  smokeColor: '#6D717C',
  waterColor: '#56BDE8',
  awningPrimary: '#C96A4B',
  awningSecondary: '#F2E5C4',
  capstoneColor: '#FFDC62',
  celebrationPrimary: '#FFE270',
  celebrationSecondary: '#5FD1A8',
  statueBaseColor: '#C5B89F',
  statueFinishedColor: '#ECCB6C',
};

export function resolveConstructionStages(pack: WorldPackManifest): readonly ConstructionStageSpec[] {
  if (pack.constructionStages && pack.constructionStages.length > 0) {
    return pack.constructionStages;
  }
  return DEFAULT_CONSTRUCTION_STAGES;
}

export function resolveConstructionPalette(pack: WorldPackManifest): ConstructionPaletteSpec {
  return pack.constructionPalette ?? DEFAULT_CONSTRUCTION_PALETTE;
}

/* Resolves a resident's visual look from the active world pack:
   exact roleKey -> archetype -> nearest class fallback -> neutral engine default. */
export function resolvePackRoleLook(
  pack: WorldPackManifest,
  roleKey: string | null,
  roleClass: ResidentRoleClass,
  archetype: RoleArchetype,
): PackRoleLookSpec {
  const normalized = (roleKey ?? '').trim().toUpperCase();
  if (normalized && pack.roleLooks?.[normalized]) {
    return pack.roleLooks[normalized]!;
  }
  if (pack.roleLooks?.[archetype]) {
    return pack.roleLooks[archetype]!;
  }
  if (pack.classFallbackLooks?.[roleClass]) {
    return pack.classFallbackLooks[roleClass]!;
  }
  return ENGINE_DEFAULT_CLASS_LOOKS[roleClass];
}

export type WorldPackValidation = { ok: true } | { ok: false; errors: string[] };

/* Maximum source tile width available in this pack (used to prevent upscaling past native art resolution). */
export function packMaxSourceTileW(pack: WorldPackManifest): number {
  let maxLod = 0;
  for (const lod of pack.projection.lods) {
    if (lod.tileW > maxLod) maxLod = lod.tileW;
  }
  const spriteCaps = pack.sprites
    .map(s => s.maxSourceTileW)
    .filter((w): w is number => typeof w === 'number' && w > 0);
  if (spriteCaps.length > 0) {
    return Math.min(maxLod, ...spriteCaps);
  }
  return maxLod;
}

/* Picks the smallest available LOD tier whose physical tile width is >= required CSS tile width * DPR.
   Never selects a lower tier when a higher crisp tier exists; falls back to the highest available tier. */
export function selectLodTier(
  lods: readonly LodTierSpec[],
  cssTileW: number,
  devicePixelRatio = 1,
): LodTierSpec {
  const sorted = [...lods].sort((a, b) => a.tileW - b.tileW);
  const dpr = Math.max(1, devicePixelRatio);
  const requiredPhysicalTileW = cssTileW * dpr;
  for (const lod of sorted) {
    if (lod.tileW + 1e-6 >= requiredPhysicalTileW) return lod;
  }
  return sorted[sorted.length - 1]!;
}

function validRange(r: PlantRange): boolean {
  return Number.isFinite(r.min) && Number.isFinite(r.max) && r.min <= r.max;
}

/* Plant kinds, wind and light: every id, range and colour must be usable before the engine places a single plant. */
function validatePlants(pack: WorldPackManifest, materialIds: ReadonlySet<string>, errors: string[]): void {
  const kindIds = new Set((pack.terrainRecipe?.tileKinds ?? []).map(k => k.id));
  const seen = new Set<string>();
  for (const plant of pack.plants ?? []) {
    const tag = `plants.${plant.id}`;
    if (!plant.id.trim()) errors.push('plant.id must be non-empty');
    if (seen.has(plant.id)) errors.push(`duplicate plant.id: ${plant.id}`);
    seen.add(plant.id);
    if (plant.tileKinds.length === 0) errors.push(`${tag}.tileKinds must be non-empty`);
    for (const id of plant.tileKinds) {
      if (kindIds.size > 0 && !kindIds.has(id)) errors.push(`${tag}.tileKinds references unknown tile kind "${id}"`);
    }
    for (const id of Object.keys(plant.materialCaps ?? {})) {
      if (materialIds.size > 0 && !materialIds.has(id)) errors.push(`${tag}.materialCaps references unknown material "${id}"`);
    }
    if (!(plant.density > 0 && plant.density <= 1)) errors.push(`${tag}.density must be in (0, 1]`);
    if (!validRange(plant.moisture)) errors.push(`${tag}.moisture must be an ordered range`);
    if (!validRange(plant.waterDist)) errors.push(`${tag}.waterDist must be an ordered range`);
    if (!validRange(plant.heightPx) || plant.heightPx.min <= 0) errors.push(`${tag}.heightPx must be a positive ordered range`);
    if (plant.clusterSize && (!validRange(plant.clusterSize) || plant.clusterSize.min < 1)) {
      errors.push(`${tag}.clusterSize must be an ordered range from 1`);
    }
    if (plant.clumping < 0 || plant.clumping > 1) errors.push(`${tag}.clumping must be in [0, 1]`);
    if (plant.clumpScale <= 0) errors.push(`${tag}.clumpScale must be positive`);
    if (!Number.isInteger(plant.spacing) || plant.spacing < 0) errors.push(`${tag}.spacing must be a non-negative integer`);
    if (!Number.isInteger(plant.variants) || plant.variants < 1) errors.push(`${tag}.variants must be a positive integer`);
    for (const [k, c] of Object.entries(plant.palette)) {
      if (!COLOR_PATTERN.test(c)) errors.push(`invalid ${tag}.palette.${k} colour`);
    }
    if (plant.sway.amplitude < 0 || plant.sway.frequency <= 0) errors.push(`${tag}.sway needs amplitude >= 0 and frequency > 0`);
    if (plant.evenCell !== undefined && !(Number.isInteger(plant.evenCell) && plant.evenCell >= 1)) errors.push(`${tag}.evenCell must be a positive integer`);
  }
  const wind = pack.wind;
  if (wind) {
    if (wind.baseStrength < 0 || wind.baseStrength > 1) errors.push('wind.baseStrength must be in [0, 1]');
    if (wind.gustStrength < 0 || wind.gustStrength > 1) errors.push('wind.gustStrength must be in [0, 1]');
    if (wind.gustSpeed <= 0 || wind.gustScale <= 0) errors.push('wind.gustSpeed and wind.gustScale must be positive');
  }
  const light = pack.lighting;
  if (light) {
    if (!COLOR_PATTERN.test(light.shadowColor)) errors.push('invalid lighting.shadowColor colour');
    if (!COLOR_PATTERN.test(light.sunTint)) errors.push('invalid lighting.sunTint colour');
    if (light.shadowAlpha < 0 || light.shadowAlpha > 1) errors.push('lighting.shadowAlpha must be in [0, 1]');
    if (light.shadowLength < 0) errors.push('lighting.shadowLength must be non-negative');
  }
}

function validateBuildingLayout(rules: BuildingLayoutRules): string[] {
  const errors: string[] = [];
  const kinds = new Set<string>(CITY_BUILDING_KINDS);
  for (const [kind, rule] of Object.entries(rules) as [string, BuildingLayoutSpec | undefined][]) {
    const at = `buildingLayout.${kind}`;
    if (!kinds.has(kind)) {
      errors.push(`${at} names no building kind of the engine`);
      continue;
    }
    if (!rule) continue;
    const spans = Array.isArray(rule.spans) ? rule.spans : [];
    const spansOk =
      spans.length > 0 &&
      spans.every(s => Number.isInteger(s) && s >= 1 && s <= 6) &&
      spans.every((s, i) => i === 0 || s >= spans[i - 1]!);
    if (!spansOk) errors.push(`${at}.spans must be whole sizes from 1 to 6 that never shrink`);
    const wall = rule.door?.wall;
    if (wall !== 'front_right' && wall !== 'front_left') {
      errors.push(`${at}.door.wall must be front_right or front_left`);
    }
    const fromFront = rule.door?.fromFront;
    const smallest = spansOk ? spans[0]! : 1;
    if (!Number.isInteger(fromFront) || fromFront! < 0 || fromFront! >= smallest) {
      errors.push(`${at}.door.fromFront must be a tile row of the smallest span (0 to ${smallest - 1})`);
    }
  }
  return errors;
}

function validateLotGround(pack: WorldPackManifest, materialIds: ReadonlySet<string>, errors: string[]): void {
  const spec = pack.lotGround;
  if (!spec) {
    if (materialIds.size > 0) errors.push('lotGround is required with smooth ground materials');
    return;
  }
  const blended = pack.terrainRecipe?.materialIds ?? [...materialIds];
  if (!blended.includes(spec.material)) errors.push(`lotGround references material "${spec.material}" the ground does not blend`);
  if (!(spec.edgeTiles > 0 && spec.edgeTiles <= 2)) errors.push('lotGround.edgeTiles must be in (0, 2]');
  if (!(spec.regrowthHours > 0)) errors.push('lotGround.regrowthHours must be positive');
}

/* A harbour names liquids of its own recipe and shows 1 to 4 blocks a deck. */
function validateHarbour(pack: WorldPackManifest, errors: string[]): void {
  const h = pack.harbour;
  if (!h) return;
  if (h.boatCargoMax !== undefined && !(Number.isInteger(h.boatCargoMax) && h.boatCargoMax >= 1 && h.boatCargoMax <= 4)) {
    errors.push('harbour.boatCargoMax must be a whole number from 1 to 4');
  }
  const kinds = new Map((pack.terrainRecipe?.tileKinds ?? []).map(kind => [kind.id, kind]));
  for (const id of h.boatLiquids ?? []) {
    if (!kinds.get(id)?.liquid) errors.push(`harbour.boatLiquids: ${id} is not a liquid of the terrain recipe`);
  }
}

export function validateWorldPack(pack: WorldPackManifest): WorldPackValidation {
  const errors: string[] = [];

  if (!pack.id.trim()) errors.push('id must be non-empty');
  validateHarbour(pack, errors);
  if (!Number.isInteger(pack.mapSize) || pack.mapSize < 1) errors.push('mapSize must be a positive integer');
  if (!Number.isInteger(pack.params.chunkSize) || pack.params.chunkSize < 1) {
    errors.push('params.chunkSize must be a positive integer');
  }
  if (pack.params.orderChaosDefault < 0 || pack.params.orderChaosDefault > 1) {
    errors.push('params.orderChaosDefault must be in [0, 1]');
  }

  if (
    pack.projection.defaultTileW <= 0 ||
    pack.projection.defaultTileH <= 0 ||
    Math.abs(pack.projection.defaultTileW / pack.projection.defaultTileH - 2) > 1e-6
  ) {
    errors.push('projection defaultTileW:defaultTileH must be positive 2:1');
  }

  if (pack.projection.lods.length === 0) {
    errors.push('projection.lods must declare at least one LOD tier');
  }
  let prevW = 0;
  for (const lod of pack.projection.lods) {
    if (lod.tileW <= 0 || lod.tileH <= 0 || Math.abs(lod.tileW / lod.tileH - 2) > 1e-6) {
      errors.push(`projection.lods.${lod.id} must have positive 2:1 tileW:tileH`);
    }
    if (lod.tileW <= prevW) {
      errors.push('projection.lods must be sorted strictly ascending by tileW');
    }
    prevW = lod.tileW;
  }

  if (
    pack.camera.minZoom <= 0 ||
    pack.camera.defaultZoom < pack.camera.minZoom ||
    pack.camera.maxZoom < pack.camera.defaultZoom
  ) {
    errors.push('camera zoom bounds must satisfy 0 < minZoom <= defaultZoom <= maxZoom');
  }

  if (pack.tiles.length === 0) {
    errors.push('tiles must declare at least one tile slot');
  }
  const tileIds = new Set<string>();
  for (const tile of pack.tiles) {
    if (!tile.id.trim()) errors.push('tile.id must be non-empty');
    if (tileIds.has(tile.id)) errors.push(`duplicate tile.id: ${tile.id}`);
    tileIds.add(tile.id);
    if (!COLOR_PATTERN.test(tile.fill)) errors.push(`invalid fill colour on tile ${tile.id}`);
    if (!COLOR_PATTERN.test(tile.stroke)) errors.push(`invalid stroke colour on tile ${tile.id}`);
    if (tile.accent && !COLOR_PATTERN.test(tile.accent)) errors.push(`invalid accent colour on tile ${tile.id}`);
  }
  if (!tileIds.has(pack.defaultTileId)) {
    errors.push(`defaultTileId "${pack.defaultTileId}" is not present in tiles`);
  }

  const materialIds = new Set<string>();
  if (pack.materials) {
    for (const mat of pack.materials) {
      if (!mat.id.trim()) errors.push('material.id must be non-empty');
      if (materialIds.has(mat.id)) errors.push(`duplicate material.id: ${mat.id}`);
      materialIds.add(mat.id);
      if (!COLOR_PATTERN.test(mat.baseColor)) errors.push(`invalid baseColor on material ${mat.id}`);
      if (!COLOR_PATTERN.test(mat.secondaryColor)) errors.push(`invalid secondaryColor on material ${mat.id}`);
      if (!COLOR_PATTERN.test(mat.accentColor)) errors.push(`invalid accentColor on material ${mat.id}`);
      if (mat.ripples !== undefined && !(mat.ripples >= 0 && mat.ripples <= 1)) errors.push(`material ${mat.id} ripples must be in [0, 1]`);
      const plots = mat.plots;
      if (plots) {
        if (!(plots.sizeU >= 1 && plots.sizeV >= 1)) errors.push(`material ${mat.id} plots need sizes of at least one tile`);
        if (!COLOR_PATTERN.test(plots.ridgeColor)) errors.push(`invalid plots.ridgeColor on material ${mat.id}`);
        if (plots.ditchColor !== undefined && !COLOR_PATTERN.test(plots.ditchColor)) errors.push(`invalid plots.ditchColor on material ${mat.id}`);
      }
    }
    for (const mat of pack.materials) {
      for (const key of ['fallow', 'margin'] as const) {
        const other = mat.plots?.[key];
        if (other !== undefined && (!materialIds.has(other) || other === mat.id)) errors.push(`material ${mat.id} plots.${key} must name another material`);
      }
    }
  }
  if (pack.terrainArt) {
    const ta = pack.terrainArt;
    if (!(ta.texelsPerTile > 0)) errors.push('terrainArt.texelsPerTile must be positive');
    for (const id of Object.keys(ta.ground)) if (materialIds.size > 0 && !materialIds.has(id)) errors.push(`terrainArt.ground names unknown material "${id}"`);
    for (const pair of Object.keys(ta.edges ?? {})) {
      const [a, b] = pair.split('|');
      if (!a || !b || (materialIds.size > 0 && (!materialIds.has(a) || !materialIds.has(b)))) errors.push(`terrainArt.edges pair "${pair}" must name two known materials`);
    }
    if (ta.liquid && !COLOR_PATTERN.test(ta.liquid.baseColor)) errors.push('invalid terrainArt.liquid.baseColor colour');
  }
  if (pack.paths) {
    const pth = pack.paths;
    if (!COLOR_PATTERN.test(pth.color) || !COLOR_PATTERN.test(pth.rutColor)) errors.push('invalid paths colour');
    if (!(pth.widthTiles > 0 && pth.spacingTiles > pth.widthTiles)) errors.push('paths need widthTiles > 0 and spacingTiles above it');
    for (const id of pth.materials) if (materialIds.size > 0 && !materialIds.has(id)) errors.push(`paths reference unknown material "${id}"`);
  }

  if (pack.liquidLayer) {
    const l = pack.liquidLayer;
    for (const [k, c] of Object.entries({
      baseColor: l.baseColor,
      deepColor: l.deepColor,
      highlightColor: l.highlightColor,
      shoreFoamColor: l.shoreFoamColor,
      shallowTintColor: l.shallowTintColor,
    })) {
      if (!COLOR_PATTERN.test(c)) errors.push(`invalid liquidLayer.${k} colour`);
    }
    if (l.depthShade !== undefined && !(l.depthShade >= 0 && l.depthShade <= 1)) errors.push('liquidLayer.depthShade must be in [0, 1]');
  }

  if (pack.terrainRecipe) {
    const recipe = pack.terrainRecipe;
    if (!recipe.id.trim()) errors.push('terrainRecipe.id must be non-empty');
    if (recipe.tileKinds.length === 0) errors.push('terrainRecipe.tileKinds must be non-empty');
    if (recipe.minBuildableRatio < 0 || recipe.minBuildableRatio > 1) {
      errors.push('terrainRecipe.minBuildableRatio must be in [0, 1]');
    }
    for (const kind of recipe.tileKinds) {
      if (!COLOR_PATTERN.test(kind.color)) errors.push(`invalid terrainRecipe.tileKinds.${kind.id} colour`);
      if (materialIds.size > 0 && !materialIds.has(kind.materialId)) {
        errors.push(`terrainRecipe.tileKinds.${kind.id} references unknown materialId "${kind.materialId}"`);
      }
    }
    if (materialIds.size > 0) {
      for (const mid of recipe.materialIds) {
        if (!materialIds.has(mid)) errors.push(`terrainRecipe.materialIds references unknown "${mid}"`);
      }
    }
  }

  validatePlants(pack, materialIds, errors);
  validateLotGround(pack, materialIds, errors);

  if (pack.outerWallMode !== undefined && pack.outerWallMode !== 'ring' && pack.outerWallMode !== 'none') {
    errors.push(`invalid outerWallMode "${String(pack.outerWallMode)}"`);
  }

  if (pack.buildingLayout) {
    errors.push(...validateBuildingLayout(pack.buildingLayout));
  }

  if (pack.art) {
    errors.push(...validateArtCatalog(pack.art));
  }

  for (const [key, value] of Object.entries(pack.stageCounts)) {
    if (!Number.isInteger(value) || value < 1) {
      errors.push(`stageCounts.${key} must be a positive integer`);
    }
  }

  const paletteKeys: (keyof Omit<WorldPaletteSpec, 'providers'>)[] = [
    'backdrop', 'border', 'gridLine', 'chunkLine', 'hoverFill', 'hoverStroke', 'selectFill', 'selectStroke',
  ];
  for (const key of paletteKeys) {
    if (!COLOR_PATTERN.test(pack.palette[key])) {
      errors.push(`invalid palette.${key} colour`);
    }
  }
  for (const [provider, color] of Object.entries(pack.palette.providers)) {
    if (!COLOR_PATTERN.test(color)) {
      errors.push(`invalid palette.providers.${provider} colour`);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
