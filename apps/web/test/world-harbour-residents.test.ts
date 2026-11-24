import type { WorldLiveSnapshot } from '@hornhoof/protocol/world';
import { describe, expect, it } from 'vitest';
import type { CityState } from '../src/world/city-layout';
import { planHarbour, type HarbourPlan, type HarbourYard } from '../src/world/harbour';
import { createHornhoofLiveFixture, syncLiveSnapshotToCity } from '../src/world/live-sync';
import { createResidentSimulation, stepResidentSimulation, type ResidentEntity, type ResidentSimulation } from '../src/world/residents';
import { generateWorldTerrain } from '../src/world/terrain-engine';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

/* #2006, Ivan 23.11: a task taken is a stone its agent's resident carries from the harbour's yard to the building; a
   task returned is a stone a checker carries back to the yard. With no harbour shown, the stones come as before. */

const pack = EGYPT_WORLD_PACK;

function cityOf(live: WorldLiveSnapshot): { city: CityState; plan: HarbourPlan } {
  const map = generateWorldTerrain(pack, { seed: live.company.seed, mapSize: 150 });
  const { city } = syncLiveSnapshotToCity(pack, map, live);
  const plan = planHarbour(pack, map, city);
  expect(plan).not.toBeNull();
  return { city, plan: plan! };
}

const onYard = (yard: HarbourYard, col: number, row: number): boolean =>
  Math.round(col) >= yard.col && Math.round(col) < yard.col + yard.span && Math.round(row) >= yard.row && Math.round(row) < yard.row + yard.span;

type LegEnd = Readonly<{ id: string; from: ResidentEntity['leg']; col: number; row: number; carrying: ResidentEntity['carrying']; pose: ResidentEntity['pose'] }>;

/* Steps the city and notes every resident at the moment one of its walks ends, with what it holds in the pause there,
   and what it holds while it walks each leg. */
function walk(sim: ResidentSimulation, seconds: number) {
  const ends: LegEnd[] = [];
  const carried = new Map<string, Map<ResidentEntity['leg'], Set<ResidentEntity['carrying']>>>();
  const leg = new Map(sim.residents.map(r => [r.id, r.leg]));
  for (let tick = 0; tick < seconds * 10; tick++) {
    stepResidentSimulation(sim, 0.1);
    for (const r of sim.residents) {
      const was = leg.get(r.id)!;
      if (was !== r.leg) ends.push({ id: r.id, from: was, col: r.col, row: r.row, carrying: r.carrying, pose: r.pose });
      else if (r.actionTimer === 0 && r.pathIndex > 0) {
        const byLeg = carried.get(r.id) ?? new Map();
        const kinds = byLeg.get(r.leg) ?? new Set();
        kinds.add(r.carrying);
        byLeg.set(r.leg, kinds);
        carried.set(r.id, byLeg);
      }
      leg.set(r.id, r.leg);
    }
  }
  return { ends, carried };
}

/* An agent's resident that brings stones; a one-shot call's day laborer takes no task from the queue. */
const isCarrier = (r: ResidentEntity) =>
  r.liveState === 'working' && r.workSpot !== null && (r.archetype === 'builder' || r.roleClass === 'turnkey');

