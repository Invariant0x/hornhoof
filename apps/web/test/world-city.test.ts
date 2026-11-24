import { describe, expect, it } from 'vitest';
import {
  acceptRelocation,
  advanceRelocationStep,
  cancelRelocation,
  createCity,
  deserializeCityLayout,
  growBuildingForProgress,
  placeBuilding,
  rebuildWallIfNeeded,
  recordTrafficRoute,
  requestRelocation,
  serializeCityLayout,
  verifyCityInvariants,
  type CityState,
} from '../src/world/city-layout';
import { runFiveYearSimulation, SIM_KNOBS, SIM_SEEDS } from '../src/world/simulator';
import { generateWorldTerrain } from '../src/world/terrain-engine';
import { DUNGEON_WORLD_PACK } from '../src/world-packs/dungeon/pack';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

describe('Stage 3 pack-agnostic organic city growth, standard 1x1..6x6 footprints, roads, walls and excavation', () => {
  it('places residence at center, 6x6 primary monument, supplies near water, departments in core, houses near hubs and statues along streets', () => {
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: 'hornhoof', mapSize: 150 });
    const city = createCity(map, { orderChaos: 0.7 });

    const residence = city.buildings.find(b => b.kind === 'residence')!;
    expect(residence).toBeDefined();
    expect(residence.spanCol).toBe(2);
    expect(residence.lot.spanCol).toBe(6);
    expect(Math.hypot(residence.col - map.startCenter.col, residence.row - map.startCenter.row)).toBeLessThanOrEqual(4);

    /* Primary monument takes a full 6x6 standard footprint from 10-standart-razmerov.json. */
    const monument = placeBuilding(city, { id: 'goal-1', kind: 'monument', label: 'Primary Goal' });
    expect(monument).not.toBeNull();
    expect(monument!.spanCol).toBe(6);
    expect(monument!.spanRow).toBe(6);
    expect(Math.hypot(monument!.col - residence.col, monument!.row - residence.row)).toBeLessThanOrEqual(24);

    const deptA = placeBuilding(city, { id: 'dept-dev', kind: 'department', departmentId: 'dev', label: 'Development' });
    const deptB = placeBuilding(city, { id: 'dept-ops', kind: 'department', departmentId: 'ops', label: 'Operations' });
    expect(deptA).not.toBeNull();
    expect(deptB).not.toBeNull();
    expect(deptA!.spanCol).toBe(3);
    expect(deptA!.lot.spanCol).toBeGreaterThanOrEqual(3);

    const supply = placeBuilding(city, { id: 'sub-1', kind: 'supply', label: 'Primary Plan' });
    expect(supply).not.toBeNull();
    expect(supply!.spanCol).toBe(3);
    let minLiquidDist = Infinity;
    for (let dy = -9; dy <= 9; dy++) {
      for (let dx = -9; dx <= 9; dx++) {
        if (map.isLiquid(supply!.col + 1 + dx, supply!.row + 1 + dy)) {
          minLiquidDist = Math.min(minLiquidDist, Math.hypot(dx, dy));
        }
      }
    }
    expect(minLiquidDist).toBeLessThanOrEqual(7.5);

    const hub1 = placeBuilding(city, { id: 'mach-1', kind: 'district_hub', districtId: 'm1' });
    const hub2 = placeBuilding(city, { id: 'mach-2', kind: 'district_hub', districtId: 'm2' });
    expect(hub1).not.toBeNull();
    expect(hub2).not.toBeNull();

    let ownDistSum = 0;
    let otherDistSum = 0;
    for (let i = 0; i < 10; i++) {
      const h1 = placeBuilding(city, { id: `agent-m1-${i}`, kind: 'house', districtId: 'm1', departmentId: 'dev' })!;
      const h2 = placeBuilding(city, { id: `agent-m2-${i}`, kind: 'house', districtId: 'm2', departmentId: 'ops' })!;
      expect(h1).not.toBeNull();
      expect(h2).not.toBeNull();
      expect(h1.spanCol).toBe(1);
      ownDistSum += Math.hypot(h1.col - hub1!.col, h1.row - hub1!.row);
      otherDistSum += Math.hypot(h1.col - hub2!.col, h1.row - hub2!.row);
      ownDistSum += Math.hypot(h2.col - hub2!.col, h2.row - hub2!.row);
      otherDistSum += Math.hypot(h2.col - hub1!.col, h2.row - hub1!.row);
    }
    expect(ownDistSum).toBeLessThan(otherDistSum);

    /* Agent houses grow smoothly in place (1x1 -> 2x2 -> 3x3 -> 4x4) backward from a front corner that never jumps. */
    const sampleHouse = city.buildings.find(b => b.id === 'agent-m1-0')!;
    const front = { col: sampleHouse.col + sampleHouse.spanCol, row: sampleHouse.row + sampleHouse.spanRow };
    const door = { ...sampleHouse.door };
    sampleHouse.level = 18;
    growBuildingForProgress(city, map, sampleHouse);
    expect({ col: sampleHouse.col + sampleHouse.spanCol, row: sampleHouse.row + sampleHouse.spanRow }).toEqual(front);
    expect(sampleHouse.door).toEqual(door);
    expect(sampleHouse.spanCol).toBeGreaterThanOrEqual(3);

    /* Ruler residence grows smoothly from 2x2 up to 6x6 as stages climb. */
    residence.stage = 5;
    growBuildingForProgress(city, map, residence);
    expect(residence.spanCol).toBeGreaterThanOrEqual(4);

    /* Statues grow from 1x1 -> 2x2 along department street. */
    const statues = [];
    for (let i = 0; i < 4; i++) {
      const st = placeBuilding(city, { id: `statue-dev-${i}`, kind: 'statue', departmentId: 'dev' });
      expect(st).not.toBeNull();
      statues.push(st!);
    }
    expect(statues[0]!.spanCol).toBe(1);
    expect(statues[3]!.spanCol).toBe(2);

    const check = verifyCityInvariants(city, map);
    expect(check.ok, JSON.stringify(check.errors)).toBe(true);
    expect(check.overlappingPairs).toBe(0);
    expect(check.disconnectedBuildings).toBe(0);
  });

  it('responds measurably to the orderChaos knob (straight grid at 1.0 vs winding organic lanes at 0.0)', () => {
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: 'velvet-ops', mapSize: 150 });
    const buildSample = (orderChaos: number): CityState => {
      const city = createCity(map, { orderChaos });
      placeBuilding(city, { id: 'goal-1', kind: 'monument' });
      for (let d = 0; d < 4; d++) {
        placeBuilding(city, { id: `dept-${d}`, kind: 'department', departmentId: `d${d}` });
      }
      for (let m = 0; m < 3; m++) {
        placeBuilding(city, { id: `hub-${m}`, kind: 'district_hub', districtId: `m${m}` });
      }
      for (let a = 0; a < 36; a++) {
        placeBuilding(city, { id: `house-${a}`, kind: 'house', districtId: `m${a % 3}`, departmentId: `d${a % 4}` });
      }
      return city;
    };

    const ordered = buildSample(1.0);
    const chaotic = buildSample(0.0);

    expect(verifyCityInvariants(ordered, map).ok).toBe(true);
    expect(verifyCityInvariants(chaotic, map).ok).toBe(true);
    expect(ordered.metrics.roadStraightness).toBeGreaterThan(chaotic.metrics.roadStraightness);
    expect(ordered.metrics.gridAlignmentRatio).toBeGreaterThan(chaotic.metrics.gridAlignmentRatio);
  });

  it('upgrades road tiers by traffic and converts superseded outer walls into connected ring streets', () => {
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: 'hornhoof', mapSize: 150 });
    const city = createCity(map, { orderChaos: 0.5 });

    const dept = placeBuilding(city, { id: 'dept-1', kind: 'department', departmentId: 'd1' })!;
    const hub = placeBuilding(city, { id: 'hub-1', kind: 'district_hub', districtId: 'm1' })!;
    for (let i = 0; i < 16; i++) {
      placeBuilding(city, { id: `h-${i}`, kind: 'house', districtId: 'm1', departmentId: 'd1' });
    }
    const builtWall1 = rebuildWallIfNeeded(city, map);
    expect(builtWall1).toBe(true);
    expect(city.wallGeneration).toBe(1);
    expect(city.wallTiles.size).toBeGreaterThan(30);

    /* Heavy commuter traffic promotes streets up to brick and stone. */
    for (let step = 0; step < 12; step++) {
      recordTrafficRoute(city, hub.door, dept.door, 12);
    }
    const tiers = new Set([...city.roads.values()].map(r => r.tier));
    expect(tiers.has('stone')).toBe(true);

    /* Expanding outer buildings triggers ring #2 and turns ring #1 into ring streets. */
    for (let i = 16; i < 54; i++) {
      placeBuilding(city, { id: `h-${i}`, kind: 'house', districtId: 'm1', departmentId: 'd1' });
    }
    const builtWall2 = rebuildWallIfNeeded(city, map, true);
    expect(builtWall2).toBe(true);
    expect(city.wallGeneration).toBe(2);
    expect(city.metrics.oldWallRoadsCreated).toBeGreaterThan(20);
    expect([...city.roads.values()].some(r => r.wasOldWall)).toBe(true);
    expect(verifyCityInvariants(city, map).ok).toBe(true);
  });

  it('refuses to move a building where no street reaches its door, as on the far bank of a map with no bridge (#1985)', () => {
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: 'hornhoof', mapSize: 150 });
    const city = createCity(map, { orderChaos: 0.6 });
    placeBuilding(city, { id: 'dept-1', kind: 'department', departmentId: 'd1', stage: 3 });
    const house = placeBuilding(city, { id: 'house-1', kind: 'house', departmentId: 'd1', stage: 4 })!;
    expect(city.bridge ?? null).toBeNull();
    /* (62, 63) is free land, but its door would stand where streets, which cross water only on a bridge, cannot come. */
    expect(requestRelocation(city, house.id, 62, 63)).toBeNull();
    expect(city.relocations).toEqual([]);
  });

  it('persists layout snapshots identically and moves buildings only via accepted staged relocation', () => {
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: 'hornhoof', mapSize: 150 });
    const city = createCity(map, { orderChaos: 0.6 });
    const dept = placeBuilding(city, { id: 'dept-1', kind: 'department', departmentId: 'd1', stage: 3 })!;
    const house = placeBuilding(city, { id: 'house-1', kind: 'house', departmentId: 'd1', stage: 4 })!;

    const snap = serializeCityLayout(city);
    const restored = deserializeCityLayout(JSON.parse(JSON.stringify(snap)));
    expect(restored.buildings).toEqual(city.buildings);
    expect(restored.roads.size).toBe(city.roads.size);

    const origPos = { col: house.col, row: house.row };
    let target: { col: number; row: number } | null = null;
    for (let dr = -20; dr <= 20 && !target; dr++) {
      for (let dc = -20; dc <= 20 && !target; dc++) {
        const c = dept.col + dc;
        const r = dept.row + dr;
        if (Math.hypot(c - origPos.col, r - origPos.row) < 6) continue;
        const attempt = requestRelocation(city, house.id, c, r);
        if (attempt) {
          target = { col: c, row: r };
          expect(house.col).toBe(origPos.col);
          expect(house.row).toBe(origPos.row);
          cancelRelocation(city, attempt.id);
          expect(house.col).toBe(origPos.col);
          expect(house.row).toBe(origPos.row);
          expect(city.relocations.find(rel => rel.id === attempt.id)?.status).toBe('cancelled');
        }
      }
    }
    expect(target).not.toBeNull();

    const acceptedReq = requestRelocation(city, house.id, target!.col, target!.row)!;
    expect(acceptedReq).not.toBeNull();
    acceptRelocation(city, acceptedReq.id);
    expect(acceptedReq.status).toBe('in_progress');
    expect(acceptedReq.phase).toBe('dismantling');

    const seenPhases = new Set<string>([acceptedReq.phase]);
    for (let step = 0; step < 30 && acceptedReq.status !== 'completed'; step++) {
      advanceRelocationStep(city, map, acceptedReq.id);
      seenPhases.add(acceptedReq.phase);
    }
    expect(acceptedReq.status).toBe('completed');
    expect(seenPhases.has('dismantling')).toBe(true);
    expect(seenPhases.has('building')).toBe(true);
    expect(house.col).toBe(target!.col);
    expect(house.row).toBe(target!.row);
    expect(verifyCityInvariants(city, map).ok).toBe(true);
  });

  it('fits a full 5-year Egypt company (150 agents, 160000 tasks, 30 major goals) across 3 seeds x 3 knobs with 1x1..6x6 footprints and zero shift on edge expansion', () => {
    expect(SIM_SEEDS).toHaveLength(3);
    expect(SIM_KNOBS).toHaveLength(3);

    for (const seed of SIM_SEEDS) {
      const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed, mapSize: 150 });
      const expandedMap = generateWorldTerrain(EGYPT_WORLD_PACK, { seed, mapSize: 150, expandMargin: 25 });

      for (const orderChaos of SIM_KNOBS) {
        const result = runFiveYearSimulation(EGYPT_WORLD_PACK, { seed, mapSize: 150, orderChaos });
        const { city, frames } = result;
        const label = `egypt/${seed}@order=${orderChaos}`;

        expect(frames.length, `${label}: 60 monthly frames`).toBe(60);
        expect(result.totalAgents, `${label}: 150 agents`).toBe(150);
        expect(result.totalAcceptedTasks, `${label}: 160000 tasks`).toBe(160000);
        expect(result.totalMajorGoals, `${label}: 30 major goals`).toBe(30);

        /* Verify true 1x1..6x6 standard footprint diversity at Year 5 (not uniform boxes). */
        const distinctSpans = new Set(city.buildings.map(b => `${b.spanCol}x${b.spanRow}`));
        expect(distinctSpans.size, `${label}: footprint diversity`).toBeGreaterThanOrEqual(4);
        expect(city.buildings.some(b => b.spanCol >= 5), `${label}: large monument/palace`).toBe(true);
        expect(city.buildings.some(b => b.kind === 'house' && b.spanCol >= 3), `${label}: grown high-level villas`).toBe(true);

        const housedAgents = city.buildings
          .filter(b => b.kind === 'house')
          .reduce((acc, b) => acc + b.residentIds.length, 0);
        expect(housedAgents, `${label}: all 150 agents housed`).toBe(150);

        const monumentGoals = city.buildings
          .filter(b => b.kind === 'monument')
          .reduce((acc, b) => acc + b.goalCount, 0);
        expect(monumentGoals, `${label}: 30 major goals`).toBe(30);
        expect(city.buildings.filter(b => b.kind === 'statue').length, `${label}: statues built`).toBeGreaterThanOrEqual(40);

        expect(city.wallGeneration, `${label}: wall expanded`).toBeGreaterThanOrEqual(2);
        expect(city.metrics.densifiedUpgrades, `${label}: in-place upgrades`).toBeGreaterThan(0);
        expect(city.metrics.mergedBuildings, `${label}: merged small structures`).toBeGreaterThan(0);
        expect(city.metrics.oldWallRoadsCreated, `${label}: old walls became roads`).toBeGreaterThan(0);

        const check = verifyCityInvariants(city, map);
        expect(check.ok, `${label}: ${JSON.stringify(check.errors)}`).toBe(true);
        expect(result.coordinateJumps, `${label}: zero coordinate jumps`).toBe(0);

        const expandedCheck = verifyCityInvariants(city, expandedMap);
        expect(expandedCheck.ok, `${label} expanded: ${JSON.stringify(expandedCheck.errors)}`).toBe(true);
      }
    }
  });

  it('runs the full 5-year simulation on the Dungeon pack by carving halls and corridors out of solid bedrock without an outer wall', () => {
    expect(EGYPT_WORLD_PACK.outerWallMode).toBe('ring');
    expect(DUNGEON_WORLD_PACK.outerWallMode).toBe('none');

    const map = generateWorldTerrain(DUNGEON_WORLD_PACK, { seed: 'hornhoof', mapSize: 150 });
    const expandedMap = generateWorldTerrain(DUNGEON_WORLD_PACK, { seed: 'hornhoof', mapSize: 150, expandMargin: 25 });
    const result = runFiveYearSimulation(DUNGEON_WORLD_PACK, { seed: 'hornhoof', mapSize: 150, orderChaos: 0.5 });
    const { city } = result;

    expect(result.packId).toBe('dungeon');
    expect(result.totalAgents).toBe(150);
    expect(result.totalAcceptedTasks).toBe(160000);
    expect(result.totalMajorGoals).toBe(30);

    /* Pack chose outerWallMode: 'none' -> uncut bedrock is the natural boundary, zero octagonal wall underground. */
    expect(city.outerWallMode).toBe('none');
    expect(city.wallGeneration).toBe(0);
    expect(city.wallTiles.size).toBe(0);
    expect(city.wallHull).toBeNull();
    expect(result.year5Breakdown.wallTiles).toBe(0);

    /* Subterranean growth genuinely carves halls and corridors out of solid rock. */
    expect(city.excavatedTiles.size).toBeGreaterThan(1500);
    expect(result.year5Breakdown.excavatedTiles).toBeGreaterThan(result.year1Breakdown.excavatedTiles);

    const housedAgents = city.buildings
      .filter(b => b.kind === 'house')
      .reduce((acc, b) => acc + b.residentIds.length, 0);
    expect(housedAgents).toBe(150);

    const monumentGoals = city.buildings
      .filter(b => b.kind === 'monument')
      .reduce((acc, b) => acc + b.goalCount, 0);
    expect(monumentGoals).toBe(30);

    const check = verifyCityInvariants(city, map);
    expect(check.ok, JSON.stringify(check.errors)).toBe(true);
    expect(result.coordinateJumps).toBe(0);

    const expandedCheck = verifyCityInvariants(city, expandedMap);
    expect(expandedCheck.ok, JSON.stringify(expandedCheck.errors)).toBe(true);
  });
});
