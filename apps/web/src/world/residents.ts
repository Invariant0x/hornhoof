/* Stage 5 pack-agnostic resident simulation engine:
   drives walking residents across the city road network for all 6 role classes,
   17 approved role archetypes, 7 live Hornhoof states, stone deliveries to goal monuments
   or department statues, checker inspections and rework stone returns, department head
   animation-only directing/poking, turnkey cross-department movement, flophouse day-laborers
   with no house/level, ruler visits, God's Altar waiting shrine, department failure smoke,
   offline machine night districts, home-upgrade scaffolding, and human wake rate-limiting.
   Contains zero theme-specific words. */

import type { ProviderId } from '@hornhoof/protocol';
import {
  HUMAN_WAKE_COOLDOWN_MS,
  classifyAgentRole,
  deriveResidentLiveState,
  outfitTierFromLevel,
  type ResidentLiveState,
  type ResidentRoleClass,
  type RoleArchetype,
  type WorldLiveCurrentTask,
  type WorldLiveSnapshot,
  type WorldLiveTaskFlow,
} from '@hornhoof/protocol/world';
import type { CityBuilding, CityState } from './city-layout';
import { deliverySpotsForBuilding, type DeliverySpot } from './construction';
import type { Direction8, PackRoleLookSpec, WorldPackManifest } from './manifest';
import { resolvePackRoleLook } from './manifest';
import { facingOfStep, tileCenterToWorld, worldToScreen, type TileCoord } from './coords';
import type { CameraState, ViewportSize } from './camera';
import { boatCargoMaxOf, scheduleBoats, type CarrierTrip, type HarbourPlan, type YardSpot } from './harbour';

export type ResidentPose =
  | 'walking'
  | 'carrying_stone'
  | 'building'
  | 'inspecting'
  | 'returning_stone'
  | 'directing'
  | 'surveying'
  | 'writing'
  | 'carving'
  | 'ringing_gong'
  | 'extinguishing'
  | 'guarding'
  | 'building_home'
  | 'holding_scroll'
  | 'praying'
  | 'broken_tool'
  | 'sleeping'
  | 'idle';

export type ResidentCarryKind = 'none' | 'stone' | 'returned_stone' | 'water_jar' | 'scroll';
export type DeliveryTargetKind = 'monument' | 'statue' | 'department' | 'none';

/* The spot on a building's lot where a resident ends its walk to work there, and the way it faces: into the building
   (#2001). */
export type ResidentWorkSpot = Readonly<{ col: number; row: number; facing: Direction8 }>;

export type ResidentEntity = {
  id: string;
  agentId: string;
  name: string;
  roleKey: string | null;
  roleClass: ResidentRoleClass;
  archetype: RoleArchetype;
  look: PackRoleLookSpec;
  level: number | null;
  outfitTier: 1 | 2 | 3 | 4 | 5;
  acceptedTasks: number;
  nextLevelRemaining: number;
  model: string;
  provider: ProviderId | null;
  cloakColor: string;
  departmentId: string | null;
  departmentName: string | null;
  machineId: string | null;
  machineHostname: string | null;
  houseId: string | null;
  homeBuildingId: string | null;
  liveState: ResidentLiveState;
  currentTask: WorldLiveCurrentTask | null;
  hasRecentRework: boolean;
  talkingToAgentId: string | null;

  /* Continuous isometric tile-space position and movement path. */
  col: number;
  row: number;
  facing: Direction8;
  walkPhase: number;
  speedTilesPerSec: number;
  path: TileCoord[];
  pathIndex: number;

  /* Current animation and behavior state. */
  pose: ResidentPose;
  carrying: ResidentCarryKind;
  deliveryTargetKind: DeliveryTargetKind;
  leg: 'outbound' | 'inbound';
  actionTimer: number;
  pokeAnimTimer: number;
  visitedDepartmentIds: string[];
  homeTile: TileCoord;
  /* The road tile a walk to work ends at; with a work spot, the one beside it. */
  workTile: TileCoord;
  originTile: TileCoord;
  /* The building the resident works at, and its spot on that building's lot, while it works at one (#2001). */
  workBuildingId: string | null;
  workSpot: ResidentWorkSpot | null;
  /* Where the resident takes its stone at the harbour yard, or leaves a returned one, and the road beside it, while the
     harbour is shown (#2006); null brings the stones from home as before. */
  yardSpot: ResidentWorkSpot | null;
  yardTile: TileCoord | null;
};

/* What the city shows beside its buildings when a resident simulation starts. */
export type ResidentSimulationOptions = Readonly<{
  /* Where the harbour the stones come to stands (#2006). */
  harbour?: HarbourPlan | null;
  /* Whether its art is there to draw it from the start; the renderer sets it as the art loads. */
  harbourShown?: boolean;
}>;

/* The harbour beside the city while residents walk (#2006): its boat trips for the snapshot's task flow, and the
   moment it shows, which starts at the snapshot's time and runs with the simulation. */
export type ResidentHarbour = {
  plan: HarbourPlan;
  flow: WorldLiveTaskFlow;
  trips: readonly CarrierTrip[];
  nowMs: number;
  /* True while the art to draw it is there (no placeholder, #105): until then the stones come from home as before. */
  shown: boolean;
};

export type ResidentSimulation = {
  packId: string;
  timeSec: number;
  /* Tiles per second a resident walks so its drawn stride fits one walk cycle, set by the renderer from the sheet it
     shows; null or unset keeps the resident's own speed. */
  walkSpeedOf?: (resident: ResidentEntity) => number | null;
  /* True for a resident drawn from a standing sheet, which then keeps its place instead of strolling (#1983). */
  standsStillOf?: (resident: ResidentEntity) => boolean;
  altarTile: TileCoord;
  altarLabel: Readonly<{ en: string; ru: string }>;
  residents: ResidentEntity[];
  smokingDepartmentIds: Set<string>;
  stuckDepartmentIds: Set<string>;
  nightDistrictIds: Set<string>;
  scaffoldingHouseIds: Set<string>;
  roadNeighbors: Map<string, TileCoord[]>;
  roadTiles: TileCoord[];
  pathCache: Map<string, TileCoord[]>;
  deptTiles: Map<string, TileCoord>;
  goalTiles: Map<string, TileCoord>;
  statueTilesByDept: Map<string, TileCoord>;
  /* The building of each department, and the spots on the lots of the buildings residents bring stones to. */
  deptBuildingIds: Map<string, string>;
  workSpotsByBuilding: Map<string, readonly DeliverySpot[]>;
  /* How many residents each building has handed a spot, so the next takes the next spot. */
  workSpotTurns: Map<string, number>;
  /* The harbour, its yard's spots, and how many residents the yard has handed one (#2006). */
  harbour: ResidentHarbour | null;
  yardSpots: readonly YardSpot[];
  yardSpotTurns: number;
  supplyTiles: TileCoord[];
  emptySupplyTiles: TileCoord[];
  hubTilesByMachine: Map<string, TileCoord>;
  gateTiles: TileCoord[];
  flophouseTile: TileCoord;
  residenceTile: TileCoord;
  allDepartmentIds: string[];
};

