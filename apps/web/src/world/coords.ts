/* Exact 2:1 diamond isometric coordinate conversion and click picking.
   World units are expressed in default 100% logical pixels (defaultTileW x defaultTileH, e.g. 120 x 60),
   so camera zoom 0.5 = 50% (60x30 CSS px), 1.0 = 100% (120x60 CSS px), and 2.0 = 200% (240x120 CSS px). */

import type { CameraState, ViewportSize } from './camera';

export type Point2D = Readonly<{ x: number; y: number }>;
export type TileCoord = Readonly<{ col: number; row: number }>;

export type WorldRect = Readonly<{
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}>;

export type MapWorldBounds = WorldRect & Readonly<{
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}>;

export type FootprintDiamond = Readonly<{
  corners: readonly [Point2D, Point2D, Point2D, Point2D];
  bounds: WorldRect;
  width: number;
  height: number;
  center: Point2D;
}>;

export type PickableObject = Readonly<{
  id: string;
  kind: string;
  col: number;
  row: number;
  spanCol: number;
  spanRow: number;
  /* Visual height rising above the ground footprint in logical world pixels. */
  heightWorld?: number;
  label?: string;
}>;

export type PickResult =
  | Readonly<{ kind: 'object'; object: PickableObject; col: number; row: number }>
  | Readonly<{ kind: 'tile'; col: number; row: number }>;

/* Top (north) vertex of diamond tile (col, row) in logical world coordinates. */
export function tileTopVertexToWorld(col: number, row: number, tileW: number, tileH: number): Point2D {
  return {
    x: (col - row) * (tileW / 2),
    y: (col + row) * (tileH / 2),
  };
}

/* Exact center of diamond tile (col, row) in logical world coordinates. */
export function tileCenterToWorld(col: number, row: number, tileW: number, tileH: number): Point2D {
  return {
    x: (col - row) * (tileW / 2),
    y: (col + row + 1) * (tileH / 2),
  };
}

/* Four diamond vertices [top, right, bottom, left] of tile (col, row) in world coordinates. */
export function tileDiamondVertices(
  col: number,
  row: number,
  tileW: number,
  tileH: number,
): readonly [Point2D, Point2D, Point2D, Point2D] {
  const c = tileCenterToWorld(col, row, tileW, tileH);
  const hw = tileW / 2;
  const hh = tileH / 2;
  return [
    { x: c.x, y: c.y - hh },
    { x: c.x + hw, y: c.y },
    { x: c.x, y: c.y + hh },
    { x: c.x - hw, y: c.y },
  ];
}

/* Continuous fractional tile coordinates for any world point. Every interior point of tile (c, r)
   satisfies c <= col < c + 1 and r <= row < r + 1. */
export function worldToTileFloat(wx: number, wy: number, tileW: number, tileH: number): TileCoord {
  const u = wx / (tileW / 2);
  const v = wy / (tileH / 2);
  return {
    col: (u + v) / 2,
    row: (v - u) / 2,
  };
}

/* Discrete tile coordinate for a world point, or null if outside [0, mapSize) x [0, mapSize). */
export function worldToTile(
  wx: number,
  wy: number,
  tileW: number,
  tileH: number,
  mapSize: number,
): TileCoord | null {
  const f = worldToTileFloat(wx, wy, tileW, tileH);
  const col = Math.floor(f.col);
  const row = Math.floor(f.row);
  if (col < 0 || row < 0 || col >= mapSize || row >= mapSize) return null;
  return { col, row };
}

export function worldToScreen(wx: number, wy: number, camera: CameraState, viewport: ViewportSize): Point2D {
  return {
    x: (wx - camera.x) * camera.zoom + viewport.width / 2,
    y: (wy - camera.y) * camera.zoom + viewport.height / 2,
  };
}

export function screenToWorld(sx: number, sy: number, camera: CameraState, viewport: ViewportSize): Point2D {
  return {
    x: (sx - viewport.width / 2) / camera.zoom + camera.x,
    y: (sy - viewport.height / 2) / camera.zoom + camera.y,
  };
}

