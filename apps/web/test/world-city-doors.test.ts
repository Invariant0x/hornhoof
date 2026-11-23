import { machinePowerTier } from '@hornhoof/protocol/world';
import { describe, expect, it } from 'vitest';
import {
  createCity,
  deserializeCityLayout,
  growBuildingForProgress,
  placeBuilding,
  serializeCityLayout,
  verifyCityInvariants,
  type CityBuilding,
} from '../src/world/city-layout';
import { createHornhoofLiveFixture, syncLiveSnapshotToCity } from '../src/world/live-sync';
import { validateWorldPack, type WorldPackManifest } from '../src/world/manifest';
import { runFiveYearSimulation } from '../src/world/simulator';
import { generateWorldTerrain } from '../src/world/terrain-engine';
import { DUNGEON_WORLD_PACK } from '../src/world-packs/dungeon/pack';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

/* The two walls that face the viewer in the 2:1 projection: the front-right wall runs along the plot's far
   column edge, the front-left wall along its far row edge; they meet at the plot's front (bottom) corner. */
function doorWall(b: CityBuilding): 'front_right' | 'front_left' | 'back' {
  const { col, row } = b.door;
  if (col === b.col + b.spanCol && row >= b.row && row < b.row + b.spanRow) return 'front_right';
  if (row === b.row + b.spanRow && col >= b.col && col < b.col + b.spanCol) return 'front_left';
  return 'back';
}

function frontCorner(b: Pick<CityBuilding, 'col' | 'row' | 'spanCol' | 'spanRow'>): { col: number; row: number } {
  return { col: b.col + b.spanCol, row: b.row + b.spanRow };
}

function expectInsideLot(b: CityBuilding): void {
  expect(b.col).toBeGreaterThanOrEqual(b.lot.col);
  expect(b.row).toBeGreaterThanOrEqual(b.lot.row);
  expect(frontCorner(b)).toEqual(frontCorner(b.lot));
}

