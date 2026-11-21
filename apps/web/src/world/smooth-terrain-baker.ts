/* Smooth material-blended isometric terrain chunk baker and animated liquid surface synthesizer.
   Replaces staircased flat diamonds with seamless blended ground textures driven by continuous
   corner fields (elevation, moisture, signed liquid distance and material blend masks), plus
   soft organic edge noise and alpha-feathered curved shorelines exposing the animated liquid layer.
   Contains zero theme-specific words, files or colours. */

import type { BakedChunk } from './chunk-baker';
import type { ChunkCoord } from './chunks';
import { worldToTileFloat } from './coords';
import type {
  GroundMaterialSpec,
  LiquidLayerSpec,
  LodTierSpec,
  WorldPackManifest,
} from './manifest';
import { hash2i, hashSeed, valueNoise2D } from './prng';
import type { CornerFieldGrid, GeneratedWorldMap } from './terrain-engine';

type Rgb = readonly [number, number, number];

const TEX_SIZE = 128;
const TEX_MASK = TEX_SIZE - 1;
const NOISE_LUT_SIZE = 256;
const NOISE_LUT_MASK = NOISE_LUT_SIZE - 1;
const BAKE_PAD_PX = 2;

const materialCache = new Map<string, Uint8ClampedArray>();
let sharedNoiseLut: Float32Array | null = null;
let sharedDetailLut: Float32Array | null = null;

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

/* Periodic 2D value noise that wraps seamlessly across [0, period) in both X and Y. */
function periodicNoise2D(x: number, y: number, period: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);

  const ix0 = ((x0 % period) + period) % period;
  const iy0 = ((y0 % period) + period) % period;
  const ix1 = (ix0 + 1) % period;
  const iy1 = (iy0 + 1) % period;

  const n00 = hash2i(ix0, iy0, seed);
  const n10 = hash2i(ix1, iy0, seed);
  const n01 = hash2i(ix0, iy1, seed);
  const n11 = hash2i(ix1, iy1, seed);

  const nx0 = n00 + (n10 - n00) * sx;
  const nx1 = n01 + (n11 - n01) * sx;
  return nx0 + (nx1 - nx0) * sy;
}

function getNoiseLuts(): { coarse: Float32Array; detail: Float32Array } {
  if (!sharedNoiseLut || !sharedDetailLut) {
    sharedNoiseLut = new Float32Array(NOISE_LUT_SIZE * NOISE_LUT_SIZE);
    sharedDetailLut = new Float32Array(NOISE_LUT_SIZE * NOISE_LUT_SIZE);
    for (let y = 0; y < NOISE_LUT_SIZE; y++) {
      for (let x = 0; x < NOISE_LUT_SIZE; x++) {
        const u = (x / NOISE_LUT_SIZE) * 16;
        const v = (y / NOISE_LUT_SIZE) * 16;
        const n1 = periodicNoise2D(u, v, 16, 0x243f6a88);
        const n2 = periodicNoise2D(u * 2, v * 2, 32, 0x85a308d3);
        sharedNoiseLut[y * NOISE_LUT_SIZE + x] = n1 * 0.68 + n2 * 0.32 - 0.5;
        sharedDetailLut[y * NOISE_LUT_SIZE + x] = periodicNoise2D(u * 4, v * 4, 64, 0x13198a2e) - 0.5;
      }
    }
  }
  return { coarse: sharedNoiseLut, detail: sharedDetailLut };
}

function sampleLutFast(lut: Float32Array, fx: number, fy: number): number {
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const ix0 = x0 & NOISE_LUT_MASK;
  const iy0 = y0 & NOISE_LUT_MASK;
  const ix1 = (ix0 + 1) & NOISE_LUT_MASK;
  const iy1 = (iy0 + 1) & NOISE_LUT_MASK;
  const r0 = iy0 << 8;
  const r1 = iy1 << 8;
  const v00 = lut[r0 + ix0]!;
  const v01 = lut[r1 + ix0]!;
  const a = v00 + (lut[r0 + ix1]! - v00) * tx;
  const b = v01 + (lut[r1 + ix1]! - v01) * tx;
  return a + (b - a) * ty;
}

