/* Pack-agnostic live company data synchronization into the Stage 3 organic city layout.
   Maps machines, departments, statue alleys, agents, subscriptions, top-level goals, ruler residence,
   one-shot call lodges, empty-lot and no-subscription states, and God's Word relocation orders
   without shifting persisted building coordinates. Contains zero theme-specific words. */

import type { ProviderId } from '@hornhoof/protocol';
import {
  DEFAULT_STATUE_STAGES,
  STATUE_TASKS_PER_STAGE,
  agentLevelFromAcceptedTasks,
  departmentStageFromAcceptedTasks,
  departmentStatuesFromAcceptedTasks,
  flophouseStageFromCalls,
  goalMonumentProgress,
  houseStageFromLevel,
  machinePowerTier,
  nextLevelProgress,
  residenceStageFromAcceptedTasks,
  type WorldLiveAgent,
  type WorldLiveDepartment,
  type WorldLiveGoal,
  type WorldLiveMachine,
  type WorldLiveSnapshot,
  type WorldLiveSubscription,
  type WorldMode,
  type WorldRelocationRecord,
} from '@hornhoof/protocol/world';
import {
  acceptRelocation,
  advanceRelocationStep,
  bindCityMap,
  canPlaceFootprint,
  createCity,
  deserializeCityLayout,
  growBuildingForProgress,
  placeBuilding,
  rebuildWallIfNeeded,
  refreshCityMetrics,
  requestRelocation,
  type CityBuilding,
  type CityLayoutSnapshot,
  type CityState,
} from './city-layout';
import type { PickableObject, TileCoord } from './coords';
import type { WorldPackManifest } from './manifest';
import type { GeneratedWorldMap } from './terrain-engine';

export type LiveCitySummary = Readonly<{
  worldMode: WorldMode;
  companyName: string;
  acceptedTasksTotal: number;
  residenceStage: number;
  machinesCount: number;
  departmentsCount: number;
  agentsCount: number;
  topAgentLevel: number;
  subscriptionsCount: number;
  activeSubscriptionsCount: number;
  goalsCount: number;
  reachedGoalsCount: number;
  statuesCount: number;
  oneShotCallsTotal: number;
  pendingRelocationsCount: number;
  wallTilesCount: number;
}>;

export type LiveCitySyncResult = Readonly<{
  city: CityState;
  worldMode: WorldMode;
  emptyLotStakes: readonly TileCoord[];
  pendingRelocations: readonly WorldRelocationRecord[];
  appliedRelocationsCount: number;
  districtColors: Readonly<Record<string, string>>;
  summary: LiveCitySummary;
}>;

const DISTRICT_PALETTE = [
  '#C95B48',
  '#3A8E9E',
  '#5A9A52',
  '#C8943A',
  '#7D64C4',
  '#C45B8E',
  '#4A7DC8',
  '#9A7C4A',
] as const;

function isCityLayoutSnapshot(value: unknown, packId: string, seed: string): value is CityLayoutSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CityLayoutSnapshot>;
  return (
    candidate.version === 2 &&
    candidate.packId === packId &&
    candidate.seed === seed &&
    Array.isArray(candidate.buildings) &&
    Array.isArray(candidate.roads)
  );
}

function buildEmptyLotStakes(center: TileCoord, radius = 3): TileCoord[] {
  return [
    { col: center.col - radius, row: center.row - radius },
    { col: center.col, row: center.row - radius },
    { col: center.col + radius, row: center.row - radius },
    { col: center.col + radius, row: center.row },
    { col: center.col + radius, row: center.row + radius },
    { col: center.col, row: center.row + radius },
    { col: center.col - radius, row: center.row + radius },
    { col: center.col - radius, row: center.row },
  ];
}

function buildDistrictColors(machines: readonly WorldLiveMachine[]): Record<string, string> {
  const colors: Record<string, string> = {};
  machines.forEach((m, idx) => {
    colors[m.id] = DISTRICT_PALETTE[idx % DISTRICT_PALETTE.length]!;
  });
  return colors;
}

function updateBuildingInPlace(
  city: CityState,
  map: GeneratedWorldMap,
  building: CityBuilding,
  patch: Partial<CityBuilding>,
  allowGrowth: boolean,
): void {
  Object.assign(building, patch);
  if (allowGrowth) {
    growBuildingForProgress(city, map, building);
  }
}

/* Synchronizes any live company snapshot onto a pack-owned procedural terrain map.
   Existing building coordinates stay frozen unless an explicit relocation task reached status 'applied'. */
