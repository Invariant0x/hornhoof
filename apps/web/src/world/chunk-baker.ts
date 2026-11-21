/* Offscreen HTMLCanvas2D terrain chunk baker.
   Bakes one chunkSize x chunkSize diamond patch into a crisp raster image at the selected LOD tier,
   ready for GPU texture upload (PixiJS) or direct 2D blitting. */

import type { ChunkCoord } from './chunks';
import { tileCenterToWorld } from './coords';
import type { LodTierId, LodTierSpec, TileSlotSpec, WorldPackManifest } from './manifest';

export type BakedChunk = Readonly<{
  canvas: HTMLCanvasElement;
  worldX: number;
  worldY: number;
  scale: number;
  pixelWidth: number;
  pixelHeight: number;
  tileCount: number;
  lodId: LodTierId;
}>;

const BAKE_PAD_PX = 1;

export function buildTileLookup(pack: WorldPackManifest): ReadonlyMap<string, TileSlotSpec> {
  const map = new Map<string, TileSlotSpec>();
  for (const tile of pack.tiles) map.set(tile.id, tile);
  return map;
}

export function bakeChunkCanvas(
  chunk: ChunkCoord,
  pack: WorldPackManifest,
  tileLookup: ReadonlyMap<string, TileSlotSpec>,
  lod: LodTierSpec,
  resolveTileId?: (col: number, row: number) => string,
): BakedChunk {
  const baseTileW = pack.projection.defaultTileW;
  const baseTileH = pack.projection.defaultTileH;
  const scale = lod.tileW / baseTileW;

  const worldWidth = chunk.bounds.maxX - chunk.bounds.minX;
  const worldHeight = chunk.bounds.maxY - chunk.bounds.minY;
  const pixelWidth = Math.max(2, Math.ceil(worldWidth * scale) + BAKE_PAD_PX * 2);
  const pixelHeight = Math.max(2, Math.ceil(worldHeight * scale) + BAKE_PAD_PX * 2);

  const canvas = document.createElement('canvas');
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  const ctx = canvas.getContext('2d');

  const fallbackTile = tileLookup.get(pack.defaultTileId) ?? pack.tiles[0]!;
  const resolver = resolveTileId ?? (pack.resolveEmptyTileId
    ? (c: number, r: number) => pack.resolveEmptyTileId!(c, r, pack.params.chunkSize, pack.mapSize)
    : () => pack.defaultTileId);

  let tileCount = 0;
  if (ctx) {
    const hw = lod.tileW / 2;
    const hh = lod.tileH / 2;
    const showBevel = lod.tileW >= 120;
    const showCoords = lod.tileW >= 240;

    ctx.lineJoin = 'miter';
    for (let row = chunk.rowStart; row < chunk.rowEnd; row++) {
      for (let col = chunk.colStart; col < chunk.colEnd; col++) {
        tileCount++;
        const spec = tileLookup.get(resolver(col, row)) ?? fallbackTile;
        const wc = tileCenterToWorld(col, row, baseTileW, baseTileH);
        const cx = (wc.x - chunk.bounds.minX) * scale + BAKE_PAD_PX;
        const cy = (wc.y - chunk.bounds.minY) * scale + BAKE_PAD_PX;

        ctx.beginPath();
        ctx.moveTo(cx, cy - hh);
        ctx.lineTo(cx + hw, cy);
        ctx.lineTo(cx, cy + hh);
        ctx.lineTo(cx - hw, cy);
        ctx.closePath();

        ctx.fillStyle = spec.fill;
        ctx.fill();

        ctx.strokeStyle = spec.stroke;
        ctx.lineWidth = Math.max(1, scale);
        ctx.stroke();

        if (showBevel && spec.accent) {
          const inset = Math.max(1.25, 1.5 * scale);
          ctx.beginPath();
          ctx.moveTo(cx - hw + inset, cy);
          ctx.lineTo(cx, cy - hh + inset);
          ctx.lineTo(cx + hw - inset, cy);
          ctx.strokeStyle = spec.accent;
          ctx.lineWidth = Math.max(1, scale);
          ctx.stroke();
        }

        if (showCoords) {
          const fontPx = Math.round(13 * (lod.tileW / 240));
          ctx.fillStyle = 'rgba(220, 234, 248, 0.42)';
          ctx.font = `600 ${fontPx}px ui-monospace, Menlo, Consolas, monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(`${col},${row}`, cx, cy);
        }
      }
    }

    /* Draw subtle outer chunk boundary so chunk partitioning is inspectable at 50% and 100%. */
    if (lod.tileW <= 120) {
      const top = tileCenterToWorld(chunk.colStart, chunk.rowStart, baseTileW, baseTileH);
      const right = tileCenterToWorld(chunk.colEnd - 1, chunk.rowStart, baseTileW, baseTileH);
      const bottom = tileCenterToWorld(chunk.colEnd - 1, chunk.rowEnd - 1, baseTileW, baseTileH);
      const left = tileCenterToWorld(chunk.colStart, chunk.rowEnd - 1, baseTileW, baseTileH);
      const px = (wx: number) => (wx - chunk.bounds.minX) * scale + BAKE_PAD_PX;
      const py = (wy: number) => (wy - chunk.bounds.minY) * scale + BAKE_PAD_PX;

      ctx.beginPath();
      ctx.moveTo(px(top.x), py(top.y - baseTileH / 2));
      ctx.lineTo(px(right.x + baseTileW / 2), py(right.y));
      ctx.lineTo(px(bottom.x), py(bottom.y + baseTileH / 2));
      ctx.lineTo(px(left.x - baseTileW / 2), py(left.y));
      ctx.closePath();
      ctx.strokeStyle = pack.palette.chunkLine;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  } else {
    tileCount = (chunk.colEnd - chunk.colStart) * (chunk.rowEnd - chunk.rowStart);
  }

  return {
    canvas,
    worldX: chunk.bounds.minX - BAKE_PAD_PX / scale,
    worldY: chunk.bounds.minY - BAKE_PAD_PX / scale,
    scale,
    pixelWidth,
    pixelHeight,
    tileCount,
    lodId: lod.id,
  };
}
