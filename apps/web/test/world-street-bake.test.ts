/* City streets baked into the ground (#1985): every street of one tier is one strip with one soft edge, so a crossing,
   a T and a bend show a single edge and no light edge line runs across a street, instead of strips laid over each
   other. The street's look stays the pack's strip art. */
import { afterEach, describe, expect, it } from 'vitest';
import type { RoadTier } from '../src/world/city-layout';
import { buildChunkGrid } from '../src/world/chunks';
import { tileTopVertexToWorld } from '../src/world/coords';
import { DEFAULT_ISOMETRIC_PROJECTION } from '../src/world/manifest';
import { bakeSmoothChunkPixels } from '../src/world/smooth-terrain-baker';
import { streetField, type StreetTile } from '../src/world/street-field';
import { registerTerrainArt, type ArtPixels } from '../src/world/terrain-art';
import { generateWorldTerrain } from '../src/world/terrain-engine';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

const TPT = 64;
/* Light rows along each edge of the strip, as painted streets have: the edge an overlap used to double. */
const EDGE_ROWS = 10;
const CORE = 70;
const LIGHT = 230;

/* A strip as wide as a street of `width` tiles: alpha fading to 0 on its first and last rows, a light edge, a dark core. */
function strip(width: number, rgb: readonly [number, number, number] = [CORE, CORE, CORE]): ArtPixels {
  const w = 4 * TPT;
  const h = Math.round(width * TPT);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const fromEdge = Math.min(y, h - 1 - y);
    const alpha = Math.min(255, Math.round((fromEdge / 4) * 255));
    const light = fromEdge < EDGE_ROWS;
    for (let x = 0; x < w; x++) data.set([light ? LIGHT : rgb[0], light ? LIGHT : rgb[1], light ? LIGHT : rgb[2], alpha], (y * w + x) * 4);
  }
  return { data, width: w, height: h };
}

const STRIPS: Readonly<Record<RoadTier, ArtPixels>> = { trail: strip(0.4), dirt: strip(0.8), brick: strip(1), stone: strip(1) };

const tiles = (tier: RoadTier, cells: ReadonlyArray<readonly [number, number]>): StreetTile[] => cells.map(([col, row]) => ({ col, row, tier }));
const ARM_U = [[3, 5], [4, 5], [5, 5], [6, 5], [7, 5]] as const;
const JOINS: Readonly<Record<string, ReadonlyArray<readonly [number, number]>>> = {
  straight: ARM_U,
  bend: [[3, 5], [4, 5], [5, 5], [5, 6], [5, 7]],
  T: [...ARM_U, [5, 6], [5, 7]],
  cross: [...ARM_U, [5, 3], [5, 4], [5, 6], [5, 7]],
};

/* One screen pixel at 200% along a tile axis, in tiles: a 240 x 120 px tile. */
const STEP = 1 / Math.hypot(120, 60);

type Sample = { alpha: number; lum: number };
function rayFromJoin(field: NonNullable<ReturnType<typeof streetField>>, angle: number): Sample[] {
  const out = [0, 0, 0, 0];
  const samples: Sample[] = [];
  for (let t = 0; t <= 1.6; t += STEP) {
    field.at(5.5 + Math.cos(angle) * t, 5.5 + Math.sin(angle) * t, out);
    samples.push({ alpha: out[3]!, lum: (out[0]! + out[1]! + out[2]!) / 3 });
  }
  return samples;
}

/* How many separate runs of light edge a ray crosses where the street is mostly opaque. */
function lightRuns(samples: readonly Sample[]): number {
  let runs = 0;
  let inside = false;
  for (const s of samples) {
    const light = s.alpha > 0.5 && s.lum > (CORE + LIGHT) / 2;
    if (light && !inside) runs++;
    inside = light;
  }
  return runs;
}