export function syncLiveSnapshotToCity(
  pack: WorldPackManifest,
  map: GeneratedWorldMap,
  snapshot: WorldLiveSnapshot,
  existingCity?: CityState | null,
): LiveCitySyncResult {
  const worldMode = snapshot.company.worldMode;
  const districtColors = buildDistrictColors(snapshot.machines);

  /* Brand-new company without a template and without staff: empty lot with stakes, boards, and starter camp. */
  if (worldMode === 'empty_lot') {
    const emptyCity = bindCityMap(
      createCity(map, { orderChaos: pack.params.orderChaosDefault, outerWallMode: 'none' }),
      map,
    );
    const camp = emptyCity.buildings.find(b => b.kind === 'residence');
    if (camp) {
      camp.label = snapshot.orchestrator?.name ?? 'Starter Camp';
      camp.stage = 1;
      camp.maxStage = pack.stageCounts.residence;
      camp.acceptedTasks = 0;
      camp.resting = false;
      camp.entityId = snapshot.orchestrator?.id;
    }
    const stakes = buildEmptyLotStakes(camp ? { col: camp.col + 1, row: camp.row + 1 } : emptyCity.center, 4);
    refreshCityMetrics(emptyCity);
    return {
      city: emptyCity,
      worldMode,
      emptyLotStakes: stakes,
      pendingRelocations: [],
      appliedRelocationsCount: 0,
      districtColors,
      summary: {
        worldMode,
        companyName: snapshot.company.name,
        acceptedTasksTotal: 0,
        residenceStage: 1,
        machinesCount: 0,
        departmentsCount: 0,
        agentsCount: 0,
        topAgentLevel: 1,
        subscriptionsCount: 0,
        activeSubscriptionsCount: 0,
        goalsCount: 0,
        reachedGoalsCount: 0,
        statuesCount: 0,
        oneShotCallsTotal: 0,
        pendingRelocationsCount: 0,
        wallTilesCount: 0,
      },
    };
  }

  let city: CityState;
  if (existingCity && existingCity.packId === pack.id && existingCity.seed === map.seed) {
    city = bindCityMap(existingCity, map);
  } else if (isCityLayoutSnapshot(snapshot.savedLayout, pack.id, map.seed)) {
    city = bindCityMap(deserializeCityLayout(snapshot.savedLayout), map);
  } else {
    city = bindCityMap(
      createCity(map, {
        orderChaos: pack.params.orderChaosDefault,
        outerWallMode: pack.outerWallMode ?? 'ring',
      }),
      map,
    );
  }

  const isActive = worldMode === 'active';
  const byId = new Map<string, CityBuilding>(city.buildings.map(b => [b.id, b]));
  const defaultDistrictId = snapshot.machines[0]?.id ?? 'district-default';

  /* 1. Ruler residence (orchestrator): scales through 5 canonical stages from company accepted tasks. */
  const residence = byId.get('residence-main') ?? city.buildings.find(b => b.kind === 'residence');
  if (residence) {
    updateBuildingInPlace(
      city,
      map,
      residence,
      {
        label: snapshot.orchestrator?.name ?? 'Ruler Residence',
        stage: isActive ? snapshot.company.residenceStage : 1,
        maxStage: pack.stageCounts.residence,
        acceptedTasks: snapshot.company.acceptedTasksTotal,
        resting: snapshot.company.allRestingNoSubscription || Boolean(snapshot.orchestrator?.resting),
        provider: snapshot.orchestrator?.provider ?? undefined,
        entityId: snapshot.orchestrator?.id,
      },
      isActive,
    );
  }

  /* 2. Top-level goals (monuments): primary goal placed first in the heart of the city. */
  const orderedGoals = [...snapshot.goals].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.number - b.number);
  for (const g of orderedGoals) {
    const id = `goal-${g.id}`;
    const existing = byId.get(id);
    const label = `#${g.number} ${g.title}`;
    const span = g.isPrimary ? 5 : 3;
    const lotSpan = g.isPrimary ? 6 : 4;
    if (existing) {
      updateBuildingInPlace(
        city,
        map,
        existing,
        {
          label,
          stage: g.stage,
          maxStage: pack.stageCounts.monument,
          progress: g.progress,
          reached: g.reached,
          celebrating: g.celebrating,
          goalCount: 1,
          entityId: g.id,
        },
        false,
      );
    } else {
      const placed = placeBuilding(city, {
        id,
        kind: 'monument',
        label,
        departmentId: g.departmentId ?? undefined,
        stage: g.stage,
        spanCol: span,
        spanRow: span,
        lotSpanCol: lotSpan,
        lotSpanRow: lotSpan,
      });
      if (placed) {
        placed.maxStage = pack.stageCounts.monument;
        placed.progress = g.progress;
        placed.reached = g.reached;
        placed.celebrating = g.celebrating;
        placed.goalCount = 1;
        placed.entityId = g.id;
        byId.set(id, placed);
      }
    }
  }

  /* 3. Departments on the main central streets, plus their statue alleys (100 tasks/stage, 20 stages/statue). */
  for (const dept of snapshot.departments) {
    const id = `dept-${dept.id}`;
    const stage = isActive ? Math.min(pack.stageCounts.department, dept.stage) : 1;
    const existing = byId.get(id);
    if (existing) {
      updateBuildingInPlace(
        city,
        map,
        existing,
        {
          label: dept.name,
          stage,
          maxStage: pack.stageCounts.department,
          acceptedTasks: dept.acceptedTasks,
          resting: snapshot.company.allRestingNoSubscription,
          entityId: dept.id,
        },
        isActive,
      );
    } else {
      const placed = placeBuilding(city, {
        id,
        kind: 'department',
        label: dept.name,
        departmentId: dept.id,
        stage,
      });
      if (placed) {
        placed.maxStage = pack.stageCounts.department;
        placed.acceptedTasks = dept.acceptedTasks;
        placed.resting = snapshot.company.allRestingNoSubscription;
        placed.entityId = dept.id;
        if (isActive) growBuildingForProgress(city, map, placed);
        byId.set(id, placed);
      }
    }

    if (isActive) {
      for (const statue of dept.statues) {
        const sid = `statue-${dept.id}-${statue.index}`;
        const sExisting = byId.get(sid);
        const sLabel = `${dept.name} #${statue.index}`;
        if (sExisting) {
          updateBuildingInPlace(
            city,
            map,
            sExisting,
            {
              label: sLabel,
              stage: statue.stage,
              maxStage: statue.maxStage,
              reached: statue.completed,
              celebrating: statue.completed,
              entityId: dept.id,
            },
            false,
          );
        } else {
          const placed = placeBuilding(city, {
            id: sid,
            kind: 'statue',
            label: sLabel,
            departmentId: dept.id,
            stage: statue.stage,
            spanCol: statue.span,
            spanRow: statue.span,
            lotSpanCol: statue.span,
            lotSpanRow: statue.span,
          });
          if (placed) {
            placed.maxStage = statue.maxStage;
            placed.reached = statue.completed;
            placed.celebrating = statue.completed;
            placed.entityId = dept.id;
            byId.set(sid, placed);
          }
        }
      }
    }
  }

  /* 4. Subscriptions as waterfront supply structures (granary/well) showing live limit fullness. */
  for (const sub of snapshot.subscriptions) {
    const id = `supply-${sub.id}`;
    const existing = byId.get(id);
    const stage = Math.max(1, Math.round(sub.fullness * 6));
    if (existing) {
      updateBuildingInPlace(
        city,
        map,
        existing,
        {
          label: sub.label,
          stage,
          maxStage: 6,
          fullness: sub.fullness,
          provider: sub.provider,
          resting: sub.exhausted || !sub.active,
          entityId: sub.id,
        },
        false,
      );
    } else {
      const placed = placeBuilding(city, {
        id,
        kind: 'supply',
        label: sub.label,
        stage,
      });
      if (placed) {
        placed.maxStage = 6;
        placed.fullness = sub.fullness;
        placed.provider = sub.provider;
        placed.resting = sub.exhausted || !sub.active;
        placed.entityId = sub.id;
        byId.set(id, placed);
      }
    }
  }

  /* 5. Machines as district hubs sized by CPU cores and RAM. */
  for (const m of snapshot.machines) {
    const id = `hub-${m.id}`;
    const existing = byId.get(id);
    if (existing) {
      updateBuildingInPlace(
        city,
        map,
        existing,
        {
          label: m.hostname,
          stage: m.powerTier,
          maxStage: 3,
          resting: !m.online,
          entityId: m.id,
        },
        false,
      );
    } else {
      const placed = placeBuilding(city, {
        id,
        kind: 'district_hub',
        label: m.hostname,
        districtId: m.id,
        stage: m.powerTier,
        spanCol: m.hubSpan,
        spanRow: m.hubSpan,
        lotSpanCol: Math.min(4, m.hubSpan + 1),
        lotSpanRow: Math.min(4, m.hubSpan + 1),
      });
      if (placed) {
        placed.maxStage = 3;
        placed.resting = !m.online;
        placed.entityId = m.id;
        byId.set(id, placed);
      }
    }
  }

  /* 6. Agents as resident homes inside the district of their machine, growing with canonical level. */
  for (const agent of snapshot.agents) {
    const id = `house-${agent.id}`;
    const districtId = agent.machineId ?? defaultDistrictId;
    const stage = isActive ? Math.min(pack.stageCounts.house, agent.houseStage) : 1;
    const level = isActive ? agent.level : 1;
    const existing = byId.get(id);
    if (existing) {
      updateBuildingInPlace(
        city,
        map,
        existing,
        {
          label: agent.name,
          districtId,
          departmentId: agent.departmentId ?? undefined,
          stage,
          maxStage: pack.stageCounts.house,
          level,
          acceptedTasks: agent.acceptedTasks,
          provider: agent.provider ?? undefined,
          resting: agent.resting,
          residentIds: [agent.id],
          entityId: agent.id,
        },
        isActive,
      );
    } else {
      const placed = placeBuilding(city, {
        id,
        kind: 'house',
        label: agent.name,
        districtId,
        departmentId: agent.departmentId ?? undefined,
        stage,
        level,
        residentIds: [agent.id],
      });
      if (placed) {
        placed.maxStage = pack.stageCounts.house;
        placed.acceptedTasks = agent.acceptedTasks;
        placed.provider = agent.provider ?? undefined;
        placed.resting = agent.resting;
        placed.entityId = agent.id;
        if (isActive) growBuildingForProgress(city, map, placed);
        byId.set(id, placed);
      }
    }
  }

  /* 7. One-shot calls: shared day-laborer lodge (flophouse) on district edge scaling with call count. */
  if (isActive && snapshot.company.oneShotCallsTotal > 0) {
    const id = 'flophouse-main';
    const existing = byId.get(id);
    const stage = Math.min(pack.stageCounts.flophouse, Math.max(1, snapshot.company.flophouseStage));
    if (existing) {
      updateBuildingInPlace(
        city,
        map,
        existing,
        {
          stage,
          maxStage: pack.stageCounts.flophouse,
          acceptedTasks: snapshot.company.oneShotCallsTotal,
        },
        false,
      );
    } else {
      const placed = placeBuilding(city, {
        id,
        kind: 'flophouse',
        label: 'Day-Laborer Lodge',
        districtId: defaultDistrictId,
        stage,
      });
      if (placed) {
        placed.maxStage = pack.stageCounts.flophouse;
        placed.acceptedTasks = snapshot.company.oneShotCallsTotal;
        byId.set(id, placed);
      }
    }
  }

  /* 8. Apply God's Word relocation orders ONLY when status === 'applied' (task accepted).
        Pending or cancelled relocations NEVER alter building coordinates. */
  for (const b of city.buildings) {
    b.pendingRelocation = null;
  }
  const pendingRelocations: WorldRelocationRecord[] = [];
  let appliedRelocationsCount = 0;

  for (const rel of snapshot.relocations) {
    const targetBuilding = byId.get(rel.buildingId);
    if (!targetBuilding) continue;

    if (rel.status === 'pending') {
      targetBuilding.pendingRelocation = {
        relocationId: rel.id,
        taskId: rel.taskId,
        taskNumber: rel.taskNumber,
        toCol: rel.toCol,
        toRow: rel.toRow,
      };
      pendingRelocations.push(rel);
    } else if (rel.status === 'applied') {
      appliedRelocationsCount++;
      if (targetBuilding.col !== rel.toCol || targetBuilding.row !== rel.toRow) {
        const req = requestRelocation(city, targetBuilding.id, rel.toCol, rel.toRow, map);
        if (req) {
          acceptRelocation(city, req.id);
          for (let step = 0; step < 64 && req.status !== 'completed'; step++) {
            advanceRelocationStep(city, map, req.id);
          }
        }
      }
    }
  }

  /* 9. Outer wall: respects pack.outerWallMode ('ring' vs 'none'). */
  if (isActive) {
    rebuildWallIfNeeded(city, map);
  }
  refreshCityMetrics(city);

  const topAgentLevel = snapshot.agents.reduce((m, a) => Math.max(m, a.level), 1);

  return {
    city,
    worldMode,
    emptyLotStakes: [],
    pendingRelocations,
    appliedRelocationsCount,
    districtColors,
    summary: {
      worldMode,
      companyName: snapshot.company.name,
      acceptedTasksTotal: snapshot.company.acceptedTasksTotal,
      residenceStage: snapshot.company.residenceStage,
      machinesCount: snapshot.machines.length,
      departmentsCount: snapshot.departments.length,
      agentsCount: snapshot.agents.length,
      topAgentLevel,
      subscriptionsCount: snapshot.subscriptions.length,
      activeSubscriptionsCount: snapshot.subscriptions.filter(s => s.active && !s.exhausted).length,
      goalsCount: snapshot.goals.length,
      reachedGoalsCount: snapshot.goals.filter(g => g.reached).length,
      statuesCount: city.buildings.filter(b => b.kind === 'statue').length,
      oneShotCallsTotal: snapshot.company.oneShotCallsTotal,
      pendingRelocationsCount: pendingRelocations.length,
      wallTilesCount: city.wallTiles.size,
    },
  };
}