const DIRS_4: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function tKey(c: number, r: number): string {
  return `${c},${r}`;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* Tiles per second a resident walks: what its drawn stride asks for, else its own speed. */
function walkSpeed(sim: ResidentSimulation, r: ResidentEntity): number {
  return sim.walkSpeedOf?.(r) ?? r.speedTilesPerSec;
}

/* A new resident faces its first step on the path (a resident not at work has its focal spot for a path), or the spot it
   stands round; the camera only with neither. */
function startFacing(path: readonly TileCoord[], from: number, at: TileCoord, focus: TileCoord): Direction8 {
  const next = path.slice(from).find(p => Math.hypot(p.col - at.col, p.row - at.row) > 1e-3) ?? focus;
  return facingOfStep(next.col - at.col, next.row - at.row);
}

function nearestRoadTile(target: TileCoord, roadTiles: readonly TileCoord[]): TileCoord {
  if (roadTiles.length === 0) return { ...target };
  let best = roadTiles[0]!;
  let bestD = Infinity;
  for (const rt of roadTiles) {
    const d = Math.abs(rt.col - target.col) + Math.abs(rt.row - target.row);
    if (d < bestD) {
      bestD = d;
      best = rt;
      if (d === 0) break;
    }
  }
  return { col: best.col, row: best.row };
}

/* Bounded road-network BFS cached per (start, goal) pair so 150 residents never stall frame time. */
function findRoadRoute(
  sim: Pick<ResidentSimulation, 'roadNeighbors' | 'roadTiles' | 'pathCache'>,
  from: TileCoord,
  to: TileCoord,
): TileCoord[] {
  const start = nearestRoadTile({ col: Math.round(from.col), row: Math.round(from.row) }, sim.roadTiles);
  const goal = nearestRoadTile({ col: Math.round(to.col), row: Math.round(to.row) }, sim.roadTiles);
  const sk = tKey(start.col, start.row);
  const gk = tKey(goal.col, goal.row);
  if (sk === gk) return [goal];

  const cacheKey = `${sk}>${gk}`;
  const cached = sim.pathCache.get(cacheKey);
  if (cached) return cached;

  const queue: TileCoord[] = [start];
  const parent = new Map<string, string>();
  parent.set(sk, '');
  let head = 0;
  let found = false;
  let visited = 0;

  while (head < queue.length && visited < 2400) {
    const cur = queue[head++]!;
    const ck = tKey(cur.col, cur.row);
    visited++;
    if (ck === gk) {
      found = true;
      break;
    }
    const nbs = sim.roadNeighbors.get(ck);
    if (!nbs) continue;
    for (const nb of nbs) {
      const nk = tKey(nb.col, nb.row);
      if (parent.has(nk)) continue;
      parent.set(nk, ck);
      queue.push(nb);
    }
  }

  let route: TileCoord[];
  if (found) {
    route = [];
    let curKey: string | undefined = gk;
    while (curKey) {
      const [cs, rs] = curKey.split(',');
      route.push({ col: Number(cs), row: Number(rs) });
      curKey = parent.get(curKey);
    }
    route.reverse();
  } else {
    /* Stay at start road tile rather than walking straight across building roofs. */
    route = [start];
  }

  if (sim.pathCache.size > 1600) sim.pathCache.clear();
  sim.pathCache.set(cacheKey, route);
  return route;
}

function buildingDoor(b: CityBuilding): TileCoord {
  return { col: b.door.col, row: b.door.row };
}

/* True if another building sits immediately South/East of (col, row), whose extruded roof would
   visually project upward over (col, row) in 2:1 isometric projection. */
function isTileOccludedInFront(city: CityState, col: number, row: number): boolean {
  const checks: readonly [number, number][] = [
    [1, 0],
    [0, 1],
    [1, 1],
    [2, 1],
    [1, 2],
    [2, 2],
  ];
  for (const [dc, dr] of checks) {
    if (city.footprintOccupant.has(tKey(col + dc, row + dr))) return true;
  }
  return false;
}

/* Picks a visible front-facing (South/East) road or plaza tile beside a building so working and
   stationary residents stand in clear view on the street instead of hidden behind tall roofs. */
function frontTileForBuilding(b: CityBuilding, city: CityState, roadSet: ReadonlySet<string>): TileCoord {
  const frontCandidates: TileCoord[] = [];
  for (let c = b.col; c < b.col + b.spanCol; c++) {
    frontCandidates.push({ col: c, row: b.row + b.spanRow });
  }
  for (let r = b.row; r < b.row + b.spanRow; r++) {
    frontCandidates.push({ col: b.col + b.spanCol, row: r });
  }
  frontCandidates.push({ col: b.col + b.spanCol, row: b.row + b.spanRow });

  for (const pt of frontCandidates) {
    const k = tKey(pt.col, pt.row);
    if (roadSet.has(k) && !city.footprintOccupant.has(k) && !isTileOccludedInFront(city, pt.col, pt.row)) {
      return pt;
    }
  }
  for (const pt of frontCandidates) {
    const k = tKey(pt.col, pt.row);
    if (!city.footprintOccupant.has(k) && !city.wallTiles.has(k) && !isTileOccludedInFront(city, pt.col, pt.row)) {
      return pt;
    }
  }
  for (const pt of frontCandidates) {
    const k = tKey(pt.col, pt.row);
    if (roadSet.has(k) && !city.footprintOccupant.has(k)) {
      return pt;
    }
  }
  return buildingDoor(b);
}

/* The next spot a building hands a resident who comes to work at it, in turn so several residents spread over its
   spots, facing into the building; null for no building or one with no spot by a road (#2001). */
function takeWorkSpot(
  sim: Pick<ResidentSimulation, 'workSpotsByBuilding' | 'workSpotTurns'>,
  buildingId: string | null,
): (ResidentWorkSpot & { approach: TileCoord }) | null {
  const spots = buildingId ? sim.workSpotsByBuilding.get(buildingId) : undefined;
  if (!buildingId || !spots || spots.length === 0) return null;
  const turn = sim.workSpotTurns.get(buildingId) ?? 0;
  sim.workSpotTurns.set(buildingId, turn + 1);
  const spot = spots[turn % spots.length]!;
  return { col: spot.col, row: spot.row, facing: facingOfStep(spot.inward.dc, spot.inward.dr), approach: spot.approach };
}

/* A road route to work, with the one step off the road onto the building's lot when the resident has a spot there. */
function toWorkSpot(route: TileCoord[], spot: ResidentWorkSpot | null): TileCoord[] {
  return spot ? [...route, { col: spot.col, row: spot.row }] : route;
}

/* The next spot of the harbour yard, in turn, for a resident who takes its stones there; null with no harbour shown. */
function takeYardSpot(sim: Pick<ResidentSimulation, 'yardSpots' | 'yardSpotTurns'>): YardSpot | null {
  if (sim.yardSpots.length === 0) return null;
  const spot = sim.yardSpots[sim.yardSpotTurns % sim.yardSpots.length]!;
  sim.yardSpotTurns++;
  return spot;
}

/* Who walks between the yard and its building while the harbour is shown: an agent's resident that brings stones, and
   a checker whose task came back, with the stone it takes back to the yard (#2006). */
function walksFromYard(roleClass: ResidentRoleClass, archetype: string, hasRecentRework: boolean): boolean {
  return archetype === 'builder' || roleClass === 'turnkey' || (roleClass === 'checker' && hasRecentRework);
}

/* True when a working resident's walks start from the yard and come back to it: it has a yard spot, and the harbour
   is drawn. */
function usesYard(sim: Pick<ResidentSimulation, 'harbour'>, r: ResidentEntity): boolean {
  return Boolean(sim.harbour?.shown && r.yardSpot && r.yardTile);
}

/* The road tile a working resident's walk back from work ends at: the yard's while the harbour is drawn, else home. */
function baseTileOf(sim: Pick<ResidentSimulation, 'harbour'>, r: ResidentEntity): TileCoord {
  return usesYard(sim, r) ? r.yardTile! : r.homeTile;
}

/* The road tile a walk to work starts from: the yard's when the resident stands at its yard spot, else home's, so a
   harbour that starts or stops showing mid-walk never sends it across the city in a straight line. */
function restTileOf(r: ResidentEntity): TileCoord {
  const at = r.yardSpot;
  return at && r.yardTile && Math.hypot(r.col - at.col, r.row - at.row) < 0.5 ? r.yardTile : r.homeTile;
}

function harbourOf(pack: WorldPackManifest, plan: HarbourPlan, snapshot: WorldLiveSnapshot, shown: boolean): ResidentHarbour {
  /* A snapshot without the field (an older server, a test page) has no queue and no arrivals. */
  const flow = (snapshot.taskFlow as WorldLiveTaskFlow | undefined) ?? { open: 0, arrivals: [] };
  const at = Date.parse(snapshot.generatedAt);
  return { plan, flow, trips: scheduleBoats(plan, flow, boatCargoMaxOf(pack)), nowMs: Number.isFinite(at) ? at : 0, shown };
}

function resolveAltarTile(pack: WorldPackManifest, city: CityState, residence: CityBuilding | undefined): TileCoord {
  const anchor = pack.altarAnchor ?? { offsetCol: 3, offsetRow: -2 };
  const baseCol = residence ? residence.col + Math.floor(residence.spanCol / 2) : city.center.col;
  const baseRow = residence ? residence.row + Math.floor(residence.spanRow / 2) : city.center.row;
  const desired = { col: baseCol + anchor.offsetCol, row: baseRow + anchor.offsetRow };

  const isAltarClear = (c: number, r: number): boolean => {
    const k = tKey(c, r);
    if (city.footprintOccupant.has(k) || city.wallTiles.has(k)) return false;
    /* Ensure zero extruded building roofs in front overlap the sanctuary or waiting agents. */
    return !isTileOccludedInFront(city, c, r);
  };

  if (isAltarClear(desired.col, desired.row)) {
    return desired;
  }

  /* Search outward from the pack anchor (preferring clear open plaza/road-adjacent ground near the palace). */
  let best: TileCoord | null = null;
  let bestScore = Infinity;
  for (let rad = 1; rad <= 10; rad++) {
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (Math.abs(dc) !== rad && Math.abs(dr) !== rad) continue;
        const c = desired.col + dc;
        const r = desired.row + dr;
        if (!isAltarClear(c, r)) continue;
        const distAnchor = Math.hypot(dc, dr);
        const distRes = Math.hypot(c - baseCol, r - baseRow);
        const nearRoad = DIRS_4.some(([rc, rr]) => city.roads.has(tKey(c + rc, r + rr))) ? -1.5 : 0;
        const score = distAnchor * 1.1 + distRes * 0.45 + nearRoad;
        if (score < bestScore) {
          bestScore = score;
          best = { col: c, row: r };
        }
      }
    }
    if (best) return best;
  }
  return residence ? frontTileForBuilding(residence, city, new Set(city.roads.keys())) : city.center;
}

