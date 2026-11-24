import { expect, test, type Page } from '@playwright/test';
import type { HarbourState } from '../src/world/harbour';
import type { ResidentEntity, ResidentHarbour } from '../src/world/residents';
import { deliverHarbourArt } from './harbour-stand-in';

/* #2006, Ivan 23.11: on the live city page the tasks come down the river as stones on boats to a harbour, wait in its
   yard and are carried from there. The harbour has no placeholder (#105, #107): without its art the page shows none.
   Stand-in pictures (harbour-stand-in.ts) play the artist's delivery; none of them is in the repository. */

type LiveHandle = {
  getResidents: () => readonly ResidentEntity[];
  getHarbour: () => (ResidentHarbour & { state: HarbourState }) | null;
  centerOnHarbour: (zoom?: number) => boolean;
  getArtStats: () => { indexedFiles: number } | null;
};

const handle = (page: Page) => page.evaluate(() => {
  const h = (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.getHarbour();
  return h ? { shown: h.shown, kind: h.plan.kind, yard: h.plan.yard, open: h.flow.open, state: h.state } : null;
});

async function openLivePage(page: Page): Promise<void> {
  await page.setViewportSize({ width: 960, height: 540 });
  await page.goto('/world-live.html?pack=egypt&lang=en&mode=hornhoof&zoom=100');
  await page.waitForFunction(() => ((window as unknown as { __WORLD_LIVE__?: LiveHandle }).__WORLD_LIVE__?.getResidents().length ?? 0) > 0);
}

test('with a file of its art missing the live page shows no harbour, and the stones come from home', async ({ page }) => {
  await deliverHarbourArt(page, ['harbour/boat_moored.png']);
  await openLivePage(page);
  const h = await handle(page);
  expect(h, 'the city plans its harbour by the river').not.toBeNull();
  expect(h!.kind).toBe('river');
  /* Once the art index is in and a few frames have passed, the harbour still stays hidden. */
  await expect.poll(() => page.evaluate(() => (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.getArtStats()?.indexedFiles ?? 0)).toBeGreaterThan(0);
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done)))));
  expect((await handle(page))!.shown).toBe(false);
  const fromYard = await page.evaluate(() =>
    (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.getResidents().filter(r => r.yardSpot && r.leg === 'outbound' && r.actionTimer > 0 && r.pose === 'building' && r.pathIndex === 0).length,
  );
  expect(fromYard, 'no one dresses a stone at a yard that is not drawn').toBe(0);
});

test('with its art in the folder the page draws the harbour and residents take their stones in its yard', async ({ page }) => {
  await deliverHarbourArt(page);
  await openLivePage(page);
  await expect.poll(async () => (await handle(page))?.shown).toBe(true);
  const h = (await handle(page))!;
  /* The yard holds the open queue less what is still aboard. */
  const aboard = h.state.carriers.reduce((n, c) => n + c.cargo, 0);
  expect(h.state.yardStones).toBe(Math.max(0, h.open - aboard));
  /* A carrier comes back to the yard and dresses its next stone there, on the yard, holding it. */
  const dressing = () =>
    page.evaluate(() => {
      const w = (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__;
      const yard = w.getHarbour()!.plan.yard;
      return w
        .getResidents()
        .filter(r => r.yardSpot && r.leg === 'outbound' && r.actionTimer > 0 && r.pathIndex === 0 && r.pose === 'building')
        .map(r => ({
          name: r.name,
          carrying: r.carrying,
          onYard: Math.round(r.col) >= yard.col && Math.round(r.col) < yard.col + yard.span && Math.round(r.row) >= yard.row && Math.round(r.row) < yard.row + yard.span,
        }));
    });
  await expect.poll(async () => (await dressing()).length).toBeGreaterThan(0);
  for (const r of await dressing()) {
    expect(r.onYard, `${r.name} on the yard`).toBe(true);
    expect(r.carrying, `${r.name} holds its stone`).toBe('stone');
  }
});
