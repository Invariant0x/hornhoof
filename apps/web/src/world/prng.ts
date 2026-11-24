/* Deterministic seed hashing and infinite-coordinate 2D noise primitives.
   Pure functions of (seed, x, y) with signed integer safety so map edge expansion never shifts existing tiles. */

/* FNV-1a + Murmur3 avalanche finalizer mapping any string or number seed to an unsigned 32-bit integer. */
export function hashSeed(seed: string | number): number {
  const text = String(seed);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/* Deterministic Mulberry32 PRNG returning floats in [0, 1). */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Deterministic 2D integer lattice hash returning a float in [0, 1) for any signed integer (ix, iy). */
export function hash2i(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/* Smooth quintic-interpolated 2D value noise in [0, 1]. */
export function valueNoise2D(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);

  const n00 = hash2i(x0, y0, seed);
  const n10 = hash2i(x0 + 1, y0, seed);
  const n01 = hash2i(x0, y0 + 1, seed);
  const n11 = hash2i(x0 + 1, y0 + 1, seed);

  const nx0 = lerp(n00, n10, fx);
  const nx1 = lerp(n01, n11, fx);
  return lerp(nx0, nx1, fy);
}

/* Fractal Brownian motion in [0, 1] over infinite 2D coordinates. */
export function fbm2D(
  x: number,
  y: number,
  seed: number,
  octaves = 4,
  lacunarity = 2.0,
  gain = 0.5,
): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2D(x * freq, y * freq, (seed + Math.imul(i + 1, 1013904223)) >>> 0);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/* Ridged multifractal noise in [0, 1], emphasizing sharp mountain crests and escarpments. */
export function ridgedFbm2D(
  x: number,
  y: number,
  seed: number,
  octaves = 4,
  lacunarity = 2.05,
  gain = 0.5,
): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = valueNoise2D(x * freq, y * freq, (seed + Math.imul(i + 1, 1664525)) >>> 0);
    const ridge = 1 - Math.abs(2 * n - 1);
    sum += amp * ridge * ridge;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}
