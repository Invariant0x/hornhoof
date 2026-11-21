import { describe, expect, it } from 'vitest';
import { validateWorldPack } from '../src/world/manifest';
import { TERRAIN_PREVIEW_PACK } from '../src/world/packs/terrain-preview-pack';
import {
  GALLERY_SEEDS,
  generateProceduralMap,
  MIN_BUILDABLE_RATIO,
  TERRAIN_KINDS,
  verifyRiverContinuity,
  type TerrainKind,
} from '../src/world/terrain';

const EXTRA_SEEDS = [
  'alpha-01',
  'bravo-02',
  'charlie-03',
  'delta-04',
  'echo-05',
  'foxtrot-06',
  'golf-07',
  'hotel-08',
  'india-09',
  'juliet-10',
  'kilo-11',
  'lima-12',
  'mike-13',
  'november-14',
  'oscar-15',
  'papa-16',
  'quebec-17',
  'romeo-18',
  'sierra-19',
  'tango-20',
];

describe('Stage 2 procedural map generator', () => {
  it('produces bit-for-bit identical maps for the same seed and distinct maps for different seeds', () => {
    const a1 = generateProceduralMap({ seed: 'hornhoof', mapSize: 150 });
    const a2 = generateProceduralMap({ seed: 'hornhoof', mapSize: 150 });
    const b = generateProceduralMap({ seed: 'atlas-studio', mapSize: 150 });

    expect(a1.numericSeed).toBe(a2.numericSeed);
    expect(a1.cityCenter).toEqual(a2.cityCenter);
    expect(a1.stats).toEqual(a2.stats);
    expect(a1.tiles.length).toBe(a2.tiles.length);
    expect(a1.tiles.every((v, idx) => v === a2.tiles[idx])).toBe(true);

    expect(a1.numericSeed).not.toBe(b.numericSeed);
    let diffCount = 0;
    for (let i = 0; i < a1.tiles.length; i++) {
      if (a1.tiles[i] !== b.tiles[i]) diffCount++;
    }
    expect(diffCount).toBeGreaterThan(a1.tiles.length * 0.25);
  });

  it('provides 12 distinct gallery seeds with continuous edge-to-edge rivers, buildable land >= threshold and riverside city center', () => {
    expect(GALLERY_SEEDS).toHaveLength(12);
    expect(new Set(GALLERY_SEEDS).size).toBe(12);

    const allSeeds = [...GALLERY_SEEDS, ...EXTRA_SEEDS];
    const seenCenters = new Set<string>();

    for (const seed of allSeeds) {
      const map = generateProceduralMap({ seed, mapSize: 150 });
      expect(map.width).toBe(150);
      expect(map.height).toBe(150);
      expect(map.tiles).toHaveLength(150 * 150);

      /* River is a single continuous component reaching at least 2 distinct map edges. */
      const riverCheck = verifyRiverContinuity(map);
      expect(riverCheck.totalRiverTiles, `${seed}: river tile count`).toBeGreaterThan(300);
      expect(riverCheck.continuous, `${seed}: river must be continuous`).toBe(true);
      expect(riverCheck.touchedEdges.length, `${seed}: river must reach at least 2 edges`).toBeGreaterThanOrEqual(2);
      expect(map.stats.riverIsContinuous).toBe(true);
      expect(map.stats.riverTouchesEdges.length).toBeGreaterThanOrEqual(2);

      /* Buildable land share meets or exceeds the configured floor. */
      expect(map.stats.buildableRatio, `${seed}: buildable share`).toBeGreaterThanOrEqual(MIN_BUILDABLE_RATIO);

      /* City center stands on flat buildable ground right beside the river, inside the central zone. */
      const { col, row } = map.cityCenter;
      expect(col, `${seed}: center col`).toBeGreaterThanOrEqual(25);
      expect(col, `${seed}: center col`).toBeLessThanOrEqual(124);
      expect(row, `${seed}: center row`).toBeGreaterThanOrEqual(25);
      expect(row, `${seed}: center row`).toBeLessThanOrEqual(124);

      const centerTerrain = map.tileAt(col, row);
      expect(['plain', 'fertile'], `${seed}: city center terrain`).toContain(centerTerrain);
      expect(map.isBuildable(col, row), `${seed}: city center buildable`).toBe(true);
      expect(map.stats.centerDistanceToRiver, `${seed}: city center near water`).toBeGreaterThanOrEqual(2);
      expect(map.stats.centerDistanceToRiver, `${seed}: city center near water`).toBeLessThanOrEqual(10);
      expect(map.stats.centerLocalBuildableRatio, `${seed}: flat neighborhood around center`).toBeGreaterThanOrEqual(0.75);

      seenCenters.add(`${col},${row}`);
    }

    expect(seenCenters.size).toBeGreaterThan(allSeeds.length * 0.7);
  });

  it('generates all natural biome features across the 12 gallery maps (river, bank, fertile, fields, ridges, quarries, dunes, springs/groves)', () => {
    const requiredAlways: TerrainKind[] = ['river', 'bank', 'fertile', 'field', 'plain', 'ridge', 'quarry', 'dune'];
    let mapsWithGroves = 0;

    for (const seed of GALLERY_SEEDS) {
      const map = generateProceduralMap({ seed, mapSize: 150 });
      for (const kind of requiredAlways) {
        expect(map.stats.counts[kind], `${seed}: missing ${kind}`).toBeGreaterThan(0);
      }
      if (map.stats.counts.spring > 0 && map.stats.counts.grove > 0) {
        mapsWithGroves++;
      }
    }

    expect(mapsWithGroves).toBe(GALLERY_SEEDS.length);
  });

  it('expands map edges from the same seed without shifting a single existing tile or the city center', () => {
    for (const seed of ['hornhoof', 'solar-labs', 'meridian-hq']) {
      const base = generateProceduralMap({ seed, mapSize: 150 });
      const expanded200 = generateProceduralMap({ seed, mapSize: 150, expandMargin: 25 });
      const expanded250 = generateProceduralMap({ seed, mapSize: 150, expandMargin: 50 });

      expect(expanded200.width).toBe(200);
      expect(expanded200.height).toBe(200);
      expect(expanded200.bounds).toEqual({ minCol: -25, maxCol: 175, minRow: -25, maxRow: 175 });
      expect(expanded200.cityCenter).toEqual(base.cityCenter);

      expect(expanded250.width).toBe(250);
      expect(expanded250.height).toBe(250);
      expect(expanded250.bounds).toEqual({ minCol: -50, maxCol: 200, minRow: -50, maxRow: 200 });
      expect(expanded250.cityCenter).toEqual(base.cityCenter);

      /* Every single tile inside the original 150x150 footprint matches identically after expansion. */
      for (let row = 0; row < 150; row++) {
        for (let col = 0; col < 150; col++) {
          const orig = base.tileAt(col, row);
          expect(expanded200.tileAt(col, row), `${seed} 200x200 mismatch at (${col},${row})`).toBe(orig);
          expect(expanded250.tileAt(col, row), `${seed} 250x250 mismatch at (${col},${row})`).toBe(orig);
        }
      }

      /* The expanded map also maintains river continuity to the new outer edges. */
      const expRiver = verifyRiverContinuity(expanded200);
      expect(expRiver.continuous, `${seed}: expanded river continuous`).toBe(true);
      expect(expRiver.touchedEdges.length, `${seed}: expanded river edges`).toBeGreaterThanOrEqual(2);
    }
  });

  it('declares a valid theme-neutral terrain preview pack covering every TerrainKind slot', () => {
    expect(validateWorldPack(TERRAIN_PREVIEW_PACK)).toEqual({ ok: true });
    expect(TERRAIN_PREVIEW_PACK.mapSize).toBe(150);
    const tileIds = new Set(TERRAIN_PREVIEW_PACK.tiles.map(t => t.id));
    for (const kind of TERRAIN_KINDS) {
      expect(tileIds.has(kind), `TERRAIN_PREVIEW_PACK missing slot for ${kind}`).toBe(true);
    }
  });
});
