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
import { createRng, hash2i, hashSeed, valueNoise2D } from './prng';
import { terrainArtFor, type ArtPixels, type LoadedTerrainArt } from './terrain-art';
import type { CornerFieldGrid, GeneratedWorldMap } from './terrain-engine';

type Rgb = readonly [number, number, number];

/* 512 texels repeat over 4 x 4 tiles: 128 texels per tile, so strokes and grains stay crisp up to 200% zoom. */
const TEX_SIZE = 512;
const TEXELS_PER_TILE = 128;
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


/* Blends a soft round dot into the wrapping RGB texture. */
function plotDot(buf: Uint8ClampedArray, x: number, y: number, radius: number, rgb: Rgb, alpha: number): void {
  const r = Math.ceil(radius);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.hypot(dx - (x - Math.round(x)), dy - (y - Math.round(y)));
      if (d > radius) continue;
      const a = alpha * (1 - (d / radius) * 0.7);
      const tx = (Math.round(x) + dx) & TEX_MASK;
      const ty = (Math.round(y) + dy) & TEX_MASK;
      const o = (ty * TEX_SIZE + tx) * 3;
      buf[o] += (rgb[0] - buf[o]!) * a;
      buf[o + 1] += (rgb[1] - buf[o + 1]!) * a;
      buf[o + 2] += (rgb[2] - buf[o + 2]!) * a;
    }
  }
}

/* A short tapered blade: wide and faint at the root, thin and bright toward the tip. */
function plotBlade(buf: Uint8ClampedArray, x: number, y: number, angle: number, len: number, bend: number, rgb: Rgb, alpha: number): void {
  const steps = Math.max(3, Math.round(len * 1.4));
  let px = x;
  let py = y;
  let a = angle;
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    plotDot(buf, px, py, 1.15 - 0.55 * t, rgb, alpha * (0.55 + 0.45 * t));
    px += Math.cos(a) * 0.72;
    py += Math.sin(a) * 0.72;
    a += bend / steps;
  }
}

/* Adds hand-drawn detail on top of the noise tones: grass blades, sand grains and soil crumbs, all wrapping. */
function addTextureDetail(buf: Uint8ClampedArray, spec: GroundMaterialSpec, c: readonly [Rgb, Rgb, Rgb], seed: number): void {
  const rng = createRng(seed ^ 0x9e3779b9);
  const [base, dark, light] = c;
  const contrast = spec.contrast ?? 1;
  if (spec.pattern === 'grass_tufts') {
    for (let i = 0; i < 9000; i++) {
      const lit = rng();
      plotBlade(buf, rng() * TEX_SIZE, rng() * TEX_SIZE, rng() * Math.PI * 2, 5 + rng() * 7, (rng() - 0.5) * 1.2, mixRgb(dark, light, lit * lit), 0.5 * contrast);
    }
  } else if (spec.pattern === 'fine_grain' || spec.pattern === 'packed_dust' || spec.pattern === 'wind_ripples') {
    const grains = spec.pattern === 'packed_dust' ? 2600 : 5200;
    for (let i = 0; i < grains; i++) {
      const bright = rng() < 0.5;
      plotDot(buf, rng() * TEX_SIZE, rng() * TEX_SIZE, 0.6 + rng() * 0.9, bright ? mixRgb(base, light, 0.8) : mixRgb(base, dark, 0.8), 0.3 + 0.3 * rng());
    }
    /* A few pebbles with a lit upper-left edge. */
    for (let i = 0; i < 70; i++) {
      const x = rng() * TEX_SIZE;
      const y = rng() * TEX_SIZE;
      const r = 1.4 + rng() * 2.2;
      plotDot(buf, x + 0.8, y + 1, r, mixRgb(base, dark, 0.7), 0.45);
      plotDot(buf, x, y, r, mixRgb(base, light, 0.35), 0.7);
      plotDot(buf, x - r * 0.3, y - r * 0.3, r * 0.45, mixRgb(base, light, 0.9), 0.5);
    }
  } else if (spec.pattern === 'soil_clods') {
    for (let i = 0; i < 3800; i++) {
      plotDot(buf, rng() * TEX_SIZE, rng() * TEX_SIZE, 0.7 + rng() * 1.6, rng() < 0.5 ? mixRgb(base, dark, 0.9) : mixRgb(base, light, 0.7), 0.35 + 0.3 * rng());
    }
  } else if (spec.pattern === 'crop_rows') {
    /* Rows of leafy seedlings along the first texture axis, wobbling a little, with gaps and uneven clumps. The soil
       between them is the secondary colour, the leaves the base colour lit toward the accent on their upper left. */
    const rows = 20;
    const pitch = TEX_SIZE / rows;
    for (let k = 0; k < rows; k++) {
      const y0 = (k + 0.5) * pitch;
      const wob = rng() * Math.PI * 2;
      let x = rng() * 6;
      while (x < TEX_SIZE) {
        const step = 4.5 + rng() * 4.5;
        if (rng() > 0.1) {
          const y = y0 + Math.sin(x * 0.03 + wob) * 1.4 + (rng() - 0.5) * 1.6;
          const rad = 1.9 + rng() * 1.6;
          plotDot(buf, x + 0.9, y + 1.1, rad * 1.05, mixRgb(dark, [40, 30, 18], 0.55), 0.55);
          plotDot(buf, x, y, rad, base, 0.95);
          plotDot(buf, x - rad * 0.35, y - rad * 0.35, rad * 0.55, mixRgb(base, light, 0.75), 0.8);
        }
        x += step;
      }
    }
  } else if (spec.pattern === 'cracked_rock' || spec.pattern === 'cut_stone') {
    for (let i = 0; i < 2600; i++) {
      plotDot(buf, rng() * TEX_SIZE, rng() * TEX_SIZE, 0.6 + rng() * 1.1, rng() < 0.5 ? mixRgb(base, dark, 0.8) : mixRgb(base, light, 0.7), 0.3 + 0.25 * rng());
    }
  }
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
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

      let blend = macro * 0.55 + mid * 0.45;
      let accent = 0;
      let mul = 1;

      if (spec.pattern === 'fine_grain') {
        const drift = periodicNoise2D(u * 8, v * 8, 8, 8, seed + 83);
        /* Grains and pebbles are drawn on afterwards (addTextureDetail); no lattice-aligned sparkle here, it tiles into bricks. */
        blend = macro * 0.5 + drift * 0.34 + mid * 0.16;
      } else if (spec.pattern === 'grass_tufts') {
        /* Isotropic ground-space meadow; isometric (u, v) sampling projects it flat onto the terrain. */
        const patch = periodicDiagNoise(u, v, 6, seed + 89);
        /* Two lattices at different angles, so the meadow patches are round and do not tile into diamonds. */
        const tuft = periodicNoise2D(u * 16, v * 16, 16, 16, seed + 91) * 0.5 + periodicDiagNoise(u, v, 11, seed + 93) * 0.5;
        blend = macro * 0.46 + patch * 0.3 + tuft * 0.24;
        if (tuft > 0.62) accent = smoothstep(0.62, 0.86, tuft) * 0.26 * contrast;
      } else if (spec.pattern === 'furrows') {
        /* Ground-axis crop furrows automatically projected onto the 2:1 isometric tile plane. */
        const phase = u * 16 * Math.PI * 2 + (macro - 0.5) * 1.1;
        const stripe = 0.5 + 0.5 * Math.sin(phase);
        blend = stripe * 0.58 + macro * 0.28 + mid * 0.14 + fine * 0.08;
        if (stripe > 0.7) accent = smoothstep(0.7, 0.98, stripe) * 0.32;
      } else if (spec.pattern === 'crop_rows') {
        /* Tilled earth between rows of young plants: rows run along the first texture axis, 5 to a tile, with a dark
           furrow between them; the plants themselves are drawn on afterwards (addTextureDetail). */
        const row = 0.5 + 0.5 * Math.cos(v * 20 * Math.PI * 2 + (mid - 0.5) * 0.6);
        blend = 0.03 + macro * 0.1 + fine * 0.08;
        mul = 0.8 + 0.26 * row;
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
      } else if (spec.pattern === 'soil_clods') {
        /* Rounded clods with dark crevices between them, like turned river silt. */
        const clod = 1 - Math.abs(2 * periodicDiagNoise(u, v, 9, seed + 331) - 1);
        const crumb = periodicNoise2D(u * 22, v * 22, 22, 22, seed + 347);
        blend = 0.18 + clod * 0.42 + macro * 0.2 + crumb * 0.12 + fine * 0.1;
        if (clod > 0.8) accent = smoothstep(0.8, 0.96, clod) * 0.34 * contrast;
      } else if (spec.pattern === 'packed_dust') {
        /* Trodden earth: soft, low contrast, with a few worn streaks and pebbles. */
        const streak = periodicDiagNoise(u * 1.0, v * 3.0, 7, seed + 353);
        const speck = periodicNoise2D(u * 40, v * 40, 40, 40, seed + 367);
        blend = macro * 0.5 + mid * 0.22 + streak * 0.18 + fine * 0.12;
        if (speck > 0.8) accent = smoothstep(0.8, 0.95, speck) * 0.3;
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

      buf[off++] = clampByte(r * mul);
      buf[off++] = clampByte(g * mul);
      buf[off++] = clampByte(b * mul);
    }
  }

  addTextureDetail(buf, spec, [c0, c1, c2], seed);
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

