/* Stage 6 pack-agnostic construction, building animation loops, resident work slots,
   20-stage statue alley progression, tiered monument capstone celebration, reverse-order
   demolition and stage-by-stage building relocation state machine.
   Contains zero theme-specific words. */

import type { CityBuilding } from './city-layout';
import {
  resolveConstructionStages,
  type BuildingLoopKind,
  type ConstructionStageSpec,
  type WorkSlotAction,
  type WorldPackManifest,
} from './manifest';

export type BuildingConstructionPhase = 'building' | 'complete' | 'demolishing' | 'cleared';

export type BuildingConstructionState = {
  id: string;
  buildingId: string;
  buildingSnapshot: CityBuilding;
  kind: CityBuilding['kind'];
  col: number;
  row: number;
  spanCol: number;
  spanRow: number;
  phase: BuildingConstructionPhase;
  currentStage: number;
  targetStage: number;
  maxStage: number;
  stageProgress: number;
  stagesPerSec: number;
  stageHistory: number[];
};

export type BuildingRelocationTransition = {
  id: string;
  buildingId: string;
  fromCol: number;
  fromRow: number;
  toCol: number;
  toRow: number;
  demolishState: BuildingConstructionState;
  buildState: BuildingConstructionState;
  completed: boolean;
};

export type StatueAlleyItem = Readonly<{
  index: number;
  stage: number;
  maxStage: number;
  completed: boolean;
  span: 1 | 2 | 3;
}>;

export type BuildingLoopSpec = Readonly<{
  kind: BuildingLoopKind;
  intensity: number;
  phaseOffset: number;
}>;

export type WorkSlot = Readonly<{
  id: string;
  action: WorkSlotAction;
  col: number;
  row: number;
  elevationPx: number;
  facing: 'E' | 'W' | 'S' | 'N';
}>;

export type ConstructionSimulation = {
  packId: string;
  timeSec: number;
  jobs: Map<string, BuildingConstructionState>;
  relocations: BuildingRelocationTransition[];
  dirtyCityVersion: number;
};

function hashSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 1000;
}

/* Maps a building's current discrete stage (1..maxStage) onto the active world pack's
   ordered construction stages (1..10: stakes_and_rope -> ... -> upgraded). */
export function resolveStageSpecForBuilding(
  building: Pick<CityBuilding, 'stage' | 'maxStage'>,
  state: BuildingConstructionState | null,
  pack: WorldPackManifest,
): ConstructionStageSpec {
  const stages = resolveConstructionStages(pack);
  const rawStage = state ? state.currentStage : building.stage;
  const maxStage = Math.max(1, state ? state.maxStage : building.maxStage);
  if (rawStage <= 0) return stages[0]!;
  if (stages.length === maxStage) {
    const idx = Math.max(0, Math.min(stages.length - 1, rawStage - 1));
    return stages[idx]!;
  }
  const ratio = Math.max(0, Math.min(1, (rawStage - 1) / Math.max(1, maxStage - 1)));
  const idx = Math.max(0, Math.min(stages.length - 1, Math.round(ratio * (stages.length - 1))));
  return stages[idx]!;
}

/* Computes the growing alley of department statues (20 stages each, 100 tasks per stage):
   every completed statue stays in place while the next starts right beside it, progressively larger. */
export function computeStatueAlleyProgress(
  acceptedTasks: number,
  maxStage = 20,
  tasksPerStage = 100,
): StatueAlleyItem[] {
  const safeTasks = Math.max(0, Math.floor(acceptedTasks));
  const perStatue = Math.max(1, maxStage * tasksPerStage);
  const completedCount = Math.floor(safeTasks / perStatue);
  const remainderTasks = safeTasks % perStatue;
  const activeStage = Math.floor(remainderTasks / Math.max(1, tasksPerStage));

  const spanFor = (idx: number): 1 | 2 | 3 => (idx <= 0 ? 1 : idx === 1 ? 2 : 3);
  const items: StatueAlleyItem[] = [];
  for (let i = 0; i < completedCount; i++) {
    items.push({
      index: i,
      stage: maxStage,
      maxStage,
      completed: true,
      span: spanFor(i),
    });
  }
  if (activeStage > 0 || items.length === 0) {
    items.push({
      index: completedCount,
      stage: Math.max(1, Math.min(maxStage, activeStage || 1)),
      maxStage,
      completed: false,
      span: spanFor(completedCount),
    });
  }
  return items;
}

