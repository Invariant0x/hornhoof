/* Smooth 2D cartographic overview renderer for any pack's GeneratedWorldMap.
   Blends pack materials across smooth corner fields (curved shorelines, hillshaded elevation,
   distinct liquid layer) and pins the startCenter marker cleanly for 12-seed gallery review.
   Contains zero theme-specific words, files or colours. */

import type { WorldPackManifest } from './manifest';
import { getMaterialTextureRgb } from './smooth-terrain-baker';
import type { GeneratedWorldMap } from './terrain-engine';

type Rgb = readonly [number, number, number];

function parseHexRgb(hex: string, fallback: Rgb): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const v = Number.parseInt(m[1]!, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/* Renders any pack's GeneratedWorldMap into a crisp smooth-blended canvas at pixelScale px/tile. */
export function renderProceduralMapPreview(
  canvas: HTMLCanvasElement,
  map: GeneratedWorldMap,
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

  const cf = map.cornerFields;
  const matCount = cf.materialIds.length;
  const matById = new Map((pack.materials ?? []).map(m => [m.id, m]));
  const textures = cf.materialIds.map(id => {
    const spec = matById.get(id) ?? pack.materials?.[0] ?? {
      id,
      baseColor: '#888888',
      secondaryColor: '#6E6E6E',
      accentColor: '#A0A0A0',
      pattern: 'fine_grain' as const,
    };
    return getMaterialTextureRgb(spec);
  });

  const liquid = pack.liquidLayer;
  const liqBase = parseHexRgb(liquid?.baseColor ?? '#2B7BB5', [43, 123, 181]);
  const liqDeep = parseHexRgb(liquid?.deepColor ?? '#1B5A88', [27, 90, 136]);
  const liqShallow = parseHexRgb(liquid?.shallowTintColor ?? '#4AA4BD', [74, 164, 189]);
  const liqFoam = parseHexRgb(liquid?.shoreFoamColor ?? '#CBE8EE', [203, 232, 238]);
  const isGlow = Boolean(liquid?.glow);

  const img = ctx.createImageData(cw, ch);
  const data = img.data;
  const cCols = cf.cols;
  const maxX = cf.cols - 1;
  const maxY = cf.rows - 1;
  const elevArr = cf.elevation;
  const waterArr = cf.signedWaterDist;
  const layerArrs = cf.layerWeights;
  const wBuf = new Float32Array(matCount);

  let off = 0;
  for (let py = 0; py < ch; py++) {
    const lv = Math.min(maxY - 1e-4, (py + 0.5) / scale);
    const y0 = Math.floor(lv);
    const fy = lv - y0;
    const rowOff = y0 * cCols;
    const ty = (py * 2) & 127;

    for (let px = 0; px < cw; px++, off += 4) {
      const lu = Math.min(maxX - 1e-4, (px + 0.5) / scale);
      const x0 = Math.floor(lu);
      const fx = lu - x0;

      const i00 = rowOff + x0;
      const i10 = i00 + 1;
      const i01 = i00 + cCols;
      const i11 = i01 + 1;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const dWater =
        waterArr[i00]! * w00 +
        waterArr[i10]! * w10 +
        waterArr[i01]! * w01 +
        waterArr[i11]! * w11;

      if (dWater < -0.15) {
        const depth = smoothstep(-0.15, -2.4, dWater);
        const ripple = ((px + py * 2) & 7) === 0 ? 12 : 0;
        const r = liqBase[0] + (liqDeep[0] - liqBase[0]) * depth + ripple;
        const g = liqBase[1] + (liqDeep[1] - liqBase[1]) * depth + ripple;
        const b = liqBase[2] + (liqDeep[2] - liqBase[2]) * depth + ripple;
        data[off] = clampByte(r);
        data[off + 1] = clampByte(g);
        data[off + 2] = clampByte(b);
        data[off + 3] = 255;
        continue;
      }

      const e00 = elevArr[i00]!;
      const e10 = elevArr[i10]!;
      const e01 = elevArr[i01]!;
      const e11 = elevArr[i11]!;
      const dEdu = (e10 - e00) * (1 - fy) + (e11 - e01) * fy;
      const dEdv = (e01 - e00) * (1 - fx) + (e11 - e10) * fx;
      const shade = Math.max(0.74, Math.min(1.24, 1.0 - (dEdu * 0.6 + dEdv * 0.6)));

      let wSum = 0;
      for (let m = 0; m < matCount; m++) {
        const arr = layerArrs[m]!;
        const raw = arr[i00]! * w00 + arr[i10]! * w10 + arr[i01]! * w01 + arr[i11]! * w11;
        const sharp = raw > 0.002 ? raw * raw : 0;
        wBuf[m] = sharp;
        wSum += sharp;
      }

      const tx = (px * 2) & 127;
      const tIdx = (ty * 128 + tx) * 3;
      let r = 0;
      let g = 0;
      let b = 0;
      if (wSum > 1e-6) {
        const inv = 1 / wSum;
        for (let m = 0; m < matCount; m++) {
          const wm = wBuf[m]!;
          if (wm <= 0) continue;
          const k = wm * inv;
          const tex = textures[m]!;
          r += tex[tIdx]! * k;
          g += tex[tIdx + 1]! * k;
          b += tex[tIdx + 2]! * k;
        }
      } else if (textures.length > 0) {
        const tex = textures[0]!;
        r = tex[tIdx]!;
        g = tex[tIdx + 1]!;
        b = tex[tIdx + 2]!;
      }

      r *= shade;
      g *= shade;
      b *= shade;

      if (dWater < 0.35) {
        const edge = 1 - smoothstep(-0.15, 0.35, dWater);
        const mixColor = isGlow ? liqFoam : liqShallow;
        r += (mixColor[0] - r) * edge * 0.55;
        g += (mixColor[1] - g) * edge * 0.55;
        b += (mixColor[2] - b) * edge * 0.55;
      }

      data[off] = clampByte(r);
      data[off + 1] = clampByte(g);
      data[off + 2] = clampByte(b);
      data[off + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);

  /* Crisp star pin showing the chosen startCenter (riverside plateau or central cavern hall). */
  const cx = (map.startCenter.col - map.bounds.minCol + 0.5) * scale;
  const cy = (map.startCenter.row - map.bounds.minRow + 0.5) * scale;
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
