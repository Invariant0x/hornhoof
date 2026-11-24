import type { WorldLiveSnapshot } from '@hornhoof/protocol/world';
import { Graphics } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { WorldArtLibrary, type DisplayRunPool } from '../src/world/art-runtime';
import type { CityBuilding, CityState } from '../src/world/city-layout';
import { renderCityToPixi } from '../src/world/city-renderer';
import { createConstructionSimulation, startBuildingConstruction, startBuildingDemolition, stepConstructionSimulation } from '../src/world/construction';
import { renderConstructionLoopsToPixi } from '../src/world/construction-renderer';
import { tileTopVertexToWorld } from '../src/world/coords';
import { createHornhoofLiveFixture, syncLiveSnapshotToCity } from '../src/world/live-sync';
import type { WorldPackManifest } from '../src/world/manifest';
import { createResidentSimulation, stepResidentSimulation } from '../src/world/residents';
import { renderResidentsToPixi } from '../src/world/residents-renderer';
import { generateWorldTerrain } from '../src/world/terrain-engine';
import { DUNGEON_WORLD_PACK } from '../src/world-packs/dungeon/pack';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';
import { SPACE_WORLD_PACK } from '../src/world-packs/space/pack';

/* #1947 item 11, Ivan 23.11: "Placeholders can be plain squares, but not like now: home-made little people and home-made
   construction pieces look shabby and ugly, and they take resources." Without art, a building, a resident or a
   construction shows one flat one-colour shape on the ground and nothing else: no procedural people, lift, parts,
   smoke or dust, in Egypt and in both test packs. */

const TILE_W = 120;
const TILE_H = 60;
const EVERYWHERE = { minX: -1e9, maxX: 1e9, minY: -1e9, maxY: 1e9 };

/* A pool that hands out a fresh Graphics each time and remembers it, with no art to draw. */
function recordingArt() {
  const drawn: { depth: number; g: Graphics }[] = [];
  const pool = {
    depth: 0,
    begin() {},
    clear() {},
    graphics() {
      const g = new Graphics();
      drawn.push({ depth: pool.depth, g });
      return g;
    },
    sprite() {
      throw new Error('no art is loaded, so nothing is drawn from a sprite');
    },
  };
  return { library: WorldArtLibrary.none(), pool: pool as unknown as DisplayRunPool, drawn };
}

const instructionsOf = (g: Graphics) => g.context.instructions;

/* The ground diamond of a lot, as a box on screen. */
function lotBox(b: Pick<CityBuilding, 'col' | 'row' | 'spanCol' | 'spanRow'>) {
  const top = tileTopVertexToWorld(b.col, b.row, TILE_W, TILE_H);
  const right = tileTopVertexToWorld(b.col + b.spanCol, b.row, TILE_W, TILE_H);
  const bottom = tileTopVertexToWorld(b.col + b.spanCol, b.row + b.spanRow, TILE_W, TILE_H);
  const left = tileTopVertexToWorld(b.col, b.row + b.spanRow, TILE_W, TILE_H);
  return { minX: left.x - 1, maxX: right.x + 1, minY: top.y - 1, maxY: bottom.y + 1 };
}

function liveCity(pack: WorldPackManifest): { live: WorldLiveSnapshot; city: CityState } {
  const base = createHornhoofLiveFixture();
  /* Every machine online, so no district is shaded at night (#1955 owns the night shade). */
  const live: WorldLiveSnapshot = { ...base, machines: base.machines.map(m => ({ ...m, online: true })) };
  const map = generateWorldTerrain(pack, { seed: live.company.seed, mapSize: 150 });
  return { live, city: syncLiveSnapshotToCity(pack, map, live).city };
}

describe.each([
  ['egypt', EGYPT_WORLD_PACK],
  ['dungeon', DUNGEON_WORLD_PACK],
  ['space', SPACE_WORLD_PACK],
])('Without art the %s world shows one flat placeholder per thing (#1947 item 11)', (_name, pack) => {
  it('draws each building, built, under construction or torn down, as one flat shape on its own lot', () => {
    const { city } = liveCity(pack);
    const sim = createConstructionSimulation(pack);
    const [building, ruin] = city.buildings.filter(b => b.kind === 'department' || b.kind === 'house');
    startBuildingConstruction(sim, building!, building!.maxStage, 1, 1);
    startBuildingDemolition(sim, ruin!);
    stepConstructionSimulation(sim, 2);
    const art = recordingArt();
    const main = new Graphics();
    renderCityToPixi(main, { city, worldMode: 'active', constructionJobs: sim.jobs }, pack, TILE_W, TILE_H, null, {
      library: art.library,
      pool: art.pool,
      variants: new Map(),
    });
    const placeholders = art.drawn.filter(d => d.depth < Number.MAX_SAFE_INTEGER);
    expect(placeholders.length).toBe(city.buildings.length);
    for (const { g } of placeholders) {
      const ins = instructionsOf(g);
      expect(ins.map(i => i.action), 'one fill, no outline, no second layer').toEqual(['fill']);
      const b = g.bounds;
      /* Flat: it lies inside the ground diamond of some lot, nothing of it stands up. */
      const home = city.buildings.find(c => {
        const box = lotBox(c);
        return b.minX >= box.minX && b.maxX <= box.maxX && b.minY >= box.minY && b.maxY <= box.maxY;
      });
      expect(home, `a placeholder at ${b.minX},${b.minY} to ${b.maxX},${b.maxY} stands up off its lot`).toBeDefined();
    }
  });

  it('draws each resident as one flat shape on the ground, and no alert smoke or home scaffolding', () => {
    const { live, city } = liveCity(pack);
    const sim = createResidentSimulation(pack, city, live);
    sim.smokingDepartmentIds.add(live.departments[0]!.id);
    sim.scaffoldingHouseIds.add(city.buildings.find(b => b.kind === 'house')?.id ?? 'none');
    stepResidentSimulation(sim, 0.5);
    const art = recordingArt();
    const main = new Graphics();
    renderResidentsToPixi(main, sim, city, pack, EVERYWHERE, TILE_W, TILE_H, null, undefined, { library: art.library, pool: art.pool });
    expect(instructionsOf(main), 'nothing drawn beside the residents').toEqual([]);
    expect(art.drawn.length).toBeGreaterThan(0);
    expect(art.drawn.length).toBeLessThanOrEqual(sim.residents.length + 1);
    for (const { g } of art.drawn) {
      expect(instructionsOf(g).map(i => i.action), 'one fill, no outline, no second layer').toEqual(['fill']);
      expect(g.bounds.maxY - g.bounds.minY, 'flat on the ground').toBeLessThanOrEqual(TILE_H + 1);
    }
  });

  it('draws no crane, dust, smoke, water, awning, celebration or stand-in worker over a construction without loop art', () => {
    const { city } = liveCity(pack);
    const sim = createConstructionSimulation(pack);
    for (const b of city.buildings.slice(0, 12)) startBuildingConstruction(sim, b, b.maxStage, 1, 1);
    stepConstructionSimulation(sim, 3);
    const art = recordingArt();
    renderConstructionLoopsToPixi(sim, city, pack, EVERYWHERE, TILE_W, TILE_H, {
      library: art.library,
      pool: art.pool,
      variants: new Map(),
    });
    expect(art.drawn.flatMap(d => instructionsOf(d.g))).toEqual([]);
  });
});
