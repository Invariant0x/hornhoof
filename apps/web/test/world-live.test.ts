import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  agentLevelFromAcceptedTasks,
  departmentStageFromAcceptedTasks,
  departmentStatuesFromAcceptedTasks,
  flophouseStageFromCalls,
  goalMonumentProgress,
  houseStageFromLevel,
  machinePowerTier,
  nextLevelProgress,
  residenceStageFromAcceptedTasks,
  type WorldLiveSnapshot,
} from '@hornhoof/protocol/world';
import { describe, expect, it } from 'vitest';
import { verifyCityInvariants } from '../src/world/city-layout';
import {
  canRelocateBuildingTo,
  cityToPickableObjects,
  createHornhoofLiveFixture,
  syncLiveSnapshotToCity,
} from '../src/world/live-sync';
import { generateWorldTerrain } from '../src/world/terrain-engine';
import { DUNGEON_WORLD_PACK } from '../src/world-packs/dungeon/pack';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

function makeEmptyCompanySnapshot(): WorldLiveSnapshot {
  return {
    generatedAt: '2026-11-21T19:00:00Z',
    company: {
      id: 'empty-co',
      name: 'Fresh Venture',
      template: null,
      seed: 'fresh-venture',
      worldMode: 'empty_lot',
      acceptedTasksTotal: 0,
      residenceStage: 1,
      residenceTierKey: 'camp',
      allRestingNoSubscription: false,
      oneShotCallsTotal: 0,
      flophouseStage: 0,
    },
    orchestrator: {
      id: 'orch-empty',
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

function makeNoSubscriptionTemplateSnapshot(): WorldLiveSnapshot {
  const power = machinePowerTier(8, 16 * 1024 ** 3);
  return {
    generatedAt: '2026-11-21T19:00:00Z',
    company: {
      id: 'startup-nosub',
      name: 'Starter Studio',
      template: 'startup',
      seed: 'starter-studio',
      worldMode: 'no_subscription',
      acceptedTasksTotal: 0,
      residenceStage: 1,
      residenceTierKey: 'camp',
      allRestingNoSubscription: true,
      oneShotCallsTotal: 0,
      flophouseStage: 0,
    },
    orchestrator: {
      id: 'orch-1',
      name: 'Orchestrator',
      kind: 'orchestrator',
      roleKey: null,
      departmentId: null,
      machineId: 'm-1',
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
        id: 'm-1',
        hostname: 'office-mac.local',
        cores: 8,
        memory: 16 * 1024 ** 3,
        powerTier: power.tier,
        hubSpan: power.span,
        online: true,
        isDefault: true,
      },
    ],
    departments: [
      {
        id: 'd-ops',
        name: 'Operations',
        templateKey: 'operations',
        roleCode: 'OPS',
        acceptedTasks: 0,
        stage: departmentStageFromAcceptedTasks(0),
        statues: departmentStatuesFromAcceptedTasks(0),
        oneShotCallsCount: 0,
        headAgentId: 'a-1',
      },
      {
        id: 'd-dev',
        name: 'Development',
        templateKey: 'development',
        roleCode: 'DEV',
        acceptedTasks: 0,
        stage: departmentStageFromAcceptedTasks(0),
        statues: departmentStatuesFromAcceptedTasks(0),
        oneShotCallsCount: 0,
        headAgentId: 'a-2',
      },
    ],
    agents: [
      {
        id: 'a-1',
        name: 'Ops Head',
        kind: 'head',
        roleKey: 'OPS-HEAD',
        departmentId: 'd-ops',
        machineId: 'm-1',
        subscriptionId: null,
        provider: null,
        acceptedTasks: 0,
        level: agentLevelFromAcceptedTasks(0),
        houseStage: houseStageFromLevel(1),
        nextLevelRemaining: nextLevelProgress(0).remaining,
        resting: true,
      },
      {
        id: 'a-2',
        name: 'Dev Head',
        kind: 'head',
        roleKey: 'DEV-HEAD',
        departmentId: 'd-dev',
        machineId: 'm-1',
        subscriptionId: null,
        provider: null,
        acceptedTasks: 0,
        level: 1,
        houseStage: 1,
        nextLevelRemaining: 2,
        resting: true,
      },
      {
        id: 'a-3',
        name: 'Builder',
        kind: 'worker',
        roleKey: 'DEV-IMPL',
        departmentId: 'd-dev',
        machineId: 'm-1',
        subscriptionId: null,
        provider: null,
        acceptedTasks: 0,
        level: 1,
        houseStage: 1,
        nextLevelRemaining: 2,
        resting: true,
      },
    ],
    subscriptions: [
      {
        id: 's-1',
        label: 'Claude Plan (pending login)',
        provider: 'claude',
        kind: 'personal',
        status: 'needs_login',
        fullness: 0,
        exhausted: true,
        active: false,
      },
    ],
    goals: [],
    relocations: [],
    savedLayout: null,
    permissions: { canRelocateAny: true, relocatableDepartmentIds: ['d-ops', 'd-dev'] },
  };
}

describe('Stage 4 pack-agnostic live data synchronization', () => {
  it('maps the live Hornhoof team scale (56 agents, 5 machines, 11 subscriptions, 944 accepted tasks) cleanly with stable coordinates', () => {
    const live = createHornhoofLiveFixture();
    expect(live.agents).toHaveLength(56);
    expect(live.machines).toHaveLength(5);
    expect(live.subscriptions).toHaveLength(11);
    expect(live.company.acceptedTasksTotal).toBe(944);
    expect(live.company.residenceStage).toBe(residenceStageFromAcceptedTasks(944).stage);
    expect(live.company.flophouseStage).toBe(flophouseStageFromCalls(live.company.oneShotCallsTotal));
    expect(Math.max(...live.agents.map(a => a.level))).toBeGreaterThanOrEqual(6);
    expect(live.goals.some(g => g.reached && g.celebrating)).toBe(true);
    expect(live.goals.some(g => g.isPrimary)).toBe(true);

    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: live.company.seed, mapSize: 150 });
    const synced1 = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, map, live);

    expect(synced1.worldMode).toBe('active');
    expect(synced1.city.buildings.filter(b => b.kind === 'district_hub')).toHaveLength(5);
    expect(synced1.city.buildings.filter(b => b.kind === 'department')).toHaveLength(live.departments.length);
    expect(synced1.city.buildings.filter(b => b.kind === 'house')).toHaveLength(56);
    expect(synced1.city.buildings.filter(b => b.kind === 'supply')).toHaveLength(11);
    expect(synced1.city.buildings.filter(b => b.kind === 'monument')).toHaveLength(live.goals.length);
    expect(synced1.city.buildings.filter(b => b.kind === 'statue').length).toBeGreaterThanOrEqual(4);
    expect(synced1.city.buildings.filter(b => b.kind === 'flophouse')).toHaveLength(1);
    expect(synced1.city.wallTiles.size).toBeGreaterThan(0);

    const check = verifyCityInvariants(synced1.city, map);
    expect(check.ok, JSON.stringify(check.errors)).toBe(true);

    /* Re-syncing live updates must NEVER jump any existing building coordinate. */
    const posBefore = new Map(synced1.city.buildings.map(b => [b.id, `${b.col},${b.row}`]));
    const synced2 = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, map, live, synced1.city);
    for (const b of synced2.city.buildings) {
      expect(`${b.col},${b.row}`, `building ${b.id} stayed in place`).toBe(posBefore.get(b.id));
    }

    const pickables = cityToPickableObjects(synced2.city);
    expect(pickables.length).toBe(synced2.city.buildings.length);
  });

  it('renders empty_lot for a company without a template and resting Stage 1 buildings when no subscription is active', () => {
    const emptyLive = makeEmptyCompanySnapshot();
    const mapEmpty = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: emptyLive.company.seed, mapSize: 150 });
    const emptyRes = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, mapEmpty, emptyLive);
    expect(emptyRes.worldMode).toBe('empty_lot');
    expect(emptyRes.city.buildings).toHaveLength(1);
    expect(emptyRes.city.buildings[0]!.kind).toBe('residence');
    expect(emptyRes.city.buildings[0]!.stage).toBe(1);
    expect(emptyRes.emptyLotStakes.length).toBeGreaterThanOrEqual(4);
    expect(emptyRes.city.wallTiles.size).toBe(0);

    const noSubLive = makeNoSubscriptionTemplateSnapshot();
    const mapNoSub = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: noSubLive.company.seed, mapSize: 150 });
    const noSubRes = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, mapNoSub, noSubLive);
    expect(noSubRes.worldMode).toBe('no_subscription');
    expect(noSubRes.city.buildings.filter(b => b.kind === 'department').every(b => b.stage === 1 && b.resting)).toBe(true);
    expect(noSubRes.city.buildings.filter(b => b.kind === 'house').every(b => b.stage === 1 && b.resting)).toBe(true);
    expect(verifyCityInvariants(noSubRes.city, mapNoSub).ok).toBe(true);
  });

  it('keeps coordinates unchanged on pending/cancelled relocation and moves only when task is applied (done)', () => {
    const live = createHornhoofLiveFixture();
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: live.company.seed, mapSize: 150 });
    const base = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, map, live);
    const house = base.city.buildings.find(b => b.kind === 'house')!;
    const origCol = house.col;
    const origRow = house.row;

    /* Find a guaranteed clear target tile nearby matching the building's full footprint. */
    let targetCol = origCol;
    let targetRow = origRow;
    outer: for (let dr = -18; dr <= 18; dr++) {
      for (let dc = -18; dc <= 18; dc++) {
        if (Math.hypot(dc, dr) < 5) continue;
        const c = origCol + dc;
        const r = origRow + dr;
        if (canRelocateBuildingTo(base.city, map, house.id, c, r)) {
          targetCol = c;
          targetRow = r;
          break outer;
        }
      }
    }
    expect(targetCol !== origCol || targetRow !== origRow).toBe(true);

    /* Pending relocation: building stays at old coords and carries pendingRelocation metadata. */
    const withPending: WorldLiveSnapshot = {
      ...live,
      relocations: [
        {
          id: 'rel-1',
          buildingId: house.id,
          buildingKind: 'house',
          buildingLabel: house.label,
          fromCol: origCol,
          fromRow: origRow,
          toCol: targetCol,
          toRow: targetRow,
          taskId: 'task-1',
          taskNumber: 999,
          taskStatus: 'open',
          assigneeAgentId: house.entityId ?? 'a1',
          departmentId: house.departmentId ?? null,
          status: 'pending',
          createdAt: '2026-11-21T19:10:00Z',
          resolvedAt: null,
        },
      ],
    };
    const pendingRes = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, map, withPending, base.city);
    const hPending = pendingRes.city.buildings.find(b => b.id === house.id)!;
    expect(hPending.col).toBe(origCol);
    expect(hPending.row).toBe(origRow);
    expect(hPending.pendingRelocation?.taskNumber).toBe(999);

    /* Cancelled relocation: stays at old coords and clears pending badge. */
    const withCancelled: WorldLiveSnapshot = {
      ...live,
      relocations: [{ ...withPending.relocations[0]!, taskStatus: 'cancelled', status: 'cancelled', resolvedAt: '2026-11-21T19:15:00Z' }],
    };
    const cancelRes = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, map, withCancelled, pendingRes.city);
    const hCancel = cancelRes.city.buildings.find(b => b.id === house.id)!;
    expect(hCancel.col).toBe(origCol);
    expect(hCancel.row).toBe(origRow);
    expect(hCancel.pendingRelocation).toBeNull();

    /* Applied (accepted) relocation: commits building to (targetCol, targetRow) and stays valid! */
    const withApplied: WorldLiveSnapshot = {
      ...live,
      relocations: [{ ...withPending.relocations[0]!, taskStatus: 'done', status: 'applied', resolvedAt: '2026-11-21T19:20:00Z' }],
    };
    const appliedRes = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, map, withApplied, cancelRes.city);
    const hApplied = appliedRes.city.buildings.find(b => b.id === house.id)!;
    expect(hApplied.col).toBe(targetCol);
    expect(hApplied.row).toBe(targetRow);
    expect(verifyCityInvariants(appliedRes.city, map).ok).toBe(true);
  });

  it('syncs the same live snapshot onto the Dungeon pack with zero outer wall and zero theme words in core engine files', () => {
    const live = createHornhoofLiveFixture();
    const map = generateWorldTerrain(DUNGEON_WORLD_PACK, { seed: live.company.seed, mapSize: 150 });
    const dungeonRes = syncLiveSnapshotToCity(DUNGEON_WORLD_PACK, map, live);
    expect(dungeonRes.city.wallTiles.size).toBe(0);
    expect(dungeonRes.city.wallGeneration).toBe(0);
    expect(dungeonRes.city.excavatedTiles.size).toBeGreaterThan(200);
    expect(verifyCityInvariants(dungeonRes.city, map).ok).toBe(true);

    /* Modularity contract: zero theme-specific words in core engine or protocol world formulas. */
    const forbidden = /\b(egypt|pharaoh|nile|pyramidion|oasis|dungeon|magma|bedrock)\b/i;
    const liveSyncSrc = readFileSync(resolve(process.cwd(), 'src/world/live-sync.ts'), 'utf8');
    const protocolWorldSrc = readFileSync(resolve(process.cwd(), '../../packages/protocol/src/world.ts'), 'utf8');
    expect(forbidden.test(liveSyncSrc)).toBe(false);
    expect(forbidden.test(protocolWorldSrc)).toBe(false);

    /* Ensure monument progress helper works identically from shared protocol. */
    const goalCheck = goalMonumentProgress({
      status: 'active',
      targetValue: 100,
      currentValue: 65,
      childGoalsTotal: 0,
      childGoalsReached: 0,
      tasksTotal: 0,
      tasksDone: 0,
    });
    expect(goalCheck.progress).toBeCloseTo(0.65, 5);
  });
});