/* Synthesizes a seamless tileable 128x128 RGB ground texture from a pack's GroundMaterialSpec. */
export function getMaterialTextureRgb(spec: GroundMaterialSpec): Uint8ClampedArray {
  const key = `${spec.id}|${spec.baseColor}|${spec.secondaryColor}|${spec.accentColor}|${spec.pattern}|${spec.contrast ?? 1}`;
  const cached = materialCache.get(key);
  if (cached) return cached;

  const c0 = parseHexRgb(spec.baseColor, [180, 160, 130]);
  const c1 = parseHexRgb(spec.secondaryColor, [150, 132, 104]);
  const c2 = parseHexRgb(spec.accentColor, [215, 198, 165]);
  const contrast = spec.contrast ?? 1;
  const seed = hashSeed(key);

  const buf = new Uint8ClampedArray(TEX_SIZE * TEX_SIZE * 3);
  let off = 0;

  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const u = x / TEX_SIZE;
      const v = y / TEX_SIZE;
      const macro = periodicNoise2D(u * 8, v * 8, 8, seed);
      const mid = periodicNoise2D(u * 20, v * 20, 20, seed + 17);
      const grain = hash2i(x, y, seed + 53) - 0.5;

      let blend = macro * 0.58 + mid * 0.42;
      let accent = 0;

      if (spec.pattern === 'fine_grain') {
        blend += grain * 0.16 * contrast;
        if (mid > 0.72 && grain > 0.15) accent = 0.28;
      } else if (spec.pattern === 'grass_tufts') {
        const blade = periodicNoise2D(u * 32, v * 16, 32, seed + 91);
        blend = macro * 0.45 + blade * 0.55 + grain * 0.12;
        if (blade > 0.74) accent = 0.42 * contrast;
      } else if (spec.pattern === 'furrows') {
        const stripe = 0.5 + 0.5 * Math.sin((u * 10 + v * 10) * Math.PI * 2 + macro * 1.4);
        blend = stripe * 0.65 + macro * 0.35;
        if (stripe > 0.78) accent = 0.35;
      } else if (spec.pattern === 'wind_ripples') {
        const wave = 0.5 + 0.5 * Math.sin((u * 6 + v * 12) * Math.PI * 2 + macro * 2.4);
        blend = wave * 0.6 + macro * 0.4 + grain * 0.08;
        if (wave > 0.76) accent = 0.36;
      } else if (spec.pattern === 'cracked_rock') {
        const r1 = 1 - Math.abs(2 * periodicNoise2D(u * 12, v * 12, 12, seed + 131) - 1);
        const r2 = 1 - Math.abs(2 * periodicNoise2D(u * 24, v * 24, 24, seed + 193) - 1);
        const crack = r1 * 0.6 + r2 * 0.4;
        blend = crack * 0.75 + macro * 0.25 + grain * 0.14;
        if (crack > 0.8) accent = 0.45;
      } else if (spec.pattern === 'cut_stone') {
        const rowId = Math.floor(v * 8);
        const bx = ((u * 4 + (rowId & 1) * 0.5) % 1 + 1) % 1;
        const by = (v * 8) % 1;
        const mortar = bx < 0.07 || by < 0.1;
        blend = mortar ? 0.12 : 0.45 + macro * 0.4 + grain * 0.12;
        if (!mortar && (bx < 0.15 || by < 0.18)) accent = 0.38;
      } else if (spec.pattern === 'moss_glow') {
        const speck = periodicNoise2D(u * 24, v * 24, 24, seed + 241);
        blend = macro * 0.5 + mid * 0.5;
        if (speck > 0.72) accent = (speck - 0.72) * 3.2;
      } else if (spec.pattern === 'paved_stone') {
        const gx = (u * 6) % 1;
        const gy = (v * 6) % 1;
        const seam = gx < 0.08 || gy < 0.08;
        blend = seam ? 0.15 : 0.45 + macro * 0.35 + grain * 0.1;
        if (!seam && (gx < 0.16 || gy < 0.16)) accent = 0.3;
      }

      const t = Math.max(0, Math.min(1, blend));
      let r = c1[0] + (c0[0] - c1[0]) * t;
      let g = c1[1] + (c0[1] - c1[1]) * t;
      let b = c1[2] + (c0[2] - c1[2]) * t;
      if (accent > 0) {
        const a = Math.min(1, accent);
        r += (c2[0] - r) * a;
        g += (c2[1] - g) * a;
        b += (c2[2] - b) * a;
      }

      buf[off++] = clampByte(r);
      buf[off++] = clampByte(g);
      buf[off++] = clampByte(b);
    }
  }

  materialCache.set(key, buf);
  return buf;
}

