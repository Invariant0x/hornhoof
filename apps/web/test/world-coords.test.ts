import { describe, expect, it } from 'vitest';
import {
  footprintToWorldDiamond,
  mapWorldBounds,
  pickAtScreen,
  pickAtWorld,
  screenToTile,
  screenToWorld,
  tileCenterToWorld,
  tileDiamondVertices,
  tileTopVertexToWorld,
  worldToScreen,
  worldToTile,
  worldToTileFloat,
  type PickableObject,
} from '../src/world/coords';
import type { CameraState, ViewportSize } from '../src/world/camera';

const TILE_W = 60;
const TILE_H = 30;
const MAP_SIZE = 150;
const DESKTOP: ViewportSize = { width: 1440, height: 900 };

describe('2:1 diamond isometric coordinate conversion', () => {
  it('computes exact world bounds for a 150x150 2:1 diamond map', () => {
    const bounds = mapWorldBounds(MAP_SIZE, TILE_W, TILE_H);
    expect(bounds).toEqual({
      minX: -4500,
      maxX: 4500,
      minY: 0,
      maxY: 4500,
      width: 9000,
      height: 4500,
      centerX: 0,
      centerY: 2250,
    });
  });

  it('round-trips tileCenterToWorld <-> worldToTile across corners, center and interior diamond points', () => {
    const samples: [number, number][] = [
      [0, 0],
      [1, 0],
      [0, 1],
      [75, 75],
      [149, 0],
      [0, 149],
      [149, 149],
      [42, 117],
      [128, 19],
    ];
    for (const [col, row] of samples) {
      const center = tileCenterToWorld(col, row, TILE_W, TILE_H);
      expect(worldToTile(center.x, center.y, TILE_W, TILE_H, MAP_SIZE)).toEqual({ col, row });

      /* Test 9 interior offsets inside the diamond using barycentric (u, v) in (0, 1)^2. */
      const top = tileTopVertexToWorld(col, row, TILE_W, TILE_H);
      for (const u of [0.1, 0.5, 0.9]) {
        for (const v of [0.1, 0.5, 0.9]) {
          const wx = top.x + (u - v) * (TILE_W / 2);
          const wy = top.y + (u + v) * (TILE_H / 2);
          const fractional = worldToTileFloat(wx, wy, TILE_W, TILE_H);
          expect(fractional.col).toBeCloseTo(col + u, 8);
          expect(fractional.row).toBeCloseTo(row + v, 8);
          expect(worldToTile(wx, wy, TILE_W, TILE_H, MAP_SIZE)).toEqual({ col, row });
        }
      }
    }
  });

  it('produces exact 2:1 diamond vertices around each tile center', () => {
    const verts = tileDiamondVertices(10, 4, TILE_W, TILE_H);
    const center = tileCenterToWorld(10, 4, TILE_W, TILE_H);
    expect(verts).toEqual([
      { x: center.x, y: center.y - TILE_H / 2 },
      { x: center.x + TILE_W / 2, y: center.y },
      { x: center.x, y: center.y + TILE_H / 2 },
      { x: center.x - TILE_W / 2, y: center.y },
    ]);
  });

  it('returns null for coordinates outside [0, mapSize)', () => {
    const outside: [number, number][] = [
      [-1, 0],
      [0, -1],
      [MAP_SIZE, 0],
      [0, MAP_SIZE],
      [MAP_SIZE, MAP_SIZE],
      [-10, -10],
    ];
    for (const [col, row] of outside) {
      const pt = tileCenterToWorld(col, row, TILE_W, TILE_H);
      expect(worldToTile(pt.x, pt.y, TILE_W, TILE_H, MAP_SIZE)).toBeNull();
    }
  });

  it('round-trips world <-> screen and screenToTile at bird-eye, 1x, 2x and 4x zooms', () => {
    const cameras: CameraState[] = [
      { x: 0, y: 2250, zoom: 0.14 },
      { x: 320, y: 1800, zoom: 1 },
      { x: -1200, y: 3100, zoom: 2 },
      { x: 900, y: 1200, zoom: 4 },
    ];
    const viewports: ViewportSize[] = [DESKTOP, { width: 375, height: 812 }];

    for (const viewport of viewports) {
      for (const cam of cameras) {
        const testTiles: [number, number][] = [[0, 0], [74, 74], [149, 149], [30, 110]];
        for (const [col, row] of testTiles) {
          const w = tileCenterToWorld(col, row, TILE_W, TILE_H);
          const s = worldToScreen(w.x, w.y, cam, viewport);
          const back = screenToWorld(s.x, s.y, cam, viewport);
          expect(back.x).toBeCloseTo(w.x, 6);
          expect(back.y).toBeCloseTo(w.y, 6);
          expect(screenToTile(s.x, s.y, cam, viewport, TILE_W, TILE_H, MAP_SIZE)).toEqual({ col, row });
        }
      }
    }
  });

  it('computes exact multi-tile footprints from 1x1 up to 6x6', () => {
    const fp1 = footprintToWorldDiamond(10, 20, 1, 1, TILE_W, TILE_H);
    expect(fp1.width).toBe(TILE_W);
    expect(fp1.height).toBe(TILE_H);

    const fp6 = footprintToWorldDiamond(10, 20, 6, 6, TILE_W, TILE_H);
    expect(fp6.width).toBe(6 * TILE_W);
    expect(fp6.height).toBe(6 * TILE_H);
    expect(fp6.corners[0]).toEqual(tileTopVertexToWorld(10, 20, TILE_W, TILE_H));
    expect(fp6.corners[2]).toEqual(tileTopVertexToWorld(16, 26, TILE_W, TILE_H));
  });
});

