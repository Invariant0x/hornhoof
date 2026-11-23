import { describe, expect, it } from 'vitest';
import { declaredArtFiles, resolveBuildingArt, type ArtIndex, type ArtIndexEntry } from '../src/world/art';
import type { BuildingKind, CityBuilding } from '../src/world/city-layout';
import { buildingLoopsFor, createConstructionSimulation, startBuildingConstruction } from '../src/world/construction';
import { DUNGEON_WORLD_PACK } from '../src/world-packs/dungeon/pack';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

function monument(kind: BuildingKind, span: number, maxStage: number): CityBuilding {
  return {
    id: `${kind}-1`,
    kind,
    label: kind,
    col: 40,
    row: 40,
    spanCol: span,
    spanRow: span,
    lot: { col: 40, row: 40, spanCol: span, spanRow: span },
    door: { col: 40 + span, row: 40 + span - 1 },
    stage: 1,
    maxStage,
    floors: 1,
    level: 1,
    residentIds: [],
    mergedFromIds: [],
    goalCount: 0,
    placedAtStep: 0,
    progress: 0,
  };
}

/* Every picture the pack declares for statues and pyramids, each with a passport on its footprint's canvas. */
function monumentIndex(): ArtIndex {
  const files: Record<string, ArtIndexEntry> = {};
  for (const d of declaredArtFiles(EGYPT_WORLD_PACK)) {
    if (!/^buildings\/(statue|monument)\//.test(d.path) && !d.path.startsWith('modules/') && !d.path.startsWith('loops/')) continue;
    files[d.path] =
      d.passport === 'anchor'
        ? { w: 64, h: 64, passport: { anchor: { x: 32, y: 60 } } }
        : d.passport === 'sheet'
          ? { w: 128, h: 128, passport: { frameW: 128, frameH: 128, frames: 1, fps: 1, anchor: { x: 64, y: 120 } } }
          : { w: 400, h: 400, passport: { groundAnchor: { x: 200, y: 300 }, corners: { top: { x: 200, y: 200 }, right: { x: 400, y: 300 }, bottom: { x: 200, y: 400 }, left: { x: 0, y: 300 } }, topAnchor: { x: 200, y: 20 } } };
  }
  return { contract: 2, pack: 'egypt', files };
}

describe('Statues and pyramids are built from their own stages (#1975)', () => {
  it('lays no crane or hoist over a statue or a pyramid of a pack that draws their building work into the stages', () => {
    expect(EGYPT_WORLD_PACK.art?.ownConstruction).toEqual(['statue', 'monument']);
    for (const [kind, span, max] of [['statue', 3, 20], ['monument', 5, 10]] as const) {
      const sim = createConstructionSimulation(EGYPT_WORLD_PACK);
      for (let stage = 1; stage < max; stage++) {
        const job = startBuildingConstruction(sim, monument(kind, span, max), max, stage, 0.05);
        const loops = buildingLoopsFor(monument(kind, span, max), job, EGYPT_WORLD_PACK).map(l => l.kind);
        expect(loops, `${kind} stage ${stage}`).not.toContain('crane');
        expect(loops, `${kind} stage ${stage}`).not.toContain('hoist_block');
      }
    }
  });

  it('keeps the crane over a statue of a pack that declares no such thing', () => {
    expect(DUNGEON_WORLD_PACK.art?.ownConstruction).toBeUndefined();
    const sim = createConstructionSimulation(DUNGEON_WORLD_PACK);
    const statue = monument('statue', 2, 20);
    const job = startBuildingConstruction(sim, statue, 20, 8, 0.05);
    expect(buildingLoopsFor(statue, job, DUNGEON_WORLD_PACK).map(l => l.kind)).toContain('crane');
  });

  it('reads a statue with no job from its own stage: carving dust with the kit’s crane between stages 4 and 18, shimmer when finished', () => {
    const loops = (pack: typeof DUNGEON_WORLD_PACK, b: CityBuilding) => buildingLoopsFor(b, null, pack).map(l => l.kind);
    const at = (stage: number, reached = false) => ({ ...monument('statue', 2, 20), stage, reached });
    expect(loops(DUNGEON_WORLD_PACK, at(3))).toEqual(['dust']);
    expect(loops(DUNGEON_WORLD_PACK, at(4))).toEqual(['dust', 'crane', 'hoist_block']);
    expect(loops(DUNGEON_WORLD_PACK, at(19))).toEqual(['dust']);
    expect(loops(DUNGEON_WORLD_PACK, at(20))).toEqual(['celebration']);
    expect(loops(DUNGEON_WORLD_PACK, at(9, true))).toEqual(['celebration']);
    expect(loops(EGYPT_WORLD_PACK, at(9))).toEqual(['dust']);
    const sim = createConstructionSimulation(DUNGEON_WORLD_PACK);
    const statue = monument('statue', 2, 20);
    const job = startBuildingConstruction(sim, statue, 20, 20, 0.05);
    expect(buildingLoopsFor(statue, { ...job, phase: 'complete', currentStage: 20 }, DUNGEON_WORLD_PACK).map(l => l.kind)).toEqual(['celebration']);
  });

  it('shows a statue’s 20 stages and a pyramid’s 10 tiers in order, each from its own picture with no kit module', () => {
    const index = monumentIndex();
    const sim = createConstructionSimulation(EGYPT_WORLD_PACK);
    const statue = monument('statue', 3, 20);
    const statueShown = Array.from({ length: 20 }, (_, i) => {
      const art = resolveBuildingArt(EGYPT_WORLD_PACK, index, statue, startBuildingConstruction(sim, statue, 20, i + 1, 0.05))!;
      expect(art.layers.some(l => l.path.startsWith('modules/')), `statue stage ${i + 1}`).toBe(false);
      return art.layers[0]!.path.split('/').pop();
    });
    expect(statueShown).toEqual(Array.from({ length: 20 }, (_, i) => `stage_${String(i + 1).padStart(2, '0')}.png`));
    const pyramid = monument('monument', 5, 10);
    const pyramidShown = Array.from({ length: 10 }, (_, i) => {
      const art = resolveBuildingArt(EGYPT_WORLD_PACK, index, pyramid, startBuildingConstruction(sim, pyramid, 10, i + 1, 0.05))!;
      expect(art.layers.some(l => l.path.startsWith('modules/')), `pyramid stage ${i + 1}`).toBe(false);
      return art.layers[0]!.path.split('/').pop();
    });
    expect(pyramidShown).toEqual(Array.from({ length: 10 }, (_, i) => `tier_${String(i + 1).padStart(2, '0')}.png`));
  });
});
