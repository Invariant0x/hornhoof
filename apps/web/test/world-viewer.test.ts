import { describe, expect, it } from 'vitest';
import { mapWorldBounds, screenToWorld, tileTopVertexToWorld } from '../src/world/coords';
import { validateWorldPack } from '../src/world/manifest';
import { generatePlants } from '../src/world/plants';
import { generateWorldTerrain } from '../src/world/terrain-engine';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';
import {
  DEFAULT_VIEWER_SEED,
  overviewLayout,
  overviewToWorld,
  packArtFiles,
  pinchCamera,
  readViewerQuery,
  viewerPack,
  wheelZoomFactor,
  worldToOverview,
} from '../src/world-packs/viewer-core';

/* The static map viewer: a page of only the world, opened from a plain static host under any sub-path. */

const TILE_W = EGYPT_WORLD_PACK.projection.defaultTileW;
const TILE_H = EGYPT_WORLD_PACK.projection.defaultTileH;
const N = EGYPT_WORLD_PACK.mapSize;
const BOUNDS = mapWorldBounds(N, TILE_W, TILE_H);
const VIEW = { width: 1280, height: 800 };
const LIMITS = { minZoom: 0.5, maxZoom: 2 };

describe('the viewer pack', () => {
  it('points the art at world-art/<pack>/ beside the page, under any sub-path', () => {
    const deep = viewerPack(EGYPT_WORLD_PACK, 'relative', 'https://example.test/a/b/index.html?seed=x#top');
    expect(deep.art?.baseUrl).toBe('https://example.test/a/b/world-art/egypt/');
    const folder = viewerPack(EGYPT_WORLD_PACK, 'relative', 'http://127.0.0.1:8080/shared/egypt-map/');
    expect(folder.art?.baseUrl).toBe('http://127.0.0.1:8080/shared/egypt-map/world-art/egypt/');
    expect(folder.terrainArt).toEqual(EGYPT_WORLD_PACK.terrainArt);
    expect(folder.plants).toEqual(EGYPT_WORLD_PACK.plants);
    expect(validateWorldPack(folder)).toEqual({ ok: true });
  });

  it('keeps the pack as it is on the dev server, where the art folder sits at its own address', () => {
    expect(viewerPack(EGYPT_WORLD_PACK, 'own', 'http://localhost:5173/world-viewer.html')).toBe(EGYPT_WORLD_PACK);
  });

  it('asks for no picture when the build ships no art, and still grows the same plants', () => {
    const bare = viewerPack(EGYPT_WORLD_PACK, 'none', 'https://example.test/');
    expect(bare.art).toBeUndefined();
    expect(bare.terrainArt).toBeUndefined();
    expect(bare.plants?.map(k => k.id)).toEqual(EGYPT_WORLD_PACK.plants?.map(k => k.id));
    expect(bare.plants?.every(k => k.art === undefined)).toBe(true);
    expect(packArtFiles(bare)).toEqual([]);
    expect(validateWorldPack(bare)).toEqual({ ok: true });
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: 'hornhoof', mapSize: N });
    expect(generatePlants(bare, map).plants).toEqual(generatePlants(EGYPT_WORLD_PACK, map).plants);
  });
});

describe('the art files a build copies', () => {
  it('lists every picture and passport the pack names, once each, relative to its art folder', () => {
    const files = packArtFiles(EGYPT_WORLD_PACK);
    expect(files).toEqual([...new Set(files)].sort());
    for (const path of [
      'ground/plain.png',
      'ground/edges/river_bank.png',
      'ground/river_bed.png',
      'ground/river_ripples.png',
      'ground/river.png',
      'roads/trail.png',
      'roads/dirt.png',
      'roads/brick.png',
      'roads/stone.png',
      'veg/date_palm_01.png',
      'veg/date_palm_01_w.png',
      'veg/date_palm_01.json',
      'decals/pebbles_01.png',
    ]) {
      expect(files).toContain(path);
    }
    expect(files.filter(f => f.startsWith('/') || f.includes('..') || f.includes('://'))).toEqual([]);
  });
});

describe('the overview from above', () => {
  it('fits the whole map as a 2:1 diamond in the middle of its box', () => {
    const wide = overviewLayout(N, { width: 1000, height: 400 });
    expect(wide).toMatchObject({ width: 800, height: 400, left: 100, top: 0 });
    const tall = overviewLayout(N, { width: 600, height: 900 });
    expect(tall).toMatchObject({ width: 600, height: 300, left: 0, top: 300 });
  });

  it('puts the corners of the map on the corners of the diamond', () => {
    const o = overviewLayout(N, { width: 1000, height: 400 });
    const at = (col: number, row: number) => {
      const p = worldToOverview(o, TILE_H, tileTopVertexToWorld(col, row, TILE_W, TILE_H));
      return { x: Math.round(p.x * 1e6) / 1e6, y: Math.round(p.y * 1e6) / 1e6 };
    };
    expect(at(0, 0)).toEqual({ x: 500, y: 0 });
    expect(at(N, 0)).toEqual({ x: 900, y: 200 });
    expect(at(N, N)).toEqual({ x: 500, y: 400 });
    expect(at(0, N)).toEqual({ x: 100, y: 200 });
  });

  it('turns a point of the overview back into the world point it shows', () => {
    const o = overviewLayout(N, { width: 1000, height: 400 });
    for (const p of [
      { x: 0, y: 4500 },
      { x: -3000, y: 3100 },
      { x: 2500, y: 7000 },
    ]) {
      const back = overviewToWorld(o, TILE_H, worldToOverview(o, TILE_H, p));
      expect(back!.x).toBeCloseTo(p.x, 6);
      expect(back!.y).toBeCloseTo(p.y, 6);
    }
  });

  it('ignores a point outside the map diamond', () => {
    const o = overviewLayout(N, { width: 1000, height: 400 });
    expect(overviewToWorld(o, TILE_H, { x: 110, y: 10 })).toBeNull();
    expect(overviewToWorld(o, TILE_H, { x: 990, y: 390 })).toBeNull();
    expect(overviewToWorld(o, TILE_H, { x: 500, y: 200 })).not.toBeNull();
  });
});

