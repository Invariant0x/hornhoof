/* Where the work comes from (#2006, Ivan 23.11): every new task comes down the river as a stone block on a cargo boat
   to a small harbour (a quay on the bank, wooden piers into the river, a stone yard behind), and waits in the yard until
   an agent takes it. The yard is the open queue. A world with no river a boat can sail brings the same stones by
   caravan through a gate at the city's edge. Everything here follows the real task states the world gets
   (WorldLiveTaskFlow): the same data and the same moment give the same picture. Contains zero theme-specific words. */

import type { WorldLiveTaskFlow } from '@hornhoof/protocol/world';
import type { CityState } from './city-layout';
import { facingOfStep, type TileCoord } from './coords';
import type { Direction8, WorldPackManifest } from './manifest';
import type { GeneratedWorldMap } from './terrain-engine';

/* The most blocks a deck shows when the pack does not say (Design: up to 4 in one row, never stacked). */
export const BOAT_CARGO_MAX_DEFAULT = 4;
/* Stones in the yard at which its fill picture steps up from fill_0 (empty) to fill_5 (full). */
export const YARD_FILL_STEPS: readonly number[] = [1, 3, 6, 10, 15];

/* Tasks created this close after the first of a batch come in the same boat, as many as a deck shows. */
const BATCH_MS = 20_000;
const BOAT_TILES_PER_SEC = 1.5;
const CARAVAN_TILES_PER_SEC = 1;
/* How far up the river a boat comes into sight: the last stretch of its route to the pier. */
const BOAT_RUN_TILES = 36;
/* At the pier: a moment to moor, then one block off the deck at a time. */
const MOOR_MS = 1_500;
const UNLOAD_MS_PER_STONE = 2_500;
/* After the last block is off, how long the berth stays taken while the boat casts off. */
const BERTH_CLEAR_MS = 2_000;
/* How far from the city centre the harbour may stand, in tiles. */
const SEARCH_RADIUS = 40;
/* Water tiles a pier runs out from the quay. */
const PIER_LENGTH = 2;
/* Free shore tiles that may lie between the quay and its yard. */
const YARD_GAP = 2;
/* How far, in steps across the ground, a yard spot's road may be from the yard's edge. */
const YARD_ROAD_REACH = 2;

export type HarbourSide = 'a' | 'b';
type Step = Readonly<{ dc: number; dr: number }>;

/* Where a resident stands on the yard to take a stone or put one back, reached from the road at approach. */
export type YardSpot = Readonly<{ col: number; row: number; approach: TileCoord; facing: Direction8 }>;
export type HarbourYard = Readonly<{
  col: number;
  row: number;
  span: number;
  spots: readonly YardSpot[];
  /* Free shore between the quay and the yard, part of the harbour's ground. */
  shore: readonly TileCoord[];
}>;
export type HarbourPier = Readonly<{
  /* From the quay out over the water: the root first, the head last. */
  tiles: readonly TileCoord[];
  /* Where a boat lies broadside along the pier at its last tile, and the way its hull points there. */
  berth: TileCoord;
  berthFacing: Direction8;
  /* The water a boat sails from where it comes into sight to the berth. */
  route: readonly TileCoord[];
}>;
export type RiverHarbourPlan = Readonly<{
  kind: 'river';
  /* a: the bank runs from top left to bottom right on screen, the water lower left; b: the other diagonal. */
  side: HarbourSide;
  water: Step;
  quay: readonly TileCoord[];
  piers: readonly HarbourPier[];
  yard: HarbourYard;
}>;
export type GateHarbourPlan = Readonly<{
  kind: 'gate';
  /* The 2x2 gate lot's top tile, and which diagonal the road through it runs. */
  gate: TileCoord;
  side: HarbourSide;
  /* From the map's edge over open land to the gate. */
  caravanRoute: readonly TileCoord[];
  yard: HarbourYard;
}>;
export type HarbourPlan = RiverHarbourPlan | GateHarbourPlan;

/* One boat (or caravan) trip: when it leaves, moors, has unloaded and is gone, all in ms. */
export type CarrierTrip = Readonly<{
  id: string;
  pier: number;
  stones: number;
  leaveMs: number;
  mooredMs: number;
  unloadedMs: number;
  goneMs: number;
}>;
export type CarrierState = Readonly<{
  id: string;
  kind: 'boat' | 'caravan';
  col: number;
  row: number;
  facing: Direction8;
  state: 'sail' | 'moored' | 'unload';
  cargo: number;
}>;
export type HarbourState = Readonly<{ carriers: readonly CarrierState[]; yardStones: number; yardStage: number }>;

