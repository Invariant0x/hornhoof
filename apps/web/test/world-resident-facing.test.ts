import { describe, expect, it } from 'vitest';
import {
  DIRECTION_ROWS,
  masterTileW,
  personSheetPath,
  residentStandsStill,
  residentWalkSpeed,
  resolveResidentArt,
  sheetRowFor,
  validateArtIndex,
  WALK_STRIDE_PX,
  type ArtIndex,
  type SheetPassport,
} from '../src/world/art';
import { tileCenterToWorld } from '../src/world/coords';
import { createHornhoofLiveFixture, syncLiveSnapshotToCity } from '../src/world/live-sync';
import { createResidentSimulation, stepResidentSimulation, type ResidentSimulation } from '../src/world/residents';
import { generateWorldTerrain } from '../src/world/terrain-engine';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

/* #1983: on the 2:1 diamond a step along a tile axis runs diagonally on screen, so a resident's sheet row comes from the
   step's angle on screen, never from the grid. Bearings are on screen: N up, E right, S down, W left. */
const BEARING: Readonly<Record<string, number>> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
const GRID_STEPS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]] as const;

const gap = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/* The bearing on screen of one grid step, from the engine's own tile placement. */
function screenBearing(dc: number, dr: number): number {
  const from = tileCenterToWorld(0, 0, 120, 60);
  const to = tileCenterToWorld(dc, dr, 120, 60);
  return ((Math.atan2(to.x - from.x, -(to.y - from.y)) * 180) / Math.PI + 360) % 360;
}

/* The bearing a sheet row shows: the drawn direction, or its mirror across the vertical. */
function shownBearing(rows: readonly string[], row: number, mirror: boolean): number {
  const drawn = BEARING[rows[row]!]!;
  return mirror ? (360 - drawn) % 360 : drawn;
}

function city() {
  const live = createHornhoofLiveFixture();
  const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: live.company.seed, mapSize: 150 });
  const synced = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, map, live);
  return { live, synced };
}

/* One working resident walks a few tiles in a straight grid direction through the simulation's own step. */
function facingAfterStep(sim: ResidentSimulation, dc: number, dr: number): string {
  const r = sim.residents.find(x => x.liveState === 'working')!;
  r.col = 60;
  r.row = 60;
  r.path = [{ col: 60 + dc * 4, row: 60 + dr * 4 }];
  r.pathIndex = 0;
  r.actionTimer = 0;
  r.facing = 'S';
  stepResidentSimulation(sim, 0.1);
  return r.facing;
}

