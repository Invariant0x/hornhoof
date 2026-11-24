import type { WorldLiveSnapshot } from '@hornhoof/protocol/world';
import { describe, expect, it } from 'vitest';
import type { CityState } from '../src/world/city-layout';
import {
  YARD_FILL_STEPS,
  boatCargoMaxOf,
  harbourAt,
  harbourGround,
  planHarbour,
  scheduleBoats,
  yardFillStage,
  type HarbourPlan,
  type RiverHarbourPlan,
} from '../src/world/harbour';
import { createHornhoofLiveFixture, createStress150LiveFixture, syncLiveSnapshotToCity } from '../src/world/live-sync';
import type { WorldPackManifest } from '../src/world/manifest';
import { generateWorldTerrain, type GeneratedWorldMap } from '../src/world/terrain-engine';
import { DUNGEON_WORLD_PACK } from '../src/world-packs/dungeon/pack';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

/* #2006, Ivan 23.11: every new task comes down the river as a stone on a cargo boat to a small harbour, waits in its
   yard (the open queue), and is carried from there to the building. All from the real task states (#99). */

const k = (col: number, row: number): string => `${col},${row}`;

function cityOf(pack: WorldPackManifest, live: WorldLiveSnapshot): { map: GeneratedWorldMap; city: CityState } {
  const map = generateWorldTerrain(pack, { seed: live.company.seed, mapSize: 150 });
  const { city } = syncLiveSnapshotToCity(pack, map, live);
  return { map, city };
}

function riverPlan(plan: HarbourPlan | null): RiverHarbourPlan {
  expect(plan?.kind).toBe('river');
  return plan as RiverHarbourPlan;
}

const T0 = Date.parse('2026-11-21T19:00:00Z');