/* ---------- painted soil edges ---------- */

/* How far each ground's weight is nudged by its own ragged noise; how wide the band is where two grounds share a pixel;
   how far from the edge the darker rim reaches (all in blend-weight units). */
const EDGE_NOISE = 0.2;
const EDGE_BAND = 0.02;
const RIM_BAND = 0.07;
const RIM_DARK = 0.13;
/* A pixel whose strongest ground leads the next one by more than this cannot change hands under the edge noise. */
const EDGE_FAST_GAP = EDGE_NOISE * 1.3 + EDGE_BAND;

/* Ragged noise of one ground at (u, v): a slow wobble, a mid ripple and a fine fray, each ground with its own offset. */
function edgeNoise(m: number, u: number, v: number, coarse: Float32Array, detail: Float32Array): number {
  return (
    sampleLutFast(coarse, u * 2.2 + m * 37.3, v * 2.2 + m * 21.9) * 0.75 +
    sampleLutFast(detail, u * 9 + m * 13.1, v * 9 - m * 7.7) * 0.3 +
    sampleLutFast(detail, u * 23 - m * 5.3, v * 23 + m * 3.1) * 0.12
  );
}

/* The two grounds a pixel shows and how much of the first: grounds meet along a drawn ragged line, not a wide smear. */
export type GroundMix = { a: number; b: number; shareA: number; rim: number };

function mixGround(w: Float32Array, count: number, u: number, v: number, coarse: Float32Array, detail: Float32Array, out: GroundMix): void {
  let a = 0;
  let wa = -1;
  let b = -1;
  let wb = -1;
  for (let m = 0; m < count; m++) {
    const x = w[m]!;
    if (x > wa) {
      b = a;
      wb = wa;
      a = m;
      wa = x;
    } else if (x > wb) {
      b = m;
      wb = x;
    }
  }
  if (wa - wb > EDGE_FAST_GAP) {
    out.a = a;
    out.b = a;
    out.shareA = 1;
    out.rim = 0;
    return;
  }
  let sa = -Infinity;
  let sb = -Infinity;
  a = -1;
  b = -1;
  for (let m = 0; m < count; m++) {
    const x = w[m]!;
    if (x < 0.02) continue;
    const s = x + EDGE_NOISE * edgeNoise(m, u, v, coarse, detail);
    if (s > sa) {
      sb = sa;
      b = a;
      sa = s;
      a = m;
    } else if (s > sb) {
      sb = s;
      b = m;
    }
  }
  if (b < 0) {
    out.a = a;
    out.b = a;
    out.shareA = 1;
    out.rim = 0;
    return;
  }
  const diff = sa - sb;
  out.a = a;
  out.b = b;
  out.shareA = smoothstep(-EDGE_BAND, EDGE_BAND, diff);
  out.rim = 1 - smoothstep(0, RIM_BAND, diff);
}