const key = (col: number, row: number): string => `${col},${row}`;

/* The pack's deck limit, 1 to 4. */
export function boatCargoMaxOf(pack: WorldPackManifest): number {
  const max = pack.harbour?.boatCargoMax ?? BOAT_CARGO_MAX_DEFAULT;
  return Math.max(1, Math.min(BOAT_CARGO_MAX_DEFAULT, Math.floor(max)));
}

/* The yard's fill picture for a number of stones: 0 for none, up to 5 for a full yard. */
export function yardFillStage(stones: number): number {
  return YARD_FILL_STEPS.filter(step => stones >= step).length;
}

type HarbourSize = Readonly<{ quay: number; piers: number; yard: number }>;
const HARBOUR_SIZES: readonly HarbourSize[] = [
  { quay: 2, piers: 1, yard: 3 },
  { quay: 4, piers: 2, yard: 3 },
  { quay: 6, piers: 3, yard: 4 },
];

/* The harbour grows with the city, a longer quay and more piers for more buildings; where the bank has no room for that
   size, the largest that fits, down to the smallest. Largest first. */
function harbourSizes(city: CityState): readonly HarbourSize[] {
  const n = city.buildings.length;
  const grown = n >= 240 ? 2 : n >= 120 ? 1 : 0;
  return HARBOUR_SIZES.slice(0, grown + 1).reverse();
}

type Ground = Readonly<{
  map: GeneratedWorldMap;
  city: CityState;
  boatWater: (col: number, row: number) => boolean;
  /* Free dry ground a quay can stand on: the bank counts, though nothing is built on it. */
  shore: (col: number, row: number) => boolean;
  /* Free land a lot can take, as the city takes it: buildable, or rock it carves. */
  free: (col: number, row: number) => boolean;
  /* Ground a caravan walks, as a road does: walkable, or rock it carves; never water, a building or a wall. */
  walk: (col: number, row: number) => boolean;
}>;

function groundOf(pack: WorldPackManifest, map: GeneratedWorldMap, city: CityState): Ground {
  const liquids = new Set(pack.harbour?.boatLiquids ?? []);
  const b = map.bounds;
  const inMap = (col: number, row: number) => col >= b.minCol && col <= b.maxCol && row >= b.minRow && row <= b.maxRow;
  const taken = (col: number, row: number) => {
    const k = key(col, row);
    return city.footprintOccupant.has(k) || city.roads.has(k) || city.wallTiles.has(k) || city.lotReservation.has(k);
  };
  return {
    map,
    city,
    boatWater: (col, row) => inMap(col, row) && liquids.has(map.tileAt(col, row) ?? ''),
    shore: (col, row) => inMap(col, row) && map.isWalkable(col, row) && !map.isLiquid(col, row) && !taken(col, row),
    free: (col, row) =>
      inMap(col, row) && (map.isBuildable(col, row) || map.isExcavatable(col, row)) && !map.isLiquid(col, row) && !taken(col, row),
    walk: (col, row) => {
      const k = key(col, row);
      return (
        inMap(col, row) && (map.isWalkable(col, row) || map.isExcavatable(col, row)) && !map.isLiquid(col, row) &&
        !city.footprintOccupant.has(k) && !city.wallTiles.has(k)
      );
    },
  };
}

/* Every tile the harbour stands on, as "col,row": quay, piers, the shore behind, the yard, or the gate. Plants leave
   them while the harbour is drawn. */
export function harbourGround(plan: HarbourPlan): ReadonlySet<string> {
  const tiles: TileCoord[] = [...plan.yard.shore];
  for (let c = plan.yard.col; c < plan.yard.col + plan.yard.span; c++) {
    for (let r = plan.yard.row; r < plan.yard.row + plan.yard.span; r++) tiles.push({ col: c, row: r });
  }
  if (plan.kind === 'river') {
    tiles.push(...plan.quay);
    for (const pier of plan.piers) tiles.push(...pier.tiles);
  } else {
    for (let c = plan.gate.col; c < plan.gate.col + 2; c++) for (let r = plan.gate.row; r < plan.gate.row + 2; r++) tiles.push({ col: c, row: r });
  }
  return new Set(tiles.map(t => key(t.col, t.row)));
}