type AddLoop = (kind: BuildingLoopKind, intensity?: number) => void;

/* Whether the shared building kit (crane, hoist) goes over this kind: not over kinds whose stage pictures carry their
   own scaffolds and ramps (WorldArtCatalog.ownConstruction). */
function laysKit(pack: WorldPackManifest, kind: CityBuilding['kind']): boolean {
  return !(pack.art?.ownConstruction ?? []).includes(kind);
}

/* Goal monuments: dust, and cranes and hoists where the kit is laid, while growing; golden capstone celebration at 100%. */
function monumentLoops(building: CityBuilding, state: BuildingConstructionState | null, kit: boolean, add: AddLoop): void {
  const reached = state ? state.phase === 'complete' && state.currentStage >= state.maxStage : Boolean(building.reached);
  if (reached) {
    add('celebration', 1.0);
    return;
  }
  const stage = state ? state.currentStage : building.stage;
  add('dust', 1.0);
  if (kit && stage >= 2) {
    add('crane', 1.0);
    add('hoist_block', 1.0);
  }
}

/* A statue's stage, its last stage and whether it is finished, from its job or, without one, from the building. */
function statueProgress(building: CityBuilding, state: BuildingConstructionState | null): { stage: number; maxS: number; finished: boolean } {
  if (state) return { stage: state.currentStage, maxS: state.maxStage, finished: state.phase === 'complete' && state.currentStage >= state.maxStage };
  return { stage: building.stage, maxS: building.maxStage, finished: Boolean(building.reached) || building.stage >= building.maxStage };
}

/* 20-stage statues: dust, and cranes and hoists where the kit is laid, while carving; celebration shimmer when finished. */
function statueLoops(building: CityBuilding, state: BuildingConstructionState | null, kit: boolean, add: AddLoop): void {
  const { stage, maxS, finished } = statueProgress(building, state);
  if (finished) {
    add('celebration', 0.55);
    return;
  }
  add('dust', 0.85);
  if (kit && stage >= 4 && stage <= maxS - 2) {
    add('crane', 0.85);
    add('hoist_block', 0.85);
  }
}

/* Returns the active Stage 6 animation loops layered over a building for its kind and stage. */
export function buildingLoopsFor(
  building: CityBuilding,
  state: BuildingConstructionState | null,
  pack: WorldPackManifest,
): BuildingLoopSpec[] {
  const phaseOffset = hashSeed(building.id) * 0.013;
  const loops: BuildingLoopSpec[] = [];
  const add = (kind: BuildingLoopKind, intensity = 1) => {
    if (!loops.some(l => l.kind === kind)) {
      loops.push({ kind, intensity, phaseOffset });
    }
  };

  if (state && state.phase === 'cleared') {
    return loops;
  }

  /* Reverse-order demolition emits active rubble dust and dismantling activity. */
  if (state && state.phase === 'demolishing') {
    add('dust', 1.25);
    if (state.currentStage >= 4) add('crane', 0.9);
    if (state.currentStage >= 3) add('smoke', 0.65);
    return loops;
  }

  if (building.kind === 'monument') {
    monumentLoops(building, state, laysKit(pack, building.kind), add);
    return loops;
  }
  if (building.kind === 'statue') {
    statueLoops(building, state, laysKit(pack, building.kind), add);
    return loops;
  }

  /* Supply silos & wells: animated water ripples / splashes whenever stocked. */
  if (building.kind === 'supply') {
    if ((building.fullness ?? 0.5) > 0.05 && !building.resting) {
      add('water', Math.max(0.4, building.fullness ?? 0.5));
    }
    if (!building.resting) add('awning', 0.6);
    return loops;
  }

  /* Active construction job uses pack-declared stage loops directly. */
  if (state && state.phase === 'building') {
    const spec = resolveStageSpecForBuilding(building, state, pack);
    for (const k of spec.defaultLoops) {
      add(k, 1.0);
    }
    return loops;
  }

  /* Completed or resting standard buildings (department, house, residence, hub, flophouse). */
  if (building.resting) {
    return loops;
  }

  if (building.kind === 'department') {
    add('awning', 0.95);
    add('smoke', 0.6);
  } else if (building.kind === 'residence') {
    add('awning', 1.0);
    if (building.stage >= 4) add('water', 0.65);
  } else if (building.kind === 'house') {
    if (building.stage >= 3) add('awning', 0.7);
    if (building.level >= 5) add('smoke', 0.45);
  } else if (building.kind === 'district_hub' || building.kind === 'flophouse') {
    add('smoke', 0.55);
    add('awning', 0.65);
  }

  return loops;
}

