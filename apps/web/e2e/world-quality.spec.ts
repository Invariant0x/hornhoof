/* #1947 item 6 in the product: when the frames the world draws are slow, it lowers its quality step by step, by the
   frame time it measures and not by the device or browser: fewer plants and less animation first, then a lower render
   resolution, down to half. The page here makes every frame slow itself, by working 60 ms in each animation frame, so
   the check does not depend on how fast the machine running it is. */

import { expect, test, type Page } from '@playwright/test';
import { ME, serveApi } from './api';

type Quality = { level: number; resolution: number; plants: number; animation: string };
type Stats = { visibleChunks: number; pendingBakes: number; dpr: number; quality: Quality; plants: { drawn: number; inView: number } };

const stats = (page: Page) =>
  page.evaluate(() => (window as unknown as { __WORLD_PRODUCT__: { getStats: () => Stats } }).__WORLD_PRODUCT__.getStats());

async function openMap(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('hh-lang', 'en');
    localStorage.setItem('hh-theme', 'egypt');
  });
  await serveApi(page);
  await page.route('**/api/me', route => route.fulfill({ json: { ...ME, company: { ...ME.company, theme: 'egypt' } } }));
  await page.goto('/');
  await expect(page.locator('[data-world-canvas="egypt"]')).toBeVisible();
  await page.waitForFunction(() => {
    const s = (window as unknown as { __WORLD_PRODUCT__?: { getStats: () => Stats | null } }).__WORLD_PRODUCT__?.getStats();
    return Boolean(s && s.visibleChunks > 0 && s.pendingBakes === 0);
  });
}

/* Every animation frame of the page works this long, as a slow machine's would take. */
const slowFrames = (page: Page, ms: number) =>
  page.evaluate(ms => {
    const burn = () => {
      const until = performance.now() + ms;
      while (performance.now() < until) {
        /* busy, as drawing on a slow machine is */
      }
      requestAnimationFrame(burn);
    };
    requestAnimationFrame(burn);
  }, ms);

test.use({ viewport: { width: 1366, height: 860 } });

test('slow frames lower the world quality step by step, down to half the render resolution', async ({ page }) => {
  await openMap(page);
  const full = await stats(page);
  expect(full.quality, 'a fresh map draws at full quality').toMatchObject({ level: 0, resolution: 1, plants: 1, animation: 'full' });
  await slowFrames(page, 60);

  await expect.poll(async () => (await stats(page)).quality.level, 'it steps down from full quality').toBeGreaterThan(0);
  const first = await stats(page);
  expect(first.quality, 'the first step thins the plants and the animation, the resolution stays').toMatchObject({ resolution: 1 });
  expect(first.quality.plants).toBeLessThan(1);

  await expect.poll(async () => (await stats(page)).quality.level, 'it goes on to the lowest step').toBe(3);
  const lowest = await stats(page);
  expect(lowest.quality).toMatchObject({ resolution: 0.5, animation: 'still' });
  const canvas = await page.locator('.world-canvas-host canvas').evaluate(c => ({
    pixels: (c as HTMLCanvasElement).width,
    css: c.getBoundingClientRect().width,
  }));
  expect(canvas.pixels, 'the canvas draws at half its density').toBe(Math.round(canvas.css * lowest.dpr * 0.5));
  expect(lowest.plants.drawn, 'about a third of the plants in the same view are drawn').toBeLessThan(full.plants.drawn * 0.5);
});