/* ---------- field plots ---------- */

type PlotLayout = Readonly<{
  material: number;
  sizeU: number;
  sizeV: number;
  ridge: Rgb;
  ditch: Rgb | null;
  layer: Float32Array;
}>;

const PLOT_SALT = 0x5bd1e995;
/* Plot edge, in tiles: the raised earth strip, the ditch in the middle of it, and the ditch's wet rim. */
const RIDGE_W = 0.11;
const DITCH_W = 0.035;
const DITCH_RIM_W = 0.07;

type PlotHit = { inside: boolean; cx: number; cy: number; edgeU: number; edgeV: number; alongV: boolean };

function layerAt(cf: CornerFieldGrid, arr: Float32Array, u: number, v: number): number {
  const lu = Math.max(0, Math.min(cf.cols - 1.001, u - cf.minCol));
  const lv = Math.max(0, Math.min(cf.rows - 1.001, v - cf.minRow));
  const x0 = lu | 0;
  const y0 = lv | 0;
  const fx = lu - x0;
  const fy = lv - y0;
  const i = y0 * cf.cols + x0;
  return (arr[i]! * (1 - fx) + arr[i + 1]! * fx) * (1 - fy) + (arr[i + cf.cols]! * (1 - fx) + arr[i + cf.cols + 1]! * fx) * fy;
}

/* Which plot (u, v) lies in, whether that plot is tilled (the field's weight at its middle), and the distance in tiles
   to the plot's nearest edge along each axis. Columns of plots are staggered so the grid does not run in long lines. */
function plotAt(cf: CornerFieldGrid, p: PlotLayout, u: number, v: number, out: PlotHit): void {
  const cx = Math.floor(u / p.sizeU);
  const off = hash2i(cx, 17, PLOT_SALT) * p.sizeV;
  const cy = Math.floor((v + off) / p.sizeV);
  out.cx = cx;
  out.cy = cy;
  out.inside = layerAt(cf, p.layer, (cx + 0.5) * p.sizeU, (cy + 0.5) * p.sizeV - off) > 0.45;
  if (!out.inside) return;
  const fx = u / p.sizeU - cx;
  const fy = (v + off) / p.sizeV - cy;
  out.edgeU = Math.min(fx, 1 - fx) * p.sizeU;
  out.edgeV = Math.min(fy, 1 - fy) * p.sizeV;
  out.alongV = hash2i(cx, cy, PLOT_SALT + 3) < 0.5;
}

/* ---------- sand ripples and paths ---------- */

/* Ripple crests run at a slant across the tile axes, about 26 px apart at 100% zoom, and wander with the noise. */
const RIPPLE_NU = 0.196;
const RIPPLE_NV = 0.98;
const RIPPLE_FREQ = 2.6;

/* Brightness factor of wind ripples at (u, v): a broad lit windward slope, a thin bright crest and a narrow shaded lee
   slope on the side away from a sun at the upper left. 1 means no change. */
function rippleShade(u: number, v: number, strength: number, coarse: Float32Array, detail: Float32Array): number {
  const warp = sampleLutFast(coarse, u * 1.1 + 5.3, v * 1.1 - 2.9) * 3.2 + sampleLutFast(detail, u * 3.3 + 1.7, v * 3.3 - 4.1) * 0.9;
  const ph = (u * RIPPLE_NU + v * RIPPLE_NV) * RIPPLE_FREQ + warp;
  const f = ph - Math.floor(ph);
  const lee = smoothstep(0.74, 0.8, f) * (1 - smoothstep(0.9, 0.99, f));
  const crest = smoothstep(0.6, 0.73, f) * (1 - smoothstep(0.73, 0.77, f));
  const patch = 0.6 + 0.4 * smoothstep(-0.25, 0.25, sampleLutFast(coarse, u * 0.55 + 71, v * 0.55 - 33));
  const k = strength * patch;
  return 1 + k * (0.08 * crest - 0.17 * lee);
}

type PathLook = Readonly<{
  color: Rgb;
  rut: Rgb;
  halfWidth: number;
  scale: number;
  materials: readonly number[];
}>;

/* How much of a worn path covers (u, v), and how much of a rut or footprint: 0 where there is none. The path follows a
   contour line of a slow noise, so it winds and forks like a track walked over years; it fades in and out along its
   length. Width comes from the noise slope, so the path keeps one width in tiles. */
function pathAt(p: PathLook, u: number, v: number, coarse: Float32Array, out: { core: number; rut: number }): void {
  out.core = 0;
  out.rut = 0;
  const gate = smoothstep(0.0, 0.12, sampleLutFast(coarse, u * 0.8 - 61, v * 0.8 + 17));
  if (gate <= 0) return;
  const s = p.scale;
  const e = 0.05;
  const n = sampleLutFast(coarse, u * s + 13.7, v * s - 41.2);
  if (Math.abs(n) > 0.06) return;
  const nu = sampleLutFast(coarse, (u + e) * s + 13.7, v * s - 41.2);
  const nv = sampleLutFast(coarse, u * s + 13.7, (v + e) * s - 41.2);
  const grad = Math.hypot(nu - n, nv - n) / e;
  if (grad < 1e-4) return;
  const dist = Math.abs(n) / grad;
  if (dist > p.halfWidth + 0.04) return;
  out.core = gate * (1 - smoothstep(p.halfWidth * 0.75, p.halfWidth + 0.04, dist));
  const rutLine = Math.exp(-Math.pow((dist - p.halfWidth * 0.42) / 0.02, 2));
  const print = hash2i(Math.floor(u * 15), Math.floor(v * 15), 0x2f6b1d) > 0.86 && dist < p.halfWidth * 0.3 ? 0.6 : 0;
  out.rut = gate * Math.max(rutLine, print);
}

/* The painted path strip at (u, v) into out[0..3] (colour and its opacity in [0, 1]): rows across the path follow the
   signed distance from the path's middle line, columns run along it. Opacity 0 off the path. */