describe('a street baked into the ground', () => {
  for (const tier of ['trail', 'dirt', 'stone'] as const) {
    for (const [join, cells] of Object.entries(JOINS)) {
      it(`shows one soft edge at a ${join} of ${tier} streets, at 200%`, () => {
        const field = streetField(tiles(tier, cells), STRIPS, TPT)!;
        expect(field).not.toBeNull();
        for (let i = 0; i < 96; i++) {
          const angle = (i / 96) * Math.PI * 2;
          const ray = rayFromJoin(field, angle);
          expect(ray[0]!.alpha, `${join} centre`).toBeGreaterThan(0.99);
          expect(ray[0]!.lum, `${join} centre is the core`).toBeLessThan((CORE + LIGHT) / 2);
          /* Out from the join the street only fades: it never shows again after its edge. */
          for (let k = 1; k < ray.length; k++) expect(ray[k]!.alpha, `${join} ${angle.toFixed(2)} at ${k}`).toBeLessThanOrEqual(ray[k - 1]!.alpha + 0.02);
          expect(lightRuns(ray), `${join} ${angle.toFixed(2)}`).toBeLessThanOrEqual(1);
        }
      });
    }
  }

  it('runs one tier into another without a second edge where they meet, the higher over the lower', () => {
    const cells = [...tiles('stone', ARM_U), ...tiles('dirt', [[5, 6], [5, 7], [5, 8]])];
    const field = streetField(cells, STRIPS, TPT)!;
    for (let i = 0; i < 96; i++) expect(lightRuns(rayFromJoin(field, (i / 96) * Math.PI * 2))).toBeLessThanOrEqual(1);
    const out = [0, 0, 0, 0];
    field.at(5.5, 5.5, out);
    expect(out[3]).toBeGreaterThan(0.99);
  });

  it('lies only where streets are, and a lone street tile is a patch of its own', () => {
    const field = streetField(tiles('dirt', [[10, 10]]), STRIPS, TPT)!;
    const out = [0, 0, 0, 0];
    field.at(10.5, 10.5, out);
    expect(out[3]).toBeGreaterThan(0.99);
    field.at(12.5, 10.5, out);
    expect(out[3]).toBe(0);
    expect(streetField([], STRIPS, TPT)).toBeNull();
  });

  it('keeps the strip running along a straight street, so a street shows no seam from tile to tile', () => {
    const striped: ArtPixels = (() => {
      const base = strip(0.8);
      const data = new Uint8ClampedArray(base.data);
      for (let y = 0; y < base.height; y++) for (let x = 0; x < base.width; x++) data[(y * base.width + x) * 4] = x % 256;
      return { ...base, data };
    })();
    const field = streetField(tiles('dirt', ARM_U), { ...STRIPS, dirt: striped }, TPT)!;
    const out = [0, 0, 0, 0];
    const reds: number[] = [];
    for (let u = 3.5; u < 7.5; u += 1 / TPT) {
      field.at(u, 5.5, out);
      reds.push(out[0]!);
    }
    /* Strip columns go up one by one along u, wrapping every 4 tiles, with no jump at a tile's edge. */
    for (let k = 1; k < reds.length; k++) {
      const step = (reds[k]! - reds[k - 1]! + 256) % 256;
      expect(step, `at ${k}`).toBeLessThanOrEqual(2);
    }
  });
});

describe("a chunk's baked ground", () => {
  afterEach(() => registerTerrainArt(EGYPT_WORLD_PACK, null));

  it("carries the city's streets in the pack's strips, and none where the city has no street", () => {
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: 'hornhoof', mapSize: EGYPT_WORLD_PACK.mapSize });
    const red = strip(0.8, [250, 20, 20]);
    const flat: ArtPixels = { data: new Uint8ClampedArray(16 * 16 * 4).fill(200), width: 16, height: 16 };
    const ids = EGYPT_WORLD_PACK.terrainRecipe!.materialIds;
    registerTerrainArt(EGYPT_WORLD_PACK, {
      ground: new Map(ids.map(id => [id, flat] as const)),
      texelsPerTile: TPT,
      edges: new Map(),
      defaultEdge: null,
      shoreEdge: null,
      liquid: null,
      pathStrip: null,
      roads: { trail: red, dirt: red, brick: red, stone: red },
      plants: new Map(),
    });
    const { col, row } = map.startCenter;
    const street = tiles('dirt', [[col - 1, row], [col, row], [col + 1, row]]);
    const { defaultTileW: W, defaultTileH: H } = DEFAULT_ISOMETRIC_PROJECTION;
    const grid = buildChunkGrid(EGYPT_WORLD_PACK.mapSize, EGYPT_WORLD_PACK.params.chunkSize, W, H);
    const chunk = grid.chunks.find(c => col >= c.colStart && col < c.colEnd && row >= c.rowStart && row < c.rowEnd)!;
    const lod = DEFAULT_ISOMETRIC_PROJECTION.lods.find(l => l.id === '2x')!;
    const pixelAt = (rgba: Uint8ClampedArray, width: number, worldX: number, worldY: number, scale: number, u: number, v: number) => {
      const w = tileTopVertexToWorld(u, v, W, H);
      const o = (Math.floor((w.y - worldY) * scale) * width + Math.floor((w.x - worldX) * scale)) * 4;
      return [rgba[o]!, rgba[o + 1]!, rgba[o + 2]!];
    };
    const withStreets = bakeSmoothChunkPixels(chunk, map, EGYPT_WORLD_PACK, lod, null, { lots: [], edge: 0, streets: street });
    const without = bakeSmoothChunkPixels(chunk, map, EGYPT_WORLD_PACK, lod, null, { lots: [], edge: 0 });
    const on = pixelAt(withStreets.rgba, withStreets.pixelWidth, withStreets.worldX, withStreets.worldY, withStreets.scale, col + 0.5, row + 0.5);
    const off = pixelAt(without.rgba, without.pixelWidth, without.worldX, without.worldY, without.scale, col + 0.5, row + 0.5);
    expect(on[0]! - on[1]!, `street pixel ${on.join(',')}`).toBeGreaterThan(120);
    expect(Math.abs(off[0]! - off[1]!), `bare ground ${off.join(',')}`).toBeLessThan(60);
    const beside = pixelAt(withStreets.rgba, withStreets.pixelWidth, withStreets.worldX, withStreets.worldY, withStreets.scale, col + 0.5, row + 2.5);
    expect(Math.abs(beside[0]! - beside[1]!), `beside the street ${beside.join(',')}`).toBeLessThan(60);
  });
});
