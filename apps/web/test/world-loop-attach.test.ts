import { describe, expect, it } from 'vitest';
import type { BuildingPicturePassport } from '../src/world/art';
import type { CityBuilding } from '../src/world/city-layout';
import { buildingLoopsFor, createConstructionSimulation, startBuildingConstruction, startBuildingDemolition } from '../src/world/construction';
import { loopTopPoint } from '../src/world/construction-renderer';
import { DUNGEON_WORLD_PACK } from '../src/world-packs/dungeon/pack';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

/* Ivan AI, 24.11, before the egypt-loops-v1 pack: where the artist loop sheets sit on a building drawn from its picture. */

const corners = { top: { x: 240, y: 520 }, right: { x: 480, y: 640 }, bottom: { x: 240, y: 760 }, left: { x: 0, y: 640 } };
const passport = (extra: Partial<BuildingPicturePassport> = {}): BuildingPicturePassport => ({
  groundAnchor: { x: 240, y: 640 },
  corners,
  ...extra,
});

describe('the top point of a building picture, where smoke, celebration and the other top loops attach', () => {
  it('is the picture’s topAnchor when it names one', () => {
    expect(loopTopPoint(passport({ topAnchor: { x: 250, y: 90 }, flagAnchor: { x: 238, y: 368 }, roofLine: 400 }))).toEqual({ x: 250, y: 90 });
  });

  it('is the flag pole’s foot on a finished house, which names no topAnchor or roof line, not the back corner of its lot', () => {
    expect(loopTopPoint(passport({ flagAnchor: { x: 238, y: 368 } }))).toEqual({ x: 238, y: 368 });
  });

  it('falls back to the roof line, then the wall top, then the back ground corner, above the lot centre', () => {
    expect(loopTopPoint(passport({ roofLine: 400, wallTopLine: 450 }))).toEqual({ x: 240, y: 400 });
    expect(loopTopPoint(passport({ wallTopLine: 450 }))).toEqual({ x: 240, y: 450 });
    expect(loopTopPoint(passport())).toEqual({ x: 240, y: 520 });
  });
});

function site(span: number, overrides: Partial<CityBuilding> = {}): CityBuilding {
  return {
    id: `site-${span}`,
    kind: 'house',
    label: 'House',
    col: 40,
    row: 40,
    spanCol: span,
    spanRow: span,
    door: { col: 40, row: 40 + span },
    lot: { col: 40, row: 40, spanCol: span, spanRow: span },
    stage: 1,
    maxStage: 10,
    level: 1,
    floors: 1,
    residentIds: [],
    mergedFromIds: [],
    goalCount: 0,
    placedAtStep: 1,
    ...overrides,
  };
}

const lifts = (kinds: readonly string[]) => kinds.filter(k => k === 'crane' || k === 'hoist_block');

describe('one lift over a building site: the crane on a lot of 3x3 and up, the hoisted block alone on a smaller one', () => {
  it('raises walls and beams (stages 4 to 6) with the crane alone on 3x3 and larger lots, since the crane draws its own block', () => {
    for (const span of [3, 4, 5]) {
      const sim = createConstructionSimulation(EGYPT_WORLD_PACK);
      const b = site(span);
      for (const stage of [4, 5, 6]) {
        const job = startBuildingConstruction(sim, b, 10, stage);
        expect(lifts(buildingLoopsFor(b, job, EGYPT_WORLD_PACK).map(l => l.kind)), `${span}x${span} stage ${stage}`).toEqual(['crane']);
      }
    }
  });

  it('raises them with the hoisted block alone on 2x2 and 1x1 lots', () => {
    for (const span of [1, 2]) {
      const sim = createConstructionSimulation(EGYPT_WORLD_PACK);
      const b = site(span);
      for (const stage of [4, 5, 6]) {
        const job = startBuildingConstruction(sim, b, 10, stage);
        expect(lifts(buildingLoopsFor(b, job, EGYPT_WORLD_PACK).map(l => l.kind)), `${span}x${span} stage ${stage}`).toEqual(['hoist_block']);
      }
    }
  });

  it('keeps the same rule for demolition and for the kit over the statues and monuments of a pack that lays it', () => {
    const sim = createConstructionSimulation(DUNGEON_WORLD_PACK);
    for (const [span, lift] of [[2, 'hoist_block'], [4, 'crane']] as const) {
      const b = site(span, { id: `old-${span}`, stage: 10 });
      const job = startBuildingDemolition(sim, b);
      job.currentStage = 6;
      expect(lifts(buildingLoopsFor(b, job, DUNGEON_WORLD_PACK).map(l => l.kind)), `demolition ${span}x${span}`).toEqual([lift]);

      const statue = site(span, { id: `statue-${span}`, kind: 'statue', stage: 8, maxStage: 20 });
      expect(lifts(buildingLoopsFor(statue, null, DUNGEON_WORLD_PACK).map(l => l.kind)), `statue ${span}x${span}`).toEqual([lift]);

      const monument = site(span + 2, { id: `goal-${span}`, kind: 'monument', stage: 6, progress: 0.6, reached: false });
      expect(lifts(buildingLoopsFor(monument, null, DUNGEON_WORLD_PACK).map(l => l.kind)), `monument ${span + 2}x${span + 2}`).toEqual(['crane']);
    }
  });
});
