import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildChunkGrid } from '../src/world/chunks';
import { worldToTileFloat } from '../src/world/coords';
import { DEFAULT_ISOMETRIC_PROJECTION, validateWorldPack } from '../src/world/manifest';
import {
  bakeSmoothChunkPixels,
  buildLiquidSurfacePixels,
  displayedWaterDistance,
  getMaterialTextureRgb,
  sampleCornerFieldBilinear,
  startSmoothChunkBake,
} from '../src/world/smooth-terrain-baker';
import {
  GALLERY_SEEDS,
  generateWorldTerrain,
  verifyTileContinuity,
} from '../src/world/terrain-engine';
import { registerTerrainArt, type ArtPixels, type LoadedTerrainArt } from '../src/world/terrain-art';
import { DUNGEON_WORLD_PACK } from '../src/world-packs/dungeon/pack';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

const WORLD_CORE_DIR = join(import.meta.dirname, '..', 'src', 'world');
const EXTRA_SEEDS = [
  'alpha-01', 'bravo-02', 'charlie-03', 'delta-04', 'echo-05',
  'foxtrot-06', 'golf-07', 'hotel-08', 'india-09', 'juliet-10',
  'kilo-11', 'lima-12', 'mike-13', 'november-14', 'oscar-15',
  'papa-16', 'quebec-17', 'romeo-18', 'sierra-19', 'tango-20',
];

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTsFiles(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe('Stage 2 pack-owned procedural generation and modularity', () => {
  it('validates both Egypt and Dungeon packs and keeps the engine core free of pack-specific recipes', () => {
    expect(validateWorldPack(EGYPT_WORLD_PACK)).toEqual({ ok: true });
    expect(validateWorldPack(DUNGEON_WORLD_PACK)).toEqual({ ok: true });
    expect(EGYPT_WORLD_PACK.terrainRecipe).toBeDefined();
    expect(DUNGEON_WORLD_PACK.terrainRecipe).toBeDefined();
    expect(EGYPT_WORLD_PACK.materials?.length).toBeGreaterThanOrEqual(6);
    expect(DUNGEON_WORLD_PACK.materials?.length).toBeGreaterThanOrEqual(5);
    expect(EGYPT_WORLD_PACK.showGridByDefault).toBe(false);
    expect(DUNGEON_WORLD_PACK.showGridByDefault).toBe(false);

    /* Engine core files in src/world/ must not hardcode Egypt or Dungeon biome recipes. */
    const coreFiles = walkTsFiles(WORLD_CORE_DIR).filter(f => !f.includes(`${join('src', 'world', 'demo')}`));
    for (const file of coreFiles) {
      const rel = relative(WORLD_CORE_DIR, file);
      const body = readFileSync(file, 'utf8');
      expect(/\b(egypt|nile|pharaoh|oasis|dungeon|lava|magma)\b/i.test(body), `pack leak in core ${rel}`).toBe(false);
    }
  });

  it('generates deterministic, distinct Egypt river-valley maps across 32 seeds with continuous rivers and riverside city centers', () => {
    const a1 = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: 'hornhoof', mapSize: 150 });
    const a2 = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: 'hornhoof', mapSize: 150 });
    const b = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: 'atlas-studio', mapSize: 150 });

    expect(a1.numericSeed).toBe(a2.numericSeed);
    expect(a1.startCenter).toEqual(a2.startCenter);
    expect(a1.tiles.every((v, i) => v === a2.tiles[i])).toBe(true);
    expect(a1.cornerFields.signedWaterDist.every((v, i) => v === a2.cornerFields.signedWaterDist[i])).toBe(true);

    let diffs = 0;
    for (let i = 0; i < a1.tiles.length; i++) if (a1.tiles[i] !== b.tiles[i]) diffs++;
    expect(diffs).toBeGreaterThan(a1.tiles.length * 0.25);

    const minRatio = EGYPT_WORLD_PACK.terrainRecipe!.minBuildableRatio;
    for (const seed of [...GALLERY_SEEDS, ...EXTRA_SEEDS]) {
      const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed, mapSize: 150 });
      const river = verifyTileContinuity(map, ['river']);
      expect(river.totalMatchingTiles, `${seed}: river tiles`).toBeGreaterThan(300);
      expect(river.continuous, `${seed}: river continuous`).toBe(true);
      expect(river.touchedEdges.length, `${seed}: river edges`).toBeGreaterThanOrEqual(2);

      expect(map.stats.buildableRatio, `${seed}: buildable share`).toBeGreaterThanOrEqual(minRatio);
      expect(map.isBuildable(map.startCenter.col, map.startCenter.row), `${seed}: start center buildable`).toBe(true);
      expect(map.stats.centerDistanceToLiquid, `${seed}: center near river`).toBeGreaterThanOrEqual(2);
      expect(map.stats.centerDistanceToLiquid, `${seed}: center near river`).toBeLessThanOrEqual(10);
      expect(map.stats.centerLocalBuildableRatio, `${seed}: flat neighborhood`).toBeGreaterThanOrEqual(0.75);
    }

    /* All 12 gallery seeds contain every expected Egypt terrain slot. */
    for (const seed of GALLERY_SEEDS) {
      const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed, mapSize: 150 });
      for (const id of ['river', 'bank', 'fertile', 'plain', 'dune', 'ridge', 'quarry', 'oasis_water', 'oasis_grove']) {
        expect(map.stats.counts[id] ?? 0, `${seed}: missing ${id}`).toBeGreaterThan(0);
      }
    }
  });

  /* Ivan's word, 23.11.2026: sown fields are a game object people work on, not landscape, so the map grows none. Where
     they stood, the fertile land's grass grows. */
  it('grows no sown fields on the Egypt map: no field tiles, no field ground and no tilled plots on any gallery seed', () => {
    expect(EGYPT_WORLD_PACK.terrainRecipe!.tileKinds.map(k => k.id)).not.toContain('field');
    expect(EGYPT_WORLD_PACK.materials.filter(m => m.id === 'field' || m.plots).map(m => m.id)).toEqual([]);
    for (const seed of GALLERY_SEEDS) {
      const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed, mapSize: 150 });
      expect(map.stats.counts.field ?? 0, `${seed}: field tiles`).toBe(0);
      expect(map.cornerFields.materialIds, `${seed}: field ground`).not.toContain('field');
    }
  });

  it('proves modularity with the Dungeon pack: bedrock, caverns, continuous magma stream and central carved hall across 12 seeds', () => {
    const a1 = generateWorldTerrain(DUNGEON_WORLD_PACK, { seed: 'hornhoof', mapSize: 150 });
    const a2 = generateWorldTerrain(DUNGEON_WORLD_PACK, { seed: 'hornhoof', mapSize: 150 });
    expect(a1.startCenter).toEqual(a2.startCenter);
    expect(a1.tiles.every((v, i) => v === a2.tiles[i])).toBe(true);

    const minOpen = DUNGEON_WORLD_PACK.terrainRecipe!.minBuildableRatio;
    for (const seed of GALLERY_SEEDS) {
      const map = generateWorldTerrain(DUNGEON_WORLD_PACK, { seed, mapSize: 150 });
      const lava = verifyTileContinuity(map, ['lava']);
      expect(lava.totalMatchingTiles, `${seed}: lava tiles`).toBeGreaterThan(200);
      expect(lava.continuous, `${seed}: lava continuous`).toBe(true);
      expect(lava.touchedEdges.length, `${seed}: lava reaches edges`).toBeGreaterThanOrEqual(2);

      /* Central starting hall is open, walkable and buildable, surrounded by excavatable rock & caverns. */
      expect(map.tileAt(map.startCenter.col, map.startCenter.row), `${seed}: start hall`).toBe('start_hall');
      expect(map.isBuildable(map.startCenter.col, map.startCenter.row)).toBe(true);
      expect(map.stats.buildableRatio, `${seed}: buildable+excavatable floor`).toBeGreaterThanOrEqual(minOpen);

      for (const id of ['solid_rock', 'rough_cavern', 'start_hall', 'lava', 'cooled_crust', 'fungal_grove', 'ore_vein']) {
        expect(map.stats.counts[id] ?? 0, `${seed}: dungeon missing ${id}`).toBeGreaterThan(0);
      }
    }
  });

  it('expands map edges without shifting a single discrete tile, smooth corner field value or start center for both packs', () => {
    for (const pack of [EGYPT_WORLD_PACK, DUNGEON_WORLD_PACK]) {
      const base = generateWorldTerrain(pack, { seed: 'hornhoof', mapSize: 150 });
      const expanded = generateWorldTerrain(pack, { seed: 'hornhoof', mapSize: 150, expandMargin: 25 });

      expect(expanded.width).toBe(200);
      expect(expanded.height).toBe(200);
      expect(expanded.startCenter).toEqual(base.startCenter);

      for (let r = 0; r < 150; r++) {
        for (let c = 0; c < 150; c++) {
          expect(expanded.tileAt(c, r), `${pack.id} tile (${c},${r})`).toBe(base.tileAt(c, r));
        }
      }

      /* Smooth corner fields on the (151 x 151) shared vertex lattice match identically. */
      for (let vr = 0; vr <= 150; vr += 5) {
        for (let vc = 0; vc <= 150; vc += 5) {
          const bSample = sampleCornerFieldBilinear(base.cornerFields, vc, vr);
          const eSample = sampleCornerFieldBilinear(expanded.cornerFields, vc, vr);
          expect(eSample.elevation).toBeCloseTo(bSample.elevation, 5);
          expect(eSample.moisture).toBeCloseTo(bSample.moisture, 5);
          expect(eSample.signedWaterDist).toBeCloseTo(bSample.signedWaterDist, 5);
        }
      }
    }
  });

  it('produces smooth corner fields, normalized blend masks and feathered non-staircased shoreline pixels when baking chunks', () => {
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: 'hornhoof', mapSize: 150 });
    const cf = map.cornerFields;
    expect(cf.cols).toBe(151);
    expect(cf.rows).toBe(151);
    expect(cf.elevation).toHaveLength(151 * 151);
    expect(cf.moisture).toHaveLength(151 * 151);
    expect(cf.signedWaterDist).toHaveLength(151 * 151);

    /* Sampled blend weights across the map stay in [0, 1] and sum to 1. */
    for (let r = 10; r < 140; r += 13) {
      for (let c = 10; c < 140; c += 13) {
        const s = sampleCornerFieldBilinear(cf, c + 0.37, r + 0.61);
        expect(Number.isFinite(s.elevation)).toBe(true);
        expect(Number.isFinite(s.moisture)).toBe(true);
        expect(Number.isFinite(s.signedWaterDist)).toBe(true);
        const weightSum = s.weights.reduce((acc, w) => acc + w, 0);
        expect(weightSum).toBeCloseTo(1, 3);
        for (const w of s.weights) {
          expect(w).toBeGreaterThanOrEqual(-1e-5);
          expect(w).toBeLessThanOrEqual(1 + 1e-5);
        }
      }
    }

    /* Locate a chunk straddling the hornhoof river shoreline and verify smooth alpha cutout + dry land + liquid pixels. */
    const grid = buildChunkGrid(150, 4, DEFAULT_ISOMETRIC_PROJECTION.defaultTileW, DEFAULT_ISOMETRIC_PROJECTION.defaultTileH);
    const shoreChunk = grid.chunks.find(ch => {
      let hasRiver = false;
      let hasLand = false;
      for (let r = ch.rowStart; r < ch.rowEnd; r++) {
        for (let c = ch.colStart; c < ch.colEnd; c++) {
          const id = map.tileAt(c, r);
          if (id === 'river') hasRiver = true;
          if (id === 'bank' || id === 'fertile') hasLand = true;
        }
      }
      return hasRiver && hasLand;
    });
    expect(shoreChunk).toBeDefined();

    const lod2x = DEFAULT_ISOMETRIC_PROJECTION.lods.find(l => l.id === '2x')!;
    const baked = bakeSmoothChunkPixels(shoreChunk!, map, EGYPT_WORLD_PACK, lod2x);
    expect(baked.pixelWidth).toBeGreaterThan(200);
    expect(baked.pixelHeight).toBeGreaterThan(100);

    let transparentLiquidPx = 0;
    let featheredShorePx = 0;
    let opaqueLandPx = 0;
    for (let i = 3; i < baked.rgba.length; i += 4) {
      const a = baked.rgba[i]!;
      if (a === 0) transparentLiquidPx++;
      else if (a === 255) opaqueLandPx++;
      else featheredShorePx++;
    }
    expect(transparentLiquidPx).toBeGreaterThan(200);
    expect(opaqueLandPx).toBeGreaterThan(200);
    /* Smooth shoreline mask produces anti-aliased feathered edge pixels rather than hard binary tile steps. */
    expect(featheredShorePx).toBeGreaterThan(50);
  });

  it('bakes a chunk a few rows per frame to exactly the pixels of one pass, so no frame bakes a whole chunk', () => {
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: 'hornhoof', mapSize: EGYPT_WORLD_PACK.mapSize });
    const grid = buildChunkGrid(150, 4, DEFAULT_ISOMETRIC_PROJECTION.defaultTileW, DEFAULT_ISOMETRIC_PROJECTION.defaultTileH);
    const chunk = grid.chunks[Math.floor(grid.chunks.length / 2) + 7]!;
    const lod2x = DEFAULT_ISOMETRIC_PROJECTION.lods.find(l => l.id === '2x')!;
    const whole = bakeSmoothChunkPixels(chunk, map, EGYPT_WORLD_PACK, lod2x);

    /* A clock that is always past the deadline: every frame gets exactly one slice of rows. */
    const job = startSmoothChunkBake(chunk, map, EGYPT_WORLD_PACK, lod2x);
    let frames = 0;
    while (!job.advance(0, () => 1)) frames++;
    frames++;
    expect(frames).toBeGreaterThan(10);
    expect(job.advance(0, () => 1)).toBe(true);
    expect({ ...job.pixels, rgba: null }).toEqual({ ...whole, rgba: null });
    expect(Buffer.from(job.pixels.rgba).equals(Buffer.from(whole.rgba))).toBe(true);

    /* With time left before the deadline, one call bakes the whole chunk. */
    const quick = startSmoothChunkBake(chunk, map, EGYPT_WORLD_PACK, lod2x);
    expect(quick.advance(Infinity, () => 0)).toBe(true);
    expect(Buffer.from(quick.pixels.rgba).equals(Buffer.from(whole.rgba))).toBe(true);
  });

  it('synthesizes strictly toroidal seamless ground and liquid textures with zero wrap seams', () => {
    /* A seamless texture's wrap pair (last column next to the first) differs like any other neighbouring pair. A seam
       would make it stand out above the largest difference between neighbouring columns (rows) inside the texture.
       The measure does not depend on the texture's resolution. */
    const measureWrapSeamRatio = (
      buf: Uint8ClampedArray,
      size: number,
      stride: 3 | 4,
    ): { horizRatio: number; vertRatio: number } => {
      const pairDiff = (a: number, b: number, along: 'col' | 'row'): number => {
        let sum = 0;
        for (let i = 0; i < size; i++) {
          const p = along === 'col' ? (i * size + a) * stride : (a * size + i) * stride;
          const q = along === 'col' ? (i * size + b) * stride : (b * size + i) * stride;
          for (let c = 0; c < 3; c++) sum += Math.abs(buf[p + c]! - buf[q + c]!);
        }
        return sum;
      };
      const ratio = (along: 'col' | 'row'): number => {
        let maxInterior = 1;
        for (let k = 0; k < size - 1; k++) maxInterior = Math.max(maxInterior, pairDiff(k, k + 1, along));
        return pairDiff(size - 1, 0, along) / maxInterior;
      };
      return { horizRatio: ratio('col'), vertRatio: ratio('row') };
    };

    for (const pack of [EGYPT_WORLD_PACK, DUNGEON_WORLD_PACK]) {
      for (const mat of pack.materials ?? []) {
        const rgb = getMaterialTextureRgb(mat);
        const size = Math.round(Math.sqrt(rgb.length / 3));
        const { horizRatio, vertRatio } = measureWrapSeamRatio(rgb, size, 3);
        expect(horizRatio, `${pack.id}/${mat.id} horizontal wrap seam`).toBeLessThan(1.15);
        expect(vertRatio, `${pack.id}/${mat.id} vertical wrap seam`).toBeLessThan(1.15);
      }
      if (pack.liquidLayer) {
        const rgba = buildLiquidSurfacePixels(pack.liquidLayer, 256);
        const { horizRatio, vertRatio } = measureWrapSeamRatio(rgba, 256, 4);
        expect(horizRatio, `${pack.id} liquid horizontal wrap seam`).toBeLessThan(1.15);
        expect(vertRatio, `${pack.id} liquid vertical wrap seam`).toBeLessThan(1.15);
      }
    }
  });
});

