/* #1947 items 1 and 2 in the product: the world loads once behind its loading screen, with progress by the real bytes of
   its pictures; the pictures are kept in the browser by content hash, so reopening the map shows no loading screen and
   downloads no picture; behind another tab the world stays mounted and paused (item 3); and after an art version change only the changed file downloads. The art folder here is the
   test's own: four ground pictures painted in one colour each, so the test needs no artist files. */

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ME, serveApi } from './api';
import { groundFolder, serveArt, solidPng } from './world-art-folder';

/* Every state the loading screen showed on this page: each step's value, max and words. */
async function watchLoadingScreen(context: BrowserContext) {
  await context.addInitScript(() => {
    localStorage.setItem('hh-lang', 'en');
    localStorage.setItem('hh-theme', 'egypt');
    const log: string[][] = [];
    (window as unknown as { __worldLoadLog: string[][] }).__worldLoadLog = log;
    const snap = () => {
      const box = document.querySelector('.world-loading');
      if (!box) return;
      const row = [...box.querySelectorAll('[role=progressbar]')].map(
        b => `${b.getAttribute('aria-valuenow')}/${b.getAttribute('aria-valuemax')} ${b.getAttribute('aria-valuetext')}`,
      );
      if (log[log.length - 1]?.join('|') !== row.join('|')) log.push(row);
    };
    new MutationObserver(snap).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-valuenow', 'aria-valuetext'] });
  });
}

async function openMap(page: Page): Promise<void> {
  await serveApi(page);
  await page.route('**/api/me', route => route.fulfill({ json: { ...ME, company: { ...ME.company, theme: 'egypt' } } }));
  await page.goto('/');
  await expect(page.locator('[data-world-canvas="egypt"]')).toBeVisible();
  await page.waitForFunction(() => {
    const h = (window as unknown as { __WORLD_PRODUCT__?: { getStats: () => { visibleChunks: number; pendingBakes: number } | null } }).__WORLD_PRODUCT__;
    const s = h?.getStats();
    return Boolean(s && s.visibleChunks > 0 && s.pendingBakes === 0) && !document.querySelector('.world-loading');
  });
}

const worldStats = (page: Page) =>
  page.evaluate(() => (window as unknown as { __WORLD_PRODUCT__: { getStats: () => { paused: boolean; framesDrawn: number } } }).__WORLD_PRODUCT__.getStats());

const loadLog = (page: Page) => page.evaluate(() => (window as unknown as { __worldLoadLog: string[][] }).__worldLoadLog);

test.use({ viewport: { width: 1366, height: 860 } });

test('the first visit shows the loading screen with the real bytes; reopening and switching tabs show none and download no picture', async ({ browser }) => {
  const context = await browser.newContext();
  const folder = { current: groundFolder() };
  const total = [...folder.current.values()].reduce((n, d) => n + d.length, 0);
  const pictures = await serveArt(context, folder);
  await watchLoadingScreen(context);

  const page = await context.newPage();
  await openMap(page);
  const shown = await loadLog(page);
  expect(shown.length, 'the loading screen showed').toBeGreaterThan(0);
  const art = shown.map(row => row[0]!);
  expect(art[0]).toBe(`0/${total} 0.0 of ${(total / 1048576).toFixed(1)} MB`);
  const bytes = art.filter(a => a.endsWith(' MB')).map(a => Number(a.split('/')[0]));
  for (let i = 1; i < bytes.length; i++) expect(bytes[i], 'the bytes only grow').toBeGreaterThanOrEqual(bytes[i - 1]!);
  expect(shown.some(row => row[0] === '1/1 Done' && row[1] !== '0/1 Waiting'), 'the pictures finish before the map step').toBe(true);
  expect(shown[shown.length - 1]![2], 'the ground step is the last one going on').not.toBe('0/1 Waiting');
  expect([...pictures].sort(), 'each picture downloads once').toEqual([...folder.current.keys()].sort());

  await page.reload();
  await openMap(page);
  expect(await loadLog(page), 'no loading screen on a reload').toEqual([]);
  expect(pictures.length, 'no picture downloads on a reload').toBe(folder.current.size);

  /* Item 3: behind Tasks the world stays mounted, hidden and paused, and comes back as it was. */
  await page.locator('.world-canvas-host canvas').evaluate(c => ((c as HTMLCanvasElement).dataset.kept = 'yes'));
  const nav = page.getByRole('navigation');
  await nav.getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(page.locator('[data-world-canvas="egypt"]')).toBeHidden();
  const parked = await worldStats(page);
  expect(parked.paused, 'the world is parked behind Tasks').toBe(true);
  await page.evaluate(() => new Promise(done => { let n = 0; const tick = () => (++n < 10 ? requestAnimationFrame(tick) : done(null)); requestAnimationFrame(tick); }));
  expect((await worldStats(page)).framesDrawn, 'no frame drawn behind Tasks').toBe(parked.framesDrawn);
  await nav.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.locator('[data-world-canvas="egypt"]')).toBeVisible();
  await expect.poll(async () => (await worldStats(page)).framesDrawn, 'it draws again on the map').toBeGreaterThan(parked.framesDrawn);
  expect(await page.locator('.world-canvas-host canvas').evaluate(c => (c as HTMLCanvasElement).dataset.kept), 'the same world, not a new one').toBe('yes');
  expect(await loadLog(page), 'no loading screen back from Tasks').toEqual([]);
  expect(pictures.length, 'no picture downloads back from Tasks').toBe(folder.current.size);

  const second = await context.newPage();
  await openMap(second);
  expect(await loadLog(second), 'no loading screen in a new tab').toEqual([]);
  expect(pictures.length, 'no picture downloads in a new tab').toBe(folder.current.size);
  await context.close();
});

test('after an art version change only the changed picture downloads, behind the loading screen', async ({ browser }) => {
  const context = await browser.newContext();
  const folder = { current: groundFolder() };
  const pictures = await serveArt(context, folder);
  await watchLoadingScreen(context);
  const page = await context.newPage();
  await openMap(page);
  pictures.length = 0;

  const repainted = solidPng(256, [120, 100, 70, 255]);
  folder.current = new Map(folder.current).set('ground/bank.png', repainted);
  await page.reload();
  await openMap(page);
  expect(pictures, 'only the changed picture').toEqual(['ground/bank.png']);
  const shown = await loadLog(page);
  expect(shown[0]![0]).toBe(`0/${repainted.length} 0.0 of ${(repainted.length / 1048576).toFixed(1)} MB`);

  await page.reload();
  await openMap(page);
  expect(await loadLog(page)).toEqual([]);
  expect(pictures).toEqual(['ground/bank.png']);
  await context.close();
});