export function screenToTile(
  sx: number,
  sy: number,
  camera: CameraState,
  viewport: ViewportSize,
  tileW: number,
  tileH: number,
  mapSize: number,
): TileCoord | null {
  const w = screenToWorld(sx, sy, camera, viewport);
  return worldToTile(w.x, w.y, tileW, tileH, mapSize);
}

export function mapWorldBounds(mapSize: number, tileW: number, tileH: number): MapWorldBounds {
  const halfSpanX = mapSize * (tileW / 2);
  const maxY = mapSize * tileH;
  return {
    minX: -halfSpanX,
    maxX: halfSpanX,
    minY: 0,
    maxY,
    width: halfSpanX * 2,
    height: maxY,
    centerX: 0,
    centerY: maxY / 2,
  };
}

/* World-space diamond covering [col, col + spanCol) x [row, row + spanRow). */
export function footprintToWorldDiamond(
  col: number,
  row: number,
  spanCol: number,
  spanRow: number,
  tileW: number,
  tileH: number,
): FootprintDiamond {
  const top = tileTopVertexToWorld(col, row, tileW, tileH);
  const right = tileTopVertexToWorld(col + spanCol, row, tileW, tileH);
  const bottom = tileTopVertexToWorld(col + spanCol, row + spanRow, tileW, tileH);
  const left = tileTopVertexToWorld(col, row + spanRow, tileW, tileH);
  const minX = left.x;
  const maxX = right.x;
  const minY = top.y;
  const maxY = bottom.y;
  return {
    corners: [top, right, bottom, left],
    bounds: { minX, maxX, minY, maxY },
    width: maxX - minX,
    height: maxY - minY,
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
  };
}

function hitTestsObject(wx: number, wy: number, obj: PickableObject, tileW: number, tileH: number): boolean {
  const f = worldToTileFloat(wx, wy, tileW, tileH);
  if (f.col >= obj.col && f.col < obj.col + obj.spanCol && f.row >= obj.row && f.row < obj.row + obj.spanRow) {
    return true;
  }
  const heightWorld = obj.heightWorld ?? 0;
  if (heightWorld <= 0) return false;
  const fp = footprintToWorldDiamond(obj.col, obj.row, obj.spanCol, obj.spanRow, tileW, tileH);
  const halfW = fp.width * 0.42;
  const baseY = fp.bounds.maxY;
  return wx >= fp.center.x - halfW && wx <= fp.center.x + halfW && wy >= fp.bounds.minY - heightWorld && wy <= baseY;
}

function objectPainterDepth(obj: PickableObject): number {
  return (obj.col + obj.spanCol - 1) + (obj.row + obj.spanRow - 1);
}

/* Picks the frontmost clickable object at (wx, wy) in reverse isometric depth order, falling back to the tile under (wx, wy). */
export function pickAtWorld(
  wx: number,
  wy: number,
  objects: readonly PickableObject[],
  tileW: number,
  tileH: number,
  mapSize: number,
): PickResult | null {
  if (objects.length > 0) {
    const ordered = [...objects].sort((a, b) => objectPainterDepth(b) - objectPainterDepth(a));
    for (const obj of ordered) {
      if (hitTestsObject(wx, wy, obj, tileW, tileH)) {
        return { kind: 'object', object: obj, col: obj.col, row: obj.row };
      }
    }
  }
  const tile = worldToTile(wx, wy, tileW, tileH, mapSize);
  return tile ? { kind: 'tile', col: tile.col, row: tile.row } : null;
}

export function pickAtScreen(
  sx: number,
  sy: number,
  camera: CameraState,
  viewport: ViewportSize,
  objects: readonly PickableObject[],
  tileW: number,
  tileH: number,
  mapSize: number,
): PickResult | null {
  const w = screenToWorld(sx, sy, camera, viewport);
  return pickAtWorld(w.x, w.y, objects, tileW, tileH, mapSize);
}