describe('Buildings stand at the front corner of their lot with the door on a front wall', () => {
  it('puts every door on a front wall and grows each building backward, keeping its front corner and its door', () => {
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: 'hornhoof', mapSize: 150 });
    const city = createCity(map, { orderChaos: 0.6, buildingLayout: EGYPT_WORLD_PACK.buildingLayout });
    const residence = city.buildings[0]!;
    const dept = placeBuilding(city, { id: 'dept-1', kind: 'department', departmentId: 'd1' }, map)!;
    const house = placeBuilding(city, { id: 'house-1', kind: 'house', departmentId: 'd1' }, map)!;
    const supply = placeBuilding(city, { id: 'sub-1', kind: 'supply' }, map)!;
    for (const b of [residence, dept, house, supply]) {
      expect(doorWall(b), b.id).not.toBe('back');
      expectInsideLot(b);
    }

    const grow = (b: CityBuilding, patch: Partial<CityBuilding>): void => {
      const corner = frontCorner(b);
      const door = { ...b.door };
      const span = b.spanCol;
      Object.assign(b, patch);
      expect(growBuildingForProgress(city, map, b), b.id).toBe(true);
      expect(b.spanCol, b.id).toBeGreaterThan(span);
      expect(frontCorner(b), b.id).toEqual(corner);
      expect(b.door, b.id).toEqual(door);
      expect(doorWall(b), b.id).not.toBe('back');
      expectInsideLot(b);
    };
    grow(house, { level: 18 });
    grow(dept, { stage: 9 });
    grow(residence, { stage: 5 });

    const check = verifyCityInvariants(city, map);
    expect(check.ok, JSON.stringify(check.errors)).toBe(true);
    expect(check.doorsOffFrontWalls).toBe(0);
  });

  it('builds the workshop of the pack with its painted door, two rows from the front corner, and grows it 3x3, 4x4, 5x5 in a 5x5 lot', () => {
    const rule = EGYPT_WORLD_PACK.buildingLayout?.district_hub;
    expect(rule).toEqual({ door: { wall: 'front_right', fromFront: 2 }, spans: [3, 4, 5] });

    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: 'hornhoof', mapSize: 150 });
    const city = createCity(map, { orderChaos: 0.5, buildingLayout: EGYPT_WORLD_PACK.buildingLayout });
    const hub = placeBuilding(city, { id: 'hub-1', kind: 'district_hub', districtId: 'm1' }, map)!;
    expect(hub).not.toBeNull();
    expect([hub.spanCol, hub.spanRow]).toEqual([3, 3]);
    expect([hub.lot.spanCol, hub.lot.spanRow]).toEqual([5, 5]);
    expect(hub.door).toEqual({ col: hub.col + 3, row: hub.row + 3 - 1 - 2 });
    const corner = frontCorner(hub);
    const door = { ...hub.door };

    hub.stage = 2;
    growBuildingForProgress(city, map, hub);
    expect([hub.spanCol, hub.spanRow]).toEqual([4, 4]);
    hub.stage = 3;
    growBuildingForProgress(city, map, hub);
    expect([hub.spanCol, hub.spanRow]).toEqual([5, 5]);
    expect(frontCorner(hub)).toEqual(corner);
    expect(hub.door).toEqual(door);
    expect(hub.door).toEqual({ col: hub.col + 5, row: hub.row + 5 - 1 - 2 });
    expect(hub.lot).toEqual({ col: hub.col, row: hub.row, spanCol: 5, spanRow: 5 });

    /* The rule is pack data: a snapshot keeps the grown building, and growth goes on after a reload. */
    const restored = deserializeCityLayout(serializeCityLayout(city), { buildingLayout: EGYPT_WORLD_PACK.buildingLayout });
    expect(restored.buildings.find(b => b.id === 'hub-1')).toEqual(hub);
  });

  it('builds an Egypt home as the pilot art: a 2x2 hut from level 1, a 3x3 mudbrick house from level 4, kept through level 14, 4x4 from 15, in a 4x4 lot with the door on the front right wall, row 0', () => {
    expect(EGYPT_WORLD_PACK.buildingLayout?.house).toEqual({ door: { wall: 'front_right', fromFront: 0 }, spans: [2, 3, 3, 4] });
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: 'hornhoof', mapSize: 150 });
    const city = createCity(map, { orderChaos: 0.5, buildingLayout: EGYPT_WORLD_PACK.buildingLayout });
    const house = placeBuilding(city, { id: 'house-1', kind: 'house', departmentId: 'd1' }, map)!;
    expect(house).not.toBeNull();
    expect([house.spanCol, house.spanRow, house.lot.spanCol, house.lot.spanRow]).toEqual([2, 2, 4, 4]);
    expect(house.door).toEqual({ col: house.col + 2, row: house.row + 2 - 1 });
    const corner = frontCorner(house);
    const door = { ...house.door };
    for (const [level, span] of [[3, 2], [4, 3], [14, 3], [15, 4]] as const) {
      house.level = level;
      growBuildingForProgress(city, map, house);
      expect(house.spanCol, `level ${level}`).toBe(span);
      expect(frontCorner(house)).toEqual(corner);
      expect(house.door).toEqual(door);
    }
    const check = verifyCityInvariants(city, map);
    expect(check.ok, JSON.stringify(check.errors)).toBe(true);
  });

  it('gives a live machine the workshop size of its power: weak 3x3, middle 4x4, strong 5x5, all in a 5x5 lot', () => {
    const live = createHornhoofLiveFixture();
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: live.company.seed, mapSize: 150 });
    const synced = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, map, live);
    const spans = EGYPT_WORLD_PACK.buildingLayout!.district_hub!.spans;
    for (const m of live.machines) {
      const hub = synced.city.buildings.find(b => b.id === `hub-${m.id}`)!;
      const tier = machinePowerTier(m.cores, m.memory).tier;
      expect(hub.spanCol, m.hostname).toBe(spans[tier - 1]);
      expect(hub.lot.spanCol, m.hostname).toBe(5);
      expect(doorWall(hub), m.hostname).toBe('front_right');
      expect(hub.door.row, m.hostname).toBe(hub.row + hub.spanRow - 1 - 2);
    }
    const check = verifyCityInvariants(synced.city, map);
    expect(check.ok, JSON.stringify(check.errors)).toBe(true);
    expect(check.doorsOffFrontWalls).toBe(0);
  });

  it('keeps every door of a 5-year city on a front wall, in Egypt and in the dungeon that declares no rule', () => {
    for (const pack of [EGYPT_WORLD_PACK, DUNGEON_WORLD_PACK]) {
      const result = runFiveYearSimulation(pack, { seed: 'hornhoof', mapSize: 150, orderChaos: 0.5 });
      const map = generateWorldTerrain(pack, { seed: 'hornhoof', mapSize: 150 });
      const check = verifyCityInvariants(result.city, map);
      expect(check.ok, `${pack.id}: ${JSON.stringify(check.errors)}`).toBe(true);
      expect(check.doorsOffFrontWalls, pack.id).toBe(0);
      expect(result.coordinateJumps, pack.id).toBe(0);
      const backDoors = result.city.buildings.filter(b => doorWall(b) === 'back').map(b => b.id);
      expect(backDoors, pack.id).toEqual([]);
      if (pack === EGYPT_WORLD_PACK) {
        const hubs = result.city.buildings.filter(b => b.kind === 'district_hub');
        expect(hubs.length).toBeGreaterThan(0);
        expect(hubs.every(h => h.door.row === h.row + h.spanRow - 3)).toBe(true);
        expect(hubs.some(h => h.spanCol === 5)).toBe(true);
      }
    }
  });

  it('rejects a layout rule with an unknown wall, a door row past the smallest size or sizes that shrink, and lets a kind keep a size for two steps', () => {
    const withRule = (rule: unknown): WorldPackManifest =>
      ({ ...EGYPT_WORLD_PACK, buildingLayout: { district_hub: rule } }) as unknown as WorldPackManifest;
    expect(validateWorldPack(EGYPT_WORLD_PACK)).toEqual({ ok: true });
    const errorsOf = (rule: unknown): readonly string[] => {
      const result = validateWorldPack(withRule(rule));
      return result.ok ? [] : result.errors;
    };
    expect(errorsOf({ door: { wall: 'back', fromFront: 0 }, spans: [3] }).join()).toMatch(/buildingLayout\.district_hub/);
    expect(errorsOf({ door: { wall: 'front_left', fromFront: 3 }, spans: [3, 4] }).join()).toMatch(/fromFront/);
    expect(errorsOf({ door: { wall: 'front_left', fromFront: -1 }, spans: [3] }).join()).toMatch(/fromFront/);
    expect(errorsOf({ door: { wall: 'front_left', fromFront: 0 }, spans: [4, 3] }).join()).toMatch(/spans/);
    expect(errorsOf({ door: { wall: 'front_right', fromFront: 1 }, spans: [2, 3, 3, 4] })).toEqual([]);
    expect(errorsOf({ door: { wall: 'front_left', fromFront: 0 }, spans: [0, 7] }).join()).toMatch(/spans/);
    expect(errorsOf({ door: { wall: 'front_left', fromFront: 0 }, spans: [] }).join()).toMatch(/spans/);
    const unknownKind = { ...EGYPT_WORLD_PACK, buildingLayout: { castle: { door: { wall: 'front_left', fromFront: 0 }, spans: [2] } } };
    const unknown = validateWorldPack(unknownKind as unknown as WorldPackManifest);
    expect(unknown.ok ? '' : unknown.errors.join()).toMatch(/castle/);
  });
});
