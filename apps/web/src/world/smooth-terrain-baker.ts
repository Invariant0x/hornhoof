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

const TEX_SIZE = 256;
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

/* C2-smooth toroidal 2D value noise wrapping seamlessly over [0, periodX) x [0, periodY). */
function periodicNoise2D(
  x: number,
  y: number,
  periodX: number,
  periodY: number,
  seed: number,
): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const sy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);

  const ix0 = ((x0 % periodX) + periodX) % periodX;
  const iy0 = ((y0 % periodY) + periodY) % periodY;
  const ix1 = (ix0 + 1) % periodX;
  const iy1 = (iy0 + 1) % periodY;

  const n00 = hash2i(ix0, iy0, seed);
  const n10 = hash2i(ix1, iy0, seed);
  const n01 = hash2i(ix0, iy1, seed);
  const n11 = hash2i(ix1, iy1, seed);

  const nx0 = n00 + (n10 - n00) * sx;
  const nx1 = n01 + (n11 - n01) * sx;
  return nx0 + (nx1 - nx0) * sy;
}

/* 45-degree rotated periodic noise over [0, 1) x [0, 1): eliminates axis-aligned grid feel while
   remaining strictly periodic because integer period shifts (u+1, v) and (u, v+1) map identically. */
function periodicDiagNoise(u: number, v: number, period: number, seed: number): number {
  return periodicNoise2D((u + v) * period, (u - v) * period, period, period, seed);
}