/* Synthesizes a seamless 256x256 tileable animated liquid texture (shimmering currents or glowing liquid). */
export function buildLiquidSurfaceCanvas(spec: LiquidLayerSpec, size = 256): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const base = parseHexRgb(spec.baseColor, [40, 128, 175]);
  const deep = parseHexRgb(spec.deepColor, [24, 92, 138]);
  const hi = parseHexRgb(spec.highlightColor, [120, 206, 232]);
  const seed = hashSeed(`${spec.baseColor}|${spec.deepColor}|${spec.highlightColor}`);

  const img = ctx.createImageData(size, size);
  const data = img.data;
  let off = 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const wave1 = periodicNoise2D(u * 8, v * 16, 16, seed);
      const wave2 = periodicNoise2D(u * 16 + 3.1, v * 8 - 1.7, 16, seed + 71);
      const caustic = 1 - Math.abs(2 * periodicNoise2D(u * 12, v * 20, 20, seed + 139) - 1);
      const ripple = Math.pow(caustic, spec.glow ? 3.0 : 4.2);

      const mix = Math.max(0, Math.min(1, wave1 * 0.55 + wave2 * 0.45));
      let r = deep[0] + (base[0] - deep[0]) * mix;
      let g = deep[1] + (base[1] - deep[1]) * mix;
      let b = deep[2] + (base[2] - deep[2]) * mix;

      const shimmer = ripple * (spec.glow ? 0.72 : 0.48);
      r += (hi[0] - r) * shimmer;
      g += (hi[1] - g) * shimmer;
      b += (hi[2] - b) * shimmer;

      data[off++] = clampByte(r);
      data[off++] = clampByte(g);
      data[off++] = clampByte(b);
      data[off++] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export type BilinearCornerSample = Readonly<{
  elevation: number;
  moisture: number;
  signedWaterDist: number;
  weights: readonly number[];
}>;

/* Continuous bilinear interpolation of the smooth corner fields at any fractional (u, v). */
export function sampleCornerFieldBilinear(cf: CornerFieldGrid, u: number, v: number): BilinearCornerSample {
  const lu = Math.max(0, Math.min(cf.cols - 1.0001, u - cf.minCol));
  const lv = Math.max(0, Math.min(cf.rows - 1.0001, v - cf.minRow));
  const x0 = Math.floor(lu);
  const y0 = Math.floor(lv);
  const x1 = Math.min(cf.cols - 1, x0 + 1);
  const y1 = Math.min(cf.rows - 1, y0 + 1);
  const fx = lu - x0;
  const fy = lv - y0;

  const i00 = y0 * cf.cols + x0;
  const i10 = y0 * cf.cols + x1;
  const i01 = y1 * cf.cols + x0;
  const i11 = y1 * cf.cols + x1;

  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;

  const interp = (arr: Float32Array): number =>
    arr[i00]! * w00 + arr[i10]! * w10 + arr[i01]! * w01 + arr[i11]! * w11;

  const weights = cf.layerWeights.map(arr => interp(arr));
  return {
    elevation: interp(cf.elevation),
    moisture: interp(cf.moisture),
    signedWaterDist: interp(cf.signedWaterDist),
    weights,
  };
}