/* Validates whether a building can be relocated onto (toCol, toRow) without overlapping roads, walls, or other footprints. */
export function canRelocateBuildingTo(
  city: CityState,
  map: GeneratedWorldMap,
  buildingId: string,
  toCol: number,
  toRow: number,
): boolean {
  const b = city.buildings.find(item => item.id === buildingId);
  if (!b) return false;
  if (b.col === toCol && b.row === toRow) return false;
  return canPlaceFootprint(city, map, toCol, toRow, b.spanCol, b.spanRow, b.id, true);
}

/* Converts placed city buildings into interactive PickableObject bounds for the isometric engine. */
export function cityToPickableObjects(city: CityState): PickableObject[] {
  return city.buildings.map(b => ({
    id: b.id,
    kind: b.kind,
    col: b.col,
    row: b.row,
    spanCol: b.spanCol,
    spanRow: b.spanRow,
    label: b.label,
  }));
}

/* Built-in live Hornhoof team scale fixture matching real operational counts:
   56 agents across 4 departments, 5 machines, 11 subscriptions, 944 accepted tasks,
   top performers at 44-48 tasks (Lv 6-7), half at <= 11 tasks, active & reached top-level goals. */
export function createHornhoofLiveFixture(): WorldLiveSnapshot {
  const machineSpecs = [
    { id: 'mac-0x', hostname: '0x.local', cores: 16, memory: 64 * 1024 ** 3, online: true },
    { id: 'mac-home', hostname: 'home-api', cores: 8, memory: 32 * 1024 ** 3, online: true },
    { id: 'mac-ahost', hostname: 'a-host', cores: 8, memory: 16 * 1024 ** 3, online: true },
    { id: 'mac-mini', hostname: 'build-mini', cores: 6, memory: 16 * 1024 ** 3, online: true },
    { id: 'mac-media', hostname: 'media-box', cores: 4, memory: 8 * 1024 ** 3, online: false },
  ] as const;

  const machines: WorldLiveMachine[] = machineSpecs.map((m, idx) => {
    const power = machinePowerTier(m.cores, m.memory);
    return {
      id: m.id,
      hostname: m.hostname,
      cores: m.cores,
      memory: m.memory,
      powerTier: power.tier,
      hubSpan: power.span,
      online: m.online,
      isDefault: idx === 0,
    };
  });

  const subSpecs: readonly { id: string; label: string; provider: ProviderId; kind: 'personal' | 'api_key'; fullness: number }[] = [
    { id: 'sub-claude-1', label: 'Claude Max #1', provider: 'claude', kind: 'personal', fullness: 0.84 },
    { id: 'sub-claude-2', label: 'Claude Max #2', provider: 'claude', kind: 'personal', fullness: 0.61 },
    { id: 'sub-claude-3', label: 'Claude Pro #3', provider: 'claude', kind: 'personal', fullness: 0.34 },
    { id: 'sub-codex-1', label: 'Codex Pro #1', provider: 'codex', kind: 'personal', fullness: 0.78 },
    { id: 'sub-codex-2', label: 'Codex Pro #2', provider: 'codex', kind: 'personal', fullness: 0.49 },
    { id: 'sub-codex-3', label: 'Codex Team #3', provider: 'codex', kind: 'personal', fullness: 0.14 },
    { id: 'sub-agy-1', label: 'Antigravity #1', provider: 'antigravity', kind: 'personal', fullness: 0.91 },
    { id: 'sub-agy-2', label: 'Antigravity #2', provider: 'antigravity', kind: 'personal', fullness: 0.52 },
    { id: 'sub-kimi-1', label: 'Kimi Plan', provider: 'kimi', kind: 'personal', fullness: 0.67 },
    { id: 'sub-glm-1', label: 'GLM Plan', provider: 'glm', kind: 'personal', fullness: 0.0 },
    { id: 'sub-api-1', label: 'Anthropic API', provider: 'anthropic_api', kind: 'api_key', fullness: 0.96 },
  ];

  const subscriptions: WorldLiveSubscription[] = subSpecs.map(s => ({
    id: s.id,
    label: s.label,
    provider: s.provider,
    kind: s.kind,
    status: 'ready',
    fullness: s.fullness,
    exhausted: s.fullness <= 0.001,
    active: true,
  }));

  /* 56 realistic team members distributed across Operations (14), Development (22), Design (10), Marketing (10).
     Exact accepted-task distribution sums to 944, top performers at 48, 46, 44 (Lv 6), half at <= 11 tasks. */
  const rosters: readonly {
    deptId: string;
    deptName: string;
    templateKey: string;
    roleCode: string;
    members: readonly { name: string; roleKey: string; kind: 'head' | 'worker'; tasks: number }[];
  }[] = [
    {
      deptId: 'dept-dev',
      deptName: 'Development',
      templateKey: 'development',
      roleCode: 'DEV',
      members: [
        { name: 'Morpheus', roleKey: 'DEV-HEAD', kind: 'head', tasks: 48 },
        { name: 'Tank', roleKey: 'DEV-IMPL', kind: 'worker', tasks: 46 },
        { name: 'Neo', roleKey: 'DEV-ARCH', kind: 'worker', tasks: 44 },
        { name: 'Trinity', roleKey: 'DEV-REV', kind: 'worker', tasks: 38 },
        { name: 'Dozer', roleKey: 'DEV-IMPL', kind: 'worker', tasks: 31 },
        { name: 'Apoc', roleKey: 'DEV-TEST', kind: 'worker', tasks: 28 },
        { name: 'Switch', roleKey: 'DEV-FE', kind: 'worker', tasks: 25 },
        { name: 'Mouse', roleKey: 'DEV-FE', kind: 'worker', tasks: 22 },
        { name: 'Link', roleKey: 'DEV-OPS', kind: 'worker', tasks: 19 },
        { name: 'Niobe', roleKey: 'DEV-SEC', kind: 'worker', tasks: 17 },
        { name: 'Ghost', roleKey: 'DEV-BE', kind: 'worker', tasks: 15 },
        { name: 'Sparks', roleKey: 'DEV-QA', kind: 'worker', tasks: 13 },
        { name: 'Zee', roleKey: 'DEV-IMPL', kind: 'worker', tasks: 11 },
        { name: 'Kid', roleKey: 'DEV-IMPL', kind: 'worker', tasks: 10 },
        { name: 'Lock', roleKey: 'DEV-SEC', kind: 'worker', tasks: 9 },
        { name: 'Roland', roleKey: 'DEV-BE', kind: 'worker', tasks: 8 },
        { name: 'Colt', roleKey: 'DEV-TEST', kind: 'worker', tasks: 7 },
        { name: 'Maggie', roleKey: 'DEV-REV', kind: 'worker', tasks: 7 },
        { name: 'Axel', roleKey: 'DEV-IMPL', kind: 'worker', tasks: 6 },
        { name: 'Bane', roleKey: 'DEV-RED', kind: 'worker', tasks: 5 },
        { name: 'Ballard', roleKey: 'DEV-BE', kind: 'worker', tasks: 5 },
        { name: 'Soren', roleKey: 'DEV-IMPL', kind: 'worker', tasks: 4 },
      ],
    },
    {
      deptId: 'dept-ops',
      deptName: 'Operations',
      templateKey: 'operations',
      roleCode: 'OPS',
      members: [
        { name: 'Seraph', roleKey: 'OPS-HEAD', kind: 'head', tasks: 34 },
        { name: 'Keymaker', roleKey: 'OPS-ACCT', kind: 'worker', tasks: 29 },
        { name: 'Sentinel', roleKey: 'OPS-WATCH', kind: 'worker', tasks: 27 },
        { name: 'Warden', roleKey: 'OPS-FIX', kind: 'worker', tasks: 24 },
        { name: 'Scout', roleKey: 'OPS-BUGS', kind: 'worker', tasks: 21 },
        { name: 'Courier', roleKey: 'OPS-INTEG', kind: 'worker', tasks: 18 },
        { name: 'Operator', roleKey: 'OPS-PROGRAM', kind: 'worker', tasks: 16 },
        { name: 'Relay', roleKey: 'OPS-WATCH', kind: 'worker', tasks: 14 },
        { name: 'Anchor', roleKey: 'OPS-FIX', kind: 'worker', tasks: 11 },
        { name: 'Beacon', roleKey: 'OPS-INTEG', kind: 'worker', tasks: 10 },
        { name: 'Ledger', roleKey: 'OPS-ACCT', kind: 'worker', tasks: 9 },
        { name: 'Probe', roleKey: 'OPS-BUGS', kind: 'worker', tasks: 8 },
        { name: 'Pulse', roleKey: 'OPS-PROGRAM', kind: 'worker', tasks: 8 },
        { name: 'Forge', roleKey: 'OPS-FIX', kind: 'worker', tasks: 7 },
      ],
    },
    {
      deptId: 'dept-des',
      deptName: 'Design',
      templateKey: 'design',
      roleCode: 'DES',
      members: [
        { name: 'Oracle', roleKey: 'DES-HEAD', kind: 'head', tasks: 32 },
        { name: 'Persephone', roleKey: 'DES-UI', kind: 'worker', tasks: 26 },
        { name: 'Sati', roleKey: 'DES-ART', kind: 'worker', tasks: 21 },
        { name: 'Rama', roleKey: 'DES-SYS', kind: 'worker', tasks: 17 },
        { name: 'Kamala', roleKey: 'DES-ART', kind: 'worker', tasks: 14 },
        { name: 'Aurelia', roleKey: 'DES-UI', kind: 'worker', tasks: 11 },
        { name: 'Milo', roleKey: 'DES-MOTION', kind: 'worker', tasks: 10 },
        { name: 'Iris', roleKey: 'DES-ART', kind: 'worker', tasks: 8 },
        { name: 'Kira', roleKey: 'DES-UI', kind: 'worker', tasks: 7 },
        { name: 'Nora', roleKey: 'DES-SYS', kind: 'worker', tasks: 6 },
      ],
    },
    {
      deptId: 'dept-mkt',
      deptName: 'Marketing',
      templateKey: 'marketing',
      roleCode: 'MKT',
      members: [
        { name: 'Herald', roleKey: 'MKT-HEAD', kind: 'head', tasks: 30 },
        { name: 'Scribe', roleKey: 'MKT-WRITE', kind: 'worker', tasks: 24 },
        { name: 'Crier', roleKey: 'MKT-SOC', kind: 'worker', tasks: 20 },
        { name: 'Chronicle', roleKey: 'MKT-WRITE', kind: 'worker', tasks: 16 },
        { name: 'Reel', roleKey: 'MKT-VIDEO', kind: 'worker', tasks: 13 },
        { name: 'Frame', roleKey: 'MKT-VIDEO', kind: 'worker', tasks: 10 },
        { name: 'Atlas', roleKey: 'MKT-SEO', kind: 'worker', tasks: 8 },
        { name: 'Spark', roleKey: 'MKT-SOC', kind: 'worker', tasks: 7 },
        { name: 'Quill', roleKey: 'MKT-WRITE', kind: 'worker', tasks: 5 },
        { name: 'Prism', roleKey: 'MKT-VIDEO', kind: 'worker', tasks: 5 },
      ],
    },
  ];

  const departments: WorldLiveDepartment[] = [];
  const agents: WorldLiveAgent[] = [];
  let acceptedTasksTotal = 0;
  let globalIdx = 0;

  for (const r of rosters) {
    let deptSum = 0;
    let headId: string | null = null;
    for (const m of r.members) {
      const id = `agent-${globalIdx + 1}`;
      if (m.kind === 'head') headId = id;
      const machine = machines[globalIdx % machines.length]!;
      const sub = subscriptions[globalIdx % subscriptions.length]!;
      const prog = nextLevelProgress(m.tasks);
      agents.push({
        id,
        name: m.name,
        kind: m.kind,
        roleKey: m.roleKey,
        departmentId: r.deptId,
        machineId: machine.id,
        subscriptionId: sub.id,
        provider: sub.provider,
        acceptedTasks: m.tasks,
        level: prog.level,
        houseStage: houseStageFromLevel(prog.level, 10),
        nextLevelRemaining: prog.remaining,
        resting: sub.exhausted,
      });
      deptSum += m.tasks;
      acceptedTasksTotal += m.tasks;
      globalIdx++;
    }
    departments.push({
      id: r.deptId,
      name: r.deptName,
      templateKey: r.templateKey,
      roleCode: r.roleCode,
      acceptedTasks: deptSum,
      stage: departmentStageFromAcceptedTasks(deptSum, 10),
      statues: departmentStatuesFromAcceptedTasks(deptSum, DEFAULT_STATUE_STAGES, STATUE_TASKS_PER_STAGE),
      oneShotCallsCount: Math.max(4, Math.round(deptSum / 22)),
      headAgentId: headId,
    });
  }

  const g1Prog = goalMonumentProgress({
    status: 'active',
    targetValue: 1_000_000,
    currentValue: 680_000,
    childGoalsTotal: 5,
    childGoalsReached: 3,
    tasksTotal: 94,
    tasksDone: 64,
  });
  const g2Prog = goalMonumentProgress({
    status: 'active',
    targetValue: null,
    currentValue: null,
    childGoalsTotal: 0,
    childGoalsReached: 0,
    tasksTotal: 94,
    tasksDone: 91,
  });
  const g3Prog = goalMonumentProgress({
    status: 'reached',
    targetValue: 100,
    currentValue: 100,
    childGoalsTotal: 4,
    childGoalsReached: 4,
    tasksTotal: 35,
    tasksDone: 35,
  });

  const goals: WorldLiveGoal[] = [
    {
      id: 'goal-1',
      number: 1,
      title: 'First $1M ARR',
      departmentId: null,
      status: 'active',
      targetValue: 1_000_000,
      currentValue: 680_000,
      unit: 'USD',
      childGoalsTotal: 5,
      childGoalsReached: 3,
      tasksTotal: 94,
      tasksDone: 64,
      progress: g1Prog.progress,
      stage: g1Prog.stage,
      reached: g1Prog.reached,
      celebrating: g1Prog.celebrating,
      isPrimary: true,
    },
    {
      id: 'goal-2',
      number: 2,
      title: 'Hornhoof v1 Launch',
      departmentId: 'dept-dev',
      status: 'active',
      targetValue: null,
      currentValue: null,
      unit: '',
      childGoalsTotal: 0,
      childGoalsReached: 0,
      tasksTotal: 94,
      tasksDone: 91,
      progress: g2Prog.progress,
      stage: g2Prog.stage,
      reached: g2Prog.reached,
      celebrating: g2Prog.celebrating,
      isPrimary: false,
    },
    {
      id: 'goal-3',
      number: 3,
      title: '100 Active Companies',
      departmentId: 'dept-mkt',
      status: 'reached',
      targetValue: 100,
      currentValue: 100,
      unit: 'companies',
      childGoalsTotal: 4,
      childGoalsReached: 4,
      tasksTotal: 35,
      tasksDone: 35,
      progress: g3Prog.progress,
      stage: g3Prog.stage,
      reached: g3Prog.reached,
      celebrating: g3Prog.celebrating,
      isPrimary: false,
    },
  ];

  const residence = residenceStageFromAcceptedTasks(acceptedTasksTotal, 5);
  const oneShotCallsTotal = 42;

  return {
    generatedAt: '2026-11-21T19:00:00Z',
    company: {
      id: 'hornhoof-live',
      name: 'Hornhoof',
      template: 'startup',
      seed: 'hornhoof',
      worldMode: 'active',
      acceptedTasksTotal,
      residenceStage: residence.stage,
      residenceTierKey: residence.tierKey,
      allRestingNoSubscription: false,
      oneShotCallsTotal,
      flophouseStage: flophouseStageFromCalls(oneShotCallsTotal, 6),
    },
    orchestrator: {
      id: 'agent-orch',
      name: 'Orchestrator',
      kind: 'orchestrator',
      roleKey: null,
      departmentId: null,
      machineId: 'mac-0x',
      subscriptionId: 'sub-claude-1',
      provider: 'claude',
      acceptedTasks: 42,
      level: agentLevelFromAcceptedTasks(42),
      houseStage: 5,
      nextLevelRemaining: nextLevelProgress(42).remaining,
      resting: false,
    },
    machines,
    departments,
    agents,
    subscriptions,
    goals,
    relocations: [],
    savedLayout: null,
    permissions: {
      canRelocateAny: true,
      relocatableDepartmentIds: departments.map(d => d.id),
    },
  };
}

