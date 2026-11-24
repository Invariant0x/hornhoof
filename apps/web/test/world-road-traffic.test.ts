/* Roads grow with the residents' real trips (#2003): a street's kind rises with the trips the company's records make
   along it (an agent's accepted tasks between its house and its department, a goal's finished tasks carried to its
   monument), never with idle or wandering residents, and the busiest straight stretches widen into the 2-tile avenue.
   The same company data always gives the same roads. */
import type { WorldLiveSnapshot } from '@hornhoof/protocol/world';
import { describe, expect, it } from 'vitest';
import { roadTierForTraffic, serializeCityLayout, tileKey, type CityState, type RoadTile } from '../src/world/city-layout';
import { createHornhoofLiveFixture, syncLiveSnapshotToCity } from '../src/world/live-sync';
import { createResidentSimulation, stepResidentSimulation } from '../src/world/residents';
import { AVENUE_RUN } from '../src/world/road-traffic';
import { generateWorldTerrain, type GeneratedWorldMap } from '../src/world/terrain-engine';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

const SEEDS = ['hornhoof', 'acme-corp', 'solar-labs'] as const;
const RANK: Readonly<Record<string, number>> = { trail: 0, dirt: 1, brick: 2, stone: 3, avenue: 4 };
const maps = new Map<string, GeneratedWorldMap>();
const mapOf = (seed: string): GeneratedWorldMap => {
  const have = maps.get(seed);
  if (have) return have;
  const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed, mapSize: EGYPT_WORLD_PACK.mapSize });
  maps.set(seed, map);
  return map;
};

/* The live fixture, a grown company, on a seed. */
function grown(seed: string): WorldLiveSnapshot {
  const live = createHornhoofLiveFixture();
  return { ...live, company: { ...live.company, seed } };
}

/* The same company in its first days: every agent with one accepted task, every goal with one finished task. */
function young(seed: string): WorldLiveSnapshot {
  const live = grown(seed);
  return {
    ...live,
    agents: live.agents.map(a => ({ ...a, acceptedTasks: Math.min(1, a.acceptedTasks) })),
    goals: live.goals.map(g => ({ ...g, tasksDone: Math.min(1, g.tasksDone) })),
  };
}

const cityOf = (snapshot: WorldLiveSnapshot, existing?: CityState | null): CityState =>
  syncLiveSnapshotToCity(EGYPT_WORLD_PACK, mapOf(snapshot.company.seed), snapshot, existing ?? null).city;

const roadsOf = (city: CityState): string[] =>
  [...city.roads.values()].map(r => `${r.col},${r.row}:${r.tier}:${JSON.stringify(r.avenue ?? null)}`).sort();

const doorOf = (city: CityState, test: (b: CityState['buildings'][number]) => boolean) => city.buildings.find(test)?.door;

/* The shortest road route between two tiles over the roads that pass `over`, or none. */
function route(city: CityState, from: { col: number; row: number }, to: { col: number; row: number }, over: (r: RoadTile) => boolean = () => true): RoadTile[] {
  const start = tileKey(from.col, from.row);
  const goal = tileKey(to.col, to.row);
  const parent = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  for (let i = 0; i < queue.length && !parent.has(goal); i++) {
    const r = city.roads.get(queue[i]!)!;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const k = tileKey(r.col + dc, r.row + dr);
      if (!city.roads.has(k) || !over(city.roads.get(k)!) || parent.has(k)) continue;
      parent.set(k, queue[i]!);
      queue.push(k);
    }
  }
  if (!city.roads.has(start) || !parent.has(goal)) return [];
  const out: RoadTile[] = [];
  for (let k: string | null = goal; k; k = parent.get(k) ?? null) out.push(city.roads.get(k)!);
  return out;
}

/* The avenues of a city: tiles of the avenue kind grouped by the middle line they share, a line holding two avenues
   apart where a step along it has no avenue tile. */
function avenuesOf(city: CityState): Map<string, RoadTile[]> {
  const lines = new Map<string, RoadTile[]>();
  for (const r of city.roads.values()) {
    if (r.tier !== 'avenue') continue;
    expect(r.avenue, `${r.col},${r.row} avenue without its line`).toBeDefined();
    const { axis, side } = r.avenue!;
    const key = `${axis}|${(axis === 'u' ? r.row : r.col) + 0.5 + side / 2}`;
    lines.set(key, [...(lines.get(key) ?? []), r]);
  }
  const out = new Map<string, RoadTile[]>();
  for (const [line, tiles] of lines) {
    const along = (r: RoadTile) => (r.avenue!.axis === 'u' ? r.col : r.row);
    const steps = [...new Set(tiles.map(along))].sort((a, b) => a - b);
    let from = steps[0]!;
    steps.forEach((step, i) => {
      if (steps[i + 1] === step + 1) return;
      out.set(`${line}|${from}`, tiles.filter(r => along(r) >= from && along(r) <= step));
      from = steps[i + 1]!;
    });
  }
  return out;
}