describe('Residents face where they walk on screen (#1983)', () => {
  const { live, synced } = city();
  const sim = createResidentSimulation(EGYPT_WORLD_PACK, synced.city, live);

  it('shows the row with the step angle on screen for all 8 grid steps on a sheet of the five rows N..S, west mirrored', () => {
    for (const [dc, dr] of GRID_STEPS) {
      const facing = facingAfterStep(sim, dc, dr);
      const { row, mirror } = sheetRowFor(undefined, facing, false);
      const shown = shownBearing(DIRECTION_ROWS, row, mirror);
      expect(gap(shown, screenBearing(dc, dr)), `step (${dc}, ${dr}) faces ${facing}, shows ${DIRECTION_ROWS[row]}${mirror ? ' mirrored' : ''}`).toBeLessThanOrEqual(22.5);
    }
  });

  it('shows the nearest drawn direction or its mirror for a sheet that draws only some directions', () => {
    for (const rows of [['SE', 'NE'], ['S', 'E', 'N'], ['SE']] as const) {
      for (const [dc, dr] of GRID_STEPS) {
        const facing = facingAfterStep(sim, dc, dr);
        const { row, mirror } = sheetRowFor(rows as SheetPassport['directions'], facing, false);
        /* The step's face on screen, within 22.5 degrees of the step (the test above), then the nearest drawn row or mirror. */
        const want = BEARING[facing]!;
        expect(gap(want, screenBearing(dc, dr)), `${rows.join(',')} step (${dc}, ${dr}) faces ${facing}`).toBeLessThanOrEqual(22.5);
        const best = Math.min(...rows.flatMap(d => [BEARING[d]!, (360 - BEARING[d]!) % 360]).map(b => gap(b, want)));
        expect(gap(shownBearing(rows, row, mirror), want), `${rows.join(',')} step (${dc}, ${dr})`).toBe(best);
      }
    }
  });

  /* Ivan, 23.11: a big carried item (a block on the left shoulder, a staff, a jar) must not jump to the other hand when a
     resident turns, so a sheet may draw all 8 directions; a drawn row always wins over a mirrored one. */
  it('shows every drawn direction of an 8-row sheet as drawn, never mirrored', () => {
    const all = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
    for (const facing of all) expect(sheetRowFor(all, facing, false), facing).toEqual({ row: all.indexOf(facing), mirror: false });
    /* Two drawn: each shows as drawn; a missing west face still takes a mirror. */
    expect(sheetRowFor(['SE', 'SW'], 'SW', false)).toEqual({ row: 1, mirror: false });
    expect(sheetRowFor(['SE', 'SW'], 'SE', false)).toEqual({ row: 0, mirror: false });
    expect(sheetRowFor(['N', 'NE', 'E', 'SE', 'S'], 'W', false)).toEqual({ row: 2, mirror: true });
  });

  it('turns an idle resident strolling round its house to where it moves', () => {
    const fresh = createResidentSimulation(EGYPT_WORLD_PACK, synced.city, live);
    const idle = fresh.residents.find(r => r.liveState === 'idle');
    expect(idle, 'the fixture has an idle resident').toBeTruthy();
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const before = { col: idle!.col, row: idle!.row };
      stepResidentSimulation(fresh, 0.1);
      const moved = { dc: idle!.col - before.col, dr: idle!.row - before.row };
      if (Math.hypot(moved.dc, moved.dr) < 1e-3) continue;
      const { row, mirror } = sheetRowFor(undefined, idle!.facing, false);
      expect(gap(shownBearing(DIRECTION_ROWS, row, mirror), screenBearing(moved.dc, moved.dr)), `stroll step ${i}`).toBeLessThanOrEqual(45);
      seen.add(idle!.facing);
    }
    expect(seen.size, 'a full circle turns the resident through several faces').toBeGreaterThanOrEqual(4);
  });

  it('starts a walking resident facing its first step, not the camera', () => {
    const fresh = createResidentSimulation(EGYPT_WORLD_PACK, synced.city, live);
    let checked = 0;
    for (const r of fresh.residents.filter(x => x.liveState === 'working')) {
      const next = r.path.slice(r.pathIndex).find(p => Math.hypot(p.col - r.col, p.row - r.row) > 1e-3);
      if (!next) continue;
      const { row, mirror } = sheetRowFor(undefined, r.facing, false);
      expect(gap(shownBearing(DIRECTION_ROWS, row, mirror), screenBearing(next.col - r.col, next.row - r.row)), `${r.id} at start`).toBeLessThanOrEqual(22.5);
      checked += 1;
    }
    expect(checked, 'walkers with a step ahead').toBeGreaterThan(3);
  });

  it('keeps the face of its last step while it stands at the end of its route, not the camera', () => {
    const fresh = createResidentSimulation(EGYPT_WORLD_PACK, synced.city, live);
    const r = fresh.residents.find(x => x.liveState === 'working' && x.archetype === 'builder')!;
    Object.assign(r, { col: 60, row: 60, path: [{ col: 60, row: 57 }], pathIndex: 0, actionTimer: 0, facing: 'S' });
    for (let i = 0; i < 100 && r.pathIndex < 1; i++) stepResidentSimulation(fresh, 0.1);
    const walked = r.facing;
    expect(gap(BEARING[walked]!, screenBearing(0, -1)), `walked up the row axis, faces ${walked}`).toBeLessThanOrEqual(22.5);
    let stood = 0;
    for (let i = 0; i < 8; i++) {
      stepResidentSimulation(fresh, 0.1);
      if (r.actionTimer <= 0) continue;
      expect(r.facing, `standing ${i}`).toBe(walked);
      stood += 1;
    }
    expect(stood, 'it pauses at the end of its route').toBeGreaterThan(3);
  });
});

