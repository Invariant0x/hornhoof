import { describe, expect, it } from 'vitest';
import {
  ART_CONTRACT_VERSION,
  artFootprintCentre,
  declaredArtFiles,
  resolveBuildingArt,
  resolveResidentArt,
  validateArtIndex,
  type ArtIndex,
  type ArtIndexEntry,
  type BuildingPicturePassport,
  type SheetPassport,
  type WorldArtCatalog,
} from '../src/world/art';
import type { CityBuilding } from '../src/world/city-layout';
import type { BuildingConstructionState } from '../src/world/construction';
import { validateWorldPack, type FootprintKey, type WorldPackManifest } from '../src/world/manifest';
import { STUB_DIAMOND_PACK } from '../src/world/packs/stub-pack';
import type { ResidentEntity } from '../src/world/residents';

const CATALOG: WorldArtCatalog = {
  baseUrl: '/world-art/test/',
  buildings: {
    house: [
      { id: 'small', footprint: '1x1', label: { en: 'Small', ru: 'Малый' } },
      { id: 'large', footprint: '3x3', label: { en: 'Large', ru: 'Большой' } },
    ],
    department: [{ id: 'hall', footprint: '3x3', label: { en: 'Hall', ru: 'Зал' } }],
    statue: [{ id: 'figure', footprint: '1x1', label: { en: 'Figure', ru: 'Фигура' } }],
    monument: [{ id: 'mound', footprint: '4x4', label: { en: 'Mound', ru: 'Курган' } }],
    supply: [{ id: 'store', footprint: '3x3', label: { en: 'Store', ru: 'Склад' } }],
  },
  altar: true,
  flags: { district: true, department: true },
  people: { looks: ['look-a'], tiers: 2 },
  loops: ['smoke'],
};

const PACK: WorldPackManifest = { ...STUB_DIAMOND_PACK, art: CATALOG };

/* Master 4x footprint diamond geometry drawn at the bottom of a picture of the given height. */
function picture(footprint: FootprintKey, height: number, extra: Partial<BuildingPicturePassport> = {}): ArtIndexEntry {
  const fp = PACK.projection.buildingFootprintsMaster4x[footprint];
  const w = fp.diamondW + 16;
  const cx = w / 2;
  const cy = height - fp.diamondH / 2 - 8;
  const passport: BuildingPicturePassport = {
    groundAnchor: { x: cx, y: cy },
    corners: {
      top: { x: cx, y: cy - fp.diamondH / 2 },
      right: { x: cx + fp.diamondW / 2, y: cy },
      bottom: { x: cx, y: cy + fp.diamondH / 2 },
      left: { x: cx - fp.diamondW / 2, y: cy },
    },
    ...extra,
  };
  return { w, h: height, passport };
}

function sheet(frames: number, rows: number, frameW = 120, frameH = 180): ArtIndexEntry {
  const passport: SheetPassport = { frameW, frameH, frames, fps: 8, anchor: { x: frameW / 2, y: frameH - 10 } };
  return { w: frameW * frames, h: frameH * rows, passport };
}

function index(files: Record<string, ArtIndexEntry>): ArtIndex {
  return { contract: ART_CONTRACT_VERSION, pack: PACK.id, files };
}

function building(partial: Partial<CityBuilding>): CityBuilding {
  return {
    id: 'b1',
    kind: 'department',
    label: 'B',
    col: 10,
    row: 20,
    spanCol: 3,
    spanRow: 3,
    lot: { col: 10, row: 20, spanCol: 5, spanRow: 5 },
    door: { col: 11, row: 19 },
    stage: 9,
    maxStage: 10,
    floors: 1,
    level: 1,
    residentIds: [],
    mergedFromIds: [],
    goalCount: 0,
    placedAtStep: 0,
    ...partial,
  };
}

function job(currentStage: number, phase: BuildingConstructionState['phase'] = 'building'): BuildingConstructionState {
  const b = building({});
  return {
    id: 'j1',
    buildingId: b.id,
    buildingSnapshot: b,
    kind: b.kind,
    col: b.col,
    row: b.row,
    spanCol: b.spanCol,
    spanRow: b.spanRow,
    phase,
    currentStage,
    targetStage: 10,
    maxStage: 10,
    stageProgress: 0,
    stagesPerSec: 1,
    stageHistory: [],
  };
}