/* The harbour of a pack that has art slots for one; a pack without them never shows a harbour, so none is planned. */
export function harbourPlanFor(pack: WorldPackManifest, map: GeneratedWorldMap, city: CityState): HarbourPlan | null {
  return pack.art?.harbour ? planHarbour(pack, map, city) : null;
}

/* Where the harbour stands for this city, or null when there is nowhere for it. On the boat-water bank nearest the
   city centre whose water lies on the side the camera sees; with no such bank, a caravan gate at the city's edge. */
export function planHarbour(pack: WorldPackManifest, map: GeneratedWorldMap, city: CityState): HarbourPlan | null {
  const ground = groundOf(pack, map, city);
  return planRiver(ground) ?? planGate(ground);
}

const SIDES: readonly Readonly<{ side: HarbourSide; water: Step; along: Step }>[] = [
  { side: 'a', water: { dc: 0, dr: 1 }, along: { dc: 1, dr: 0 } },
  { side: 'b', water: { dc: 1, dr: 0 }, along: { dc: 0, dr: 1 } },
];

function planRiver(g: Ground): RiverHarbourPlan | null {
  const c0 = g.city.center;
  const banks: { col: number; row: number; s: (typeof SIDES)[number]; d: number }[] = [];
  for (let row = c0.row - SEARCH_RADIUS; row <= c0.row + SEARCH_RADIUS; row++) {
    for (let col = c0.col - SEARCH_RADIUS; col <= c0.col + SEARCH_RADIUS; col++) {
      for (const s of SIDES) {
        if (g.shore(col, row) && g.boatWater(col + s.water.dc, row + s.water.dr)) {
          banks.push({ col, row, s, d: Math.hypot(col - c0.col, row - c0.row) });
        }
      }
    }
  }
  banks.sort((a, b) => a.d - b.d || a.row - b.row || a.col - b.col || (a.s.side < b.s.side ? -1 : 1));
  const routes = new Map<string, TileCoord[] | null>();
  for (const size of harbourSizes(g.city)) {
    for (const bank of banks) {
      const plan = riverAt(g, bank, bank.s, size, routes);
      if (plan) return plan;
    }
  }
  return null;
}

function riverAt(
  g: Ground,
  bank: TileCoord,
  s: (typeof SIDES)[number],
  size: HarbourSize,
  routes: Map<string, TileCoord[] | null>,
): RiverHarbourPlan | null {
  const { water, along } = s;
  const offsets = [...Array(size.quay).keys()].map(i => -i).sort((a, b) => Math.abs(a + (size.quay - 1) / 2) - Math.abs(b + (size.quay - 1) / 2) || b - a);
  for (const start of offsets) {
    const quay = [...Array(size.quay).keys()].map(i => ({ col: bank.col + (start + i) * along.dc, row: bank.row + (start + i) * along.dr }));
    if (!quay.every(q => g.shore(q.col, q.row) && g.boatWater(q.col + water.dc, q.row + water.dr))) continue;
    const piers: HarbourPier[] = [];
    for (let j = 0; j < size.piers; j++) {
      const q = quay[Math.min(size.quay - 1, Math.round(((j + 0.5) * size.quay) / size.piers - 0.5))]!;
      const pier = pierAt(g, q, water, along, routes);
      if (!pier) break;
      piers.push(pier);
    }
    if (piers.length < size.piers) continue;
    const yard = yardBehind(g, quay, water, along, size.yard);
    if (yard) return { kind: 'river', side: s.side, water, quay, piers, yard };
  }
  return null;
}

/* A pier straight out over the water from a quay tile, with water beside its head where a boat lies broadside and a
   way from there up the river. */
