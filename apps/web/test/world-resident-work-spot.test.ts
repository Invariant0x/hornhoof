import { Graphics } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import type { CityBuilding, CityState } from '../src/world/city-layout';
import { deliverySpotsForBuilding, workSlotsForBuilding } from '../src/world/construction';
import { createHornhoofLiveFixture, syncLiveSnapshotToCity } from '../src/world/live-sync';
import type { Direction8, WorldPackManifest } from '../src/world/manifest';
import { createResidentSimulation, stepResidentSimulation, type ResidentEntity } from '../src/world/residents';
import { renderResidentsToPixi } from '../src/world/residents-renderer';
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

  it('spreads the residents working at one building over its work spots', () => {
    const live = createHornhoofLiveFixture();
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: live.company.seed, mapSize: 150 });
    const { city } = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, map, live);
    const seen = arrivals(EGYPT_WORLD_PACK, r => expect(r.workBuildingId, `${r.name} knows its building`).toBeTruthy());
    const spotsInUse = new Map<string, Set<string>>();
    const residents = new Map<string, Set<string>>();
    for (const a of seen) {
      const id = a.buildingId!;
      spotsInUse.set(id, (spotsInUse.get(id) ?? new Set()).add(`${a.col.toFixed(2)},${a.row.toFixed(2)}`));
      residents.set(id, (residents.get(id) ?? new Set()).add(a.name));
    }
    let spread = 0;
    for (const [id, names] of residents) {
      const building = city.buildings.find(b => b.id === id)!;
      const spots = deliverySpotsForBuilding(building, null, EGYPT_WORLD_PACK, city);
      /* Each spot on the lot by a road, one tile from it, and no two the same. */
      for (const spot of spots) {
        expect(city.roads.has(tile(spot.col, spot.row)), `${id} spot on a road`).toBe(false);
        expect(city.roads.has(tile(spot.approach.col, spot.approach.row)), `${id} spot by a road`).toBe(true);
        expect(Math.hypot(spot.col - spot.approach.col, spot.row - spot.approach.row)).toBeLessThan(1);
      }
      expect(new Set(spots.map(s => `${s.col},${s.row}`)).size).toBe(spots.length);
      const want = Math.min(names.size, spots.length);
      expect(spotsInUse.get(id)!.size, `${names.size} residents at ${id} with ${spots.length} spots`).toBe(want);
      if (want > 1) spread++;
    }
    expect(spread, 'the fixture has buildings where several residents work side by side').toBeGreaterThan(0);
  });

  /* The map hides a passer-by behind a building in front of it; a resident stepping onto a building's front edge, and
     standing there, is in front of it and is drawn all the way. */
  it('is drawn on its step onto the lot and at its spot, not hidden behind the building it works at', () => {
    const live = createHornhoofLiveFixture();
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: live.company.seed, mapSize: 150 });
    const { city } = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, map, live);
    const sim = createResidentSimulation(EGYPT_WORLD_PACK, city, live);
    const everywhere = { minX: -1e7, maxX: 1e7, minY: -1e7, maxY: 1e7 };
    const drawn = new Set<string>();
    let stepping = 0;
    let atSpot = 0;
    for (let tick = 0; tick < 1600; tick++) {
      stepResidentSimulation(sim, 0.05);
      const near = sim.residents.filter(r => {
        if (!r.workSpot || r.liveState !== 'working') return false;
        const toSpot = Math.hypot(r.col - r.workSpot.col, r.row - r.workSpot.row);
        const onLastStep = r.leg === 'outbound' && r.pathIndex === r.path.length - 1 && toSpot > 1e-6 && toSpot < 1;
        return onLastStep || (r.leg === 'inbound' && r.pose === 'building' && toSpot < 1e-6);
      });
      if (near.length === 0) continue;
      renderResidentsToPixi(new Graphics(), sim, city, EGYPT_WORLD_PACK, everywhere, 64, 32, null, drawn);
      for (const r of near) {
        expect(drawn.has(r.id), `${r.name} at ${r.col.toFixed(2)}, ${r.row.toFixed(2)} by ${r.workBuildingId}`).toBe(true);
        if (r.leg === 'outbound') stepping++;
        else atSpot++;
      }
    }
    expect(stepping).toBeGreaterThan(20);
    expect(atSpot).toBeGreaterThan(20);
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

  /* The seam with the construction data (#1947 item 11 removes the drawn stand-in workers, not these slots). */
  it('takes the spots from the building’s work slots: the sled and ramp sides of a monument, every road side of a department', () => {
    const live = createHornhoofLiveFixture();
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: live.company.seed, mapSize: 150 });
    const { city } = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, map, live);
    /* The building alone on its lot with a road all round it. */
    const alone = (b: CityBuilding): Pick<CityState, 'roads' | 'footprintOccupant'> => {
      const footprintOccupant = new Map<string, string>();
      const roads = new Map<string, unknown>();
      for (let c = b.col - 1; c <= b.col + b.spanCol; c++) {
        for (let r = b.row - 1; r <= b.row + b.spanRow; r++) {
          const inside = c >= b.col && c < b.col + b.spanCol && r >= b.row && r < b.row + b.spanRow;
          if (inside) footprintOccupant.set(`${c},${r}`, b.id);
          else roads.set(`${c},${r}`, {});
        }
      }
      return { roads, footprintOccupant } as Pick<CityState, 'roads' | 'footprintOccupant'>;
    };
    const southEast = (b: CityBuilding, s: { col: number }) => s.col > b.col + b.spanCol - 1;
    const southWest = (b: CityBuilding, s: { row: number }) => s.row > b.row + b.spanRow - 1;

    const monument = city.buildings.find(b => b.kind === 'monument' && !b.reached)!;
    const slots = workSlotsForBuilding(monument, null, EGYPT_WORLD_PACK, alone(monument).footprintOccupant);
    expect(slots.map(s => s.action)).toEqual(expect.arrayContaining(['pull_sled', 'carry_ramp']));
    const spots = deliverySpotsForBuilding(monument, null, EGYPT_WORLD_PACK, alone(monument));
    expect(spots.length).toBeGreaterThan(0);
    expect(spots.length).toBeLessThanOrEqual(slots.length);
    /* The sled lies off the south-west face, the ramp against the south-east one: a spot by each. */
    expect(spots.some(s => southWest(monument, s) && s.inward.dr === -1)).toBe(true);
    expect(spots.some(s => southEast(monument, s) && s.inward.dc === -1)).toBe(true);

    const department = city.buildings.find(b => b.kind === 'department')!;
    expect(workSlotsForBuilding(department, null, EGYPT_WORLD_PACK)).toEqual([]);
    const along = deliverySpotsForBuilding(department, null, EGYPT_WORLD_PACK, alone(department));
    expect(along).toHaveLength(department.spanCol + department.spanRow);
    expect(along.every(s => southEast(department, s) !== southWest(department, s))).toBe(true);
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
