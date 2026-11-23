import { describe, expect, it, vi } from 'vitest';
import {
  animationDetailForZoom,
  computeEffectiveZoomBounds,
  createInitialCamera,
  lodForCamera,
  panCamera,
  visibleWorldRect,
  zoomCameraAt,
  zoomPercent,
  type CameraState,
  type ViewportSize,
} from '../src/world/camera';
import { bakeChunkCanvas, buildTileLookup } from '../src/world/chunk-baker';
import {
  buildChunkGrid,
  ChunkLruCache,
  cullVisibleChunks,
  rectsIntersect,
  type ChunkCoord,
} from '../src/world/chunks';
import { mapWorldBounds, screenToWorld } from '../src/world/coords';
import { DEFAULT_ISOMETRIC_PROJECTION, selectLodTier, type WorldPackManifest } from '../src/world/manifest';
import { STUB_DIAMOND_PACK } from '../src/world/packs/stub-pack';

const TILE_W = STUB_DIAMOND_PACK.projection.defaultTileW;
const TILE_H = STUB_DIAMOND_PACK.projection.defaultTileH;
const MAP_SIZE = STUB_DIAMOND_PACK.mapSize;
const CHUNK_SIZE = STUB_DIAMOND_PACK.params.chunkSize;
const DESKTOP: ViewportSize = { width: 1440, height: 900 };

describe('chunk partitioning and viewport culling', () => {
  it('partitions every tile of a 150x150 map into 4x4 chunks exactly once without gaps or overlaps', () => {
    const grid = buildChunkGrid(MAP_SIZE, CHUNK_SIZE, TILE_W, TILE_H);
    expect(grid.chunksPerAxis).toBe(Math.ceil(MAP_SIZE / CHUNK_SIZE));
    expect(grid.chunksPerAxis).toBe(38);
    expect(grid.chunks).toHaveLength(38 * 38);

    const covered = new Uint8Array(MAP_SIZE * MAP_SIZE);
    for (const chunk of grid.chunks) {
      expect(chunk.colEnd).toBeLessThanOrEqual(MAP_SIZE);
      expect(chunk.rowEnd).toBeLessThanOrEqual(MAP_SIZE);
      expect(chunk.colStart).toBeLessThan(chunk.colEnd);
      expect(chunk.rowStart).toBeLessThan(chunk.rowEnd);
      for (let row = chunk.rowStart; row < chunk.rowEnd; row++) {
        for (let col = chunk.colStart; col < chunk.colEnd; col++) {
          const idx = row * MAP_SIZE + col;
          covered[idx] = (covered[idx] ?? 0) + 1;
        }
      }
    }
    expect(covered.every(count => count === 1)).toBe(true);
  });

  it('matches exhaustive AABB culling exactly across 100 camera positions and zooms in [50%, 200%]', () => {
    const grid = buildChunkGrid(MAP_SIZE, CHUNK_SIZE, TILE_W, TILE_H);
    const bounds = mapWorldBounds(MAP_SIZE, TILE_W, TILE_H);
    const zooms = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

    for (let i = 0; i < 100; i++) {
      const fx = ((i * 37) % 100) / 100;
      const fy = ((i * 61) % 100) / 100;
      const cam: CameraState = {
        x: bounds.minX + fx * bounds.width,
        y: bounds.minY + fy * bounds.height,
        zoom: zooms[i % zooms.length]!,
      };
      const rect = visibleWorldRect(cam, DESKTOP, TILE_W);
      const fast = cullVisibleChunks(grid, rect).map((c: ChunkCoord) => c.key).sort();
      const brute = grid.chunks.filter(c => rectsIntersect(c.bounds, rect)).map(c => c.key).sort();
      expect(fast, `camera #${i} (${cam.x}, ${cam.y}, z=${cam.zoom})`).toEqual(brute);
    }
  });

  it('culls over 88% of chunks even at 50% minimum zoom (no bird-eye whole-map view)', () => {
    const grid = buildChunkGrid(MAP_SIZE, CHUNK_SIZE, TILE_W, TILE_H);
    const bounds = mapWorldBounds(MAP_SIZE, TILE_W, TILE_H);

    const camMin: CameraState = { x: bounds.centerX, y: bounds.centerY, zoom: 0.5 };
    const visMin = cullVisibleChunks(grid, visibleWorldRect(camMin, DESKTOP, 0));
    expect(visMin.length).toBeGreaterThan(0);
    expect(visMin.length).toBeLessThan(Math.ceil(grid.chunks.length * 0.12));

    const camDefault: CameraState = { x: bounds.centerX, y: bounds.centerY, zoom: 1.0 };
    const visDefault = cullVisibleChunks(grid, visibleWorldRect(camDefault, DESKTOP, 0));
    expect(visDefault.length).toBeGreaterThan(0);
    expect(visDefault.length).toBeLessThan(visMin.length);
    expect(visDefault.length).toBeLessThan(Math.ceil(grid.chunks.length * 0.05));

    const camMax: CameraState = { x: bounds.centerX, y: bounds.centerY, zoom: 2.0 };
    const visMax = cullVisibleChunks(grid, visibleWorldRect(camMax, DESKTOP, 0));
    expect(visMax.length).toBeGreaterThan(0);
    expect(visMax.length).toBeLessThan(visDefault.length);
    expect(visMax.length).toBeLessThan(Math.ceil(grid.chunks.length * 0.02));
  });

  it('keeps baked 4x4 chunk textures under 2048 px even at 8x Retina LOD', () => {
    const grid = buildChunkGrid(MAP_SIZE, CHUNK_SIZE, TILE_W, TILE_H);
    const lookup = buildTileLookup(STUB_DIAMOND_PACK);
    const lod8x = DEFAULT_ISOMETRIC_PROJECTION.lods.find(l => l.id === '8x')!;
    const baked = bakeChunkCanvas(grid.chunks[0]!, STUB_DIAMOND_PACK, lookup, lod8x);
    expect(baked.lodId).toBe('8x');
    expect(baked.tileCount).toBe(16);
    expect(baked.pixelWidth).toBeLessThanOrEqual(2048);
    expect(baked.pixelHeight).toBeLessThanOrEqual(1024);
  });

  it('evicts least-recently-used inactive chunks while keeping active chunks pinned', () => {
    const cache = new ChunkLruCache<string>(3);
    const disposed: string[] = [];
    const onDispose = vi.fn((val: string) => disposed.push(val));

    cache.set('a', 'tex-a');
    cache.set('b', 'tex-b');
    cache.set('c', 'tex-c');
    /* Touch 'a' so 'b' becomes least-recently-used. */
    expect(cache.get('a')).toBe('tex-a');
    cache.set('d', 'tex-d');
    cache.evictIfNeeded(new Set(['a', 'd']), onDispose);

    expect(cache.size).toBe(3);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('d')).toBe(true);
    expect(disposed).toEqual(['tex-b']);

    cache.clear(onDispose);
    expect(cache.size).toBe(0);
    expect(disposed).toHaveLength(4);
  });
});