function pierAt(g: Ground, q: TileCoord, water: Step, along: Step, routes: Map<string, TileCoord[] | null>): HarbourPier | null {
  const tiles = [...Array(PIER_LENGTH).keys()].map(k => ({ col: q.col + water.dc * (k + 1), row: q.row + water.dr * (k + 1) }));
  if (!tiles.every(t => g.boatWater(t.col, t.row))) return null;
  const head = tiles[tiles.length - 1]!;
  for (const side of [1, -1]) {
    const berth = { col: head.col + side * along.dc, row: head.row + side * along.dr };
    const beside = { col: berth.col - water.dc, row: berth.row - water.dr };
    if (!g.boatWater(berth.col, berth.row) || !g.boatWater(beside.col, beside.row)) continue;
    const k = key(berth.col, berth.row);
    if (!routes.has(k)) routes.set(k, routeUpstream(g, berth));
    const route = routes.get(k);
    if (!route) continue;
    return { tiles, berth, berthFacing: facingOfStep(water.dc, water.dr), route };
  }
  return null;
}

/* The water a boat comes down: from the farthest map-edge water the berth reaches, its last stretch to the berth. */
function routeUpstream(g: Ground, berth: TileCoord): TileCoord[] | null {
  const b = g.map.bounds;
  const onEdge = (t: TileCoord) => t.col === b.minCol || t.col === b.maxCol || t.row === b.minRow || t.row === b.maxRow;
  const parent = new Map<string, string | null>([[key(berth.col, berth.row), null]]);
  const queue: TileCoord[] = [berth];
  let far: TileCoord | null = null;
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    if (onEdge(cur)) far = cur;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const n = { col: cur.col + dc, row: cur.row + dr };
      const nk = key(n.col, n.row);
      if (parent.has(nk) || !g.boatWater(n.col, n.row)) continue;
      parent.set(nk, key(cur.col, cur.row));
      queue.push(n);
    }
  }
  if (!far) return null;
  const path: TileCoord[] = [];
  for (let k: string | null | undefined = key(far.col, far.row); k; k = parent.get(k)) {
    const [c, r] = k.split(',');
    path.push({ col: Number(c), row: Number(r) });
  }
  return path.slice(-(BOAT_RUN_TILES + 1));
}

/* A square yard of free land behind the quay, across at most YARD_GAP tiles of free shore, with a spot a resident
   reaches from a road. */
function yardBehind(g: Ground, quay: readonly TileCoord[], water: Step, along: Step, span: number): HarbourYard | null {
  const first = quay[0]!;
  const shifts = [...Array(quay.length + span - 1).keys()]
    .map(i => i - (span - 1))
    .sort((a, b) => Math.abs(a + (span - quay.length) / 2) - Math.abs(b + (span - quay.length) / 2) || a - b);
  const at = (u: number, v: number): TileCoord => ({ col: first.col + u * along.dc - v * water.dc, row: first.row + u * along.dr - v * water.dr });
  for (let gap = 0; gap <= YARD_GAP; gap++) {
    for (const shift of shifts) {
      const tiles: TileCoord[] = [];
      const between: TileCoord[] = [];
      for (let u = shift; u < shift + span; u++) {
        for (let v = 1; v <= gap; v++) between.push(at(u, v));
        for (let v = gap + 1; v <= gap + span; v++) tiles.push(at(u, v));
      }
      if (!tiles.every(t => g.free(t.col, t.row)) || !between.every(t => g.shore(t.col, t.row))) continue;
      const yard = lotOf(tiles);
      const spots = yardSpots(g, yard);
      if (spots.length > 0) return { ...yard, spots, shore: between };
    }
  }
  return null;
}

function lotOf(tiles: readonly TileCoord[]): Readonly<{ col: number; row: number; span: number }> {
  const col = Math.min(...tiles.map(t => t.col));
  const row = Math.min(...tiles.map(t => t.row));
  return { col, row, span: Math.max(...tiles.map(t => t.col)) - col + 1 };
}

/* Spots a tenth of a tile inside the yard's two front edges, each with a road within reach of the tile outside it. */
function yardSpots(g: Ground, yard: Readonly<{ col: number; row: number; span: number }>): YardSpot[] {
  const spots: YardSpot[] = [];
  const edges: { tile: TileCoord; out: Step }[] = [];
  for (let i = 0; i < yard.span; i++) {
    edges.push({ tile: { col: yard.col + yard.span - 1, row: yard.row + i }, out: { dc: 1, dr: 0 } });
    edges.push({ tile: { col: yard.col + i, row: yard.row + yard.span - 1 }, out: { dc: 0, dr: 1 } });
  }
  for (const { tile, out } of edges) {
    const outside = { col: tile.col + out.dc, row: tile.row + out.dr };
    const approach = nearestRoad(g, outside);
    if (!approach) continue;
    spots.push({ col: tile.col + out.dc * 0.4, row: tile.row + out.dr * 0.4, approach, facing: facingOfStep(-out.dc, -out.dr) });
  }
  return spots;
}

