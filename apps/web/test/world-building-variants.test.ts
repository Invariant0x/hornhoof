import { describe, expect, it } from 'vitest';
import { declaredArtFiles, resolveBuildingArt, validateArtIndex, variantStepOf, type ArtIndex, type ArtIndexEntry } from '../src/world/art';
import { chooseBuildingVariants, cityBuildingVariants } from '../src/world/building-variants';
import type { CityBuilding } from '../src/world/city-layout';
import { createConstructionSimulation, startBuildingConstruction, startBuildingDemolition, type BuildingConstructionState } from '../src/world/construction';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

/* A home on a 4x4 lot at (col, row), its house standing at the lot's front corner. */
function home(id: string, col: number, row: number, level = 1, placedAtStep = 0): CityBuilding {
  const span = level >= 4 ? 3 : 2;
  return {
    id,
    kind: 'house',
    label: id,
    col: col + 4 - span,
    row: row + 4 - span,
    spanCol: span,
    spanRow: span,
    lot: { col, row, spanCol: 4, spanRow: 4 },
    door: { col: col + 4, row: row + 3 },
    stage: 1,
    maxStage: 10,
    floors: 1,
    level,
    residentIds: [],
    mergedFromIds: [],
    goalCount: 0,
    placedAtStep,
  };
}

/* A street of homes on 4x4 lots with one-tile lanes between them, rows of `perRow`. */
function street(n: number, perRow = 5, level = 1): CityBuilding[] {
  return Array.from({ length: n }, (_, i) => home(`house-agent-${i + 1}`, 40 + (i % perRow) * 5, 40 + Math.floor(i / perRow) * 5, level, i));
}

const byStep = (count: number) => (b: CityBuilding) => (b.kind === 'house' ? { key: `house/${b.spanCol}`, count } : null);

function neighbours(a: CityBuilding, b: CityBuilding): boolean {
  const gapC = Math.max(b.lot.col - (a.lot.col + a.lot.spanCol), a.lot.col - (b.lot.col + b.lot.spanCol));
  const gapR = Math.max(b.lot.row - (a.lot.row + a.lot.spanRow), a.lot.row - (b.lot.row + b.lot.spanRow));
  return a.id !== b.id && gapC <= 1 && gapR <= 1;
}

