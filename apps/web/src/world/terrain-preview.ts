/* Cartographic 2D canvas preview renderer for Stage 2 procedural maps.
   Draws shaded terrain relief (top-left sun on ridges, wind ripples on dunes, field plots,
   deep-channel river shading) plus an unmistakable city center star marker. */

import type { WorldPackManifest } from './manifest';
import { TERRAIN_KINDS, type ProceduralMap, type TerrainKind } from './terrain';

type Rgb = readonly [number, number, number];

function parseHexRgb(hex: string, fallback: Rgb): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const v = Number.parseInt(m[1]!, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function shadeRgb(rgb: Rgb, delta: number): Rgb {
  return [
    Math.max(0, Math.min(255, Math.round(rgb[0] + delta))),
    Math.max(0, Math.min(255, Math.round(rgb[1] + delta))),
    Math.max(0, Math.min(255, Math.round(rgb[2] + delta))),
  ];
}

function buildKindPalette(pack: WorldPackManifest): Record<TerrainKind, Rgb> {
  const byId = new Map(pack.tiles.map(t => [t.id, t]));
  const out = {} as Record<TerrainKind, Rgb>;
  for (const kind of TERRAIN_KINDS) {
    const slot = byId.get(kind);
    out[kind] = parseHexRgb(slot?.fill ?? '#888888', [136, 136, 136]);
  }
  return out;
}

/* Renders a full ProceduralMap into a crisp canvas at scale px/tile (default 2 -> 300x300 for 150x150). */
export function renderProceduralMapPreview(
  canvas: HTMLCanvasElement,
  map: ProceduralMap,
  pack: WorldPackManifest,
  pixelScale = 2,
): void {
  const scale = Math.max(1, Math.floor(pixelScale));
  const cw = map.width * scale;
  const ch = map.height * scale;
  canvas.width = cw;
  canvas.height = ch;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const baseRgb = buildKindPalette(pack);
  const img = ctx.createImageData(cw, ch);
  const data = img.data;
  const { width, height, tiles } = map;

  const idxOf = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= width || y >= height) return -1;
    return tiles[y * width + x] ?? -1;
  };

  for (let y = 0; y < height; y++) {
    const row = map.bounds.minRow + y;
    for (let x = 0; x < width; x++) {
      const col = map.bounds.minCol + x;
      const ti = tiles[y * width + x]!;
      const kind = TERRAIN_KINDS[ti]!;
      let rgb = baseRgb[kind];

      if (kind === 'river') {
        /* Deepen center of river away from banks so bends and currents read clearly. */
        const nearShore =
          idxOf(x - 1, y) !== ti || idxOf(x + 1, y) !== ti || idxOf(x, y - 1) !== ti || idxOf(x, y + 1) !== ti;
        rgb = nearShore ? shadeRgb(rgb, 14) : shadeRgb(rgb, -14);
      } else if (kind === 'ridge') {
        /* Directional top-left sun hillshading highlights northwest crests and shadows southeast slopes. */
        const litEdge = idxOf(x - 1, y) !== ti || idxOf(x, y - 1) !== ti;
        const shadowEdge = idxOf(x + 1, y) !== ti || idxOf(x, y + 1) !== ti;
        if (litEdge && !shadowEdge) rgb = shadeRgb(rgb, 36);
        else if (shadowEdge && !litEdge) rgb = shadeRgb(rgb, -32);
        else if (((col + row) & 3) === 0) rgb = shadeRgb(rgb, 10);
      } else if (kind === 'quarry') {
        /* Terraced stone bands distinguish quarry outcrops along ridge foothills. */
        const step = (col - row) & 3;
        rgb = step === 0 ? shadeRgb(rgb, 20) : step === 2 ? shadeRgb(rgb, -16) : rgb;
      } else if (kind === 'dune') {
        /* Subtle diagonal wind-wave ripples give dunes clear texture against flat plains. */
        const wave = (col + row) & 3;
        rgb = wave === 0 ? shadeRgb(rgb, 14) : wave === 2 ? shadeRgb(rgb, -12) : rgb;
      } else if (kind === 'field') {
        /* Agricultural plot borders inside the fertile valley. */
        if (col % 5 === 0 || row % 5 === 0) rgb = shadeRgb(rgb, -14);
        else if (((col + row) & 1) === 0) rgb = shadeRgb(rgb, 5);
      } else if (kind === 'plain' && ((col ^ row) & 7) === 0) {
        rgb = shadeRgb(rgb, -4);
      }

      const [r, g, b] = rgb;
      for (let sy = 0; sy < scale; sy++) {
        let off = ((y * scale + sy) * cw + x * scale) * 4;
        for (let sx = 0; sx < scale; sx++) {
          data[off++] = r;
          data[off++] = g;
          data[off++] = b;
          data[off++] = 255;
        }
      }
    }
  }

  ctx.putImageData(img, 0, 0);

  /* Draw crisp city center star pin right over the chosen flat riverside site. */
  const cx = (map.cityCenter.col - map.bounds.minCol + 0.5) * scale;
  const cy = (map.cityCenter.row - map.bounds.minRow + 0.5) * scale;
  const outerR = Math.max(6, scale * 3.8);
  const innerR = outerR * 0.45;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, outerR + 2.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(15, 22, 32, 0.85)';
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = cx + Math.cos(angle) * r;
    const py = cy + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = '#FFD166';
  ctx.fill();
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = '#141B24';
  ctx.stroke();
  ctx.restore();
}