function resident(partial: Partial<ResidentEntity>): ResidentEntity {
  return {
    id: 'r1',
    agentId: 'a1',
    name: 'R',
    roleKey: null,
    roleClass: 'executor',
    archetype: 'builder',
    look: { id: 'look-a', label: { en: 'A', ru: 'А' }, tunicColor: '#ffffff', trimColor: '#000000', prop: 'none', headgear: 'none' },
    level: 1,
    outfitTier: 1,
    cloakColor: '#C96A4B',
    facing: 'S',
    walkPhase: 0,
    pose: 'idle',
    col: 5,
    row: 5,
    ...partial,
  } as ResidentEntity;
}

describe('Stage 9 art contract: declared files, index validation and art resolution with placeholder fallback', () => {
  it('declares every picture, shared module, sheet, flag and altar file the contract asks for, under engine-defined paths', () => {
    const files = declaredArtFiles(PACK);
    const paths = new Set(files.map(f => f.path));

    for (const pic of ['low_walls_open', 'full_walls', 'roof_beams', 'roof', 'complete', 'upgraded', 'annex']) {
      expect(paths.has(`buildings/department/hall/${pic}.png`), pic).toBe(true);
      expect(paths.has(`buildings/house/small/${pic}.png`), pic).toBe(true);
    }
    expect(paths.has('buildings/statue/figure/stage_01.png')).toBe(true);
    expect(paths.has(`buildings/statue/figure/stage_${String(PACK.stageCounts.statue).padStart(2, '0')}.png`)).toBe(true);
    expect(paths.has('buildings/monument/mound/tier_01.png')).toBe(true);
    expect(paths.has(`buildings/monument/mound/tier_${String(PACK.stageCounts.monument).padStart(2, '0')}.png`)).toBe(true);
    expect(paths.has('buildings/monument/mound/capstone.png')).toBe(true);
    for (const fill of [0, 1, 2, 3, 4]) expect(paths.has(`buildings/supply/store/fill_${fill}.png`)).toBe(true);
    expect(paths.has('buildings/altar/complete.png')).toBe(true);

    /* Shared construction modules exist once per footprint used by buildings that go through construction stages. */
    for (const fp of ['1x1', '3x3']) {
      for (const mod of ['stakes', 'foundation', 'scaffold_back', 'scaffold_front', 'ramp']) {
        expect(paths.has(`modules/${fp}/${mod}.png`), `${fp} ${mod}`).toBe(true);
      }
    }

    expect(paths.has('people/look-a/tier_1/walk.png')).toBe(true);
    expect(paths.has('people/look-a/tier_2/carry.cloak.png')).toBe(true);
    expect(paths.has('people/look-a/tier_3/walk.png')).toBe(false);
    expect(paths.has('loops/smoke.png')).toBe(true);
    expect(paths.has('flags/district.png')).toBe(true);
    expect(paths.has('flags/department.png')).toBe(true);

    expect(files.find(f => f.path === 'buildings/department/hall/complete.png')?.required).toBe(true);
    expect(files.find(f => f.path === 'buildings/department/hall/upgraded.png')?.required).toBe(false);
    expect(files.find(f => f.path === 'people/look-a/tier_1/walk.cloak.png')?.passport).toBe('none');
    expect(new Set(files.map(f => f.path)).size).toBe(files.length);
  });

  it('accepts a correct art index and rejects wrong footprint geometry, sheet sizes, cloak layers, versions and pack ids', () => {
    const good = index({
      'buildings/department/hall/complete.png': picture('3x3', 900, { flagAnchor: { x: 300, y: 120 } }),
      'people/look-a/tier_1/walk.png': sheet(8, 5),
      'people/look-a/tier_1/walk.cloak.png': { w: 960, h: 900 },
      'loops/smoke.png': sheet(12, 1, 64, 96),
    });
    const report = validateArtIndex(PACK, good);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.present).toBe(4);
    expect(report.declared).toBe(declaredArtFiles(PACK).length);

    const narrow = picture('3x3', 900);
    const narrowPassport = narrow.passport as BuildingPicturePassport;
    const wrongDiamond = index({
      'buildings/department/hall/complete.png': {
        ...narrow,
        passport: { ...narrowPassport, corners: { ...narrowPassport.corners, right: { x: narrowPassport.corners.right.x - 60, y: narrowPassport.groundAnchor.y } } },
      },
    });
    expect(validateArtIndex(PACK, wrongDiamond).errors.join('\n')).toMatch(/hall\/complete\.png.*diamond width/);

    const offAnchor = index({
      'buildings/department/hall/complete.png': { ...narrow, passport: { ...narrowPassport, groundAnchor: { x: narrowPassport.groundAnchor.x + 9, y: narrowPassport.groundAnchor.y } } },
    });
    expect(validateArtIndex(PACK, offAnchor).errors.join('\n')).toMatch(/groundAnchor/);

    const tooTall = index({ 'buildings/department/hall/complete.png': picture('3x3', 2000) });
    expect(validateArtIndex(PACK, tooTall).errors.join('\n')).toMatch(/taller than/);

    const badSheet = index({ 'people/look-a/tier_1/walk.png': { ...sheet(8, 5), w: 900 } });
    expect(validateArtIndex(PACK, badSheet).errors.join('\n')).toMatch(/walk\.png.*frameW \* frames/);

    const badRows = index({ 'people/look-a/tier_1/walk.png': sheet(8, 4) });
    expect(validateArtIndex(PACK, badRows).errors.join('\n')).toMatch(/5 direction rows/);

    const badCloak = index({
      'people/look-a/tier_1/walk.png': sheet(8, 5),
      'people/look-a/tier_1/walk.cloak.png': { w: 960, h: 720 },
    });
    expect(validateArtIndex(PACK, badCloak).errors.join('\n')).toMatch(/cloak.*same size/);

    const orphanCloak = index({ 'people/look-a/tier_1/walk.cloak.png': { w: 960, h: 900 } });
    expect(validateArtIndex(PACK, orphanCloak).errors.join('\n')).toMatch(/without its base sheet/);

    const noPassport = index({ 'buildings/department/hall/complete.png': { w: 736, h: 900 } });
    expect(validateArtIndex(PACK, noPassport).errors.join('\n')).toMatch(/passport/);

    expect(validateArtIndex(PACK, { ...good, contract: ART_CONTRACT_VERSION + 1 }).ok).toBe(false);
    expect(validateArtIndex(PACK, { ...good, pack: 'another' }).ok).toBe(false);

    const unknown = validateArtIndex(PACK, index({ 'buildings/department/typo/complete.png': picture('3x3', 900) }));
    expect(unknown.ok).toBe(true);
    expect(unknown.warnings.join('\n')).toMatch(/typo\/complete\.png.*not declared/);
  });

  it('keeps every building on its placeholder when the pack has no art, no index or no picture for the current stage', () => {
    const b = building({ stage: 9 });
    expect(resolveBuildingArt(STUB_DIAMOND_PACK, null, b, null)).toBeNull();
    expect(resolveBuildingArt(PACK, null, b, null)).toBeNull();
    expect(resolveBuildingArt(PACK, index({}), b, null)).toBeNull();
    const onlyComplete = index({ 'buildings/department/hall/complete.png': picture('3x3', 900) });
    expect(resolveBuildingArt(PACK, onlyComplete, b, job(5))).toBeNull();
  });

  it('draws the finished look, upgraded look, annex and a tinted district flag at the picture flag anchor', () => {
    const files = index({
      'buildings/department/hall/complete.png': picture('3x3', 900, { flagAnchor: { x: 300, y: 100 } }),
      'buildings/house/large/complete.png': picture('3x3', 900, { flagAnchor: { x: 200, y: 140 } }),
      'buildings/house/large/annex.png': picture('3x3', 900),
      'flags/district.png': { w: 40, h: 120, passport: { anchor: { x: 4, y: 118 } } },
      'flags/department.png': { w: 40, h: 120, passport: { anchor: { x: 4, y: 118 } } },
    });

    const dept = resolveBuildingArt(PACK, files, building({ stage: 9 }), null, { departmentColor: '#5CA6E6' });
    expect(dept?.layers.map(l => l.path)).toEqual(['buildings/department/hall/complete.png', 'flags/department.png']);
    const main = files.files['buildings/department/hall/complete.png']!.passport as BuildingPicturePassport;
    expect(dept?.layers[1]).toMatchObject({
      tint: '#5CA6E6',
      anchor: { x: 4, y: 118 },
      offset: { x: 300 - main.groundAnchor.x, y: 100 - main.groundAnchor.y },
    });
    /* Stage 10 falls back to the finished look while the pack has no upgraded picture yet. */
    expect(resolveBuildingArt(PACK, files, building({ stage: 10 }), null)?.layers[0]?.path).toBe('buildings/department/hall/complete.png');

    /* Houses pick the step whose footprint matches the house's grown size and show the annex while growing in place. */
    const house = building({ kind: 'house', spanCol: 3, spanRow: 3, level: 9, stage: 9, districtId: 'd1' });
    expect(resolveBuildingArt(PACK, files, house, null, { districtColor: '#AA3355' })?.layers.map(l => [l.path, l.tint])).toEqual([
      ['buildings/house/large/complete.png', undefined],
      ['flags/district.png', '#AA3355'],
    ]);
    expect(resolveBuildingArt(PACK, files, house, null, { upgrading: true })?.layers[0]?.path).toBe('buildings/house/large/annex.png');
    /* A 2x2 house scales the nearest step (1x1 or 3x3) to its own footprint instead of falling back. */
    const mid = resolveBuildingArt(PACK, files, { ...house, spanCol: 2, spanRow: 2 }, null);
    expect(mid?.layers[0]?.path).toBe('buildings/house/large/complete.png');
    expect(mid?.artPxPerTile).toBeCloseTo(PACK.projection.buildingFootprintsMaster4x['3x3'].diamondW / 2, 5);
  });

  it('shows the finished look of the growth step outside construction, whatever the growth stage', () => {
    const files = index({
      'buildings/department/hall/complete.png': picture('3x3', 900),
      'buildings/department/hall/upgraded.png': picture('3x3', 940),
    });
    /* Growth stages 2..9 are finished buildings of that step; only a construction job walks the construction pictures. */
    for (const stage of [1, 2, 5, 9]) {
      expect(resolveBuildingArt(PACK, files, building({ stage }), null)?.layers.map(l => l.path), `stage ${stage}`).toEqual([
        'buildings/department/hall/complete.png',
      ]);
    }
    /* The last growth stage shows the upgraded look when the pack has it. */
    expect(resolveBuildingArt(PACK, files, building({ stage: 10 }), null)?.layers[0]?.path).toBe('buildings/department/hall/upgraded.png');
  });

  it('takes a module drawn as an empty canvas, its passport saying why, as valid and lays nothing for it', () => {
    const why = 'nothing fits inside the lot in front of the walls';
    const files = index({
      'modules/3x3/scaffold_back.png': picture('3x3', 800),
      'modules/3x3/scaffold_front.png': picture('3x3', 800, { empty: why }),
      'modules/3x3/ramp.png': picture('3x3', 500, { empty: why }),
      'buildings/department/hall/low_walls_open.png': picture('3x3', 600),
      'buildings/department/hall/complete.png': picture('3x3', 900),
    });
    const report = validateArtIndex(PACK, files);
    expect(report.errors.filter(e => /modules\/3x3\/(scaffold_front|ramp)/.test(e))).toEqual([]);
    expect(report.warnings.filter(e => /modules\/3x3\/(scaffold_front|ramp)/.test(e))).toEqual([]);
    const paths = (stage: number) => resolveBuildingArt(PACK, files, building({}), job(stage))?.layers.map(l => l.path);
    expect(paths(4)).toEqual(['modules/3x3/scaffold_back.png', 'buildings/department/hall/low_walls_open.png']);
    expect(paths(8)).toEqual(['modules/3x3/scaffold_back.png', 'buildings/department/hall/complete.png']);
  });

  it('assembles construction stages from shared modules and the building own pictures, in the right drawing order', () => {
    const files = index({
      'modules/3x3/stakes.png': picture('3x3', 400),
      'modules/3x3/foundation.png': picture('3x3', 420),
      'modules/3x3/scaffold_back.png': picture('3x3', 800),
      'modules/3x3/scaffold_front.png': picture('3x3', 800),
      'modules/3x3/ramp.png': picture('3x3', 500),
      'buildings/department/hall/low_walls_open.png': picture('3x3', 600),
      'buildings/department/hall/full_walls.png': picture('3x3', 800, { wallCutY: 500 }),
      'buildings/department/hall/complete.png': picture('3x3', 900),
    });
    const b = building({});
    const paths = (stage: number, pack: WorldPackManifest = PACK) => resolveBuildingArt(pack, files, b, job(stage))?.layers.map(l => l.path);

    expect(paths(1)).toEqual(['modules/3x3/stakes.png']);
    expect(paths(2)).toEqual(['modules/3x3/foundation.png']);
    expect(paths(3)).toEqual(['buildings/department/hall/low_walls_open.png']);
    expect(paths(4)).toEqual([
      'modules/3x3/scaffold_back.png',
      'buildings/department/hall/low_walls_open.png',
      'modules/3x3/ramp.png',
      'modules/3x3/scaffold_front.png',
    ]);
    expect(paths(8)).toEqual(['modules/3x3/scaffold_back.png', 'buildings/department/hall/complete.png', 'modules/3x3/scaffold_front.png']);
    expect(paths(9)).toEqual(['buildings/department/hall/complete.png']);

    /* A pack may build stage 4 from the full-height walls cut at their wall cut line instead. */
    const cutPack: WorldPackManifest = {
      ...PACK,
      art: { ...CATALOG, stagePictures: { waist_walls_scaffold: { picture: 'full_walls', cutToWallLine: true } } },
    };
    const cut = resolveBuildingArt(cutPack, files, b, job(4));
    const walls = cut?.layers.find(l => l.path.endsWith('full_walls.png'));
    expect(walls?.frame).toEqual({ x: 0, y: 500, w: files.files['buildings/department/hall/full_walls.png']!.w, h: 300 });
    const wallsPassport = files.files['buildings/department/hall/full_walls.png']!.passport as BuildingPicturePassport;
    expect(walls?.anchor).toEqual({ x: wallsPassport.groundAnchor.x, y: wallsPassport.groundAnchor.y - 500 });

    /* Demolition runs the same pictures in reverse; a cleared site draws nothing. */
    expect(resolveBuildingArt(PACK, files, b, job(3, 'demolishing'))?.layers.map(l => l.path)).toEqual([
      'buildings/department/hall/low_walls_open.png',
    ]);
    expect(resolveBuildingArt(PACK, files, b, job(0, 'cleared'))).toBeNull();
  });

  it('picks statue stages, monument tiers with the capstone, and supply fill levels from live values', () => {
    const files = index({
      'buildings/statue/figure/stage_07.png': picture('1x1', 400),
      'buildings/monument/mound/tier_06.png': picture('4x4', 900),
      'buildings/monument/mound/tier_10.png': picture('4x4', 1100, { topAnchor: { x: 496, y: 60 } }),
      'buildings/monument/mound/capstone.png': { w: 80, h: 60, passport: { anchor: { x: 40, y: 58 } } },
      'buildings/supply/store/fill_0.png': picture('3x3', 600),
      'buildings/supply/store/fill_2.png': picture('3x3', 600),
    });
    const statue = building({ kind: 'statue', spanCol: 1, spanRow: 1, stage: 7, maxStage: 20 });
    expect(resolveBuildingArt(PACK, files, statue, null)?.layers.map(l => l.path)).toEqual(['buildings/statue/figure/stage_07.png']);

    const mound = building({ kind: 'monument', spanCol: 4, spanRow: 4, stage: 5, maxStage: 10, progress: 0.55 });
    expect(resolveBuildingArt(PACK, files, mound, null)?.layers.map(l => l.path)).toEqual(['buildings/monument/mound/tier_06.png']);
    const reached = resolveBuildingArt(PACK, files, { ...mound, progress: 1, reached: true }, null);
    expect(reached?.layers.map(l => l.path)).toEqual(['buildings/monument/mound/tier_10.png', 'buildings/monument/mound/capstone.png']);

    const store = building({ kind: 'supply', spanCol: 3, spanRow: 3, stage: 6, maxStage: 6, fullness: 0.5 });
    expect(resolveBuildingArt(PACK, files, store, null)?.layers[0]?.path).toBe('buildings/supply/store/fill_2.png');
    expect(resolveBuildingArt(PACK, files, { ...store, resting: true }, null)?.layers[0]?.path).toBe('buildings/supply/store/fill_0.png');
  });

  it('places a picture by its ground anchor at the footprint centre, scaled from its diamond width', () => {
    const b = building({ col: 10, row: 20, spanCol: 3, spanRow: 3 });
    const centre = artFootprintCentre(b, 120, 60);
    /* Footprint centre is the tile-space point (11.5, 21.5). */
    expect(centre).toEqual({ x: (11.5 - 21.5) * 60, y: (11.5 + 21.5) * 30 });
    const files = index({ 'buildings/department/hall/complete.png': picture('3x3', 900) });
    const art = resolveBuildingArt(PACK, files, building({}), null);
    expect(art?.artPxPerTile).toBe(240);
  });

  it('draws residents from layered sheets: direction rows, mirrored west faces, frame by time, tinted cloak and tier fallback', () => {
    const files = index({
      'people/look-a/tier_1/walk.png': sheet(8, 5),
      'people/look-a/tier_1/walk.cloak.png': { w: 960, h: 900 },
      'people/look-a/tier_1/idle.png': sheet(4, 5),
      'people/look-a/tier_1/pray.png': sheet(6, 5),
    });

    const walker = resolveResidentArt(PACK, files, resident({ pose: 'walking', facing: 'N' }), 0);
    expect(walker?.layers.map(l => [l.path, l.frame.y, l.tint])).toEqual([
      ['people/look-a/tier_1/walk.png', 0, undefined],
      ['people/look-a/tier_1/walk.cloak.png', 0, '#C96A4B'],
    ]);
    expect(walker?.mirror).toBe(false);
    expect(walker?.layers[0]?.anchor).toEqual({ x: 60, y: 170 });

    /* SW reuses the SE row (row 3) mirrored; W reuses E (row 2); NW reuses NE (row 1). */
    expect(resolveResidentArt(PACK, files, resident({ pose: 'walking', facing: 'SW' }), 0)).toMatchObject({ mirror: true });
    expect(resolveResidentArt(PACK, files, resident({ pose: 'walking', facing: 'SW' }), 0)?.layers[0]?.frame.y).toBe(3 * 180);
    expect(resolveResidentArt(PACK, files, resident({ pose: 'walking', facing: 'W' }), 0)?.layers[0]?.frame.y).toBe(2 * 180);
    expect(resolveResidentArt(PACK, files, resident({ pose: 'walking', facing: 'NW' }), 0)?.layers[0]?.frame.y).toBe(1 * 180);
    expect(resolveResidentArt(PACK, files, resident({ pose: 'walking', facing: 'S' }), 0)?.layers[0]?.frame.y).toBe(4 * 180);

    /* 8 fps: at 0.5 s the walk shows frame 4. */
    expect(resolveResidentArt(PACK, files, resident({ pose: 'walking' }), 0.5)?.layers[0]?.frame.x).toBe(4 * 120);

    /* A pose with its own sheet uses it; carrying falls back to walking, inspecting to idle. */
    expect(resolveResidentArt(PACK, files, resident({ pose: 'praying' }), 0)?.layers[0]?.path).toBe('people/look-a/tier_1/pray.png');
    expect(resolveResidentArt(PACK, files, resident({ pose: 'carrying_stone' }), 0)?.layers[0]?.path).toBe('people/look-a/tier_1/walk.png');
    expect(resolveResidentArt(PACK, files, resident({ pose: 'inspecting' }), 0)?.layers[0]?.path).toBe('people/look-a/tier_1/idle.png');

    /* Tier 2 outfit is missing, so the tier 1 sheet stands in; an unknown look stays a placeholder. */
    expect(resolveResidentArt(PACK, files, resident({ pose: 'walking', outfitTier: 2 }), 0)?.layers[0]?.path).toBe('people/look-a/tier_1/walk.png');
    expect(resolveResidentArt(PACK, files, resident({ look: { ...resident({}).look, id: 'look-b' } }), 0)).toBeNull();
    expect(resolveResidentArt(PACK, null, resident({}), 0)).toBeNull();
  });

  it('rejects art catalogs with unknown footprints, duplicate steps or people tiers out of 1..5', () => {
    expect(validateWorldPack(PACK)).toEqual({ ok: true });
    const badFootprint = { ...PACK, art: { ...CATALOG, buildings: { house: [{ id: 'x', footprint: '7x7' as FootprintKey, label: { en: 'X', ru: 'X' } }] } } };
    expect(validateWorldPack(badFootprint)).toMatchObject({ ok: false });
    const dupSteps = {
      ...PACK,
      art: {
        ...CATALOG,
        buildings: {
          house: [
            { id: 'x', footprint: '1x1' as FootprintKey, label: { en: 'X', ru: 'X' } },
            { id: 'x', footprint: '2x2' as FootprintKey, label: { en: 'X', ru: 'X' } },
          ],
        },
      },
    };
    expect(validateWorldPack(dupSteps)).toMatchObject({ ok: false });
    expect(validateWorldPack({ ...PACK, art: { ...CATALOG, people: { looks: ['look-a'], tiers: 6 } } })).toMatchObject({ ok: false });
    expect(validateWorldPack({ ...PACK, art: { ...CATALOG, baseUrl: 'relative/' } })).toMatchObject({ ok: false });
  });
});