/* Rate limiter enforcing that human agent wakes cannot fire more than once per cooldown window. */
export class HumanWakeGate {
  private readonly lastWakeByAgent = new Map<string, number>();

  constructor(private readonly cooldownMs = HUMAN_WAKE_COOLDOWN_MS) {}

  remainingMs(agentId: string, now = Date.now()): number {
    const prev = this.lastWakeByAgent.get(agentId);
    if (prev === undefined) return 0;
    return Math.max(0, this.cooldownMs - (now - prev));
  }

  tryWake(agentId: string, now = Date.now()): { allowed: boolean; remainingMs: number } {
    const rem = this.remainingMs(agentId, now);
    if (rem > 0) return { allowed: false, remainingMs: rem };
    this.lastWakeByAgent.set(agentId, now);
    return { allowed: true, remainingMs: 0 };
  }
}

/* Builds a live Stage 5 resident simulation from the synced city layout and Hornhoof snapshot. */
export function createResidentSimulation(
  pack: WorldPackManifest,
  city: CityState,
  snapshot: WorldLiveSnapshot,
  options: ResidentSimulationOptions = {},
): ResidentSimulation {
  const roadSet = new Set<string>(city.roads.keys());
  const roadTiles: TileCoord[] = [...city.roads.values()].map(r => ({ col: r.col, row: r.row }));
  const roadNeighbors = new Map<string, TileCoord[]>();
  for (const rt of roadTiles) {
    const nbs: TileCoord[] = [];
    for (const [dc, dr] of DIRS_4) {
      const nc = rt.col + dc;
      const nr = rt.row + dr;
      if (roadSet.has(tKey(nc, nr))) nbs.push({ col: nc, row: nr });
    }
    roadNeighbors.set(tKey(rt.col, rt.row), nbs);
  }

  const residence = city.buildings.find(b => b.kind === 'residence');
  const residenceTile = residence ? frontTileForBuilding(residence, city, roadSet) : { ...city.center };
  const altarTile = resolveAltarTile(pack, city, residence);
  const altarLabel = pack.altarAnchor?.label ?? { en: "God's Altar", ru: 'Алтарь бога' };

  const deptTiles = new Map<string, TileCoord>();
  const goalTiles = new Map<string, TileCoord>();
  const statueTilesByDept = new Map<string, TileCoord>();
  const deptBuildingIds = new Map<string, string>();
  const goalBuildingIds = new Map<string, string>();
  const statueBuildingIdsByDept = new Map<string, string>();
  const workSpotsByBuilding = new Map<string, readonly DeliverySpot[]>();
  const houseByAgent = new Map<string, CityBuilding>();
  const hubTilesByMachine = new Map<string, TileCoord>();
  const supplyTiles: TileCoord[] = [];
  const emptySupplyTiles: TileCoord[] = [];
  let flophouseTile: TileCoord = residenceTile;

  for (const b of city.buildings) {
    const front = frontTileForBuilding(b, city, roadSet);
    if (b.kind === 'department' && b.departmentId) {
      deptTiles.set(b.departmentId, front);
      deptBuildingIds.set(b.departmentId, b.id);
    }
    if (b.kind === 'monument' && b.entityId) {
      goalTiles.set(b.entityId, front);
      goalBuildingIds.set(b.entityId, b.id);
    }
    if (b.kind === 'statue' && b.departmentId) {
      statueTilesByDept.set(b.departmentId, front);
      statueBuildingIdsByDept.set(b.departmentId, b.id);
    }
    if (b.kind === 'department' || b.kind === 'monument' || b.kind === 'statue') {
      workSpotsByBuilding.set(b.id, deliverySpotsForBuilding(b, null, pack, city));
    }
    if (b.kind === 'house' && b.entityId) houseByAgent.set(b.entityId, b);
    if (b.kind === 'district_hub' && b.districtId) hubTilesByMachine.set(b.districtId, front);
    if (b.kind === 'supply') {
      supplyTiles.push(front);
      if ((b.fullness ?? 1) <= 0.05 || b.resting) emptySupplyTiles.push(front);
    }
    if (b.kind === 'flophouse') flophouseTile = front;
  }

  /* Gate tiles: outer roads touching the outer wall perimeter (or outer road extremities if outerWallMode === 'none'). */
  const gateTiles: TileCoord[] = [];
  for (const rt of roadTiles) {
    let touchesWall = false;
    for (const [dc, dr] of DIRS_4) {
      if (city.wallTiles.has(tKey(rt.col + dc, rt.row + dr))) {
        touchesWall = true;
        break;
      }
    }
    if (touchesWall) gateTiles.push(rt);
  }
  if (gateTiles.length === 0 && roadTiles.length > 0) {
    const sortedByDist = [...roadTiles].sort(
      (a, b) =>
        Math.hypot(b.col - city.center.col, b.row - city.center.row) -
        Math.hypot(a.col - city.center.col, a.row - city.center.row),
    );
    gateTiles.push(...sortedByDist.slice(0, Math.min(4, sortedByDist.length)));
  }

  const deptNameById = new Map(snapshot.departments.map(d => [d.id, d.name]));
  const machineHostById = new Map(snapshot.machines.map(m => [m.id, m.hostname]));
  const machineOnlineById = new Map(snapshot.machines.map(m => [m.id, m.online]));
  const smokingDepartmentIds = new Set<string>(snapshot.departments.filter(d => d.hasSmoke).map(d => d.id));
  const stuckDepartmentIds = new Set<string>(snapshot.departments.filter(d => d.hasStuckTask).map(d => d.id));
  const nightDistrictIds = new Set<string>(snapshot.machines.filter(m => !m.online).map(m => m.id));
  const scaffoldingHouseIds = new Set<string>();
  const allDepartmentIds = snapshot.departments.map(d => d.id);

  const sim: ResidentSimulation = {
    packId: pack.id,
    timeSec: 0,
    altarTile,
    altarLabel,
    residents: [],
    smokingDepartmentIds,
    stuckDepartmentIds,
    nightDistrictIds,
    scaffoldingHouseIds,
    roadNeighbors,
    roadTiles,
    pathCache: new Map(),
    deptTiles,
    goalTiles,
    statueTilesByDept,
    deptBuildingIds,
    workSpotsByBuilding,
    workSpotTurns: new Map(),
    harbour: options.harbour ? harbourOf(pack, options.harbour, snapshot, options.harbourShown ?? false) : null,
    yardSpots: options.harbour?.yard.spots ?? [],
    yardSpotTurns: 0,
    supplyTiles,
    emptySupplyTiles,
    hubTilesByMachine,
    gateTiles,
    flophouseTile,
    residenceTile,
    allDepartmentIds,
  };

  const cloakFor = (provider: ProviderId | null): string => {
    if (!provider) return pack.palette.providers.api_key ?? '#B89B5E';
    if (pack.palette.providers[provider]) return pack.palette.providers[provider]!;
    if (provider.includes('api') || provider === 'openrouter') {
      return pack.palette.providers.api_key ?? '#B89B5E';
    }
    return '#9A8C78';
  };

  const buildResident = (
    agent: NonNullable<WorldLiveSnapshot['orchestrator']>,
    idx: number,
  ): ResidentEntity => {
    const isTurnkey = Boolean(agent.isTurnkey);
    const classified = classifyAgentRole({
      kind: agent.kind,
      roleKey: agent.roleKey,
      isTurnkey,
    });
    const roleClass = agent.roleClass ?? classified.roleClass;
    const archetype = agent.archetype ?? classified.archetype;
    const look = resolvePackRoleLook(pack, agent.roleKey, roleClass, archetype);
    const house = houseByAgent.get(agent.id);
    const machineOnline = agent.machineId ? (machineOnlineById.get(agent.machineId) ?? true) : true;
    const liveState: ResidentLiveState =
      agent.liveState ??
      deriveResidentLiveState({
        machineOnline,
        allRestingNoSubscription: snapshot.company.allRestingNoSubscription,
        subscriptionExhausted: agent.resting,
        hasFailedTurn: false,
        waitingForHuman: false,
        isWorking: !agent.resting,
        recentlyLeveledUp: false,
      });

    if (liveState === 'turn_failed' && agent.departmentId) {
      smokingDepartmentIds.add(agent.departmentId);
    }
    if (liveState === 'upgrading_home' && house) {
      scaffoldingHouseIds.add(house.id);
    }

    const homeTile =
      roleClass === 'ruler'
        ? residenceTile
        : house
          ? frontTileForBuilding(house, city, roadSet)
          : agent.departmentId && deptTiles.has(agent.departmentId)
            ? deptTiles.get(agent.departmentId)!
            : residenceTile;

    const deptTile = (agent.departmentId && deptTiles.get(agent.departmentId)) || residenceTile;
    let workTile: TileCoord = deptTile;
    let deliveryTargetKind: DeliveryTargetKind = 'department';
    /* The building the resident works at, when its work is at one: its department's unless a branch below says another. */
    const deptBuilding = (deptId: string | null | undefined): string | null => (deptId && deptBuildingIds.get(deptId)) || null;
    let workBuildingId: string | null = deptBuilding(agent.departmentId);

    if (liveState === 'waiting_human') {
      workTile = altarTile;
      deliveryTargetKind = 'none';
      workBuildingId = null;
    } else if (liveState === 'exhausted') {
      const supplyPool = emptySupplyTiles.length > 0 ? emptySupplyTiles : supplyTiles;
      workTile = supplyPool.length > 0 ? supplyPool[idx % supplyPool.length]! : residenceTile;
      deliveryTargetKind = 'none';
      workBuildingId = null;
    } else if (liveState === 'machine_offline' || liveState === 'upgrading_home' || liveState === 'idle') {
      workTile = homeTile;
      deliveryTargetKind = 'none';
      workBuildingId = null;
    } else if (liveState === 'turn_failed') {
      workTile = deptTile;
      deliveryTargetKind = 'department';
    } else {
      /* Active 'working' state: choose destination by role class & archetype. */
      if (roleClass === 'ruler') {
        const targetHouse = agent.talkingToAgentId ? houseByAgent.get(agent.talkingToAgentId) : undefined;
        workTile = targetHouse ? frontTileForBuilding(targetHouse, city, roadSet) : deptTile;
        deliveryTargetKind = 'none';
        workBuildingId = null;
      } else if (roleClass === 'turnkey') {
        const otherDeptId =
          allDepartmentIds.find(did => did !== agent.departmentId) ?? agent.departmentId;
        const otherTile = otherDeptId ? deptTiles.get(otherDeptId) : undefined;
        workTile = otherTile ?? deptTile;
        deliveryTargetKind = 'department';
        if (otherTile) workBuildingId = deptBuilding(otherDeptId);
      } else if (archetype === 'firefighter' && smokingDepartmentIds.size > 0) {
        const smokeDept = [...smokingDepartmentIds][0]!;
        workTile = deptTiles.get(smokeDept) ?? deptTile;
        deliveryTargetKind = 'department';
        if (deptTiles.has(smokeDept)) workBuildingId = deptBuilding(smokeDept);
      } else if (archetype === 'patrol' && stuckDepartmentIds.size > 0) {
        const stuckDept = [...stuckDepartmentIds][0]!;
        workTile = deptTiles.get(stuckDept) ?? deptTile;
        deliveryTargetKind = 'department';
        if (deptTiles.has(stuckDept)) workBuildingId = deptBuilding(stuckDept);
      } else if (archetype === 'gate_guard' || archetype === 'red_team' || archetype === 'inspector_scout') {
        workTile = gateTiles.length > 0 ? gateTiles[idx % gateTiles.length]! : deptTile;
        deliveryTargetKind = 'none';
        workBuildingId = null;
      } else if (archetype === 'keykeeper' || archetype === 'caravan_runner') {
        workTile = supplyTiles.length > 0 ? supplyTiles[idx % supplyTiles.length]! : deptTile;
        deliveryTargetKind = 'none';
        workBuildingId = null;
      } else if (archetype === 'machine_keeper' && agent.machineId && hubTilesByMachine.has(agent.machineId)) {
        workTile = hubTilesByMachine.get(agent.machineId)!;
        deliveryTargetKind = 'none';
        workBuildingId = null;
      } else if (roleClass === 'executor' && archetype === 'builder') {
        const goalId = agent.currentTask?.goalId ?? null;
        if (goalId && goalTiles.has(goalId)) {
          workTile = goalTiles.get(goalId)!;
          deliveryTargetKind = 'monument';
          workBuildingId = goalBuildingIds.get(goalId) ?? null;
        } else if (agent.departmentId && statueTilesByDept.has(agent.departmentId)) {
          workTile = statueTilesByDept.get(agent.departmentId)!;
          deliveryTargetKind = 'statue';
          workBuildingId = statueBuildingIdsByDept.get(agent.departmentId) ?? null;
        } else {
          workTile = deptTile;
          deliveryTargetKind = 'department';
        }
      } else if (roleClass === 'checker') {
        const goalId = agent.currentTask?.goalId ?? null;
        if (goalId && goalTiles.has(goalId)) {
          workTile = goalTiles.get(goalId)!;
          deliveryTargetKind = 'monument';
          workBuildingId = goalBuildingIds.get(goalId) ?? null;
        } else if (agent.departmentId && statueTilesByDept.has(agent.departmentId)) {
          workTile = statueTilesByDept.get(agent.departmentId)!;
          deliveryTargetKind = 'statue';
          workBuildingId = statueBuildingIdsByDept.get(agent.departmentId) ?? null;
        } else {
          workTile = deptTile;
          deliveryTargetKind = 'department';
        }
      }
    }

    /* At work by a building, the walk ends on its lot: the road route goes to the road beside the spot (#2001). */
    const spot = liveState === 'working' ? takeWorkSpot(sim, workBuildingId) : null;
    if (spot) workTile = spot.approach;
    const workSpot: ResidentWorkSpot | null = spot ? { col: spot.col, row: spot.row, facing: spot.facing } : null;
    /* With the harbour shown, the stone a resident brings comes from the yard, and a returned one goes back there. */
    const yard =
      liveState === 'working' && workSpot && walksFromYard(roleClass, archetype, Boolean(agent.hasRecentRework)) ? takeYardSpot(sim) : null;
    const yardSpot: ResidentWorkSpot | null = yard ? { col: yard.col, row: yard.row, facing: yard.facing } : null;
    const yardTile: TileCoord | null = yard ? yard.approach : null;
    const originTile =
      liveState === 'waiting_human' || liveState === 'exhausted' || liveState === 'turn_failed'
        ? workTile
        : homeTile;
    const fromTile = sim.harbour?.shown && yardTile ? yardTile : homeTile;
    const initialPath =
      liveState === 'working' ? toWorkSpot(findRoadRoute(sim, fromTile, workTile), workSpot) : [originTile];
    /* Stagger initial path positions deterministically so streets look bustling from frame 0,
       and spread static-state residents around shared focal spots (altar, empty supply, smoking dept). */
    const startIdx =
      initialPath.length > 1 ? hashStr(agent.id) % initialPath.length : 0;
    const basePt = initialPath[startIdx] ?? originTile;
    let startCol = basePt.col;
    let startRow = basePt.row;
    if (liveState !== 'working') {
      const ang = (idx * 2.399963) % (Math.PI * 2);
      const rad =
        liveState === 'waiting_human'
          ? 0.52 + (idx % 3) * 0.14
          : liveState === 'exhausted' || liveState === 'turn_failed'
            ? 0.38 + (idx % 3) * 0.12
            : 0.24;
      const candC = startCol + Math.cos(ang) * rad;
      const candR = startRow + Math.sin(ang) * rad;
      if (!city.footprintOccupant.has(tKey(Math.round(candC), Math.round(candR)))) {
        startCol = candC;
        startRow = candR;
      }
    }
    const startPt = { col: startCol, row: startRow };
    const visitedDepartmentIds =
      roleClass === 'turnkey'
        ? [...allDepartmentIds]
        : agent.departmentId
          ? [agent.departmentId]
          : [];

    const entity: ResidentEntity = {
      id: `res-${agent.id}`,
      agentId: agent.id,
      name: agent.name,
      roleKey: agent.roleKey,
      roleClass,
      archetype,
      look,
      level: agent.level,
      outfitTier: agent.outfitTier ?? outfitTierFromLevel(agent.level),
      acceptedTasks: agent.acceptedTasks,
      nextLevelRemaining: agent.nextLevelRemaining,
      model: agent.model ?? 'claude-sonnet-5-5',
      provider: agent.provider,
      cloakColor: cloakFor(agent.provider),
      departmentId: agent.departmentId,
      departmentName: agent.departmentId ? (deptNameById.get(agent.departmentId) ?? null) : null,
      machineId: agent.machineId,
      machineHostname: agent.machineId ? (machineHostById.get(agent.machineId) ?? null) : null,
      houseId: house?.id ?? null,
      homeBuildingId: roleClass === 'ruler' ? 'residence-main' : (house?.id ?? null),
      liveState,
      currentTask: agent.currentTask ?? null,
      hasRecentRework: Boolean(agent.hasRecentRework),
      talkingToAgentId: agent.talkingToAgentId ?? null,
      col: startPt.col,
      row: startPt.row,
      facing: startFacing(initialPath, startIdx, startPt, basePt),
      walkPhase: (hashStr(agent.id) % 628) / 100,
      speedTilesPerSec:
        archetype === 'firefighter' || archetype === 'red_team'
          ? 3.1
          : roleClass === 'head' || roleClass === 'ruler'
            ? 2.2
            : 2.0,
      path: initialPath,
      pathIndex: startIdx,
      pose: 'idle',
      carrying: 'none',
      deliveryTargetKind,
      leg: 'outbound',
      actionTimer: 0.4 + ((hashStr(agent.id) % 10) * 0.12),
      pokeAnimTimer: 0,
      visitedDepartmentIds,
      homeTile,
      workTile,
      originTile,
      workBuildingId: liveState === 'working' ? workBuildingId : null,
      workSpot,
      yardSpot,
      yardTile,
    };

    applyStaticStatePose(entity);
    return entity;
  };

  /* Spawn ruler (orchestrator) when company has a residence. */
  if (snapshot.orchestrator && snapshot.company.worldMode !== 'empty_lot') {
    sim.residents.push(buildResident(snapshot.orchestrator, 0));
  }

  /* Spawn every company agent (workers & department heads). */
  snapshot.agents.forEach((agent, i) => {
    sim.residents.push(buildResident(agent, i + 1));
  });

  /* Spawn active one-shot call day-laborers: NO house, NO level, live in flophouse, come for one call and return. */
  const activeCalls = snapshot.activeCalls ?? [];
  const dlLook = resolvePackRoleLook(pack, null, 'day_laborer', 'day_laborer');
  activeCalls.forEach((call, idx) => {
    const workBuildingId = (call.departmentId && deptBuildingIds.get(call.departmentId)) || null;
    const spot = takeWorkSpot(sim, workBuildingId);
    const workSpot: ResidentWorkSpot | null = spot ? { col: spot.col, row: spot.row, facing: spot.facing } : null;
    const dest = spot?.approach ?? ((call.departmentId && deptTiles.get(call.departmentId)) || residenceTile);
    const route = toWorkSpot(findRoadRoute(sim, flophouseTile, dest), workSpot);
    const startIdx = route.length > 1 ? (idx * 3 + 1) % route.length : 0;
    const pt = route[startIdx] ?? flophouseTile;
    sim.residents.push({
      id: `call-${call.id}`,
      agentId: call.callerAgentId,
      name: call.judge ? `Judge #${call.taskNumber}` : `Helper #${call.taskNumber}`,
      roleKey: null,
      roleClass: 'day_laborer',
      archetype: 'day_laborer',
      look: dlLook,
      level: null,
      outfitTier: 1,
      acceptedTasks: 0,
      nextLevelRemaining: 0,
      model: 'one-shot',
      provider: call.provider,
      cloakColor: cloakFor(call.provider),
      departmentId: call.departmentId,
      departmentName: call.departmentId ? (deptNameById.get(call.departmentId) ?? null) : null,
      machineId: call.machineId,
      machineHostname: call.machineId ? (machineHostById.get(call.machineId) ?? null) : null,
      houseId: null,
      homeBuildingId: 'flophouse-main',
      liveState: 'working',
      currentTask: { id: call.id, number: call.taskNumber, title: `One-shot #${call.taskNumber}`, goalId: null },
      hasRecentRework: false,
      talkingToAgentId: null,
      col: pt.col,
      row: pt.row,
      facing: startFacing(route, startIdx, pt, dest),
      walkPhase: idx * 1.1,
      speedTilesPerSec: 2.4,
      path: route,
      pathIndex: startIdx,
      pose: 'carrying_stone',
      carrying: 'stone',
      deliveryTargetKind: 'department',
      leg: 'outbound',
      actionTimer: 0.8,
      pokeAnimTimer: 0,
      visitedDepartmentIds: call.departmentId ? [call.departmentId] : [],
      homeTile: flophouseTile,
      workTile: dest,
      originTile: flophouseTile,
      workBuildingId,
      workSpot,
      yardSpot: null,
      yardTile: null,
    });
  });

  return sim;
}

