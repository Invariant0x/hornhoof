import { describe, expect, it } from 'vitest';
import {
  ART_CONTRACT_VERSION,
  validateArtIndex,
  type ArtIndex,
  type ArtIndexEntry,
  type BuildingPicturePassport,
  type LoopAttachPoint,
  type SheetPassport,
} from '../src/world/art';
import type { DisplayRunPool, WorldArtLibrary } from '../src/world/art-runtime';
import type { CityBuilding, CityState } from '../src/world/city-layout';
import { buildingLoopsFor, createConstructionSimulation, startBuildingConstruction, startBuildingDemolition } from '../src/world/construction';
import { loopTopPoint, renderConstructionLoopsToPixi } from '../src/world/construction-renderer';
import { tileCenterToWorld } from '../src/world/coords';
import type { WorldPackManifest } from '../src/world/manifest';
import { STUB_DIAMOND_PACK } from '../src/world/packs/stub-pack';
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

/* A pack with one 3x3 department hall and the awning and smoke loops, drawn by a library that has every picture. */
const LOOP_PACK: WorldPackManifest = {
  ...STUB_DIAMOND_PACK,
  art: {
    baseUrl: '/world-art/test/',
    buildings: { department: [{ id: 'hall', footprint: '3x3', label: { en: 'Hall', ru: 'Зал' } }] },
    loops: ['awning', 'smoke'],
  },
};
const HALL = 'buildings/department/hall/complete.png';
const TILE_W = 120;
const TILE_H = 60;

function hallPicture(extra: Partial<BuildingPicturePassport> = {}): ArtIndexEntry {
  const fp = LOOP_PACK.projection.buildingFootprintsMaster4x['3x3'];
  const w = fp.diamondW + 16;
  const h = 900;
  const cx = w / 2;
  const cy = h - fp.diamondH / 2 - 8;
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
  return { w, h, passport };
}

function loopSheet(attach: LoopAttachPoint): ArtIndexEntry {
  const passport: SheetPassport = { frameW: 64, frameH: 96, frames: 4, fps: 8, anchor: { x: 32, y: 90 }, attach };
  return { w: 256, h: 96, passport };
}

function loopIndex(hall: ArtIndexEntry): ArtIndex {
  return {
    contract: ART_CONTRACT_VERSION,
    pack: LOOP_PACK.id,
    files: { [HALL]: hall, 'loops/awning.png': loopSheet('awning'), 'loops/smoke.png': loopSheet('top') },
  };
}

/* Draws the loops of one finished hall and returns each loop sheet drawn with where it stands. */
function drawnLoops(hall: ArtIndexEntry): { sheet: string; x: number; y: number }[] {
  const index = loopIndex(hall);
  const library = { index, frame: (path: string) => ({ path }) } as unknown as WorldArtLibrary;
  const drawn: { sheet: string; x: number; y: number }[] = [];
  const pool = {
    depth: 0,
    begin() {},
    sprite(tex: { path: string }) {
      const at = { sheet: tex.path, x: 0, y: 0 };
      drawn.push(at);
      const noop = { set() {} };
      return { anchor: noop, scale: noop, alpha: 1, position: { set: (x: number, y: number) => Object.assign(at, { x, y }) } };
    },
  } as unknown as DisplayRunPool;
  const b = site(3, { id: 'hall-1', kind: 'department', stage: 9, level: 9 });
  const city = { buildings: [b] } as unknown as CityState;
  renderConstructionLoopsToPixi(createConstructionSimulation(LOOP_PACK), city, LOOP_PACK, { minX: -1e9, maxX: 1e9, minY: -1e9, maxY: 1e9 }, TILE_W, TILE_H, {
    library,
    pool,
    variants: new Map(),
  });
  /* Only the loop sheets: the hall's own picture is drawn by the city renderer, not here. */
  return drawn.filter(d => d.sheet.startsWith('loops/'));
}

/* Where a point of the hall's picture lands on the map. */
function onMap(hall: ArtIndexEntry, pt: { x: number; y: number }): { x: number; y: number } {
  const p = hall.passport as BuildingPicturePassport;
  const ctr = tileCenterToWorld(40 + 1, 40 + 1, TILE_W, TILE_H);
  const s = TILE_W / ((p.corners.right.x - p.corners.left.x) / 3);
  return { x: ctr.x + (pt.x - p.groundAnchor.x) * s, y: ctr.y + (pt.y - p.groundAnchor.y) * s };
}

describe('the awning loop is opt-in: only a picture whose passport says awningLoop: true gets it, at its awningAnchor', () => {
  it('leaves the awning loop off a building that names an awningAnchor but no awningLoop, as every delivered house does', () => {
    const hall = hallPicture({ awningAnchor: { x: 300, y: 600 }, flagAnchor: { x: 250, y: 300 } });
    expect(drawnLoops(hall).map(d => d.sheet)).toEqual(['loops/smoke.png']);
  });

  it('draws it at the awningAnchor where the passport asks, and the smoke at the flag pole’s foot', () => {
    const hall = hallPicture({ awningAnchor: { x: 300, y: 600 }, flagAnchor: { x: 250, y: 300 }, awningLoop: true });
    const drawn = drawnLoops(hall);
    expect(drawn.map(d => d.sheet).sort()).toEqual(['loops/awning.png', 'loops/smoke.png']);
    const awning = drawn.find(d => d.sheet === 'loops/awning.png')!;
    const smoke = drawn.find(d => d.sheet === 'loops/smoke.png')!;
    const wantAwning = onMap(hall, { x: 300, y: 600 });
    const wantSmoke = onMap(hall, { x: 250, y: 300 });
    expect(awning.x).toBeCloseTo(wantAwning.x, 6);
    expect(awning.y).toBeCloseTo(wantAwning.y, 6);
    expect(smoke.x).toBeCloseTo(wantSmoke.x, 6);
    expect(smoke.y).toBeCloseTo(wantSmoke.y, 6);
  });

  it('is checked by the art check: awningLoop must be true or false, and true needs an awningAnchor', () => {
    const errorsOf = (hall: ArtIndexEntry) => validateArtIndex(LOOP_PACK, loopIndex(hall)).errors;
    expect(errorsOf(hallPicture({ awningLoop: true, awningAnchor: { x: 300, y: 600 } }))).toEqual([]);
    expect(errorsOf(hallPicture({ awningLoop: false }))).toEqual([]);
    expect(errorsOf(hallPicture({ awningLoop: true })).join('\n')).toMatch(/hall\/complete\.png: awningLoop needs an awningAnchor/);
    expect(errorsOf(hallPicture({ awningLoop: 'yes' as unknown as boolean })).join('\n')).toMatch(/hall\/complete\.png: awningLoop must be true or false/);
  });
});