function nearestRoad(g: Ground, at: TileCoord): TileCoord | null {
  for (let d = 0; d <= YARD_ROAD_REACH; d++) {
    for (let dr = -d; dr <= d; dr++) {
      for (let dc = -d; dc <= d; dc++) {
        if (Math.abs(dc) + Math.abs(dr) !== d) continue;
        if (g.city.roads.has(key(at.col + dc, at.row + dr))) return { col: at.col + dc, row: at.row + dr };
      }
    }
  }
  return null;
}

/* No boat water by the city: a 2x2 gate on free land beside the road farthest out, a yard beside it, and the way a
   caravan walks in from the map's edge. */
function planGate(g: Ground): GateHarbourPlan | null {
  const c0 = g.city.center;
  const roads = [...g.city.roads.values()]
    .map(r => ({ col: r.col, row: r.row, d: Math.hypot(r.col - c0.col, r.row - c0.row) }))
    .sort((a, b) => b.d - a.d || a.row - b.row || a.col - b.col)
    .slice(0, 24);
  const size = harbourSizes(g.city)[0]!;
  for (const road of roads) {
    const options: { gate: TileCoord; d: number }[] = [];
    for (let dr = -2; dr <= 1; dr++) {
      for (let dc = -2; dc <= 1; dc++) {
        const gate = { col: road.col + dc, row: road.row + dr };
        const tiles = [gate, { col: gate.col + 1, row: gate.row }, { col: gate.col, row: gate.row + 1 }, { col: gate.col + 1, row: gate.row + 1 }];
        if (!tiles.every(t => g.free(t.col, t.row) && g.walk(t.col, t.row))) continue;
        if (!tiles.some(t => Math.abs(t.col - road.col) + Math.abs(t.row - road.row) === 1)) continue;
        options.push({ gate, d: Math.hypot(gate.col + 0.5 - c0.col, gate.row + 0.5 - c0.row) });
      }
    }
    options.sort((a, b) => b.d - a.d || a.gate.row - b.gate.row || a.gate.col - b.gate.col);
    for (const { gate } of options) {
      const caravanRoute = routeInFromEdge(g, gate);
      if (!caravanRoute) continue;
      const yard = yardBeside(g, gate, size.yard);
      if (!yard) continue;
      const side: HarbourSide = Math.abs(road.col - (gate.col + 0.5)) > Math.abs(road.row - (gate.row + 0.5)) ? 'b' : 'a';
      return { kind: 'gate', gate, side, caravanRoute, yard };
    }
  }
  return null;
}

function yardBeside(g: Ground, gate: TileCoord, span: number): HarbourYard | null {
  const gateTiles = new Set([key(gate.col, gate.row), key(gate.col + 1, gate.row), key(gate.col, gate.row + 1), key(gate.col + 1, gate.row + 1)]);
  const origins: TileCoord[] = [];
  for (let dr = -span; dr <= 2; dr++) for (let dc = -span; dc <= 2; dc++) origins.push({ col: gate.col + dc, row: gate.row + dr });
  origins.sort((a, b) => Math.hypot(a.col - gate.col, a.row - gate.row) - Math.hypot(b.col - gate.col, b.row - gate.row) || a.row - b.row || a.col - b.col);
  for (const o of origins) {
    const tiles: TileCoord[] = [];
    for (let u = 0; u < span; u++) for (let v = 0; v < span; v++) tiles.push({ col: o.col + u, row: o.row + v });
    if (tiles.some(t => gateTiles.has(key(t.col, t.row)) || !g.free(t.col, t.row))) continue;
    const touches = tiles.some(t => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dc, dr]) => gateTiles.has(key(t.col + dc!, t.row + dr!))));
    if (!touches) continue;
    const yard = { col: o.col, row: o.row, span };
    const spots = yardSpots(g, yard);
    if (spots.length > 0) return { ...yard, spots, shore: [] };
  }
  return null;
}