/* atYard: the resident stands at the harbour yard, where a carrier dresses its next stone (#2006). */
function applyStaticStatePose(r: ResidentEntity, atYard = false): void {
  if (r.liveState === 'machine_offline') {
    r.pose = 'sleeping';
    r.carrying = 'none';
    return;
  }
  if (r.liveState === 'exhausted') {
    r.pose = 'praying';
    r.carrying = 'none';
    return;
  }
  if (r.liveState === 'turn_failed') {
    r.pose = 'broken_tool';
    r.carrying = 'none';
    return;
  }
  if (r.liveState === 'waiting_human') {
    r.pose = 'holding_scroll';
    r.carrying = 'scroll';
    return;
  }
  if (r.liveState === 'upgrading_home') {
    r.pose = 'building_home';
    r.carrying = 'none';
    return;
  }
  if (r.liveState === 'idle') {
    r.pose = 'idle';
    r.carrying = 'none';
    return;
  }

  /* Working state initial pose & carry invariant. */
  if (r.roleClass === 'head') {
    r.carrying = 'none';
    r.pose = r.actionTimer > 0 ? 'directing' : 'walking';
    return;
  }
  if (r.roleClass === 'ruler') {
    r.carrying = 'none';
    r.pose = 'walking';
    return;
  }
  if (r.roleClass === 'checker') {
    if (r.hasRecentRework && r.leg === 'inbound') {
      r.carrying = 'returned_stone';
      r.pose = 'returning_stone';
    } else {
      r.carrying = 'scroll';
      r.pose = 'inspecting';
    }
    return;
  }
  if (r.archetype === 'firefighter') {
    r.carrying = 'water_jar';
    r.pose = 'extinguishing';
    return;
  }
  if (r.archetype === 'patrol') {
    r.carrying = 'none';
    r.pose = 'ringing_gong';
    return;
  }
  if (r.archetype === 'gate_guard') {
    r.carrying = 'none';
    r.pose = 'guarding';
    return;
  }
  if (r.archetype === 'architect') {
    r.carrying = 'scroll';
    r.pose = 'surveying';
    return;
  }
  if (r.archetype === 'scribe') {
    r.carrying = 'scroll';
    r.pose = 'writing';
    return;
  }
  if (r.archetype === 'artisan') {
    r.carrying = 'none';
    r.pose = 'carving';
    return;
  }
  /* Builders, turnkey generalists, road builders and day-laborers carry stones outbound and build! */
  carrierPose(r, atYard);
}

