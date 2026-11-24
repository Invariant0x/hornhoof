/* Roads grow with the residents' real trips (#2003). The trips come only from the company's records: an agent goes
   from its department to its house and back for every task it had accepted and for the one it is on, a goal's finished
   tasks are carried from its department to its monument, a statue's stages from its department to the statue. Idle
   residents, wandering, talks and the hour of the day make no trip. Each trip takes the shortest road route between
   the two doors, searched in a fixed order, so the same records on the same streets always give the same traffic.
   A street rises in kind with its traffic (the construction count it keeps plus the trips over it) and never goes
   down, and the busiest straight stretches widen into the 2-tile avenue onto open land beside them. */

import type { WorldLiveAgent, WorldLiveGoal, WorldLiveSnapshot } from '@hornhoof/protocol/world';
import {
  canWalkRoad,
  raiseRoadTier,
  roadTierForTraffic,
  setRoadTile,
  tileKey,
  type AvenueLine,
  type CityBuilding,
  type CityState,
  type LotRect,
  type RoadTile,
} from './city-layout';
import type { TileCoord } from './coords';
import type { GeneratedWorldMap } from './terrain-engine';

/* Trips along one route: from one door to another, and back. */
export type Trip = Readonly<{ from: TileCoord; to: TileCoord; walks: number }>;

/* A straight stretch of at least AVENUE_RUN tiles, each this busy, widens into the avenue. */
export const AVENUE_TRAFFIC = 200;
export const AVENUE_RUN = 4;

/* The search order of the four steps, fixed so the same streets always give the same route. */
const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

type Doors = Readonly<{
  department: ReadonlyMap<string, TileCoord>;
  house: ReadonlyMap<string, TileCoord>;
  monument: ReadonlyMap<string, TileCoord>;
  residence: TileCoord | null;
  statues: readonly CityBuilding[];
}>;

function doorsOf(city: CityState): Doors {
  const department = new Map<string, TileCoord>();
  const house = new Map<string, TileCoord>();
  const monument = new Map<string, TileCoord>();
  for (const b of city.buildings) {
    if (b.kind === 'department' && b.departmentId) department.set(b.departmentId, b.door);
    if (b.kind === 'house' && b.entityId) house.set(b.entityId, b.door);
    if (b.kind === 'monument' && b.entityId) monument.set(b.entityId, b.door);
  }
  const residence = city.buildings.find(b => b.kind === 'residence')?.door ?? null;
  return { department, house, monument, residence, statues: city.buildings.filter(b => b.kind === 'statue' && b.departmentId) };
}

/* Trips between two doors, none when a door is missing or there is no walk. */
const tripsBetween = (from: TileCoord | null | undefined, to: TileCoord | null | undefined, walks: number): Trip[] =>
  from && to && walks > 0 ? [{ from, to, walks }] : [];

/* An agent's trips: from its department to its house and back for each task it had accepted and for the one it is on,
   and for the one it is on to its goal's monument. */
function agentTrips(doors: Doors, agent: WorldLiveAgent): Trip[] {
  const work = agent.departmentId ? doors.department.get(agent.departmentId) : undefined;
  const onTask = agent.currentTask ? 1 : 0;
  const goalId = agent.currentTask?.goalId;
  return [
    ...tripsBetween(work, doors.house.get(agent.id), agent.acceptedTasks + onTask),
    ...tripsBetween(work, goalId ? doors.monument.get(goalId) : undefined, onTask),
  ];
}

/* A goal's finished tasks, carried from its department (the residence for a company goal) to its monument. */
function goalTrips(doors: Doors, goal: WorldLiveGoal): Trip[] {
  return tripsBetween(goal.departmentId ? doors.department.get(goal.departmentId) : doors.residence, doors.monument.get(goal.id), goal.tasksDone);
}

/* The trips the company's records make between the city's buildings; a statue's stages are carried from its
   department. */
export function recordTrips(city: CityState, snapshot: Pick<WorldLiveSnapshot, 'agents' | 'goals'>): Trip[] {
  const doors = doorsOf(city);
  return [
    ...snapshot.agents.flatMap(a => agentTrips(doors, a)),
    ...snapshot.goals.flatMap(g => goalTrips(doors, g)),
    ...doors.statues.flatMap(s => tripsBetween(doors.department.get(s.departmentId!), s.door, s.stage)),
  ];
}

/* Every road tile reached from a door, with the tile it was reached from: a breadth-first search in STEPS order. */
function routesFrom(city: CityState, from: TileCoord): ReadonlyMap<string, string | null> {
  const start = tileKey(from.col, from.row);
  const parent = new Map<string, string | null>();
  if (!city.roads.has(start)) return parent;
  parent.set(start, null);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const road = city.roads.get(queue[i]!)!;
    for (const [dc, dr] of STEPS) {
      const k = tileKey(road.col + dc, road.row + dr);
      if (parent.has(k) || !city.roads.has(k)) continue;
      parent.set(k, queue[i]!);
      queue.push(k);
    }
  }
  return parent;
}

/* How many trips pass over each road tile, by tile key: every trip over the shortest road route between its doors.
   A trip whose doors no road joins passes over nothing. */