describe('pinch with two fingers', () => {
  const start = { x: 0, y: 4500, zoom: 1 };

  it('zooms by the change of distance between the fingers and keeps the spot between them in place', () => {
    const from = [
      { x: 600, y: 400 },
      { x: 700, y: 400 },
    ] as const;
    const to = [
      { x: 550, y: 400 },
      { x: 750, y: 400 },
    ] as const;
    const next = pinchCamera(start, from, to, VIEW, LIMITS, BOUNDS);
    expect(next.zoom).toBeCloseTo(2, 9);
    const before = screenToWorld(650, 400, start, VIEW);
    const after = screenToWorld(650, 400, next, VIEW);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('stays inside the zoom limits', () => {
    const from = [
      { x: 600, y: 400 },
      { x: 700, y: 400 },
    ] as const;
    const apart = [
      { x: 300, y: 400 },
      { x: 1000, y: 400 },
    ] as const;
    const together = [
      { x: 645, y: 400 },
      { x: 655, y: 400 },
    ] as const;
    expect(pinchCamera(start, from, apart, VIEW, LIMITS, BOUNDS).zoom).toBe(2);
    expect(pinchCamera(start, from, together, VIEW, LIMITS, BOUNDS).zoom).toBe(0.5);
  });

  it('moves the map with the fingers when their distance stays the same', () => {
    const from = [
      { x: 600, y: 400 },
      { x: 700, y: 400 },
    ] as const;
    const moved = [
      { x: 640, y: 380 },
      { x: 740, y: 380 },
    ] as const;
    const next = pinchCamera(start, from, moved, VIEW, LIMITS, BOUNDS);
    expect(next).toEqual({ x: -40, y: 4520, zoom: 1 });
  });

  it('keeps the camera on the map', () => {
    const edge = { x: BOUNDS.maxX, y: BOUNDS.maxY, zoom: 1 };
    const from = [
      { x: 600, y: 400 },
      { x: 700, y: 400 },
    ] as const;
    const away = [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
    ] as const;
    expect(pinchCamera(edge, from, away, VIEW, LIMITS, BOUNDS)).toEqual(edge);
  });
});

describe('wheel zoom', () => {
  it('zooms in for a wheel turned away and out for one turned back, by about one step a notch', () => {
    expect(wheelZoomFactor({ deltaY: -100, deltaMode: 0, ctrlKey: false })).toBeCloseTo(1.15, 6);
    expect(wheelZoomFactor({ deltaY: 100, deltaMode: 0, ctrlKey: false })).toBeCloseTo(1 / 1.15, 6);
    expect(wheelZoomFactor({ deltaY: 0, deltaMode: 0, ctrlKey: false })).toBe(1);
  });

  it('reads a wheel that counts lines or pages like one that counts pixels', () => {
    const lines = wheelZoomFactor({ deltaY: -3, deltaMode: 1, ctrlKey: false });
    expect(lines).toBeGreaterThan(1.12);
    expect(lines).toBeLessThan(1.18);
    expect(wheelZoomFactor({ deltaY: 1, deltaMode: 2, ctrlKey: false })).toBeLessThan(1);
  });

  it('follows a trackpad pinch smoothly, a little for each small step', () => {
    const small = wheelZoomFactor({ deltaY: -4, deltaMode: 0, ctrlKey: true });
    expect(small).toBeGreaterThan(1.02);
    expect(small).toBeLessThan(1.08);
  });

  it('never jumps far on one huge turn', () => {
    expect(wheelZoomFactor({ deltaY: -5000, deltaMode: 0, ctrlKey: false })).toBeLessThan(2);
    expect(wheelZoomFactor({ deltaY: 5000, deltaMode: 0, ctrlKey: true })).toBeGreaterThan(0.5);
  });
});

describe('the page address', () => {
  it('opens the accepted map when the address names no seed', () => {
    expect(DEFAULT_VIEWER_SEED).toBe('hornhoof');
    expect(readViewerQuery('', 'ru-RU')).toEqual({ seed: 'hornhoof', lang: 'ru' });
    expect(readViewerQuery('?seed=%20%20', 'en-US')).toEqual({ seed: 'hornhoof', lang: 'en' });
  });

  it('takes the seed and language from the address', () => {
    expect(readViewerQuery('?seed=%20north-star%20&lang=en', 'ru')).toEqual({ seed: 'north-star', lang: 'en' });
    expect(readViewerQuery('?lang=ru', 'de-DE')).toEqual({ seed: 'hornhoof', lang: 'ru' });
    expect(readViewerQuery('?lang=fr', 'de-DE')).toEqual({ seed: 'hornhoof', lang: 'en' });
  });

  it('ignores a seed too long to be one', () => {
    expect(readViewerQuery(`?seed=${'x'.repeat(65)}`, 'en')).toEqual({ seed: 'hornhoof', lang: 'en' });
  });
});
