import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CityBuilding } from '../src/world/city-layout';
import {
  buildingLoopsFor,
  computeStatueAlleyProgress,
  createConstructionSimulation,
  startBuildingConstruction,
  startBuildingDemolition,
  startBuildingRelocation,
  stepConstructionSimulation,
  workSlotsForBuilding,
} from '../src/world/construction';
import {
  CONSTRUCTION_STAGE_IDS,
  DEFAULT_CONSTRUCTION_STAGES,
  resolveConstructionStages,
} from '../src/world/manifest';
import { DUNGEON_WORLD_PACK } from '../src/world-packs/dungeon/pack';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

function makeBuilding(overrides: Partial<CityBuilding> = {}): CityBuilding {
  return {
    id: 'dept-dev',
    kind: 'department',
    label: 'Development',
    col: 70,
    row: 70,
    spanCol: 4,
    spanRow: 4,
    door: { col: 71, row: 74 },
    lot: { col: 69, row: 69, spanCol: 6, spanRow: 6 },
    stage: 10,
    maxStage: 10,
    level: 10,
    floors: 2,
    residentIds: [],
    mergedFromIds: [],
    goalCount: 0,
    placedAtStep: 1,
    departmentId: 'dept-dev',
    ...overrides,
  };
}

describe('Stage 6 construction stages, building animation loops, work slots, 20-stage statues, pyramids and reverse demolition', () => {
  it('reads all 10 construction stages from the active world pack with distinct Egypt and Dungeon packs and neutral engine defaults', () => {
    expect(CONSTRUCTION_STAGE_IDS).toEqual([
      'stakes_and_rope',
      'foundation',
      'low_walls_open',
      'waist_walls_scaffold',
      'full_walls',
      'roof_beams',
      'roof',
      'finishing',
      'complete',
      'upgraded',
    ]);

    const egyptStages = resolveConstructionStages(EGYPT_WORLD_PACK);
    const dungeonStages = resolveConstructionStages(DUNGEON_WORLD_PACK);
    expect(egyptStages).toHaveLength(10);
    expect(dungeonStages).toHaveLength(10);
    expect(egyptStages.map(s => s.id)).toEqual([...CONSTRUCTION_STAGE_IDS]);
    expect(dungeonStages.map(s => s.id)).toEqual([...CONSTRUCTION_STAGE_IDS]);

    /* Packs customize stage labels/materials independently without changing engine code. */
    expect(egyptStages[0]!.label.ru).not.toBe(dungeonStages[0]!.label.ru);
    expect(egyptStages[9]!.label.en).not.toBe(dungeonStages[9]!.label.en);

    /* Key architectural stage properties required by Stage 6. */
    const openWalls = egyptStages.find(s => s.id === 'low_walls_open')!;
    const waistScaffold = egyptStages.find(s => s.id === 'waist_walls_scaffold')!;
    const roofBeams = egyptStages.find(s => s.id === 'roof_beams')!;
    const complete = egyptStages.find(s => s.id === 'complete')!;
    expect(openWalls.openInteriorVisible).toBe(true);
    expect(waistScaffold.hasScaffolding).toBe(true);
    expect(waistScaffold.hasRamp).toBe(true);
    expect(roofBeams.hasRoofBeams).toBe(true);
    expect(complete.hasScaffolding).toBe(false);

    /* Fallback when a minimal pack omits constructionStages. */
    const fallback = resolveConstructionStages({ ...EGYPT_WORLD_PACK, constructionStages: undefined });
    expect(fallback).toEqual(DEFAULT_CONSTRUCTION_STAGES);
  });

  it('activates stage-appropriate building animation loops (crane, hoist, dust, smoke, water, awning, celebration) and resident work slots', () => {
    const sim = createConstructionSimulation(EGYPT_WORLD_PACK);
    const dept = makeBuilding({ id: 'dept-build', stage: 3, maxStage: 10 });

    /* Stage 3 (low_walls_open): open rooms with interior masons + dust. */
    const openState = startBuildingConstruction(sim, dept, 10, 3);
    const openLoops = buildingLoopsFor(dept, openState, EGYPT_WORLD_PACK);
    const openSlots = workSlotsForBuilding(dept, openState, EGYPT_WORLD_PACK);
    expect(openLoops.map(l => l.kind)).toContain('dust');
    expect(openSlots.some(s => s.action === 'interior_mason')).toBe(true);

    /* Stage 4 (waist_walls_scaffold): crane, hoist_block, dust + scaffold hammerers, ramp carriers & sled team! */
    openState.currentStage = 4;
    const midLoops = buildingLoopsFor(dept, openState, EGYPT_WORLD_PACK);
    const midSlots = workSlotsForBuilding(dept, openState, EGYPT_WORLD_PACK);
    expect(midLoops.map(l => l.kind)).toEqual(expect.arrayContaining(['crane', 'hoist_block', 'dust']));
    expect(midSlots.map(s => s.action)).toEqual(expect.arrayContaining(['hammer_scaffold', 'carry_ramp', 'pull_sled']));

    /* Completed department -> fluttering awning + hearth smoke, zero crane. */
    const doneDept = makeBuilding({ id: 'dept-done', stage: 9, maxStage: 10 });
    const doneLoops = buildingLoopsFor(doneDept, null, EGYPT_WORLD_PACK);
    expect(doneLoops.map(l => l.kind)).toEqual(expect.arrayContaining(['awning', 'smoke']));
    expect(doneLoops.map(l => l.kind)).not.toContain('crane');

    /* Active supply well/granary -> animated water loop. */
    const supply = makeBuilding({ id: 'sub-1', kind: 'supply', spanCol: 2, spanRow: 2, fullness: 0.75, stage: 5 });
    expect(buildingLoopsFor(supply, null, EGYPT_WORLD_PACK).map(l => l.kind)).toContain('water');

    /* Incomplete vs reached goal monument -> construction crane/sleds vs golden capstone celebration! */
    const buildingPyramid = makeBuilding({
      id: 'goal-1',
      kind: 'monument',
      spanCol: 6,
      spanRow: 6,
      stage: 6,
      maxStage: 10,
      progress: 0.6,
      reached: false,
    });
    const pyrLoopsActive = buildingLoopsFor(buildingPyramid, null, EGYPT_WORLD_PACK);
    const pyrSlotsActive = workSlotsForBuilding(buildingPyramid, null, EGYPT_WORLD_PACK);
    expect(pyrLoopsActive.map(l => l.kind)).toEqual(expect.arrayContaining(['crane', 'hoist_block', 'dust']));
    expect(pyrLoopsActive.map(l => l.kind)).not.toContain('celebration');
    expect(pyrSlotsActive.some(s => s.action === 'pull_sled')).toBe(true);

    const reachedPyramid = { ...buildingPyramid, stage: 10, progress: 1, reached: true };
    const pyrLoopsDone = buildingLoopsFor(reachedPyramid, null, EGYPT_WORLD_PACK);
    expect(pyrLoopsDone.map(l => l.kind)).toContain('celebration');
    expect(pyrLoopsDone.map(l => l.kind)).not.toContain('crane');
  });

  it('tracks 20-stage statues and statue alleys (completed statue stays, next larger statue begins beside it)', () => {
    const midFirst = computeStatueAlleyProgress(1500, 20, 100);
    expect(midFirst).toHaveLength(1);
    expect(midFirst[0]).toMatchObject({ index: 0, stage: 15, maxStage: 20, completed: false, span: 1 });

    const exactFirst = computeStatueAlleyProgress(2000, 20, 100);
    expect(exactFirst).toHaveLength(1);
    expect(exactFirst[0]).toMatchObject({ index: 0, stage: 20, maxStage: 20, completed: true, span: 1 });

    /* Past 2,000 tasks: Statue #1 stays complete (1x1) while Statue #2 grows larger (2x2) at stage 5/20! */
    const secondGrowing = computeStatueAlleyProgress(2500, 20, 100);
    expect(secondGrowing).toHaveLength(2);
    expect(secondGrowing[0]).toMatchObject({ index: 0, stage: 20, completed: true, span: 1 });
    expect(secondGrowing[1]).toMatchObject({ index: 1, stage: 5, maxStage: 20, completed: false, span: 2 });

    /* Past 4,000 tasks: Statues #1 (1x1) & #2 (2x2) stay complete while Statue #3 (3x3) grows! */
    const thirdGrowing = computeStatueAlleyProgress(4800, 20, 100);
    expect(thirdGrowing).toHaveLength(3);
    expect(thirdGrowing[2]).toMatchObject({ index: 2, stage: 8, maxStage: 20, completed: false, span: 3 });

    /* Statue under construction emits carving scaffold work slots. */
    const statueB = makeBuilding({ id: 'statue-1', kind: 'statue', spanCol: 2, spanRow: 2, stage: 12, maxStage: 20, reached: false });
    const slots = workSlotsForBuilding(statueB, null, EGYPT_WORLD_PACK);
    expect(slots.some(s => s.action === 'carve_statue')).toBe(true);
  });

  it('executes forward construction 1..10, demolition strictly in reverse stage order 10..0, and stage-by-stage relocation with zero theme words in engine core', () => {
    const sim = createConstructionSimulation(EGYPT_WORLD_PACK);
    const dept = makeBuilding({ id: 'dept-cycle', stage: 1, maxStage: 10 });

    /* 1. Forward construction 1 -> 10. */
    const buildJob = startBuildingConstruction(sim, dept, 10, 1, 2.0);
    for (let i = 0; i < 60; i++) {
      stepConstructionSimulation(sim, 0.25);
    }
    expect(buildJob.phase).toBe('complete');
    expect(buildJob.currentStage).toBe(10);
    expect(buildJob.stageHistory).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    /* 2. Reverse-order demolition 10 -> 9 -> ... -> 1 -> 0 (cleared). */
    const demoJob = startBuildingDemolition(sim, { ...dept, stage: 10 }, 2.0);
    let sawDemolishDust = false;
    let sawDemolishSlot = false;
    for (let i = 0; i < 70; i++) {
      stepConstructionSimulation(sim, 0.25);
      if (demoJob.phase === 'demolishing') {
        if (buildingLoopsFor(dept, demoJob, EGYPT_WORLD_PACK).some(l => l.kind === 'dust')) sawDemolishDust = true;
        if (workSlotsForBuilding(dept, demoJob, EGYPT_WORLD_PACK).some(s => s.action === 'demolish_rubble')) {
          sawDemolishSlot = true;
        }
      }
    }
    expect(sawDemolishDust).toBe(true);
    expect(sawDemolishSlot).toBe(true);
    expect(demoJob.phase).toBe('cleared');
    expect(demoJob.currentStage).toBe(0);
    expect(demoJob.stageHistory).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);

    /* 3. God's Word relocation: old site dismantles in reverse while new site builds 1..8! */
    const house = makeBuilding({ id: 'house-rel', kind: 'house', col: 60, row: 60, spanCol: 2, spanRow: 2, stage: 8, maxStage: 10 });
    const reloc = startBuildingRelocation(sim, house, 68, 64, 2.5);
    expect(reloc.demolishState.phase).toBe('demolishing');
    expect(reloc.demolishState.currentStage).toBe(8);
    expect(reloc.buildState.phase).toBe('building');
    expect(reloc.buildState.currentStage).toBe(1);

    for (let i = 0; i < 80; i++) {
      stepConstructionSimulation(sim, 0.25);
    }
    expect(reloc.completed).toBe(true);
    expect(reloc.demolishState.phase).toBe('cleared');
    expect(reloc.demolishState.stageHistory).toEqual([8, 7, 6, 5, 4, 3, 2, 1, 0]);
    expect(reloc.buildState.phase).toBe('complete');
    expect(reloc.buildState.stageHistory).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    /* 4. Zero theme words in core engine files. */
    const forbidden = /\b(egypt|pharaoh|nile|pyramidion|oasis|dungeon|magma|bedrock|papyrus|medjay)\b/i;
    for (const relPath of [
      'src/world/manifest.ts',
      'src/world/construction.ts',
      'src/world/construction-renderer.ts',
      'src/world/city-renderer.ts',
    ]) {
      const src = readFileSync(resolve(process.cwd(), relPath), 'utf8');
      expect(forbidden.test(src), `${relPath} must contain zero theme words`).toBe(false);
    }
  });
});
