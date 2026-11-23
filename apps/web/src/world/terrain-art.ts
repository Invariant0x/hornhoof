/* Painted ground, liquid, path and plant art of a pack (TerrainArtSpec and PlantKindSpec.art), loaded once per pack
   and kept as decoded pixels for the chunk baker and the plant layer. A file that fails to load leaves its slot on
   the procedural look; a pack without art loads nothing. Needs a browser (fetch and createImageBitmap). */

import type { PlantPassport, WorldPackManifest } from './manifest';
import { parsePlantPassport } from './plants';

/* Straight (not premultiplied) RGBA pixels. */
export type ArtPixels = Readonly<{ data: Uint8ClampedArray; width: number; height: number }>;

export type PlantArtImage = Readonly<{
  pixels: ArtPixels;
  canvas: HTMLCanvasElement;
  /* One wind weight per pixel in [0, 255], or null when the picture has no weight map. */
  weights: Uint8ClampedArray | null;
  passport: PlantPassport;
}>;

export type LoadedTerrainArt = Readonly<{
  ground: ReadonlyMap<string, ArtPixels>;
  texelsPerTile: number;
  /* 'first|second' material ids. */
  edges: ReadonlyMap<string, ArtPixels>;
  defaultEdge: ArtPixels | null;
  shoreEdge: ArtPixels | null;
  liquid: Readonly<{ bed: ArtPixels; ripples: ArtPixels; surface: ArtPixels | null; baseColor: string }> | null;
  pathStrip: ArtPixels | null;
  /* Plant kind id -> its loaded variants, in the order the pack lists them. */
  plants: ReadonlyMap<string, readonly PlantArtImage[]>;
}>;

const loaded = new WeakMap<WorldPackManifest, LoadedTerrainArt>();
const loading = new WeakMap<WorldPackManifest, Promise<LoadedTerrainArt | null>>();

/* The art of a pack once it has loaded, else null. */
export function terrainArtFor(pack: WorldPackManifest): LoadedTerrainArt | null {
  return loaded.get(pack) ?? null;
}

/* Hands art to the engine without loading it: for tests and tools that decode pictures their own way. */
export function registerTerrainArt(pack: WorldPackManifest, art: LoadedTerrainArt): void {
  loaded.set(pack, art);
}

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

async function loadCanvas(url: string): Promise<HTMLCanvasElement | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const canvas = canvasOf(bmp.width, bmp.height);
    canvas.getContext('2d', { willReadFrequently: true })?.drawImage(bmp, 0, 0);
    bmp.close();
    return canvas;
  } catch {
    return null;
  }
}

function pixelsOf(canvas: HTMLCanvasElement): ArtPixels | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: img.data, width: canvas.width, height: canvas.height };
}

async function loadPixels(url: string): Promise<ArtPixels | null> {
  const canvas = await loadCanvas(url);
  return canvas ? pixelsOf(canvas) : null;
}

async function loadJson(url: string): Promise<unknown> {
  try {
    const res = await fetch(url);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/* A seamless square texture whose side is a power of two, or null. */
function squareTexture(p: ArtPixels | null): ArtPixels | null {
  if (!p || p.width !== p.height || (p.width & (p.width - 1)) !== 0) return null;
  return p;
}

async function loadPlant(base: string, image: string, windMask: string | undefined, passport: string | undefined): Promise<PlantArtImage | null> {
  const [canvas, mask, json] = await Promise.all([
    loadCanvas(base + image),
    windMask ? loadPixels(base + windMask) : Promise.resolve(null),
    passport ? loadJson(base + passport) : Promise.resolve(null),
  ]);
  if (!canvas) return null;
  const pixels = pixelsOf(canvas);
  if (!pixels) return null;
  const pass = parsePlantPassport(json) ?? {
    rootPoint: [canvas.width / 2, canvas.height - 1] as const,
    crownCenter: [canvas.width / 2, canvas.height / 2] as const,
    crownHub: [canvas.width / 2, canvas.height / 2] as const,
    heightPx: canvas.height,
    crownWidthPx: canvas.width,
  };
  let weights: Uint8ClampedArray | null = null;
  if (mask && mask.width === canvas.width && mask.height === canvas.height) {
    weights = new Uint8ClampedArray(mask.width * mask.height);
    for (let i = 0; i < weights.length; i++) weights[i] = mask.data[i * 4]!;
  }
  return { pixels, canvas, weights, passport: pass };
}

/* Loads every painted file the pack names, at most once per pack; resolves to null when the pack names none or none
   of them loads. */
export function loadTerrainArt(pack: WorldPackManifest): Promise<LoadedTerrainArt | null> {
  const have = loaded.get(pack);
  if (have) return Promise.resolve(have);
  const busy = loading.get(pack);
  if (busy) return busy;
  const job = loadAll(pack);
  loading.set(pack, job);
  return job;
}

async function loadAll(pack: WorldPackManifest): Promise<LoadedTerrainArt | null> {
  const base = pack.art?.baseUrl;
  const spec = pack.terrainArt;
  const plantKinds = (pack.plants ?? []).filter(k => (k.art?.length ?? 0) > 0);
  if (!base || (!spec && plantKinds.length === 0) || typeof fetch !== 'function' || typeof createImageBitmap !== 'function') return null;

  const groundJobs = Object.entries(spec?.ground ?? {}).map(async ([id, file]) => [id, squareTexture(await loadPixels(base + file))] as const);
  const edgeJobs = Object.entries(spec?.edges ?? {}).map(async ([pair, file]) => [pair, await loadPixels(base + file)] as const);
  const plantJobs = plantKinds.map(async k => [k.id, (await Promise.all(k.art!.map(a => loadPlant(base, a.image, a.windMask, a.passport)))).filter((x): x is PlantArtImage => x !== null)] as const);
  const liq = spec?.liquid;
  const [ground, edges, plants, defaultEdge, shoreEdge, bed, ripples, surface, pathStrip] = await Promise.all([
    Promise.all(groundJobs),
    Promise.all(edgeJobs),
    Promise.all(plantJobs),
    spec?.defaultEdge ? loadPixels(base + spec.defaultEdge) : Promise.resolve(null),
    spec?.shoreEdge ? loadPixels(base + spec.shoreEdge) : Promise.resolve(null),
    liq ? loadPixels(base + liq.bed) : Promise.resolve(null),
    liq ? loadPixels(base + liq.ripples) : Promise.resolve(null),
    liq?.surface ? loadPixels(base + liq.surface) : Promise.resolve(null),
    spec?.pathStrip ? loadPixels(base + spec.pathStrip) : Promise.resolve(null),
  ]);

  const groundMap = new Map<string, ArtPixels>();
  for (const [id, px] of ground) if (px) groundMap.set(id, px);
  const edgeMap = new Map<string, ArtPixels>();
  for (const [pair, px] of edges) if (px) edgeMap.set(pair, px);
  const plantMap = new Map<string, readonly PlantArtImage[]>();
  for (const [id, list] of plants) if (list.length > 0) plantMap.set(id, list);
  if (groundMap.size === 0 && plantMap.size === 0) return null;

  const art: LoadedTerrainArt = {
    ground: groundMap,
    texelsPerTile: spec?.texelsPerTile ?? 256,
    edges: edgeMap,
    defaultEdge,
    shoreEdge,
    liquid: liq && bed && ripples ? { bed, ripples, surface: squareTexture(surface), baseColor: liq.baseColor } : null,
    pathStrip,
    plants: plantMap,
  };
  loaded.set(pack, art);
  return art;
}
