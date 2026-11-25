import { expect, test } from '@playwright/test';
import type { ResidentEntity } from '../src/world/residents';

/* #1983: the live city page hands out the residents the map draws. Its first snapshot sync built a second simulation
   while the engine was still loading, so the engine stepped one simulation and the page (the debug handle, the camera
   follow and the resident card) read another that never moved. */
type LiveHandle = {
  getResidents: () => readonly ResidentEntity[];
  centerOnResident: (residentId: string, zoom?: number) => boolean;
  getResidentScreenPoint: (residentId: string) => { x: number; y: number } | null;
};
type Spot = { id: string; col: number; row: number };

test('the live page reads the residents the map moves', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 360 });
  await page.goto('/world-live.html?pack=egypt&lang=en&mode=hornhoof&zoom=100');
  await page.waitForFunction(() => ((window as unknown as { __WORLD_LIVE__?: LiveHandle }).__WORLD_LIVE__?.getResidents().length ?? 0) > 0);
  const spots = () =>
    page.evaluate(() =>
      (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__
        .getResidents()
        .filter(r => r.liveState === 'working')
        .map(r => ({ id: r.id, col: r.col, row: r.row })),
    );
  const before: Spot[] = await spots();
  expect(before.length).toBeGreaterThan(0);
  /* Working residents walk their routes; in time some of them move, however slow the frame rate (no limit, #59). */
  await expect
    .poll(async () => {
      const now = new Map((await spots()).map(s => [s.id, s]));
      return before.filter(s => {
        const n = now.get(s.id);
        return n && Math.hypot(n.col - s.col, n.row - s.row) > 0.2;
      }).length;
    })
    .toBeGreaterThan(0);

  /* The page's resident is where the map draws it: the camera centred on it puts its screen point in the middle. */
  const id = before[0]!.id;
  const pt = await page.evaluate(rid => {
    const h = (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__;
    h.centerOnResident(rid, 1);
    return h.getResidentScreenPoint(rid);
  }, id);
  expect(pt).not.toBeNull();
  expect(Math.abs(pt!.x - 320)).toBeLessThan(2);
});