describe('painted art in the ground baker', () => {
  const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: 'hornhoof', mapSize: 150 });
  const grid = buildChunkGrid(150, 4, DEFAULT_ISOMETRIC_PROJECTION.defaultTileW, DEFAULT_ISOMETRIC_PROJECTION.defaultTileH);
  const lod2x = DEFAULT_ISOMETRIC_PROJECTION.lods.find(l => l.id === '2x')!;
  const shoreChunk = grid.chunks.find(ch => {
    const ids = new Set<string | null>();
    for (let r = ch.rowStart; r < ch.rowEnd; r++) for (let c = ch.colStart; c < ch.colEnd; c++) ids.add(map.tileAt(c, r));
    return ids.has('river') && (ids.has('bank') || ids.has('fertile'));
  })!;

  /* A flat seamless picture for every ground, as a painted set would bring. */
  const flat = (rgb: readonly [number, number, number]): ArtPixels => {
    const data = new Uint8ClampedArray(64 * 64 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([rgb[0], rgb[1], rgb[2], 255], i);
    return { data, width: 64, height: 64 };
  };
  const art = (ground: boolean): LoadedTerrainArt => ({
    ground: new Map(ground ? map.cornerFields.materialIds.map((id, i) => [id, flat([90 + i * 20, 140, 60 + i * 15])] as const) : []),
    texelsPerTile: 256,
    edges: new Map(),
    defaultEdge: null,
    shoreEdge: null,
    liquid: null,
    pathStrip: null,
    plants: new Map([['date_palm', []]]),
  });
  const same = (a: Uint8ClampedArray, b: Uint8ClampedArray) => Buffer.from(a).equals(Buffer.from(b));
  const procedural = () => {
    registerTerrainArt(EGYPT_WORLD_PACK, null);
    return bakeSmoothChunkPixels(shoreChunk, map, EGYPT_WORLD_PACK, lod2x).rgba;
  };

  it('draws with the art an engine pinned, so art that arrives later never mixes into its picture', () => {
    const before = procedural();
    registerTerrainArt(EGYPT_WORLD_PACK, art(true));
    try {
      expect(same(bakeSmoothChunkPixels(shoreChunk, map, EGYPT_WORLD_PACK, lod2x).rgba, before)).toBe(false);
      expect(same(bakeSmoothChunkPixels(shoreChunk, map, EGYPT_WORLD_PACK, lod2x, null).rgba, before)).toBe(true);
      const job = startSmoothChunkBake(shoreChunk, map, EGYPT_WORLD_PACK, lod2x, null);
      expect(job.advance(Infinity, () => 0)).toBe(true);
      expect(same(job.pixels.rgba, before)).toBe(true);
    } finally {
      registerTerrainArt(EGYPT_WORLD_PACK, null);
    }
  });

  it('keeps the procedural ground when the art brought only plants', () => {
    const before = procedural();
    registerTerrainArt(EGYPT_WORLD_PACK, art(false));
    try {
      expect(same(bakeSmoothChunkPixels(shoreChunk, map, EGYPT_WORLD_PACK, lod2x).rgba, before)).toBe(true);
    } finally {
      registerTerrainArt(EGYPT_WORLD_PACK, null);
    }
  });

  it('feathers the shore procedurally when painted ground has no shore mask', () => {
    registerTerrainArt(EGYPT_WORLD_PACK, art(true));
    try {
      const baked = bakeSmoothChunkPixels(shoreChunk, map, EGYPT_WORLD_PACK, lod2x);
      const { defaultTileW: tw, defaultTileH: th } = DEFAULT_ISOMETRIC_PROJECTION;
      /* Just inside the waterline the land fades into the water; well inland it is opaque. */
      let edgeAlpha = 0;
      let edgeN = 0;
      let inlandOpaque = 0;
      let inlandN = 0;
      for (let py = 0; py < baked.pixelHeight; py++) {
        for (let px = 0; px < baked.pixelWidth; px++) {
          const t = worldToTileFloat(baked.worldX + (px + 0.5) / baked.scale, baked.worldY + (py + 0.5) / baked.scale, tw, th);
          if (t.col < shoreChunk.colStart || t.col >= shoreChunk.colEnd || t.row < shoreChunk.rowStart || t.row >= shoreChunk.rowEnd) continue;
          const d = displayedWaterDistance(map.cornerFields, t.col, t.row);
          const a = baked.rgba[(py * baked.pixelWidth + px) * 4 + 3]!;
          if (d > -0.2 && d < -0.05) {
            edgeAlpha += a;
            edgeN++;
          } else if (d > 1) {
            inlandN++;
            if (a === 255) inlandOpaque++;
          }
        }
      }
      expect(edgeN).toBeGreaterThan(50);
      expect(edgeAlpha / edgeN).toBeLessThan(200);
      expect(inlandOpaque).toBe(inlandN);
    } finally {
      registerTerrainArt(EGYPT_WORLD_PACK, null);
    }
  });
});