export function movementTraffic(city: CityState, trips: readonly Trip[]): Map<string, number> {
  const traffic = new Map<string, number>();
  const searched = new Map<string, ReadonlyMap<string, string | null>>();
  for (const trip of trips) {
    const fromKey = tileKey(trip.from.col, trip.from.row);
    const parent = searched.get(fromKey) ?? routesFrom(city, trip.from);
    searched.set(fromKey, parent);
    const goal = tileKey(trip.to.col, trip.to.row);
    if (!parent.has(goal)) continue;
    for (let k: string | null = goal; k !== null; k = parent.get(k) ?? null) traffic.set(k, (traffic.get(k) ?? 0) + trip.walks);
  }
  return traffic;
}

/* Raises every road to the kind its traffic reaches, then widens the busiest straight stretches into avenues. */
export function growRoadsWithTraffic(city: CityState, map: GeneratedWorldMap, movement: ReadonlyMap<string, number>): void {
  for (const [k, road] of city.roads) raiseRoadTier(road, roadTierForTraffic(road.traffic + (movement.get(k) ?? 0)));
  widenBusyStretches(city, map, movement);
}

/* A tile of a stretch that may widen: busy enough, on land, not yet an avenue and not the starter avenue. */
function widens(city: CityState, movement: ReadonlyMap<string, number>, col: number, row: number): boolean {
  const k = tileKey(col, row);
  const road = city.roads.get(k);
  return Boolean(road && !road.bridge && !road.grandAvenue && road.tier !== 'avenue' && road.traffic + (movement.get(k) ?? 0) >= AVENUE_TRAFFIC);
}

const inLot = (l: LotRect, col: number, row: number): boolean => col >= l.col && col < l.col + l.spanCol && row >= l.row && row < l.row + l.spanRow;

/* Open land a road may be laid on that no lot, wall or cleared lot holds. */
function openLand(city: CityState, map: GeneratedWorldMap, col: number, row: number): boolean {
  const k = tileKey(col, row);
  if (city.lotReservation.has(k) || city.wallTiles.has(k)) return false;
  return !city.vacatedLots.some(l => inLot(l, col, row)) && canWalkRoad(city, map, col, row, false);
}

/* Whether an avenue's lane may take a tile: a street that is not the bridge, the starter avenue or an avenue, or open
   land. */
function laneOpen(city: CityState, map: GeneratedWorldMap, col: number, row: number): boolean {
  const road = city.roads.get(tileKey(col, row));
  if (!road) return openLand(city, map, col, row);
  return !road.bridge && !road.grandAvenue && road.tier !== 'avenue';
}

type Lane = Readonly<{ from: number; to: number; side: -1 | 1 }>;

/* The longest part of a stretch, at least AVENUE_RUN tiles, whose lane on one side is open all along it: the +1 side
   first, so the choice is the same every time. */
function laneBeside(city: CityState, map: GeneratedWorldMap, run: readonly RoadTile[], axis: AvenueLine['axis']): Lane | null {
  let best: Lane | null = null;
  for (const side of [1, -1] as const) {
    const [dc, dr] = axis === 'u' ? [0, side] : [side, 0];
    let from = 0;
    for (let i = 0; i <= run.length; i++) {
      if (i < run.length && laneOpen(city, map, run[i]!.col + dc, run[i]!.row + dr)) continue;
      if (i - from >= AVENUE_RUN && (!best || i - from > best.to - best.from + 1)) best = { from, to: i - 1, side };
      from = i + 1;
    }
  }
  return best;
}

/* Makes a stretch and its lane an avenue. */
function layAvenue(city: CityState, map: GeneratedWorldMap, run: readonly RoadTile[], axis: AvenueLine['axis'], side: -1 | 1): void {
  const [dc, dr] = axis === 'u' ? [0, side] : [side, 0];
  for (const road of run) {
    const lane = city.roads.get(tileKey(road.col + dc, road.row + dr)) ?? setRoadTile(city, map, road.col + dc, road.row + dr, { trafficDelta: 0 });
    road.tier = 'avenue';
    road.avenue = { axis, side };
    lane.tier = 'avenue';
    lane.avenue = { axis, side: side === 1 ? -1 : 1 };
  }
}

/* The busy stretches along each axis, from their first tile, in a fixed order; each widens where it has a lane. */
function widenBusyStretches(city: CityState, map: GeneratedWorldMap, movement: ReadonlyMap<string, number>): void {
  const tiles = [...city.roads.values()].sort((a, b) => a.row - b.row || a.col - b.col);
  for (const axis of ['u', 'v'] as const) {
    const [dc, dr] = axis === 'u' ? [1, 0] : [0, 1];
    for (const t of tiles) {
      if (!widens(city, movement, t.col, t.row) || widens(city, movement, t.col - dc, t.row - dr)) continue;
      const run: RoadTile[] = [];
      for (let i = 0; widens(city, movement, t.col + dc * i, t.row + dr * i); i++) run.push(city.roads.get(tileKey(t.col + dc * i, t.row + dr * i))!);
      const lane = run.length >= AVENUE_RUN ? laneBeside(city, map, run, axis) : null;
      if (lane) layAvenue(city, map, run.slice(lane.from, lane.to + 1), axis, lane.side);
    }
  }
}
