import { describe, expect, it } from 'vitest';
import {
  DIRECTION_ROWS,
  masterTileW,
  personSheetPath,
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

  it('covers the same ground in a cycle whichever way it walks, so the foreshortened rows keep their feet too', () => {
    const east = oneCycle({}, 1, -1).tiles;
    for (const [dc, dr] of GRID_STEPS) expect(oneCycle({}, dc, dr).tiles, `step (${dc}, ${dr})`).toBeCloseTo(east, 3);
  });
});