/* The shortest way a caravan walks from the map's edge to the gate. */
function routeInFromEdge(g: Ground, gate: TileCoord): TileCoord[] | null {
  const b = g.map.bounds;
  const open = g.walk;
  const start = gate;
  const parent = new Map<string, string | null>([[key(start.col, start.row), null]]);
  const queue: TileCoord[] = [start];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    if (cur.col === b.minCol || cur.col === b.maxCol || cur.row === b.minRow || cur.row === b.maxRow) {
      const path: TileCoord[] = [];
      for (let k: string | null | undefined = key(cur.col, cur.row); k; k = parent.get(k)) {
        const [c, r] = k.split(',');
        path.push({ col: Number(c), row: Number(r) });
      }
      return path;
    }
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const n = { col: cur.col + dc, row: cur.row + dr };
      const nk = key(n.col, n.row);
      if (parent.has(nk) || !open(n.col, n.row)) continue;
      parent.set(nk, key(cur.col, cur.row));
      queue.push(n);
    }
  }
  return null;
}

function routesOf(plan: HarbourPlan): readonly (readonly TileCoord[])[] {
  return plan.kind === 'river' ? plan.piers.map(p => p.route) : [plan.caravanRoute];
}

function speedOf(plan: HarbourPlan): number {
  return plan.kind === 'river' ? BOAT_TILES_PER_SEC : CARAVAN_TILES_PER_SEC;
}

function travelMs(plan: HarbourPlan, route: readonly TileCoord[]): number {
  return (Math.max(1, route.length - 1) / speedOf(plan)) * 1000;
}

/* The boat (or caravan) trips that bring the tasks created in the window: tasks created within BATCH_MS of a batch's
   first come together, at most cargoMax of them; each trip takes the berth that frees first. */
export function scheduleBoats(plan: HarbourPlan, flow: WorldLiveTaskFlow, cargoMax: number): CarrierTrip[] {
  const max = Math.max(1, Math.floor(cargoMax));
  const times = flow.arrivals.map(a => Date.parse(a)).filter(Number.isFinite).sort((a, b) => a - b);
  const routes = routesOf(plan);
  const free = routes.map(() => -Infinity);
  const trips: CarrierTrip[] = [];
  for (let i = 0; i < times.length; ) {
    const first = times[i]!;
    let stones = 0;
    while (i < times.length && stones < max && times[i]! - first <= BATCH_MS) {
      stones++;
      i++;
    }
    let pier = 0;
    let moored = Infinity;
    routes.forEach((route, p) => {
      const at = Math.max(first + travelMs(plan, route), free[p]!);
      if (at < moored) {
        moored = at;
        pier = p;
      }
    });
    const sail = travelMs(plan, routes[pier]!);
    const unloaded = moored + MOOR_MS + stones * UNLOAD_MS_PER_STONE;
    free[pier] = unloaded + BERTH_CLEAR_MS;
    trips.push({ id: `trip-${first}-${trips.length}`, pier, stones, leaveMs: moored - sail, mooredMs: moored, unloadedMs: unloaded, goneMs: unloaded + sail });
  }
  return trips;
}

/* Tiles on each side of a stretch that decide which way a carrier heads there, and the fewest stretches a heading
   is held: a river winds tile by tile, and a boat drawn in only the four diagonals must not flick between two. */
const HEADING_WINDOW = 3;
const HEADING_MIN_RUN = 4;
const OPPOSITE: Readonly<Partial<Record<Direction8, Direction8>>> = { NE: 'SW', SW: 'NE', SE: 'NW', NW: 'SE' };
const headingsCache = new WeakMap<readonly TileCoord[], readonly Direction8[]>();

/* The diagonal a grid step mostly runs along: a column step is SE or NW on screen, a row step SW or NE; where both
   are about even the heading stays the one before, if it is one of the two. */
function diagonalOf(dc: number, dr: number, prev: Direction8 | null): Direction8 {
  const byCol: Direction8 = dc >= 0 ? 'SE' : 'NW';
  const byRow: Direction8 = dr >= 0 ? 'SW' : 'NE';
  const ac = Math.abs(dc);
  const ar = Math.abs(dr);
  if (Math.abs(ac - ar) <= 0.25 * Math.max(ac, ar, 1e-6) && (prev === byCol || prev === byRow)) return prev;
  return ac >= ar ? byCol : byRow;
}

