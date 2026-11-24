import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateWorldPack } from '../src/world/manifest';
import { sampleCornerFieldBilinear } from '../src/world/smooth-terrain-baker';
import { GALLERY_SEEDS, generateWorldTerrain, verifyTileContinuity } from '../src/world/terrain-engine';
import { resolveWorldPack } from '../src/world-packs/registry';
import { SPACE_WORLD_PACK } from '../src/world-packs/space/pack';

const WORLD_DIR = join(import.meta.dirname, '..', 'src', 'world');
const SPACE_DIR = join(import.meta.dirname, '..', 'src', 'world-packs', 'space');
/* The pack's own tile ids and words only it uses; generic words like "hull" (convex hull) stay allowed in the engine. */
const SPACE_TERMS = /\b(open_space|outer_hull|command_deck|garden_bay|cargo_bay|frame_truss|starships?|spaceships?|orbital|admirals?|airlocks?)\b/i;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe('Stage 9 second test pack: an orbital station on the same engine', () => {
  it('is registered, validates and brings its own recipe, materials, looks and art catalog', () => {
    expect(resolveWorldPack('space')).toBe(SPACE_WORLD_PACK);
    expect(validateWorldPack(SPACE_WORLD_PACK)).toEqual({ ok: true });
    expect(SPACE_WORLD_PACK.terrainRecipe?.id).toBe('space-station');
    expect(SPACE_WORLD_PACK.outerWallMode).toBe('none');
    expect(SPACE_WORLD_PACK.art?.baseUrl).toBe('/world-art/space/');
    expect(SPACE_WORLD_PACK.roleLooks?.ruler?.label).toBe('Fleet Admiral');
  });

  it('generates the same station for the same seed and different stations for different seeds', () => {
    const a1 = generateWorldTerrain(SPACE_WORLD_PACK, { seed: 'hornhoof', mapSize: 150 });
    const a2 = generateWorldTerrain(SPACE_WORLD_PACK, { seed: 'hornhoof', mapSize: 150 });
    const b = generateWorldTerrain(SPACE_WORLD_PACK, { seed: 'atlas-studio', mapSize: 150 });
    expect(a1.startCenter).toEqual(a2.startCenter);
    expect(a1.tiles.every((v, i) => v === a2.tiles[i])).toBe(true);
    expect(a1.tiles.some((v, i) => v !== b.tiles[i])).toBe(true);
  });

  it('puts the command deck at the start, open space around the station, and every deck kind on every gallery seed', () => {
    const minOpen = SPACE_WORLD_PACK.terrainRecipe!.minBuildableRatio;
    for (const seed of GALLERY_SEEDS) {
      const map = generateWorldTerrain(SPACE_WORLD_PACK, { seed, mapSize: 150 });
      expect(map.tileAt(map.startCenter.col, map.startCenter.row), `${seed}: start`).toBe('command_deck');
      expect(map.isBuildable(map.startCenter.col, map.startCenter.row)).toBe(true);
      expect(map.stats.buildableRatio, `${seed}: buildable`).toBeGreaterThanOrEqual(minOpen);
      const space = verifyTileContinuity(map, ['open_space']);
      expect(space.continuous, `${seed}: open space is one field around the station`).toBe(true);
      expect(space.touchedEdges.length, `${seed}: open space at the edges`).toBe(4);
      for (const id of ['open_space', 'outer_hull', 'deck', 'corridor', 'command_deck', 'garden_bay', 'cargo_bay', 'frame']) {
        expect(map.stats.counts[id] ?? 0, `${seed}: missing ${id}`).toBeGreaterThan(0);
      }
    }
  });

  it('expands map edges without moving a single tile, corner value or the start', () => {
    const base = generateWorldTerrain(SPACE_WORLD_PACK, { seed: 'hornhoof', mapSize: 150 });
    const expanded = generateWorldTerrain(SPACE_WORLD_PACK, { seed: 'hornhoof', mapSize: 150, expandMargin: 25 });
    expect(expanded.startCenter).toEqual(base.startCenter);
    for (let r = 0; r < 150; r += 3) {
      for (let c = 0; c < 150; c += 3) expect(expanded.tileAt(c, r)).toBe(base.tileAt(c, r));
    }
    for (let v = 0; v <= 150; v += 10) {
      const a = sampleCornerFieldBilinear(base.cornerFields, v, 150 - v);
      const e = sampleCornerFieldBilinear(expanded.cornerFields, v, 150 - v);
      expect(e.signedWaterDist).toBeCloseTo(a.signedWaterDist, 5);
    }
  });

  it('needs no engine change: no word of the station in the engine, and the pack imports only the engine', () => {
    for (const file of walk(WORLD_DIR)) {
      expect(SPACE_TERMS.test(readFileSync(file, 'utf8')), `station word in ${relative(WORLD_DIR, file)}`).toBe(false);
    }
    for (const file of walk(SPACE_DIR)) {
      const body = readFileSync(file, 'utf8');
      for (const m of body.matchAll(/from '([^']+)'/g)) {
        expect(m[1]!.startsWith('../../world/') || m[1]!.startsWith('./') || m[1] === '@hornhoof/protocol/world', `${file} imports ${m[1]}`).toBe(true);
      }
      expect(body.includes('—'), `em dash in ${file}`).toBe(false);
      expect(/[ёЁ]/.test(body), `Russian yo in ${file}`).toBe(false);
    }
  });
});