export type SmoothBakedPixels = Readonly<{
  rgba: Uint8ClampedArray;
  worldX: number;
  worldY: number;
  scale: number;
  pixelWidth: number;
  pixelHeight: number;
  tileCount: number;
}>;

/* Pure pixel baker for one chunk using smooth bilinear corner fields, noise-feathered masks,
   seamless material textures, directional top-left elevation shading and curved liquid cutouts.
   Works both in Node/jsdom unit tests (no canvas 2D needed) and live browser WebGL texture upload. */
export function bakeSmoothChunkPixels(
  chunk: ChunkCoord,
  map: GeneratedWorldMap,
  pack: WorldPackManifest,
  lod: LodTierSpec,
): SmoothBakedPixels {
  const baseTileW = pack.projection.defaultTileW;
  const baseTileH = pack.projection.defaultTileH;
  /* Cap raster scale at 2x (4x LOD = 240x120) so smooth terrain chunks stay crisp and fast to bake. */
  const scale = Math.min(2, lod.tileW / baseTileW);
  const invScale = 1 / scale;

  const worldWidth = chunk.bounds.maxX - chunk.bounds.minX;
  const worldHeight = chunk.bounds.maxY - chunk.bounds.minY;
  const pixelWidth = Math.max(2, Math.ceil(worldWidth * scale) + BAKE_PAD_PX * 2);
  const pixelHeight = Math.max(2, Math.ceil(worldHeight * scale) + BAKE_PAD_PX * 2);
  const rgba = new Uint8ClampedArray(pixelWidth * pixelHeight * 4);

  const worldX = chunk.bounds.minX - BAKE_PAD_PX * invScale;
  const worldY = chunk.bounds.minY - BAKE_PAD_PX * invScale;

  const cf = map.cornerFields;
  const matCount = cf.materialIds.length;
  const matById = new Map((pack.materials ?? []).map(m => [m.id, m]));
  const textures: Uint8ClampedArray[] = cf.materialIds.map(id => {
    const spec = matById.get(id) ?? pack.materials?.[0] ?? {
      id,
      baseColor: '#B8A888',
      secondaryColor: '#9E8E70',
      accentColor: '#D0C0A0',
      pattern: 'fine_grain' as const,
    };
    return getMaterialTextureRgb(spec);
  });

  const liquid = pack.liquidLayer;
  const shallowRgb = parseHexRgb(liquid?.shallowTintColor ?? '#489FB5', [72, 159, 181]);
  const foamRgb = parseHexRgb(liquid?.shoreFoamColor ?? '#CFEAEF', [207, 234, 239]);
  const isGlowLiquid = Boolean(liquid?.glow);

  const { coarse, detail } = getNoiseLuts();
  const cCols = cf.cols;
  const cMaxX = cf.cols - 1;
  const cMaxY = cf.rows - 1;
  const minCol = cf.minCol;
  const minRow = cf.minRow;
  const elevArr = cf.elevation;
  const waterArr = cf.signedWaterDist;
  const layerArrs = cf.layerWeights;

  const du = invScale / baseTileW;
  const dv = -invScale / baseTileW;
  /* Tiny fractional epsilon ensures zero hairline gap between neighboring chunk textures. */
  const eps = 0.015;
  const cStart = chunk.colStart - eps;
  const cEnd = chunk.colEnd + eps;
  const rStart = chunk.rowStart - eps;
  const rEnd = chunk.rowEnd + eps;

  /* Reusable scratch buffer avoids per-pixel GC allocations. */
  const wBuf = new Float32Array(matCount);

  for (let py = 0; py < pixelHeight; py++) {
    const wy = worldY + (py + 0.5) * invScale;
    const rowStartTile = worldToTileFloat(worldX + 0.5 * invScale, wy, baseTileW, baseTileH);
    const u0 = rowStartTile.col;
    const v0 = rowStartTile.row;

    /* Exact diamond scanline clip: u0 + px * du in [cStart, cEnd) and v0 + px * dv in [rStart, rEnd). */
    const pxMinU = Math.ceil((cStart - u0) / du);
    const pxMaxU = Math.floor((cEnd - u0) / du);
    const pxMinV = Math.ceil((rEnd - v0) / dv);
    const pxMaxV = Math.floor((rStart - v0) / dv);
    const pxStart = Math.max(0, pxMinU, pxMinV);
    const pxEnd = Math.min(pixelWidth - 1, pxMaxU, pxMaxV);
    if (pxStart > pxEnd) continue;

    let u = u0 + pxStart * du;
    let v = v0 + pxStart * dv;
    const ty = Math.floor(wy * 0.9) & TEX_MASK;
    const texRowOff = ty * TEX_SIZE;
    let out = (py * pixelWidth + pxStart) * 4;

    for (let px = pxStart; px <= pxEnd; px++, u += du, v += dv, out += 4) {
      const lu = u - minCol;
      const lv = v - minRow;
      if (lu < 0 || lv < 0 || lu >= cMaxX || lv >= cMaxY) continue;

      const x0 = lu | 0;
      const y0 = lv | 0;
      const fx = lu - x0;
      const fy = lv - y0;

      const i00 = y0 * cCols + x0;
      const i10 = i00 + 1;
      const i01 = i00 + cCols;
      const i11 = i01 + 1;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const rawWater =
        waterArr[i00]! * w00 +
        waterArr[i10]! * w10 +
        waterArr[i01]! * w01 +
        waterArr[i11]! * w11;

      /* Fast reject deep interior liquid well clear of the shoreline noise band. */
      if (rawWater < -1.1) continue;

      let dWater = rawWater;
      let nCoarse = 0;
      if (rawWater < 1.5) {
        nCoarse = sampleLutFast(coarse, u * 11.5, v * 11.5);
        const nDetail = sampleLutFast(detail, u * 23.0, v * 23.0);
        dWater = rawWater + nCoarse * 0.62 + nDetail * 0.24;
        /* Deep liquid cutout: transparent alpha lets the separate animated liquid layer shine through. */
        if (dWater < -0.34) continue;
      }

      /* Compute directional top-left 5200K hillshading from continuous elevation gradient. */
      const e00 = elevArr[i00]!;
      const e10 = elevArr[i10]!;
      const e01 = elevArr[i01]!;
      const e11 = elevArr[i11]!;
      const dEdu = (e10 - e00) * (1 - fy) + (e11 - e01) * fy;
      const dEdv = (e01 - e00) * (1 - fx) + (e11 - e10) * fx;
      const shade = Math.max(0.76, Math.min(1.22, 1.0 - (dEdu * 0.55 + dEdv * 0.55)));

      const wx = worldX + (px + 0.5) * invScale;
      const tx = Math.floor(wx * 0.9) & TEX_MASK;
      const texIdx = (texRowOff + tx) * 3;

      /* Fast single-material path when one layer dominates (> 0.96); full smooth noise blend on borders. */
      let maxM = 0;
      let maxW = -1;
      for (let m = 0; m < matCount; m++) {
        const arr = layerArrs[m]!;
        const raw = arr[i00]! * w00 + arr[i10]! * w10 + arr[i01]! * w01 + arr[i11]! * w11;
        wBuf[m] = raw;
        if (raw > maxW) {
          maxW = raw;
          maxM = m;
        }
      }

      let r = 0;
      let g = 0;
      let b = 0;
      if (maxW >= 0.96) {
        const tex = textures[maxM]!;
        r = tex[texIdx]!;
        g = tex[texIdx + 1]!;
        b = tex[texIdx + 2]!;
      } else {
        const edgeN = nCoarse !== 0 ? nCoarse : sampleLutFast(coarse, u * 11.5, v * 11.5);
        let wSum = 0;
        for (let m = 0; m < matCount; m++) {
          const raw = wBuf[m]!;
          if (raw <= 0.005) {
            wBuf[m] = 0;
            continue;
          }
          const sign = (m & 1) === 0 ? 1 : -1;
          const perturbed = Math.max(0, raw + edgeN * sign * 0.16);
          const sharp = perturbed * perturbed;
          wBuf[m] = sharp;
          wSum += sharp;
        }
        if (wSum > 1e-6) {
          const invSum = 1 / wSum;
          for (let m = 0; m < matCount; m++) {
            const wm = wBuf[m]!;
            if (wm <= 0) continue;
            const k = wm * invSum;
            const tex = textures[m]!;
            r += tex[texIdx]! * k;
            g += tex[texIdx + 1]! * k;
            b += tex[texIdx + 2]! * k;
          }
        } else {
          const tex = textures[maxM]!;
          r = tex[texIdx]!;
          g = tex[texIdx + 1]!;
          b = tex[texIdx + 2]!;
        }
      }

      r *= shade;
      g *= shade;
      b *= shade;

      let alpha = 255;
      if (dWater < 0.72) {
        /* Damp shore darkening (or warm emissive rim glow) hugging the curved coastline smoothly. */
        const wetFactor = 1 - smoothstep(0.08, 0.72, dWater);
        if (isGlowLiquid) {
          r += (shallowRgb[0] - r) * wetFactor * 0.48;
          g += (shallowRgb[1] - g) * wetFactor * 0.48;
          b += (shallowRgb[2] - b) * wetFactor * 0.48;
        } else {
          const damp = 1 - wetFactor * 0.16;
          r *= damp;
          g *= damp;
          b *= damp;
        }

        if (dWater < 0.14) {
          /* Curved feathered shoreline edge blending seamlessly into the animated liquid layer. */
          const shoreMask = smoothstep(-0.34, 0.14, dWater);
          alpha = clampByte(shoreMask * 255);
          const shallowMix = 1 - smoothstep(-0.22, 0.12, dWater);
          r += (shallowRgb[0] - r) * shallowMix * 0.65;
          g += (shallowRgb[1] - g) * shallowMix * 0.65;
          b += (shallowRgb[2] - b) * shallowMix * 0.65;

          const foamBand = Math.exp(-Math.pow((dWater + 0.06) / 0.1, 2));
          const foamStrength = isGlowLiquid ? 0.65 : 0.42;
          r += (foamRgb[0] - r) * foamBand * foamStrength;
          g += (foamRgb[1] - g) * foamBand * foamStrength;
          b += (foamRgb[2] - b) * foamBand * foamStrength;
        }
      }

      rgba[out] = clampByte(r);
      rgba[out + 1] = clampByte(g);
      rgba[out + 2] = clampByte(b);
      rgba[out + 3] = alpha;
    }
  }

  return {
    rgba,
    worldX,
    worldY,
    scale,
    pixelWidth,
    pixelHeight,
    tileCount: (chunk.colEnd - chunk.colStart) * (chunk.rowEnd - chunk.rowStart),
  };
}

export function bakeSmoothChunkCanvas(
  chunk: ChunkCoord,
  map: GeneratedWorldMap,
  pack: WorldPackManifest,
  lod: LodTierSpec,
): BakedChunk {
  const baked = bakeSmoothChunkPixels(chunk, map, pack, lod);
  const canvas = document.createElement('canvas');
  canvas.width = baked.pixelWidth;
  canvas.height = baked.pixelHeight;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const img = ctx.createImageData(baked.pixelWidth, baked.pixelHeight);
    img.data.set(baked.rgba);
    ctx.putImageData(img, 0, 0);
  }
  return {
    canvas,
    worldX: baked.worldX,
    worldY: baked.worldY,
    scale: baked.scale,
    pixelWidth: baked.pixelWidth,
    pixelHeight: baked.pixelHeight,
    tileCount: baked.tileCount,
    lodId: lod.id,
  };
}

/* Exposed for smooth 2D gallery overview rendering (shared smooth shoreline logic). */
export function sampleSmoothNoise(u: number, v: number, seed: number): number {
  return valueNoise2D(u, v, seed) - 0.5;
}