/* #1983, Ivan: the feet never slide. In one walk cycle (frames / fps seconds) a resident covers exactly the stride its
   sheet draws: `stride` master px of the E row, or the default measured on the pilot sheets. */
describe('Residents cover one drawn stride per walk cycle (#1983)', () => {
  const { live, synced } = city();
  const master = masterTileW(EGYPT_WORLD_PACK);

  function walkSheetIndex(lookId: string, extra: Partial<SheetPassport>): ArtIndex {
    const passport = { frameW: 192, frameH: 256, frames: 8, fps: 10, anchor: { x: 96, y: 236 }, ...extra } as SheetPassport;
    return { contract: 2, pack: 'egypt', files: { [personSheetPath(lookId, 1, 'walk')]: { w: 192 * passport.frames, h: 256 * 5, passport } } };
  }

  /* Walks one resident in a straight grid direction for one cycle and gives its move in master px on screen and in tiles. */
  function oneCycle(extra: Partial<SheetPassport>, dc: number, dr: number) {
    const sim = createResidentSimulation(EGYPT_WORLD_PACK, synced.city, live);
    const r = sim.residents.find(x => x.liveState === 'working' && EGYPT_WORLD_PACK.art!.people!.looks.includes(x.look.id))!;
    const index = walkSheetIndex(r.look.id, extra);
    sim.walkSpeedOf = resident => residentWalkSpeed(EGYPT_WORLD_PACK, index, resident);
    Object.assign(r, { col: 60, row: 60, path: [{ col: 60 + dc * 40, row: 60 + dr * 40 }], pathIndex: 0, actionTimer: 0, outfitTier: 1, pose: 'walking' });
    const fps = extra.fps ?? 10;
    const frames = extra.frames ?? 8;
    const frameAt = () => resolveResidentArt(EGYPT_WORLD_PACK, index, r, sim.timeSec)!.layers[0]!.frame.x;
    const startFrame = frameAt();
    const cycle = frames / fps;
    const steps = 40;
    for (let i = 0; i < steps; i++) stepResidentSimulation(sim, cycle / steps);
    const d = { dc: r.col - 60, dr: r.row - 60 };
    return { screenX: ((d.dc - d.dr) * master) / 2, tiles: Math.hypot(d.dc, d.dr), sameFrame: frameAt() === startFrame };
  }

  it('walking east covers the default stride of the pilot sheets in one cycle, back on its first frame', () => {
    const { screenX, sameFrame } = oneCycle({}, 1, -1);
    expect(screenX).toBeCloseTo(WALK_STRIDE_PX, 0);
    expect(sameFrame).toBe(true);
  });

  it('takes the stride and the cycle from the passport when the sheet carries them', () => {
    const { screenX, sameFrame } = oneCycle({ stride: 120, frames: 6, fps: 12 }, 1, -1);
    expect(screenX).toBeCloseTo(120, 0);
    expect(sameFrame).toBe(true);
  });

  it('refuses a stride that is not a number of px above zero, which would stop the resident dead', () => {
    const at = 'people/egypt-mason/tier_1/';
    const sheetOf = (stride: unknown) => ({ w: 192 * 8, h: 256 * 5, passport: { frameW: 192, frameH: 256, frames: 8, fps: 10, anchor: { x: 96, y: 236 }, stride } as unknown as SheetPassport });
    const report = validateArtIndex(EGYPT_WORLD_PACK, {
      contract: 2,
      pack: 'egypt',
      files: { [`${at}walk.png`]: sheetOf(0), [`${at}carry.png`]: sheetOf('92') },
    });
    expect(report.errors.some(e => e.startsWith(`${at}walk.png`) && /stride/.test(e))).toBe(true);
    expect(report.errors.some(e => e.startsWith(`${at}carry.png`) && /stride/.test(e))).toBe(true);
    const fine = validateArtIndex(EGYPT_WORLD_PACK, { contract: 2, pack: 'egypt', files: { [`${at}walk.png`]: sheetOf(92) } });
    expect(fine.errors.filter(e => /stride/.test(e))).toEqual([]);
  });

  it('accepts a sheet that draws the west directions too, one row each, and refuses a name it does not know', () => {
    const at = 'people/egypt-mason/tier_1/';
    const sheetOf = (directions: readonly string[], rows = directions.length) => ({
      w: 192 * 8,
      h: 256 * rows,
      passport: { frameW: 192, frameH: 256, frames: 8, fps: 10, anchor: { x: 96, y: 236 }, directions } as unknown as SheetPassport,
    });
    const eight = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const fine = validateArtIndex(EGYPT_WORLD_PACK, { contract: 2, pack: 'egypt', files: { [`${at}carry.png`]: sheetOf(eight), [`${at}idle.png`]: sheetOf(['SE', 'SW']) } });
    expect(fine.errors.filter(e => e.startsWith(at))).toEqual([]);
    const bad = validateArtIndex(EGYPT_WORLD_PACK, {
      contract: 2,
      pack: 'egypt',
      files: { [`${at}carry.png`]: sheetOf(eight, 5), [`${at}walk.png`]: sheetOf(['SE', 'WSW']) },
    });
    expect(bad.errors.some(e => e.startsWith(`${at}carry.png`)), 'eight directions need eight rows').toBe(true);
    expect(bad.errors).toContain(`${at}walk.png: directions must name drawn ones among N, NE, E, SE, S, SW, W, NW`);
  });

  it('covers the same ground in a cycle whichever way it walks, so the foreshortened rows keep their feet too', () => {
    const east = oneCycle({}, 1, -1).tiles;
    for (const [dc, dr] of GRID_STEPS) expect(oneCycle({}, dc, dr).tiles, `step (${dc}, ${dr})`).toBeCloseTo(east, 3);
  });

  /* Ivan: one idle at a house. A standing sheet (idle) has no stride, so a resident drawn from it stands still instead
     of sliding round its house; a placeholder keeps strolling (the test above). */
  it('keeps an idle resident drawn from a standing sheet in place at its house, its sheet still running', () => {
    const sim = createResidentSimulation(EGYPT_WORLD_PACK, synced.city, live);
    const idle = sim.residents.find(r => r.liveState === 'idle' && EGYPT_WORLD_PACK.art!.people!.looks.includes(r.look.id))!;
    expect(idle, 'the fixture has an idle resident with an art look').toBeTruthy();
    const passport = { frameW: 192, frameH: 256, frames: 4, fps: 4, anchor: { x: 96, y: 236 }, directions: ['SE'] } as SheetPassport;
    const index: ArtIndex = { contract: 2, pack: 'egypt', files: { [personSheetPath(idle.look.id, 1, 'idle')]: { w: 768, h: 256, passport } } };
    idle.outfitTier = 1;
    sim.standsStillOf = r => residentStandsStill(EGYPT_WORLD_PACK, index, r);
    stepResidentSimulation(sim, 0.1);
    const at = { col: idle.col, row: idle.row, facing: idle.facing };
    const frames = new Set<number>();
    for (let i = 0; i < 30; i++) {
      stepResidentSimulation(sim, 0.1);
      expect({ col: idle.col, row: idle.row, facing: idle.facing }, `step ${i}`).toEqual(at);
      expect(idle.pose).toBe('idle');
      frames.add(resolveResidentArt(EGYPT_WORLD_PACK, index, idle, sim.timeSec)!.layers[0]!.frame.x);
    }
    expect(frames.size, 'the idle loop plays in place').toBe(4);

    /* Without art, or with only a walking sheet, there is no standing sheet to keep it in place. */
    expect(residentStandsStill(EGYPT_WORLD_PACK, null, idle)).toBe(false);
    expect(residentStandsStill(EGYPT_WORLD_PACK, walkSheetIndex(idle.look.id, {}), idle)).toBe(false);
  });
});
