import { describe, expect, it, vi } from 'vitest';
import {
  activeZoomTier,
  computeBirdEyeZoom,
  panCamera,
  visibleWorldRect,
  zoomCameraAt,
  zoomForTier,
  type CameraState,
  type ViewportSize,
} from '../src/world/camera';
import {
  buildChunkGrid,
  ChunkLruCache,
  cullVisibleChunks,
  rectsIntersect,
  type ChunkCoord,
} from '../src/world/chunks';
import { mapWorldBounds, screenToWorld, worldToScreen } from '../src/world/coords';

const TILE_W = 60;
const TILE_H = 30;
const MAP_SIZE = 150;
const CHUNK_SIZE = 8;
const DESKTOP: ViewportSize = { width: 1440, height: 900 };

describe('chunk partitioning and viewport culling', () => {
  it('partitions every tile of a 150x150 map exactly once without gaps or overlaps', () => {
    const grid = buildChunkGrid(MAP_SIZE, CHUNK_SIZE, TILE_W, TILE_H);
    expect(grid.chunksPerAxis).toBe(Math.ceil(MAP_SIZE / CHUNK_SIZE));
    expect(grid.chunks).toHaveLength(19 * 19);

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

  it('matches exhaustive AABB culling exactly across 100 camera positions and zooms', () => {
    const grid = buildChunkGrid(MAP_SIZE, CHUNK_SIZE, TILE_W, TILE_H);
    const bounds = mapWorldBounds(MAP_SIZE, TILE_W, TILE_H);
    const zooms = [0.12, 0.35, 0.75, 1, 2, 4];

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

  it('culls over 95% of chunks at 4x zoom and renders the whole map at bird-eye zoom', () => {
    const grid = buildChunkGrid(MAP_SIZE, CHUNK_SIZE, TILE_W, TILE_H);
    const bounds = mapWorldBounds(MAP_SIZE, TILE_W, TILE_H);

    const cam4x: CameraState = { x: bounds.centerX, y: bounds.centerY, zoom: 4 };
    const vis4x = cullVisibleChunks(grid, visibleWorldRect(cam4x, DESKTOP, 0));
    expect(vis4x.length).toBeGreaterThan(0);
    expect(vis4x.length).toBeLessThan(Math.ceil(grid.chunks.length * 0.05));

    const cam2x: CameraState = { x: bounds.centerX, y: bounds.centerY, zoom: 2 };
    const vis2x = cullVisibleChunks(grid, visibleWorldRect(cam2x, DESKTOP, 0));
    expect(vis2x.length).toBeLessThan(Math.ceil(grid.chunks.length * 0.1));

    const cam1x: CameraState = { x: bounds.centerX, y: bounds.centerY, zoom: 1 };
    const vis1x = cullVisibleChunks(grid, visibleWorldRect(cam1x, DESKTOP, 0));
    expect(vis1x.length).toBeLessThan(Math.ceil(grid.chunks.length * 0.2));

    const birdZoom = computeBirdEyeZoom(MAP_SIZE, TILE_W, TILE_H, DESKTOP, 24);
    const camBird: CameraState = { x: bounds.centerX, y: bounds.centerY, zoom: birdZoom };
    const visBird = cullVisibleChunks(grid, visibleWorldRect(camBird, DESKTOP, 0));
    expect(visBird.length).toBe(grid.chunks.length);

    /* Confirm all four corners of the 150x150 map fit inside the viewport at bird-eye zoom. */
    const topLeft = worldToScreen(bounds.minX, bounds.minY, camBird, DESKTOP);
    const bottomRight = worldToScreen(bounds.maxX, bounds.maxY, camBird, DESKTOP);
    expect(topLeft.x).toBeGreaterThanOrEqual(23);
    expect(topLeft.y).toBeGreaterThanOrEqual(23);
    expect(bottomRight.x).toBeLessThanOrEqual(DESKTOP.width - 23);
    expect(bottomRight.y).toBeLessThanOrEqual(DESKTOP.height - 23);
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

describe('camera pan, cursor-anchored zoom and resolution tiers', () => {
  it('keeps the world point under the pointer stationary when zooming', () => {
    const bounds = mapWorldBounds(MAP_SIZE, TILE_W, TILE_H);
    const birdZoom = computeBirdEyeZoom(MAP_SIZE, TILE_W, TILE_H, DESKTOP, 24);
    const start: CameraState = { x: 400, y: 1900, zoom: 1 };
    const anchor = { x: 980, y: 310 };
    const before = screenToWorld(anchor.x, anchor.y, start, DESKTOP);

    const zoomedIn = zoomCameraAt(start, 2, anchor, DESKTOP, birdZoom, 4, bounds);
    const after = screenToWorld(anchor.x, anchor.y, zoomedIn, DESKTOP);
    expect(zoomedIn.zoom).toBeCloseTo(2, 6);
    expect(after.x).toBeCloseTo(before.x, 4);
    expect(after.y).toBeCloseTo(before.y, 4);
  });

  it('clamps pan smoothly to map bounds and maps zoom values to standard LOD tiers', () => {
    const bounds = mapWorldBounds(MAP_SIZE, TILE_W, TILE_H);
    const panned = panCamera({ x: 0, y: 2250, zoom: 1 }, 99999, -99999, bounds);
    expect(panned.x).toBeGreaterThanOrEqual(bounds.minX);
    expect(panned.x).toBeLessThanOrEqual(bounds.maxX);
    expect(panned.y).toBeGreaterThanOrEqual(bounds.minY);
    expect(panned.y).toBeLessThanOrEqual(bounds.maxY);

    expect(zoomForTier('1x', MAP_SIZE, TILE_W, TILE_H, DESKTOP, 24)).toBe(1);
    expect(zoomForTier('2x', MAP_SIZE, TILE_W, TILE_H, DESKTOP, 24)).toBe(2);
    expect(zoomForTier('4x', MAP_SIZE, TILE_W, TILE_H, DESKTOP, 24)).toBe(4);
    expect(activeZoomTier(0.15)).toBe('overview');
    expect(activeZoomTier(1)).toBe('1x');
    expect(activeZoomTier(2)).toBe('2x');
    expect(activeZoomTier(4)).toBe('4x');
  });
});