function getNoiseLuts(): { coarse: Float32Array; detail: Float32Array } {
  if (!sharedNoiseLut || !sharedDetailLut) {
    sharedNoiseLut = new Float32Array(NOISE_LUT_SIZE * NOISE_LUT_SIZE);
    sharedDetailLut = new Float32Array(NOISE_LUT_SIZE * NOISE_LUT_SIZE);
    for (let y = 0; y < NOISE_LUT_SIZE; y++) {
      for (let x = 0; x < NOISE_LUT_SIZE; x++) {
        const u = x / NOISE_LUT_SIZE;
        const v = y / NOISE_LUT_SIZE;
        const n1 = periodicNoise2D(u * 12, v * 12, 12, 12, 0x243f6a88);
        const n2 = periodicDiagNoise(u, v, 16, 0x85a308d3);
        sharedNoiseLut[y * NOISE_LUT_SIZE + x] = n1 * 0.65 + n2 * 0.35 - 0.5;
        sharedDetailLut[y * NOISE_LUT_SIZE + x] =
          periodicDiagNoise(u, v, 32, 0x13198a2e) - 0.5;
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

/* Synthesizes a strictly seamless toroidal 256x256 RGB ground texture from a pack's GroundMaterialSpec. */
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
    const v = y / TEX_SIZE;
    for (let x = 0; x < TEX_SIZE; x++) {
      const u = x / TEX_SIZE;
      const macro =
        periodicNoise2D(u * 4, v * 4, 4, 4, seed) * 0.62 +
        periodicDiagNoise(u, v, 5, seed + 7) * 0.38;
      const mid =
        periodicDiagNoise(u, v, 11, seed + 17) * 0.55 +
        periodicNoise2D(u * 14, v * 14, 14, 14, seed + 29) * 0.45;
      const fine = periodicNoise2D(u * 36, v * 36, 36, 36, seed + 53) - 0.5;
      const micro = periodicDiagNoise(u, v, 48, seed + 67) - 0.5;

      let blend = macro * 0.55 + mid * 0.45;
      let accent = 0;

      if (spec.pattern === 'fine_grain') {
        const drift = periodicNoise2D(u * 8, v * 8, 8, 8, seed + 83);
        blend = macro * 0.48 + drift * 0.34 + mid * 0.18 + fine * 0.16 * contrast + micro * 0.08;
        const sparkle = periodicDiagNoise(u, v, 24, seed + 97);
        if (sparkle > 0.72) accent = smoothstep(0.72, 0.92, sparkle) * 0.34 * contrast;
      } else if (spec.pattern === 'grass_tufts') {
        /* Isotropic ground-space meadow; isometric (u, v) sampling projects it flat onto the terrain. */
        const patch = periodicDiagNoise(u, v, 6, seed + 89);
        const tuft = periodicNoise2D(u * 16, v * 16, 16, 16, seed + 91);
        const blade = periodicDiagNoise(u, v, 22, seed + 109);
        blend = macro * 0.44 + patch * 0.3 + tuft * 0.26 + fine * 0.1;
        const sunlit = tuft * 0.55 + blade * 0.45;
        if (sunlit > 0.62) accent = smoothstep(0.62, 0.88, sunlit) * 0.44 * contrast;
      } else if (spec.pattern === 'furrows') {
        /* Ground-axis crop furrows automatically projected onto the 2:1 isometric tile plane. */
        const phase = u * 16 * Math.PI * 2 + (macro - 0.5) * 1.1;
        const stripe = 0.5 + 0.5 * Math.sin(phase);
        blend = stripe * 0.58 + macro * 0.28 + mid * 0.14 + fine * 0.08;
        if (stripe > 0.7) accent = smoothstep(0.7, 0.98, stripe) * 0.32;
      } else if (spec.pattern === 'wind_ripples') {
        const phase = (u * 5 + v * 5) * Math.PI * 2 + (macro - 0.5) * 2.1;
        const wave = 0.5 + 0.5 * Math.sin(phase);
        blend = wave * 0.56 + macro * 0.32 + mid * 0.12 + fine * 0.08;
        if (wave > 0.72) accent = smoothstep(0.72, 0.98, wave) * 0.38;
      } else if (spec.pattern === 'cracked_rock') {
        const r1 = 1 - Math.abs(2 * periodicDiagNoise(u, v, 6, seed + 131) - 1);
        const r2 = 1 - Math.abs(2 * periodicNoise2D(u * 14, v * 14, 14, 14, seed + 193) - 1);
        const r3 = 1 - Math.abs(2 * periodicDiagNoise(u, v, 22, seed + 211) - 1);
        const strata = r1 * 0.5 + r2 * 0.32 + r3 * 0.18;
        blend = strata * 0.72 + macro * 0.28 + fine * 0.12;
        if (strata > 0.72) accent = smoothstep(0.72, 0.94, strata) * 0.48;
      } else if (spec.pattern === 'cut_stone') {
        /* Ground-plane staggered masonry blocks projected onto isometric tiles. */
        const su = u * 8;
        const sv = v * 4;
        const rowId = Math.floor(sv);
        const bx = (((su + (rowId & 1) * 0.5) % 1) + 1) % 1;
        const by = ((sv % 1) + 1) % 1;
        const edge = Math.min(bx, 1 - bx, by, 1 - by);
        const mortar = 1 - smoothstep(0.03, 0.09, edge);
        blend = (1 - mortar) * (0.45 + macro * 0.36 + mid * 0.19 + fine * 0.1) + mortar * 0.14;
        if (mortar < 0.2 && (bx < 0.18 || by < 0.18)) accent = 0.32;
      } else if (spec.pattern === 'moss_glow') {
        /* Smooth isotropic bioluminescent spore clusters foreshortened flat onto the cavern floor. */
        const cluster1 = periodicDiagNoise(u, v, 8, seed + 241);
        const cluster2 = periodicNoise2D(u * 16, v * 16, 16, 16, seed + 263);
        const glow = cluster1 * 0.55 + cluster2 * 0.45;
        blend = macro * 0.5 + mid * 0.5;
        if (glow > 0.62) accent = smoothstep(0.62, 0.88, glow) * 0.92;
      } else if (spec.pattern === 'paved_stone') {
        /* Ground-space flagstones (2x2 per tile) that project as true 2:1 isometric diamond slabs. */
        const duRaw = u * 8;
        const dvRaw = v * 8;
        const cellU = ((Math.floor(duRaw) % 8) + 8) % 8;
        const cellV = ((Math.floor(dvRaw) % 8) + 8) % 8;
        const slabTone = hash2i(cellU, cellV, seed + 307);
        const fx = ((duRaw % 1) + 1) % 1;
        const fy = ((dvRaw % 1) + 1) % 1;
        const edge = Math.min(fx, 1 - fx, fy, 1 - fy);
        const seam = 1 - smoothstep(0.035, 0.09, edge);
        const surface = 0.34 + slabTone * 0.26 + macro * 0.24 + mid * 0.16 + fine * 0.1;
        blend = surface * (1 - seam * 0.7) + seam * 0.08;
        if (seam < 0.25 && (fx < 0.16 || fy < 0.16)) accent = 0.22 * (1 - seam);
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

/* Pure pixel synthesizer for a strictly seamless toroidal animated liquid tile (testable in Node). */
export function buildLiquidSurfacePixels(spec: LiquidLayerSpec, size = 256): Uint8ClampedArray {
  const base = parseHexRgb(spec.baseColor, [40, 128, 175]);
  const deep = parseHexRgb(spec.deepColor, [24, 92, 138]);
  const hi = parseHexRgb(spec.highlightColor, [120, 206, 232]);
  const seed = hashSeed(`${spec.baseColor}|${spec.deepColor}|${spec.highlightColor}`);

  const data = new Uint8ClampedArray(size * size * 4);
  let off = 0;

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      /* Soft periodic domain warp breaks all grid symmetry while preserving exact toroidal wrap. */
      const warpX = (periodicNoise2D(u * 4, v * 4, 4, 4, seed + 13) - 0.5) * 0.06;
      const warpY = (periodicNoise2D(u * 4, v * 4, 4, 4, seed + 37) - 0.5) * 0.06;
      const wu = u + warpX;
      const wv = v + warpY;

      const wave1 = periodicNoise2D(wu * 6, wv * 6, 6, 6, seed);
      const wave2 = periodicDiagNoise(wu, wv, 5, seed + 71);
      const wave3 = periodicNoise2D(wu * 10, wv * 10, 10, 10, seed + 101);

      const cA = 1 - Math.abs(2 * periodicDiagNoise(wu, wv, 6, seed + 139) - 1);
      const cB = 1 - Math.abs(2 * periodicNoise2D(wu * 10, wv * 10, 10, 10, seed + 181) - 1);
      const caustic = cA * 0.6 + cB * 0.4;
      const ripple = Math.pow(caustic, spec.glow ? 2.8 : 4.6);

      const mix = Math.max(0, Math.min(1, wave1 * 0.45 + wave2 * 0.35 + wave3 * 0.2));
      let r = deep[0] + (base[0] - deep[0]) * mix;
      let g = deep[1] + (base[1] - deep[1]) * mix;
      let b = deep[2] + (base[2] - deep[2]) * mix;

      const shimmer = ripple * (spec.glow ? 0.78 : 0.42);
      r += (hi[0] - r) * shimmer;
      g += (hi[1] - g) * shimmer;
      b += (hi[2] - b) * shimmer;

      data[off++] = clampByte(r);
      data[off++] = clampByte(g);
      data[off++] = clampByte(b);
      data[off++] = 255;
    }
  }
  return data;
}

/* Synthesizes a seamless 256x256 tileable animated liquid canvas (shimmering currents or glowing liquid). */
export function buildLiquidSurfaceCanvas(spec: LiquidLayerSpec, size = 256): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const pixels = buildLiquidSurfacePixels(spec, size);
  const img = ctx.createImageData(size, size);
  img.data.set(pixels);
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
  const maxColIdx = cf.cols - 1;
  const maxRowIdx = cf.rows - 1;
  const lu = Math.max(0, Math.min(maxColIdx, u - cf.minCol));
  const lv = Math.max(0, Math.min(maxRowIdx, v - cf.minRow));
  const x0 = Math.min(maxColIdx, Math.floor(lu));
  const y0 = Math.min(maxRowIdx, Math.floor(lv));
  const x1 = Math.min(maxColIdx, x0 + 1);
  const y1 = Math.min(maxRowIdx, y0 + 1);
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

/* Signed water distance as the baker draws it, with the same shoreline noise: below about 0.08 the picture is water or
   foam. Anything that must stand on dry land (plants, later buildings) checks this, not the raw field. */
export function displayedWaterDistance(cf: CornerFieldGrid, u: number, v: number): number {
  const raw = sampleCornerFieldBilinear(cf, u, v).signedWaterDist;
  if (raw >= 1.35) return raw;
  const { coarse, detail } = getNoiseLuts();
  return raw + sampleLutFast(coarse, u * 4.5, v * 4.5) * 0.5 + sampleLutFast(detail, u * 5.0, v * 5.0) * 0.1;
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
      if (rawWater < -0.95) continue;

      let dWater = rawWater;
      let nCoarse = 0;
      if (rawWater < 1.35) {
        nCoarse = sampleLutFast(coarse, u * 4.5, v * 4.5);
        const nDetail = sampleLutFast(detail, u * 5.0, v * 5.0);
        dWater = rawWater + nCoarse * 0.5 + nDetail * 0.1;
        /* Deep liquid cutout: transparent alpha lets the separate animated liquid layer shine through. */
        if (dWater < -0.26) continue;
      }

      /* Compute directional top-left 5200K hillshading from continuous elevation gradient. */
      const e00 = elevArr[i00]!;
      const e10 = elevArr[i10]!;
      const e01 = elevArr[i01]!;
      const e11 = elevArr[i11]!;
      const dEdu = (e10 - e00) * (1 - fy) + (e11 - e01) * fy;
      const dEdv = (e01 - e00) * (1 - fx) + (e11 - e10) * fx;
      const shade = Math.max(0.76, Math.min(1.22, 1.0 - (dEdu * 0.55 + dEdv * 0.55)));

      /* Project material textures onto the isometric ground plane via global tile coordinates (u, v):
         64 texels per tile = one seamless 256x256 texture repeat across every 4x4 ground tiles. */
      const tfx = u * 64;
      const tfy = v * 64;
      const tx0 = Math.floor(tfx);
      const ty0 = Math.floor(tfy);
      const tFracX = tfx - tx0;
      const tFracY = tfy - ty0;
      const tx0m = tx0 & TEX_MASK;
      const tx1m = (tx0 + 1) & TEX_MASK;
      const row0Off = (ty0 & TEX_MASK) * TEX_SIZE;
      const row1Off = ((ty0 + 1) & TEX_MASK) * TEX_SIZE;
      const idx00 = (row0Off + tx0m) * 3;
      const idx10 = (row0Off + tx1m) * 3;
      const idx01 = (row1Off + tx0m) * 3;
      const idx11 = (row1Off + tx1m) * 3;
      const tw00 = (1 - tFracX) * (1 - tFracY);
      const tw10 = tFracX * (1 - tFracY);
      const tw01 = (1 - tFracX) * tFracY;
      const tw11 = tFracX * tFracY;

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
        r = tex[idx00]! * tw00 + tex[idx10]! * tw10 + tex[idx01]! * tw01 + tex[idx11]! * tw11;
        g = tex[idx00 + 1]! * tw00 + tex[idx10 + 1]! * tw10 + tex[idx01 + 1]! * tw01 + tex[idx11 + 1]! * tw11;
        b = tex[idx00 + 2]! * tw00 + tex[idx10 + 2]! * tw10 + tex[idx01 + 2]! * tw01 + tex[idx11 + 2]! * tw11;
      } else {
        const edgeN = nCoarse !== 0 ? nCoarse : sampleLutFast(coarse, u * 5.5, v * 5.5);
        let wSum = 0;
        for (let m = 0; m < matCount; m++) {
          const raw = wBuf[m]!;
          if (raw <= 0.005) {
            wBuf[m] = 0;
            continue;
          }
          const sign = (m & 1) === 0 ? 1 : -1;
          const perturbed = Math.max(0, raw + edgeN * sign * 0.14);
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
            r += (tex[idx00]! * tw00 + tex[idx10]! * tw10 + tex[idx01]! * tw01 + tex[idx11]! * tw11) * k;
            g += (tex[idx00 + 1]! * tw00 + tex[idx10 + 1]! * tw10 + tex[idx01 + 1]! * tw01 + tex[idx11 + 1]! * tw11) * k;
            b += (tex[idx00 + 2]! * tw00 + tex[idx10 + 2]! * tw10 + tex[idx01 + 2]! * tw01 + tex[idx11 + 2]! * tw11) * k;
          }
        } else {
          const tex = textures[maxM]!;
          r = tex[idx00]! * tw00 + tex[idx10]! * tw10 + tex[idx01]! * tw01 + tex[idx11]! * tw11;
          g = tex[idx00 + 1]! * tw00 + tex[idx10 + 1]! * tw10 + tex[idx01 + 1]! * tw01 + tex[idx11 + 1]! * tw11;
          b = tex[idx00 + 2]! * tw00 + tex[idx10 + 2]! * tw10 + tex[idx01 + 2]! * tw01 + tex[idx11 + 2]! * tw11;
        }
      }

      r *= shade;
      g *= shade;
      b *= shade;

      let alpha = 255;
      if (dWater < 0.62) {
        /* Damp shore darkening (or warm emissive rim glow) hugging the curved coastline smoothly. */
        const wetFactor = 1 - smoothstep(0.05, 0.62, dWater);
        if (isGlowLiquid) {
          r += (shallowRgb[0] - r) * wetFactor * 0.52;
          g += (shallowRgb[1] - g) * wetFactor * 0.52;
          b += (shallowRgb[2] - b) * wetFactor * 0.52;
        } else {
          const damp = 1 - wetFactor * 0.2;
          r *= damp;
          g *= damp;
          b *= damp;
        }

        if (dWater < 0.08) {
          /* Curved feathered shoreline edge blending seamlessly into the animated liquid layer. */
          const shoreMask = smoothstep(-0.26, 0.08, dWater);
          alpha = clampByte(shoreMask * 255);
          const shallowMix = 1 - smoothstep(-0.18, 0.08, dWater);
          r += (shallowRgb[0] - r) * shallowMix * 0.62;
          g += (shallowRgb[1] - g) * shallowMix * 0.62;
          b += (shallowRgb[2] - b) * shallowMix * 0.62;

          const foamBand = Math.exp(-Math.pow((dWater + 0.04) / 0.075, 2));
          const foamStrength = isGlowLiquid ? 0.68 : 0.36;
          r += (foamRgb[0] - r) * foamBand * foamStrength;
          g += (foamRgb[1] - g) * foamBand * foamStrength;
          b += (foamRgb[2] - b) * foamBand * foamStrength;
        }
      }

      if (
        alpha < 255 &&
        (u < chunk.colStart || u >= chunk.colEnd || v < chunk.rowStart || v >= chunk.rowEnd)
      ) {
        continue;
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