describe('click picking for objects and tiles', () => {
  const objects: PickableObject[] = [
    { id: 'back-hall', kind: 'building', col: 50, row: 50, spanCol: 3, spanRow: 3, heightWorld: 140 },
    { id: 'front-house', kind: 'building', col: 52, row: 52, spanCol: 2, spanRow: 2, heightWorld: 90 },
    { id: 'unit-1', kind: 'unit', col: 40, row: 40, spanCol: 1, spanRow: 1, heightWorld: 34 },
  ];

  it('picks an object when clicking its ground footprint or elevated body', () => {
    const groundPt = tileCenterToWorld(51, 51, TILE_W, TILE_H);
    const groundHit = pickAtWorld(groundPt.x, groundPt.y, objects, TILE_W, TILE_H, MAP_SIZE);
    expect(groundHit).toMatchObject({ kind: 'object', object: { id: 'back-hall' } });

    const unitFoot = tileCenterToWorld(40, 40, TILE_W, TILE_H);
    const unitHeadHit = pickAtWorld(unitFoot.x, unitFoot.y - 24, objects, TILE_W, TILE_H, MAP_SIZE);
    expect(unitHeadHit).toMatchObject({ kind: 'object', object: { id: 'unit-1' } });
  });

  it('picks the frontmost depth-sorted object when elevated silhouettes overlap', () => {
    /* front-house at (52..53, 52..53) stands in front of back-hall at (50..52, 50..52). */
    const overlapPt = tileCenterToWorld(52, 52, TILE_W, TILE_H);
    const hit = pickAtWorld(overlapPt.x, overlapPt.y - 20, objects, TILE_W, TILE_H, MAP_SIZE);
    expect(hit).toMatchObject({ kind: 'object', object: { id: 'front-house' } });
  });

  it('falls back to tile hit on empty ground and null outside the map', () => {
    const cam: CameraState = { x: 0, y: 2250, zoom: 2 };
    const emptyPt = tileCenterToWorld(10, 10, TILE_W, TILE_H);
    const screenPt = worldToScreen(emptyPt.x, emptyPt.y, cam, DESKTOP);
    expect(pickAtScreen(screenPt.x, screenPt.y, cam, DESKTOP, objects, TILE_W, TILE_H, MAP_SIZE)).toEqual({
      kind: 'tile',
      col: 10,
      row: 10,
    });

    const outPt = tileCenterToWorld(-5, 10, TILE_W, TILE_H);
    expect(pickAtWorld(outPt.x, outPt.y, objects, TILE_W, TILE_H, MAP_SIZE)).toBeNull();
  });
});
