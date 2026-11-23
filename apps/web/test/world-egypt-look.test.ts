/* The Egypt map's look as the design check asked for it (#1914): narrow painted soil edges, no bare stretch of ground,
   palms in groups, an unbroken strip of plants along the water, water that darkens toward the middle, and plants that
   are mirrored in the water. Each check works on numbers, so it runs without a browser. */

import { describe, expect, it } from 'vitest';
import { worldToTileFloat } from '../src/world/coords';
import { buildChunkGrid } from '../src/world/chunks';
import { DEFAULT_ISOMETRIC_PROJECTION } from '../src/world/manifest';
import { createDrawList, ITEM_STRIDE, PlantLayout } from '../src/world/plant-layer';
import type { PlantSpriteInfo } from '../src/world/plant-sprites';
import { generatePlants } from '../src/world/plants';
import {
  bakeSmoothChunkPixels,
  displayedWaterDistance,
  groundMixAt,
  sampleCornerFieldBilinear,
  tilledPlotAt,
  waterDistanceAt,
  waterlineShareAt,
} from '../src/world/smooth-terrain-baker';
import { registerTerrainArt, type ArtPixels, type LoadedTerrainArt } from '../src/world/terrain-art';
import { GALLERY_SEEDS, generateWorldTerrain, type GeneratedWorldMap } from '../src/world/terrain-engine';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

const SEEDS = GALLERY_SEEDS.slice(0, 6);
const TILE_W = DEFAULT_ISOMETRIC_PROJECTION.defaultTileW;
const TILE_H = DEFAULT_ISOMETRIC_PROJECTION.defaultTileH;
/* Screen pixels at 100% zoom for one tile step along a tile axis. */
const PX_PER_TILE_STEP = Math.hypot(TILE_W / 2, TILE_H / 2);

const maps = new Map<string, GeneratedWorldMap>();
function mapFor(seed: string): GeneratedWorldMap {
  let map = maps.get(seed);
  if (!map) {
    map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed, mapSize: EGYPT_WORLD_PACK.mapSize });
    maps.set(seed, map);
  }
  return map;
}

/* Open ground: dry land that is not a tilled field plot or bare rock, which are drawn ground of their own. */
function isOpenGround(map: GeneratedWorldMap, u: number, v: number): boolean {
  const tile = map.tileAt(Math.floor(u), Math.floor(v));
  if (tile === null || tile === 'ridge' || map.kindById.get(tile)?.liquid) return false;
  if (displayedWaterDistance(map.cornerFields, u, v) <= 0.1) return false;
  if (tilledPlotAt(map, EGYPT_WORLD_PACK, u, v)) return false;
  const ids = map.cornerFields.materialIds;
  const w = sampleCornerFieldBilinear(map.cornerFields, u, v).weights;
  return (w[ids.indexOf('rock')] ?? 0) < 0.45;
}

/* Painted edge masks as an artist delivers them: a ragged line between the two grounds, antialiased over a few rows.
   With them registered the baker paints its edges; the real pictures are not in the repository. */
function paintedEdgeArt(): LoadedTerrainArt {
  const w = 64;
  const h = 256;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const line = h / 2 + 14 * Math.sin((x / w) * Math.PI * 6) + 6 * Math.sin((x / w) * Math.PI * 14);
      const value = Math.max(0, Math.min(255, (line - y) * 64 + 128));
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  const mask = { data, width: w, height: h };
  return { ground: new Map(), texelsPerTile: 256, edges: new Map(), defaultEdge: mask, shoreEdge: null, liquid: null, pathStrip: null, plants: new Map() };
}

