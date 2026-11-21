/* Universal world pack manifest contract for the isometric world engine.
   Contains zero theme-specific words, files or colours; every concrete world supplies its own manifest. */

export type EngineKind = 'isometric-2d' | '3d';

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

/* Terrain tile visual slot declared by a world pack. */
export type TileSlotSpec = Readonly<{
  id: string;
  fill: string;
  stroke: string;
  accent?: string;
  buildable: boolean;
  walkable: boolean;
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
  /* Optional pure tile resolver for stub or preview packs; defaults to defaultTileId. */
  resolveEmptyTileId?: (col: number, row: number, chunkSize: number, mapSize: number) => string;
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

export function validateWorldPack(pack: WorldPackManifest): WorldPackValidation {
  const errors: string[] = [];

  if (!pack.id.trim()) errors.push('id must be non-empty');
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
