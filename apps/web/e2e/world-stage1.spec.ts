import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WorldEngineStats } from '../src/world/renderer';
import { captureWith } from './capture';

/* Stage 1 engine core live browser verification: empty 150x150 2:1 diamond grid on the stub pack,
   hard zoom bounds (50% min 60x30 .. 100% default 120x60 .. 200% max 240x120), Retina-aware LOD
   selection, baked chunk frustum culling, drag pan + wheel zoom and exact tile click picking. */

const capture = captureWith('stage1', process.env.HH_SCREENSHOT_DIR);

type DemoHandle = {
  setZoom: (zoom: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  panByScreen: (dx: number, dy: number) => void;
  flushVisibleBakes: () => void;
  getStats: () => WorldEngineStats;
  screenPointOfTile: (col: number, row: number) => { x: number; y: number };
};

async function waitForDemoReady(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as { __WORLD_DEMO__?: DemoHandle }).__WORLD_DEMO__));
  await page.evaluate(() => {
    const demo = (window as unknown as { __WORLD_DEMO__: DemoHandle }).__WORLD_DEMO__;
    demo.flushVisibleBakes();
  });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function readStats(page: Page): Promise<WorldEngineStats> {
  return page.evaluate(() => (window as unknown as { __WORLD_DEMO__: DemoHandle }).__WORLD_DEMO__.getStats());
}