describe('hard camera zoom bounds, drag panning and Retina-aware LOD selection', () => {
  it('starts centered at 100% default zoom and enforces hard 50%..200% zoom bounds', () => {
    const bounds = mapWorldBounds(MAP_SIZE, TILE_W, TILE_H);
    const zoomBounds = computeEffectiveZoomBounds(STUB_DIAMOND_PACK, 1);
    expect(zoomBounds).toEqual({
      minZoom: 0.5,
      defaultZoom: 1.0,
      maxZoom: 2.0,
      cappedBySource: false,
    });

    const initial = createInitialCamera(STUB_DIAMOND_PACK, 1);
    expect(initial).toEqual({ x: bounds.centerX, y: bounds.centerY, zoom: 1.0 });
    expect(zoomPercent(initial.zoom)).toBe(100);

    const anchor = { x: 980, y: 310 };
    const zoomedOut = zoomCameraAt(initial, 0.01, anchor, DESKTOP, zoomBounds.minZoom, zoomBounds.maxZoom, bounds);
    expect(zoomedOut.zoom).toBe(0.5);
    expect(zoomPercent(zoomedOut.zoom)).toBe(50);

    const zoomedOutMore = zoomCameraAt(zoomedOut, 0.5, anchor, DESKTOP, zoomBounds.minZoom, zoomBounds.maxZoom, bounds);
    expect(zoomedOutMore).toBe(zoomedOut);

    const zoomedIn = zoomCameraAt(initial, 100, anchor, DESKTOP, zoomBounds.minZoom, zoomBounds.maxZoom, bounds);
    expect(zoomedIn.zoom).toBe(2.0);
    expect(zoomPercent(zoomedIn.zoom)).toBe(200);

    const zoomedInMore = zoomCameraAt(zoomedIn, 2, anchor, DESKTOP, zoomBounds.minZoom, zoomBounds.maxZoom, bounds);
    expect(zoomedInMore).toBe(zoomedIn);
  });

  it('keeps the world point under the pointer stationary when zooming and clamps pan to map bounds', () => {
    const bounds = mapWorldBounds(MAP_SIZE, TILE_W, TILE_H);
    const start: CameraState = { x: 400, y: 3900, zoom: 1.0 };
    const anchor = { x: 980, y: 310 };
    const before = screenToWorld(anchor.x, anchor.y, start, DESKTOP);

    const zoomedIn = zoomCameraAt(start, 1.5, anchor, DESKTOP, 0.5, 2.0, bounds);
    const after = screenToWorld(anchor.x, anchor.y, zoomedIn, DESKTOP);
    expect(zoomedIn.zoom).toBeCloseTo(1.5, 6);
    expect(after.x).toBeCloseTo(before.x, 4);
    expect(after.y).toBeCloseTo(before.y, 4);

    const panned = panCamera(start, 999999, -999999, bounds);
    expect(panned.x).toBeGreaterThanOrEqual(bounds.minX);
    expect(panned.x).toBeLessThanOrEqual(bounds.maxX);
    expect(panned.y).toBeGreaterThanOrEqual(bounds.minY);
    expect(panned.y).toBeLessThanOrEqual(bounds.maxY);
  });

  it('selects the smallest LOD tier >= CSS tile width * DPR without upscaling blur', () => {
    const lods = DEFAULT_ISOMETRIC_PROJECTION.lods;

    /* Standard 1x display. */
    expect(lodForCamera(STUB_DIAMOND_PACK, 0.5, 1).id).toBe('1x');
    expect(lodForCamera(STUB_DIAMOND_PACK, 0.75, 1).id).toBe('2x');
    expect(lodForCamera(STUB_DIAMOND_PACK, 1.0, 1).id).toBe('2x');
    expect(lodForCamera(STUB_DIAMOND_PACK, 1.5, 1).id).toBe('4x');
    expect(lodForCamera(STUB_DIAMOND_PACK, 2.0, 1).id).toBe('4x');

    /* 2x Retina display picks one LOD step higher so physical pixels remain 1:1 or downsampled. */
    expect(lodForCamera(STUB_DIAMOND_PACK, 0.5, 2).id).toBe('2x');
    expect(lodForCamera(STUB_DIAMOND_PACK, 1.0, 2).id).toBe('4x');
    expect(lodForCamera(STUB_DIAMOND_PACK, 2.0, 2).id).toBe('8x');

    /* Direct selectLodTier check with unsorted input order. */
    const reversed = [...lods].reverse();
    expect(selectLodTier(reversed, 120, 1).id).toBe('2x');
    expect(selectLodTier(reversed, 120, 2).id).toBe('4x');
    expect(selectLodTier(reversed, 240, 2).id).toBe('8x');
  });

  it('automatically caps maxZoom when pack source art lacks Retina resolution (never stretches)', () => {
    /* Pack with 1x..4x only (max 240 px tile, no 8x 480 px tier). */
    const packWithout8x: WorldPackManifest = {
      ...STUB_DIAMOND_PACK,
      projection: {
        ...STUB_DIAMOND_PACK.projection,
        lods: STUB_DIAMOND_PACK.projection.lods.filter(l => l.id !== '8x'),
      },
    };

    /* At 1x DPR, 240 px source covers full 200% (240 CSS px) with zero stretching. */
    expect(computeEffectiveZoomBounds(packWithout8x, 1)).toEqual({
      minZoom: 0.5,
      defaultZoom: 1.0,
      maxZoom: 2.0,
      cappedBySource: false,
    });

    /* At 2x Retina DPR, 240 px source caps maxZoom at 100% (120 CSS px * 2 = 240 physical px). */
    expect(computeEffectiveZoomBounds(packWithout8x, 2)).toEqual({
      minZoom: 0.5,
      defaultZoom: 1.0,
      maxZoom: 1.0,
      cappedBySource: true,
    });

    /* Explicit per-view asset cap (e.g. a sprite capped at 120 px) also prevents upscaling. */
    expect(computeEffectiveZoomBounds(STUB_DIAMOND_PACK, 1, 120)).toEqual({
      minZoom: 0.5,
      defaultZoom: 1.0,
      maxZoom: 1.0,
      cappedBySource: true,
    });
  });

  it('reduces animation detail at far zoom and enables full detail up close', () => {
    expect(animationDetailForZoom(0.5)).toBe('reduced');
    expect(animationDetailForZoom(0.7)).toBe('reduced');
    expect(animationDetailForZoom(1.0)).toBe('standard');
    expect(animationDetailForZoom(1.4)).toBe('standard');
    expect(animationDetailForZoom(1.5)).toBe('full');
    expect(animationDetailForZoom(2.0)).toBe('full');
  });
});
