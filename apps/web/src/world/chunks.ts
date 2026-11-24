/* Chunk grid partitioning, O(visible) frustum culling and bounded LRU texture cache. */

import { footprintToWorldDiamond, worldToTileFloat, type WorldRect } from './coords';

export type ChunkCoord = Readonly<{
  cx: number;
  cy: number;
  key: string;
  colStart: number;
  rowStart: number;
  colEnd: number;
  rowEnd: number;
  bounds: WorldRect;
}>;

export type ChunkGrid = Readonly<{
  mapSize: number;
  chunkSize: number;
  chunksPerAxis: number;
  tileW: number;
  tileH: number;
  chunks: readonly ChunkCoord[];
  byIndex: ReadonlyArray<ChunkCoord>;
}>;

export function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

export function rectsIntersect(a: WorldRect, b: WorldRect): boolean {
  return a.maxX >= b.minX && a.minX <= b.maxX && a.maxY >= b.minY && a.minY <= b.maxY;
}

/* Partitions an N x N diamond map into square chunkSize x chunkSize tile chunks (clipped at map edges). */
export function buildChunkGrid(mapSize: number, chunkSize: number, tileW: number, tileH: number): ChunkGrid {
  const chunksPerAxis = Math.ceil(mapSize / chunkSize);
  const chunks: ChunkCoord[] = [];
  for (let cy = 0; cy < chunksPerAxis; cy++) {
    const rowStart = cy * chunkSize;
    const rowEnd = Math.min(mapSize, rowStart + chunkSize);
    for (let cx = 0; cx < chunksPerAxis; cx++) {
      const colStart = cx * chunkSize;
      const colEnd = Math.min(mapSize, colStart + chunkSize);
      const fp = footprintToWorldDiamond(colStart, rowStart, colEnd - colStart, rowEnd - rowStart, tileW, tileH);
      chunks.push({
        cx,
        cy,
        key: chunkKey(cx, cy),
        colStart,
        rowStart,
        colEnd,
        rowEnd,
        bounds: fp.bounds,
      });
    }
  }
  return {
    mapSize,
    chunkSize,
    chunksPerAxis,
    tileW,
    tileH,
    chunks,
    byIndex: chunks,
  };
}

/* O(visible) isometric frustum culling: projects the four corners of the visible world rectangle into
   fractional tile space to bound candidate chunk indices, then filters by exact AABB intersection. */
export function cullVisibleChunks(grid: ChunkGrid, visible: WorldRect): ChunkCoord[] {
  const corners = [
    worldToTileFloat(visible.minX, visible.minY, grid.tileW, grid.tileH),
    worldToTileFloat(visible.maxX, visible.minY, grid.tileW, grid.tileH),
    worldToTileFloat(visible.maxX, visible.maxY, grid.tileW, grid.tileH),
    worldToTileFloat(visible.minX, visible.maxY, grid.tileW, grid.tileH),
  ];

  let minCol = Infinity;
  let maxCol = -Infinity;
  let minRow = Infinity;
  let maxRow = -Infinity;
  for (const pt of corners) {
    if (pt.col < minCol) minCol = pt.col;
    if (pt.col > maxCol) maxCol = pt.col;
    if (pt.row < minRow) minRow = pt.row;
    if (pt.row > maxRow) maxRow = pt.row;
  }

  const maxChunk = grid.chunksPerAxis - 1;
  const cxMin = Math.max(0, Math.floor(minCol / grid.chunkSize) - 1);
  const cxMax = Math.min(maxChunk, Math.floor(maxCol / grid.chunkSize) + 1);
  const cyMin = Math.max(0, Math.floor(minRow / grid.chunkSize) - 1);
  const cyMax = Math.min(maxChunk, Math.floor(maxRow / grid.chunkSize) + 1);

  if (cxMin > cxMax || cyMin > cyMax) return [];

  const result: ChunkCoord[] = [];
  for (let cy = cyMin; cy <= cyMax; cy++) {
    const rowOffset = cy * grid.chunksPerAxis;
    for (let cx = cxMin; cx <= cxMax; cx++) {
      const chunk = grid.byIndex[rowOffset + cx];
      if (chunk && rectsIntersect(chunk.bounds, visible)) {
        result.push(chunk);
      }
    }
  }
  return result;
}

/* Bounded LRU cache for baked chunk textures. Map iteration order tracks recency (oldest first). */
export class ChunkLruCache<T> {
  private readonly store = new Map<string, T>();
  private readonly maxEntries: number;

  constructor(maxEntries: number) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  get size(): number {
    return this.store.size;
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  get(key: string): T | undefined {
    const value = this.store.get(key);
    if (value === undefined) return undefined;
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  set(key: string, value: T): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, value);
  }

  /* Evicts least-recently-used keys not in protectedKeys until size <= maxEntries. */
  evictIfNeeded(protectedKeys: ReadonlySet<string>, onDispose: (value: T, key: string) => void): void {
    if (this.store.size <= this.maxEntries) return;
    for (const [key, value] of this.store) {
      if (this.store.size <= this.maxEntries) break;
      if (protectedKeys.has(key)) continue;
      this.store.delete(key);
      onDispose(value, key);
    }
  }

  clear(onDispose: (value: T, key: string) => void): void {
    for (const [key, value] of this.store) {
      onDispose(value, key);
    }
    this.store.clear();
  }
}