test('Stage 1 demo renders empty 150x150 stub map with hard zoom bounds, Retina LODs, chunk culling and click picking', async ({ browser }, info: TestInfo) => {
  const shotDir = process.env.HH_SCREENSHOT_DIR;
  const videoDir = info.outputPath('stage1-video');
  if (shotDir) mkdirSync(shotDir, { recursive: true });
  mkdirSync(videoDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  try {
    await page.goto('/world-demo.html');
    await waitForDemoReady(page);

    /* Default 100% zoom: 120x60 CSS px tile, 2x LOD at DPR 1, tiny visible chunk slice. */
    const initial = await readStats(page);
    expect(initial.mapSize).toBe(150);
    expect(initial.chunkSize).toBe(4);
    expect(initial.totalChunks).toBe(1444);
    expect(initial.zoomPercent).toBe(100);
    expect(initial.cssTileW).toBe(120);
    expect(initial.cssTileH).toBe(60);
    expect(initial.lodId).toBe('2x');
    expect(initial.animationDetail).toBe('standard');
    expect(initial.visibleChunks).toBeGreaterThan(0);
    expect(initial.visibleChunks).toBeLessThan(initial.totalChunks * 0.06);

    /* Click center tile (75, 75) at 100% and verify exact tile + chunk readout. */
    const pt100 = await page.evaluate(() => (window as unknown as { __WORLD_DEMO__: DemoHandle }).__WORLD_DEMO__.screenPointOfTile(75, 75));
    await page.mouse.click(pt100.x, pt100.y);
    await expect(page.getByTestId('world-stage1-selected')).toContainText('Clicked tile: (75, 75)');
    await expect(page.getByTestId('world-stage1-selected')).toContainText('Chunk (18, 18)');
    await capture(page, info, '100pct-desktop');

    /* Zoom out repeatedly via minus button + wheel to prove hard floor stops strictly at 50% (60x30, no bird-eye). */
    const zoomOutBtn = page.getByTestId('zoom-out');
    for (let i = 0; i < 4; i++) {
      await zoomOutBtn.click();
    }
    await page.mouse.move(720, 450);
    await page.mouse.wheel(0, 600);
    await waitForDemoReady(page);
    const minStats = await readStats(page);
    expect(minStats.zoomPercent).toBe(50);
    expect(minStats.zoom).toBeCloseTo(0.5, 4);
    expect(minStats.cssTileW).toBe(60);
    expect(minStats.cssTileH).toBe(30);
    expect(minStats.lodId).toBe('1x');
    expect(minStats.animationDetail).toBe('reduced');
    expect(minStats.visibleChunks).toBeGreaterThan(initial.visibleChunks);
    expect(minStats.visibleChunks).toBeLessThan(minStats.totalChunks * 0.15);
    await expect(zoomOutBtn).toBeDisabled();
    await expect(page.getByTestId('zoom-reset')).toHaveText('50%');
    await capture(page, info, '50pct-min-desktop');

    /* Reset via percentage button returns cleanly to 100%. */
    await page.getByTestId('zoom-reset').click();
    await waitForDemoReady(page);
    expect((await readStats(page)).zoomPercent).toBe(100);
    await expect(zoomOutBtn).toBeEnabled();

    /* Zoom in repeatedly via plus button + wheel to prove hard ceiling stops strictly at 200% (240x120, 4x LOD). */
    const zoomInBtn = page.getByTestId('zoom-in');
    for (let i = 0; i < 4; i++) {
      await zoomInBtn.click();
    }
    await page.mouse.move(720, 450);
    await page.mouse.wheel(0, -600);
    await waitForDemoReady(page);
    const maxStats = await readStats(page);
    expect(maxStats.zoomPercent).toBe(200);
    expect(maxStats.zoom).toBeCloseTo(2.0, 4);
    expect(maxStats.cssTileW).toBe(240);
    expect(maxStats.cssTileH).toBe(120);
    expect(maxStats.lodId).toBe('4x');
    expect(maxStats.animationDetail).toBe('full');
    expect(maxStats.visibleChunks).toBeGreaterThan(0);
    expect(maxStats.visibleChunks).toBeLessThan(initial.visibleChunks);
    await expect(zoomInBtn).toBeDisabled();
    await expect(page.getByTestId('zoom-reset')).toHaveText('200%');

    const pt200 = await page.evaluate(() => (window as unknown as { __WORLD_DEMO__: DemoHandle }).__WORLD_DEMO__.screenPointOfTile(75, 75));
    await page.mouse.click(pt200.x, pt200.y);
    await expect(page.getByTestId('world-stage1-selected')).toContainText('Clicked tile: (75, 75)');
    await capture(page, info, '200pct-max-desktop');

    /* Return to 100%, test real mouse drag panning + wheel zoom inside bounds. */
    await page.getByTestId('zoom-reset').click();
    await waitForDemoReady(page);
    const beforePan = await readStats(page);
    await page.mouse.move(720, 450);
    await page.mouse.down();
    await page.mouse.move(540, 360, { steps: 10 });
    await page.mouse.up();
    await page.mouse.wheel(0, -240);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const afterPan = await readStats(page);
    expect(afterPan.camera.x).not.toBeCloseTo(beforePan.camera.x, 1);
    expect(afterPan.camera.y).not.toBeCloseTo(beforePan.camera.y, 1);
    expect(afterPan.zoom).toBeGreaterThan(beforePan.zoom);
    expect(afterPan.zoom).toBeLessThanOrEqual(2.0);

    /* Measure smooth rAF loop during continuous panning at 100% zoom. */
    await page.getByTestId('zoom-reset').click();
    await waitForDemoReady(page);
    const bench = await page.evaluate(
      () =>
        new Promise<{ frames: number; avgMs: number; fps: number }>(resolve => {
          const demo = (window as unknown as { __WORLD_DEMO__: DemoHandle }).__WORLD_DEMO__;
          const deltas: number[] = [];
          let last = performance.now();
          let count = 0;
          const step = (now: number) => {
            deltas.push(now - last);
            last = now;
            demo.panByScreen(6, 3);
            count++;
            if (count >= 24) {
              const avgMs = deltas.reduce((a, b) => a + b, 0) / deltas.length;
              resolve({ frames: count, avgMs: Math.round(avgMs * 10) / 10, fps: Math.round(1000 / Math.max(1, avgMs)) });
              return;
            }
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }),
    );
    console.log(
      `STAGE1_METRICS renderer=${initial.rendererKind} map=${initial.mapSize}x${initial.mapSize} totalChunks=${initial.totalChunks}` +
        ` vis50=${minStats.visibleChunks} vis100=${initial.visibleChunks} vis200=${maxStats.visibleChunks}` +
        ` panFrames=${bench.frames} avgFrameMs=${bench.avgMs} fps=${bench.fps}`,
    );
    expect(bench.frames).toBe(24);
    expect(errors).toEqual([]);
  } finally {
    const video = page.video();
    await context.close();
    if (video && shotDir) {
      const recordedPath = await video.path();
      copyFileSync(recordedPath, join(shotDir, 'stage1-demo.webm'));
    }
  }

  /* Verify 2x Retina DPR selects crisp 2x/4x/8x LODs with zero upscaling blur. */
  const retinaCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const retinaPage = await retinaCtx.newPage();
  const retinaErrors: string[] = [];
  retinaPage.on('pageerror', error => retinaErrors.push(error.message));
  try {
    await retinaPage.goto('/world-demo.html');
    await waitForDemoReady(retinaPage);
    const r100 = await readStats(retinaPage);
    expect(r100.dpr).toBe(2);
    expect(r100.lodId).toBe('4x');

    await retinaPage.evaluate(() => (window as unknown as { __WORLD_DEMO__: DemoHandle }).__WORLD_DEMO__.setZoom(2.0));
    await waitForDemoReady(retinaPage);
    expect((await readStats(retinaPage)).lodId).toBe('8x');

    await retinaPage.evaluate(() => (window as unknown as { __WORLD_DEMO__: DemoHandle }).__WORLD_DEMO__.setZoom(0.5));
    await waitForDemoReady(retinaPage);
    expect((await readStats(retinaPage)).lodId).toBe('2x');
    expect(retinaErrors).toEqual([]);
  } finally {
    await retinaCtx.close();
  }

  /* Verify narrow mobile portrait viewport renders cleanly with zero overflow. */
  const mobileCtx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 1 });
  const mobilePage = await mobileCtx.newPage();
  const mobileErrors: string[] = [];
  mobilePage.on('pageerror', error => mobileErrors.push(error.message));
  try {
    await mobilePage.goto('/world-demo.html');
    await waitForDemoReady(mobilePage);
    const overflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await capture(mobilePage, info, '100pct-mobile');
    expect(mobileErrors).toEqual([]);
  } finally {
    await mobileCtx.close();
  }
});