/* Computes concrete resident work slots (elevated scaffold hammering, open-room interior masons,
   ramp carriers, heavy stone sled haulers, statue carvers and demolition teams).
   When footprintOccupant is provided, external ground slots avoid colliding with neighboring buildings. */
export function workSlotsForBuilding(
  building: CityBuilding,
  state: BuildingConstructionState | null,
  pack: WorldPackManifest,
  footprintOccupant?: ReadonlyMap<string, string>,
): WorkSlot[] {
  const slots: WorkSlot[] = [];
  if (state && state.phase === 'cleared') return slots;

  const c0 = state ? state.col : building.col;
  const r0 = state ? state.row : building.row;
  const sc = state ? state.spanCol : building.spanCol;
  const sr = state ? state.spanRow : building.spanRow;

  const isGroundClear = (col: number, row: number): boolean => {
    if (!footprintOccupant) return true;
    const occ = footprintOccupant.get(`${Math.round(col)},${Math.round(row)}`);
    return !occ || occ === building.id;
  };

  if (state && state.phase === 'demolishing') {
    const elev = Math.max(4, Math.round(state.currentStage * 3.8));
    slots.push(
      { id: `${building.id}-dem-1`, action: 'demolish_rubble', col: c0 + sc - 0.2, row: r0 + sr * 0.5, elevationPx: elev, facing: 'W' },
      { id: `${building.id}-dem-2`, action: 'demolish_rubble', col: c0 + sc * 0.45, row: r0 + sr + 0.15, elevationPx: 0, facing: 'N' },
    );
    return slots;
  }

  if (building.kind === 'monument') {
    const reached = state ? state.phase === 'complete' && state.currentStage >= state.maxStage : Boolean(building.reached);
    if (reached) return slots;
    const progress = state
      ? Math.max(0.1, state.currentStage / Math.max(1, state.maxStage))
      : Math.max(0.12, Math.min(1, building.progress ?? 0.5));
    const tierElev = Math.round(16 + progress * (sc >= 6 ? 78 : 52));

    /* Place the 2-worker sled team on an open ground lane beside the monument (never overlapping another roof!). */
    /* Only in front of the monument: a worker behind it would face a back wall, which is never drawn (#1975). */
    const sledCandidates: Array<{ col: number; row: number; facing: 'N' | 'W' }> = [
      { col: c0 + sc * 0.55, row: r0 + sr + 0.75, facing: 'N' },
      { col: c0 + sc + 0.75, row: r0 + sr * 0.55, facing: 'W' },
    ];
    const sledSpot = sledCandidates.find(pt => isGroundClear(pt.col, pt.row) && isGroundClear(pt.col + 0.6, pt.row));
    if (sledSpot) {
      slots.push({
        id: `${building.id}-sled-1`,
        action: 'pull_sled',
        col: sledSpot.col,
        row: sledSpot.row,
        elevationPx: 0,
        facing: sledSpot.facing,
      });
    }
    if (isGroundClear(c0 + sc + 0.15, r0 + sr * 0.65)) {
      slots.push({
        id: `${building.id}-ramp-1`,
        action: 'carry_ramp',
        col: c0 + sc + 0.15,
        row: r0 + sr * 0.65,
        elevationPx: Math.round(tierElev * 0.45),
        facing: 'W',
      });
    }
    slots.push({
      id: `${building.id}-top-1`,
      action: 'hammer_scaffold',
      col: c0 + sc * 0.52,
      row: r0 + sr * 0.52,
      elevationPx: tierElev,
      facing: 'N',
    });
    return slots;
  }

  if (building.kind === 'statue') {
    const stage = state ? state.currentStage : building.stage;
    const maxS = state ? state.maxStage : building.maxStage;
    const finished = state ? state.phase === 'complete' && stage >= maxS : Boolean(building.reached) || stage >= maxS;
    if (finished) return slots;
    const elev = Math.round(12 + (stage / Math.max(1, maxS)) * (26 + sc * 16));
    if (isGroundClear(c0 + sc + 0.1, r0 + sr * 0.55)) {
      slots.push({
        id: `${building.id}-carve-1`,
        action: 'carve_statue',
        col: c0 + sc - 0.05,
        row: r0 + sr * 0.55,
        elevationPx: elev * 0.65,
        facing: 'W',
      });
    }
    if (isGroundClear(c0 + sc * 0.45, r0 + sr + 0.15)) {
      slots.push({
        id: `${building.id}-carve-2`,
        action: 'carve_statue',
        col: c0 + sc * 0.45,
        row: r0 + sr + 0.05,
        elevationPx: Math.max(0, elev * 0.35),
        facing: 'N',
      });
    }
    return slots;
  }

  /* Active construction building stages. */
  if (state && state.phase === 'building') {
    const spec = resolveStageSpecForBuilding(building, state, pack);
    if (spec.openInteriorVisible) {
      /* Workers visibly laying walls inside the exposed interior rooms, both well inside the walls: on a 3x3 the strip
         along the front right wall (from u 1.95 out) belongs to the shared front scaffold and ramp (#1975). */
      slots.push(
        { id: `${building.id}-int-1`, action: 'interior_mason', col: c0 + sc * 0.34, row: r0 + sr * 0.44, elevationPx: 5, facing: 'N' },
        { id: `${building.id}-int-2`, action: 'interior_mason', col: c0 + sc * 0.56, row: r0 + sr * 0.66, elevationPx: 5, facing: 'W' },
      );
    }
    if (spec.hasScaffolding) {
      const scaffoldElev = Math.round(14 + spec.heightRatio * 34);
      slots.push(
        { id: `${building.id}-scaf-1`, action: 'hammer_scaffold', col: c0 + sc + 0.04, row: r0 + sr * 0.48, elevationPx: scaffoldElev, facing: 'W' },
        { id: `${building.id}-scaf-2`, action: 'hammer_scaffold', col: c0 + sc * 0.42, row: r0 + sr + 0.04, elevationPx: Math.round(scaffoldElev * 0.65), facing: 'N' },
      );
    }
    if (spec.hasRamp) {
      slots.push(
        { id: `${building.id}-ramp-1`, action: 'carry_ramp', col: c0 + sc * 0.72, row: r0 + sr + 0.22, elevationPx: 10, facing: 'N' },
        { id: `${building.id}-sled-1`, action: 'pull_sled', col: c0 + sc * 0.35, row: r0 + sr + 0.68, elevationPx: 0, facing: 'E' },
      );
    }
  }

  return slots;
}

