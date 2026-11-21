/* Theme-neutral cartographic preview pack for Stage 2 procedural terrain inspection.
   Maps all 10 universal TerrainKind IDs onto readable geographic diamond colours with zero theme words. */

import { DEFAULT_CAMERA_BOUNDS, DEFAULT_ISOMETRIC_PROJECTION, type WorldPackManifest } from '../manifest';

export const TERRAIN_PREVIEW_PACK: WorldPackManifest = {
  id: 'terrain-preview',
  name: { en: 'Geographic Terrain Preview', ru: 'Географический просмотр местности' },
  engine: 'isometric-2d',
  mapSize: 150,
  projection: DEFAULT_ISOMETRIC_PROJECTION,
  camera: DEFAULT_CAMERA_BOUNDS,
  defaultTileId: 'plain',
  tiles: [
    { id: 'river', fill: '#2B7BB5', stroke: '#236699', accent: '#4899D1', buildable: false, walkable: false },
    { id: 'bank', fill: '#D9C598', stroke: '#C2AD7F', accent: '#E8D8B2', buildable: false, walkable: true },
    { id: 'fertile', fill: '#5D9B52', stroke: '#4C8242', accent: '#75B569', buildable: true, walkable: true },
    { id: 'field', fill: '#88AC52', stroke: '#709141', accent: '#A3C46C', buildable: true, walkable: true },
    { id: 'plain', fill: '#C8BA92', stroke: '#B3A47B', accent: '#D9CCA7', buildable: true, walkable: true },
    { id: 'dune', fill: '#B6945E', stroke: '#9E7D4A', accent: '#CAA872', buildable: false, walkable: true },
    { id: 'grove', fill: '#3E7D4A', stroke: '#30663B', accent: '#539960', buildable: false, walkable: true },
    { id: 'spring', fill: '#36A8B8', stroke: '#288996', accent: '#5EC4D4', buildable: false, walkable: false },
    { id: 'ridge', fill: '#646B73', stroke: '#4A5057', accent: '#89929C', buildable: false, walkable: false },
    { id: 'quarry', fill: '#949186', stroke: '#78756B', accent: '#B5B2A8', buildable: false, walkable: true },
  ],
  sprites: [],
  stageCounts: {
    house: 10,
    department: 10,
    district: 30,
    residence: 5,
    statue: 20,
    monument: 10,
    flophouse: 6,
    construction: 8,
  },
  palette: {
    backdrop: '#141B24',
    border: '#7A96B5',
    gridLine: 'rgba(20, 27, 36, 0.25)',
    chunkLine: 'rgba(20, 27, 36, 0.16)',
    hoverFill: 'rgba(104, 206, 255, 0.28)',
    hoverStroke: '#7ED6FF',
    selectFill: 'rgba(255, 202, 88, 0.36)',
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
    orderChaosDefault: 0.5,
  },
};