describe('Drawn variants of a building step (#1975)', () => {
  it('gives every home the same variant on two loads, whatever order the city lists its buildings in', () => {
    const first = chooseBuildingVariants(street(20), byStep(15));
    const second = chooseBuildingVariants([...street(20)].reverse(), byStep(15));
    expect(first.size).toBe(20);
    expect([...second.entries()].sort()).toEqual([...first.entries()].sort());
    for (const v of first.values()) expect(v >= 0 && v < 15).toBe(true);
  });

  it('never repeats a variant next door while another one is free, and uses more than one', () => {
    const homes = street(25);
    const chosen = chooseBuildingVariants(homes, byStep(15));
    for (const a of homes) for (const b of homes) if (neighbours(a, b)) expect(chosen.get(a.id), `${a.id} ${b.id}`).not.toBe(chosen.get(b.id));
    expect(new Set(chosen.values()).size).toBeGreaterThan(5);
  });

  it('keeps an older home as it is when a newer one is built next door', () => {
    const homes = street(9, 3);
    const before = chooseBuildingVariants(homes, byStep(4));
    const after = chooseBuildingVariants([...homes, home('house-agent-new', 40 + 3 * 5, 40, 1, 99)], byStep(4));
    for (const h of homes) expect(after.get(h.id), h.id).toBe(before.get(h.id));
  });

  it('settles homes placed in the same step by their ids, so the order of the list never matters', () => {
    const homes = street(12).map(h => ({ ...h, placedAtStep: 0 }));
    const first = chooseBuildingVariants(homes, byStep(3));
    expect([...chooseBuildingVariants([...homes].reverse(), byStep(3)).entries()].sort()).toEqual([...first.entries()].sort());
  });

  it('chooses for the city shown under the pack, and for none without a city', () => {
    const homes = street(6);
    expect(cityBuildingVariants(null, EGYPT_WORLD_PACK).size).toBe(0);
    expect([...cityBuildingVariants({ city: { buildings: homes } }, EGYPT_WORLD_PACK).entries()]).toEqual([
      ...chooseBuildingVariants(homes, b => variantStepOf(EGYPT_WORLD_PACK, b)).entries(),
    ]);
  });

  it('gives every home the only variant when a step has one, and leaves kinds without variants out', () => {
    const chosen = chooseBuildingVariants(street(6), byStep(1));
    expect([...chosen.values()]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(chooseBuildingVariants(street(3), () => null).size).toBe(0);
  });
});

describe('Variant folders in the art (#1975)', () => {
  const corners = { top: { x: 240, y: 439 }, right: { x: 480, y: 559 }, bottom: { x: 240, y: 679 }, left: { x: 0, y: 559 } };
  const picture: ArtIndexEntry = { w: 480, h: 680, passport: { groundAnchor: { x: 240, y: 559 }, corners } };
  const index = (variants: readonly string[]): ArtIndex => ({
    contract: 2,
    pack: 'egypt',
    files: Object.fromEntries(variants.map(v => [`buildings/house/hut/${v}/complete.png`, picture])),
  });
  const hut = home('house-agent-7', 40, 40, 1);

  it('declares the pack’s house variants: v01 of each step required, the others optional', () => {
    const files = declaredArtFiles(EGYPT_WORLD_PACK);
    const hutComplete = files.filter(f => /^buildings\/house\/hut\/v\d\d\/complete\.png$/.test(f.path));
    expect(hutComplete.map(f => f.path)).toHaveLength(15);
    expect(hutComplete.filter(f => f.required).map(f => f.path)).toEqual(['buildings/house/hut/v01/complete.png']);
    /* The step folder itself stands for v01 (order v3: a step with no variant folders keeps its pictures there). */
    expect(files.find(f => f.path === 'buildings/house/hut/complete.png')?.required).toBe(false);
    expect(variantStepOf(EGYPT_WORLD_PACK, hut)).toEqual({ key: 'house/hut', count: 15 });
    expect(variantStepOf(EGYPT_WORLD_PACK, { ...hut, kind: 'district_hub', stage: 1 })).toBeNull();
  });

  it('checks a variant picture against its step’s footprint, as any other picture of the step', () => {
    const wide: ArtIndexEntry = { ...picture, w: 720, h: 760 };
    const report = validateArtIndex(EGYPT_WORLD_PACK, {
      contract: 2,
      pack: 'egypt',
      files: { 'buildings/house/hut/v01/complete.png': picture, 'buildings/house/hut/v02/complete.png': { ...wide, passport: { groundAnchor: { x: 360, y: 559 }, corners: { top: { x: 360, y: 379 }, right: { x: 720, y: 559 }, bottom: { x: 360, y: 739 }, left: { x: 0, y: 559 } } } } },
    });
    expect(report.errors.filter(e => e.startsWith('buildings/house/hut/v01/'))).toEqual([]);
    expect(report.errors).toContain('buildings/house/hut/v02/complete.png: diamond width 720 px does not match footprint 2x2 (480 px)');
  });

  it('gives a home the lot of its largest step in every pack with house art', () => {
    for (const pack of [EGYPT_WORLD_PACK]) {
      const largest = Math.max(...(pack.art?.buildings.house ?? []).map(s => Number(s.footprint.split('x')[0])));
      expect(pack.buildingLayout?.house?.spans.at(-1), pack.id).toBe(largest);
    }
  });

  it('draws the chosen variant, the next delivered one when it is missing, and nothing without art', () => {
    const path = (art: ReturnType<typeof resolveBuildingArt>) => art?.layers[0]?.path ?? null;
    expect(path(resolveBuildingArt(EGYPT_WORLD_PACK, index(['v01', 'v03', 'v04']), hut, null, { variant: 2 }))).toBe('buildings/house/hut/v03/complete.png');
    expect(path(resolveBuildingArt(EGYPT_WORLD_PACK, index(['v01', 'v03', 'v04']), hut, null, { variant: 1 }))).toBe('buildings/house/hut/v03/complete.png');
    expect(path(resolveBuildingArt(EGYPT_WORLD_PACK, index(['v01', 'v03']), hut, null, { variant: 13 }))).toBe('buildings/house/hut/v01/complete.png');
    expect(path(resolveBuildingArt(EGYPT_WORLD_PACK, index(['v01']), hut, null))).toBe('buildings/house/hut/v01/complete.png');
    expect(resolveBuildingArt(EGYPT_WORLD_PACK, index([]), hut, null, { variant: 0 })).toBeNull();
  });

  /* Order v3: a step with no variant folders keeps its pictures directly in the step folder. Delivered that way, the
     set is the step's v01, so art delivered before the variants came and any folder laid out flat still draws (#1983). */
  const flat = (more: Record<string, ArtIndexEntry> = {}): ArtIndex => ({
    contract: 2,
    pack: 'egypt',
    files: { 'buildings/house/hut/complete.png': picture, ...more },
  });

  it('draws a step delivered flat, with no variant folders, as its v01 for every home', () => {
    const path = (art: ReturnType<typeof resolveBuildingArt>) => art?.layers[0]?.path ?? null;
    for (const variant of [0, 4, 14]) {
      expect(path(resolveBuildingArt(EGYPT_WORLD_PACK, flat(), hut, null, { variant })), `variant ${variant}`).toBe('buildings/house/hut/complete.png');
    }
    /* A v01 folder of its own wins over the flat set. */
    expect(path(resolveBuildingArt(EGYPT_WORLD_PACK, flat({ 'buildings/house/hut/v01/complete.png': picture }), hut, null, { variant: 3 }))).toBe(
      'buildings/house/hut/v01/complete.png',
    );
  });

  /* Design, 24.11 (company note #107): a variant with stages not drawn yet (painted v07, v10, v15, mudbrick v13-v15)
     stands only as a finished house. A house under construction takes a variant with every stage drawn, and keeps
     it once built; a house that stood finished keeps its own look while it is torn down. */
  describe('construction takes only a variant with every stage drawn', () => {
    const STAGES = ['low_walls_open', 'full_walls', 'roof_beams', 'roof'] as const;
    const full = (v: string): Record<string, ArtIndexEntry> =>
      Object.fromEntries(['complete', ...STAGES].map(name => [`buildings/house/hut/${v}/${name}.png`, picture]));
    const finishedOnly = (v: string): Record<string, ArtIndexEntry> => ({ [`buildings/house/hut/${v}/complete.png`]: picture });
    const art = (...sets: Record<string, ArtIndexEntry>[]): ArtIndex => ({ contract: 2, pack: 'egypt', files: Object.assign({}, ...sets) });
    const line = { ...hut, maxStage: EGYPT_WORLD_PACK.stageCounts.construction };
    const building = (stage: number): BuildingConstructionState =>
      startBuildingConstruction(createConstructionSimulation(EGYPT_WORLD_PACK), line, line.maxStage, stage);
    const folderOf = (files: ArtIndex, job: BuildingConstructionState | null, variant: number) =>
      resolveBuildingArt(EGYPT_WORLD_PACK, files, line, job, { variant })?.layers[0]?.path.split('/').slice(0, 4).join('/') ?? null;

    it('builds in the next variant with every stage, from the one chosen, and keeps it once finished', () => {
      const files = art(finishedOnly('v01'), full('v02'), finishedOnly('v03'), full('v04'));
      expect(folderOf(files, null, 0), 'finished, a finished-only variant stands').toBe('buildings/house/hut/v01');
      expect(folderOf(files, building(5), 0)).toBe('buildings/house/hut/v02');
      expect(folderOf(files, building(5), 2)).toBe('buildings/house/hut/v04');
      expect(folderOf(files, building(5), 3), 'a full variant chosen is kept').toBe('buildings/house/hut/v04');
      expect(resolveBuildingArt(EGYPT_WORLD_PACK, files, line, building(5), { variant: 0 })?.layers[0]?.path).toBe('buildings/house/hut/v02/full_walls.png');
      const done = building(line.maxStage);
      expect(done.phase).toBe('complete');
      expect(folderOf(files, done, 0), 'built, it keeps the variant it was built in').toBe('buildings/house/hut/v02');
    });

    it('counts a stage drawn as its stage_NN picture, and leaves the optional upgraded and annex out', () => {
      const numbered = { ...finishedOnly('v02'), ...Object.fromEntries(['03', '05', '06', '07'].map(n => [`buildings/house/hut/v02/stage_${n}.png`, picture])) };
      expect(folderOf(art(finishedOnly('v01'), numbered), building(5), 0)).toBe('buildings/house/hut/v02');
      const oneStageShort = { ...full('v02') };
      delete oneStageShort['buildings/house/hut/v02/roof.png'];
      expect(folderOf(art(finishedOnly('v01'), oneStageShort, full('v03')), building(5), 0), 'v02 lacks its roof stage').toBe('buildings/house/hut/v03');
      /* A step delivered flat, with no variant folders, is its v01 and counts the same way. */
      const flatFull = Object.fromEntries(['complete', ...STAGES].map(name => [`buildings/house/hut/${name}.png`, picture]));
      expect(resolveBuildingArt(EGYPT_WORLD_PACK, art(flatFull, finishedOnly('v04')), line, building(5), { variant: 3 })?.layers[0]?.path).toBe(
        'buildings/house/hut/full_walls.png',
      );
    });

    it('keeps the look a finished house stood in while it is torn down', () => {
      const files = art(finishedOnly('v01'), full('v02'));
      const tearing = startBuildingDemolition(createConstructionSimulation(EGYPT_WORLD_PACK), { ...line, stage: line.maxStage });
      expect(folderOf(files, tearing, 0)).toBe('buildings/house/hut/v01');
    });

    it('builds in the chosen variant, nearest drawn picture first, when no variant has every stage', () => {
      expect(folderOf(art(finishedOnly('v01'), finishedOnly('v02')), building(5), 1)).toBe('buildings/house/hut/v02');
      expect(resolveBuildingArt(EGYPT_WORLD_PACK, art(finishedOnly('v01')), line, building(5), { variant: 0 })?.layers[0]?.path).toBe(
        'buildings/house/hut/v01/complete.png',
      );
    });
  });

  it('accepts a flat step folder in the art check as the step’s v01: declared, checked, and v01 not missing', () => {
    const report = validateArtIndex(EGYPT_WORLD_PACK, flat());
    expect(report.warnings.filter(w => w.startsWith('buildings/house/hut/'))).toEqual([]);
    expect(report.missingRequired).not.toContain('buildings/house/hut/v01/complete.png');
    expect(validateArtIndex(EGYPT_WORLD_PACK, index([])).missingRequired).toContain('buildings/house/hut/v01/complete.png');
    /* Checked against the step's footprint like the v01 it stands for. */
    const wide: ArtIndexEntry = {
      w: 720,
      h: 760,
      passport: { groundAnchor: { x: 360, y: 559 }, corners: { top: { x: 360, y: 379 }, right: { x: 720, y: 559 }, bottom: { x: 360, y: 739 }, left: { x: 0, y: 559 } } },
    };
    expect(validateArtIndex(EGYPT_WORLD_PACK, { ...flat(), files: { 'buildings/house/hut/complete.png': wide } }).errors).toContain(
      'buildings/house/hut/complete.png: diamond width 720 px does not match footprint 2x2 (480 px)',
    );
  });
});
