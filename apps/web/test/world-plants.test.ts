import { describe, expect, it } from 'vitest';
import { validateWorldPack, type WorldPackManifest } from '../src/world/manifest';
import { generatePlants, parsePlantPassport, visiblePlants } from '../src/world/plants';
import { sampleCornerFieldBilinear } from '../src/world/smooth-terrain-baker';
import { GALLERY_SEEDS, generateWorldTerrain } from '../src/world/terrain-engine';
import { DUNGEON_WORLD_PACK } from '../src/world-packs/dungeon/pack';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

const SEEDS = GALLERY_SEEDS.slice(0, 6);
const NOT_GROUND = new Set(['river', 'oasis_water', 'ridge']);

function mapFor(seed: string, pack: WorldPackManifest = EGYPT_WORLD_PACK, expandMargin = 0) {
  return generateWorldTerrain(pack, { seed, mapSize: pack.mapSize, expandMargin });
}

describe('procedural plant placement', () => {
  it('gives the same plants for the same seed and different plants for another seed', () => {
    const a = generatePlants(EGYPT_WORLD_PACK, mapFor('hornhoof')).plants;
    const b = generatePlants(EGYPT_WORLD_PACK, mapFor('hornhoof')).plants;
    const c = generatePlants(EGYPT_WORLD_PACK, mapFor('acme-corp')).plants;
    expect(a.length).toBeGreaterThan(300);
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
  });

  it('never stands a plant in water or on bedrock, on any of six seeds', () => {
    for (const seed of SEEDS) {
      const map = mapFor(seed);
      const field = generatePlants(EGYPT_WORLD_PACK, map);
      expect(field.plants.length).toBeGreaterThan(300);
      const rockIdx = map.cornerFields.materialIds.indexOf('rock');
      for (const p of field.plants) {
        const tile = map.tileAt(Math.floor(p.col), Math.floor(p.row))!;
        expect(NOT_GROUND.has(tile), `${seed}: plant on ${tile} at ${p.col.toFixed(2)},${p.row.toFixed(2)}`).toBe(false);
        const s = sampleCornerFieldBilinear(map.cornerFields, p.col, p.row);
        expect(s.signedWaterDist, `${seed}: plant in water`).toBeGreaterThan(0);
        expect(s.weights[rockIdx]!, `${seed}: plant on bedrock`).toBeLessThan(0.3);
      }
    }
  });

  it('makes density follow the masks: reeds hug the water, groves keep to moist ground', () => {
    const map = mapFor('hornhoof');
    const field = generatePlants(EGYPT_WORLD_PACK, map);
    const kinds = EGYPT_WORLD_PACK.plants!;
    const meanMoisture = Array.from(map.cornerFields.moisture).reduce((s, v) => s + v, 0) / map.cornerFields.moisture.length;
    let checked = 0;
    for (const p of field.plants) {
      const kind = kinds[p.kindIndex]!;
      const s = sampleCornerFieldBilinear(map.cornerFields, p.col, p.row);
      expect(s.signedWaterDist).toBeGreaterThanOrEqual(kind.waterDist.min - 1e-6);
      expect(s.signedWaterDist).toBeLessThanOrEqual(kind.waterDist.max + 1e-6);
      expect(s.moisture).toBeGreaterThanOrEqual(kind.moisture.min - 1e-6);
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
    const moistAvg = field.plants.reduce((s, p) => s + sampleCornerFieldBilinear(map.cornerFields, p.col, p.row).moisture, 0) / field.plants.length;
    expect(moistAvg).toBeGreaterThan(meanMoisture * 1.6);
  });

  it('uses several kinds and keeps their placement inside each kind\'s allowed ground', () => {
    const map = mapFor('hornhoof');
    const field = generatePlants(EGYPT_WORLD_PACK, map);
    const kinds = EGYPT_WORLD_PACK.plants!;
    const used = new Set(field.plants.map(p => p.kindIndex));
    expect(used.size).toBeGreaterThanOrEqual(3);
    for (const p of field.plants) {
      const tile = map.tileAt(Math.floor(p.col), Math.floor(p.row))!;
      expect(kinds[p.kindIndex]!.tileKinds).toContain(tile);
      expect(p.heightPx).toBeGreaterThanOrEqual(kinds[p.kindIndex]!.heightPx.min * 0.8);
      expect(p.heightPx).toBeLessThanOrEqual(kinds[p.kindIndex]!.heightPx.max * 1.25);
    }
  });

  it('works for a pack with no plants and for the dungeon pack', () => {
    const bare: WorldPackManifest = { ...EGYPT_WORLD_PACK, plants: undefined };
    expect(generatePlants(bare, mapFor('hornhoof', bare)).plants).toEqual([]);
    expect(generatePlants({ ...EGYPT_WORLD_PACK, plants: [] }, mapFor('hornhoof')).plants).toEqual([]);
    expect(generatePlants(DUNGEON_WORLD_PACK, mapFor('hornhoof', DUNGEON_WORLD_PACK)).plants).toEqual([]);
    expect(validateWorldPack(bare)).toEqual({ ok: true });
    expect(validateWorldPack(DUNGEON_WORLD_PACK)).toEqual({ ok: true });
  });

  it('keeps plants in place when the map grows at its edges', () => {
    const small = generatePlants(EGYPT_WORLD_PACK, mapFor('hornhoof')).plants;
    const grown = generatePlants(EGYPT_WORLD_PACK, mapFor('hornhoof', EGYPT_WORLD_PACK, 12)).plants;
    const key = (p: (typeof small)[number]) => `${p.kindIndex}:${p.col.toFixed(4)}:${p.row.toFixed(4)}`;
    const grownKeys = new Set(grown.map(key));
    const inner = small.filter(p => p.col > 4 && p.col < 146 && p.row > 4 && p.row < 146);
    expect(inner.length).toBeGreaterThan(250);
    for (const p of inner) expect(grownKeys.has(key(p))).toBe(true);
  });

  it('orders plants back to front so they sort with buildings and people', () => {
    const { plants } = generatePlants(EGYPT_WORLD_PACK, mapFor('hornhoof'));
    for (let i = 1; i < plants.length; i++) expect(plants[i]!.y).toBeGreaterThanOrEqual(plants[i - 1]!.y);
  });

  it('picks only the plants inside a view rectangle', () => {
    const field = generatePlants(EGYPT_WORLD_PACK, mapFor('hornhoof'));
    const mid = field.plants[Math.floor(field.plants.length / 2)]!;
    const rect = { minX: mid.x - 400, maxX: mid.x + 400, minY: mid.y - 300, maxY: mid.y + 300 };
    const seen = visiblePlants(field, rect, 200);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThan(field.plants.length);
    for (const p of seen) {
      expect(p.x).toBeGreaterThanOrEqual(rect.minX - 200);
      expect(p.x).toBeLessThanOrEqual(rect.maxX + 200);
      expect(p.y).toBeGreaterThanOrEqual(rect.minY - 200 * 0.4);
      expect(p.y).toBeLessThanOrEqual(rect.maxY + 200);
    }
  });

  it('validates the plant specs of a pack', () => {
    const first = EGYPT_WORLD_PACK.plants![0]!;
    const broken: WorldPackManifest = { ...EGYPT_WORLD_PACK, plants: [{ ...first, tileKinds: ['nowhere'], density: 2 }] };
    const result = validateWorldPack(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('unknown tile kind "nowhere"');
      expect(result.errors.join('\n')).toContain('density');
    }
    expect(validateWorldPack(EGYPT_WORLD_PACK)).toEqual({ ok: true });
  });

  it('reads an artist plant passport and rejects an incomplete one', () => {
    const passport = parsePlantPassport({ root_point: [128, 250], crown_center: [128, 70], crown_hub: [128, 120], height: 240, crown_width: 190 });
    expect(passport).toEqual({ rootPoint: [128, 250], crownCenter: [128, 70], crownHub: [128, 120], heightPx: 240, crownWidthPx: 190 });
    expect(parsePlantPassport({ root_point: [1, 2] })).toBeNull();
    expect(parsePlantPassport(null)).toBeNull();
  });
});
