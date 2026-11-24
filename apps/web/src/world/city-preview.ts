/* Pack-agnostic 2D city timelapse renderer for Stage 3 simulation and 3x3 Order/Chaos comparison.
   Renders underlying smooth procedural terrain, carved excavated chambers/tunnels (for subterranean
   packs), 4-tier road network (trail/dirt/brick/stone + bridges), single active outer wall ring
   and role/district-coded buildings scaled accurately to their 1x1..6x6 standard footprints.
   Contains zero theme-specific words, files or colours. */

import type { CityLayoutSnapshot, RoadTier } from './city-layout';
import type { WorldPackManifest } from './manifest';
import type { GeneratedWorldMap } from './terrain-engine';
import { renderProceduralMapPreview } from './terrain-preview';

const DISTRICT_COLORS = [
  '#D96B52',
  '#4A9E7D',
  '#5C85D6',
  '#C9973E',
  '#9B6BC9',
  '#4EA8B8',
] as const;

const ROAD_COLORS: Readonly<Record<RoadTier, string>> = {
  trail: '#9B8762',
  dirt: '#7D6342',
  brick: '#B56B45',
  stone: '#DDE3EB',
};

function districtColor(districtId?: string): string {
  if (!districtId) return '#C47E5A';
  const m = /(\d+)$/.exec(districtId);
  const idx = m ? (Number.parseInt(m[1]!, 10) - 1) % DISTRICT_COLORS.length : 0;
  return DISTRICT_COLORS[Math.max(0, idx)]!;
}

/* Draws a full Stage 3 CityLayoutSnapshot on top of its smooth procedural terrain canvas. */
export function renderCitySnapshot(
  canvas: HTMLCanvasElement,
  map: GeneratedWorldMap,
  snapshot: CityLayoutSnapshot,
  pack: WorldPackManifest,
  pixelScale = 4,
): void {
  const scale = Math.max(2, Math.floor(pixelScale));
  renderProceduralMapPreview(canvas, map, pack, scale);

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const ox = -map.bounds.minCol;
  const oy = -map.bounds.minRow;
  const px = (col: number) => (col + ox) * scale;
  const py = (row: number) => (row + oy) * scale;

  /* 0. Excavated rock chambers & corridors (clearly distinguishes carved space from uncut bedrock). */
  if (snapshot.excavatedTiles.length > 0) {
    ctx.fillStyle = 'rgba(138, 134, 148, 0.88)';
    for (const key of snapshot.excavatedTiles) {
      const comma = key.indexOf(',');
      const col = Number.parseInt(key.slice(0, comma), 10);
      const row = Number.parseInt(key.slice(comma + 1), 10);
      ctx.fillRect(px(col), py(row), scale, scale);
    }
  }

  /* 1. Roads (4 tiers + liquid bridges + grand avenues + old wall ring boulevards). */
  for (const road of snapshot.roads) {
    const x = px(road.col);
    const y = py(road.row);
    if (road.bridge) {
      ctx.fillStyle = '#7A5430';
      ctx.fillRect(x, y, scale, scale);
      ctx.fillStyle = '#E2C396';
      ctx.fillRect(x + 0.5, y + 0.5, Math.max(1, scale - 1), Math.max(1, scale - 1));
    } else {
      ctx.fillStyle = ROAD_COLORS[road.tier];
      ctx.fillRect(x, y, scale, scale);
      if (road.grandAvenue || road.tier === 'stone') {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
        ctx.fillRect(x + scale * 0.2, y + scale * 0.2, scale * 0.6, scale * 0.6);
      }
    }
  }

  /* 2. Active single outer city wall ring (dark foundation + bright rampart crest). */
  for (const key of snapshot.wallTiles) {
    const comma = key.indexOf(',');
    const col = Number.parseInt(key.slice(0, comma), 10);
    const row = Number.parseInt(key.slice(comma + 1), 10);
    const x = px(col);
    const y = py(row);
    ctx.fillStyle = '#1C222B';
    ctx.fillRect(x, y, scale, scale);
    ctx.fillStyle = '#E8EDF5';
    const inset = Math.max(0.5, scale * 0.18);
    ctx.fillRect(x + inset, y + inset, Math.max(1, scale - inset * 2), Math.max(1, scale - inset * 2));
  }

  /* 3. Buildings with real 1x1..6x6 footprints, stepped monuments and district-coded dwellings. */
  for (const b of snapshot.buildings) {
    const x = px(b.col);
    const y = py(b.row);
    const w = b.spanCol * scale;
    const h = b.spanRow * scale;

    if (b.kind === 'residence') {
      ctx.fillStyle = '#1B2028';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#FFD166';
      ctx.fillRect(x + 1, y + 1, Math.max(2, w - 2), Math.max(2, h - 2));
      ctx.fillStyle = '#FFF3C4';
      ctx.fillRect(x + w * 0.24, y + h * 0.24, w * 0.52, h * 0.52);
    } else if (b.kind === 'monument') {
      ctx.fillStyle = '#4A2C12';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#E09A38';
      ctx.fillRect(x + 1, y + 1, Math.max(2, w - 2), Math.max(2, h - 2));
      ctx.fillStyle = '#F7C96E';
      ctx.fillRect(x + w * 0.2, y + h * 0.2, w * 0.6, h * 0.6);
      ctx.fillStyle = '#FFF5D1';
      ctx.fillRect(x + w * 0.38, y + h * 0.38, w * 0.24, h * 0.24);
    } else if (b.kind === 'department') {
      ctx.fillStyle = '#162845';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#3B78CC';
      ctx.fillRect(x + 1, y + 1, Math.max(2, w - 2), Math.max(2, h - 2));
      ctx.fillStyle = '#8CC2FF';
      ctx.fillRect(x + w * 0.22, y + h * 0.22, w * 0.56, h * 0.56);
    } else if (b.kind === 'district_hub') {
      ctx.fillStyle = '#143330';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = districtColor(b.districtId);
      ctx.fillRect(x + 1, y + 1, Math.max(2, w - 2), Math.max(2, h - 2));
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(x + w * 0.34, y + h * 0.34, w * 0.32, h * 0.32);
    } else if (b.kind === 'supply') {
      ctx.fillStyle = '#14363D';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#38C8C8';
      ctx.fillRect(x + 1, y + 1, Math.max(2, w - 2), Math.max(2, h - 2));
    } else if (b.kind === 'statue') {
      ctx.fillStyle = '#1D2530';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#F7FAFF';
      const pad = Math.max(0.5, scale * 0.16);
      ctx.fillRect(x + pad, y + pad, Math.max(1, w - pad * 2), Math.max(1, h - pad * 2));
    } else if (b.kind === 'flophouse') {
      ctx.fillStyle = '#251E2B';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#8C7BA6';
      ctx.fillRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
    } else {
      /* Houses: tinted by machine district, highlighted roof on higher-tier / merged estates. */
      ctx.fillStyle = '#1E242C';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = districtColor(b.districtId);
      ctx.fillRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
      if (b.spanCol >= 3 || b.floors >= 2 || b.residentIds.length > 1) {
        ctx.fillStyle = 'rgba(255, 245, 215, 0.52)';
        ctx.fillRect(x + w * 0.25, y + h * 0.25, w * 0.5, h * 0.5);
      }
    }
  }
}