describe('roads that grow with real trips', () => {
  it('give every road the same kind from the same company data: built afresh, reloaded from its saved layout and synced again', () => {
    for (const seed of SEEDS) {
      const first = cityOf(grown(seed));
      expect(roadsOf(cityOf(grown(seed))), seed).toEqual(roadsOf(first));
      const reloaded = cityOf({ ...grown(seed), savedLayout: serializeCityLayout(first) });
      expect(roadsOf(reloaded), `${seed} reloaded`).toEqual(roadsOf(first));
      const before = roadsOf(first);
      expect(roadsOf(cityOf(grown(seed), first)), `${seed} synced again`).toEqual(before);
    }
  });

  it("raise a road along the route of an agent's accepted tasks between its house and its department", () => {
    for (const seed of SEEDS) {
      const live = grown(seed);
      const city = cityOf(live);
      const busiest = [...live.agents].filter(a => a.departmentId).sort((a, b) => b.acceptedTasks - a.acceptedTasks)[0]!;
      const house = doorOf(city, b => b.kind === 'house' && b.entityId === busiest.id)!;
      const department = doorOf(city, b => b.kind === 'department' && b.departmentId === busiest.departmentId)!;
      const shortest = route(city, house, department).length;
      expect(shortest, seed).toBeGreaterThan(1);
      /* One of the shortest routes is raised all along to the kind those trips reach. */
      const floor = roadTierForTraffic(busiest.acceptedTasks);
      expect(route(city, house, department, r => RANK[r.tier]! >= RANK[floor]!).length, `${seed} raised to ${floor}`).toBe(shortest);
    }
  });

  it('raise nothing for idle or wandering residents: only the records count', () => {
    const seed = 'hornhoof';
    const live = grown(seed);
    const working = cityOf({ ...live, agents: live.agents.map(a => ({ ...a, liveState: 'working' as const, resting: false, currentTask: null })) });
    const idle = cityOf({
      ...live,
      agents: live.agents.map((a, i) => ({ ...a, liveState: 'idle' as const, resting: true, currentTask: null, talkingToAgentId: live.agents[(i + 1) % live.agents.length]!.id, hasRecentRework: true })),
    });
    expect(roadsOf(idle)).toEqual(roadsOf(working));
    const before = roadsOf(working);
    const sim = createResidentSimulation(EGYPT_WORLD_PACK, working, live);
    for (let t = 0; t < 600; t++) stepResidentSimulation(sim, 0.5);
    expect(roadsOf(working), 'after the residents walked about').toEqual(before);
    expect(roadsOf(cityOf({ ...live, agents: live.agents.map(a => ({ ...a, liveState: 'idle' as const, currentTask: null })) }, working)), 'synced idle').toEqual(before);
  });

  it('widen the busiest straight stretch into a 2-tile avenue on free land beside it, and a young city has none', () => {
    let avenues = 0;
    for (const seed of SEEDS) {
      const map = mapOf(seed);
      const city = cityOf(grown(seed));
      for (const [line, tiles] of avenuesOf(city)) {
        avenues++;
        const { axis } = tiles[0]!.avenue!;
        const along = (r: RoadTile) => (axis === 'u' ? r.col : r.row);
        const across = (r: RoadTile) => (axis === 'u' ? r.row : r.col);
        const rows = new Set(tiles.map(across));
        expect(rows.size, `${seed} ${line} is two tiles wide`).toBe(2);
        const [a, b] = [...rows];
        const stepsOf = (row: number) => tiles.filter(r => across(r) === row).map(along).sort((x, y) => x - y);
        expect(stepsOf(a!), `${seed} ${line} both lanes run side by side`).toEqual(stepsOf(b!));
        const steps = stepsOf(a!);
        expect(steps.length, `${seed} ${line} long enough`).toBeGreaterThanOrEqual(AVENUE_RUN);
        expect(steps.at(-1)! - steps[0]!, `${seed} ${line} straight and unbroken`).toBe(steps.length - 1);
        for (const r of tiles) {
          const k = tileKey(r.col, r.row);
          expect(map.isLiquid(r.col, r.row) || r.bridge, `${seed} ${k} on water`).toBe(false);
          expect(city.footprintOccupant.has(k), `${seed} ${k} under a building`).toBe(false);
          expect(city.wallTiles.has(k), `${seed} ${k} under the wall`).toBe(false);
          expect(r.grandAvenue, `${seed} ${k} is the starter avenue`).toBe(false);
        }
      }
      expect(avenuesOf(cityOf(young(seed))).size, `${seed} young`).toBe(0);
    }
    expect(avenues, 'avenues in the grown cities').toBeGreaterThan(0);
  });

  it('keep the starter avenue, and never lower a kind once raised', () => {
    for (const seed of SEEDS) {
      const city = cityOf(grown(seed));
      const starter = [...city.roads.values()].filter(r => r.grandAvenue);
      expect(starter.length, seed).toBeGreaterThan(0);
      for (const r of starter) expect(RANK[r.tier], `${seed} ${r.col},${r.row}`).toBeGreaterThanOrEqual(RANK.brick!);
      const raised = new Map([...city.roads.values()].map(r => [tileKey(r.col, r.row), r.tier]));
      const again = cityOf(young(seed), city);
      for (const [k, tier] of raised) expect(RANK[again.roads.get(k)?.tier ?? 'trail'], `${seed} ${k}`).toBeGreaterThanOrEqual(RANK[tier]!);
    }
  });
});