describe('Egypt map look from the design check', () => {
  it('paints soil edges narrow: two soils share a pixel over at most 12 px at 100%', () => {
    registerTerrainArt(EGYPT_WORLD_PACK, paintedEdgeArt());
    try {
      expectNarrowEdges();
    } finally {
      registerTerrainArt(EGYPT_WORLD_PACK, null);
    }
  });

  function expectNarrowEdges(): void {
    const map = mapFor('hornhoof');
    const step = 0.5 / PX_PER_TILE_STEP;
    const dirs = [
      [1, 0],
      [0, 1],
      [Math.SQRT1_2, Math.SQRT1_2],
      [Math.SQRT1_2, -Math.SQRT1_2],
    ] as const;
    const mixAt = (u: number, v: number) => groundMixAt(map, EGYPT_WORLD_PACK, u, v);
    let edgesSeen = 0;
    let widest = 0;
    /* Scan lines across the map; where the ground in front changes, an edge is crossed. Walk out of the mixed pixels
       there in four directions and keep the shortest run, which is the edge's width measured square to it. */
    for (let r = 10.37; r < 140 && edgesSeen < 200; r += 3.1) {
      let prev = mixAt(8, r).a;
      for (let c = 8; c < 142; c += 0.05) {
        const here = mixAt(c, r);
        if (here.a === prev) continue;
        prev = here.a;
        if (displayedWaterDistance(map.cornerFields, c, r) < 0.6) continue;
        let shortest = Infinity;
        for (const [du, dv] of dirs) {
          let run = 0;
          for (const sgn of [1, -1]) {
            for (let i = 1; i < 400; i++) {
              const m = mixAt(c + du * step * i * sgn, r + dv * step * i * sgn);
              if (m.shareA > 0.9) break;
              run++;
            }
          }
          shortest = Math.min(shortest, (run + 1) * 0.5);
        }
        edgesSeen++;
        widest = Math.max(widest, shortest);
      }
    }
    expect(edgesSeen).toBeGreaterThan(20);
    expect(widest).toBeLessThanOrEqual(12);
  }

  it('leaves no bare 300 x 300 px stretch of open ground at 100% on any of six seeds', () => {
    for (const seed of SEEDS) {
      const map = mapFor(seed);
      const plants = generatePlants(EGYPT_WORLD_PACK, map).plants;
      const cell = 150;
      const grid = new Map<string, number>();
      for (const p of plants) {
        const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
        grid.set(key, (grid.get(key) ?? 0) + 1);
      }
      const n = EGYPT_WORLD_PACK.mapSize;
      const bare: string[] = [];
      let windows = 0;
      for (let y = 0; y + 300 <= n * TILE_H; y += cell) {
        for (let x = -n * (TILE_W / 2); x + 300 <= n * (TILE_W / 2); x += cell) {
          let land = 0;
          let inside = true;
          for (let j = 0; j < 5 && inside; j++) {
            for (let i = 0; i < 5; i++) {
              const t = worldToTileFloat(x + 30 + i * 60, y + 30 + j * 60, TILE_W, TILE_H);
              if (t.col < 1 || t.row < 1 || t.col > n - 1 || t.row > n - 1) {
                inside = false;
                break;
              }
              if (isOpenGround(map, t.col, t.row)) land++;
            }
          }
          if (!inside || land < 18) continue;
          windows++;
          const count =
            (grid.get(`${x / cell},${y / cell}`) ?? 0) +
            (grid.get(`${x / cell + 1},${y / cell}`) ?? 0) +
            (grid.get(`${x / cell},${y / cell + 1}`) ?? 0) +
            (grid.get(`${x / cell + 1},${y / cell + 1}`) ?? 0);
          if (count === 0) bare.push(`${x},${y}`);
        }
      }
      expect(windows, seed).toBeGreaterThan(1000);
      expect(bare, `${seed}: bare windows`).toEqual([]);
    }
  });

  it('grows date palms in groups of three to seven', () => {
    for (const seed of SEEDS.slice(0, 3)) {
      const map = mapFor(seed);
      const field = generatePlants(EGYPT_WORLD_PACK, map);
      const palmIdx = EGYPT_WORLD_PACK.plants!.findIndex(k => k.id === 'date_palm');
      const palms = field.plants.filter(p => p.kindIndex === palmIdx);
      expect(palms.length, seed).toBeGreaterThan(150);
      /* Groups: palms closer than 2.2 tiles belong together. */
      const group = palms.map((_, i) => i);
      const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i]!)));
      for (let i = 0; i < palms.length; i++) {
        for (let j = i + 1; j < palms.length; j++) {
          if (Math.hypot(palms[i]!.col - palms[j]!.col, palms[i]!.row - palms[j]!.row) < 2.2) group[find(i)] = find(j);
        }
      }
      const sizes = new Map<number, number>();
      palms.forEach((_, i) => sizes.set(find(i), (sizes.get(find(i)) ?? 0) + 1));
      const inGroups = palms.filter((_, i) => {
        const s = sizes.get(find(i))!;
        return s >= 3 && s <= 9;
      }).length;
      expect(inGroups / palms.length, seed).toBeGreaterThan(0.7);
    }
  });

  it('keeps an unbroken strip of reeds and papyrus along the fertile shore', () => {
    for (const seed of SEEDS.slice(0, 3)) {
      const map = mapFor(seed);
      const field = generatePlants(EGYPT_WORLD_PACK, map);
      const kinds = EGYPT_WORLD_PACK.plants!;
      const shoreKinds = new Set(kinds.flatMap((k, i) => (k.waterDist.min < 1 && k.shape !== 'stone_cluster' ? [i] : [])));
      const near = field.plants.filter(p => shoreKinds.has(p.kindIndex));
      let points = 0;
      let covered = 0;
      for (let r = 3; r < 147; r += 0.5) {
        for (let c = 3; c < 147; c += 0.5) {
          const s = sampleCornerFieldBilinear(map.cornerFields, c, r);
          if (s.signedWaterDist < 0.45 || s.signedWaterDist > 0.7 || s.moisture < 0.6) continue;
          const tile = map.tileAt(Math.floor(c), Math.floor(r));
          if (tile !== 'bank' && tile !== 'fertile') continue;
          if (displayedWaterDistance(map.cornerFields, c, r) < 0.3) continue;
          points++;
          if (near.some(p => Math.abs(p.col - c) < 1.3 && Math.abs(p.row - r) < 1.3 && Math.hypot(p.col - c, p.row - r) < 1.3)) covered++;
        }
      }
      expect(points, seed).toBeGreaterThan(100);
      expect(covered / points, seed).toBeGreaterThan(0.85);
    }
  });

  it('darkens the water toward the middle of the river through the ground layer', () => {
    const map = mapFor('hornhoof');
    const grid = buildChunkGrid(150, 4, TILE_W, TILE_H);
    const lod1x = DEFAULT_ISOMETRIC_PROJECTION.lods.find(l => l.id === '1x')!;
    let deepAlpha = 0;
    let deepN = 0;
    let shallowAlpha = 0;
    let shallowN = 0;
    for (const ch of grid.chunks) {
      let river = 0;
      for (let r = ch.rowStart; r < ch.rowEnd; r++) for (let c = ch.colStart; c < ch.colEnd; c++) if (map.tileAt(c, r) === 'river') river++;
      if (river < 4) continue;
      const baked = bakeSmoothChunkPixels(ch, map, EGYPT_WORLD_PACK, lod1x);
      for (let py = 0; py < baked.pixelHeight; py += 3) {
        for (let px = 0; px < baked.pixelWidth; px += 3) {
          const t = worldToTileFloat(baked.worldX + (px + 0.5) / baked.scale, baked.worldY + (py + 0.5) / baked.scale, TILE_W, TILE_H);
          if (t.col < ch.colStart || t.col >= ch.colEnd || t.row < ch.rowStart || t.row >= ch.rowEnd) continue;
          const d = displayedWaterDistance(map.cornerFields, t.col, t.row);
          const a = baked.rgba[(py * baked.pixelWidth + px) * 4 + 3]!;
          if (d < -1.6) {
            deepAlpha += a;
            deepN++;
          } else if (d > -0.7 && d < -0.35) {
            shallowAlpha += a;
            shallowN++;
          }
        }
      }
      if (deepN > 400 && shallowN > 400) break;
    }
    expect(deepN).toBeGreaterThan(100);
    expect(shallowN).toBeGreaterThan(100);
    /* The middle carries a dark tint the liquid layer shows through; the shallows stay clearer. */
    expect(deepAlpha / deepN).toBeGreaterThan(70);
    expect(deepAlpha / deepN).toBeLessThan(200);
    expect(deepAlpha / deepN).toBeGreaterThan((shallowAlpha / shallowN) * 1.5);
  });

  it('mirrors the plants that stand by the water, and only those', () => {
    const map = mapFor('hornhoof');
    const field = generatePlants(EGYPT_WORLD_PACK, map);
    const kinds = EGYPT_WORLD_PACK.plants!;
    const info = (): PlantSpriteInfo => ({
      base: { frame: 0, pivotX: 10, pivotY: 40 },
      shadow: { frame: 1, pivotX: 4, pivotY: 13 },
      hubX: 0,
      hubY: 0,
      heightPx: 40,
      passport: { rootPoint: [10, 40], crownCenter: [10, 10], crownHub: [10, 10], heightPx: 40, crownWidthPx: 20 },
    });
    const sprites = kinds.map(k => Array.from({ length: k.variants }, info));
    const layout = new PlantLayout({ pack: EGYPT_WORLD_PACK, field, sprites, lighting: EGYPT_WORLD_PACK.lighting });
    const out = createDrawList();
    const reflections = createDrawList();
    const view = { minX: -9000, minY: 0, maxX: 9000, maxY: 9000 };
    layout.build(view, 2, out, reflections);
    const standing = field.plants.filter(p => !kinds[p.kindIndex]!.flat);
    const byWater = standing.filter(p => p.nearWater).length;
    expect(field.plants.filter(p => kinds[p.kindIndex]!.flat && p.nearWater)).toEqual([]);
    const dry = standing.filter(p => !p.nearWater).length;
    expect(byWater).toBeGreaterThan(100);
    expect(dry).toBeGreaterThan(100);
    expect(reflections.count).toBe(byWater);
    /* A reflection hangs below its root: its vertical scale is negative. */
    for (let i = 0; i < reflections.count; i++) expect(reflections.data[i * ITEM_STRIDE + 4]!).toBeLessThan(0);
  });

  /* Design's notes on the accepted map (#1934): the water distance the waterline and the depth tint follow has no
     kinks along the tiles, the drawn waterline does not jump where it crosses a tile border, and the painted water keeps
     darkening toward the middle of the river. */
  it('follows a water distance without kinks along the tile borders', () => {
    const map = mapFor('hornhoof');
    const cf = map.cornerFields;
    const h = 0.01;
    let points = 0;
    let worst = 0;
    let worstBilinear = 0;
    const bilinear = (u: number, v: number) => sampleCornerFieldBilinear(cf, u, v).signedWaterDist;
    for (let k = 20; k < 130; k++) {
      for (let t = 20; t < 130; t += 0.37) {
        for (const [u, v, du, dv] of [
          [k, t, 1, 0],
          [t, k, 0, 1],
        ] as const) {
          if (Math.abs(bilinear(u, v)) > 4) continue;
          points++;
          const slope = (f: (u: number, v: number) => number, s: number) => (f(u + du * h * s, v + dv * h * s) - f(u, v)) / h;
          worst = Math.max(worst, Math.abs(slope(waterDistanceAt.bind(null, cf), 1) + slope(waterDistanceAt.bind(null, cf), -1)));
          worstBilinear = Math.max(worstBilinear, Math.abs(slope(bilinear, 1) + slope(bilinear, -1)));
        }
      }
    }
    expect(points).toBeGreaterThan(500);
    /* The bilinear field bends at every tile border; the field the water is drawn from does not. */
    expect(worstBilinear).toBeGreaterThan(0.2);
    expect(worst).toBeLessThan(0.05);
  });

  it('draws the waterline without a step where it crosses a tile border', () => {
    const map = mapFor('hornhoof');
    const flat: ArtPixels = { data: new Uint8ClampedArray(64 * 64 * 4).fill(200), width: 64, height: 64 };
    /* A shore mask as an artist paints it: a ragged line, antialiased over a few rows. */
    const w = 256;
    const hgt = 256;
    const data = new Uint8ClampedArray(w * hgt * 4);
    for (let y = 0; y < hgt; y++) {
      for (let x = 0; x < w; x++) {
        const line = hgt / 2 + 24 * Math.sin((x / w) * Math.PI * 2) + 8 * Math.sin((x / w) * Math.PI * 6);
        const value = Math.max(0, Math.min(255, (line - y) * 64 + 128));
        data.fill(value, (y * w + x) * 4, (y * w + x) * 4 + 3);
        data[(y * w + x) * 4 + 3] = 255;
      }
    }
    const art: LoadedTerrainArt = {
      ground: new Map(map.cornerFields.materialIds.map(id => [id, flat] as const)),
      texelsPerTile: 256,
      edges: new Map(),
      defaultEdge: null,
      shoreEdge: { data, width: w, height: hgt },
      liquid: null,
      pathStrip: null,
      plants: new Map(),
    };
    registerTerrainArt(EGYPT_WORLD_PACK, art);
    try {
      const eps = 0.001;
      let points = 0;
      let worst = 0;
      for (let k = 10; k < 140; k++) {
        for (let t = 10; t < 140; t += 0.02) {
          for (const [u, v, du, dv] of [
            [k, t, 1, 0],
            [t, k, 0, 1],
          ] as const) {
            if (Math.abs(displayedWaterDistance(map.cornerFields, u, v)) > 0.2) continue;
            points++;
            const before = waterlineShareAt(map, EGYPT_WORLD_PACK, u - du * eps, v - dv * eps);
            const after = waterlineShareAt(map, EGYPT_WORLD_PACK, u + du * eps, v + dv * eps);
            worst = Math.max(worst, Math.abs(after - before));
          }
        }
      }
      expect(points).toBeGreaterThan(2000);
      /* The mask's rows blend over a few texels: two points 0.002 tile apart differ by a small part of the way, a step by all of it. */
      expect(worst).toBeLessThan(0.3);
    } finally {
      registerTerrainArt(EGYPT_WORLD_PACK, null);
    }
  });

  it('darkens painted water smoothly all the way to the middle of the river', () => {
    const map = mapFor('hornhoof');
    const tiny: ArtPixels = { data: new Uint8ClampedArray(4 * 4 * 4).fill(128), width: 4, height: 4 };
    registerTerrainArt(EGYPT_WORLD_PACK, {
      ground: new Map(),
      texelsPerTile: 256,
      edges: new Map(),
      defaultEdge: null,
      shoreEdge: null,
      liquid: { bed: tiny, ripples: tiny, surface: null, baseColor: '#68A1BA' },
      pathStrip: null,
      plants: new Map(),
    });
    try {
      const grid = buildChunkGrid(150, 4, TILE_W, TILE_H);
      const lod1x = DEFAULT_ISOMETRIC_PROJECTION.lods.find(l => l.id === '1x')!;
      /* Depth bins as [shallow end, deep end] of the water distance. */
      const bins = [
        [-0.6, -1.0],
        [-1.8, -2.2],
        [-3.0, -3.4],
      ] as const;
      const sum = bins.map(() => 0);
      const count = bins.map(() => 0);
      let steepest = 0;
      for (const ch of grid.chunks) {
        let river = 0;
        for (let r = ch.rowStart; r < ch.rowEnd; r++) for (let c = ch.colStart; c < ch.colEnd; c++) if (map.tileAt(c, r) === 'river') river++;
        if (river < 12) continue;
        const baked = bakeSmoothChunkPixels(ch, map, EGYPT_WORLD_PACK, lod1x);
        const depthAt = (px: number, py: number) => {
          const t = worldToTileFloat(baked.worldX + (px + 0.5) / baked.scale, baked.worldY + (py + 0.5) / baked.scale, TILE_W, TILE_H);
          if (t.col < ch.colStart || t.col >= ch.colEnd || t.row < ch.rowStart || t.row >= ch.rowEnd) return null;
          return displayedWaterDistance(map.cornerFields, t.col, t.row);
        };
        for (let py = 0; py < baked.pixelHeight; py += 2) {
          for (let px = 0; px < baked.pixelWidth - 1; px += 2) {
            const d = depthAt(px, py);
            if (d === null || d > -0.4) continue;
            const a = baked.rgba[(py * baked.pixelWidth + px) * 4 + 3]!;
            bins.forEach(([hi, lo], i) => {
              if (d <= hi && d > lo) {
                sum[i] += a;
                count[i]++;
              }
            });
            const d2 = depthAt(px + 1, py);
            if (d2 !== null && d2 < -0.4) steepest = Math.max(steepest, Math.abs(baked.rgba[(py * baked.pixelWidth + px + 1) * 4 + 3]! - a));
          }
        }
      }
      const mean = sum.map((s, i) => s / Math.max(1, count[i]!));
      for (const n of count) expect(n).toBeGreaterThan(200);
      /* Darker step by step toward the middle, and the middle carries a deep tint. */
      expect(mean[1]!).toBeGreaterThan(mean[0]! + 20);
      expect(mean[2]!).toBeGreaterThan(mean[1]! + 20);
      expect(mean[2]!).toBeGreaterThan(160);
      /* No hard band: neighbouring water pixels never differ by more than a few levels of tint. */
      expect(steepest).toBeLessThanOrEqual(6);
    } finally {
      registerTerrainArt(EGYPT_WORLD_PACK, null);
    }
  });
});
