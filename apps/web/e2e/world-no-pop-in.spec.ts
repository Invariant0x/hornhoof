/* #1947 item 4 in the product: once the loading screen is gone, no frame shows a ground piece still baking while the
   camera pans by keys or by drag, and none drawn coarser than its zoom needs, or missing, while the camera zooms out
   across the detail tiers. The engine counts those pieces in view each frame (getStats(): pendingBakes, lowDetailChunks);
   the page reads the count on every frame of each move. The ground pictures are the test's own (world-art-folder.ts). */

import { expect, test, type Page } from '@playwright/test';
import { ME, serveApi } from './api';
import { groundFolder, serveArt } from './world-art-folder';

type Stats = { pendingBakes: number; aheadBakes: number; lowDetailChunks: number; visibleChunks: number; zoom: number; maxZoom: number; lodId: string };
type Count = 'pendingBakes' | 'lowDetailChunks';
type Watch = { frames: number; worst: number; worstZoom: number; bad: number };

declare global {
  interface Window {
    __popIn?: Watch | null;
  }
}

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
    return Boolean(s && s.visibleChunks > 0 && s.pendingBakes === 0) && !document.querySelector('.world-loading');
  });
}

/* Reads the engine's count on every animation frame of the page until stopped; the worst frame and how many were bad. */
async function watch<T>(page: Page, count: Count, move: () => Promise<T>): Promise<Watch> {
  await page.evaluate(count => {
    const w: Watch = { frames: 0, worst: 0, worstZoom: 0, bad: 0 };
    window.__popIn = w;
    const tick = () => {
      if (window.__popIn !== w) return;
      const s = (window as unknown as { __WORLD_PRODUCT__?: { getStats: () => Stats | null } }).__WORLD_PRODUCT__?.getStats();
      if (s) {
        w.frames++;
        const n = s[count];
        /* An engine that does not count them fails every frame. */
        if (typeof n !== 'number' || n > 0) w.bad++;
        if (n > w.worst) {
          w.worst = n;
          w.worstZoom = s.zoom;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, count);
  await move();
  /* Two more frames, so the frame the move ended on is read too. */
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  return page.evaluate(() => {
    const w = window.__popIn!;
    window.__popIn = null;
    return w;
  });
}

async function holdKey(page: Page, key: string, ms: number): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

async function canvasCentre(page: Page): Promise<{ x: number; y: number }> {
  const box = (await page.locator('.world-canvas-host canvas').boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/* Every piece in view and around it baked at the current zoom. */
const settled = (page: Page) =>
  page.waitForFunction(() => {
    const s = (window as unknown as { __WORLD_PRODUCT__?: { getStats: () => Stats | null } }).__WORLD_PRODUCT__?.getStats();
    return Boolean(s && s.pendingBakes === 0 && s.aheadBakes === 0);
  });

test.use({ viewport: { width: 1366, height: 860 } });

test('after the loading screen no frame shows a ground piece still baking while panning by keys or by drag', async ({ page, context }) => {
  await serveArt(context, { current: groundFolder() });
  await openMap(page);
  const start = await stats(page);

  const keys = await watch(page, 'pendingBakes', async () => {
    await holdKey(page, 'ArrowRight', 1200);
    await holdKey(page, 'ArrowDown', 1200);
    await holdKey(page, 'ArrowLeft', 1200);
  });
  expect(keys.frames, 'frames read while panning by keys').toBeGreaterThan(20);
  expect(keys.bad, `no frame with a piece still baking while panning by keys: ${JSON.stringify({ ...keys, start })}`).toBe(0);

  const centre = await canvasCentre(page);
  const drag = await watch(page, 'pendingBakes', async () => {
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    /* About 600 px a second, a calm drag across the map. */
    for (let i = 1; i <= 30; i++) {
      await page.mouse.move(centre.x - i * 12, centre.y - i * 6);
      await page.waitForTimeout(20);
    }
    await page.mouse.up();
  });
  expect(drag.frames, 'frames read while dragging').toBeGreaterThan(5);
  expect(drag.bad, `no frame with a piece still baking while dragging: ${JSON.stringify(drag)}`).toBe(0);
});

test('zooming out across the detail tiers shows no ground piece coarser than its zoom, or missing', async ({ page, context }) => {
  await serveArt(context, { current: groundFolder() });
  await openMap(page);
  const centre = await canvasCentre(page);
  await page.mouse.move(centre.x, centre.y);
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -120);
  await expect.poll(async () => (await stats(page)).zoom, 'zoomed in to the closest view').toBe((await stats(page)).maxZoom);
  await settled(page);
  const close = await stats(page);

  const out = await watch(page, 'lowDetailChunks', async () => {
    for (let i = 0; i < 14; i++) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(150);
    }
  });
  const far = await stats(page);
  expect(far.lodId, 'the zoom crossed the detail tiers').not.toBe(close.lodId);
  expect(out.bad, `no frame with a piece coarser than its zoom while zooming out: ${JSON.stringify({ ...out, from: close.zoom, to: far.zoom })}`).toBe(0);
});
