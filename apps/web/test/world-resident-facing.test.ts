import { describe, expect, it } from 'vitest';
import { DIRECTION_ROWS, sheetRowFor, type SheetPassport } from '../src/world/art';
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