/* A carrier leaves home with a stone, lays it at the site while it pauses there, and walks back empty (#1983). */
function carrierPose(r: ResidentEntity, atYard: boolean): void {
  /* Back at the yard, it dresses the next stone before it carries it off (#2006). */
  if (atYard && r.leg === 'outbound' && r.actionTimer > 0) {
    r.carrying = 'stone';
    r.pose = 'building';
    return;
  }
  const atSite = r.leg === 'inbound';
  r.carrying = atSite ? 'none' : 'stone';
  r.pose = !atSite ? 'carrying_stone' : r.actionTimer > 0 ? 'building' : 'walking';
}

/* Seconds a resident dresses a stone at the yard before it carries it off (#2006). */
const YARD_DRESS_SEC = 1.6;

/* Isometric tile distance covered per full walk stride (2*PI radians), preventing foot sliding at any speed. */
const WALK_STRIDE_TILES = 0.65;

/* An idle resident: drawn from a standing sheet it keeps its place by its house; otherwise a calm stroll round the
   house, its walkPhase following the actual tile displacement. */
function stepIdle(sim: ResidentSimulation, r: ResidentEntity, i: number): void {
  r.pose = 'idle';
  r.carrying = 'none';
  if (sim.standsStillOf?.(r)) return;
  const prevCol = r.col;
  const prevRow = r.row;
  const phase = sim.timeSec * 0.7 + i * 0.9;
  r.col = r.homeTile.col + Math.cos(phase) * 0.45;
  r.row = r.homeTile.row + Math.sin(phase) * 0.45;
  const idleMoved = Math.hypot(r.col - prevCol, r.row - prevRow);
  if (idleMoved > 1e-4) {
    r.walkPhase += (idleMoved / WALK_STRIDE_TILES) * Math.PI * 2;
    r.facing = facingOfStep(r.col - prevCol, r.row - prevRow);
  }
}