function pathStripAt(p: PathLook, strip: ArtPixels, tpt: number, u: number, v: number, coarse: Float32Array, out: number[]): void {
  out[3] = 0;
  const gate = smoothstep(0.0, 0.12, sampleLutFast(coarse, u * 0.8 - 61, v * 0.8 + 17));
  if (gate <= 0) return;
  const s = p.scale;
  const e = 0.05;
  const n = sampleLutFast(coarse, u * s + 13.7, v * s - 41.2);
  if (Math.abs(n) > 0.06) return;
  const nu = (sampleLutFast(coarse, (u + e) * s + 13.7, v * s - 41.2) - n) / e;
  const nv = (sampleLutFast(coarse, u * s + 13.7, (v + e) * s - 41.2) - n) / e;
  const grad = Math.hypot(nu, nv);
  if (grad < 1e-4) return;
  const sd = n / grad;
  const y = strip.height / 2 + sd * tpt;
  if (y < 0 || y > strip.height - 1) return;
  const tu = -nv / grad;
  const tv = nu / grad;
  const wu = tu * tu;
  const wv = tv * tv;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (const [x, wt] of [[u * tpt, wu], [v * tpt + 311, wv]] as const) {
    if (wt < 0.02) continue;
    const xi = ((Math.floor(x) % strip.width) + strip.width) % strip.width;
    const o = ((y | 0) * strip.width + xi) * 4;
    const al = (strip.data[o + 3]! / 255) * wt;
    r += strip.data[o]! * al;
    g += strip.data[o + 1]! * al;
    b += strip.data[o + 2]! * al;
    a += al;
  }
  if (a <= 0) return;
  out[0] = r / a;
  out[1] = g / a;
  out[2] = b / a;
  out[3] = Math.min(1, a / (wu + wv)) * gate;
}

/* ---------- chunk baking ---------- */

