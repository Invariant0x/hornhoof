import { expect, test } from '@playwright/test';
import type { CityBuilding } from '../src/world/city-layout';
import type { ResidentEntity } from '../src/world/residents';

/* #2001, 23.11: on the live city page a resident who has brought its stone stands on the lot of the building it
   works at, turned to it, not on the road beside it. */
type LiveHandle = {
  getResidents: () => readonly ResidentEntity[];
  getBuildings: () => readonly CityBuilding[];
};
type AtWork = { name: string; building: string | null; onLot: boolean; facing: string; spotFacing: string | null };

test('the live page shows a resident at work on the lot of its building, turned to it', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 360 });
  await page.goto('/world-live.html?pack=egypt&lang=en&mode=hornhoof&zoom=100');
  await page.waitForFunction(() => ((window as unknown as { __WORLD_LIVE__?: LiveHandle }).__WORLD_LIVE__?.getResidents().length ?? 0) > 0);
  /* Residents pausing at the end of a walk to work, building: on the page's own simulation, the one the map draws. */
  const atWork = (): Promise<AtWork[]> =>
    page.evaluate(() => {
      const h = (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__;
      const buildings = new Map(h.getBuildings().map(b => [b.id, b]));
      return h
        .getResidents()
        .filter(r => r.liveState === 'working' && r.deliveryTargetKind !== 'none' && r.pose === 'building' && r.leg === 'inbound' && r.pathIndex === 0)
        .map(r => {
          const b = r.workBuildingId ? buildings.get(r.workBuildingId) : undefined;
          const col = Math.round(r.col);
          const row = Math.round(r.row);
          return {
            name: r.name,
            building: r.workBuildingId ?? null,
            onLot: Boolean(b) && col >= b!.col && col < b!.col + b!.spanCol && row >= b!.row && row < b!.row + b!.spanRow,
            facing: r.facing,
            spotFacing: r.workSpot?.facing ?? null,
          };
        });
    });
  /* Working residents walk their routes and pause at work; in time one does, however slow the frame rate (#59). */
  await expect.poll(async () => (await atWork()).length).toBeGreaterThan(0);
  const seen = await atWork();
  for (const r of seen) {
    expect(r.building, `${r.name} knows the building it works at`).not.toBeNull();
    expect(r.onLot, `${r.name} stands on the lot of ${r.building}`).toBe(true);
    expect(r.facing, `${r.name} turned to ${r.building}`).toBe(r.spotFacing);
  }
});