/* Advances all residents smoothly along their road paths and role behavior loops.
   Zero per-frame allocations on the steady path so 150 residents step in < 0.25 ms. */
export function stepResidentSimulation(sim: ResidentSimulation, dtSec: number): void {
  const dt = Math.max(0.001, Math.min(0.25, dtSec));
  sim.timeSec += dt;
  if (sim.harbour) sim.harbour.nowMs += dt * 1000;

  for (let i = 0; i < sim.residents.length; i++) {
    const r = sim.residents[i]!;

    if (r.liveState === 'machine_offline' || r.liveState === 'exhausted' || r.liveState === 'turn_failed' || r.liveState === 'waiting_human') {
      applyStaticStatePose(r);
      continue;
    }

    if (r.liveState === 'upgrading_home') {
      r.pose = 'building_home';
      r.carrying = 'none';
      continue;
    }

    if (r.liveState === 'idle') {
      stepIdle(sim, r, i);
      continue;
    }

    /* Active 'working' behavior loop. */
    if (r.actionTimer > 0) {
      r.actionTimer = Math.max(0, r.actionTimer - dt);
      if (r.roleClass === 'head') {
        r.carrying = 'none';
        r.pose = 'directing';
        r.pokeAnimTimer = Math.max(0, r.actionTimer);
      } else if (r.roleClass === 'checker') {
        r.carrying = r.hasRecentRework && r.leg === 'inbound' ? 'returned_stone' : 'scroll';
        r.pose = r.hasRecentRework && r.leg === 'inbound' ? 'returning_stone' : 'inspecting';
      } else if (r.archetype === 'architect') {
        r.carrying = 'scroll';
        r.pose = 'surveying';
      } else if (r.archetype === 'firefighter') {
        r.carrying = 'water_jar';
        r.pose = 'extinguishing';
      } else if (r.archetype === 'patrol') {
        r.carrying = 'none';
        r.pose = 'ringing_gong';
      } else if (r.archetype === 'gate_guard') {
        r.carrying = 'none';
        r.pose = 'guarding';
      } else if (r.archetype === 'scribe') {
        r.carrying = 'scroll';
        r.pose = 'writing';
      } else if (r.archetype === 'artisan') {
        r.carrying = 'none';
        r.pose = 'carving';
      } else if (r.roleClass === 'ruler') {
        r.carrying = 'none';
        r.pose = 'directing';
      } else {
        carrierPose(r, usesYard(sim, r));
      }
      continue;
    }

    /* Advance along cached road path. */
    const target = r.path[r.pathIndex];
    if (!target) {
      /* At its spot by the building it works at, a resident turns to the building (#2001); at the yard, to the yard. */
      if (r.leg === 'outbound' && r.workSpot) r.facing = r.workSpot.facing;
      if (r.leg === 'inbound' && usesYard(sim, r)) r.facing = r.yardSpot!.facing;
      r.leg = r.leg === 'outbound' ? 'inbound' : 'outbound';
      /* Turnkey generalists rotate cleanly across all company departments. */
      if (r.roleClass === 'turnkey' && r.leg === 'outbound' && sim.allDepartmentIds.length > 1) {
        const nextDept = sim.allDepartmentIds[Math.floor(sim.timeSec + i) % sim.allDepartmentIds.length]!;
        const nextTile = sim.deptTiles.get(nextDept);
        if (nextTile) {
          const buildingId = sim.deptBuildingIds.get(nextDept) ?? null;
          const spot = takeWorkSpot(sim, buildingId);
          r.workBuildingId = buildingId;
          r.workSpot = spot ? { col: spot.col, row: spot.row, facing: spot.facing } : null;
          r.workTile = spot?.approach ?? nextTile;
        }
      }
      const yard = usesYard(sim, r);
      const nextFrom = r.leg === 'outbound' ? restTileOf(r) : r.workTile;
      const nextTo = r.leg === 'outbound' ? r.workTile : baseTileOf(sim, r);
      const route = findRoadRoute(sim, nextFrom, nextTo);
      r.path = toWorkSpot(route, r.leg === 'outbound' ? r.workSpot : yard ? r.yardSpot : null);
      r.pathIndex = 0;
      r.actionTimer = r.roleClass === 'head' ? 1.4 : r.roleClass === 'checker' ? 1.3 : yard && r.leg === 'outbound' ? YARD_DRESS_SEC : 0.9;
      applyStaticStatePose(r, yard);
      continue;
    }

    const dc = target.col - r.col;
    const dr = target.row - r.row;
    const dist = Math.hypot(dc, dr);
    const step = walkSpeed(sim, r) * dt;

    let movedTiles = 0;
    if (dist <= step) {
      r.col = target.col;
      r.row = target.row;
      movedTiles = dist;
      r.pathIndex++;
    } else {
      r.col += (dc / dist) * step;
      r.row += (dr / dist) * step;
      movedTiles = step;
      r.facing = facingOfStep(dc, dr);
    }
    if (movedTiles > 1e-4) {
      r.walkPhase += (movedTiles / WALK_STRIDE_TILES) * Math.PI * 2;
    }

    /* Enforce class invariants while walking. */
    if (r.roleClass === 'head' || r.roleClass === 'ruler') {
      r.carrying = 'none';
      r.pose = 'walking';
    } else if (r.roleClass === 'checker') {
      if (r.hasRecentRework && r.leg === 'inbound') {
        r.carrying = 'returned_stone';
        r.pose = 'returning_stone';
      } else {
        r.carrying = 'scroll';
        r.pose = 'walking';
      }
    } else if (r.archetype === 'firefighter') {
      r.carrying = 'water_jar';
      r.pose = 'walking';
    } else if (r.archetype === 'builder' || r.roleClass === 'turnkey' || r.roleClass === 'day_laborer') {
      r.carrying = r.leg === 'outbound' ? 'stone' : 'none';
      r.pose = r.leg === 'outbound' ? 'carrying_stone' : 'walking';
    } else {
      r.pose = 'walking';
    }
  }
}

/* Picks the closest visible resident under a screen click (radius scaled by zoom). */
export function pickResidentAtScreen(
  sim: ResidentSimulation,
  sx: number,
  sy: number,
  camera: CameraState,
  viewport: ViewportSize,
  tileW: number,
  tileH: number,
): ResidentEntity | null {
  const hitRadius = Math.max(16, 26 * camera.zoom);
  let best: ResidentEntity | null = null;
  let bestDist = hitRadius;
  for (const r of sim.residents) {
    const world = tileCenterToWorld(r.col, r.row, tileW, tileH);
    const pt = worldToScreen(world.x, world.y - 24, camera, viewport);
    const d = Math.hypot(sx - pt.x, sy - pt.y);
    if (d <= bestDist) {
      bestDist = d;
      best = r;
    }
  }
  return best;
}