/* Pure pixel baker for one chunk using smooth bilinear corner fields, painted soil edges, seamless material textures,
   field plots, wind ripples, worn paths, top-left elevation shading and curved liquid cutouts with a depth tint.
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
  const look = groundLook(map, pack);
  const { textures, matCount } = look;

  const liquid = pack.liquidLayer;
  const shallowRgb = parseHexRgb(liquid?.shallowTintColor ?? '#489FB5', [72, 159, 181]);
  const foamRgb = parseHexRgb(liquid?.shoreFoamColor ?? '#CFEAEF', [207, 234, 239]);
  const deepRgb = parseHexRgb(liquid?.deepColor ?? '#1C5F86', [28, 95, 134]);
  const deepTint: Rgb = [deepRgb[0] * 0.5, deepRgb[1] * 0.55, deepRgb[2] * 0.62];
  const depthShade = liquid?.depthShade ?? 0;
  const isGlowLiquid = Boolean(liquid?.glow);
  const sun = parseHexRgb(pack.lighting?.sunTint ?? '#FFFFFF', [255, 255, 255]);
  const sunR = sun[0] / 255;
  const sunG = sun[1] / 255;
  const sunB = sun[2] / 255;

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

  /* Reusable scratch values avoid per-pixel GC allocations. */
  const wBuf = new Float32Array(matCount);
  const mix: GroundMix = { a: 0, b: 0, shareA: 1, rim: 0 };
  const plotHit: PlotHit = { inside: false, cx: 0, cy: 0, edgeU: 0, edgeV: 0, alongV: false };
  const path = { core: 0, rut: 0 };
  const rgb = [0, 0, 0, 0];
  const painted = look.art !== null;
  const shore = look.art?.shoreEdge ?? null;
  const strip = look.art?.pathStrip ?? null;

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
      /* Translucent pixels are drawn only by the chunk that owns them, so chunk overlaps never darken twice. */
      const owned = u >= chunk.colStart && u < chunk.colEnd && v >= chunk.rowStart && v < chunk.rowEnd;

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

      let dWater = rawWater;
      let nCoarse = 0;
      let nDetail = 0;
      if (rawWater < 1.35) {
        nCoarse = sampleLutFast(coarse, u * 4.5, v * 4.5);
        nDetail = sampleLutFast(detail, u * 5.0, v * 5.0);
        dWater = rawWater + nCoarse * 0.5 + nDetail * 0.1;
      }

      /* Open liquid: transparent, so the animated liquid layer shines through, under a depth tint that darkens the middle
         and lightens the shallows, with a few broken ripple lines along the shore. */
      if (dWater < -0.26) {
        if (depthShade <= 0 || !owned) continue;
        waterTint(u, v, dWater, depthShade, deepTint, shallowRgb, foamRgb, coarse, detail, !painted, rgba, out);
        continue;
      }

      /* Compute directional top-left 5200K hillshading from continuous elevation gradient. */
      const e00 = elevArr[i00]!;
      const e10 = elevArr[i10]!;
      const e01 = elevArr[i01]!;
      const e11 = elevArr[i11]!;
      const dEdu = (e10 - e00) * (1 - fy) + (e11 - e01) * fy;
      const dEdv = (e01 - e00) * (1 - fx) + (e11 - e10) * fx;
      let shade = Math.max(0.76, Math.min(1.22, 1.0 - (dEdu * 0.55 + dEdv * 0.55)));
      /* Slow light and dark drifts over large areas, so a wide stretch of one ground is never flat and a painted texture
         does not show its repeat. */
      shade *= 1 + (painted ? 0.06 : 0.09) * sampleLutFast(coarse, u * 0.45 + 11, v * 0.45 + 7);

      for (let m = 0; m < matCount; m++) {
        const arr = layerArrs[m]!;
        wBuf[m] = arr[i00]! * w00 + arr[i10]! * w10 + arr[i01]! * w01 + arr[i11]! * w11;
      }

      let rippleStrength = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      plotHit.inside = false;
      if (look.plot) {
        plotAt(cf, look.plot, u, v, plotHit);
        if (!plotHit.inside) wBuf[look.plot.material] = 0;
      }
      if (plotHit.inside) {
        plotColor(look, plotHit, u, v, coarse, rgb);
        r = rgb[0]!;
        g = rgb[1]!;
        b = rgb[2]!;
      } else {
        if (painted) mixGroundArt(look, cf, wBuf, u, v, coarse, mix);
        else mixGround(wBuf, matCount, u, v, coarse, detail, mix);
        sampleTexture(textures[mix.a]!, u, v, rgb);
        r = rgb[0]!;
        g = rgb[1]!;
        b = rgb[2]!;
        rippleStrength = look.ripples[mix.a]!;
        if (mix.shareA < 1) {
          sampleTexture(textures[mix.b]!, u, v, rgb);
          const k = mix.shareA;
          r = r * k + rgb[0]! * (1 - k);
          g = g * k + rgb[1]! * (1 - k);
          b = b * k + rgb[2]! * (1 - k);
          rippleStrength = rippleStrength * k + look.ripples[mix.b]! * (1 - k);
        }
        if (mix.rim > 0) shade *= 1 - RIM_DARK * mix.rim;
      }

      /* Worn paths over open dry ground, then the wind ripples, which the paths have trodden flat. */
      if (look.path && dWater > 0.7) {
        let onPath = 0;
        for (const m of look.path.materials) onPath += wBuf[m]!;
        if (onPath > 0.5) {
          const k = smoothstep(0.5, 0.8, onPath);
          if (strip) {
            pathStripAt(look.path, strip, look.art!.texelsPerTile, u, v, coarse, rgb);
            const t = rgb[3]! * k;
            if (t > 0) {
              r += (rgb[0]! - r) * t;
              g += (rgb[1]! - g) * t;
              b += (rgb[2]! - b) * t;
            }
          } else pathAt(look.path, u, v, coarse, path);
          if (!strip && path.core > 0) {
            const c = look.path.color;
            const t = path.core * k * 0.55;
            r += (c[0] - r) * t;
            g += (c[1] - g) * t;
            b += (c[2] - b) * t;
            rippleStrength *= 1 - path.core;
          }
          if (!strip && path.rut > 0) {
            const c = look.path.rut;
            const t = path.rut * k * 0.5;
            r += (c[0] - r) * t;
            g += (c[1] - g) * t;
            b += (c[2] - b) * t;
          }
        }
      }
      if (rippleStrength > 0.01 && dWater > 0.45) {
        shade *= rippleShade(u, v, rippleStrength * smoothstep(0.45, 1.3, dWater), coarse, detail);
      }

      /* The sun's tint warms what it lights. */
      r *= shade * sunR;
      g *= shade * sunG;
      b *= shade * sunB;

      let alpha = 255;
      if (shore && dWater < 0.6) {
        /* The painted waterline: the land fades out where the shore mask says water, so the liquid layer shows. */
        const gwu = (waterArr[i10]! - waterArr[i00]!) * (1 - fy) + (waterArr[i11]! - waterArr[i01]!) * fy;
        const gwv = (waterArr[i01]! - waterArr[i00]!) * (1 - fx) + (waterArr[i11]! - waterArr[i10]!) * fx;
        const gl = Math.hypot(gwu, gwv) || 1;
        const liquidShare = maskShare(shore, look.art!.texelsPerTile, u, v, -dWater, -gwv / gl, gwu / gl);
        alpha = clampByte((1 - liquidShare) * 255);
      } else if (!painted && dWater < 0.75) {
        if (isGlowLiquid) {
          /* Warm emissive rim glow hugging the curved coastline smoothly. */
          const wetFactor = 1 - smoothstep(0.05, 0.62, dWater);
          r += (shallowRgb[0] - r) * wetFactor * 0.52;
          g += (shallowRgb[1] - g) * wetFactor * 0.52;
          b += (shallowRgb[2] - b) * wetFactor * 0.52;
        } else {
          /* A dark band of wet sand along the water, with a ragged inland edge, and a soft damp fade beyond it. */
          const wet = 1 - smoothstep(0.1, 0.3 + 0.12 * (nDetail + 0.5), dWater);
          const damp = 1 - smoothstep(0.25, 0.75, dWater);
          const k = 1 - 0.3 * wet - 0.08 * damp;
          r *= k;
          g *= k * 0.99;
          b *= k * 0.95;
        }

        if (dWater < 0.08) {
          /* Curved feathered shoreline edge blending seamlessly into the animated liquid layer. */
          const shoreMask = smoothstep(-0.26, 0.08, dWater);
          const shallowMix = 1 - smoothstep(-0.18, 0.08, dWater);
          r += (shallowRgb[0] - r) * shallowMix * 0.62;
          g += (shallowRgb[1] - g) * shallowMix * 0.62;
          b += (shallowRgb[2] - b) * shallowMix * 0.62;

          /* Foam along the waterline, broken into lumps rather than one even line. */
          const lumps = Math.max(0, Math.min(1, 0.45 + 1.6 * sampleLutFast(detail, u * 7.3 + 3.1, v * 7.3 - 2.2)));
          const foamBand = Math.exp(-Math.pow((dWater + 0.04) / 0.075, 2)) * (isGlowLiquid ? 1 : lumps);
          const foamStrength = isGlowLiquid ? 0.68 : 0.5;
          r += (foamRgb[0] - r) * foamBand * foamStrength;
          g += (foamRgb[1] - g) * foamBand * foamStrength;
          b += (foamRgb[2] - b) * foamBand * foamStrength;

          if (depthShade > 0 && shoreMask < 1) {
            /* Under the feathered edge lies the light shallow tint, so the shore does not show a dark seam. */
            const under = 0.24 * (1 - shoreMask);
            const a = shoreMask + under;
            r = (r * shoreMask + shallowRgb[0] * 1.08 * under) / a;
            g = (g * shoreMask + shallowRgb[1] * 1.08 * under) / a;
            b = (b * shoreMask + shallowRgb[2] * 1.04 * under) / a;
            alpha = clampByte(a * 255);
          } else {
            alpha = clampByte(shoreMask * 255);
          }
        }
      }

      if (alpha < 255 && !owned) continue;

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

/* One open-liquid pixel: a dark tint toward the middle with slow patches, a light tint in the shallows, and broken
   light ripple lines a little way off the shore. */