export function createConstructionSimulation(pack: WorldPackManifest): ConstructionSimulation {
  return {
    packId: pack.id,
    timeSec: 0,
    jobs: new Map(),
    relocations: [],
    dirtyCityVersion: 0,
  };
}

export function startBuildingConstruction(
  sim: ConstructionSimulation,
  building: CityBuilding,
  targetStage = building.maxStage,
  startStage = 1,
  stagesPerSec = 1.2,
): BuildingConstructionState {
  const maxStage = Math.max(1, building.maxStage);
  const clampedStart = Math.max(1, Math.min(maxStage, Math.round(startStage)));
  const clampedTarget = Math.max(clampedStart, Math.min(maxStage, Math.round(targetStage)));
  const state: BuildingConstructionState = {
    id: `build-${building.id}`,
    buildingId: building.id,
    buildingSnapshot: { ...building, stage: clampedStart },
    kind: building.kind,
    col: building.col,
    row: building.row,
    spanCol: building.spanCol,
    spanRow: building.spanRow,
    phase: clampedStart >= clampedTarget ? 'complete' : 'building',
    currentStage: clampedStart,
    targetStage: clampedTarget,
    maxStage,
    stageProgress: 0,
    stagesPerSec: Math.max(0.05, stagesPerSec),
    stageHistory: [clampedStart],
  };
  sim.jobs.set(building.id, state);
  sim.dirtyCityVersion++;
  return state;
}

export function startBuildingDemolition(
  sim: ConstructionSimulation,
  building: CityBuilding,
  stagesPerSec = 1.2,
): BuildingConstructionState {
  const maxStage = Math.max(1, building.maxStage);
  const startStage = Math.max(1, Math.min(maxStage, Math.round(building.stage)));
  const state: BuildingConstructionState = {
    id: `demolish-${building.id}`,
    buildingId: building.id,
    buildingSnapshot: { ...building, stage: startStage },
    kind: building.kind,
    col: building.col,
    row: building.row,
    spanCol: building.spanCol,
    spanRow: building.spanRow,
    phase: 'demolishing',
    currentStage: startStage,
    targetStage: 0,
    maxStage,
    stageProgress: 0,
    stagesPerSec: Math.max(0.05, stagesPerSec),
    stageHistory: [startStage],
  };
  sim.jobs.set(building.id, state);
  sim.dirtyCityVersion++;
  return state;
}