describe('The harbour where the work comes from (#2006)', () => {
  it('stands on the river bank by the city: a quay on free land, piers into the river, a yard behind it by a road', () => {
    const { map, city } = cityOf(EGYPT_WORLD_PACK, createHornhoofLiveFixture());
    const plan = riverPlan(planHarbour(EGYPT_WORLD_PACK, map, city));
    const taken = (col: number, row: number) =>
      city.footprintOccupant.has(k(col, row)) || city.roads.has(k(col, row)) || city.wallTiles.has(k(col, row)) || city.lotReservation.has(k(col, row));
    expect(plan.quay.length).toBeGreaterThanOrEqual(2);
    for (const q of plan.quay) {
      expect(map.isLiquid(q.col, q.row), `quay ${q.col},${q.row} on land`).toBe(false);
      expect(taken(q.col, q.row), `quay ${q.col},${q.row} on free land`).toBe(false);
      /* The water lies in front of the quay, on the side the camera sees. */
      expect(map.tileAt(q.col + plan.water.dc, q.row + plan.water.dr)).toBe('river');
    }
    expect(plan.piers.length).toBeGreaterThanOrEqual(1);
    for (const pier of plan.piers) {
      for (const t of pier.tiles) expect(map.tileAt(t.col, t.row), `pier ${t.col},${t.row} over the river`).toBe('river');
      /* The boat lies broadside along the pier at its last tile, on the river. */
      expect(map.tileAt(Math.round(pier.berth.col), Math.round(pier.berth.row))).toBe('river');
      expect(pier.route.length).toBeGreaterThan(2);
      for (const t of pier.route) expect(map.tileAt(t.col, t.row), `boat route ${t.col},${t.row}`).toBe('river');
    }
    const yard = plan.yard;
    for (let c = yard.col; c < yard.col + yard.span; c++) {
      for (let r = yard.row; r < yard.row + yard.span; r++) {
        expect(map.isBuildable(c, r) && !map.isLiquid(c, r), `yard ${c},${r} on dry land`).toBe(true);
        expect(taken(c, r), `yard ${c},${r} on free land`).toBe(false);
      }
    }
    expect(yard.spots.length).toBeGreaterThan(0);
    for (const s of yard.spots) {
      expect(city.roads.has(k(s.approach.col, s.approach.row)), 'a yard spot is reached from a road').toBe(true);
      expect(Math.round(s.col) >= yard.col && Math.round(s.col) < yard.col + yard.span, 'the spot is on the yard').toBe(true);
      expect(Math.round(s.row) >= yard.row && Math.round(s.row) < yard.row + yard.span).toBe(true);
    }
  });

  it('names the ground it stands on, so plants leave it: quay, piers, the shore behind and the yard', () => {
    const { map, city } = cityOf(EGYPT_WORLD_PACK, createHornhoofLiveFixture());
    const plan = riverPlan(planHarbour(EGYPT_WORLD_PACK, map, city));
    const ground = harbourGround(plan);
    for (const t of [...plan.quay, ...plan.piers.flatMap(p => p.tiles), ...plan.yard.shore]) expect(ground.has(k(t.col, t.row)), `${t.col},${t.row}`).toBe(true);
    for (let c = plan.yard.col; c < plan.yard.col + plan.yard.span; c++) {
      for (let r = plan.yard.row; r < plan.yard.row + plan.yard.span; r++) expect(ground.has(k(c, r))).toBe(true);
    }
    for (const t of plan.yard.shore) expect(map.isLiquid(t.col, t.row) || city.roads.has(k(t.col, t.row))).toBe(false);
    expect(ground.has(k(plan.piers[0]!.berth.col, plan.piers[0]!.berth.row)), 'the berth stays open water').toBe(false);
  });

  it('grows with the city: a longer quay and more piers in a bigger one', () => {
    const small = cityOf(EGYPT_WORLD_PACK, createHornhoofLiveFixture());
    const big = cityOf(EGYPT_WORLD_PACK, createStress150LiveFixture());
    const a = riverPlan(planHarbour(EGYPT_WORLD_PACK, small.map, small.city));
    const b = riverPlan(planHarbour(EGYPT_WORLD_PACK, big.map, big.city));
    expect(big.city.buildings.length).toBeGreaterThan(small.city.buildings.length);
    expect(b.quay.length).toBeGreaterThan(a.quay.length);
    expect(b.piers.length).toBeGreaterThan(a.piers.length);
  });

  it('brings a created task down the river as a stone on a boat, unloads it at the pier into the yard, and sails back empty', () => {
    const { map, city } = cityOf(EGYPT_WORLD_PACK, createHornhoofLiveFixture());
    const plan = riverPlan(planHarbour(EGYPT_WORLD_PACK, map, city));
    const flow = { open: 1, arrivals: [new Date(T0).toISOString()] };
    const trips = scheduleBoats(plan, flow, 4);
    expect(trips).toHaveLength(1);
    const trip = trips[0]!;
    expect(trip.stones).toBe(1);

    const before = harbourAt(plan, trips, flow, trip.leaveMs - 1000);
    expect(before.carriers).toEqual([]);
    expect(before.yardStones).toBe(0);

    const sailing = harbourAt(plan, trips, flow, Math.round((trip.leaveMs + trip.mooredMs) / 2));
    expect(sailing.carriers).toHaveLength(1);
    expect(sailing.carriers[0]!.state).toBe('sail');
    expect(sailing.carriers[0]!.cargo).toBe(1);
    expect(['NE', 'SE', 'SW', 'NW']).toContain(sailing.carriers[0]!.facing);
    expect(sailing.yardStones).toBe(0);

    const moored = harbourAt(plan, trips, flow, trip.mooredMs + 1);
    const pier = plan.piers[trip.pier]!;
    expect(moored.carriers[0]!.col).toBeCloseTo(pier.berth.col, 6);
    expect(moored.carriers[0]!.row).toBeCloseTo(pier.berth.row, 6);
    /* Broadside along the pier: the hull lies the way the pier runs. */
    expect(moored.carriers[0]!.facing).toBe(pier.berthFacing);

    const unloaded = harbourAt(plan, trips, flow, trip.unloadedMs + 1);
    expect(unloaded.yardStones).toBe(1);
    expect(unloaded.carriers[0]!.cargo).toBe(0);
    expect(harbourAt(plan, trips, flow, trip.goneMs + 1).carriers).toEqual([]);
  });

  it('brings tasks that come together in one boat, never more blocks on a deck than the pack allows', () => {
    const { map, city } = cityOf(EGYPT_WORLD_PACK, createHornhoofLiveFixture());
    const plan = riverPlan(planHarbour(EGYPT_WORLD_PACK, map, city));
    const arrivals = [0, 2, 3, 5, 8, 9, 11].map(s => new Date(T0 + s * 1000).toISOString());
    const flow = { open: arrivals.length, arrivals };
    for (const max of [4, 3, 1]) {
      const trips = scheduleBoats(plan, flow, max);
      expect(trips.reduce((n, t) => n + t.stones, 0)).toBe(arrivals.length);
      expect(trips.length).toBe(Math.ceil(arrivals.length / max));
      for (const t of trips) expect(t.stones).toBeLessThanOrEqual(max);
      for (let at = T0 - 5000; at < trips[trips.length - 1]!.goneMs; at += 700) {
        for (const carrier of harbourAt(plan, trips, flow, at).carriers) expect(carrier.cargo).toBeLessThanOrEqual(max);
      }
    }
    expect(boatCargoMaxOf(EGYPT_WORLD_PACK)).toBe(4);
    expect(boatCargoMaxOf({ ...EGYPT_WORLD_PACK, harbour: { ...EGYPT_WORLD_PACK.harbour, boatCargoMax: 3 } })).toBe(3);
  });

  it('fills the yard with the open queue: what the boats have landed waits there', () => {
    const { map, city } = cityOf(EGYPT_WORLD_PACK, createHornhoofLiveFixture());
    const plan = riverPlan(planHarbour(EGYPT_WORLD_PACK, map, city));
    /* Long since landed: the yard holds the whole queue. */
    for (const open of [0, 1, 2, 3, 5, 6, 9, 10, 14, 15, 40]) {
      const flow = { open, arrivals: [] };
      const state = harbourAt(plan, scheduleBoats(plan, flow, 4), flow, T0);
      expect(state.yardStones).toBe(open);
      expect(state.yardStage).toBe(yardFillStage(open));
    }
    expect(YARD_FILL_STEPS).toEqual([1, 3, 6, 10, 15]);
    expect([0, 1, 2, 3, 5, 6, 9, 10, 14, 15, 40].map(yardFillStage)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    /* Stones still on a boat are not in the yard yet. */
    const flow = { open: 5, arrivals: [new Date(T0).toISOString(), new Date(T0 + 1000).toISOString()] };
    const trips = scheduleBoats(plan, flow, 4);
    expect(harbourAt(plan, trips, flow, trips[0]!.leaveMs + 10).yardStones).toBe(3);
    expect(harbourAt(plan, trips, flow, trips[0]!.unloadedMs + 1).yardStones).toBe(5);
  });

  it('draws the same harbour, boats and yard from the same data', () => {
    const one = cityOf(EGYPT_WORLD_PACK, createHornhoofLiveFixture());
    const two = cityOf(EGYPT_WORLD_PACK, createHornhoofLiveFixture());
    const a = planHarbour(EGYPT_WORLD_PACK, one.map, one.city);
    const b = planHarbour(EGYPT_WORLD_PACK, two.map, two.city);
    expect(b).toEqual(a);
    const arrivals = [0, 4, 40, 41, 90].map(s => new Date(T0 + s * 1000).toISOString());
    const flow = { open: 7, arrivals };
    const ta = scheduleBoats(a!, flow, 4);
    const tb = scheduleBoats(b!, flow, 4);
    expect(tb).toEqual(ta);
    for (let at = T0; at < T0 + 300_000; at += 3333) expect(harbourAt(b!, tb, flow, at)).toEqual(harbourAt(a!, ta, flow, at));
  });

  it('brings the work by caravan through a gate at the city’s edge where no boat can sail', () => {
    const live = createHornhoofLiveFixture();
    const { map, city } = cityOf(DUNGEON_WORLD_PACK, live);
    const plan = planHarbour(DUNGEON_WORLD_PACK, map, city);
    expect(plan?.kind).toBe('gate');
    if (plan?.kind !== 'gate') return;
    const taken = (col: number, row: number) => city.footprintOccupant.has(k(col, row)) || city.roads.has(k(col, row)) || city.wallTiles.has(k(col, row));
    for (let c = plan.gate.col; c < plan.gate.col + 2; c++) {
      for (let r = plan.gate.row; r < plan.gate.row + 2; r++) {
        expect(taken(c, r) || !(map.isWalkable(c, r) || map.isExcavatable(c, r)), `gate ${c},${r}`).toBe(false);
      }
    }
    /* The caravan walks in from the map's edge to the gate the way a road goes: over open ground or rock it carves,
       never through lava, a building or a wall. */
    const first = plan.caravanRoute[0]!;
    const b = map.bounds;
    expect(first.col === b.minCol || first.col === b.maxCol || first.row === b.minRow || first.row === b.maxRow).toBe(true);
    for (const t of plan.caravanRoute) {
      expect((map.isWalkable(t.col, t.row) || map.isExcavatable(t.col, t.row)) && !map.isLiquid(t.col, t.row), `caravan ${t.col},${t.row}`).toBe(true);
      expect(city.footprintOccupant.has(k(t.col, t.row)) || city.wallTiles.has(k(t.col, t.row)), `caravan ${t.col},${t.row}`).toBe(false);
    }
    expect(plan.yard.spots.length).toBeGreaterThan(0);
    const flow = { open: 2, arrivals: [new Date(T0).toISOString()] };
    const trips = scheduleBoats(plan, flow, 4);
    expect(trips).toHaveLength(1);
    expect(harbourAt(plan, trips, flow, trips[0]!.unloadedMs + 1).yardStones).toBe(2);
  });
});