describe('Residents take the stones at the harbour yard (#2006)', () => {
  it('a taken task: its resident fetches the stone from the yard, dresses it there, and carries it to its building', () => {
    const live = createHornhoofLiveFixture();
    const { city, plan } = cityOf(live);
    const sim = createResidentSimulation(pack, city, live, { harbour: plan, harbourShown: true });
    const carriers = sim.residents.filter(isCarrier);
    expect(carriers.length).toBeGreaterThan(2);
    for (const r of carriers) {
      expect(r.yardSpot, r.name).not.toBeNull();
      expect(plan.yard.spots.some(s => s.col === r.yardSpot!.col && s.row === r.yardSpot!.row), r.name).toBe(true);
    }
    const ids = new Set(carriers.map(r => r.id));
    const { ends, carried } = walk(sim, 160);
    const atYard = ends.filter(e => ids.has(e.id) && e.from === 'inbound');
    const atSite = ends.filter(e => ids.has(e.id) && e.from === 'outbound');
    expect(atYard.length).toBeGreaterThan(2);
    expect(atSite.length).toBeGreaterThan(2);
    for (const e of atYard) {
      /* Back at the yard: on it, holding the next stone while it dresses it. */
      expect(onYard(plan.yard, e.col, e.row), `${e.id} at ${e.col},${e.row}`).toBe(true);
      expect(e.carrying).toBe('stone');
      expect(e.pose).toBe('building');
    }
    for (const e of atSite) expect(onYard(plan.yard, e.col, e.row), e.id).toBe(false);
    for (const id of ids) {
      const legs = carried.get(id);
      if (!legs) continue;
      /* To the building with a stone, back to the yard with empty hands. */
      if (legs.has('outbound')) expect([...legs.get('outbound')!], id).toEqual(['stone']);
      if (legs.has('inbound')) expect([...legs.get('inbound')!], id).toEqual(['none']);
    }
  });

  it('a returned task: the checker carries the stone from the building back to the yard', () => {
    const base = createHornhoofLiveFixture();
    const live: WorldLiveSnapshot = {
      ...base,
      agents: base.agents.map(a => (a.liveState === 'working' ? { ...a, hasRecentRework: true } : a)),
    };
    const { city, plan } = cityOf(live);
    const sim = createResidentSimulation(pack, city, live, { harbour: plan, harbourShown: true });
    /* A checker at a building takes the stone back; one out at the gates has none to take. */
    const checkers = sim.residents.filter(r => r.roleClass === 'checker' && r.liveState === 'working' && r.hasRecentRework && r.workSpot);
    expect(checkers.length).toBeGreaterThan(0);
    for (const r of checkers) expect(r.yardSpot, r.name).not.toBeNull();
    const ids = new Set(checkers.map(r => r.id));
    const { ends, carried } = walk(sim, 160);
    const back = ends.filter(e => ids.has(e.id) && e.from === 'inbound');
    expect(back.length).toBeGreaterThan(0);
    for (const e of back) expect(onYard(plan.yard, e.col, e.row), `${e.id} at ${e.col},${e.row}`).toBe(true);
    for (const id of ids) {
      const legs = carried.get(id);
      if (legs?.has('inbound')) expect([...legs.get('inbound')!], id).toEqual(['returned_stone']);
    }
  });

  it('when the art comes in while a resident walks home, its next walk still starts from where it stands', () => {
    const live = createHornhoofLiveFixture();
    const { city, plan } = cityOf(live);
    const sim = createResidentSimulation(pack, city, live, { harbour: plan });
    const carriers = new Set(sim.residents.filter(isCarrier).map(r => r.id));
    let switched = false;
    const leg = new Map(sim.residents.map(r => [r.id, r.leg]));
    let checked = 0;
    for (let tick = 0; tick < 1600; tick++) {
      if (tick === 300) {
        sim.harbour!.shown = true;
        switched = true;
      }
      stepResidentSimulation(sim, 0.1);
      for (const r of sim.residents) {
        /* A stone is dressed at the yard only: nowhere else does a carrier stand over a stone it holds. */
        if (carriers.has(r.id) && r.pose === 'building' && r.carrying === 'stone') {
          expect(onYard(plan.yard, r.col, r.row), `${r.name} dresses a stone at ${r.col},${r.row}`).toBe(true);
        }
        const was = leg.get(r.id);
        leg.set(r.id, r.leg);
        if (!switched || !carriers.has(r.id) || was !== 'inbound' || r.leg !== 'outbound') continue;
        /* The new walk's first step is a road tile next to where the resident stands, never one across the city. */
        const first = r.path[0]!;
        expect(Math.hypot(first.col - r.col, first.row - r.row), `${r.name} at ${r.col},${r.row} starts at ${first.col},${first.row}`).toBeLessThan(2.5);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(3);
  });

  it.each([
    ['no harbour', false],
    ['a harbour with no art to draw it', true],
  ])('with %s, a resident brings its stone from home as before', (_name, planned) => {
    const live = createHornhoofLiveFixture();
    const { city, plan: placed } = cityOf(live);
    const sim = createResidentSimulation(pack, city, live, planned ? { harbour: placed } : {});
    const carriers = sim.residents.filter(isCarrier);
    if (!planned) for (const r of carriers) expect(r.yardSpot).toBeNull();
    const homes = new Map(carriers.map(r => [r.id, r.homeTile]));
    const { ends } = walk(sim, 160);
    const home = ends.filter(e => homes.has(e.id) && e.from === 'inbound');
    expect(home.length).toBeGreaterThan(2);
    /* It ends each walk back on the road by its home, never at the yard. */
    const { plan } = cityOf(live);
    for (const e of home) {
      const h = homes.get(e.id)!;
      expect(Math.hypot(e.col - h.col, e.row - h.row), e.id).toBeLessThanOrEqual(3);
      expect(onYard(plan.yard, e.col, e.row), e.id).toBe(false);
    }
  });
});
