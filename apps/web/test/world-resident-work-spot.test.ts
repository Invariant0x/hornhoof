import { describe, expect, it } from 'vitest';
import type { CityState } from '../src/world/city-layout';
import { createHornhoofLiveFixture, syncLiveSnapshotToCity } from '../src/world/live-sync';
import type { Direction8, WorldPackManifest } from '../src/world/manifest';
import { createResidentSimulation, stepResidentSimulation, type ResidentEntity } from '../src/world/residents';
import { generateWorldTerrain } from '../src/world/terrain-engine';
import { DUNGEON_WORLD_PACK } from '../src/world-packs/dungeon/pack';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';
import { SPACE_WORLD_PACK } from '../src/world-packs/space/pack';

/* #2001, Ivan 23.11: a resident brings its stone to the building itself. Every delivery and every build ends on a work
   spot of the building, facing it, never on a road tile. */

const tile = (col: number, row: number): string => `${Math.round(col)},${Math.round(row)}`;

/* Screen angle of each facing, the way a sheet row is drawn (E 0, clockwise in 45 degree steps). */
const FACING_ORDER: readonly Direction8[] = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];

/* A point half a tile ahead of a resident in the direction it faces on screen. On the 2:1 diamond a screen vector
   (x, y) is the tile step dc - dr = x, (dc + dr) / 2 = y. */
function aheadOf(r: Pick<ResidentEntity, 'col' | 'row' | 'facing'>): { col: number; row: number } {
  const angle = (FACING_ORDER.indexOf(r.facing) * Math.PI) / 4;
  const x = Math.cos(angle);
  const y = Math.sin(angle);
  const dc = (x + 2 * y) / 2;
  const dr = (2 * y - x) / 2;
  const len = Math.hypot(dc, dr);
  return { col: r.col + (dc / len) * 0.5, row: r.row + (dr / len) * 0.5 };
}

type Arrival = Readonly<{ name: string; kind: ResidentEntity['deliveryTargetKind']; buildingId: string | null; col: number; row: number }>;

/* Steps the live fixture city of a pack and checks every resident the moment it stands at the end of a walk to the
   building it works at. */
function arrivals(pack: WorldPackManifest, check: (r: ResidentEntity, city: CityState) => void): Arrival[] {
  const live = createHornhoofLiveFixture();
  const map = generateWorldTerrain(pack, { seed: live.company.seed, mapSize: 150 });
  const { city } = syncLiveSnapshotToCity(pack, map, live);
  const sim = createResidentSimulation(pack, city, live);
  const seen: Arrival[] = [];
  /* A resident starts mid-route, maybe in a pause of its own; only the pause at the end of a walk to work counts. */
  const leg = new Map(sim.residents.map(r => [r.id, r.leg]));
  for (let tick = 0; tick < 1600; tick++) {
    stepResidentSimulation(sim, 0.1);
    for (const r of sim.residents) {
      const arrived = leg.get(r.id) === 'outbound' && r.leg === 'inbound';
      leg.set(r.id, r.leg);
      if (!arrived || r.liveState !== 'working' || r.deliveryTargetKind === 'none' || r.pose !== 'building') continue;
      check(r, city);
      seen.push({ name: r.name, kind: r.deliveryTargetKind, buildingId: r.workBuildingId, col: r.col, row: r.row });
    }
  }
  return seen;
}

describe('A delivery ends at the building it is for (#2001)', () => {
  it('never ends on a road tile: the stone is laid on the building’s own lot', () => {
    const seen = arrivals(EGYPT_WORLD_PACK, (r, city) => {
      expect(city.roads.has(tile(r.col, r.row)), `${r.name} lays its stone on the road at ${r.col}, ${r.row}`).toBe(false);
      expect(r.workBuildingId, `${r.name} knows the building it brings the stone to`).toBeTruthy();
      expect(city.footprintOccupant.get(tile(r.col, r.row)), `${r.name} stands on the lot of ${r.workBuildingId}`).toBe(r.workBuildingId);
      expect(r.carrying, `${r.name} has laid the stone it brought`).toBe('none');
    });
    /* Deliveries to the goal monuments, the department statues and the department buildings all count. */
    expect(new Set(seen.map(a => a.kind))).toEqual(new Set(['monument', 'statue', 'department']));
    expect(seen.length).toBeGreaterThanOrEqual(12);
  });

  it('faces the building it lays the stone in', () => {
    const seen = arrivals(EGYPT_WORLD_PACK, (r, city) => {
      expect(r.workBuildingId, `${r.name} knows the building it brings the stone to`).toBeTruthy();
      const ahead = aheadOf(r);
      expect(city.footprintOccupant.get(tile(ahead.col, ahead.row)), `${r.name} faces ${r.facing}, away from ${r.workBuildingId}`).toBe(
        r.workBuildingId,
      );
    });
    expect(seen.length).toBeGreaterThanOrEqual(12);
  });

  it('spreads the residents bringing stones to one building over its work spots', () => {
    const seen = arrivals(EGYPT_WORLD_PACK, r => expect(r.workBuildingId, `${r.name} knows its building`).toBeTruthy());
    const spotsByBuilding = new Map<string, Set<string>>();
    const residentsByBuilding = new Map<string, Set<string>>();
    for (const a of seen) {
      const id = a.buildingId ?? '';
      spotsByBuilding.set(id, (spotsByBuilding.get(id) ?? new Set()).add(`${a.col.toFixed(2)},${a.row.toFixed(2)}`));
      residentsByBuilding.set(id, (residentsByBuilding.get(id) ?? new Set()).add(a.name));
    }
    const shared = [...residentsByBuilding].filter(([, names]) => names.size >= 2);
    expect(shared.length, 'the fixture has buildings that several residents bring stones to').toBeGreaterThan(0);
    for (const [id] of shared) expect(spotsByBuilding.get(id)!.size, `${id} has more than one work spot in use`).toBeGreaterThan(1);
  });

  it('leaves the buildings as the accepted results drew them: a delivery grows nothing by itself', () => {
    const live = createHornhoofLiveFixture();
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: live.company.seed, mapSize: 150 });
    const { city } = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, map, live);
    const before = city.buildings.map(b => ({ id: b.id, stage: b.stage, progress: b.progress, reached: b.reached }));
    const sim = createResidentSimulation(EGYPT_WORLD_PACK, city, live);
    for (let tick = 0; tick < 600; tick++) stepResidentSimulation(sim, 0.1);
    expect(city.buildings.map(b => ({ id: b.id, stage: b.stage, progress: b.progress, reached: b.reached }))).toEqual(before);
  });

  it.each([
    ['dungeon', DUNGEON_WORLD_PACK],
    ['space', SPACE_WORLD_PACK],
  ])('works the same in the %s test pack, with no pack words in the engine', (_name, pack) => {
    const seen = arrivals(pack, (r, city) => {
      expect(r.workBuildingId, `${r.name} knows its building`).toBeTruthy();
      expect(city.roads.has(tile(r.col, r.row)), `${r.name} on the road`).toBe(false);
      expect(city.footprintOccupant.get(tile(r.col, r.row))).toBe(r.workBuildingId);
      const ahead = aheadOf(r);
      expect(city.footprintOccupant.get(tile(ahead.col, ahead.row)), `${r.name} faces ${r.facing}`).toBe(r.workBuildingId);
    });
    expect(seen.length).toBeGreaterThan(0);
  });
});