function waterTint(
  u: number,
  v: number,
  d: number,
  depthShade: number,
  deep: Rgb,
  shallow: Rgb,
  foam: Rgb,
  coarse: Float32Array,
  detail: Float32Array,
  drawLines: boolean,
  rgba: Uint8ClampedArray,
  out: number,
): void {
  const depth = smoothstep(-0.3, -2.0, d);
  const patches = 0.8 + 0.5 * (sampleLutFast(coarse, u * 0.7 + 21, v * 0.7 - 9) + 0.5) * 0.8;
  const aDeep = Math.min(0.85, depthShade * depth * patches);
  const aShallow = drawLines ? 0.24 * (1 - smoothstep(-0.3, -0.95, d)) : 0;
  const broken = drawLines ? Math.max(0, Math.min(1, 0.2 + 1.8 * sampleLutFast(detail, u * 6.1 - 7.3, v * 6.1 + 2.9))) : 0;
  const lines =
    (Math.exp(-Math.pow((d + 0.42) / 0.03, 2)) * 0.5 + Math.exp(-Math.pow((d + 0.7) / 0.03, 2)) * 0.3) * broken;
  const a = Math.min(1, aDeep + aShallow + lines);
  if (a <= 0.004) return;
  rgba[out] = clampByte((deep[0] * aDeep + shallow[0] * 1.1 * aShallow + foam[0] * lines) / a);
  rgba[out + 1] = clampByte((deep[1] * aDeep + shallow[1] * 1.1 * aShallow + foam[1] * lines) / a);
  rgba[out + 2] = clampByte((deep[2] * aDeep + shallow[2] * 1.05 * aShallow + foam[2] * lines) / a);
  rgba[out + 3] = clampByte(a * 255);
}

/* A seamless square ground texture: procedural (RGB) or painted (RGBA), with its texels per tile. */
type GroundTex = Readonly<{ data: Uint8ClampedArray; size: number; mask: number; tpt: number; stride: number }>;

function proceduralTex(data: Uint8ClampedArray): GroundTex {
  return { data, size: TEX_SIZE, mask: TEX_MASK, tpt: TEXELS_PER_TILE, stride: 3 };
}

function artTex(p: ArtPixels, tpt: number): GroundTex {
  return { data: p.data, size: p.width, mask: p.width - 1, tpt, stride: 4 };
}

/* Bilinear sample of a seamless ground texture at tile coordinates (u, v) into out[0..2]. */
function sampleTexture(tex: GroundTex, u: number, v: number, out: number[]): void {
  const tfx = u * tex.tpt;
  const tfy = v * tex.tpt;
  const tx0 = Math.floor(tfx);
  const ty0 = Math.floor(tfy);
  const ax = tfx - tx0;
  const ay = tfy - ty0;
  const m = tex.mask;
  const st = tex.stride;
  const c0 = tx0 & m;
  const c1 = (tx0 + 1) & m;
  const r0 = (ty0 & m) * tex.size;
  const r1 = ((ty0 + 1) & m) * tex.size;
  const d = tex.data;
  const i00 = (r0 + c0) * st;
  const i10 = (r0 + c1) * st;
  const i01 = (r1 + c0) * st;
  const i11 = (r1 + c1) * st;
  const w00 = (1 - ax) * (1 - ay);
  const w10 = ax * (1 - ay);
  const w01 = (1 - ax) * ay;
  const w11 = ax * ay;
  out[0] = d[i00]! * w00 + d[i10]! * w10 + d[i01]! * w01 + d[i11]! * w11;
  out[1] = d[i00 + 1]! * w00 + d[i10 + 1]! * w10 + d[i01 + 1]! * w01 + d[i11 + 1]! * w11;
  out[2] = d[i00 + 2]! * w00 + d[i10 + 2]! * w10 + d[i01 + 2]! * w01 + d[i11 + 2]! * w11;
}

/* Painted edge mask value in [0, 1] (1 = the mask's first ground) at a column along the edge (wrapping) and a row
   across it (clamped), bilinear. */
function sampleMask(mask: ArtPixels, x: number, y: number): number {
  const w = mask.width;
  const h = mask.height;
  const yc = Math.max(0, Math.min(h - 1.001, y));
  const x0 = Math.floor(x);
  const y0 = yc | 0;
  const ax = x - x0;
  const ay = yc - y0;
  const c0 = ((x0 % w) + w) % w;
  const c1 = (c0 + 1) % w;
  const d = mask.data;
  const r0 = y0 * w;
  const r1 = (y0 + 1) * w;
  const a = d[(r0 + c0) * 4]! * (1 - ax) + d[(r0 + c1) * 4]! * ax;
  const b = d[(r1 + c0) * 4]! * (1 - ax) + d[(r1 + c1) * 4]! * ax;
  return (a + (b - a) * ay) / 255;
}

/* A painted edge across a boundary, at signed distance `d` tiles into the mask's first ground (negative: into the
   second), with the boundary's direction (tu, tv) along the tile axes: columns follow whichever tile axis the edge
   runs along more, blended where it runs at a slant, so the mask never stretches. Returns the first ground's share. */
function maskShare(mask: ArtPixels, tpt: number, u: number, v: number, d: number, tu: number, tv: number): number {
  const y = mask.height / 2 - d * tpt;
  const wu = tu * tu;
  const wv = tv * tv;
  const sum = wu + wv || 1;
  let s = 0;
  if (wu > 0.02) s += sampleMask(mask, u * tpt, y) * wu;
  if (wv > 0.02) s += sampleMask(mask, v * tpt + 517, y) * wv;
  return s / sum;
}

/* One tilled-plot pixel: crop rows one way or the other, a growth stage per plot, the raised earth strip at the plot's
   edge with a thin shadow on its lower side, and a narrow irrigation ditch along some edges. With painted art the
   strip is the painted edge between the surrounding grass and the field, and the ditch is painted water. */