/* Starts a God's Word relocation transition: the old building dismantles strictly in reverse
   stage order (S -> S-1 -> ... -> 0) while the new building rises stage-by-stage (1 -> ... -> S)
   at (toCol, toRow). */
export function startBuildingRelocation(
  sim: ConstructionSimulation,
  building: CityBuilding,
  toCol: number,
  toRow: number,
  stagesPerSec = 1.2,
): BuildingRelocationTransition {
  const maxStage = Math.max(1, building.maxStage);
  const startStage = Math.max(1, Math.min(maxStage, Math.round(building.stage)));
  const oldKey = `${building.id}__old`;
  const oldSnap: CityBuilding = { ...building, id: oldKey, stage: startStage };
  const newSnap: CityBuilding = { ...building, col: toCol, row: toRow, stage: 1 };

  const demolishState: BuildingConstructionState = {
    id: `reloc-dem-${building.id}`,
    buildingId: oldKey,
    buildingSnapshot: oldSnap,
    kind: building.kind,
    col: building.col,
    row: building.row,
    spanCol: building.spanCol,
    spanRow: building.spanRow,
    phase: 'demolishing',
    currentStage: startStage,
    targetStage: 0,
    maxStage,
    stageProgress: 0,
    stagesPerSec: Math.max(0.05, stagesPerSec),
    stageHistory: [startStage],
  };

  const buildState: BuildingConstructionState = {
    id: `reloc-bld-${building.id}`,
    buildingId: building.id,
    buildingSnapshot: newSnap,
    kind: building.kind,
    col: toCol,
    row: toRow,
    spanCol: building.spanCol,
    spanRow: building.spanRow,
    phase: startStage <= 1 ? 'complete' : 'building',
    currentStage: 1,
    targetStage: startStage,
    maxStage,
    stageProgress: 0,
    stagesPerSec: Math.max(0.05, stagesPerSec),
    stageHistory: [1],
  };

  sim.jobs.set(oldKey, demolishState);
  sim.jobs.set(building.id, buildState);
  const transition: BuildingRelocationTransition = {
    id: `reloc-${building.id}-${toCol}-${toRow}`,
    buildingId: building.id,
    fromCol: building.col,
    fromRow: building.row,
    toCol,
    toRow,
    demolishState,
    buildState,
    completed: false,
  };
  sim.relocations.push(transition);
  sim.dirtyCityVersion++;
  return transition;
}

/* Advances all active construction, demolition and relocation timers by dtSec.
   Returns true whenever at least one discrete building stage transitioned. */
export function stepConstructionSimulation(sim: ConstructionSimulation, dtSec: number): boolean {
  const dt = Math.max(0.001, Math.min(0.5, dtSec));
  sim.timeSec += dt;
  let stageChanged = false;

  for (const job of sim.jobs.values()) {
    if (job.phase === 'complete' || job.phase === 'cleared') continue;
    job.stageProgress += dt * job.stagesPerSec;

    while (job.stageProgress >= 1 && (job.phase === 'building' || job.phase === 'demolishing')) {
      job.stageProgress -= 1;
      if (job.phase === 'building') {
        if (job.currentStage < job.targetStage) {
          job.currentStage++;
          job.buildingSnapshot.stage = job.currentStage;
          job.stageHistory.push(job.currentStage);
          stageChanged = true;
        }
        if (job.currentStage >= job.targetStage) {
          job.phase = 'complete';
          job.stageProgress = 0;
          break;
        }
      } else {
        if (job.currentStage > 0) {
          job.currentStage--;
          job.buildingSnapshot.stage = job.currentStage;
          job.stageHistory.push(job.currentStage);
          stageChanged = true;
        }
        if (job.currentStage <= 0) {
          job.phase = 'cleared';
          job.stageProgress = 0;
          break;
        }
      }
    }
  }

  for (const rel of sim.relocations) {
    if (!rel.completed && rel.demolishState.phase === 'cleared' && rel.buildState.phase === 'complete') {
      rel.completed = true;
    }
  }

  if (stageChanged) {
    sim.dirtyCityVersion++;
  }
  return stageChanged;
}
