import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolutionTierId } from '../src/world/manifest';
import type { WorldEngineStats } from '../src/world/renderer';
import { captureWith } from './capture';

/* Stage 1 engine core live browser verification: empty 150x150 2:1 diamond grid on the stub pack,
   bird-eye / 1x / 2x / 4x zoom tiers, baked chunk frustum culling, drag pan + wheel zoom and tile click picking. */

const capture = captureWith('stage1', process.env.HH_SCREENSHOT_DIR);

type DemoHandle = {
  setZoomTier: (tier: ResolutionTierId) => void;
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

test('Stage 1 demo renders empty 150x150 stub map with chunk culling, 4x/2x/1x/bird-eye zoom and exact tile click picking', async ({ browser }, info: TestInfo) => {
  const shotDir = process.env.HH_SCREENSHOT_DIR;
  const videoDir = info.outputPath('stage1-video');
  if (shotDir) mkdirSync(shotDir, { recursive: true });
  mkdirSync(videoDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
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

    const initial = await readStats(page);
    expect(initial.mapSize).toBe(150);
    expect(initial.totalChunks).toBe(361);
    expect(initial.tier).toBe('1x');
    expect(initial.visibleChunks).toBeGreaterThan(0);
    expect(initial.visibleChunks).toBeLessThan(initial.totalChunks * 0.25);

    /* Click center tile (75, 75) at 1x zoom and verify exact readout. */
    const pt75 = await page.evaluate(() => (window as unknown as { __WORLD_DEMO__: DemoHandle }).__WORLD_DEMO__.screenPointOfTile(75, 75));
    await page.mouse.click(pt75.x, pt75.y);
    await expect(page.getByTestId('world-stage1-selected')).toContainText('Clicked tile: (75, 75)');
    await expect(page.getByTestId('world-stage1-selected')).toContainText('Chunk (9, 9)');
    await capture(page, info, '1x-desktop');

    /* Bird-eye view: whole 150x150 diamond visible on one screen. */
    await page.getByTestId('zoom-tier-overview').click();
    await waitForDemoReady(page);
    const bird = await readStats(page);
    expect(bird.tier).toBe('overview');
    expect(bird.visibleChunks).toBe(bird.totalChunks);
    await capture(page, info, 'birdeye-desktop');

    /* 2x HD zoom tier: tighter culling, click another exact tile (78, 72) well clear of the top-left HUD. */
    await page.getByTestId('zoom-tier-2x').click();
    await waitForDemoReady(page);
    const zoom2 = await readStats(page);
    expect(zoom2.tier).toBe('2x');
    expect(zoom2.visibleChunks).toBeLessThan(initial.visibleChunks);
    const pt2 = await page.evaluate(() => (window as unknown as { __WORLD_DEMO__: DemoHandle }).__WORLD_DEMO__.screenPointOfTile(78, 72));
    await page.mouse.click(pt2.x, pt2.y);
    await expect(page.getByTestId('world-stage1-selected')).toContainText('Clicked tile: (78, 72)');
    await capture(page, info, '2x-desktop');

    /* 4x Master zoom tier: smallest visible chunk set, coordinate labels visible inside tiles. */
    await page.getByTestId('zoom-tier-4x').click();
    await waitForDemoReady(page);
    const zoom4 = await readStats(page);
    expect(zoom4.tier).toBe('4x');
    expect(zoom4.visibleChunks).toBeGreaterThan(0);
    expect(zoom4.visibleChunks).toBeLessThan(zoom2.visibleChunks);
    const pt4 = await page.evaluate(() => (window as unknown as { __WORLD_DEMO__: DemoHandle }).__WORLD_DEMO__.screenPointOfTile(75, 75));
    await page.mouse.click(pt4.x, pt4.y);
    await expect(page.getByTestId('world-stage1-selected')).toContainText('Clicked tile: (75, 75)');
    await capture(page, info, '4x-desktop');

    /* Smooth drag pan + wheel zoom interaction. */
    const beforePan = await readStats(page);
    await page.mouse.move(720, 450);
    await page.mouse.down();
    await page.mouse.move(540, 360, { steps: 10 });
    await page.mouse.up();
    await page.mouse.wheel(0, 240);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const afterPan = await readStats(page);
    expect(afterPan.camera.x).not.toBeCloseTo(beforePan.camera.x, 1);
    expect(afterPan.camera.y).not.toBeCloseTo(beforePan.camera.y, 1);
    expect(afterPan.zoom).toBeLessThan(beforePan.zoom);

    /* Measure smooth rAF loop during continuous programmatic panning at 1x zoom (all visible chunks already baked). */
    await page.getByTestId('zoom-tier-1x').click();
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
        ` visOverview=${bird.visibleChunks} vis1x=${initial.visibleChunks} vis2x=${zoom2.visibleChunks} vis4x=${zoom4.visibleChunks}` +
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

  /* Verify mobile portrait viewport renders cleanly with zero overflow. */
  const mobileCtx = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const mobilePage = await mobileCtx.newPage();
  const mobileErrors: string[] = [];
  mobilePage.on('pageerror', error => mobileErrors.push(error.message));
  try {
    await mobilePage.goto('/world-demo.html');
    await waitForDemoReady(mobilePage);
    await mobilePage.getByTestId('zoom-tier-overview').click();
    await waitForDemoReady(mobilePage);
    const overflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await capture(mobilePage, info, 'birdeye-mobile');
    expect(mobileErrors).toEqual([]);
  } finally {
    await mobileCtx.close();
  }
});