function plotColor(look: GroundLook, hit: PlotHit, u: number, v: number, coarse: Float32Array, out: number[]): void {
  const p = look.plot!;
  sampleTexture(hit.alongV ? look.plotRowsV! : look.textures[p.material]!, u, v, out);
  const art = look.art !== null;
  if (!art) {
    const stage = hash2i(hit.cx, hit.cy, PLOT_SALT + 7);
    /* Young plots show more earth, ripe ones turn yellow; the rest are in full leaf. */
    const kr = stage < 0.25 ? 0.97 : stage > 0.8 ? 1.1 : 1;
    const kg = stage < 0.25 ? 0.9 : stage > 0.8 ? 1.03 : 1.02;
    const kb = stage < 0.25 ? 0.92 : stage > 0.8 ? 0.86 : 0.98;
    out[0] = out[0]! * kr;
    out[1] = out[1]! * kg;
    out[2] = out[2]! * kb;
  }
  const alongU = hit.edgeV < hit.edgeU;
  const edge = Math.min(hit.edgeU, hit.edgeV) + (art ? 0 : sampleLutFast(coarse, u * 7.7, v * 7.7) * 0.03);
  const ditchHere = hit.edgeV < hit.edgeU && hash2i(hit.cx, hit.cy, PLOT_SALT + 11) < 0.2;
  if (art) {
    if (look.ditch && ditchHere && edge < DITCH_RIM_W) {
      const t = 1 - smoothstep(DITCH_W, DITCH_RIM_W, edge);
      const c = [0, 0, 0];
      sampleTexture(look.ditch, u, v, c);
      out[0] = out[0]! + (c[0]! - out[0]!) * t;
      out[1] = out[1]! + (c[1]! - out[1]!) * t;
      out[2] = out[2]! + (c[2]! - out[2]!) * t;
      return;
    }
    if (look.plotEdge && edge < 0.5) {
      const tpt = look.art!.texelsPerTile;
      /* Distance into the field from the middle of the painted strip, which sits a little inside the plot. */
      const share = maskShare(look.plotEdge.mask, tpt, u, v, -(edge - 0.16), alongU ? 1 : 0, alongU ? 0 : 1);
      if (share > 0.004) {
        const c = [0, 0, 0];
        sampleTexture(look.textures[look.grassForPlots]!, u, v, c);
        out[0] = out[0]! + (c[0]! - out[0]!) * share;
        out[1] = out[1]! + (c[1]! - out[1]!) * share;
        out[2] = out[2]! + (c[2]! - out[2]!) * share;
      }
    }
    return;
  }
  if (edge < RIDGE_W) {
    const t = 1 - smoothstep(RIDGE_W - 0.03, RIDGE_W, edge);
    out[0] = out[0]! + (p.ridge[0] - out[0]!) * t;
    out[1] = out[1]! + (p.ridge[1] - out[1]!) * t;
    out[2] = out[2]! + (p.ridge[2] - out[2]!) * t;
    /* The ridge stands a little higher than the plot: its inner foot is in shade. */
    const foot = Math.exp(-Math.pow((edge - RIDGE_W) / 0.02, 2)) * 0.18;
    out[0] = out[0]! * (1 - foot);
    out[1] = out[1]! * (1 - foot);
    out[2] = out[2]! * (1 - foot);
    if (p.ditch && ditchHere) {
      const rim = 1 - smoothstep(DITCH_W, DITCH_RIM_W, edge);
      const water = 1 - smoothstep(DITCH_W * 0.6, DITCH_W, edge);
      out[0] = out[0]! * (1 - 0.3 * rim) + (p.ditch[0] - out[0]! * (1 - 0.3 * rim)) * water;
      out[1] = out[1]! * (1 - 0.3 * rim) + (p.ditch[1] - out[1]! * (1 - 0.3 * rim)) * water;
      out[2] = out[2]! * (1 - 0.25 * rim) + (p.ditch[2] - out[2]! * (1 - 0.25 * rim)) * water;
    }
  }
}

/* An edge mask for a pair of grounds, and whether the pair's first ground is the mask's second. */
type EdgeLook = Readonly<{ mask: ArtPixels; flip: boolean }>;

/* Everything the baker needs from the pack's grounds, worked out once per map, pack and art. */
type GroundLook = Readonly<{
  matCount: number;
  textures: readonly GroundTex[];
  ripples: Float32Array;
  plot: PlotLayout | null;
  plotRowsV: GroundTex | null;
  path: PathLook | null;
  /* Painted look; null draws everything procedurally. */
  art: LoadedTerrainArt | null;
  /* edges[a * matCount + b]: the painted mask between grounds a and b. */
  edges: readonly (EdgeLook | null)[];
  plotEdge: EdgeLook | null;
  grassForPlots: number;
  ditch: GroundTex | null;
}>;

const lookCache = new WeakMap<GeneratedWorldMap, { pack: WorldPackManifest; art: LoadedTerrainArt | null; look: GroundLook }>();

