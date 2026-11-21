/* Geometric colored-diamond stub world pack for Stage 1 engine verification.
   Contains zero theme-specific assets, words or colours. */

import { DEFAULT_CAMERA_BOUNDS, DEFAULT_ISOMETRIC_PROJECTION, type WorldPackManifest } from '../manifest';

export const STUB_DIAMOND_PACK: WorldPackManifest = {
  id: 'stub-diamonds',
  name: { en: 'Geometric Diamond Grid', ru: 'Геометрическая ромбовидная сетка' },
  engine: 'isometric-2d',
  mapSize: 150,
  projection: DEFAULT_ISOMETRIC_PROJECTION,
  camera: DEFAULT_CAMERA_BOUNDS,
  defaultTileId: 'cell-a',
  tiles: [
    { id: 'cell-a', fill: '#2E3B4E', stroke: '#3F5169', accent: '#4C617D', buildable: true, walkable: true },
    { id: 'cell-b', fill: '#35455B', stroke: '#465A74', accent: '#566D8B', buildable: true, walkable: true },
    { id: 'band-a', fill: '#294852', stroke: '#39626F', accent: '#487989', buildable: true, walkable: true },
    { id: 'band-b', fill: '#2F525D', stroke: '#406D7B', accent: '#518798', buildable: true, walkable: true },
    { id: 'origin', fill: '#3B5E58', stroke: '#54877E', accent: '#6CA89E', buildable: true, walkable: true },
    { id: 'border', fill: '#252F3D', stroke: '#3A4A60', accent: '#4B607B', buildable: true, walkable: true },
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
    border: '#5E7C9E',
    gridLine: '#40536B',
    chunkLine: 'rgba(130, 184, 224, 0.34)',
    hoverFill: 'rgba(104, 206, 255, 0.24)',
    hoverStroke: '#7ED6FF',
    selectFill: 'rgba(255, 202, 88, 0.34)',
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
    /* 4x4 tile chunks stay <= 1920x960 px even at 8x Retina LOD (480x240), fitting every 2048px GPU. */
    chunkSize: 4,
    orderChaosDefault: 0.5,
  },
  resolveEmptyTileId(col: number, row: number, chunkSize: number, mapSize: number): string {
    if (col === 0 || row === 0 || col === mapSize - 1 || row === mapSize - 1) return 'border';
    const center = Math.floor(mapSize / 2);
    const centerDist = Math.max(Math.abs(col - center), Math.abs(row - center));
    if (centerDist <= 3) return 'origin';
    const chunkParity = (Math.floor(col / chunkSize) + Math.floor(row / chunkSize)) & 1;
    const tileParity = (col + row) & 1;
    if (chunkParity === 0) return tileParity === 0 ? 'cell-a' : 'cell-b';
    return tileParity === 0 ? 'band-a' : 'band-b';
  },
};