export function createEmptyCompanyFixture(): WorldLiveSnapshot {
  return {
    generatedAt: '2026-11-21T19:00:00Z',
    company: {
      id: 'empty-company',
      name: 'New Company',
      template: null,
      seed: 'hornhoof',
      worldMode: 'empty_lot',
      acceptedTasksTotal: 0,
      residenceStage: 1,
      residenceTierKey: 'camp',
      allRestingNoSubscription: false,
      oneShotCallsTotal: 0,
      flophouseStage: 0,
    },
    orchestrator: {
      id: 'orch-new',
      name: 'Orchestrator',
      kind: 'orchestrator',
      roleKey: null,
      departmentId: null,
      machineId: null,
      subscriptionId: null,
      provider: null,
      acceptedTasks: 0,
      level: 1,
      houseStage: 1,
      nextLevelRemaining: 2,
      resting: false,
    },
    machines: [],
    departments: [],
    agents: [],
    subscriptions: [],
    goals: [],
    relocations: [],
    savedLayout: null,
    permissions: { canRelocateAny: true, relocatableDepartmentIds: [] },
  };
}

export function createNoSubscriptionFixture(): WorldLiveSnapshot {
  const power = machinePowerTier(8, 16 * 1024 ** 3);
  return {
    generatedAt: '2026-11-21T19:00:00Z',
    company: {
      id: 'nosub-company',
      name: 'Startup Template',
      template: 'startup',
      seed: 'hornhoof',
      worldMode: 'no_subscription',
      acceptedTasksTotal: 0,
      residenceStage: 1,
      residenceTierKey: 'camp',
      allRestingNoSubscription: true,
      oneShotCallsTotal: 0,
      flophouseStage: 0,
    },
    orchestrator: {
      id: 'orch-nosub',
      name: 'Orchestrator',
      kind: 'orchestrator',
      roleKey: null,
      departmentId: null,
      machineId: 'mac-starter',
      subscriptionId: null,
      provider: null,
      acceptedTasks: 0,
      level: 1,
      houseStage: 1,
      nextLevelRemaining: 2,
      resting: true,
    },
    machines: [
      {
        id: 'mac-starter',
        hostname: 'workstation.local',
        cores: 8,
        memory: 16 * 1024 ** 3,
        powerTier: power.tier,
        hubSpan: power.span,
        online: true,
        isDefault: true,
      },
    ],
    departments: [
      { id: 'd-ops', name: 'Operations', templateKey: 'operations', roleCode: 'OPS', acceptedTasks: 0, stage: 1, statues: [], oneShotCallsCount: 0, headAgentId: 'a-1' },
      { id: 'd-dev', name: 'Development', templateKey: 'development', roleCode: 'DEV', acceptedTasks: 0, stage: 1, statues: [], oneShotCallsCount: 0, headAgentId: 'a-2' },
      { id: 'd-mkt', name: 'Marketing', templateKey: 'marketing', roleCode: 'MKT', acceptedTasks: 0, stage: 1, statues: [], oneShotCallsCount: 0, headAgentId: 'a-3' },
    ],
    agents: [
      { id: 'a-1', name: 'Ops Lead', kind: 'head', roleKey: 'OPS-HEAD', departmentId: 'd-ops', machineId: 'mac-starter', subscriptionId: null, provider: null, acceptedTasks: 0, level: 1, houseStage: 1, nextLevelRemaining: 2, resting: true },
      { id: 'a-2', name: 'Dev Lead', kind: 'head', roleKey: 'DEV-HEAD', departmentId: 'd-dev', machineId: 'mac-starter', subscriptionId: null, provider: null, acceptedTasks: 0, level: 1, houseStage: 1, nextLevelRemaining: 2, resting: true },
      { id: 'a-3', name: 'Mkt Lead', kind: 'head', roleKey: 'MKT-HEAD', departmentId: 'd-mkt', machineId: 'mac-starter', subscriptionId: null, provider: null, acceptedTasks: 0, level: 1, houseStage: 1, nextLevelRemaining: 2, resting: true },
      { id: 'a-4', name: 'Developer', kind: 'worker', roleKey: 'DEV-IMPL', departmentId: 'd-dev', machineId: 'mac-starter', subscriptionId: null, provider: null, acceptedTasks: 0, level: 1, houseStage: 1, nextLevelRemaining: 2, resting: true },
      { id: 'a-5', name: 'Reviewer', kind: 'worker', roleKey: 'DEV-REV', departmentId: 'd-dev', machineId: 'mac-starter', subscriptionId: null, provider: null, acceptedTasks: 0, level: 1, houseStage: 1, nextLevelRemaining: 2, resting: true },
      { id: 'a-6', name: 'Writer', kind: 'worker', roleKey: 'MKT-WRITE', departmentId: 'd-mkt', machineId: 'mac-starter', subscriptionId: null, provider: null, acceptedTasks: 0, level: 1, houseStage: 1, nextLevelRemaining: 2, resting: true },
    ],
    subscriptions: [
      { id: 'sub-empty-1', label: 'No Active Plan', provider: 'claude', kind: 'personal', status: 'needs_login', fullness: 0, exhausted: true, active: false },
    ],
    goals: [],
    relocations: [],
    savedLayout: null,
    permissions: { canRelocateAny: true, relocatableDepartmentIds: ['d-ops', 'd-dev', 'd-mkt'] },
  };
}