function groundLook(map: GeneratedWorldMap, pack: WorldPackManifest): GroundLook {
  const art = terrainArtFor(pack);
  const hit = lookCache.get(map);
  if (hit && hit.pack === pack && hit.art === art) return hit.look;
  const cf = map.cornerFields;
  const matById = new Map((pack.materials ?? []).map(m => [m.id, m]));
  const specs: GroundMaterialSpec[] = cf.materialIds.map(
    id =>
      matById.get(id) ??
      pack.materials?.[0] ?? {
        id,
        baseColor: '#B8A888',
        secondaryColor: '#9E8E70',
        accentColor: '#D0C0A0',
        pattern: 'fine_grain' as const,
      },
  );
  const tpt = art?.texelsPerTile ?? TEXELS_PER_TILE;
  const textures = specs.map(s => {
    const painted = art?.ground.get(s.id);
    return painted ? artTex(painted, tpt) : proceduralTex(getMaterialTextureRgb(s));
  });
  /* Painted sand already carries its ripples; procedural ones go only on procedural ground. */
  const ripples = new Float32Array(specs.map((s, i) => (textures[i]!.stride === 3 ? (s.ripples ?? 0) : 0)));
  const plotIdx = specs.findIndex(s => s.plots !== undefined);
  let plot: PlotLayout | null = null;
  let plotRowsV: GroundTex | null = null;
  if (plotIdx >= 0) {
    const ps = specs[plotIdx]!.plots!;
    plot = {
      material: plotIdx,
      sizeU: ps.sizeU,
      sizeV: ps.sizeV,
      ridge: parseHexRgb(ps.ridgeColor, [150, 160, 90]),
      ditch: ps.ditchColor ? parseHexRgb(ps.ditchColor, [70, 140, 160]) : null,
      layer: cf.layerWeights[plotIdx]!,
    };
    plotRowsV = transposedTexture(textures[plotIdx]!);
  }
  const ps = pack.paths;
  const path: PathLook | null = ps
    ? {
        color: parseHexRgb(ps.color, [220, 200, 160]),
        rut: parseHexRgb(ps.rutColor, [150, 120, 80]),
        halfWidth: ps.widthTiles / 2,
        /* The coarse noise crosses zero about every 21 of its texels: scale it so paths lie about spacingTiles apart. */
        scale: 21 / ps.spacingTiles,
        materials: ps.materials.map(id => cf.materialIds.indexOf(id)).filter(i => i >= 0),
      }
    : null;

  const n = specs.length;
  const edges: (EdgeLook | null)[] = new Array<EdgeLook | null>(n * n).fill(null);
  if (art) {
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        if (a === b) continue;
        const ida = specs[a]!.id;
        const idb = specs[b]!.id;
        const direct = art.edges.get(`${ida}|${idb}`);
        const turned = art.edges.get(`${idb}|${ida}`);
        edges[a * n + b] = direct ? { mask: direct, flip: false } : turned ? { mask: turned, flip: true } : art.defaultEdge ? { mask: art.defaultEdge, flip: false } : null;
      }
    }
  }
  /* A plot's edge is painted with the mask between the ground around fields and the field itself. */
  let grassForPlots = -1;
  let plotEdge: EdgeLook | null = null;
  if (art && plot) {
    for (let a = 0; a < n && !plotEdge; a++) {
      const e = art.edges.get(`${specs[a]!.id}|${specs[plot.material]!.id}`);
      if (e) {
        plotEdge = { mask: e, flip: false };
        grassForPlots = a;
      }
    }
  }
  const surface = art?.liquid?.surface;
  const look: GroundLook = {
    matCount: n,
    textures,
    ripples,
    plot,
    plotRowsV,
    path,
    art,
    edges,
    plotEdge,
    grassForPlots,
    ditch: surface ? artTex(surface, tpt) : null,
  };
  lookCache.set(map, { pack, art, look });
  return look;
}

const transposedCache = new WeakMap<Uint8ClampedArray, GroundTex>();

/* The same seamless texture turned a quarter, for plots whose rows run along the other tile axis. */
function transposedTexture(tex: GroundTex): GroundTex {
  const cached = transposedCache.get(tex.data);
  if (cached) return cached;
  const src = tex.data;
  const st = tex.stride;
  const size = tex.size;
  const dst = new Uint8ClampedArray(src.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = (y * size + x) * st;
      const b = (x * size + y) * st;
      for (let c = 0; c < st; c++) dst[b + c] = src[a + c]!;
    }
  }
  const out: GroundTex = { ...tex, data: dst };
  transposedCache.set(tex.data, out);
  return out;
}

/* Painted soil edge: the two strongest grounds after a slow wobble, and the first one's share from the painted mask
   at the pixel's distance from their boundary. The distance comes from the slope of the two weights. */
function mixGroundArt(
  look: GroundLook,
  cf: CornerFieldGrid,
  w: Float32Array,
  u: number,
  v: number,
  coarse: Float32Array,
  out: GroundMix,
): void {
  const count = look.matCount;
  let a = -1;
  let b = -1;
  let sa = -Infinity;
  let sb = -Infinity;
  for (let m = 0; m < count; m++) {
    const x = w[m]!;
    if (x < 0.01) continue;
    const s = x + 0.12 * sampleLutFast(coarse, u * 2.2 + m * 37.3, v * 2.2 + m * 21.9);
    if (s > sa) {
      sb = sa;
      b = a;
      sa = s;
      a = m;
    } else if (s > sb) {
      sb = s;
      b = m;
    }
  }
  out.a = Math.max(0, a);
  out.b = out.a;
  out.shareA = 1;
  out.rim = 0;
  if (b < 0) return;
  const edge = look.edges[a * count + b];
  if (!edge) {
    out.b = b;
    out.shareA = smoothstep(-EDGE_BAND, EDGE_BAND, sa - sb);
    return;
  }
  const e = 0.05;
  const la = cf.layerWeights[a]!;
  const lb = cf.layerWeights[b]!;
  const g0 = layerAt(cf, la, u, v) - layerAt(cf, lb, u, v);
  const gu = (layerAt(cf, la, u + e, v) - layerAt(cf, lb, u + e, v) - g0) / e;
  const gv = (layerAt(cf, la, u, v + e) - layerAt(cf, lb, u, v + e) - g0) / e;
  const grad = Math.max(0.08, Math.hypot(gu, gv));
  const d = (sa - sb) / grad;
  if (d > 0.55) return;
  const share = maskShare(edge.mask, look.art!.texelsPerTile, u, v, edge.flip ? -d : d, -gv / grad, gu / grad);
  out.b = b;
  out.shareA = edge.flip ? 1 - share : share;
}

/* The two grounds and their shares that the baker paints at (u, v): what a soil edge looks like, as numbers. */
export function groundMixAt(map: GeneratedWorldMap, pack: WorldPackManifest, u: number, v: number): GroundMix {
  const look = groundLook(map, pack);
  const s = sampleCornerFieldBilinear(map.cornerFields, u, v);
  const w = new Float32Array(s.weights);
  const out: GroundMix = { a: 0, b: 0, shareA: 1, rim: 0 };
  if (look.plot) {
    const hit: PlotHit = { inside: false, cx: 0, cy: 0, edgeU: 0, edgeV: 0, alongV: false };
    plotAt(map.cornerFields, look.plot, u, v, hit);
    if (hit.inside) {
      out.a = look.plot.material;
      out.b = look.plot.material;
      return out;
    }
    w[look.plot.material] = 0;
  }
  const { coarse, detail } = getNoiseLuts();
  if (look.art) mixGroundArt(look, map.cornerFields, w, u, v, coarse, out);
  else mixGround(w, look.matCount, u, v, coarse, detail, out);
  return out;
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
