/* Universal world pack manifest contract for the isometric world engine.
   Contains zero theme-specific words, files or colours; every concrete world supplies its own manifest. */

export type EngineKind = 'isometric-2d' | '3d';

export type Direction8 = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';
export type UniqueRenderAngle5 = 'N' | 'NE' | 'E' | 'SE' | 'S';
export type ResolutionTierId = 'overview' | '1x' | '2x' | '4x';
export type FootprintKey = '1x1' | '2x2' | '3x3' | '4x4' | '5x5' | '6x6';

export type ResolutionTierSpec = Readonly<{
  tileW: number;
  tileH: number;
  humanHeightPx: number;
  rigSourceHumanHeightPx?: number;
}>;

export type OverviewTierSpec = Readonly<{
  tileW: number;
  tileH: number;
}>;

export type FootprintMetrics = Readonly<{
  diamondW: number;
  diamondH: number;
  doorHeightPx: number;
  maxCanvasH: number;
}>;

export type ProjectionSpec = Readonly<{
  type: 'dimetric_2_to_1';
  tileRatioWToH: number;
  diamondAngleDeg: number;
  cameraElevationDeg: number;
  sun: Readonly<{
    direction: 'top_left';
    azimuthDeg: number;
    elevationDeg: number;
    kelvin: number;
  }>;
  tiers: Readonly<{
    master4x: ResolutionTierSpec;
    hd2x: ResolutionTierSpec;
    classic1x: ResolutionTierSpec;
    overview: OverviewTierSpec;
  }>;
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
  tileW?: number;
  tileH?: number;
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
  overviewMarginPx: number;
  orderChaosDefault: number;
}>;

export type WorldPackManifest = Readonly<{
  id: string;
  name: Readonly<{ en: string; ru: string }>;
  engine: EngineKind;
  /* Single map dimension N for an N x N diamond tile grid. */
  mapSize: number;
  projection: ProjectionSpec;
  defaultTileId: string;
  tiles: readonly TileSlotSpec[];
  sprites: readonly SpriteAtlasSpec[];
  stageCounts: StageCountsSpec;
  palette: WorldPaletteSpec;
  params: WorldEngineParamsSpec;
  /* Optional pure tile resolver for stub or preview packs; defaults to defaultTileId. */
  resolveEmptyTileId?: (col: number, row: number, chunkSize: number) => string;
}>;

/* Canonical 2:1 dimetric asset standard (240x120 master 4x, 120x60 hd 2x, 60x30 classic 1x, 16x8 overview). */
export const DEFAULT_ISOMETRIC_PROJECTION: ProjectionSpec = {
  type: 'dimetric_2_to_1',
  tileRatioWToH: 2.0,
  diamondAngleDeg: 26.56505,
  cameraElevationDeg: 30.0,
  sun: {
    direction: 'top_left',
    azimuthDeg: -45,
    elevationDeg: 55,
    kelvin: 5200,
  },
  tiers: {
    master4x: { tileW: 240, tileH: 120, humanHeightPx: 136, rigSourceHumanHeightPx: 544 },
    hd2x: { tileW: 120, tileH: 60, humanHeightPx: 68 },
    classic1x: { tileW: 60, tileH: 30, humanHeightPx: 34 },
    overview: { tileW: 16, tileH: 8 },
  },
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

const COLOR_PATTERN = /^(?:#[0-9a-f]{3,8}|rgba?\([^)]+\))$/i;

export type WorldPackValidation = { ok: true } | { ok: false; errors: string[] };

export function tierTileMetrics(projection: ProjectionSpec, tier: ResolutionTierId): { tileW: number; tileH: number } {
  switch (tier) {
    case 'overview':
      return projection.tiers.overview;
    case '1x':
      return projection.tiers.classic1x;
    case '2x':
      return projection.tiers.hd2x;
    case '4x':
      return projection.tiers.master4x;
  }
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

  const tiers: [string, { tileW: number; tileH: number }][] = [
    ['master4x', pack.projection.tiers.master4x],
    ['hd2x', pack.projection.tiers.hd2x],
    ['classic1x', pack.projection.tiers.classic1x],
    ['overview', pack.projection.tiers.overview],
  ];
  for (const [name, t] of tiers) {
    if (t.tileW <= 0 || t.tileH <= 0 || Math.abs(t.tileW / t.tileH - 2) > 1e-6) {
      errors.push(`projection.tiers.${name} must have positive 2:1 tileW:tileH`);
    }
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