/* One heading per stretch of a route, from the way it runs over a few tiles each side, with short runs folded into
   the heading before them. The same route always gives the same headings. */
function routeHeadings(route: readonly TileCoord[]): readonly Direction8[] {
  const known = headingsCache.get(route);
  if (known) return known;
  const last = route.length - 1;
  const out: Direction8[] = [];
  let prev: Direction8 | null = null;
  for (let i = 0; i < last; i++) {
    const a = route[Math.max(0, i - HEADING_WINDOW)]!;
    const b = route[Math.min(last, i + 1 + HEADING_WINDOW)]!;
    prev = diagonalOf(b.col - a.col, b.row - a.row, prev);
    out.push(prev);
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < out.length; ) {
      let j = i;
      while (j < out.length && out[j] === out[i]) j++;
      if (i > 0 && j < out.length && j - i < HEADING_MIN_RUN) out.fill(out[i - 1]!, i, j);
      i = j;
    }
  }
  headingsCache.set(route, out);
  return out;
}

/* A point a fraction of the way along a route of unit steps, and the heading of its stretch there; back, the same
   route from its end with the opposite heading. */
function alongRoute(route: readonly TileCoord[], fraction: number, back = false): Readonly<{ col: number; row: number; facing: Direction8 }> {
  const last = route.length - 1;
  if (last < 1) return { col: route[0]?.col ?? 0, row: route[0]?.row ?? 0, facing: 'S' };
  const f = Math.max(0, Math.min(1, fraction));
  const pos = (back ? 1 - f : f) * last;
  const i = Math.min(last - 1, Math.floor(pos));
  const a = route[i]!;
  const b = route[i + 1]!;
  const t = pos - i;
  const heading = routeHeadings(route)[i] ?? facingOfStep(b.col - a.col, b.row - a.row);
  return { col: a.col + (b.col - a.col) * t, row: a.row + (b.row - a.row) * t, facing: back ? (OPPOSITE[heading] ?? heading) : heading };
}

/* The harbour at a moment: every boat (or caravan) under way or at its berth, and the stones waiting in the yard, which
   are the open queue less those not yet off a deck. */
export function harbourAt(plan: HarbourPlan, trips: readonly CarrierTrip[], flow: WorldLiveTaskFlow, nowMs: number): HarbourState {
  const routes = routesOf(plan);
  const kind = plan.kind === 'river' ? 'boat' : 'caravan';
  const carriers: CarrierState[] = [];
  let aboard = 0;
  for (const trip of trips) {
    const unloadFrom = trip.mooredMs + MOOR_MS;
    const off = nowMs < unloadFrom ? 0 : Math.min(trip.stones, Math.floor((nowMs - unloadFrom) / UNLOAD_MS_PER_STONE) + 1);
    const landed = nowMs >= trip.unloadedMs ? trip.stones : Math.min(trip.stones - 1, Math.max(0, off - 1));
    if (nowMs < trip.unloadedMs) aboard += trip.stones - landed;
    if (nowMs < trip.leaveMs || nowMs >= trip.goneMs) continue;
    const route = routes[trip.pier]!;
    const sail = trip.mooredMs - trip.leaveMs;
    const berth = plan.kind === 'river' ? plan.piers[trip.pier]! : null;
    const end = route[route.length - 1]!;
    const atBerth = berth ? { col: berth.berth.col, row: berth.berth.row, facing: berth.berthFacing } : { ...end, facing: alongRoute(route, 1).facing };
    let at: Readonly<{ col: number; row: number; facing: Direction8 }>;
    let state: CarrierState['state'];
    if (nowMs < trip.mooredMs) {
      at = alongRoute(route, (nowMs - trip.leaveMs) / sail);
      state = 'sail';
    } else if (nowMs < trip.unloadedMs) {
      at = atBerth;
      state = nowMs < unloadFrom ? 'moored' : 'unload';
    } else {
      const back = alongRoute(route, (nowMs - trip.unloadedMs) / sail, true);
      at = back;
      state = 'sail';
    }
    carriers.push({ id: trip.id, kind, col: at.col, row: at.row, facing: at.facing, state, cargo: trip.stones - landed });
  }
  const yardStones = Math.max(0, flow.open - aboard);
  return { carriers, yardStones, yardStage: yardFillStage(yardStones) };
}
